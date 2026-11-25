#!/usr/bin/env node
'use strict';

// Creates .env with a random secret, an unguessable room link, and a password.
// Usage: npm run setup                  -> create .env (keeps an existing one)
//        npm run setup -- --new-link    -> rotate the room link (old link stops working)
//        npm run setup -- --password "something"   -> set a new password (logs everyone out)
//        npm run setup -- --url https://movies.example.com   -> set the public URL

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', '.env');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const words = ['popcorn', 'velvet', 'comet', 'maple', 'harbor', 'lantern', 'meadow', 'cinema', 'orbit', 'willow',
  'ember', 'saffron', 'tidal', 'cobalt', 'juniper', 'nebula', 'quartz', 'falcon', 'marble', 'sunset'];
const randomPassword = () =>
  [0, 1, 2].map(() => words[crypto.randomInt(words.length)]).join('-') + '-' + crypto.randomInt(10, 100);

env.SECRET ||= crypto.randomBytes(32).toString('hex');
if (!env.ROOM_TOKEN || args.includes('--new-link')) env.ROOM_TOKEN = crypto.randomBytes(18).toString('base64url');
env.ROOM_PASSWORD = argValue('--password') || env.ROOM_PASSWORD || randomPassword();
env.PUBLIC_URL = argValue('--url') || env.PUBLIC_URL || 'http://127.0.0.1:3000';
env.PORT ||= '3000';
env.HOST ||= '127.0.0.1';
env.MEDIA_DIR ||= './media';
env.SESSION_DAYS ||= '7';

const out = `# Movie Night configuration. Keep this file private (it is git-ignored).
# Signing key for login cookies. Never share.
SECRET=${env.SECRET}
# Secret part of the room link.
ROOM_TOKEN=${env.ROOM_TOKEN}
# Password your guest types in. Changing it logs everyone out.
ROOM_PASSWORD=${env.ROOM_PASSWORD}
# The public address of your tunnel, e.g. https://movies.yourdomain.com
PUBLIC_URL=${env.PUBLIC_URL}
PORT=${env.PORT}
# 127.0.0.1 = only reachable through the tunnel. 0.0.0.0 = also from your home network.
HOST=${env.HOST}
# Folder with your converted .mp4 files (and optional matching .vtt subtitles).
MEDIA_DIR=${env.MEDIA_DIR}
# How long a login lasts.
SESSION_DAYS=${env.SESSION_DAYS}
`;
fs.writeFileSync(envPath, out, { mode: 0o600 });

console.log(`\nSaved ${envPath}\n`);
console.log(`  Room link: ${env.PUBLIC_URL.replace(/\/+$/, '')}/w/${env.ROOM_TOKEN}/`);
console.log(`  Password:  ${env.ROOM_PASSWORD}\n`);
console.log('Send the link and the password to your guest separately (e.g. link by text, password by call).\n');
