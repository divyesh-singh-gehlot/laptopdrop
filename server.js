// LaptopDrop server: Express + WebSocket + mDNS. Run with `npm start`.
'use strict';

// ===================== CONFIG =====================
const CONFIG = {
  START_PORT: 3000,
  MAX_PORT_TRIES: 20,
  MAX_FILE_SIZE: 1024 * 1024 * 1024, // 1 GB per file
  MAX_FILES: 20,
  MAX_TEXT_LENGTH: 100000,
  PENDING_TIMEOUT_MS: 60 * 1000,          // pending transfers expire after 60s
  ACCEPTED_KEEP_MS: 10 * 60 * 1000,       // accepted phone files kept max 10 min (or until session ends)
    BLOCK_DANGEROUS: true, // set to false to allow every file type
  BLOCKED_EXT: ['.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.vbe', '.wsf', '.hta', '.jar', '.lnk', '.reg', '.dll'],
  INLINE_MIME: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'], // only these may be previewed
  OPEN_BROWSER: true,
};
// ==================================================

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { Bonjour } = require('bonjour-service');
const QRCode = require('qrcode');

const TMP_ROOT = path.join(os.tmpdir(), 'laptopdrop-tmp');
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'LaptopDrop');
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

let deviceName = os.hostname().replace(/\.local$/, '');
let PORT = CONFIG.START_PORT;
let LAN_IP = '127.0.0.1';

// ---------- helpers ----------
const newId = () => crypto.randomBytes(16).toString('hex'); // unguessable IDs

function isLocalAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
function isLocal(req) {
  return isLocalAddr(req.socket.remoteAddress);
}
function requireLocal(req, res, next) {
  if (!isLocal(req)) return res.status(403).json({ error: 'Only allowed from the host laptop' });
  next();
}

// Sanitize file names: strip paths and odd characters (prevents traversal)
function sanitizeName(name) {
  let base = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '');
  if (!base) base = 'file';
  return base.slice(0, 180);
}

function isAllowedFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (CONFIG.BLOCK_DANGEROUS && CONFIG.BLOCKED_EXT.includes(ext)) return false;
  return true;
}

