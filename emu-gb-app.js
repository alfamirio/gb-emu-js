/* =========================================================================================
   emu-gb-app.js — Application Wiring
   -----------------------------------------------------------------------------------------
   Wires up the emulator UI: screen canvas, input, audio/speed controls, ROM loading
   (drag-and-drop, ZIP extraction), playback (rewind, step/breakpoint, save states), and
   media export (.sav battery RAM, screenshots, audio/video clips).

   Educational-use guardrails (play-time cap, commercial-ROM filter) live in
   emu-gb-guardrails.js; this file only calls into them, via resetPlayTime() and
   checkCommercialRomGate().

   Load order: emu-gb-core.js -> emu-gb-guardrails.js -> emu-gb-app.js -> emu-gb-debug.js.
   ========================================================================================= */

// App-level UI/feature configuration (not emulator-core values, which stay next to their CPU/PPU/APU/MMU usage).
const APP_CONFIG = {
  MAX_SAVE_SLOTS: 5,                  // save-state slots kept per ROM (oldest dropped first)
  VOLUME_MIN: 0,
  VOLUME_MAX: 100,
  VOLUME_STEP: 5,                     // volume slider/percentage only moves in steps this size
  VOLUME_DEFAULT: 50,
  VOLUME_MAX_GAIN: 0.6,               // gain at slider=100%; keeps max volume well under full-scale
  TURBO_SPEED: 2,                     // emulation speed multiplier the T hotkey toggles to
  SCREENSHOT_WEBP_QUALITY: 0.80,      // canvas.toBlob() quality for the screenshot feature
  RECORDING_TIMER_LABEL_INTERVAL_MS: 500, // how often the video/audio recording timer label updates
  VIDEO_CAPTURE_FPS: 30,              // frame rate requested from canvas.captureStream() for clips
  // Codec preference for gameplay clips, tried in order (vp9 preferred over vp8).
  VIDEO_MIME_CANDIDATES: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  // Codec preference for standalone audio export: Ogg/Opus (a "real" .opus file)
  // preferred over WebM/Opus (same audio codec, different container).
  AUDIO_MIME_CANDIDATES: ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'],
  VIDEO_BITRATE_KBPS: 200,           // target bitrate for gameplay clip recording (video track)
  CLIP_AUDIO_BITRATE_KBPS: 32,       // target bitrate for the audio track inside a gameplay clip
  AUDIO_EXPORT_BITRATE_KBPS: 32,     // target bitrate for the standalone audio-only export
};

// `emulator` is `let` since coreToggle below swaps it between GBEmulator (DMG) and CGBEmulator (GBC).
const canvas = document.getElementById('screen');
const coreToggle = document.getElementById('coreToggle'); // unchecked = GB core, checked = GBC core

// Composition root: injects stats/instrumentation/scheduler so the core itself stays
// UI-agnostic. Audio is wired up separately below.
function createEmulator(EmulatorClass) {
  return new EmulatorClass({
    stats: new CoreStats(),
    instrumentation: new Instrumentation(),
    scheduler: new RafScheduler(),
  });
}
let emulator = createEmulator(GBEmulator);

/* ---- screen rendering: the core only produces a framebuffer; app.js draws it via WebGL
   (texture + fullscreen quad), falling back to canvas-2D where WebGL isn't available. ---- */
const SCREEN_W = EMU_CORE_CONFIG.SCREEN.WIDTH;
const SCREEN_H = EMU_CORE_CONFIG.SCREEN.HEIGHT;
const screenOverlay = document.getElementById('screenOverlay');
const overlayCtx = screenOverlay.getContext('2d');
let markCurrentLine = false; // debug-only "scanline mark" navbar toggle; app-side, not a core concept

// preserveDrawingBuffer: true keeps the GL backbuffer readable after compositing, which
// canvas.toBlob() (screenshots) and canvas.captureStream() (clip recording) below need.
const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true })
        || canvas.getContext('experimental-webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });

let legacyCtx = null, legacyImageData = null; // 2D fallback, only populated if WebGL is unavailable
let glProgram = null, glTexture = null;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Screen shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initWebGL() {
  const vsSource = `
    attribute vec2 aPosition;
    attribute vec2 aTexCoord;
    varying vec2 vTexCoord;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
      vTexCoord = aTexCoord;
    }
  `;
  // The core already does all the color/palette work, so this fragment shader just
  // samples the framebuffer texture as-is.
  const fsSource = `
    precision mediump float;
    varying vec2 vTexCoord;
    uniform sampler2D uScreen;
    void main() {
      gl_FragColor = texture2D(uScreen, vTexCoord);
    }
  `;
  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  glProgram = gl.createProgram();
  gl.attachShader(glProgram, vs);
  gl.attachShader(glProgram, fs);
  gl.linkProgram(glProgram);
  if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
    console.error('Screen program link error:', gl.getProgramInfoLog(glProgram));
    glProgram = null;
    return false;
  }
  gl.useProgram(glProgram);

  // Fullscreen quad as a triangle strip. V is flipped (1 at top) because the framebuffer's
  // row 0 is the screen's top row, while WebGL addresses textures bottom-up.
  const quadVerts = new Float32Array([
    /* x,  y,   u, v */
    -1, -1,   0, 1,
     1, -1,   1, 1,
    -1,  1,   0, 0,
     1,  1,   1, 0,
  ]);
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

  const positionLoc = gl.getAttribLocation(glProgram, 'aPosition');
  const texCoordLoc = gl.getAttribLocation(glProgram, 'aTexCoord');
  gl.enableVertexAttribArray(positionLoc);
  gl.enableVertexAttribArray(texCoordLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 16, 8);

  glTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); // NEAREST keeps pixels crisp,
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // matching the CSS pixelated upscale
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SCREEN_W, SCREEN_H, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array(SCREEN_W * SCREEN_H * 4));

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  return true;
}

if (gl) {
  initWebGL();
} else {
  console.warn('WebGL is unavailable in this browser; falling back to canvas-2D screen rendering.');
  legacyCtx = canvas.getContext('2d');
  legacyImageData = legacyCtx.createImageData(SCREEN_W, SCREEN_H);
}

function draw() {
  const framebuffer = emulator.getFramebuffer();
  if (glProgram) {
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SCREEN_W, SCREEN_H, gl.RGBA, gl.UNSIGNED_BYTE, framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } else {
    legacyImageData.data.set(framebuffer);
    legacyCtx.putImageData(legacyImageData, 0, 0);
  }
  overlayCtx.clearRect(0, 0, SCREEN_W, SCREEN_H); // clear every frame; re-drawn below only if the toggle is on
  if (markCurrentLine) drawCurrentLineMarker();
}

