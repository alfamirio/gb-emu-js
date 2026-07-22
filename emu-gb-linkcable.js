/* =========================================================================================
   emu-gb-linkcable.js — Network link cable (PeerJS)
   -----------------------------------------------------------------------------------------
   Lets two people on different machines plug into each other's serial port over the
   internet/local network via WebRTC (PeerJS), so link-cable features (trading, linked
   battles, two-player link minigames, etc.) work without both players being on the same
   physical console.

   How it plugs into the core: emu-gb-core.js's MMU calls two methods on whatever object
   is set as `emulator.serialLink` (null-safe if nothing is attached):
     - masterTransfer(byte, resolve): local ROM started a transfer with the internal clock.
       Send `byte` to the partner and call resolve(replyByte) once we have (or time out) a
       reply.
     - armSlave(localByte, resolve): local ROM started a transfer with the external clock
       (i.e. waiting on the *other* Game Boy to drive it). Stash `localByte` and call
       resolve(receivedByte) once a partner-initiated transfer arrives.

   Because a WebRTC round-trip can't reproduce the real ~8KHz bit-clocked shift register,
   each transfer is treated as one atomic byte exchange rather than simulating individual
   clock pulses. That's a real limitation (some link-cable protocols expect near-instant
   back-to-back bytes and may be too latency-sensitive to work well over a slow connection),
   but it's enough for most turn-based link interactions.

   Load order: after emu-gb-core.js/emu-gbc-core.js (needs nothing from them directly, but
   conceptually configures what they call into) and the PeerJS CDN script; before
   emu-gb-app.js, since app.js's createEmulator() wires `linkCable` in as `serialLink`.
   ========================================================================================= */

class LinkCableTransport {
  static MASTER_TIMEOUT_MS = 1500; // how long a master transfer waits for a reply before giving up (line floats high, like a real disconnected cable)

  constructor() {
    this.peer = null;
    this.conn = null;
    this.myId = null;
    this.status = 'disconnected'; // 'disconnected' | 'hosting' | 'connecting' | 'connected'
    this.onStatusChange = null;   // (status, detail) => void; wired up by the UI below

    this._pendingMaster = null;   // { resolve, timer } - our own in-flight masterTransfer()
    this._armedSlave = null;      // { localByte, resolve } - waiting on a partner-initiated transfer
  }

  _setStatus(status, detail) {
    this.status = status;
    this.onStatusChange?.(status, detail);
  }

  _ensurePeer() {
    if (this.peer) return;
    this.peer = new Peer(); // random ID assigned by the public PeerJS broker
    this.peer.on('open', (id) => { this.myId = id; this.onStatusChange?.(this.status, { myId: id }); });
    this.peer.on('connection', (conn) => this._attachConnection(conn));
    this.peer.on('error', (err) => {
      console.warn('LinkCable peer error:', err);
      this._setStatus('disconnected', { error: err.message || String(err) });
    });
    this.peer.on('disconnected', () => this._setStatus('disconnected', { error: 'lost connection to the PeerJS broker' }));
  }

  // Generates our own ID and waits for someone to connect to it.
  host() {
    this.disconnect();
    this._ensurePeer();
    this._setStatus('hosting');
  }

  // Connects out to someone else's ID (from their host() screen).
  connectTo(remoteId) {
    this.disconnect();
    this._ensurePeer();
    this._setStatus('connecting', { remoteId });
    // peer.connect() before our own peer has finished its handshake with the signaling
    // server can silently go nowhere (no 'open', no 'error' - it just hangs), so wait for
    // our own 'open' first if it hasn't fired yet.
    if (this.peer.open) {
      this._attachConnection(this.peer.connect(remoteId, { reliable: true }));
    } else {
      this.peer.once('open', () => {
        if (this.status !== 'connecting') return; // disconnect()/host() was called while we waited
        this._attachConnection(this.peer.connect(remoteId, { reliable: true }));
      });
    }
  }

  _attachConnection(conn) {
    this.conn = conn;
    conn.on('open', () => this._setStatus('connected', { remoteId: conn.peer }));
    conn.on('data', (msg) => this._onData(msg));
    conn.on('close', () => { this._resolvePending(0xFF); this.conn = null; this._setStatus('disconnected'); });
    conn.on('error', (err) => console.warn('LinkCable connection error:', err));
  }

  disconnect() {
    this._resolvePending(0xFF);
    this.conn?.close();
    this.peer?.destroy();
    this.peer = null;
    this.conn = null;
    this.myId = null;
    this._setStatus('disconnected');
  }

