'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Config (.env file next to this script, or real environment variables)
// ---------------------------------------------------------------------------
loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
// 127.0.0.1 = only reachable through the tunnel (recommended). Use 0.0.0.0 to allow LAN access.
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.SECRET;
const ROOM_TOKEN = process.env.ROOM_TOKEN;
const ROOM_PASSWORD = process.env.ROOM_PASSWORD;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, 'media'));
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;

if (!SECRET || !ROOM_TOKEN || !ROOM_PASSWORD) {
  console.error('Missing SECRET / ROOM_TOKEN / ROOM_PASSWORD. Run `npm run setup` first.');
  process.exit(1);
}
if (SECRET.length < 32 || ROOM_TOKEN.length < 16) {
  console.error('SECRET must be >= 32 chars and ROOM_TOKEN >= 16 chars. Run `npm run setup` to generate them.');
  process.exit(1);
}

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const SUB_EXTS = new Set(['.vtt']);
const BASE = `/w/${ROOM_TOKEN}`;
const COOKIE = 'dg_session';
// Signing key includes the password, so changing the password logs everyone out.
const SIGN_KEY = crypto.createHash('sha256').update(`${SECRET}\0${ROOM_PASSWORD}`).digest();

// ---------------------------------------------------------------------------
// Sessions: stateless signed cookies
// ---------------------------------------------------------------------------
function sign(data) {
  return crypto.createHmac('sha256', SIGN_KEY).update(data).digest('base64url');
}

function makeSession(name) {
  const payload = Buffer.from(JSON.stringify({ n: name, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(cookieHeader) {
  const raw = parseCookies(cookieHeader)[COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.e !== 'number' || data.e < Date.now()) return null;
    return { name: String(data.n || 'Guest').slice(0, 30) };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(ROOM_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple brute-force protection: 8 failed attempts per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) {
    failures.delete(ip);
    return false;
  }
  return f.count >= 8;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------
function listVideos() {
  let files;
  try {
    files = fs.readdirSync(MEDIA_DIR);
  } catch {
    return [];
  }
  const set = new Set(files);
  return files
    .filter((f) => !f.startsWith('.') && VIDEO_EXTS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => {
      const sub = `${path.parse(f).name}.vtt`;
      return { name: f, subtitles: set.has(sub) ? sub : null };
    });
}

function isServableMedia(name) {
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name.startsWith('.')) return false;
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXTS.has(ext) && !SUB_EXTS.has(ext)) return false;
  return fs.existsSync(path.join(MEDIA_DIR, name));
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
// Requests arrive from cloudflared on localhost; trust its X-Forwarded-* headers.
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', // keeps the secret room link out of Referer headers
    'Content-Security-Policy':
      "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public'), { index: false }));

function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip || 'unknown';
}

function requireAuth(req, res, next) {
  const session = readSession(req.headers.cookie);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  req.session = session;
  next();
}

app.get(`${BASE}/`, (req, res) => {
  // Relative URLs in the page need the trailing slash.
  if (!req.path.endsWith('/')) return res.redirect(301, `${BASE}/`);
  if (readSession(req.headers.cookie)) {
    return res.sendFile(path.join(__dirname, 'public', 'player.html'));
  }
  res.type('html').send(loginPage(req.query.e));
});

app.post(`${BASE}/login`, express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const ip = clientIp(req);
  if (tooManyFailures(ip)) return res.redirect(303, `${BASE}/?e=locked`);
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!passwordMatches(req.body?.password || '')) {
    recordFailure(ip);
    return res.redirect(303, `${BASE}/?e=bad`);
  }
  failures.delete(ip);
  res.cookie(COOKIE, makeSession(name || 'Guest'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: SESSION_DAYS * 864e5,
    encode: String,
  });
  res.redirect(303, `${BASE}/`);
});

app.post(`${BASE}/logout`, (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect(303, `${BASE}/`);
});

app.get(`${BASE}/api/me`, requireAuth, (req, res) => res.json({ name: req.session.name }));
app.get(`${BASE}/api/videos`, requireAuth, (req, res) => res.json(listVideos()));

app.get(`${BASE}/media/:file`, requireAuth, (req, res) => {
  const file = req.params.file;
  if (!isServableMedia(file)) return res.sendStatus(404);
  res.sendFile(file, {
    root: MEDIA_DIR,
    dotfiles: 'deny',
    acceptRanges: true, // HTTP range requests -> instant seeking
    headers: { 'Cache-Control': 'private, max-age=3600' },
  });
});

// Anything else (including wrong room tokens) is a plain 404 so the link can't be guessed.
app.use((req, res) => res.status(404).type('text').send('Not found'));

function loginPage(error) {
  const msg =
    error === 'bad' ? 'Wrong password.' : error === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Movie Night</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="login">
<form class="card" method="post" action="login">
  <h1>🍿 Movie Night</h1>
  <p class="muted">This room is private. Enter the password to join.</p>
  ${msg ? `<p class="error">${msg}</p>` : ''}
  <label>Your name <input name="name" maxlength="30" autocomplete="nickname" required></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Join</button>
</form>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sync room (one shared room; the server holds the authoritative playback state)
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, maxHttpBufferSize: 1e4 });