// Draws a bright horizontal marker over the PPU's current scanline (LY), so the raster
// position is visible on the actual screen output too, not just in a debug panel.
function drawCurrentLineMarker() {
  const ly = emulator.instrumentation.readPPUState().ly;
  if (ly > SCREEN_H - 1) return; // VBlank lines are off the visible screen
  overlayCtx.save();
  overlayCtx.fillStyle = 'rgba(255, 221, 0, 0.55)';
  overlayCtx.fillRect(0, ly, SCREEN_W, 1);
  overlayCtx.strokeStyle = 'rgba(255, 221, 0, 0.9)';
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeRect(0, Math.max(0, ly - 0.5), SCREEN_W, 1);
  overlayCtx.restore();
}

/* ---- audio engine: mirrors the canvas rendering above - the core APU only produces mixed
   stereo samples (emulator.drainAudioSamples()); app.js turns those into actual sound. ---- */
let audioCtx = null;
let masterGain = null;
let audioNode = null; // ScriptProcessorNode feeding masterGain, pulling from the ring buffer

// Lazily creates the AudioContext/GainNode/ScriptProcessorNode on first use. Must happen
// inside a user gesture (click/drop) per browser autoplay policy.
function ensureAudioEngine() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.connect(audioCtx.destination);
  emulator.setSampleRate(audioCtx.sampleRate); // real device rate, not an assumed 44100

  const bufferSize = 2048;
  audioNode = audioCtx.createScriptProcessor(bufferSize, 0, 2);
  audioNode.onaudioprocess = (e) => {
    const { left, right } = emulator.drainAudioSamples(bufferSize);
    e.outputBuffer.getChannelData(0).set(left);
    e.outputBuffer.getChannelData(1).set(right);
  };
  audioNode.connect(masterGain);
  applyGain();
}

// Maps the volume slider (0-100%) to gain through a squared curve, since perceived loudness
// is roughly logarithmic - a linear mapping would make the top of the slider feel too loud.
function applyGain() {
  if (!masterGain) return;
  const pct = soundControls.volumeSlider.value / APP_CONFIG.VOLUME_MAX; // 0..1, straight off the slider
  const taperedGain = pct * pct * APP_CONFIG.VOLUME_MAX_GAIN;
  masterGain.gain.value = isMuted ? 0 : taperedGain;
}

// Wires the core's cross-cutting hooks (onFrame/onFpsUpdate/onBreakpointHit) onto whichever
// emulator instance is current. Re-run on every GB<->GBC swap so the wiring follows along.
function wireEmulatorCallbacks() {
  emulator.onFrame = () => { draw(); refreshDebugTools(); };
  emulator.onFpsUpdate = (fps) => { document.getElementById('fps').textContent = fps + ' fps'; };
  emulator.instrumentation.onBreakpointHit = (reason) => {
    btnPause.textContent = '▶ Start';
    bpStatus.textContent = `⏹ Stopped — ${reason}`;
    refreshDebugTools();
  };
  emulator.onAudioResume = () => { ensureAudioEngine(); if (audioCtx?.state === 'suspended') audioCtx.resume(); };
  emulator.onAudioSuspend = () => { if (audioCtx?.state === 'running') audioCtx.suspend(); };
  // A core swap creates a fresh APU defaulting to 44100 - if audio is already running,
  // tell it the real sample rate right away instead of waiting for a resume.
  if (audioCtx) emulator.setSampleRate(audioCtx.sampleRate);
}
wireEmulatorCallbacks();

// Swaps `emulator` to match the GB/GBC core toggle, pausing the old instance first.
function ensureEmulatorMatchesCoreToggle() {
  const NeededClass = coreToggle.checked ? CGBEmulator : GBEmulator;
  if (emulator instanceof NeededClass) return;
  emulator.pause();
  emulator = createEmulator(NeededClass);
  wireEmulatorCallbacks();
}

// ROM loading panel refs (file picker, drag-drop zone, ROM header info)
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const romInfo = document.getElementById('romInfo');
const checksumBadges = document.getElementById('checksumBadges');

// Playback controls refs (start/pause/reset/rewind)
const btnPause = document.getElementById('btnPause');
const btnReset = document.getElementById('btnReset');
const btnRewind = document.getElementById('btnRewind');
const rewindInfo = document.getElementById('rewindInfo');

// Step/breakpoint debugging controls refs
const btnStep = document.getElementById('btnStep');
const btnStepLine = document.getElementById('btnStepLine');
const btnStepFrame = document.getElementById('btnStepFrame');
const btnStep1s = document.getElementById('btnStep1s');
const bpStatus = document.getElementById('bpStatus');

// Navbar toggle: when checked, a (re)loaded ROM is left paused on its first instruction
// instead of auto-starting, ready to be stepped via the buttons above.
const stepDebugToggle = document.getElementById('stepDebugToggle');
const stepDebugLabelOn = document.getElementById('stepDebugLabelOn');
stepDebugToggle.addEventListener('change', () => {
  stepDebugLabelOn.classList.toggle('active', stepDebugToggle.checked);
});

let lastROMBytes = null;

// Central registry of every localStorage key this app persists, including keys owned by
// other files, so "Clear all saved config" below can iterate one place instead of a list.
const STORAGE_KEYS = {
  UI_CONFIG: 'jsgb-config:ui',                     // model/mode/etc - this file
  SOUND_CONFIG: 'jsgb-config:sound',               // volume/mute - this file
  RTC_CORRECTION: 'jsgb-config:rtc-correction',    // RTC panel - emu-gb-debug-visualizers.js
  MEMSCAN_CHEATS: 'jsgb-config:memscan-cheats',    // saved cheats - emu-gb-debug-inspectors.js
};
const STORAGE_KEY_PREFIXES = {
  SAVE_SLOTS: 'jsgb-saveslots:', // one key per ROM title - this file
};

/* Small factory for the "load merged JSON from a key, save merged JSON back to it" pattern,
   shared by the UI config and sound config below. */
function makePersistedConfig(key, defaults = {}) {
  function load() {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? { ...defaults } : Object.assign({ ...defaults }, JSON.parse(raw));
    } catch (e) { return { ...defaults }; }
  }
  function save(partial) {
    try {
      const merged = Object.assign(load(), partial);
      localStorage.setItem(key, JSON.stringify(merged));
      return merged;
    } catch (e) { /* storage unavailable/full - settings won't persist */ }
  }
  return { load, save };
}

/* Unified UI config: model (GB/GBP), play/debug mode, and "mark current line" persisted
   together. Sound mute/volume use a separate entry below; speed is never persisted. */
const uiConfigStore = makePersistedConfig(STORAGE_KEYS.UI_CONFIG);
function loadUIConfig() { return uiConfigStore.load(); }
function saveUIConfig(partial) { uiConfigStore.save(partial); }

