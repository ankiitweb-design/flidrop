# Beam — send files straight between your devices

A small web app for moving files (photos, videos, anything) directly between
two devices — phone to laptop, Android to iPhone, laptop to Mac, whatever.
No app install, no account, no upload step.

## How it actually works

There are two parts:

1. **The signaling server** (`server/`) — a tiny Node.js server. Its only
   job is to let two browsers find each other using a 5-character room
   code, then pass along a short technical "handshake" between them. It
   never sees, stores, or touches the files themselves.
2. **The web app** (`public/`) — the page you open on both devices. Once
   the handshake is done, the two browsers open a direct connection
   (WebRTC) and the file flows straight from one device to the other.

This is the same underlying tech video calls use, repurposed for files
instead of camera/mic streams. It's why transfers can be fast and don't
depend on uploading to some company's server first.

## Running it locally (to try it out)

You'll need Node.js installed (v18 or newer).

```bash
cd server
npm install
npm start
```

Then open `http://localhost:3000` on two devices on the same Wi-Fi
(or two browser tabs on the same computer, to test). On one, choose
"Send files." On the other, choose "Receive files" and type in the
5-letter code (or scan the QR code with your phone's camera).

## Putting it on the internet (so it works from anywhere, not just home Wi-Fi)

Since you mentioned you don't have hosting yet, here are free options that
work well for this kind of small Node.js app:

- **Render.com** — free tier, connects directly to a GitHub repo, auto-deploys
  on every push. Good first choice.
- **Railway.app** — similar free-tier flow, slightly more generous limits.
- **Fly.io** — free allowance, a bit more setup but very reliable.

General steps (Render as the example):
1. Push this project to a GitHub repo.
2. On Render, create a "New Web Service," point it at the repo, set the
   root directory to `server`, build command `npm install`, start command
   `npm start`.
3. Render gives you a `https://your-app.onrender.com` URL — that's your
   Beam link. Open it on any device, anywhere.

Once it's live on a real domain with `https://`, everything in the app
(camera-based QR scanning, the connection itself) works the same way, just
reachable from any network instead of only your home Wi-Fi.

## Two honest limitations worth knowing

**Very restrictive networks.** This app uses public "STUN" servers to help
two devices on different networks find each other directly. That works for
the vast majority of home/mobile connections. Some corporate or
public-Wi-Fi networks have stricter firewalls that block this. If a
transfer ever refuses to connect across two different networks, the
reliable fallback is putting both devices on the same Wi-Fi temporarily —
that always works, since direct discovery is easy on a local network. If
you find this happening a lot, the long-term fix is paying for a "TURN"
server add-on (a relay of last resort) — I'm happy to walk you through
that later if it becomes a real need.

**Very large files on iPhone/iPad.** Every browser except Safari can
stream an incoming file straight to disk as it arrives. Safari on iOS
currently can't, so it holds the file in memory until it's fully received.
For photos and most videos this is a non-issue. For huge files (multi-GB
movies) sent *to* an iPhone specifically, it can hit a memory ceiling.
Sending *from* an iPhone, or transfers to Android/laptop/Mac, don't have
this limit.

## What's in the project

```
beam/
├── server/
│   ├── server.js       — the signaling server
│   └── package.json
└── public/
    ├── index.html       — the page structure
    ├── style.css        — the design
    ├── app.js            — connection + file transfer logic
    └── vendor/qrcode.js  — QR code generation (self-hosted, no external CDN)
```

## What I tested before handing this to you

- Automated tests confirming room creation, pairing, and the technical
  handshake relay all work correctly.
- A real file sent through a real peer-to-peer connection between two
  browser tabs, with the received file's checksum verified byte-for-byte
  identical to the original.
- Multiple files of different types (`.bin`, `.jpg`, `.mp4`) queued and
  sent in one go.
- The phone-sized layout (390px wide) alongside a desktop-sized layout, to
  confirm phone-to-laptop transfers look right on both ends.
