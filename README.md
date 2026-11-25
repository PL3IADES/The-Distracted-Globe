# 🍿 Movie Night

A private watch-together player you host from your own computer. Put video files in a folder, send someone a link and a password, and you both watch the same file in sync: play, pause, seek and picking a new video happen for both of you. There's also a small chat.

- **Full quality:** each browser streams the actual file. It's not a screen share.
- **Stays in sync:** the server keeps the official playback position. Each player gently speeds up or slows down by 5% to fix small drift, and jumps if it's more than 1.5s off. If one person's video stalls to load, it pauses for both and resumes automatically.
- **Private:**
  - The room link contains an unguessable token, and any other URL returns a plain 404.
  - A password is required, with lockout after 8 wrong tries.
  - Login uses signed, HTTP-only cookies.
  - Video files are only served to logged-in users.
  - Strict security headers are set.
  - By default the server only listens on `127.0.0.1`, so the internet reaches it **only** through your tunnel.
- Works in Safari on Mac, as well as Chrome, Firefox and iPhone.

---

## 1. Install (one time)

You need **Node.js 18+** and **ffmpeg** on the computer that will host.

| | Mac | Windows |
|---|---|---|
| Node.js | `brew install node` | `winget install OpenJS.NodeJS.LTS` |
| ffmpeg | `brew install ffmpeg` | `winget install ffmpeg` |
| cloudflared | `brew install cloudflared` | `winget install Cloudflare.cloudflared` |

Then, in this folder:

```bash
npm install
npm run setup
```

`setup` creates a private `.env` file and prints your **room link** and a random **password**. To choose your own password: `npm run setup -- --password "our-secret-phrase"`.

## 2. Add movies

Browsers can't play every format (MKV, HEVC and DTS audio often fail in Safari), so convert files first:

```bash
npm run convert -- "/path/to/Some Movie.mkv"
```

This writes `media/Some Movie.mp4`, which is H.264 + AAC with "faststart", so it streams and seeks instantly. If the file is already H.264, the video is copied without re-encoding, which only takes seconds. Subtitles are picked up automatically from a matching `.srt` next to the file or from a text subtitle track inside it.

Already have a browser-friendly `.mp4`? Just drop it in `media/`. A `Name.vtt` next to `Name.mp4` shows up as subtitles.

## 3. Start it

```bash
npm start
```

Leave that window open; closing it stops the server. Open the printed **"Open on this computer"** link (it looks like `http://127.0.0.1:3000/w/<token>/`, and the `/w/<token>/` part is required, since `http://127.0.0.1:3000` on its own shows "Not found") and log in.

**"This site can't be reached"?** The server isn't running. Look in the terminal for an error: `Missing SECRET…` means run `npm run setup` first, and `Port 3000 is already in use` means it's already running in another window.

## 4. Put it on the internet with Cloudflare Tunnel

The tunnel gives you an `https://` address without opening router ports or exposing your home IP.

### Option A: quick test, no domain needed
```bash
cloudflared tunnel --url http://127.0.0.1:3000
```
It prints a random `https://….trycloudflare.com` address. Your guest's link is that address + `/w/<ROOM_TOKEN>/`. The address changes every time you run it.

### Option B: your own domain, `movies.miloboynton.cc`
Your domain's DNS is already on Cloudflare, so this is free. A subdomain doesn't affect your main website.

One-time setup:
```bash
npm run tunnel -- setup movies.miloboynton.cc
```
This opens a browser to log in to Cloudflare (pick `miloboynton.cc`), creates a tunnel called `movienight`, adds the `movies` DNS record, and saves the address in `.env`. It never overwrites an existing DNS record.

Every movie night, run these in two terminal windows:
```bash
npm start          # window 1: the app
npm run tunnel     # window 2: connects it to https://movies.miloboynton.cc
```

The link to send her is `https://movies.miloboynton.cc/w/<ROOM_TOKEN>/`. `npm start` prints it.

> Send the **link** and the **password** separately, for example the link by text and the password by phone call.

## 5. Watching together

1. Both open the link and log in. Your names appear at the top right.
2. Either person picks a video from the menu. It loads for both.
3. Either person presses play, pause or scrubs, and the other follows. The status line under the video shows whether you're in sync.
4. Safari sometimes blocks a video from starting until you've clicked the page. If a **"Click to join playback"** button appears, click it once.

## Settings and maintenance

| Task | Command |
|---|---|
| Use a different subdomain | `npm run tunnel -- setup tv.miloboynton.cc` |
| New room link (old one stops working) | `npm run setup -- --new-link` |
| New password (logs everyone out) | `npm run setup -- --password "…"` |
| Better or worse convert quality | `npm run convert -- --quality 18 file.mkv` (lower = better, bigger) |
| Keep 4K instead of downscaling to 1080p | `npm run convert -- --max-height 2160 file.mkv` |

Other options live in `.env`, which is git-ignored, so never commit it: `PORT`, `HOST`, `MEDIA_DIR` (point it at an external drive, for example) and `SESSION_DAYS`.

### Bandwidth tip
Your home **upload** speed is the limit, because she streams from you. 1080p at the default quality is usually about 3–8 Mbps. If she buffers, convert with `--max-height 720` or `--quality 23`. Run a speed test and look at the *upload* number.

### Keeping your computer awake
On a Mac host, run `caffeinate -i npm start` so it doesn't sleep mid-movie. On Windows, set sleep to "Never" while plugged in.

## How it works

```
 her Safari ──https──▶ Cloudflare ──tunnel──▶ cloudflared ──▶ server.js (127.0.0.1:3000) ◀── your browser
                                                               ├─ /w/<token>/            login + player page
                                                               ├─ /w/<token>/media/…     video (HTTP range requests)
                                                               └─ /socket.io             sync: play/pause/seek/load/chat
```

- `server.js`: the Express server, login and sessions, media streaming, and the Socket.IO sync room.
- `public/player.js`: applies the room state to the `<video>` element, handles drift correction and buffering detection, and sends your actions.
- `scripts/setup.js`: generates and updates `.env`.
- `scripts/convert.js`: the ffmpeg wrapper for browser-safe MP4 and VTT subtitles.