const room = {
  video: null,
  playing: false,
  position: 0, // seconds, as of updatedAt
  updatedAt: Date.now(),
  held: false, // auto-paused because someone is buffering
  by: null,
  reason: null,
};
const buffering = new Set();
let holdTimer = null;

function currentPosition() {
  return room.position + (room.playing ? (Date.now() - room.updatedAt) / 1000 : 0);
}

function update(changes, by, reason) {
  room.position = currentPosition();
  room.updatedAt = Date.now();
  Object.assign(room, changes);
  room.by = by;
  room.reason = reason;
  broadcastState();
}

function snapshot() {
  return {
    video: room.video,
    playing: room.playing,
    position: currentPosition(),
    held: room.held,
    buffering: [...buffering].map((id) => io.sockets.sockets.get(id)?.data.name).filter(Boolean),
    by: room.by,
    reason: room.reason,
  };
}

function broadcastState() {
  io.emit('state', snapshot());
}

function presence() {
  io.emit('presence', [...io.sockets.sockets.values()].map((s) => s.data.name));
}

function validTime(t) {
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 && t < 1e6;
}

function holdForBuffering() {
  if (room.playing && buffering.size > 0) {
    update({ playing: false, held: true }, null, 'buffering');
    clearTimeout(holdTimer);
    // Never wait forever on a slow connection.
    holdTimer = setTimeout(() => {
      buffering.clear();
      releaseHold();
    }, 20e3);
  }
}

function releaseHold() {
  if (room.held && buffering.size === 0) {
    clearTimeout(holdTimer);
    update({ playing: true, held: false }, null, 'resumed');
  }
}

io.use((socket, next) => {
  const session = readSession(socket.handshake.headers.cookie);
  if (!session) return next(new Error('unauthorized'));
  socket.data.name = session.name;
  next();
});

io.on('connection', (socket) => {
  const name = socket.data.name;
  socket.emit('state', { ...snapshot(), reason: 'welcome' });
  presence();

  socket.on('ping-sync', (cb) => typeof cb === 'function' && cb(Date.now()));

  socket.on('load', (video) => {
    if (!listVideos().some((v) => v.name === video)) return;
    buffering.clear();
    clearTimeout(holdTimer);
    room.position = 0;
    room.updatedAt = Date.now();
    update({ video, playing: false, position: 0, held: false }, name, 'load');
  });

  socket.on('play', (pos) => {
    if (!room.video || !validTime(pos)) return;
    room.position = pos;
    room.updatedAt = Date.now();
    update({ playing: true, held: false }, name, 'play');
    holdForBuffering();
  });

  socket.on('pause', (pos) => {
    if (!room.video || !validTime(pos)) return;
    clearTimeout(holdTimer);
    room.position = pos;
    room.updatedAt = Date.now();
    update({ playing: false, held: false }, name, 'pause');
  });

  socket.on('seek', (pos) => {
    if (!room.video || !validTime(pos)) return;
    room.position = pos;
    room.updatedAt = Date.now();
    update({}, name, 'seek');
  });

  socket.on('buffering', (isBuffering) => {
    if (isBuffering) {
      buffering.add(socket.id);
      holdForBuffering();
    } else if (buffering.delete(socket.id)) {
      releaseHold();
      if (!room.held) broadcastState();
    }
  });

  socket.on('chat', (text) => {
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 500);
    if (text) io.emit('chat', { name, text, time: Date.now() });
  });

  socket.on('disconnect', () => {
    if (buffering.delete(socket.id)) releaseHold();
    presence();
  });
});

// Heartbeat so everyone keeps correcting drift.
setInterval(() => {
  if (room.video && io.engine.clientsCount > 0) io.emit('state', { ...snapshot(), reason: 'tick' });
}, 2000);

server.listen(PORT, HOST, () => {
  console.log(`\n🍿 Movie Night is running on http://${HOST}:${PORT}`);
  console.log(`   Media folder: ${MEDIA_DIR}`);
  console.log(`   Videos found: ${listVideos().length}`);
  console.log(`\n   Room link (share this + the password):\n   ${PUBLIC_URL}${BASE}/\n`);
});

// ---------------------------------------------------------------------------
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