function rmSafe(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// Pick best LAN IPv4, skipping internal/virtual interfaces
function detectLanIp() {
  const virtual = /(vmware|virtualbox|vbox|docker|veth|br-|hyper-v|vethernet|wsl|utun|tun|tap|zerotier|tailscale|loopback)/i;
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      let score = virtual.test(name) ? 0 : 10;
      if (/^192\.168\./.test(a.address)) score += 3;
      else if (/^10\./.test(a.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      candidates.push({ address: a.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ? candidates[0].address : '127.0.0.1';
}

function openPath(target) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const p = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch {}
}
function openBrowser(url) {
  if (process.platform === 'win32') {
    try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  } else openPath(url);
}

// Unique destination path: "photo.jpg" -> "photo (1).jpg"
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${i++})${ext}`);
  return candidate;
}

function moveFile(src, dest) {
  try { fs.renameSync(src, dest); }
  catch { fs.copyFileSync(src, dest); rmSafe(src); } // cross-device fallback
}

// ---------- temp folder ----------
rmSafe(TMP_ROOT);
fs.mkdirSync(TMP_ROOT, { recursive: true });

// Multer: streamed to disk, each request in its own temp folder
function makeUpload() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        if (!req._tmpDir) {
          req._tmpDir = path.join(TMP_ROOT, newId());
          fs.mkdirSync(req._tmpDir, { recursive: true });
        }
        cb(null, req._tmpDir);
      },
      filename: (req, file, cb) => cb(null, newId()),
    }),
    limits: { fileSize: CONFIG.MAX_FILE_SIZE, files: CONFIG.MAX_FILES, fieldSize: CONFIG.MAX_TEXT_LENGTH * 4 },
        fileFilter: (req, file, cb) => {
      const name = sanitizeName(file.originalname);
      if (!isAllowedFile(name)) {
        const err = new Error(`File type not allowed for safety: ${name}`);
        err.code = 'BAD_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  }).array('files', CONFIG.MAX_FILES);
}
const upload = makeUpload();

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (err) {
        if (req._tmpDir) rmSafe(req._tmpDir);
        if (err.code === 'LIMIT_FILE_SIZE') err.message = `File too large (max ${Math.round(CONFIG.MAX_FILE_SIZE / 1048576)} MB)`;
        return reject(err);
      }
      resolve();
    });
  });
}

// ---------- state ----------
const phones = new Map();   // id -> { id, name, ws, token }
const laptops = new Map();  // key -> { id, name, host, port }
const hosts = new Set();    // host UI sockets (localhost only)
const transfers = new Map(); // outgoing-to-phone transfers
const incoming = new Map();  // incoming-from-laptop transfers awaiting host decision

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function toHosts(obj) { for (const ws of hosts) send(ws, obj); }

function deviceList() {
  return [
    ...[...phones.values()].map((p) => ({ id: 'phone:' + p.id, name: p.name, type: 'phone' })),
    ...[...laptops.values()].map((l) => ({ id: 'laptop:' + l.id, name: l.name, type: 'laptop', address: `${l.host}:${l.port}` })),
  ];
}
function broadcastDevices() { toHosts({ type: 'devices', devices: deviceList() }); }

function status(clientKey, state, extra = {}) {
  toHosts({ type: 'status', clientKey, state, ...extra });
}

function cleanupTransfer(t) {
  if (!t || t.cleaned) return;
  t.cleaned = true;
  clearTimeout(t.timer);
  if (t.dir) rmSafe(t.dir);
  transfers.delete(t.id);
}

// ---------- express ----------
const app = express();
app.disable('x-powered-by');

// "/" -> host UI for localhost, receive-only UI for others
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', isLocal(req) ? 'index.html' : 'receive.html'));
});
app.get(['/app.js'], requireLocal, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Host info (name, URLs, QR)
app.get('/api/info', requireLocal, async (req, res) => {
  const lanUrl = `http://${LAN_IP}:${PORT}`;
  res.json({ name: deviceName, lanUrl, qr: await QRCode.toDataURL(lanUrl, { margin: 1, width: 240 }), devices: deviceList(), downloadDir: DOWNLOAD_DIR });
});

// Rename this laptop (re-advertise on mDNS)
app.post('/api/rename', requireLocal, express.json(), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name required' });
  deviceName = name;
  republish();
  res.json({ ok: true, name });
});

app.post('/api/open-folder', requireLocal, (req, res) => {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  openPath(DOWNLOAD_DIR);
  res.json({ ok: true });
});

// Cancel an outgoing pending transfer
app.post('/api/cancel', requireLocal, express.json(), (req, res) => {
  const key = req.body?.clientKey;
  for (const t of transfers.values()) {
    if (t.clientKey === key && t.state === 'pending') {
      const phone = phones.get(t.phoneId);
      send(phone?.ws, { type: 'cancelled', id: t.id });
      status(key, 'cancelled');
      cleanupTransfer(t);
    }
  }
  res.json({ ok: true });
});

