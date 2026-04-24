# P2P Clipboard

End-to-end encrypted clipboard and file sharing between browsers using WebRTC
Data Channels. The server only relays signaling — it never sees the encryption
key, your text, or your files.

## Features

- **Room creation with QR code** — open the link on another device or scan to join
- **WebSocket signaling server** — minimal Node.js + `ws`, only relays SDP/ICE
- **End-to-end encryption** — AES-GCM 256, key generated client-side and stored
  in the URL hash fragment (never sent to the server)
- **Real-time clipboard sync** — type on one device, appears on the other
- **File sharing** — drag & drop, chunked, with progress bars and backpressure
- **No cloud storage** — all payloads transit peer-to-peer over WebRTC

## How encryption works

1. The creator's browser generates a random 256-bit AES-GCM key and puts it in
   the URL hash: `#<roomId>.<base64url-key>`.
2. Browsers never send the hash fragment to the server.
3. Both peers import the same key and encrypt every WebRTC frame with a fresh
   random 96-bit IV.
4. The signaling server only sees the room ID and opaque SDP/ICE payloads.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` and click **Create new room**, then open the
generated link (or scan the QR) on another device on the same network.

> For cross-network connections you may need a TURN server (current config
> uses public STUN only). Add TURN credentials in `public/app.js` under
> `iceServers`.

## Deploy to Render.com (free, supports WebSockets)

Render's free Web Service tier supports the persistent WebSocket connection
this app needs. No code changes required.

### One-time setup

1. Push this folder to a GitHub repo:
   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/webrtc-clipboard.git
   git push -u origin main
   ```
2. Go to <https://dashboard.render.com/> and click **New +** &rarr; **Blueprint**.
3. Connect the GitHub repo. Render will auto-detect `render.yaml` and create
   the service.
4. Click **Apply**. First build takes ~2 minutes.
5. You'll get a public URL like `https://webrtc-clipboard.onrender.com`.

### Notes

- The client auto-detects HTTPS and uses `wss://` for signaling — nothing to configure.
- Render's free tier spins the service down after ~15 min of inactivity and
  cold-starts on the next request (a few seconds). Upgrade to a paid plan to keep it warm.
- For peers behind strict NATs (mobile carriers, corporate networks) you'll
  need a TURN server. Add credentials in `public/app.js` under `iceServers`.
  Free options: <https://www.metered.ca/tools/openrelay/>.

## Project layout

- `server.js` — Express static server + `/ws` signaling
- `public/index.html` — landing page (create / join)
- `public/room.html` — room UI (clipboard, files, QR)
- `public/app.js` — WebRTC + AES-GCM + clipboard/file logic
- `public/styles.css` — UI styling
