// server.js — Beam signaling server
//
// What this server does:
//   - Serves the static web app (public/)
//   - Lets two browsers find each other using a short room code
//   - Relays WebRTC handshake messages (SDP/ICE) between them
//
// What this server NEVER does:
//   - See, touch, or store any file content. Once the two devices are
//     connected, files flow directly between them over WebRTC.

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud/type
const ROOM_CODE_LENGTH = 5;
const ROOM_TTL_MS = 10 * 60 * 1000; // rooms expire after 10 min if unused
const MAX_ROOM_AGE_CHECK_MS = 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** @type {Map<string, {host: WebSocket|null, guest: WebSocket|null, createdAt: number}>} */
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function otherPeer(room, ws) {
  if (room.host === ws) return room.guest;
  if (room.guest === ws) return room.host;
  return null;
}

function cleanupSocket(ws) {
  const roomCode = ws.roomCode;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  const peer = otherPeer(room, ws);
  if (peer) send(peer, { type: 'peer-left' });

  if (room.host === ws) room.host = null;
  if (room.guest === ws) room.guest = null;

  if (!room.host && !room.guest) {
    rooms.delete(roomCode);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Malformed message' });
    }

    switch (msg.type) {
      case 'create': {
        const code = generateRoomCode();
        rooms.set(code, { host: ws, guest: null, createdAt: Date.now() });
        ws.roomCode = code;
        ws.role = 'host';
        send(ws, { type: 'created', room: code });
        break;
      }

      case 'join': {
        const code = String(msg.room || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room || !room.host) {
          return send(ws, { type: 'error', message: 'Room not found or expired' });
        }
        if (room.guest) {
          return send(ws, { type: 'error', message: 'Room already has two devices' });
        }
        room.guest = ws;
        ws.roomCode = code;
        ws.role = 'guest';
        send(ws, { type: 'joined', room: code });
        send(room.host, { type: 'peer-joined' });
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const peer = otherPeer(room, ws);
        if (peer) send(peer, { type: 'signal', data: msg.data });
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => cleanupSocket(ws));
  ws.on('error', () => cleanupSocket(ws));
});

// Heartbeat: drop dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      cleanupSocket(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Sweep expired/empty rooms
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const empty = !room.host && !room.guest;
    const stale = now - room.createdAt > ROOM_TTL_MS;
    if (empty || stale) {
      if (room.host) send(room.host, { type: 'error', message: 'Room expired' });
      if (room.guest) send(room.guest, { type: 'error', message: 'Room expired' });
      rooms.delete(code);
    }
  }
}, MAX_ROOM_AGE_CHECK_MS);

server.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(sweeper);
});

server.listen(PORT, () => {
  console.log(`Beam signaling server running on port ${PORT}`);
});
