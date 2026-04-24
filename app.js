/**
 * Room client: WebRTC + E2E encryption + clipboard/file sync.
 *
 * Hash format: #<roomId>.<base64url-key>
 * The server only sees roomId; the AES-GCM key never leaves this page.
 */

// ---------- Hash parsing ----------
const hash = location.hash.replace(/^#/, '');
const [roomId, keyB64] = hash.split('.');
if (!roomId || !keyB64) {
  alert('Missing room ID or key in URL. Returning home.');
  location.href = '/';
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyBytes = b64urlToBytes(keyB64);
let aesKey;

(async () => {
  aesKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
})();

// ---------- UI refs ----------
const shareLinkEl = document.getElementById('shareLink');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const roomIdLabel = document.getElementById('roomIdLabel');
const peerCountEl = document.getElementById('peerCount');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const clipboardEl = document.getElementById('clipboard');
const syncIndicator = document.getElementById('syncIndicator');
const copyClipBtn = document.getElementById('copyClipBtn');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileListEl = document.getElementById('fileList');

shareLinkEl.value = location.href;
roomIdLabel.textContent = roomId;

copyLinkBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(location.href);
  copyLinkBtn.textContent = 'Copied!';
  setTimeout(() => (copyLinkBtn.textContent = 'Copy'), 1200);
});

copyClipBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(clipboardEl.value);
  copyClipBtn.textContent = 'Copied!';
  setTimeout(() => (copyClipBtn.textContent = 'Copy to system clipboard'), 1200);
});

// QR code
QRCode.toCanvas(document.getElementById('qrcode'), location.href, {
  width: 180,
  margin: 1,
  color: { dark: '#0b0d12', light: '#ffffff' },
});

// Tabs
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const tab = t.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.panel !== tab);
    });
  });
});

function setStatus(state, text) {
  connDot.classList.remove('warn', 'err');
  if (state === 'warn') connDot.classList.add('warn');
  if (state === 'err') connDot.classList.add('err');
  connText.textContent = text;
}

// ---------- Encryption helpers ----------
const FRAME_JSON = 1;
const FRAME_BIN = 2;
const IV_LEN = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function encryptFrame(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext)
  );
  const out = new Uint8Array(IV_LEN + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_LEN);
  return out.buffer;
}

async function decryptFrame(buf) {
  const data = new Uint8Array(buf);
  const iv = data.slice(0, IV_LEN);
  const ct = data.slice(IV_LEN);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
  return new Uint8Array(pt);
}

async function sendJSON(obj) {
  if (!dc || dc.readyState !== 'open') return;
  const body = enc.encode(JSON.stringify(obj));
  const frame = new Uint8Array(1 + body.length);
  frame[0] = FRAME_JSON;
  frame.set(body, 1);
  const ct = await encryptFrame(frame);
  dc.send(ct);
}

async function sendBinaryChunk(fileId, seq, chunk) {
  if (!dc || dc.readyState !== 'open') return;
  const frame = new Uint8Array(1 + 4 + 4 + chunk.byteLength);
  frame[0] = FRAME_BIN;
  const dv = new DataView(frame.buffer);
  dv.setUint32(1, fileId, false);
  dv.setUint32(5, seq, false);
  frame.set(new Uint8Array(chunk), 9);
  const ct = await encryptFrame(frame);
  dc.send(ct);
}

