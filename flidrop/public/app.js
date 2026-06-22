// app.js — Beam client
//
// Flow:
//   Sender:   create room -> show code/QR -> wait for peer -> make WebRTC offer
//             -> open data channel -> send files in chunks
//   Receiver: enter code -> join room -> receive WebRTC offer -> answer
//             -> data channel opens -> receive chunks -> reassemble -> download
//
// The signaling server only ever sees small JSON handshake messages
// (SDP + ICE candidates). All file bytes flow peer-to-peer over the
// WebRTC data channel once connected.

(() => {
  'use strict';

  // ---------- config ----------
  const CHUNK_SIZE = 64 * 1024;       // 64KB per wire chunk — safe across modern browsers
  const READ_BLOCK_SIZE = 1024 * 1024; // read the file in 1MB blocks, then send 64KB pieces
                                        // from each block — far fewer slow async reads overall
  const BUFFER_HIGH_WATER = 4 * 1024 * 1024; // pause sending above 4MB queued
  const BUFFER_LOW_WATER = 1 * 1024 * 1024;  // resume once drained below this
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // ---------- dom ----------
  const $ = (id) => document.getElementById(id);
  const screens = {
    select: $('screen-select'),
    send: $('screen-send'),
    receiveEntry: $('screen-receive-entry'),
    receiveActive: $('screen-receive-active'),
  };

  function showScreen(name) {
    Object.values(screens).forEach((el) => { el.hidden = true; });
    screens[name].hidden = false;
  }

  function toast(msg, ms = 3200) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // ---------- websocket signaling ----------
  let ws = null;
  let wsReady = false;
  let role = null; // 'host' | 'guest'
  let roomCode = null;
  const pendingSignalQueue = [];

  function connectSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      wsReady = true;
      setServerStatus(true);
      // flush anything queued while disconnected
      while (pendingSignalQueue.length) ws.send(pendingSignalQueue.shift());
    });

    ws.addEventListener('close', () => {
      wsReady = false;
      setServerStatus(false);
    });

    ws.addEventListener('error', () => setServerStatus(false));

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServerMessage(msg);
    });
  }

  function wsSend(obj) {
    const payload = JSON.stringify(obj);
    if (wsReady && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      pendingSignalQueue.push(payload);
    }
  }

  function setServerStatus(ok) {
    const dot = $('serverStatus');
    dot.className = `server-status ${ok ? 'ok' : 'bad'}`;
    $('serverStatusText').textContent = ok ? 'ready' : 'reconnecting';
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'created':
        roomCode = msg.room;
        role = 'host';
        $('roomCodeDisplay').textContent = roomCode;
        renderQR(roomCode);
        $('sendStatusLine').textContent = 'waiting for the other device…';
        break;

      case 'joined':
        roomCode = msg.room;
        role = 'guest';
        $('recvStatusLine').textContent = 'connected to room — waiting for sender…';
        break;

      case 'peer-joined':
        // We're the host; a guest connected. Start the WebRTC offer.
        $('sendStatusLine').textContent = 'peer found — connecting…';
        setLinkLive('send', true);
        startAsOfferer();
        break;

      case 'peer-left':
        toast('The other device disconnected.');
        teardownConnection();
        setLinkLive('send', false);
        setLinkLive('recv', false);
        break;

      case 'signal':
        handleSignal(msg.data);
        break;

      case 'error':
        toast(msg.message || 'Something went wrong.');
        if (role === 'guest') {
          $('receiveEntryStatus').textContent = msg.message;
          $('receiveEntryStatus').className = 'status-line err';
        }
        break;
    }
  }

  // ---------- QR code ----------
  function renderQR(code) {
    const holder = $('qrcode');
    holder.innerHTML = '';
    const url = `${location.origin}${location.pathname}?room=${code}`;

    // eslint-disable-next-line no-undef
    const qr = qrcode(0, 'M'); // type 0 = auto-size, M = medium error correction
    qr.addData(url);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });

    const svg = holder.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', '148');
      svg.setAttribute('height', '148');
    }
  }

  // ---------- link rig animation ----------
  function setLinkLive(side, live) {
    if (side === 'send') {
      $('sendLinkLine').classList.toggle('live', live);
      $('sendPulse').hidden = !live;
      $('sendNodeRemote').classList.toggle('lit', live);
      $('sendNodeLocal').classList.toggle('lit', live);
    } else {
      document.querySelector('#screen-receive-active .link-line')?.classList.toggle('live', live);
      $('recvPulse').hidden = !live;
      $('recvNodeRemote').classList.toggle('lit', live);
      $('recvNodeLocal').classList.toggle('lit', live);
    }
  }

  // ---------- WebRTC ----------
  let pc = null;
  let dataChannel = null;
  let remoteDescSet = false;
  const iceQueue = [];

  function createPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        wsSend({ type: 'signal', data: { candidate: ev.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        toast('Connection lost. Try again — if you\'re on different networks, the same Wi-Fi tends to be more reliable.');
      }
    };

    pc.ondatachannel = (ev) => {
      bindDataChannel(ev.channel);
    };

    return pc;
  }

  async function startAsOfferer() {
    createPeerConnection();
    dataChannel = pc.createDataChannel('beam', { ordered: true });
    bindDataChannel(dataChannel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'signal', data: { sdp: pc.localDescription } });
  }

  async function handleSignal(data) {
    if (!pc) createPeerConnection();

    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      remoteDescSet = true;
      flushIceQueue();

      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ type: 'signal', data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (remoteDescSet) {
        try { await pc.addIceCandidate(data.candidate); } catch { /* ignore */ }
      } else {
        iceQueue.push(data.candidate);
      }
    }
  }

  function flushIceQueue() {
    while (iceQueue.length) {
      const c = iceQueue.shift();
      pc.addIceCandidate(c).catch(() => {});
    }
  }

  function teardownConnection() {
    if (dataChannel) { try { dataChannel.close(); } catch {} }
    if (pc) { try { pc.close(); } catch {} }
    dataChannel = null;
    pc = null;
    remoteDescSet = false;
    iceQueue.length = 0;
  }

  // ---------- data channel: shared open handler ----------
  function bindDataChannel(channel) {
    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;

    dataChannel.onopen = () => {
      if (role === 'host') {
        $('sendWaitingPanel').hidden = true;
        $('sendActivePanel').hidden = false;
        $('sendStatusLine').textContent = '';
      } else {
        showScreen('receiveActive');
        setLinkLive('recv', true);
        $('recvStatusLine').textContent = '';
      }
    };

    dataChannel.onclose = () => {
      if (role === 'host') setLinkLive('send', false);
      else setLinkLive('recv', false);
    };

    if (role === 'guest' || (!role)) {
      bindReceiverMessageHandler(dataChannel);
    }
  }

  // ============================================================
  //  SENDER SIDE — file queue + chunked transmission
  // ============================================================
  const sendQueue = [];
  let sending = false;
  const cancelledIds = new Set();

  function enqueueFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    files.forEach((file) => {
      const id = uid();
      sendQueue.push({ id, file });
      renderSendItem(id, file);
    });
    if (dataChannel && dataChannel.readyState === 'open') processSendQueue();
  }

  function renderSendItem(id, file) {
    const list = $('sendTransferList');
    const item = document.createElement('div');
    item.className = 'transfer-item';
    item.id = `send-${id}`;
    item.innerHTML = `
      <div class="t-row">
        <span class="t-name">${escapeHtml(file.name)}</span>
        <span class="t-meta">${formatBytes(file.size)}</span>
      </div>
      <div class="t-bar-track"><div class="t-bar-fill" id="bar-${id}"></div></div>
      <div class="t-status-row">
        <div class="t-status" id="status-${id}">queued</div>
        <button class="t-cancel" id="cancel-${id}" type="button">cancel</button>
      </div>
    `;
    list.appendChild(item);
    $(`cancel-${id}`).addEventListener('click', () => cancelSend(id));
  }

  function cancelSend(id) {
    cancelledIds.add(id);

    // If it's still sitting in the queue (hasn't started yet), just pull
    // it out entirely — nothing was ever sent, no need to tell the peer.
    const queueIdx = sendQueue.findIndex((j) => j.id === id);
    if (queueIdx !== -1) {
      sendQueue.splice(queueIdx, 1);
      markCancelled(id, 'cancelled');
      return;
    }
    // Otherwise it's actively sending — the send loop below checks
    // cancelledIds on every chunk and will stop itself shortly, then
    // notify the receiver so it discards the partial file too.
    const statusEl = $(`status-${id}`);
    if (statusEl) statusEl.textContent = 'cancelling…';
  }

  function markCancelled(id, label) {
    const statusEl = $(`status-${id}`);
    const barEl = $(`bar-${id}`);
    const cancelBtn = $(`cancel-${id}`);
    if (statusEl) statusEl.textContent = label;
    if (barEl) barEl.classList.add('cancelled');
    if (cancelBtn) cancelBtn.remove();
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function processSendQueue() {
    if (sending) return;
    sending = true;

    while (sendQueue.length) {
      const job = sendQueue.shift();
      await sendOneFile(job.id, job.file);
    }

    sending = false;
  }

  function waitForBufferDrain() {
    return new Promise((resolve) => {
      const check = () => {
        if (dataChannel.bufferedAmount <= BUFFER_LOW_WATER) {
          resolve();
        } else {
          dataChannel.addEventListener('bufferedamountlow', resolve, { once: true });
        }
      };
      check();
    });
  }

  async function sendOneFile(id, file) {
    const statusEl = $(`status-${id}`);
    const barEl = $(`bar-${id}`);
    statusEl.textContent = 'sending…';

    dataChannel.send(JSON.stringify({
      type: 'file-start', id, name: file.name, size: file.size, mime: file.type,
    }));

    let offset = 0;
    let lastUiUpdate = 0;
    try {
      while (offset < file.size) {
        if (cancelledIds.has(id)) {
          dataChannel.send(JSON.stringify({ type: 'file-cancel', id }));
          markCancelled(id, 'cancelled ✕');
          return;
        }

        // Read one larger block from disk/memory — this is the slow part,
        // so we do it far less often than once per tiny wire-chunk.
        const blockEnd = Math.min(offset + READ_BLOCK_SIZE, file.size);
        const block = await file.slice(offset, blockEnd).arrayBuffer();

        // Send that block out as fast, synchronous 64KB pieces.
        let blockOffset = 0;
        while (blockOffset < block.byteLength) {
          if (cancelledIds.has(id)) {
            dataChannel.send(JSON.stringify({ type: 'file-cancel', id }));
            markCancelled(id, 'cancelled ✕');
            return;
          }
          if (dataChannel.bufferedAmount > BUFFER_HIGH_WATER) {
            await waitForBufferDrain();
          }
          if (dataChannel.readyState !== 'open') throw new Error('Connection closed mid-transfer');

          const pieceEnd = Math.min(blockOffset + CHUNK_SIZE, block.byteLength);
          // A view into the same buffer — no copy.
          const piece = block.slice(blockOffset, pieceEnd);
          dataChannel.send(piece);
          blockOffset = pieceEnd;
        }

        offset = blockEnd;

        // Throttle UI updates to ~10/sec instead of on every wire-chunk —
        // updating the DOM thousands of times is itself a source of lag.
        const now = performance.now();
        if (now - lastUiUpdate > 100 || offset === file.size) {
          const pct = Math.min(100, Math.round((offset / file.size) * 100));
          barEl.style.width = `${pct}%`;
          statusEl.textContent = `${pct}% — ${formatBytes(offset)} / ${formatBytes(file.size)}`;
          lastUiUpdate = now;
        }
      }

      dataChannel.send(JSON.stringify({ type: 'file-end', id }));
      barEl.classList.add('done');
      barEl.style.width = '100%';
      statusEl.textContent = 'sent ✓';
      $(`cancel-${id}`)?.remove();
    } catch (err) {
      statusEl.textContent = `failed — ${err.message}`;
      statusEl.classList.add('err');
      $(`cancel-${id}`)?.remove();
    }
  }

  // ============================================================
  //  RECEIVER SIDE — reassembly + download
  // ============================================================
  const incoming = new Map(); // id -> { name, size, mime, chunks: [], received: 0 }

  function bindReceiverMessageHandler(channel) {
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'file-start') onFileStart(msg);
        if (msg.type === 'file-end') onFileEnd(msg);
        if (msg.type === 'file-cancel') onFileCancel(msg);
      } else {
        onChunk(ev.data);
      }
    };
  }

  let activeIncomingId = null;
  let lastRecvUiUpdate = 0;

  function onFileStart(msg) {
    activeIncomingId = msg.id;
    lastRecvUiUpdate = 0;
    incoming.set(msg.id, {
      name: msg.name, size: msg.size, mime: msg.mime || 'application/octet-stream',
      chunks: [], received: 0,
    });
    renderRecvItem(msg.id, msg.name, msg.size);
  }

  function onFileCancel(msg) {
    incoming.delete(msg.id);
    const barEl = $(`rbar-${msg.id}`);
    const statusEl = $(`rstatus-${msg.id}`);
    if (barEl) barEl.classList.add('cancelled');
    if (statusEl) statusEl.textContent = 'cancelled by sender';
    if (activeIncomingId === msg.id) activeIncomingId = null;
  }

  function onChunk(buf) {
    if (!activeIncomingId) return;
    const entry = incoming.get(activeIncomingId);
    if (!entry) return;
    entry.chunks.push(buf);
    entry.received += buf.byteLength;

    const now = performance.now();
    if (now - lastRecvUiUpdate < 100 && entry.received < entry.size) return;
    lastRecvUiUpdate = now;

    const pct = Math.min(100, Math.round((entry.received / entry.size) * 100));
    const barEl = $(`rbar-${activeIncomingId}`);
    const statusEl = $(`rstatus-${activeIncomingId}`);
    if (barEl) barEl.style.width = `${pct}%`;
    if (statusEl) statusEl.textContent = `${pct}% — ${formatBytes(entry.received)} / ${formatBytes(entry.size)}`;
  }

  function onFileEnd(msg) {
    const entry = incoming.get(msg.id);
    if (!entry) return;
    const blob = new Blob(entry.chunks, { type: entry.mime });
    const url = URL.createObjectURL(blob);

    const barEl = $(`rbar-${msg.id}`);
    const statusEl = $(`rstatus-${msg.id}`);
    barEl.classList.add('done');
    barEl.style.width = '100%';
    statusEl.textContent = 'received ✓';

    const item = $(`recv-${msg.id}`);
    const link = document.createElement('a');
    link.href = url;
    link.download = entry.name;
    link.className = 't-download';
    link.textContent = 'Save file';
    item.appendChild(link);

    // Try to trigger an automatic download too.
    const auto = document.createElement('a');
    auto.href = url;
    auto.download = entry.name;
    document.body.appendChild(auto);
    auto.click();
    document.body.removeChild(auto);

    incoming.delete(msg.id);
    activeIncomingId = null;
  }

  function renderRecvItem(id, name, size) {
    const list = $('recvTransferList');
    const item = document.createElement('div');
    item.className = 'transfer-item';
    item.id = `recv-${id}`;
    item.innerHTML = `
      <div class="t-row">
        <span class="t-name">${escapeHtml(name)}</span>
        <span class="t-meta">${formatBytes(size)}</span>
      </div>
      <div class="t-bar-track"><div class="t-bar-fill" id="rbar-${id}"></div></div>
      <div class="t-status" id="rstatus-${id}">receiving…</div>
    `;
    list.appendChild(item);
  }

  // ============================================================
  //  UI wiring
  // ============================================================
  $('btnSend').addEventListener('click', () => {
    showScreen('send');
    $('sendWaitingPanel').hidden = false;
    $('sendActivePanel').hidden = true;
    $('roomCodeDisplay').textContent = '·····';
    wsSend({ type: 'create' });
  });

  $('btnReceive').addEventListener('click', () => {
    showScreen('receiveEntry');
    $('codeInput').value = '';
    $('codeInput').focus();
  });

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      teardownConnection();
      setLinkLive('send', false);
      setLinkLive('recv', false);
      showScreen('select');
    });
  });

  $('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length < 4) {
      $('receiveEntryStatus').textContent = 'Enter the full code shown on the other device.';
      $('receiveEntryStatus').className = 'status-line err';
      return;
    }
    $('receiveEntryStatus').textContent = '';
    wsSend({ type: 'join', room: code });
  });

  $('dropzone').addEventListener('click', () => $('fileInput').click());
  $('browseLink').addEventListener('click', (e) => { e.stopPropagation(); $('fileInput').click(); });
  $('dropzone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
  });

  $('fileInput').addEventListener('change', (e) => {
    enqueueFiles(e.target.files);
    e.target.value = '';
  });

  ['dragover', 'dragenter'].forEach((evt) => {
    $('dropzone').addEventListener(evt, (e) => {
      e.preventDefault();
      $('dropzone').classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    $('dropzone').addEventListener(evt, () => $('dropzone').classList.remove('dragover'));
  });
  $('dropzone').addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) enqueueFiles(e.dataTransfer.files);
  });

  // Auto-fill room code from a scanned QR link (?room=XXXXX)
  function prefillFromURL() {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      showScreen('receiveEntry');
      $('codeInput').value = room.toUpperCase();
    }
  }

  // ---------- boot ----------
  connectSocket();
  prefillFromURL();
})();