// SEND (host only). Upload goes to local temp first, then delivered on accept.
app.post('/api/send', requireLocal, async (req, res) => {
  try {
    await runUpload(req, res);
  } catch (err) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
  }
  const files = (req.files || []).map((f) => ({ path: f.path, name: sanitizeName(f.originalname), size: f.size, mime: f.mimetype || 'application/octet-stream' }));
  const text = typeof req.body.text === 'string' ? req.body.text.slice(0, CONFIG.MAX_TEXT_LENGTH) : '';
  const clientKey = String(req.body.clientKey || newId()).slice(0, 64);
  const deviceId = String(req.body.deviceId || '');
  const dir = req._tmpDir;

  if (!files.length && !text.trim()) {
    if (dir) rmSafe(dir);
    return res.status(400).json({ error: 'Nothing to send' });
  }

  if (deviceId.startsWith('phone:')) {
    const phone = phones.get(deviceId.slice(6));
    if (!phone) { if (dir) rmSafe(dir); return res.status(404).json({ error: 'Phone disconnected' }); }
    const t = { id: newId(), clientKey, phoneId: phone.id, files, text, dir, state: 'pending' };
    transfers.set(t.id, t);
    t.timer = setTimeout(() => {
      if (t.state !== 'pending') return;
      send(phone.ws, { type: 'cancelled', id: t.id, reason: 'expired' });
      status(clientKey, 'expired');
      cleanupTransfer(t);
    }, CONFIG.PENDING_TIMEOUT_MS);
    send(phone.ws, {
      type: 'incoming', id: t.id, from: deviceName,
      files: files.map((f) => ({ name: f.name, size: f.size })), hasText: !!text.trim(),
    });
    status(clientKey, 'waiting');
    return res.json({ ok: true });
  }

  if (deviceId.startsWith('laptop:')) {
    const lap = laptops.get(deviceId.slice(7));
    if (!lap) { if (dir) rmSafe(dir); return res.status(404).json({ error: 'Laptop no longer available' }); }
    res.json({ ok: true });
    forwardToLaptop(lap, files, text, clientKey).finally(() => { if (dir) rmSafe(dir); });
    return;
  }

  if (dir) rmSafe(dir);
  res.status(400).json({ error: 'Unknown device' });
});

// Forward payload to another laptop; its server holds the request until accept/decline/expiry
async function forwardToLaptop(lap, files, text, clientKey) {
  status(clientKey, 'sending', { progress: 100, note: 'Delivering to laptop…' });
  try {
    const form = new FormData();
    form.append('from', deviceName);
    form.append('text', text);
    for (const f of files) {
      const blob = await fs.openAsBlob(f.path, { type: f.mime }); // streamed from disk
      form.append('files', blob, f.name);
    }
    status(clientKey, 'waiting');
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), CONFIG.PENDING_TIMEOUT_MS + 5 * 60 * 1000);
    const r = await fetch(`http://${lap.host}:${lap.port}/api/incoming`, { method: 'POST', body: form, signal: ctrl.signal });
    clearTimeout(to);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return status(clientKey, 'failed', { reason: data.error || `Receiver error ${r.status}` });
    if (data.status === 'accepted') status(clientKey, 'sent');
    else if (data.status === 'declined') status(clientKey, 'declined');
    else if (data.status === 'expired') status(clientKey, 'expired');
    else status(clientKey, 'failed', { reason: 'Unexpected response' });
  } catch (err) {
    status(clientKey, 'failed', { reason: `Device unreachable (${err.code || err.cause?.code || err.message}). Check firewall / same network.` });
  }
}

// INCOMING from another laptop (LAN allowed). Nothing saved until the user accepts.
app.post('/api/incoming', async (req, res) => {
  try {
    await runUpload(req, res);
  } catch (err) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
  }
  const files = (req.files || []).map((f) => ({ path: f.path, name: sanitizeName(f.originalname), size: f.size }));
  const text = typeof req.body.text === 'string' ? req.body.text.slice(0, CONFIG.MAX_TEXT_LENGTH) : '';
  const from = String(req.body.from || 'Unknown laptop').slice(0, 60);
  if (!files.length && !text.trim()) { if (req._tmpDir) rmSafe(req._tmpDir); return res.status(400).json({ error: 'Empty' }); }
  if (!hosts.size) { if (req._tmpDir) rmSafe(req._tmpDir); return res.status(503).json({ error: 'Receiver has no LaptopDrop window open' }); }

  const inc = { id: newId(), from, files, text, dir: req._tmpDir, res, done: false };
  incoming.set(inc.id, inc);
  const finish = (st) => {
    if (inc.done) return;
    inc.done = true;
    clearTimeout(inc.timer);
    incoming.delete(inc.id);
    if (inc.dir) rmSafe(inc.dir);
    toHosts({ type: 'incoming-closed', id: inc.id });
    if (!res.headersSent) res.json({ status: st });
  };
  inc.finish = finish;
  inc.timer = setTimeout(() => finish('expired'), CONFIG.PENDING_TIMEOUT_MS);
  req.on('close', () => { if (!res.writableEnded) finish('cancelled'); }); // sender gave up
  toHosts({ type: 'incoming', id: inc.id, from, files: files.map((f) => ({ name: f.name, size: f.size })), hasText: !!text.trim() });
});

