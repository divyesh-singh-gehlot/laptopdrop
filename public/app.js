// Host UI (localhost only): send + receive
(() => {
  const $ = (id) => document.getElementById(id);
  // Keep in sync with BLOCKED_EXT in server.js
  const BLOCKED = ['.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.vbe', '.wsf', '.hta', '.jar', '.lnk', '.reg', '.dll'];
  let devices = [];
  let selected = null;
  let files = [];
  const incomingQueue = [];
  const transferEls = new Map();

  const toast = (msg) => {
    const t = $('toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.display = 'none'), 3000);
  };
  const fmtSize = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const k of kids) e.append(k);
    return e;
  };
  const describe = (files, hasText) => {
    const parts = [];
    if (files.length) parts.push(`${files.length} file${files.length > 1 ? 's' : ''}`);
    if (hasText) parts.push('a text message');
    return parts.join(' and ');
  };

  // ---- info ----
  async function loadInfo() {
    const r = await fetch('/api/info');
    const d = await r.json();
    $('myName').textContent = d.name;
    $('lanUrl').textContent = d.lanUrl;
    $('qr').src = d.qr;
    renderDevices(d.devices);
  }

  $('renameBtn').onclick = async () => {
    const name = prompt('Device name', $('myName').textContent);
    if (!name || !name.trim()) return;
    const r = await fetch('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (r.ok) $('myName').textContent = (await r.json()).name;
  };
  $('openFolder').onclick = () => fetch('/api/open-folder', { method: 'POST' });

  // ---- devices ----
  function renderDevices(list) {
    devices = list;
    const box = $('devices');
    box.replaceChildren();
    if (selected && !devices.find((d) => d.id === selected)) selected = null;
    for (const d of devices) {
      const card = el('div', { className: 'device' + (d.id === selected ? ' selected' : '') },
        el('div', { className: 'icon', textContent: d.type === 'phone' ? '📱' : '💻' }),
        el('div', { className: 'name', textContent: d.name }),
        el('div', { className: 'muted', textContent: d.type === 'phone' ? 'Phone' : 'Laptop' }));
      card.onclick = () => { selected = d.id; renderDevices(devices); };
      box.append(card);
    }
    $('noDevices').style.display = devices.length ? 'none' : '';
    updateSendState();
  }

  function updateSendState() {
    const dev = devices.find((d) => d.id === selected);
    $('target').textContent = dev ? `To: ${dev.name}` : 'Select a device above';
    $('sendBtn').disabled = !dev || (!files.length && !$('text').value.trim());
  }
  $('text').addEventListener('input', updateSendState);

  // ---- files ----
  const drop = $('drop');
  drop.onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });

  function addFiles(list) {
    for (const f of list) {
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (BLOCKED.includes(ext)) { toast(`Skipped ${f.name}: this file type is blocked for safety`); continue; }
      files.push(f);
    }
    renderThumbs();
  }
  function renderThumbs() {
    const box = $('thumbs');
    box.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
    box.replaceChildren();
    files.forEach((f, i) => {
      const t = el('div', { className: 'thumb', title: `${f.name} (${fmtSize(f.size)})` });
      if (/\.(jpe?g|png|gif|webp)$/i.test(f.name)) t.append(el('img', { src: URL.createObjectURL(f), alt: f.name }));
      else t.append(el('span', { textContent: '📄 ' + f.name })); // non-images: icon + name
      const x = el('button', { textContent: '✕', title: 'Remove' });
      x.onclick = () => { files.splice(i, 1); renderThumbs(); };
      t.append(x);
      box.append(t);
    });
    updateSendState();
  }

  // ---- send ----
  const LABELS = { uploading: 'Sending', sending: 'Sending', waiting: 'Waiting for response', sent: 'Sent', declined: 'Declined', expired: 'Expired', failed: 'Failed', cancelled: 'Cancelled' };

  function addTransferRow(key, dev, summary) {
    const st = el('span', { textContent: 'Sending' });
    const bar = el('div', { className: 'bar' }, el('div'));
    const cancel = el('button', { textContent: 'Cancel', style: 'margin-top:.4rem;display:none' });
    cancel.onclick = () => fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: key }) });
    const li = el('li', {},
      el('div', {}, el('strong', { textContent: dev.name }), ' — ', el('span', { className: 'muted', textContent: summary })),
      el('div', {}, st), bar, cancel);
    $('transfers').prepend(li);
    $('noTransfers').style.display = 'none';
    transferEls.set(key, { st, bar, cancel });
  }

  function setTransfer(key, state, { progress, reason, note } = {}) {
    const t = transferEls.get(key);
    if (!t) return;
    t.st.className = 'st-' + state;
    t.st.textContent = (LABELS[state] || state) + (reason ? `: ${reason}` : '') + (note ? ` (${note})` : '');
    const showBar = state === 'uploading' || state === 'sending';
    t.bar.style.display = showBar ? '' : 'none';
    if (progress != null) t.bar.firstChild.style.width = progress + '%';
    t.cancel.style.display = state === 'waiting' ? '' : 'none';
  }

  $('sendBtn').onclick = () => {
    const dev = devices.find((d) => d.id === selected);
    if (!dev) return;
    const text = $('text').value;
    const key = crypto.getRandomValues(new Uint32Array(4)).join('-');
    const fd = new FormData();
    fd.append('deviceId', dev.id);
    fd.append('clientKey', key);
    fd.append('text', text);
    files.forEach((f) => fd.append('files', f, f.name));
    addTransferRow(key, dev, describe(files, !!text.trim()));
    setTransfer(key, 'uploading', { progress: 0 });

    // XHR for upload progress
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/send');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setTransfer(key, 'uploading', { progress: Math.round((e.loaded / e.total) * 100) }); };
    xhr.onload = () => {
      if (xhr.status >= 400) {
        let msg = 'Error ' + xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        setTransfer(key, 'failed', { reason: msg });
      }
    };
    xhr.onerror = () => setTransfer(key, 'failed', { reason: 'Local server unreachable' });
    xhr.send(fd);

    files = []; $('text').value = ''; renderThumbs();
  };

  // ---- incoming (from other laptops) ----
  function showNextIncoming() {
    const inc = incomingQueue[0];
    if (!inc) return $('overlay').classList.remove('show');
    $('inTitle').textContent = `${inc.from} wants to send you ${describe(inc.files, inc.hasText)}`;
    $('inDetails').textContent = inc.files.map((f) => `${f.name} (${fmtSize(f.size)})`).join(', ');
    $('overlay').classList.add('show');
  }
  function respond(accept) {
    const inc = incomingQueue.shift();
    if (inc) send({ type: 'respond-incoming', id: inc.id, accept });
    showNextIncoming();
  }
  $('acceptBtn').onclick = () => respond(true);
  $('declineBtn').onclick = () => respond(false);

  function addReceived(r) {
    const li = el('li', {}, el('div', {}, el('strong', { textContent: r.from }), el('span', { className: 'muted', textContent: ' · ' + new Date(r.at).toLocaleTimeString() })));
    if (r.files.length) li.append(el('div', { className: 'muted', textContent: `Saved: ${r.files.join(', ')}` }));
    if (r.text && r.text.trim()) {
      const box = el('div', { className: 'textbox', textContent: r.text }); // textContent = XSS safe
      const copy = el('button', { textContent: 'Copy' });
      copy.onclick = () => copyText(r.text, box);
      li.append(box, copy);
    }
    $('received').prepend(li);
    $('noReceived').style.display = 'none';
  }

  async function copyText(text, box) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch {
      const range = document.createRange(); range.selectNodeContents(box);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
      toast('Selected — press Ctrl/Cmd+C');
    }
  }

  // ---- websocket with backoff ----
  let ws, backoff = 500;
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { backoff = 500; send({ type: 'register', role: 'host' }); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'devices') renderDevices(m.devices);
      else if (m.type === 'status') setTransfer(m.clientKey, m.state, m);
      else if (m.type === 'incoming') { if (!incomingQueue.find((i) => i.id === m.id)) incomingQueue.push(m); if (incomingQueue.length === 1) showNextIncoming(); }
      else if (m.type === 'incoming-closed') {
        const i = incomingQueue.findIndex((x) => x.id === m.id);
        if (i >= 0) { incomingQueue.splice(i, 1); if (i === 0) showNextIncoming(); }
      }
      else if (m.type === 'received') addReceived(m);
      else if (m.type === 'error') toast(m.message);
    };
    ws.onclose = () => { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 10000); };
  }

  loadInfo().catch(() => toast('Could not load info'));
  connect();
})();