// ---------- Signaling ----------
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProto}//${location.host}/ws`);
let myPeerId = null;
let pc = null;
let dc = null;
let makingOffer = false;
let polite = false; // tie-breaker
let initiator = false;

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'join', roomId }));
});

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'joined') {
    myPeerId = msg.peerId;
    peerCountEl.textContent = msg.peerCount;
    if (msg.peerCount >= 2) {
      // Someone already here; we initiate.
      initiator = true;
      ensurePeer();
      await makeOffer();
    } else {
      setStatus('warn', 'Waiting for peer…');
    }
    return;
  }

  if (msg.type === 'peer-joined') {
    peerCountEl.textContent = String(parseInt(peerCountEl.textContent || '1') + 1);
    // The earlier peer initiates only if not already connected.
    if (!pc) {
      initiator = true;
      ensurePeer();
      await makeOffer();
    }
    return;
  }

  if (msg.type === 'peer-left') {
    peerCountEl.textContent = String(Math.max(1, parseInt(peerCountEl.textContent || '1') - 1));
    setStatus('warn', 'Peer disconnected');
    if (pc) {
      pc.close();
      pc = null;
      dc = null;
    }
    return;
  }

  if (msg.type === 'offer') {
    ensurePeer();
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    return;
  }

  if (msg.type === 'answer') {
    if (pc && pc.signalingState !== 'stable') {
      await pc.setRemoteDescription(msg.sdp);
    }
    return;
  }

  if (msg.type === 'ice') {
    try {
      if (pc) await pc.addIceCandidate(msg.candidate);
    } catch (err) {
      console.warn('ICE add failed', err);
    }
    return;
  }
});

function ensurePeer() {
  if (pc) return;
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') setStatus('ok', 'Peer connected · encrypted');
    else if (s === 'connecting') setStatus('warn', 'Connecting…');
    else if (s === 'failed') setStatus('err', 'Connection failed');
    else if (s === 'disconnected') setStatus('warn', 'Disconnected');
  };
  pc.ondatachannel = (ev) => {
    setupDataChannel(ev.channel);
  };

  if (initiator) {
    const channel = pc.createDataChannel('data', { ordered: true });
    setupDataChannel(channel);
  }
}

async function makeOffer() {
  try {
    makingOffer = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
  } finally {
    makingOffer = false;
  }
}

function setupDataChannel(channel) {
  dc = channel;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 1 * 1024 * 1024;

  dc.onopen = () => {
    setStatus('ok', 'Peer connected · encrypted');
    // Send current clipboard contents to new peer
    if (clipboardEl.value) {
      sendJSON({ kind: 'clip', text: clipboardEl.value, ts: Date.now() });
    }
  };
  dc.onclose = () => setStatus('warn', 'Channel closed');
  dc.onmessage = async (ev) => {
    try {
      const plain = await decryptFrame(ev.data);
      handleFrame(plain);
    } catch (err) {
      console.error('Decrypt failed', err);
    }
  };
}

// ---------- Inbound frame handling ----------
let lastRemoteClipTs = 0;

function handleFrame(frame) {
  const type = frame[0];
  if (type === FRAME_JSON) {
    const obj = JSON.parse(dec.decode(frame.subarray(1)));
    if (obj.kind === 'clip') {
      if (obj.ts > lastRemoteClipTs) {
        lastRemoteClipTs = obj.ts;
        suppressNextInput = true;
        clipboardEl.value = obj.text;
        flashSync('Synced from peer');
      }
    } else if (obj.kind === 'file-meta') {
      beginIncomingFile(obj);
    } else if (obj.kind === 'file-end') {
      finishIncomingFile(obj.fileId);
    }
  } else if (type === FRAME_BIN) {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const fileId = dv.getUint32(1, false);
    const seq = dv.getUint32(5, false);
    const chunk = frame.subarray(9);
    receiveFileChunk(fileId, seq, chunk);
  }
}

// ---------- Clipboard sync ----------
let suppressNextInput = false;
let clipDebounce = null;
clipboardEl.addEventListener('input', () => {
  if (suppressNextInput) {
    suppressNextInput = false;
    return;
  }
  clearTimeout(clipDebounce);
  clipDebounce = setTimeout(() => {
    const ts = Date.now();
    lastRemoteClipTs = ts; // our own update wins until peer sends newer
    sendJSON({ kind: 'clip', text: clipboardEl.value, ts });
    flashSync('Sent');
  }, 150);
});