// Phone downloads (only intended recipient session, only after accept)
app.get('/api/download/:id/:idx', (req, res) => {
  const t = transfers.get(req.params.id);
  if (!t || t.state !== 'accepted') return res.status(404).send('Not available');
  const phone = phones.get(t.phoneId);
  if (!phone || req.query.token !== phone.token) return res.status(403).send('Forbidden');
  const f = t.files[Number(req.params.idx)];
  if (!f || !fs.existsSync(f.path)) return res.status(404).send('Not found');
  const isImg = CONFIG.INLINE_MIME.includes(String(f.mime).toLowerCase());
  res.setHeader('Content-Type', isImg ? f.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const disp = req.query.inline && isImg ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  const stream = fs.createReadStream(f.path); // streamed
  stream.pipe(res);
  if (!req.query.inline) {
    stream.on('end', () => {
      f.downloaded = true;
      if (t.files.every((x) => x.downloaded)) status(t.clientKey, 'sent', { note: 'All files downloaded' });
    });
  }
});

// JSON error handler
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const local = isLocalAddr(req.socket.remoteAddress);
  let phone = null;
  let isHost = false;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      if (msg.role === 'host' && local) {
        isHost = true;
        hosts.add(ws);
        send(ws, { type: 'devices', devices: deviceList() });
        for (const inc of incoming.values()) send(ws, { type: 'incoming', id: inc.id, from: inc.from, files: inc.files.map((f) => ({ name: f.name, size: f.size })), hasText: !!inc.text.trim() });
        return;
      }
      if (msg.role === 'phone' && !phone) {
        const name = String(msg.name || 'Phone').trim().slice(0, 40) || 'Phone';
        phone = { id: newId(), name, ws, token: newId() };
        phones.set(phone.id, phone);
        send(ws, { type: 'registered', id: phone.id, token: phone.token, host: deviceName });
        broadcastDevices();
      }
      return;
    }

    if (msg.type === 'rename' && phone) {
      phone.name = String(msg.name || '').trim().slice(0, 40) || phone.name;
      broadcastDevices();
      return;
    }

    // Phone accept/decline
    if (msg.type === 'respond' && phone) {
      const t = transfers.get(msg.id);
      if (!t || t.phoneId !== phone.id || t.state !== 'pending') return;
      clearTimeout(t.timer);
      if (!msg.accept) {
        status(t.clientKey, 'declined');
        cleanupTransfer(t);
        return;
      }
      t.state = 'accepted';
      send(ws, {
        type: 'deliver', id: t.id, from: deviceName, text: t.text,
        files: t.files.map((f, i) => ({ name: f.name, size: f.size, url: `/api/download/${t.id}/${i}?token=${phone.token}` })),
      });
      if (!t.files.length) { status(t.clientKey, 'sent'); cleanupTransfer(t); }
      else {
        status(t.clientKey, 'sending', { note: 'Accepted — phone is downloading' });
        t.timer = setTimeout(() => cleanupTransfer(t), CONFIG.ACCEPTED_KEEP_MS);
      }
      return;
    }

    // Host accept/decline for incoming laptop transfer
    if (msg.type === 'respond-incoming' && isHost) {
      const inc = incoming.get(msg.id);
      if (!inc || inc.done) return;
      if (!msg.accept) return inc.finish('declined');
      const saved = [];
      try {
        if (inc.files.length) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        for (const f of inc.files) {
          const dest = uniquePath(DOWNLOAD_DIR, f.name);
          moveFile(f.path, dest);
          saved.push(path.basename(dest));
        }
      } catch (err) {
        toHosts({ type: 'error', message: 'Could not save files: ' + err.message });
        return inc.finish('declined');
      }
      toHosts({ type: 'received', from: inc.from, files: saved, text: inc.text, at: Date.now() });
      inc.finish('accepted');
    }
  });

  ws.on('close', () => {
    hosts.delete(ws);
    if (phone) {
      phones.delete(phone.id);
      // Clean any transfers for this phone (pending -> failed, accepted -> session over)
      for (const t of [...transfers.values()]) {
        if (t.phoneId !== phone.id) continue;
        if (t.state === 'pending') status(t.clientKey, 'failed', { reason: 'Phone disconnected' });
        cleanupTransfer(t);
      }
      broadcastDevices();
    }
  });
});