const savedUIConfig = loadUIConfig();

// GB/GBC core toggle: unchecked = GB (DMG) core (default), checked = GBC core. Overrides the cartridge header's own CGB flag.
const coreLabelGB = document.getElementById('coreLabelGB');
const coreLabelGBC = document.getElementById('coreLabelGBC');

function applyCoreToggle() {
  const wantGBC = coreToggle.checked;
  coreLabelGBC.classList.toggle('active', wantGBC);
  coreLabelGB.classList.toggle('active', !wantGBC);
  saveUIConfig({ gbcCore: wantGBC });
  if (lastROMBytes) loadROMBytes(lastROMBytes); // re-run the currently loaded ROM through the newly forced core
  else ensureEmulatorMatchesCoreToggle();
  // Logged after the reload above, since loadROM() resets the event log.
  emulator.stats?.logEvent('System', 'info', 'core-switch', wantGBC ? 'Switched to GBC core' : 'Switched to GB (DMG) core');
}

// Restore the saved core choice before the first render so the UI doesn't flash the default.
if (typeof savedUIConfig.gbcCore === 'boolean') coreToggle.checked = savedUIConfig.gbcCore;
applyCoreToggle();
coreToggle.addEventListener('change', applyCoreToggle);

function getROMTitle(bytes) { return parseROMTitle(bytes); } // parseROMTitle: emu-gb-core.js
// All officially-assigned cartridge type bytes (header offset 0x147).
const CART_TYPE_NAMES = {
  0x00: 'ROM ONLY', 0x01: 'MBC1', 0x02: 'MBC1+RAM', 0x03: 'MBC1+RAM+BATTERY',
  0x05: 'MBC2', 0x06: 'MBC2+BATTERY',
  0x08: 'ROM+RAM', 0x09: 'ROM+RAM+BATTERY',
  0x0B: 'MMM01', 0x0C: 'MMM01+RAM', 0x0D: 'MMM01+RAM+BATTERY',
  0x0F: 'MBC3+TIMER+BATTERY', 0x10: 'MBC3+TIMER+RAM+BATTERY', 0x11: 'MBC3',
  0x12: 'MBC3+RAM', 0x13: 'MBC3+RAM+BATTERY',
  0x19: 'MBC5', 0x1A: 'MBC5+RAM', 0x1B: 'MBC5+RAM+BATTERY',
  0x1C: 'MBC5+RUMBLE', 0x1D: 'MBC5+RUMBLE+RAM', 0x1E: 'MBC5+RUMBLE+RAM+BATTERY',
  0x20: 'MBC6', 0x22: 'MBC7+SENSOR+RUMBLE+RAM+BATTERY',
  0xFC: 'POCKET CAMERA', 0xFD: 'BANDAI TAMA5', 0xFE: 'HuC3', 0xFF: 'HuC1+RAM+BATTERY',
};
// Mapper families this emulator implements bank-switching for.
function isCartTypeSupported(t) {
  return t === 0x00 || (t >= 0x01 && t <= 0x03) || t === 0x05 || t === 0x06 || (t >= 0x0F && t <= 0x13) || (t >= 0x19 && t <= 0x1E);
}
function getMBCName(bytes) {
  const t = bytes[0x147];
  return CART_TYPE_NAMES[t] || ('Unknown type 0x' + t.toString(16));
}
// Warns when the cartridge uses an unimplemented mapper (falls back to MBC1-style banking).
function getMBCCompatibilityWarning(bytes) {
  const t = bytes[0x147];
  if (isCartTypeSupported(t)) return null;
  const name = CART_TYPE_NAMES[t] || ('unknown type 0x' + t.toString(16));
  return `This ROM uses ${name}, which isn't implemented. Falling back to MBC1-style banking - expect glitches, save data that doesn't stick, or a game that doesn't boot.`;
}
// Informational note for supported mappers with an unemulated hardware feature (MBC5 rumble).
function getMBCInfoNote(bytes) {
  const t = bytes[0x147];
  if (t >= 0x1C && t <= 0x1E) return "This cartridge's rumble motor isn't emulated (no vibration) - everything else works normally.";
  return null;
}

// Cartridge types with battery-backed save RAM this emulator persists (MBC1/2/3/5).
function hasBatteryBackedRAM(bytes) {
  const t = bytes[0x147];
  return t === 0x03 || t === 0x06 || t === 0x0F || t === 0x10 || t === 0x13 || t === 0x1B || t === 0x1E;
}
// Cart RAM size declared in the ROM header (0x149), in the standard .sav layout. MBC2 is a
// fixed-size special case: 512 nibbles saved as 512 bytes, one nibble per byte.
function getCartRAMByteSize(bytes) {
  const t = bytes[0x147];
  if (t === 0x05 || t === 0x06) return 0x200;
  const RAM_SIZES = { 0x00: 0, 0x01: 0x800, 0x02: 0x2000, 0x03: 0x8000, 0x04: 0x20000, 0x05: 0x10000 };
  return RAM_SIZES[bytes[0x149]] || 0;
}

// Header's CGB flag (0x143): 0xC0 requires GBC hardware, 0x80 merely takes advantage of it.
// The GB/GBC toggle overrides this, so these warn on conflicts and note which core is running.
function getGBCCompatibilityWarning(bytes) {
  const flag = bytes[0x143];
  if (flag === 0xC0 && !coreToggle.checked) {
    return 'GBC-only game forced onto the GB core - it will likely fail to run correctly.';
  }
  return null;
}
function getGBCInfoNote(bytes) {
  const flag = bytes[0x143];
  const runningGBC = coreToggle.checked;
  if (flag === 0xC0) return runningGBC ? 'GBC-only game - running on the GBC core.' : null;
  if (flag === 0x80) {
    return runningGBC
      ? 'GBC-enhanced game - running on the GBC core for its full color palettes.'
      : 'GBC-enhanced game forced onto the GB core - runs, but without its color palettes.';
  }
  return null;
}


// File-integrity checksums for the loaded ROM image, over the raw file bytes - distinct
// from the cartridge header's own internal checksum bytes.

// CRC32 (ISO-HDLC / zlib polynomial), via the crc-32 library. CRC32.buf() returns a signed
// 32-bit int, so mask it to unsigned before hex-formatting.
function crc32(bytes) {
  return CRC32.buf(bytes) >>> 0;
}

