#!/usr/bin/env node
'use strict';

// Converts any video into a browser-friendly MP4 (H.264 + AAC, "faststart") in the media folder,
// so it streams and seeks instantly in Safari, Chrome and Firefox. Also extracts the first
// text subtitle track (or uses a matching .srt next to the file) as .vtt.
//
// Usage: npm run convert -- "/path/to/Movie.mkv" ["/path/to/Another.mp4" ...]
// Options: --quality 20   (CRF: lower = better quality / bigger file, 18-23 is sensible)
//          --max-height 1080   (downscale larger videos; keeps upload bandwidth sane)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
loadEnv(path.join(root, '.env'));
const mediaDir = path.resolve(root, process.env.MEDIA_DIR || 'media');

const args = process.argv.slice(2);
const opt = (flag, def) => {
  const i = args.indexOf(flag);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const crf = String(Number(opt('--quality', 20)) || 20);
const maxHeight = Number(opt('--max-height', 1080)) || 1080;
const inputs = args;

if (!inputs.length) {
  console.log('Usage: npm run convert -- "/path/to/Movie.mkv" [more files...]');
  process.exit(1);
}
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (spawnSync(tool, ['-version']).error) {
    console.error(`${tool} not found. Install ffmpeg first (Mac: brew install ffmpeg, Windows: winget install ffmpeg).`);
    process.exit(1);
  }
}
fs.mkdirSync(mediaDir, { recursive: true });

for (const input of inputs) convert(path.resolve(input));

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout).streams;
}

function convert(input) {
  if (!fs.existsSync(input)) {
    console.error(`Not found: ${input}`);
    return;
  }
  const base = path.parse(input).name.replace(/[^\w .()[\]-]+/g, '').trim() || 'video';
  const out = path.join(mediaDir, `${base}.mp4`);
  const streams = probe(input);
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) {
    console.error(`No video stream in ${input}`);
    return;
  }

  // Re-use the video stream as-is when it's already browser-safe H.264 at a sane size (fast!).
  const copyVideo = v.codec_name === 'h264' && (v.pix_fmt === 'yuv420p' || !v.pix_fmt) && (v.height || 0) <= maxHeight;
  const copyAudio = a && a.codec_name === 'aac' && (a.channels || 2) <= 2;

  const ff = ['-hide_banner', '-y', '-i', input, '-map', '0:v:0'];
  if (a) ff.push('-map', '0:a:0');
  if (copyVideo) ff.push('-c:v', 'copy');
  else {
    ff.push('-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-profile:v', 'high');
    if ((v.height || 0) > maxHeight) ff.push('-vf', `scale=-2:${maxHeight}`);
  }
  if (a) ff.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
  ff.push('-movflags', '+faststart', '-sn', out);

  console.log(`\n▶ ${path.basename(input)} → ${path.relative(root, out)}`);
  console.log(`  video: ${copyVideo ? 'copy (already H.264)' : `re-encode H.264 crf ${crf}`}, audio: ${!a ? 'none' : copyAudio ? 'copy' : 're-encode AAC stereo'}`);
  const r = spawnSync('ffmpeg', ff, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error(`  ✗ ffmpeg failed for ${input}`);
    return;
  }

  // Subtitles: a sidecar .srt/.vtt wins, otherwise the first text subtitle track in the file.
  const vtt = path.join(mediaDir, `${base}.vtt`);
  const sidecar = ['.srt', '.vtt'].map((e) => input.replace(/\.[^.]+$/, e)).find((f) => fs.existsSync(f));
  const textSubs = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'];
  const subIndex = streams.filter((s) => s.codec_type === 'subtitle').findIndex((s) => textSubs.includes(s.codec_name));
  if (sidecar) {
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', sidecar, vtt], { stdio: 'inherit' });
  } else if (subIndex >= 0) {
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', `0:s:${subIndex}`, vtt], { stdio: 'inherit' });
  }
  console.log(`  ✓ done${fs.existsSync(vtt) ? ' (with subtitles)' : ''}`);
}

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}
