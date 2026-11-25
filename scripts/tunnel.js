#!/usr/bin/env node
'use strict';

// Cloudflare Tunnel helper.
//   One-time:  npm run tunnel -- setup movies.yourdomain.com
//   Each time: npm run tunnel          (keep it running next to `npm start`)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const env = readEnv();
const PORT = env.PORT || '3000';
const TUNNEL = env.TUNNEL_NAME || 'movienight';

if (spawnSync('cloudflared', ['--version']).error) {
  console.error('cloudflared is not installed. Mac: brew install cloudflared   Windows: winget install Cloudflare.cloudflared');
  process.exit(1);
}
if (!fs.existsSync(envPath)) {
  console.error('Run `npm run setup` first.');
  process.exit(1);
}

const [cmd, hostname] = process.argv.slice(2);
if (cmd === 'setup') setup(hostname);
else run();

function cf(args, opts = {}) {
  console.log(`$ cloudflared ${args.join(' ')}`);
  return spawnSync('cloudflared', args, { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
}

function setup(host) {
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    console.error('Usage: npm run tunnel -- setup movies.yourdomain.com');
    process.exit(1);
  }

  // 1. Log in to Cloudflare (opens a browser; pick the domain) unless already done.
  if (!fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem'))) {
    if (cf(['tunnel', 'login']).status !== 0) process.exit(1);
  }

  // 2. Create the tunnel unless it already exists.
  if (cf(['tunnel', 'info', TUNNEL], { quiet: true }).status !== 0) {
    if (cf(['tunnel', 'create', TUNNEL]).status !== 0) process.exit(1);
  } else {
    console.log(`Tunnel "${TUNNEL}" already exists, reusing it.`);
  }

  // 3. Point the hostname at the tunnel. Never overwrites an existing DNS record.
  const route = cf(['tunnel', 'route', 'dns', TUNNEL, host], { quiet: true });
  const out = `${route.stdout || ''}${route.stderr || ''}`;
  if (route.status !== 0 && !/already (configured|exists)/i.test(out)) {
    console.error(out.trim());
    console.error(`\nCould not create the DNS record for ${host}. If a record with that name already exists`);
    console.error('in the Cloudflare dashboard (DNS tab), delete it or pick another subdomain, then run this again.');
    process.exit(1);
  }

  // 4. Save it, so the server prints the right link.
  writeEnv({ PUBLIC_URL: `https://${host}`, TUNNEL_NAME: TUNNEL });
  console.log(`\n✓ ${host} now points at your tunnel "${TUNNEL}".`);
  console.log('  Next: run `npm start` in one terminal and `npm run tunnel` in another.\n');
}

function run() {
  console.log(`Starting tunnel "${TUNNEL}" → http://127.0.0.1:${PORT}`);
  if (env.PUBLIC_URL?.startsWith('https://')) console.log(`Public address: ${env.PUBLIC_URL}`);
  console.log('Leave this window open while you watch. Ctrl+C to stop.\n');
  const child = spawn('cloudflared', ['tunnel', 'run', '--url', `http://127.0.0.1:${PORT}`, TUNNEL], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return out;
}

function writeEnv(values) {
  let text = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, text, { mode: 0o600 });
}