// MD5 via the spark-md5 library. SparkMD5.ArrayBuffer.hash() wants a real ArrayBuffer, so
// slice one out first if `bytes` is a view over a larger buffer.
function md5(bytes) {
  const arrayBuffer = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return SparkMD5.ArrayBuffer.hash(arrayBuffer);
}

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Computes all four checksums for the loaded ROM (SHA-1/SHA-256 via Web Crypto; CRC32/MD5 above).
async function computeChecksums(bytes) {
  const [sha1Buf, sha256Buf] = await Promise.all([
    crypto.subtle.digest('SHA-1', bytes),
    crypto.subtle.digest('SHA-256', bytes),
  ]);
  return {
    crc32: crc32(bytes).toString(16).toUpperCase().padStart(8, '0'),
    md5: md5(bytes).toUpperCase(),
    sha1: bufToHex(sha1Buf).toUpperCase(),
    sha256: bufToHex(sha256Buf).toUpperCase(),
  };
}

// Renders the checksum badges; clicking one copies its value to the clipboard.
function renderChecksumBadges(checksums) {
  const entries = [
    ['CRC32', checksums.crc32],
    ['MD5', checksums.md5],
    ['SHA-1', checksums.sha1],
    ['SHA-256', checksums.sha256],
  ];
  checksumBadges.innerHTML = entries.map(([label, value]) =>
    `<span class="checksum-badge" data-value="${value}" title="${value}">${label}</span>`
  ).join('');
  checksumBadges.querySelectorAll('.checksum-badge').forEach((el) => {
    // flashCopiedBadge: emu-gb-debug-core.js, loaded after this file - fine, since it's only
    // referenced from inside this click handler, well after every script has loaded.
    el.addEventListener('click', () => flashCopiedBadge(el, el.dataset.value));
  });
}

// After any emulator.loadROM() call (fresh load or reset/reboot), the banking panel and RTC
// tab need rebuilding against the new ROM's mapper state.
function refreshBankingAndRtcPanels() {
  lastRenderedAccessSeq = -1;
  lastRenderedBankSwitchT = -1;
  buildBankingPanel();
  updateRtcTabAvailability(); // show/hide the RTC tab depending on whether this ROM is MBC3+TIMER
}

// Finishes loading a ROM once its raw bytes are in hand, shared by the plain-file and zip paths.
async function loadROMBytes(bytes) {
  // Commercial-ROM check, run before touching any state so a blocked ROM leaves the
  // previous one untouched.
  const gate = checkCommercialRomGate(bytes);
  if (gate.blocked) {
    romInfo.innerHTML = `<span style="color:#e8794b">⚠ This ROM (CRC32 0x${gate.crc32}) matches the No-Intro commercial-game database and can't be loaded here.</span>` +
      `<br><span style="color:#9aa0a6">ℹ This emulator only supports homebrew/non-commercial ROMs.</span>`;
    checksumBadges.innerHTML = '';
    return;
  }

  lastROMBytes = bytes;
  ensureEmulatorMatchesCoreToggle();
  emulator.loadROM(bytes);
  emulator.stats?.logEvent('System', 'info', 'rom-loaded', `ROM loaded: ${getROMTitle(bytes)}`);
  const checksums = await computeChecksums(bytes);
  const mbcWarning = getMBCCompatibilityWarning(bytes);
  const mbcInfo = getMBCInfoNote(bytes);
  const gbcWarning = getGBCCompatibilityWarning(bytes);
  const gbcInfo = getGBCInfoNote(bytes);
  romInfo.innerHTML = `<b>${getROMTitle(bytes)}</b><br>Mapper: ${getMBCName(bytes)}<br>Size: ${(bytes.length / 1024).toFixed(0)} KB` +
    `<br>Checksum: 0x${checksums.crc32}` +
    (gbcWarning ? `<br><span style="color:#e8794b">⚠ ${gbcWarning}</span>` : '') +
    (!gbcWarning && gbcInfo ? `<br><span style="color:#9aa0a6">ℹ ${gbcInfo}</span>` : '') +
    (mbcWarning ? `<br><span style="color:#e8794b">⚠ ${mbcWarning}</span>` : '') +
    (!mbcWarning && mbcInfo ? `<br><span style="color:#9aa0a6">ℹ ${mbcInfo}</span>` : '');
  renderChecksumBadges(checksums);
  refreshBankingAndRtcPanels();
  selectedFrameStatsIndex = null; // follow the latest frame again for this newly-loaded ROM
  selectedAnatomyLine = null;     // clear any pinned scanline from the previous ROM
  btnPause.disabled = false; btnReset.disabled = false;
  btnStep.disabled = false; btnStepLine.disabled = false; btnStepFrame.disabled = false;
  btnStep1s.disabled = false;
  updateRewindButton();
  bpStatus.textContent = 'Ready.';
  updateStateButtons();
  if (typeof modelToggle !== 'undefined') {
    modelToggle.disabled = emulator instanceof CGBEmulator;
    modelToggle.title = modelToggle.disabled
      ? 'Not applicable in GBC mode - colors come from the cartridge\'s own CGB palettes.'
      : '';
  }
  if (stepDebugToggle.checked) {
    btnPause.textContent = '▶ Start';
    bpStatus.textContent = 'Step Debug — paused at boot.';
  } else {
    emulator.start();
  }
  resetPlayTime();
}

/* Zipped ROM support: minimal dependency-free ZIP reader. Walks the central directory for
   .gb/.gbc/.bin entries, then extracts via the local file header. */
const ROM_IN_ZIP_RE = /\.(gb|gbc|bin)$/i;