  _resolvePending(fallbackByte) {
    if (this._pendingMaster) {
      clearTimeout(this._pendingMaster.timer);
      const { resolve } = this._pendingMaster;
      this._pendingMaster = null;
      resolve(fallbackByte);
    }
    this._armedSlave = null;
  }

  /* ---- the two methods MMU._writeSerialControl() calls ---- */

  masterTransfer(byte, resolve) {
    if (!this.conn || !this.conn.open) { resolve(0xFF); return; } // no partner attached - line floats high
    if (this._pendingMaster) { clearTimeout(this._pendingMaster.timer); this._pendingMaster.resolve(0xFF); } // shouldn't normally overlap; don't leak the old one
    const timer = setTimeout(() => {
      if (!this._pendingMaster) return;
      const { resolve: r } = this._pendingMaster;
      this._pendingMaster = null;
      r(0xFF);
    }, LinkCableTransport.MASTER_TIMEOUT_MS);
    this._pendingMaster = { resolve, timer };
    this.conn.send({ type: 'xfer', byte });
  }

  armSlave(localByte, resolve) {
    this._armedSlave = { localByte, resolve };
  }

  _onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'xfer') {
      // Partner started a transfer. Reply with whatever we have armed, or 0xFF if our own
      // ROM hasn't reached its transfer point yet (matches real disconnected-side behavior).
      const armed = this._armedSlave;
      this._armedSlave = null;
      this.conn.send({ type: 'xferReply', byte: armed ? armed.localByte : 0xFF });
      armed?.resolve(msg.byte);
    } else if (msg.type === 'xferReply' && this._pendingMaster) {
      clearTimeout(this._pendingMaster.timer);
      const { resolve } = this._pendingMaster;
      this._pendingMaster = null;
      resolve(msg.byte);
    }
  }
}

const linkCable = new LinkCableTransport();

/* ---- UI wiring: small panel next to "Load ROM" (markup lives in index.html) ---- */
(function wireLinkCableUI() {
  const statusBadge = document.getElementById('linkCableStatus');
  const myIdRow = document.getElementById('linkCableMyIdRow');
  const myIdText = document.getElementById('linkCableMyId');
  const remoteIdInput = document.getElementById('linkCableRemoteId');
  const btnHost = document.getElementById('btnLinkCableHost');
  const btnConnect = document.getElementById('btnLinkCableConnect');
  const btnDisconnect = document.getElementById('btnLinkCableDisconnect');
  const btnCopyId = document.getElementById('btnLinkCableCopyId');
  if (!statusBadge) return; // markup not present - skip UI wiring, transport still works headless

  const STATUS_LABEL = {
    disconnected: 'Not connected',
    hosting: 'Waiting for partner…',
    connecting: 'Connecting…',
    connected: 'Connected',
  };

  // A joining peer still needs its own Peer object under the hood (that's just how
  // PeerJS/WebRTC signaling works), but its auto-generated id is irrelevant to the user -
  // only the host's code is ever meant to be shared. Track which button was pressed so we
  // only ever surface "Your code" for the host.
  let role = null; // 'host' | 'join' | null

  function render(status, detail) {
    statusBadge.textContent = STATUS_LABEL[status] || status;
    statusBadge.classList.remove('linkcable-green', 'linkcable-amber', 'linkcable-red');
    statusBadge.classList.add(
      status === 'connected' ? 'linkcable-green' : status === 'disconnected' ? 'linkcable-red' : 'linkcable-amber'
    );

    btnHost.disabled = status === 'hosting' || status === 'connected';
    btnConnect.disabled = status === 'connecting' || status === 'connected';
    remoteIdInput.disabled = status === 'connecting' || status === 'connected';
    btnDisconnect.disabled = status === 'disconnected';

    if (role === 'host' && detail?.myId) {
      myIdText.textContent = detail.myId;
      myIdRow.style.display = '';
    } else {
      myIdRow.style.display = 'none';
    }

    if (detail?.error) statusBadge.title = detail.error;
    else statusBadge.title = '';
  }

  linkCable.onStatusChange = render;
  render('disconnected');

  btnHost.addEventListener('click', () => { role = 'host'; linkCable.host(); });
  btnConnect.addEventListener('click', () => {
    const id = remoteIdInput.value.trim();
    if (id) { role = 'join'; linkCable.connectTo(id); }
  });
  btnDisconnect.addEventListener('click', () => { role = null; linkCable.disconnect(); });
  btnCopyId.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(myIdText.textContent);
      btnCopyId.textContent = 'Copied!';
      setTimeout(() => { btnCopyId.textContent = 'Copy'; }, 1200);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }
  });
})();
