// Phone receive-only UI
(() => {
  const $ = (id) => document.getElementById(id);
  const queue = [];
  let ws, backoff = 500;

  // Device name remembered in localStorage
  let name = localStorage.getItem('ld-name');
  if (!name) { name = 'Phone-' + Math.floor(1000 + Math.random() * 9000); localStorage.setItem('ld-name', name); }

  const toast = (msg) => {
    const t = $('toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.display = 'none'), 3000);
  };
  const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); kids.forEach((k) => e.append(k)); return e; };
  const fmtSize = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const describe = (files, hasText) => {
    const p = [];
    if (files.length) p.push(`${files.length} file${files.length > 1 ? 's' : ''}`);
    if (hasText) p.push('a text message');
    return p.join(' and ');
  };
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

  function setConn(on, host) {
    $('dot').className = 'dot' + (on ? ' on' : '');
    $('conn').textContent = on ? `Connected as ${name}` : 'Disconnected — reconnecting…';
    if (host !== undefined) $('hostLine').textContent = host ? `Laptop: ${host}` : '';
  }

  $('renameBtn').onclick = () => {
    const n = prompt('Your device name', name);
    if (!n || !n.trim()) return;
    name = n.trim().slice(0, 40);
    localStorage.setItem('ld-name', name);
    send({ type: 'rename', name });
    setConn(ws && ws.readyState === 1);
  };

  // ---- accept / decline sheet ----
  function showNext() {
    const inc = queue[0];
    if (!inc) return $('overlay').classList.remove('show');
    $('inTitle').textContent = `${inc.from} wants to send you ${describe(inc.files, inc.hasText)}`;
    $('inDetails').textContent = inc.files.map((f) => `${f.name} (${fmtSize(f.size)})`).join(', ');
    $('overlay').classList.add('show');
  }
  function respond(accept) {
    const inc = queue.shift();
    if (inc) send({ type: 'respond', id: inc.id, accept });
    showNext();
  }
  $('acceptBtn').onclick = () => respond(true);
  $('declineBtn').onclick = () => respond(false);

  // ---- render delivered content ----
  function deliver(m) {
    const card = el('div', { className: 'card' }, el('div', { className: 'muted', textContent: `From ${m.from} · ${new Date().toLocaleTimeString()}` }));
    if (m.text && m.text.trim()) {
      const box = el('div', { className: 'textbox', textContent: m.text }); // textContent = XSS safe
      const copy = el('button', { className: 'primary', textContent: 'Copy text' });
      copy.onclick = () => copyText(m.text, box);
      card.append(box, copy);
    }
    if (m.files.length) {
      for (const f of m.files) {
        const dl = el('a', { className: 'btn primary', href: f.url, textContent: `Download ${f.name}` });
        dl.setAttribute('download', f.name);
        if (/\.(jpe?g|png|gif|webp|heic)$/i.test(f.name)) {
          const img = el('img', { className: 'recv-img', alt: f.name, loading: 'lazy', src: f.url + '&inline=1' });
          img.onerror = () => img.replaceWith(el('div', { className: 'muted', textContent: `${f.name} (preview not supported)` }));
          card.append(img, dl);
        } else {
          // Non-image: no preview, just name, size and download
          card.append(el('div', { className: 'muted', textContent: `📄 ${f.name} (${fmtSize(f.size)})` }), dl);
        }
      }
      if (m.files.length > 1) {
        const all = el('button', { textContent: 'Download all', style: 'margin-top:.75rem' });
        all.onclick = async () => {
          for (const f of m.files) {
            const a = el('a', { href: f.url }); a.setAttribute('download', f.name);
            document.body.append(a); a.click(); a.remove();
            await new Promise((r) => setTimeout(r, 700));
          }
        };
        card.append(el('div', {}, all));
      }
      if (m.files.some((f) => /\.(jpe?g|png|gif|webp|heic)$/i.test(f.name))) {
        card.append(el('p', { className: 'muted', textContent: 'Tip: on iPhone you can also long-press an image and choose "Save to Photos".' }));
      }
    }
    $('received').prepend(card);
    $('receivedWrap').style.display = '';
  }

  async function copyText(text, box) {
    try {
      if (!navigator.clipboard) throw new Error();
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      // Clipboard API often unavailable on plain HTTP: select the text instead
      const range = document.createRange(); range.selectNodeContents(box);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
      toast('Text selected — tap Copy');
    }
  }

  // ---- websocket with auto-reconnect backoff ----
  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { backoff = 500; send({ type: 'register', role: 'phone', name }); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'registered') setConn(true, m.host);
      else if (m.type === 'incoming') { queue.push(m); if (queue.length === 1) showNext(); if (navigator.vibrate) navigator.vibrate(200); }
      else if (m.type === 'cancelled') {
        const i = queue.findIndex((q) => q.id === m.id);
        if (i >= 0) { queue.splice(i, 1); if (i === 0) showNext(); toast(m.reason === 'expired' ? 'Request expired' : 'Sender cancelled'); }
      }
      else if (m.type === 'deliver') deliver(m);
    };
    ws.onclose = () => {
      setConn(false);
      queue.length = 0; showNext(); // pending requests are void after disconnect
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
  }
  connect();
})();