function readZipEntries(bytes) {
  if (bytes.length < 22) throw new Error('File is too small to be a ZIP archive.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIG = 0x06054b50;
  const minEOCD = 22, maxCommentLen = 65535;
  const searchStart = Math.max(0, bytes.length - minEOCD - maxCommentLen);
  let eocdOffset = -1;
  for (let i = bytes.length - minEOCD; i >= searchStart; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file (end-of-central-directory record not found).');

  const cdCount = dv.getUint16(eocdOffset + 10, true);
  let ptr = dv.getUint32(eocdOffset + 16, true);
  const CD_SIG = 0x02014b50;
  const entries = [];
  for (let i = 0; i < cdCount; i++) {
    if (dv.getUint32(ptr, true) !== CD_SIG) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localHeaderOffset = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.push({ name, method, compSize, localHeaderOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractZipEntry(bytes, entry) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const LFH_SIG = 0x04034b50;
  if (dv.getUint32(entry.localHeaderOffset, true) !== LFH_SIG) throw new Error('Corrupt ZIP local file header.');
  const nameLen = dv.getUint16(entry.localHeaderOffset + 26, true);
  const extraLen = dv.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compSize);

  if (entry.method === 0) return new Uint8Array(compressed); // stored - no compression
  if (entry.method === 8) {
    if (!window.DecompressionStream) throw new Error("This browser doesn't support in-browser ZIP decompression.");
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`Unsupported ZIP compression method (${entry.method}) - only stored or deflated entries are supported.`);
}

async function handleZipFile(file) {
  romInfo.textContent = 'Reading zip file…';
  checksumBadges.innerHTML = '';
  try {
    const zipBytes = new Uint8Array(await file.arrayBuffer());
    const romEntries = readZipEntries(zipBytes)
      .filter(e => ROM_IN_ZIP_RE.test(e.name) && !e.name.endsWith('/'))
      .sort((a, b) => a.name.localeCompare(b.name)); // deterministic pick when a zip holds several ROMs
    if (romEntries.length === 0) {
      romInfo.textContent = 'No .gb/.gbc/.bin ROM found inside that zip.';
      return;
    }
    const chosen = romEntries[0];
    romInfo.textContent = `Extracting "${chosen.name}" from zip…`;
    const romBytes = await extractZipEntry(zipBytes, chosen);
    await loadROMBytes(romBytes);
    if (romEntries.length > 1) {
      romInfo.innerHTML += `<br><span style="color:#e8c46b">Zip had ${romEntries.length} ROMs — loaded "${chosen.name}".</span>`;
    }
  } catch (err) {
    romInfo.textContent = `Could not load ROM from zip: ${err.message}`;
  }
}

function handleROMFile(file) {
  if (/\.zip$/i.test(file.name)) { handleZipFile(file); return; }
  const reader = new FileReader();
  reader.onload = (e) => { loadROMBytes(new Uint8Array(e.target.result)); };
  reader.readAsArrayBuffer(file);
}

fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleROMFile(e.target.files[0]); });

['dragover', 'dragenter'].forEach(evt => window.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); }));
['dragleave', 'drop'].forEach(evt => window.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); }));
window.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) handleROMFile(e.dataTransfer.files[0]); });

btnPause.addEventListener('click', () => {
  if (emulator.running) {
    emulator.pause();
    btnPause.textContent = '▶ Start';
    bpStatus.textContent = 'Paused.';
  } else {
    emulator.start();
    btnPause.textContent = '⏸ Pause';
    bpStatus.textContent = 'Running.';
  }
  refreshDebugTools();
});
// Shared by Reset and .sav import: reboots on the loaded ROM. loadROM() reinitializes
// CPU/PPU/banking/RTC state but leaves cartRAM untouched, mirroring a power-cycle.
function resetEmulator(statusMsg) {
  if (!lastROMBytes) return;
  emulator.loadROM(lastROMBytes);
  refreshBankingAndRtcPanels();
  if (stepDebugToggle.checked) {
    btnPause.textContent = '▶ Start';
    bpStatus.textContent = 'Step Debug — paused at boot. Use the step buttons above.';
  } else {
    emulator.start();
    btnPause.textContent = '⏸ Pause';
    bpStatus.textContent = statusMsg;
  }
  updateRewindButton(); // a fresh run means any rewind history from before is gone too
  resetPlayTime();
}

btnReset.addEventListener('click', () => resetEmulator('Reset.'));

// Rewind: in-memory only, up to GBEmulator.REWIND_MAX_SNAPSHOTS deep, one snapshot every
// GBEmulator.REWIND_SNAPSHOT_INTERVAL_SECONDS of emulated time.
function updateRewindButton() {
  const snapshots = emulator.rewindBuffer.length;
  const interval = emulator.REWIND_SNAPSHOT_INTERVAL_SECONDS;
  const maxSnapshots = emulator.REWIND_MAX_SNAPSHOTS;
  btnRewind.disabled = snapshots === 0;
  rewindInfo.textContent = snapshots > 0
    ? `${snapshots * interval}s of rewind (${snapshots}/${maxSnapshots} snapshots, every ${interval}s).`
    : (lastROMBytes ? `No rewind history yet — play for ${interval}s first.` : '');
}
setInterval(updateRewindButton, 250); // buffer grows in the background while playing, not just on clicks

btnRewind.addEventListener('click', () => {
  const ok = emulator.rewind();
  if (ok) {
    btnPause.textContent = '▶ Start';
    bpStatus.textContent = `Rewound ${emulator.REWIND_SNAPSHOT_INTERVAL_SECONDS}s — PC=${hex16(emulator.instrumentation.readRegisters().PC)}`;
  }
  updateRewindButton();
});

/* ---- step / breakpoint debugger: each stepping method fires the emulator's onFrame hook
   itself (wired in wireEmulatorCallbacks()), so only click-specific status text is needed here. ---- */
btnStep.addEventListener('click', () => {
  emulator.stepOne();
  btnPause.textContent = '▶ Start';
  bpStatus.textContent = `Stepped — now at PC=${hex16(emulator.instrumentation.readRegisters().PC)}`;
});

btnStepLine.addEventListener('click', () => {
  emulator.stepLine();
  btnPause.textContent = '▶ Start';
  bpStatus.textContent = `Stepped to line LY=${emulator.instrumentation.readPPUState().ly} — PC=${hex16(emulator.instrumentation.readRegisters().PC)}`;
});

btnStepFrame.addEventListener('click', () => {
  emulator.stepFrame();
  btnPause.textContent = '▶ Start';
  bpStatus.textContent = `Stepped one frame — PC=${hex16(emulator.instrumentation.readRegisters().PC)}`;
});

btnStep1s.addEventListener('click', () => {
  emulator.stepOneSecond();
  btnPause.textContent = '▶ Start';
  bpStatus.textContent = `Stepped 1s (60 frames) — PC=${hex16(emulator.instrumentation.readRegisters().PC)}`;
  selectedFrameStatsIndex = null; // let Frame Activity follow the 60 frames just stepped
});

// Sound controls: mute state + volume persisted in localStorage.
const soundConfigStore = makePersistedConfig(STORAGE_KEYS.SOUND_CONFIG);
function saveSoundConfig() {
  soundConfigStore.save({ muted: isMuted, volume: Number(soundControls.volumeSlider.value), channelMuted: emulator.getAllChannelMuted() });
}
function loadSoundConfig() { return soundConfigStore.load(); }

const soundControls = {
  btnMute: document.getElementById('btnMute'),
  volumeSlider: document.getElementById('volumeSlider'),
  volumeLabel: document.getElementById('volumeLabel'),
};

soundControls.volumeSlider.min = APP_CONFIG.VOLUME_MIN;
soundControls.volumeSlider.max = APP_CONFIG.VOLUME_MAX;
soundControls.volumeSlider.step = APP_CONFIG.VOLUME_STEP;
soundControls.volumeSlider.value = APP_CONFIG.VOLUME_DEFAULT;

// Snaps a percentage onto the configured step.
function snapToVolumeStep(pct) {
  return Math.round(pct / APP_CONFIG.VOLUME_STEP) * APP_CONFIG.VOLUME_STEP;
}

