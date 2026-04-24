/**
 * WebRTC Clipboard - Signaling Server
 *
 * The server only relays signaling messages (SDP/ICE) between peers in the same
 * room. It NEVER sees the encryption key (which lives in the URL hash fragment
 * client-side) and NEVER sees clipboard contents or files (those go peer-to-peer
 * over WebRTC DataChannels).
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Friendly room ID generator
app.get('/api/new-room', (_req, res) => {
  const id = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  res.json({ roomId: id });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Set<WebSocket>>} */
const rooms = new Map();

function broadcast(roomId, sender, payload) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  const data = JSON.stringify(payload);
  for (const peer of peers) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      peer.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.peerId = crypto.randomBytes(6).toString('hex');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '').slice(0, 64);
      if (!roomId) return;
      ws.roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const peers = rooms.get(roomId);
      peers.add(ws);
      ws.send(
        JSON.stringify({
          type: 'joined',
          peerId: ws.peerId,
          peerCount: peers.size,
        })
      );
      // Notify other peers a new one arrived
      broadcast(roomId, ws, { type: 'peer-joined', peerId: ws.peerId });
      return;
    }

    if (!ws.roomId) return;

    // Relay signaling messages (offer/answer/ice/etc.)
    if (['offer', 'answer', 'ice', 'bye'].includes(msg.type)) {
      broadcast(ws.roomId, ws, { ...msg, from: ws.peerId });
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const peers = rooms.get(ws.roomId);
    if (!peers) return;
    peers.delete(ws);
    if (peers.size === 0) rooms.delete(ws.roomId);
    else broadcast(ws.roomId, ws, { type: 'peer-left', peerId: ws.peerId });
  });
});

server.listen(PORT, () => {
  console.log(`WebRTC Clipboard signaling server running on http://localhost:${PORT}`);
});
