'use strict';

(() => {
  const video = document.getElementById('video');
  const select = document.getElementById('videoSelect');
  const statusEl = document.getElementById('status');
  const emptyEl = document.getElementById('empty');
  const unlockBtn = document.getElementById('unlock');
  const presenceEl = document.getElementById('presence');
  const toastEl = document.getElementById('toast');
  const messages = document.getElementById('messages');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');

  const HARD_SEEK = 1.5; // seconds off -> jump
  const SOFT_DRIFT = 0.25; // seconds off -> nudge playback speed
  const USER_SEEK_THRESHOLD = 1.0; // a local seek this far from the room = the user seeked

  let me = '';
  let server = null; // last state from server
  let receivedAt = 0; // performance.now() when `server` arrived
  let rtt = 0.1; // seconds, smoothed round-trip time
  let currentSrc = null;
  let videos = [];
  let iAmBuffering = false;
  let waitTimer = null;

  const socket = io({ transports: ['websocket', 'polling'] });

  // ---------------------------------------------------------------- helpers
  function roomPosition() {
    if (!server) return 0;
    const elapsed = server.playing ? (performance.now() - receivedAt) / 1000 + rtt / 2 : 0;
    return server.position + elapsed;
  }

  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
  }

  function setBuffering(value) {
    if (value === iAmBuffering) return;
    iAmBuffering = value;
    socket.emit('buffering', value);
  }

  async function loadLibrary() {
    try {
      const res = await fetch('api/videos', { credentials: 'same-origin' });
      if (res.status === 401) return location.reload();
      videos = await res.json();
    } catch {
      return;
    }
    const current = server?.video || '';
    select.replaceChildren(new Option(videos.length ? 'Choose a video…' : 'No videos in media folder', ''));
    for (const v of videos) select.add(new Option(v.name.replace(/\.[^.]+$/, ''), v.name));
    select.value = current;
  }

  function loadVideo(name) {
    currentSrc = name;
    video.querySelectorAll('track').forEach((t) => t.remove());
    if (!name) {
      video.removeAttribute('src');
      video.load();
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    video.src = `media/${encodeURIComponent(name)}`;
    const info = videos.find((v) => v.name === name);
    if (info?.subtitles) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = 'Subtitles';
      track.srclang = 'en';
      track.src = `media/${encodeURIComponent(info.subtitles)}`;
      video.appendChild(track);
    }
    video.load();
  }

  // ------------------------------------------------- apply room state to <video>
  function apply() {
    if (!server) return;

    if (server.video !== currentSrc) {
      if (server.video && !videos.some((v) => v.name === server.video)) {
        loadLibrary().then(() => {
          loadVideo(server.video);
        });
      } else {
        loadVideo(server.video);
      }
      select.value = server.video || '';
      return; // continue once metadata is loaded
    }
    if (!server.video || video.readyState < 1) return;
    if (video.seeking) return; // don't fight a seek that's in progress (ours or the user's)

    const target = roomPosition();
    const diff = video.currentTime - target;

    if (!server.playing) {
      video.playbackRate = 1;
      // While held for buffering, let the buffering person keep loading.
      if (!(server.held && iAmBuffering) && !video.paused) video.pause();
      if (Math.abs(diff) > SOFT_DRIFT && !(server.held && iAmBuffering)) video.currentTime = target;
      return;
    }

    if (Math.abs(diff) > HARD_SEEK) {
      video.currentTime = target;
      video.playbackRate = 1;
    } else if (Math.abs(diff) > SOFT_DRIFT) {
      video.playbackRate = diff > 0 ? 0.95 : 1.05; // gently catch up / fall back
    } else {
      video.playbackRate = 1;
    }

    if (video.paused) {
      video.play().then(
        () => (unlockBtn.hidden = true),
        (err) => {
          // Safari blocks play() until the user has clicked something on the page.
          if (err.name === 'NotAllowedError') unlockBtn.hidden = false;
        }
      );
    }
  }

  function updateStatus() {
    if (!server) return;
    let text;
    if (!server.video) text = 'Nothing playing';
    else if (server.held) text = `Waiting for ${server.buffering.join(', ') || 'someone'} to buffer…`;
    else text = `${server.playing ? '▶ Playing' : '⏸ Paused'} · ${fmt(roomPosition())}`;
    if (server.video && video.readyState >= 1) {
      const drift = video.currentTime - roomPosition();
      text += ` · in sync ${Math.abs(drift) < 0.5 ? '✓' : `(off ${drift.toFixed(1)}s)`}`;
    }
    statusEl.textContent = text;
  }
  setInterval(updateStatus, 500);

  // ------------------------------------------------ local user actions -> server
  video.addEventListener('play', () => {
    if (!server || server.playing) return; // already playing in the room (or remote-triggered)
    socket.emit('play', video.currentTime);
  });

  video.addEventListener('pause', () => {
    if (!server || !server.playing || video.ended) return;
    if (video.seeking) return; // Safari pauses briefly during some seeks
    socket.emit('pause', video.currentTime);
  });

  video.addEventListener('seeked', () => {
    if (!server) return;
    if (Math.abs(video.currentTime - roomPosition()) > USER_SEEK_THRESHOLD) {
      socket.emit('seek', video.currentTime);
    }
  });

  video.addEventListener('loadedmetadata', apply);

  // Buffering detection: only while we are supposed to be playing.
  video.addEventListener('waiting', () => {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      if (!video.paused && video.readyState < 3) setBuffering(true);
    }, 800);
  });
  video.addEventListener('playing', () => {
    clearTimeout(waitTimer);
    setBuffering(false);
  });
  video.addEventListener('canplay', () => {
    if (iAmBuffering && server?.held) setBuffering(false);
  });

  unlockBtn.addEventListener('click', () => {
    unlockBtn.hidden = true;
    apply();
  });

  select.addEventListener('focus', loadLibrary);
  select.addEventListener('change', () => {
    if (select.value) socket.emit('load', select.value);
  });

  // --------------------------------------------------------------- socket events
  socket.on('connect', () => {
    statusEl.textContent = 'Connected';
    measureRtt();
  });
  socket.on('disconnect', () => (statusEl.textContent = 'Disconnected — reconnecting…'));
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') location.reload();
    else statusEl.textContent = 'Connection problem — retrying…';
  });

  socket.on('state', (state) => {
    const prev = server;
    server = state;
    receivedAt = performance.now();
    apply();
    updateStatus();

    if (state.by && state.by !== me && state.reason !== 'tick') {
      if (state.reason === 'play') toast(`${state.by} pressed play`);
      if (state.reason === 'pause') toast(`${state.by} paused`);
      if (state.reason === 'seek') toast(`${state.by} jumped to ${fmt(state.position)}`);
      if (state.reason === 'load') toast(`${state.by} picked ${state.video.replace(/\.[^.]+$/, '')}`);
    }
    if (state.reason === 'buffering' && !prev?.held) toast('Paused while someone buffers…');
    if (state.reason === 'resumed') toast('Resuming');
  });

  socket.on('presence', (names) => {
    presenceEl.replaceChildren(
      ...names.map((n) => {
        const span = document.createElement('span');
        span.className = 'pill';
        span.textContent = n;
        return span;
      })
    );
  });

  socket.on('chat', ({ name, text, time }) => {
    const li = document.createElement('li');
    const who = document.createElement('strong');
    who.textContent = name;
    const when = document.createElement('time');
    when.textContent = new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    li.append(who, ' ', when, document.createElement('br'), text);
    messages.appendChild(li);
    messages.scrollTop = messages.scrollHeight;
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (chatInput.value.trim()) socket.emit('chat', chatInput.value);
    chatInput.value = '';
  });

  function measureRtt() {
    const t0 = performance.now();
    socket.timeout(5000).emit('ping-sync', (err) => {
      if (err) return;
      const sample = (performance.now() - t0) / 1000;
      rtt = rtt * 0.7 + sample * 0.3;
    });
  }
  setInterval(measureRtt, 5000);

  // ---------------------------------------------------------------------- init
  fetch('api/me', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : location.reload()))
    .then((d) => d && (me = d.name));
  loadLibrary();
})();