const savedSoundConfig = loadSoundConfig();
if (savedSoundConfig && typeof savedSoundConfig.volume === 'number') soundControls.volumeSlider.value = snapToVolumeStep(savedSoundConfig.volume);
let isMuted = !!(savedSoundConfig && savedSoundConfig.muted);

applyGain();
soundControls.btnMute.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
soundControls.volumeLabel.textContent = soundControls.volumeSlider.value + '%';

soundControls.btnMute.addEventListener('click', () => {
  isMuted = !isMuted;
  applyGain();
  soundControls.btnMute.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
  saveSoundConfig();
});
soundControls.volumeSlider.addEventListener('input', () => {
  applyGain();
  soundControls.volumeLabel.textContent = soundControls.volumeSlider.value + '%';
  saveSoundConfig();
});

// Speed control: preset badges (x0.25 - 4x). Not persisted; always starts at 1x.
const speedBadges = [...document.querySelectorAll('.speed-badge')];

function setSpeed(value) {
  emulator.speed = value;
  speedBadges.forEach(b => b.classList.toggle('active', Number(b.dataset.speed) === value));
  emulator.stats?.logEvent('System', 'info', 'speed-change', `Speed set to ${value}×`);
}

setSpeed(1);

speedBadges.forEach(badge => {
  badge.addEventListener('click', () => setSpeed(Number(badge.dataset.speed)));
});

// Turbo hotkey: T toggles between 1x and 2x speed. Skipped while a text input has focus.
window.addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  setSpeed(emulator.speed === APP_CONFIG.TURBO_SPEED ? 1 : APP_CONFIG.TURBO_SPEED);
});

// Keyboard input
const KEY_MAP = {
  ArrowRight: [0, true], ArrowLeft: [1, true], ArrowUp: [2, true], ArrowDown: [3, true],
  z: [1, false], Z: [1, false],  // B
  x: [0, false], X: [0, false],  // A
  Shift: [2, false],             // Select
  Enter: [3, false],             // Start
};
window.addEventListener('keydown', (e) => { const m = KEY_MAP[e.key]; if (m) { emulator.setButton(m[0], true, m[1]); e.preventDefault(); } });
window.addEventListener('keyup', (e) => { const m = KEY_MAP[e.key]; if (m) { emulator.setButton(m[0], false, m[1]); e.preventDefault(); } });


/* ---- Save / load states: up to MAX_SLOTS snapshots per ROM in localStorage. [/Save
   quick-saves, ]/Load loads latest, sidebar cards load a specific slot, Export/Import moves one as JSON. ---- */

const MAX_SLOTS = APP_CONFIG.MAX_SAVE_SLOTS;

const btnSaveState = document.getElementById('btnSaveState');
const btnLoadState = document.getElementById('btnLoadState');
const btnExportState = document.getElementById('btnExportState');
const btnImportStateLabel = document.getElementById('btnImportState');
const importStateInput = document.getElementById('importStateInput');
const btnDeleteAllStates = document.getElementById('btnDeleteAllStates');
const stateInfo = document.getElementById('stateInfo');
const slotList = document.getElementById('slotList');
const slotEmpty = document.getElementById('slotEmpty');
const slotCountBadge = document.getElementById('slotCount');
const btnDownloadSav = document.getElementById('btnDownloadSav');
const btnImportSavLabel = document.getElementById('btnImportSav');
const importSavInput = document.getElementById('importSavInput');
const savInfo = document.getElementById('savInfo');

function slotsKey() { return STORAGE_KEY_PREFIXES.SAVE_SLOTS + (emulator.romTitle || 'rom'); }

function loadSlots() {
  try { return JSON.parse(localStorage.getItem(slotsKey())) || []; }
  catch { return []; }
}

// Unique-enough id for a save-state slot: timestamp + a short random suffix, in case two
// slots are saved within the same millisecond.
function makeSlotId() {
  return 'slot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

// Writes the slot list back to localStorage, dropping the oldest slot(s) if quota is exceeded.
function writeSlots(slots) {
  while (true) {
    try { localStorage.setItem(slotsKey(), JSON.stringify(slots)); return slots; }
    catch (e) {
      if (slots.length <= 1) throw e;
      slots.pop();
    }
  }
}

function updateStateButtons() {
  const hasROM = emulator.hasROM();
  btnSaveState.disabled = !hasROM;
  btnExportState.disabled = !hasROM;
  btnImportStateLabel.classList.toggle('disabled', !hasROM);
  btnScreenshot.disabled = !hasROM;
  // Don't yank the record button out from under an in-progress recording.
  if (!clipRecorderCtl.isActive()) btnRecordClip.disabled = !hasROM;
  if (!audioRecorderCtl.isActive()) btnRecordAudio.disabled = !hasROM;
  document.querySelectorAll('.layer-download-btn').forEach(btn => { btn.disabled = !hasROM; });

  // .sav controls only apply to carts with battery-backed save RAM this emulator persists.
  const hasSaveRAM = hasROM && lastROMBytes && hasBatteryBackedRAM(lastROMBytes);
  btnDownloadSav.disabled = !hasSaveRAM;
  btnImportSavLabel.classList.toggle('disabled', !hasSaveRAM);

  const slots = hasROM ? loadSlots() : [];
  btnLoadState.disabled = slots.length === 0;
  btnDeleteAllStates.disabled = slots.length === 0;
  slotCountBadge.textContent = slots.length + '/' + MAX_SLOTS;

  renderSlotList(slots);
}

// Decodes a slot's stored (base64) PPU framebuffer into its thumbnail canvas.
function drawSlotThumbnail(canvas, state) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(EMU_CORE_CONFIG.SCREEN.WIDTH, EMU_CORE_CONFIG.SCREEN.HEIGHT);
  imgData.data.set(base64ToU8(state.ppu.framebuffer));
  ctx.putImageData(imgData, 0, 0);
}

function renderSlotList(slots) {
  slotList.querySelectorAll('.slot-card').forEach(el => el.remove());
  slotEmpty.style.display = slots.length === 0 ? '' : 'none';

  slots.forEach((slot, i) => {
    const card = document.createElement('div');
    card.className = 'slot-card' + (i === 0 ? ' latest' : '');

    const canvas = document.createElement('canvas');
    canvas.width = EMU_CORE_CONFIG.SCREEN.WIDTH; canvas.height = EMU_CORE_CONFIG.SCREEN.HEIGHT;
    drawSlotThumbnail(canvas, slot.state);
    card.appendChild(canvas);

    const meta = document.createElement('div');
    meta.className = 'slot-meta';
    const tag = document.createElement('span');
    tag.className = 'slot-tag';
    tag.textContent = i === 0 ? 'Latest' : '#' + (i + 1);
    const time = document.createElement('span');
    time.className = 'slot-time';
    time.textContent = new Date(slot.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    meta.appendChild(tag); meta.appendChild(time);
    card.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'slot-delete';
    del.textContent = '×';
    del.title = 'Delete this save';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSlot(slot.id); });
    card.appendChild(del);

    card.addEventListener('click', () => loadSlot(slot.id));
    slotList.appendChild(card);
  });
}