// Heartbeat to drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

// ---------- mDNS ----------
const bonjour = new Bonjour();
let published = null;
function republish() {
  try {
    if (published) published.stop();
    published = bonjour.publish({ name: `${deviceName}-${INSTANCE_ID.slice(0, 4)}`, type: 'laptopdrop', port: PORT, txt: { id: INSTANCE_ID, name: deviceName } });
    published.on('error', (e) => console.warn('mDNS publish error:', e.message));
  } catch (e) { console.warn('mDNS publish failed:', e.message); }
}
function startBrowse() {
  const browser = bonjour.find({ type: 'laptopdrop' });
  browser.on('up', (svc) => {
    const id = svc.txt?.id;
    if (!id || id === INSTANCE_ID) return; // exclude self
    const ipv4 = (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.referer?.address;
    if (!ipv4) return;
    laptops.set(id, { id, name: svc.txt?.name || svc.name, host: ipv4, port: svc.port });
    broadcastDevices();
  });
  browser.on('down', (svc) => {
    const id = svc.txt?.id;
    if (id && laptops.delete(id)) broadcastDevices();
  });
  // Periodic re-query so renamed/returned laptops show up
  setInterval(() => { try { browser.update(); } catch {} }, 10000);
  // Ping laptops: drop unreachable ones
  setInterval(async () => {
    for (const l of [...laptops.values()]) {
      try {
        const r = await fetch(`http://${l.host}:${l.port}/ping`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error();
        const d = await r.json();
        if (d.name && d.name !== l.name) { l.name = d.name; broadcastDevices(); }
      } catch { laptops.delete(l.id); broadcastDevices(); }
    }
  }, 15000);
}
app.get('/ping', (req, res) => res.json({ ok: true, name: deviceName, id: INSTANCE_ID }));

// ---------- start (port fallback) ----------
function listen(port, tries = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < CONFIG.MAX_PORT_TRIES) {
      console.log(`Port ${port} is busy, trying ${port + 1}…`);
      return listen(port + 1, tries + 1);
    }
    console.error('Could not start server:', err.message);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', async () => {
    PORT = port;
    LAN_IP = detectLanIp();
    const local = `http://localhost:${PORT}`;
    const lan = `http://${LAN_IP}:${PORT}`;
    console.log('\n  LaptopDrop is running\n');
    console.log(`  Open on this laptop: ${local}`);
    console.log(`  Open on your phone:  ${lan}\n`);
    try { console.log(await QRCode.toString(lan, { type: 'terminal', small: true })); } catch {}
    if (LAN_IP === '127.0.0.1') console.log('  ⚠ No LAN network detected. Connect to Wi-Fi first.\n');
    republish();
    startBrowse();
    if (CONFIG.OPEN_BROWSER) openBrowser(local);
  });
}
listen(CONFIG.START_PORT);

// ---------- cleanup on exit ----------
let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  console.log('\nShutting down…');
  rmSafe(TMP_ROOT);
  try { bonjour.unpublishAll(() => bonjour.destroy()); } catch {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => rmSafe(TMP_ROOT));