function flashSync(msg) {
  syncIndicator.textContent = msg;
  clearTimeout(flashSync._t);
  flashSync._t = setTimeout(() => (syncIndicator.textContent = ''), 1500);
}

// ---------- File transfer ----------
const CHUNK_SIZE = 64 * 1024; // 64 KB
const MAX_BUFFERED = 4 * 1024 * 1024; // 4 MB

let nextFileId = 1;
const incoming = new Map(); // fileId -> { meta, chunks: [], received: 0, el }
const outgoing = new Map(); // fileId -> ui element

dropzone.addEventListener('click', () => fileInput.click());
['dragenter', 'dragover'].forEach((e) =>
  dropzone.addEventListener(e, (ev) => {
    ev.preventDefault();
    dropzone.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((e) =>
  dropzone.addEventListener(e, (ev) => {
    ev.preventDefault();
    dropzone.classList.remove('drag');
  })
);
dropzone.addEventListener('drop', (ev) => {
  if (ev.dataTransfer.files) sendFiles(ev.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files) sendFiles(fileInput.files);
  fileInput.value = '';
});

async function sendFiles(files) {
  if (!dc || dc.readyState !== 'open') {
    alert('No peer connected yet.');
    return;
  }
  for (const f of files) await sendOneFile(f);
}

async function sendOneFile(file) {
  const fileId = nextFileId++;
  const item = renderFileItem({
    name: file.name,
    size: file.size,
    direction: 'up',
  });
  outgoing.set(fileId, item);

  await sendJSON({
    kind: 'file-meta',
    fileId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  });

  let offset = 0;
  let seq = 0;
  while (offset < file.size) {
    // backpressure
    while (dc.bufferedAmount > MAX_BUFFERED) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();
    await sendBinaryChunk(fileId, seq++, buf);
    offset += buf.byteLength;
    item.setProgress(offset / file.size);
  }
  await sendJSON({ kind: 'file-end', fileId });
  item.setDone('Sent');
}

function beginIncomingFile(meta) {
  const item = renderFileItem({
    name: meta.name,
    size: meta.size,
    direction: 'down',
  });
  incoming.set(meta.fileId, {
    meta,
    chunks: [],
    received: 0,
    item,
  });
}

function receiveFileChunk(fileId, seq, chunk) {
  const rec = incoming.get(fileId);
  if (!rec) return;
  // Copy because the underlying buffer may be reused
  rec.chunks[seq] = new Uint8Array(chunk);
  rec.received += chunk.byteLength;
  rec.item.setProgress(rec.received / rec.meta.size);
}

function finishIncomingFile(fileId) {
  const rec = incoming.get(fileId);
  if (!rec) return;
  const blob = new Blob(rec.chunks, { type: rec.meta.mime });
  const url = URL.createObjectURL(blob);
  rec.item.setDownload(url, rec.meta.name);
  incoming.delete(fileId);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function renderFileItem({ name, size, direction }) {
  const li = document.createElement('li');
  li.className = 'file-item';
  li.innerHTML = `
    <div>
      <div class="name">${direction === 'up' ? '⬆' : '⬇'} ${escapeHtml(name)}</div>
      <div class="sub">${fmtSize(size)} · <span class="state">${direction === 'up' ? 'Sending…' : 'Receiving…'}</span></div>
      <div class="progress"><div></div></div>
    </div>
    <div class="action"></div>
  `;
  fileListEl.prepend(li);
  const bar = li.querySelector('.progress > div');
  const state = li.querySelector('.state');
  const action = li.querySelector('.action');
  return {
    setProgress(p) {
      bar.style.width = `${Math.min(100, p * 100).toFixed(1)}%`;
    },
    setDone(text) {
      state.textContent = text;
      bar.style.width = '100%';
    },
    setDownload(url, filename) {
      state.textContent = 'Received';
      bar.style.width = '100%';
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.textContent = 'Download';
      a.className = 'btn';
      action.appendChild(a);
    },
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