// Applies a save-state object to the running emulator.
function applyLoadedState(state) {
  const wasRunning = emulator.running;
  emulator.pause();
  emulator.loadSaveState(state);
  draw();        // repaint immediately from the restored framebuffer
  updateRtcTabAvailability();
  refreshDebugTools();
  if (wasRunning) emulator.start();
}

function quickSaveState() {
  if (!emulator.hasROM()) return;
  const slots = loadSlots();
  slots.unshift({ id: makeSlotId(),
                  savedAt: new Date().toISOString(), state: emulator.getSaveState() });
  while (slots.length > MAX_SLOTS) slots.pop();
  try {
    const saved = writeSlots(slots);
    updateStateButtons();
    stateInfo.textContent = `State saved ✓ (${saved.length}/${MAX_SLOTS})`;
    emulator.stats?.logEvent('System', 'info', 'state-saved', `Save state written (${saved.length}/${MAX_SLOTS} slots)`);
  } catch (e) {
    alert('Could not save state (storage full): ' + e.message);
  }
}

function quickLoadState() {
  const slots = loadSlots();
  if (slots.length === 0) return;
  loadSlot(slots[0].id);
}

function loadSlot(id) {
  const slots = loadSlots();
  const slot = slots.find(s => s.id === id);
  if (!slot) return;
  try {
    applyLoadedState(slot.state);
    stateInfo.textContent = 'Loaded save from ' + new Date(slot.savedAt).toLocaleTimeString();
    emulator.stats?.logEvent('System', 'info', 'state-loaded', 'Save state loaded from slot saved ' + new Date(slot.savedAt).toLocaleTimeString());
  } catch (e) {
    alert('Could not load state: ' + e.message);
  }
}

function deleteSlot(id) {
  const slots = loadSlots().filter(s => s.id !== id);
  writeSlots(slots);
  updateStateButtons();
  stateInfo.textContent = 'Save deleted.';
}

// Wipes every saved slot for the currently loaded ROM.
function deleteAllSlots() {
  const slots = loadSlots();
  if (slots.length === 0) return;
  const romName = emulator.romTitle || 'this ROM';
  const proceed = confirm(`Delete all ${slots.length} saved state(s) for "${romName}"? This cannot be undone.`);
  if (!proceed) return;
  writeSlots([]);
  updateStateButtons();
  stateInfo.textContent = 'All saved states deleted.';
}

btnSaveState.addEventListener('click', quickSaveState);
btnLoadState.addEventListener('click', quickLoadState);
btnDeleteAllStates.addEventListener('click', deleteAllSlots);

btnExportState.addEventListener('click', () => {
  try {
    const state = emulator.getSaveState();
    const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    downloadBlob(blob, `${safeRomName()}.savestate.json`);
  } catch (e) {
    alert('Could not export state: ' + e.message);
  }
});

importStateInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    let state;
    try {
      state = JSON.parse(ev.target.result);
    } catch (err) {
      alert("That file doesn't look like a valid save state (not valid JSON).");
      return;
    }
    if (state.romTitle && emulator.romTitle && state.romTitle !== emulator.romTitle) {
      const proceed = confirm(
        `This save is from "${state.romTitle}" but the currently loaded ROM is "${emulator.romTitle}". Load it anyway?`
      );
      if (!proceed) return;
    }
    try {
      applyLoadedState(state);
      // Also add the import to this ROM's slot list so it shows up in the sidebar.
      const slots = loadSlots();
      slots.unshift({ id: makeSlotId(),
                       savedAt: state.savedAt || new Date().toISOString(), state });
      while (slots.length > MAX_SLOTS) slots.pop();
      writeSlots(slots);
      updateStateButtons();
      stateInfo.textContent = 'State imported ✓';
    } catch (err) {
      alert('Could not load state: ' + err.message);
    }
  };
  reader.readAsText(file);
  importStateInput.value = ''; // allow re-importing the same file again later
});

/* ---- .sav export/import: battery-backed cart RAM only, flat binary layout
   compatible with other emulators/flash carts. Separate from the save-state system. ---- */
btnDownloadSav.addEventListener('click', () => {
  if (!lastROMBytes || !hasBatteryBackedRAM(lastROMBytes)) return;
  const size = getCartRAMByteSize(lastROMBytes);
  if (size === 0) { alert('This cartridge has no save RAM to export.'); return; }
  const data = emulator.getCartRAM(size);
  downloadBlob(new Blob([data], { type: 'application/octet-stream' }), `${safeRomName()}.sav`);
  savInfo.textContent = 'Save file downloaded ✓';
});

importSavInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  importSavInput.value = ''; // allow re-importing the same file again later
  if (!file) return;
  if (!lastROMBytes || !hasBatteryBackedRAM(lastROMBytes)) {
    alert('The currently loaded ROM has no battery-backed save RAM to import into.');
    return;
  }
  const expectedSize = getCartRAMByteSize(lastROMBytes);
  const reader = new FileReader();
  reader.onload = (ev) => {
    const bytes = new Uint8Array(ev.target.result);
    if (expectedSize && bytes.length !== expectedSize) {
      const proceed = confirm(
        `This .sav is ${bytes.length} bytes, but this ROM's header declares ${expectedSize} bytes of save RAM. ` +
        `Load it anyway (extra bytes ignored, missing bytes left as-is)?`
      );
      if (!proceed) return;
    }
    const n = Math.min(bytes.length, expectedSize || bytes.length);
    emulator.setCartRAM(bytes.subarray(0, n));
    // Game only re-reads save RAM at boot, so reset to apply it.
    resetEmulator('Save file loaded, game reset to apply it.');
    savInfo.textContent = 'Save file loaded ✓ (game reset to apply it)';
  };
  reader.onerror = () => { alert('Could not read that file.'); };
  reader.readAsArrayBuffer(file);
});

/* ---- hotkeys: [ quick-save, ] quick-load ---- */
window.addEventListener('keydown', (e) => {
  if (e.key === '[') {
    e.preventDefault();
    if (!btnSaveState.disabled) quickSaveState();
  } else if (e.key === ']') {
    e.preventDefault();
    if (!btnLoadState.disabled) quickLoadState();
  }
});

/* ---- media capture: WEBP screenshots, WEBM clips, Opus audio export ---- */
const btnScreenshot = document.getElementById('btnScreenshot');
const btnRecordClip = document.getElementById('btnRecordClip');
const btnRecordAudio = document.getElementById('btnRecordAudio');
const captureInfo = document.getElementById('captureInfo');

function safeRomName() { return (emulator.romTitle || 'rom').replace(/[^a-z0-9_-]+/gi, '_'); }

// Triggers a browser download for an in-memory blob, then cleans up the object URL.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

btnScreenshot.addEventListener('click', () => {
  canvas.toBlob(blob => {
    if (!blob) { alert('Could not capture screenshot (WEBP encoding is not supported in this browser).'); return; }
    downloadBlob(blob, `${safeRomName()}_${Date.now()}.webp`);
    captureInfo.textContent = 'Screenshot saved ✓';
  }, 'image/webp', APP_CONFIG.SCREENSHOT_WEBP_QUALITY);
});

// Generic MediaRecorder-based capture session, shared by gameplay-clip and audio-only export
// below. `buildStream` sets up tracks (or returns null after its own alert); `cleanup` tears them down.
function createCaptureRecorder({
  mimeCandidates, unsupportedMsg, noCodecMsg, buildStream, recorderOptions, filename, savedMsg,
  timerLabel, button, idleLabel, recordingLabel,
}) {
  let recorder = null, chunks = [], timerId = null, startedAt = 0;

  function updateTimer() {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const mm = pad2(Math.floor(secs / 60));
    const ss = pad2(secs % 60);
    captureInfo.textContent = timerLabel(mm, ss);
  }

  function start() {
    if (!window.MediaRecorder) { alert(unsupportedMsg); return; }
    const mimeType = mimeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
    if (!mimeType) { alert(noCodecMsg); return; }

    ensureAudioEngine(); // no-op if already set up; safe here since a click is a user gesture

    const built = buildStream(mimeType);
    if (!built) return; // buildStream already alerted on failure

    chunks = [];
    recorder = new MediaRecorder(built.stream, recorderOptions(mimeType));
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      built.cleanup();
      clearInterval(timerId);
      const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
      chunks = [];
      if (blob.size > 0) {
        downloadBlob(blob, filename(mimeType));
        captureInfo.textContent = savedMsg;
      } else {
        captureInfo.textContent = 'Recording produced no data.';
      }
    };

    recorder.start();
    startedAt = Date.now();
    updateTimer();
    timerId = setInterval(updateTimer, APP_CONFIG.RECORDING_TIMER_LABEL_INTERVAL_MS);
    button.textContent = recordingLabel;
    button.classList.add('recording');
  }

  function stop() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorder = null;
    button.textContent = idleLabel;
    button.classList.remove('recording');
  }

  button.addEventListener('click', () => {
    if (recorder && recorder.state !== 'inactive') stop();
    else start();
  });

  return { start, stop, isActive: () => !!(recorder && recorder.state !== 'inactive') };
}

/* ---- gameplay clip recording ---- */
const clipRecorderCtl = createCaptureRecorder({
  mimeCandidates: APP_CONFIG.VIDEO_MIME_CANDIDATES,
  unsupportedMsg: 'This browser does not support MediaRecorder, so gameplay clips cannot be recorded.',
  noCodecMsg: 'No supported WEBM video codec found in this browser.',
  buildStream: () => {
    const videoStream = canvas.captureStream(APP_CONFIG.VIDEO_CAPTURE_FPS);
    const tracks = [...videoStream.getVideoTracks()];
    let clipAudioDest = null;
    if (audioCtx && masterGain) {
      clipAudioDest = audioCtx.createMediaStreamDestination();
      masterGain.connect(clipAudioDest); // fans out alongside the existing speaker connection
      tracks.push(...clipAudioDest.stream.getAudioTracks());
    }
    return {
      stream: new MediaStream(tracks),
      cleanup: () => {
        if (clipAudioDest) { masterGain.disconnect(clipAudioDest); clipAudioDest = null; }
        videoStream.getTracks().forEach(t => t.stop());
      },
    };
  },
  recorderOptions: (mimeType) => ({
    mimeType,
    videoBitsPerSecond: APP_CONFIG.VIDEO_BITRATE_KBPS * 1000,
    audioBitsPerSecond: APP_CONFIG.CLIP_AUDIO_BITRATE_KBPS * 1000,
  }),
  filename: () => `${safeRomName()}_${Date.now()}.webm`,
  savedMsg: 'Clip saved ✓',
  timerLabel: (mm, ss) => `⏺ Recording... ${mm}:${ss}`,
  button: btnRecordClip,
  idleLabel: '⏺ Video',
  recordingLabel: '⏹ Video',
});

/* ---- audio-only export (Opus): taps the same masterGain node feeding the speakers, so
   mixed/muted channels are reflected automatically. Prefers Ogg/Opus, falls back to WebM/Opus. ---- */
function audioFileExtension(mimeType) {
  return mimeType.startsWith('audio/ogg') ? 'opus' : 'weba'; // WebM-container Opus audio; .weba avoids implying a video file
}

const audioRecorderCtl = createCaptureRecorder({
  unsupportedMsg: 'This browser does not support MediaRecorder, so audio cannot be exported.',
  noCodecMsg: 'No supported Opus audio codec found in this browser.',
  buildStream: () => {
    if (!audioCtx || !masterGain) { alert('Audio is not available in this browser.'); return null; }
    const audioDest = audioCtx.createMediaStreamDestination();
    masterGain.connect(audioDest); // fans out alongside the existing speaker connection
    return {
      stream: audioDest.stream,
      cleanup: () => { masterGain.disconnect(audioDest); },
    };
  },
  recorderOptions: (mimeType) => ({ mimeType, audioBitsPerSecond: APP_CONFIG.AUDIO_EXPORT_BITRATE_KBPS * 1000 }),
  filename: (mimeType) => `${safeRomName()}_${Date.now()}.${audioFileExtension(mimeType)}`,
  savedMsg: 'Audio saved ✓',
  timerLabel: (mm, ss) => `⏺ Recording audio... ${mm}:${ss}`,
  button: btnRecordAudio,
  idleLabel: '🎵 Audio',
  recordingLabel: '⏹ Audio',
});

/* ---- clear saved config: wipes every entry in STORAGE_KEYS plus all save-state slots,
   resetting to defaults on next load. ---- */
const btnClearConfig = document.getElementById('btnClearConfig');
btnClearConfig.addEventListener('click', () => {
  const ok = confirm('Clear all saved emulator config (model, play/debug mode, sound settings, RTC correction, saved cheats) AND all game save states? This cannot be undone.');
  if (!ok) return;
  try {
    Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    Object.keys(localStorage)
      .filter(k => k.startsWith(STORAGE_KEY_PREFIXES.SAVE_SLOTS))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* storage unavailable - nothing to clear */ }
  location.reload();
});
