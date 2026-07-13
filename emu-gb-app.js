/* =========================================================================================
   emu-gb-app.js — application wiring: ROM loading, playback controls, save states, capture
   -----------------------------------------------------------------------------------------
   Everything that isn't the emulation core itself (emu-gb-core.js) and isn't one of the
   debug/visualizer inspector panels (emu-gb-debug.js): the screen canvas + Emulator
   instance, ROM loading (including drag/drop and in-browser zip extraction), playback
   controls, rewind, step/breakpoint debugger controls, sound/speed controls, keyboard
   input, save-state slots, .sav (battery cart RAM) export/import, hotkeys, and the
   screenshot/gameplay-clip/audio capture tools.

   Depends on: emu-gb-core.js (Emulator, EMU_CORE_CONFIG, hex8/hex16/base64 helpers) must be
   loaded first. Several handlers here call into emu-gb-debug.js (refreshDebugTools(),
   buildBankingPanel(), etc.) - those are all deferred (inside event handlers/callbacks), so
   it's fine for this file to load *before* emu-gb-debug.js; nothing here calls a debug.js
   function immediately at the top level.

   Load order: emu-gb-core.js -> emu-gb-app.js -> emu-gb-debug.js (see index.html for why:
   emu-gb-debug.js's own top-level setup code reads UI config/constants this file defines).
   ========================================================================================= */

/* ======================================= UI wiring ======================================= */

/* ---- screen canvas + emulator instance ----
   `emulator` is deliberately `let`, not `const`: coreToggle below swaps it between a
   GBEmulator (original DMG core) and CGBEmulator (Game Boy Color core, emu-gbc-core.js)
   depending on which core the person has selected. Every other function in this file and
   in emu-gb-debug.js reads `emulator` (and `emulator.mmu`/`.cpu`/`.ppu`/etc) fresh each time
   it's called rather than caching a reference at load time, so the swap is transparent to
   the rest of the app - see ensureEmulatorMatchesCoreToggle() below. */
const canvas = document.getElementById('screen');
const coreToggle = document.getElementById('coreToggle'); // unchecked = GB core, checked = GBC core
let emulator = new GBEmulator(canvas);

// Swaps `emulator` to match the GB/GBC core toggle, if it doesn't already. Pauses (and lets
// go of) the old instance first so its rAF loop/audio context don't linger; callers that just
// loaded a ROM call emulator.start() again right after loadROM() runs.
function ensureEmulatorMatchesCoreToggle() {
  const NeededClass = coreToggle.checked ? CGBEmulator : GBEmulator;
  if (emulator instanceof NeededClass) return;
  emulator.pause();
  emulator = new NeededClass(canvas);
}

/* ---- ROM loading panel refs (file picker, drag-drop zone, ROM header info) ---- */
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const romInfo = document.getElementById('romInfo');
const checksumBadges = document.getElementById('checksumBadges');

/* ---- playback controls refs (start/pause/reset/rewind) ---- */
const btnPause = document.getElementById('btnPause');
const btnReset = document.getElementById('btnReset');
const btnRewind = document.getElementById('btnRewind');
const rewindInfo = document.getElementById('rewindInfo');

/* ---- play-time timer (badge on the same line as the "Load ROM" title) ----
   Tracks real wall-clock time the currently loaded ROM has spent actually running (i.e.
   while emulator.running is true) - time before a ROM is loaded, paused time, and
   debugger single-stepping don't count. Resets to 0 on every new ROM load and on Reset.
   Implemented as a poll (like updateRewindButton() below) rather than hooking every
   play/pause/step/rewind/breakpoint call site, so it stays correct no matter how playback
   was started or stopped, and survives the GB/GBC core swap transparently. */
const playTimeLabel = document.getElementById('playTime');
let playTimeSeconds = 0;
let playTimeLastTick = null; // performance.now() at the last tick emulator was running, or null if not running

function formatPlayTime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function resetPlayTime() {
  playTimeSeconds = 0;
  playTimeLastTick = emulator.running ? performance.now() : null;
  playTimeLabel.textContent = formatPlayTime(0);
}

function tickPlayTime() {
  const now = performance.now();
  if (emulator.running) {
    if (playTimeLastTick !== null) playTimeSeconds += (now - playTimeLastTick) / 1000;
    playTimeLastTick = now;
  } else {
    playTimeLastTick = null;
  }
  playTimeLabel.textContent = formatPlayTime(playTimeSeconds);
}
setInterval(tickPlayTime, 500);

/* ---- step/breakpoint debugging controls refs ---- */
const btnStep = document.getElementById('btnStep');
const btnStepLine = document.getElementById('btnStepLine');
const btnStepFrame = document.getElementById('btnStepFrame');
const btnStep1s = document.getElementById('btnStep1s');
const bpStatus = document.getElementById('bpStatus');

let lastROMBytes = null;

/* ---- app-level UI/feature configuration ----
   Constants for the UI and feature layer only - NOT emulator-core values (CPU cycle
   counts, PPU timing, hardware register bit widths, etc. stay as their real hardware
   numbers, defined right where they're used in the CPU/PPU/APU/MMU classes). Grouping
   these UI-layer numbers here means tweaking e.g. the volume step or how many save slots
   are kept doesn't mean hunting through the file for a raw number typed inline. */
const APP_CONFIG = {
  MAX_SAVE_SLOTS: 5,                  // save-state slots kept per ROM (oldest dropped first)
  VOLUME_MIN: 0,
  VOLUME_MAX: 100,
  VOLUME_STEP: 5,                     // volume slider/percentage only moves in steps this size
  VOLUME_DEFAULT: 50,
  TURBO_SPEED: 2,                     // emulation speed multiplier the T hotkey toggles to
  SCREENSHOT_WEBP_QUALITY: 0.80,      // canvas.toBlob() quality for the screenshot feature
  RECORDING_TIMER_LABEL_INTERVAL_MS: 500, // how often the video/audio recording timer label updates
  VIDEO_CAPTURE_FPS: 30,              // frame rate requested from canvas.captureStream() for clips
  // Codec preference order for gameplay clips: tried in order, first one the browser's
  // MediaRecorder actually supports wins. vp9 preferred over vp8 for better quality/size.
  VIDEO_MIME_CANDIDATES: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  // Codec preference order for standalone audio export: Ogg/Opus preferred (a "real"
  // standalone .opus file) over WebM/Opus (still Opus audio, just a different container).
  AUDIO_MIME_CANDIDATES: ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'],
  VIDEO_BITRATE_KBPS: 200,           // target bitrate for gameplay clip recording (video track)
  CLIP_AUDIO_BITRATE_KBPS: 32,       // target bitrate for the audio track inside a gameplay clip
  AUDIO_EXPORT_BITRATE_KBPS: 32,     // target bitrate for the standalone audio-only export
};

/* ---- localStorage-persisted config helper ----
   Small factory for the "load merged JSON from a key, save merged JSON back to it" pattern.
   Both the UI config (model/mode/etc., below) and the sound config (mute/volume/channel
   mutes, further down) are exactly this shape - this is the one place that pattern is
   written, so the next persisted setting just needs `makePersistedConfig('some:key')`. */
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
    } catch (e) { /* storage unavailable/full - ignore, settings just won't persist */ }
  }
  return { load, save };
}

/* ---- unified UI config: model (GB/GBP), play/debug mode, and "mark current line" all live
   together in one localStorage entry so they're restored together on next visit (sound
   mute/volume keep their own separate entry below, since they're wired up independently;
   emulation speed is deliberately NOT persisted here - it always starts back at 1x). */
const uiConfigStore = makePersistedConfig('jsgb-config:ui');
function loadUIConfig() { return uiConfigStore.load(); }
function saveUIConfig(partial) { uiConfigStore.save(partial); }

const savedUIConfig = loadUIConfig();

/* ---- GB/GBC core toggle: unchecked = GB (DMG) core (default), checked = GBC core. Forces
   which core every ROM loads into, overriding the cartridge header's own CGB flag. ---- */
const coreLabelGB = document.getElementById('coreLabelGB');
const coreLabelGBC = document.getElementById('coreLabelGBC');

function applyCoreToggle() {
  const wantGBC = coreToggle.checked;
  coreLabelGBC.classList.toggle('active', wantGBC);
  coreLabelGB.classList.toggle('active', !wantGBC);
  saveUIConfig({ gbcCore: wantGBC });
  if (lastROMBytes) loadROMBytes(lastROMBytes); // re-run the currently loaded ROM through the newly forced core
  else ensureEmulatorMatchesCoreToggle();
}

// Restore the saved core choice before the first render so the UI doesn't flash the default.
if (typeof savedUIConfig.gbcCore === 'boolean') coreToggle.checked = savedUIConfig.gbcCore;
applyCoreToggle();
coreToggle.addEventListener('change', applyCoreToggle);


function getROMTitle(bytes) {
  let title = '';
  for (let i = 0x134; i < 0x144; i++) {
    const c = bytes[i];
    if (c === 0) break;
    if (c >= 32 && c < 127) title += String.fromCharCode(c);
  }
  return title.trim() || 'Unknown';
}
// Every officially-assigned cartridge type byte (header offset 0x147), so unsupported
// mappers can still be identified by name in the UI instead of just showing a raw hex value.
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
// The mapper families this emulator actually implements bank-switching logic for.
// (0x0F-0x13 includes the MBC3 RTC support added above.)
function isCartTypeSupported(t) {
  return t === 0x00 || (t >= 0x01 && t <= 0x03) || t === 0x05 || t === 0x06 || (t >= 0x0F && t <= 0x13) || (t >= 0x19 && t <= 0x1E);
}
function getMBCName(bytes) {
  const t = bytes[0x147];
  return CART_TYPE_NAMES[t] || ('Unknown type 0x' + t.toString(16));
}
// Returns a short warning string when the cartridge uses a mapper this emulator doesn't
// actually implement (it silently falls back to MBC1-style banking, which will misbehave
// for anything with different bank-select widths, extra RAM chip behavior, rumble, an
// accelerometer, a camera sensor, etc.) Returns null for mappers that are fully supported.
function getMBCCompatibilityWarning(bytes) {
  const t = bytes[0x147];
  if (isCartTypeSupported(t)) return null;
  const name = CART_TYPE_NAMES[t] || ('unknown type 0x' + t.toString(16));
  return `This ROM uses ${name}, which isn't implemented. Falling back to MBC1-style banking - expect glitches, save data that doesn't stick, or a game that doesn't boot.`;
}
// Returns a mild informational note (not a warning) for mappers that are fully supported for
// banking/save purposes but have some real hardware feature this emulator doesn't reproduce -
// currently just the MBC5 rumble motor, which has no gameplay effect if it's simply silent.
function getMBCInfoNote(bytes) {
  const t = bytes[0x147];
  if (t >= 0x1C && t <= 0x1E) return "This cartridge's rumble motor isn't emulated (no vibration) - everything else works normally.";
  return null;
}

// Which cartridge types have battery-backed save RAM this emulator actually implements
// persistence for (i.e. the mappers with a real cartRAM read/write path - MBC1/2/3/5).
// MBC6/MBC7/MMM01/HuC1/HuC3/POCKET CAMERA carts also have batteries on real hardware, but
// this emulator doesn't implement those mappers, so there's no real save data to export.
function hasBatteryBackedRAM(bytes) {
  const t = bytes[0x147];
  return t === 0x03 || t === 0x06 || t === 0x0F || t === 0x10 || t === 0x13 || t === 0x1B || t === 0x1E;
}
// How many bytes of cart RAM this ROM's header declares (offset 0x149), in the standard .sav
// layout other emulators/hardware flash carts use. MBC2 is a fixed-size special case: its
// 512 built-in 4-bit nibbles are conventionally saved as 512 bytes, one nibble per byte.
function getCartRAMByteSize(bytes) {
  const t = bytes[0x147];
  if (t === 0x05 || t === 0x06) return 0x200;
  const RAM_SIZES = { 0x00: 0, 0x01: 0x800, 0x02: 0x2000, 0x03: 0x8000, 0x04: 0x20000, 0x05: 0x10000 };
  return RAM_SIZES[bytes[0x149]] || 0;
}

// The cartridge header's CGB flag (offset 0x143) tells us whether a ROM requires Game Boy
// Color hardware to run at all (0xC0), or merely takes advantage of it when present while
// staying playable on original DMG hardware (0x80). The GB/GBC core toggle overrides this and
// always forces one specific core, so these two helpers warn when that forced choice
// conflicts with the header, and otherwise just note which core is actually running the ROM.
function getGBCCompatibilityWarning(bytes) {
  const flag = bytes[0x143];
  if (flag === 0xC0 && !coreToggle.checked) {
    return 'Game Boy Color-only game forced onto the Game Boy core - it will likely fail to run correctly.';
  }
  return null;
}
function getGBCInfoNote(bytes) {
  const flag = bytes[0x143];
  const runningGBC = coreToggle.checked;
  if (flag === 0xC0) return runningGBC ? 'Game Boy Color-only game - running on the Game Boy Color core.' : null;
  if (flag === 0x80) {
    return runningGBC
      ? 'Game Boy Color-enhanced game - running on the Game Boy Color core for its full color palettes.'
      : 'Game Boy Color-enhanced game forced onto the Game Boy core - runs, but without its color palettes.';
  }
  return null;
}


// File-integrity checksums for the loaded ROM image, computed over the raw file bytes -
// the same values a ROM database (No-Intro, GoodTools, etc.) or a "verify my dump" tool
// would key off of. Distinct from the GB/GBC cartridge header's own internal checksum
// bytes; these are standard general-purpose hashes.

// CRC32 (ISO-HDLC / zlib polynomial 0xEDB88320), table-based.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// MD5 - compact standalone implementation (Web Crypto does not expose MD5).
function md5(bytes) {
  const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const msgLen = bytes.length;
  const bitLen = msgLen * 8;
  const padLen = ((msgLen % 64) < 56) ? (56 - (msgLen % 64)) : (120 - (msgLen % 64));
  const total = msgLen + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes, 0);
  buf[msgLen] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true);

  for (let chunkStart = 0; chunkStart < total; chunkStart += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(chunkStart + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const toHexLE = (n) => {
    n = n >>> 0;
    let hex = '';
    for (let i = 0; i < 4; i++) hex += ((n >>> (i * 8)) & 0xFF).toString(16).padStart(2, '0');
    return hex;
  };
  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Computes all four checksums for the loaded ROM. SHA-1/SHA-256 go through the browser's
// native Web Crypto implementation; CRC32 and MD5 aren't exposed there, so they're computed
// with the small implementations above.
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

// Renders the CRC32 / MD5 / SHA-1 / SHA-256 badges. Clicking a badge copies its full value
// to the clipboard (with brief "Copied!" feedback); hovering shows the full value as a
// native tooltip via the title attribute, since the badge itself only shows the algorithm name.
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
    el.addEventListener('click', () => {
      const value = el.dataset.value;
      navigator.clipboard.writeText(value).then(() => {
        const original = el.textContent;
        el.textContent = 'Copied!';
        el.classList.add('copied');
        setTimeout(() => { el.textContent = original; el.classList.remove('copied'); }, 1000);
      }).catch(() => { /* clipboard unavailable - silently ignore */ });
    });
  });
}

// Finishes loading a ROM once its raw bytes are in hand - shared by both the plain
// .gb/.gbc/.bin path and the zip-extraction path below, so neither has to duplicate the
// "wire it into the emulator and UI" bookkeeping.
async function loadROMBytes(bytes) {
  lastROMBytes = bytes;
  ensureEmulatorMatchesCoreToggle();
  emulator.loadROM(bytes);
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
  lastRenderedAccessSeq = -1;
  lastRenderedBankSwitchT = -1;
  buildBankingPanel();
  updateRtcTabAvailability(); // show/hide the RTC tab depending on whether this ROM is MBC3+TIMER
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
      ? 'Not applicable in Game Boy Color mode - colors come from the cartridge\'s own CGB palettes.'
      : '';
  }
  emulator.start();
  resetPlayTime();
}

/* ---- zipped ROM support ----
   Minimal, dependency-free ZIP reader: walks the central directory to find .gb/.gbc/.bin
   entries, then extracts the chosen one straight from its local file header. Stored (method
   0) entries are used as-is; deflated (method 8) entries go through the browser's built-in
   DecompressionStream, so no third-party unzip library is needed. Encrypted or zip64/multi-
   disk archives (rare for ROM zips) aren't supported. */
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
    btnPause.textContent = '▶ Resume';
    bpStatus.textContent = 'Paused.';
  } else {
    emulator.start();
    btnPause.textContent = '⏸ Pause';
    bpStatus.textContent = 'Running.';
  }
  refreshDebugTools();
});
// Shared by the Reset button and by .sav import below: reboots the emulator on the currently
// loaded ROM. loadROM() reinitializes CPU/PPU/banking/RTC state but deliberately does NOT touch
// cartRAM (it's allocated once and left alone across loads - see emu-gbc-core.js), so this is
// safe to call right after writing new bytes into cartRAM and will make the game actually pick
// them up, the same way power-cycling a real Game Boy would.
function resetEmulator(statusMsg) {
  if (!lastROMBytes) return;
  emulator.loadROM(lastROMBytes);
  lastRenderedAccessSeq = -1;
  lastRenderedBankSwitchT = -1;
  buildBankingPanel();
  updateRtcTabAvailability();
  emulator.start();
  btnPause.textContent = '⏸ Pause';
  bpStatus.textContent = statusMsg;
  updateRewindButton(); // a fresh run means any rewind history from before is gone too
  resetPlayTime();
}

btnReset.addEventListener('click', () => resetEmulator('Reset.'));

/* ---- rewind: in-memory-only, up to Emulator.REWIND_MAX_SNAPSHOTS deep, one snapshot every
   Emulator.REWIND_SNAPSHOT_INTERVAL_SECONDS of emulated time (see Emulator.rewind()) ---- */
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
    btnPause.textContent = '▶ Resume';
    bpStatus.textContent = `Rewound ${emulator.REWIND_SNAPSHOT_INTERVAL_SECONDS}s — PC=${hex16(emulator.cpu.PC)}`;
    refreshDebugTools();
  }
  updateRewindButton();
});

/* ---- step / breakpoint debugger ---- */
emulator.onBreakpointHit = (reason) => {
  btnPause.textContent = '▶ Resume';
  bpStatus.textContent = `⏹ Stopped — ${reason}`;
  refreshDebugTools();
};

btnStep.addEventListener('click', () => {
  emulator.stepOne();
  btnPause.textContent = '▶ Resume';
  bpStatus.textContent = `Stepped — now at PC=${hex16(emulator.cpu.PC)}`;
  refreshDebugTools();
});

btnStepLine.addEventListener('click', () => {
  emulator.stepLine();
  btnPause.textContent = '▶ Resume';
  bpStatus.textContent = `Stepped to line LY=${emulator.ppu.ly} — PC=${hex16(emulator.cpu.PC)}`;
  refreshDebugTools();
});

btnStepFrame.addEventListener('click', () => {
  emulator.stepFrame();
  btnPause.textContent = '▶ Resume';
  bpStatus.textContent = `Stepped one frame — PC=${hex16(emulator.cpu.PC)}`;
  refreshDebugTools();
});

btnStep1s.addEventListener('click', () => {
  emulator.stepOneSecond();
  btnPause.textContent = '▶ Resume';
  bpStatus.textContent = `Stepped 1s (60 frames) — PC=${hex16(emulator.cpu.PC)}`;
  selectedFrameStatsIndex = null; // let Frame Activity follow the 60 frames just stepped
  refreshDebugTools();
});

/* ---- sound controls ---- */
/* Mute state + volume level are persisted in localStorage so they're restored on the next visit
   (same pattern as the play/debug mode toggle above, via the shared makePersistedConfig() helper). */
const soundConfigStore = makePersistedConfig('jsgb-config:sound');
function saveSoundConfig() {
  soundConfigStore.save({ muted: isMuted, volume: Number(soundControls.volumeSlider.value), channelMuted: emulator.apu.chMuted });
}
function loadSoundConfig() { return soundConfigStore.load(); }

// DOM refs for this panel grouped together so it's obvious at a glance what the sound
// controls touch (and safe to find/delete as a unit).
const soundControls = {
  btnMute: document.getElementById('btnMute'),
  volumeSlider: document.getElementById('volumeSlider'),
  volumeLabel: document.getElementById('volumeLabel'),
};

soundControls.volumeSlider.min = APP_CONFIG.VOLUME_MIN;
soundControls.volumeSlider.max = APP_CONFIG.VOLUME_MAX;
soundControls.volumeSlider.step = APP_CONFIG.VOLUME_STEP;
soundControls.volumeSlider.value = APP_CONFIG.VOLUME_DEFAULT;

// Snaps a percentage onto the configured step, so the slider and label stay in sync
// with what dragging/arrow-keys can actually produce.
function snapToVolumeStep(pct) {
  return Math.round(pct / APP_CONFIG.VOLUME_STEP) * APP_CONFIG.VOLUME_STEP;
}

const savedSoundConfig = loadSoundConfig();
if (savedSoundConfig && typeof savedSoundConfig.volume === 'number') soundControls.volumeSlider.value = snapToVolumeStep(savedSoundConfig.volume);
let isMuted = !!(savedSoundConfig && savedSoundConfig.muted);

emulator.apu.setVolume(soundControls.volumeSlider.value / APP_CONFIG.VOLUME_MAX);
emulator.apu.setMuted(isMuted);
soundControls.btnMute.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
soundControls.volumeLabel.textContent = soundControls.volumeSlider.value + '%';

soundControls.btnMute.addEventListener('click', () => {
  isMuted = !isMuted;
  emulator.apu.setMuted(isMuted);
  soundControls.btnMute.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
  saveSoundConfig();
});
soundControls.volumeSlider.addEventListener('input', () => {
  emulator.apu.setVolume(soundControls.volumeSlider.value / APP_CONFIG.VOLUME_MAX);
  soundControls.volumeLabel.textContent = soundControls.volumeSlider.value + '%';
  saveSoundConfig();
});

/* ---- speed control: preset badges (x0.25 - 4x) set the emulation speed multiplier ----
   Deliberately NOT persisted - always starts at 1x on load/refresh, regardless of what
   speed was last used, so a forgotten turbo/slowdown setting never carries over silently. */
const speedBadges = [...document.querySelectorAll('.speed-badge')];

function setSpeed(value) {
  emulator.speed = value;
  speedBadges.forEach(b => b.classList.toggle('active', Number(b.dataset.speed) === value));
}

setSpeed(1);

speedBadges.forEach(badge => {
  badge.addEventListener('click', () => setSpeed(Number(badge.dataset.speed)));
});

/* ---- turbo hotkey: T toggles between 1x and 2x speed ----
   Goes through the same setSpeed() the speed badges use, so the 2x badge lights up while
   turbo is on. Not persisted, same as the speed badges above. Skipped while a text
   input/textarea has focus (e.g. the breakpoint PC field) so typing the letter T doesn't
   accidentally toggle emulation speed. */
window.addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  setSpeed(emulator.speed === APP_CONFIG.TURBO_SPEED ? 1 : APP_CONFIG.TURBO_SPEED);
});

/* ---- keyboard input ---- */
const KEY_MAP = {
  ArrowRight: [0, true], ArrowLeft: [1, true], ArrowUp: [2, true], ArrowDown: [3, true],
  z: [0, false], Z: [0, false],  // A
  x: [1, false], X: [1, false],  // B
  Shift: [2, false],             // Select
  Enter: [3, false],             // Start
};
window.addEventListener('keydown', (e) => { const m = KEY_MAP[e.key]; if (m) { emulator.joypad.setButton(m[0], true, m[1]); e.preventDefault(); } });
window.addEventListener('keyup', (e) => { const m = KEY_MAP[e.key]; if (m) { emulator.joypad.setButton(m[0], false, m[1]); e.preventDefault(); } });


/* ================================== Save / load states ===================================
   States are kept as a list of up to MAX_SLOTS snapshots per ROM (most recent first) in
   localStorage, each holding a full emulator.getSaveState() snapshot - including the PPU
   framebuffer, which doubles as the thumbnail image shown in the sidebar, so no separate
   screenshot needs to be captured or stored.
     - [ / "Save" button  -> quick-saves a new slot (oldest is dropped once at the limit)
     - ] / "Load" button  -> quick-loads the most recent slot
     - clicking a sidebar card -> loads that specific slot
     - Export/Import .json -> moves a single snapshot in or out as a downloadable file
   ========================================================================================= */

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

function slotsKey() { return 'jsgb-saveslots:' + (emulator.romTitle || 'rom'); }

function loadSlots() {
  try { return JSON.parse(localStorage.getItem(slotsKey())) || []; }
  catch { return []; }
}

// Writes the slot list back to localStorage, dropping the oldest slot(s) and retrying if
// the browser's storage quota is exceeded (e.g. from other sites' data sharing the origin).
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
  const hasROM = emulator.mmu.rom && emulator.mmu.rom.length > 0;
  btnSaveState.disabled = !hasROM;
  btnExportState.disabled = !hasROM;
  btnImportStateLabel.classList.toggle('disabled', !hasROM);
  btnScreenshot.disabled = !hasROM;
  // Don't yank the record button out from under an in-progress recording.
  if (!(clipRecorder && clipRecorder.state !== 'inactive')) btnRecordClip.disabled = !hasROM;
  if (!(audioRecorder && audioRecorder.state !== 'inactive')) btnRecordAudio.disabled = !hasROM;
  document.querySelectorAll('.layer-download-btn').forEach(btn => { btn.disabled = !hasROM; });

  // The .sav (battery cart RAM) controls only make sense for carts that actually have
  // battery-backed save RAM this emulator persists (see hasBatteryBackedRAM) - e.g. it stays
  // disabled for ROM-only carts or unsupported/unimplemented mappers, even once a ROM is loaded.
  const hasSaveRAM = hasROM && lastROMBytes && hasBatteryBackedRAM(lastROMBytes);
  btnDownloadSav.disabled = !hasSaveRAM;
  btnImportSavLabel.classList.toggle('disabled', !hasSaveRAM);

  const slots = hasROM ? loadSlots() : [];
  btnLoadState.disabled = slots.length === 0;
  btnDeleteAllStates.disabled = slots.length === 0;
  slotCountBadge.textContent = slots.length + '/' + MAX_SLOTS;

  renderSlotList(slots);
}

// Decodes a slot's stored (base64) PPU framebuffer straight into its thumbnail canvas -
// the same raw pixels the screen itself was showing at save time.
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

// Applies a save-state object to the running emulator, pausing/resuming around it so a
// partially-stepped frame never gets mixed with the restored state.
function applyLoadedState(state) {
  const wasRunning = emulator.running;
  emulator.pause();
  emulator.loadSaveState(state);
  emulator.draw();        // repaint immediately from the restored framebuffer
  updateRtcTabAvailability();
  refreshDebugTools();
  if (wasRunning) emulator.start();
}

function quickSaveState() {
  if (!(emulator.mmu.rom && emulator.mmu.rom.length)) return;
  const slots = loadSlots();
  slots.unshift({ id: 'slot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                  savedAt: new Date().toISOString(), state: emulator.getSaveState() });
  while (slots.length > MAX_SLOTS) slots.pop();
  try {
    const saved = writeSlots(slots);
    updateStateButtons();
    stateInfo.textContent = `State saved ✓ (${saved.length}/${MAX_SLOTS})`;
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

// Wipes every saved slot for the currently loaded ROM after a confirmation prompt,
// since this can't be undone.
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
    const url = URL.createObjectURL(blob);
    const safeName = (emulator.romTitle || 'rom').replace(/[^a-z0-9_-]+/gi, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.savestate.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
      slots.unshift({ id: 'slot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
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

/* ---- .sav export/import: battery-backed cart RAM only ----
   Deliberately separate from the save-state system above. Save states snapshot the whole
   emulator (CPU/PPU/APU/RAM/banking registers, everything) so you can resume mid-frame;
   a .sav is just the cartridge's battery-backed RAM, in the plain flat-binary layout other
   emulators and real flash carts use for Pokemon/SML2/etc-style in-game saves - so a file
   exported here can be loaded into another emulator (or vice versa), which a .json save
   state can't do. */
btnDownloadSav.addEventListener('click', () => {
  if (!lastROMBytes || !hasBatteryBackedRAM(lastROMBytes)) return;
  const size = getCartRAMByteSize(lastROMBytes);
  if (size === 0) { alert('This cartridge has no save RAM to export.'); return; }
  const data = emulator.mmu.cartRAM.slice(0, size);
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
    const mmu = emulator.mmu;
    const n = Math.min(bytes.length, mmu.cartRAM.length, expectedSize || bytes.length);
    mmu.cartRAM.set(bytes.subarray(0, n));
    // Writing straight into cartRAM only updates the underlying "battery" - it doesn't make an
    // already-running game notice, same as swapping a cartridge's battery contents mid-session
    // on real hardware wouldn't. The game only re-reads its save data at boot (title screen,
    // "Continue" check, etc.), so without a reset here the import would silently appear to do
    // nothing even though the bytes did land - which is exactly the "saves fine, won't load
    // back" symptom this fixes.
    resetEmulator('Save file loaded, game reset to apply it.');
    savInfo.textContent = 'Save file loaded ✓ (game reset to apply it)';
  };
  reader.onerror = () => { alert('Could not read that file.'); };
  reader.readAsArrayBuffer(file);
});

/* ---- hotkeys: [ quick-save, ] quick-load ----
   F5/F9 are avoided since they're reserved for page refresh / browser dev tools in most
   browsers; [ and ] are free, easy to reach, and read naturally as "save / load". */
window.addEventListener('keydown', (e) => {
  if (e.key === '[') {
    e.preventDefault();
    if (!btnSaveState.disabled) quickSaveState();
  } else if (e.key === ']') {
    e.preventDefault();
    if (!btnLoadState.disabled) quickLoadState();
  }
});

/* ---- media capture: single-frame WEBP screenshots, WEBM gameplay clips (video+audio), and
   standalone Opus audio export - all via browser-native encoding (canvas.toBlob /
   MediaRecorder), no extra libraries. ---- */
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

/* ---- gameplay clip recording ----
   canvas.captureStream() gives a live video track straight from the screen canvas; the APU's
   masterGain node (already feeding the speakers) is additionally tapped into a
   MediaStreamAudioDestinationNode so the recording gets sound too. MediaRecorder then encodes
   both together as WEBM in real time - no re-encoding step, no bundled codec library. */
let clipRecorder = null;
let clipChunks = [];
let clipAudioDest = null;
let clipTimerId = null;
let clipStartedAt = 0;

function pickClipMimeType() {
  return APP_CONFIG.VIDEO_MIME_CANDIDATES.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function updateClipTimer() {
  const secs = Math.floor((Date.now() - clipStartedAt) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  captureInfo.textContent = `⏺ Recording... ${mm}:${ss}`;
}

function startClipRecording() {
  if (!window.MediaRecorder) { alert('This browser does not support MediaRecorder, so gameplay clips cannot be recorded.'); return; }
  const mimeType = pickClipMimeType();
  if (!mimeType) { alert('No supported WEBM video codec found in this browser.'); return; }

  emulator.apu.initAudio(); // no-op if already set up; safe here since a click is a user gesture

  const videoStream = canvas.captureStream(APP_CONFIG.VIDEO_CAPTURE_FPS);
  const tracks = [...videoStream.getVideoTracks()];
  if (emulator.apu.audioCtx && emulator.apu.masterGain) {
    clipAudioDest = emulator.apu.audioCtx.createMediaStreamDestination();
    emulator.apu.masterGain.connect(clipAudioDest); // fans out alongside the existing speaker connection
    tracks.push(...clipAudioDest.stream.getAudioTracks());
  }

  clipChunks = [];
  clipRecorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType,
    videoBitsPerSecond: APP_CONFIG.VIDEO_BITRATE_KBPS * 1000,
    audioBitsPerSecond: APP_CONFIG.CLIP_AUDIO_BITRATE_KBPS * 1000,
  });
  clipRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) clipChunks.push(e.data); };
  clipRecorder.onstop = () => {
    if (clipAudioDest) { emulator.apu.masterGain.disconnect(clipAudioDest); clipAudioDest = null; }
    videoStream.getTracks().forEach(t => t.stop());
    clearInterval(clipTimerId);
    const blob = new Blob(clipChunks, { type: mimeType.split(';')[0] });
    clipChunks = [];
    if (blob.size > 0) {
      downloadBlob(blob, `${safeRomName()}_${Date.now()}.webm`);
      captureInfo.textContent = 'Clip saved ✓';
    } else {
      captureInfo.textContent = 'Recording produced no data.';
    }
  };

  clipRecorder.start();
  clipStartedAt = Date.now();
  updateClipTimer();
  clipTimerId = setInterval(updateClipTimer, APP_CONFIG.RECORDING_TIMER_LABEL_INTERVAL_MS);
  btnRecordClip.textContent = '⏹ Video';
  btnRecordClip.classList.add('recording');
}

function stopClipRecording() {
  if (clipRecorder && clipRecorder.state !== 'inactive') clipRecorder.stop();
  clipRecorder = null;
  btnRecordClip.textContent = '⏺ Video';
  btnRecordClip.classList.remove('recording');
}

btnRecordClip.addEventListener('click', () => {
  if (clipRecorder && clipRecorder.state !== 'inactive') stopClipRecording();
  else startClipRecording();
});

/* ---- audio-only export (Opus) ----
   Taps the exact same masterGain node that feeds the speakers and the gameplay-clip
   recorder above - the APU already zeroes out a channel's contribution to masterGain the
   moment it's muted (master Mute button or a per-channel CH1-4 mute in the Oscilloscope
   panel, see APU.mixSample), so the exported audio automatically reflects whatever is
   actually mixed in right now. Nothing extra to filter here. MediaRecorder is asked for an
   Opus codec explicitly; Ogg/Opus is preferred when the browser supports it since it's a
   "real" standalone .opus file, falling back to WebM/Opus (still Opus audio, just a
   different container) otherwise. */
let audioRecorder = null;
let audioChunks = [];
let audioDest = null;
let audioTimerId = null;
let audioStartedAt = 0;

function pickAudioMimeType() {
  return APP_CONFIG.AUDIO_MIME_CANDIDATES.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function audioFileExtension(mimeType) {
  return mimeType.startsWith('audio/ogg') ? 'opus' : 'weba'; // WebM-container Opus audio; .weba avoids implying a video file
}

function updateAudioTimer() {
  const secs = Math.floor((Date.now() - audioStartedAt) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  captureInfo.textContent = `⏺ Recording audio... ${mm}:${ss}`;
}

function startAudioRecording() {
  if (!window.MediaRecorder) { alert('This browser does not support MediaRecorder, so audio cannot be exported.'); return; }
  const mimeType = pickAudioMimeType();
  if (!mimeType) { alert('No supported Opus audio codec found in this browser.'); return; }

  emulator.apu.initAudio(); // no-op if already set up; safe here since a click is a user gesture
  if (!emulator.apu.audioCtx || !emulator.apu.masterGain) { alert('Audio is not available in this browser.'); return; }

  audioDest = emulator.apu.audioCtx.createMediaStreamDestination();
  emulator.apu.masterGain.connect(audioDest); // fans out alongside the existing speaker connection

  audioChunks = [];
  audioRecorder = new MediaRecorder(audioDest.stream, {
    mimeType,
    audioBitsPerSecond: APP_CONFIG.AUDIO_EXPORT_BITRATE_KBPS * 1000,
  });
  audioRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
  audioRecorder.onstop = () => {
    emulator.apu.masterGain.disconnect(audioDest);
    audioDest = null;
    clearInterval(audioTimerId);
    const blob = new Blob(audioChunks, { type: mimeType.split(';')[0] });
    audioChunks = [];
    if (blob.size > 0) {
      downloadBlob(blob, `${safeRomName()}_${Date.now()}.${audioFileExtension(mimeType)}`);
      captureInfo.textContent = 'Audio saved ✓';
    } else {
      captureInfo.textContent = 'Recording produced no data.';
    }
  };

  audioRecorder.start();
  audioStartedAt = Date.now();
  updateAudioTimer();
  audioTimerId = setInterval(updateAudioTimer, APP_CONFIG.RECORDING_TIMER_LABEL_INTERVAL_MS);
  btnRecordAudio.textContent = '⏹ Audio';
  btnRecordAudio.classList.add('recording');
}

function stopAudioRecording() {
  if (audioRecorder && audioRecorder.state !== 'inactive') audioRecorder.stop();
  audioRecorder = null;
  btnRecordAudio.textContent = '🎵 Audio';
  btnRecordAudio.classList.remove('recording');
}

btnRecordAudio.addEventListener('click', () => {
  if (audioRecorder && audioRecorder.state !== 'inactive') stopAudioRecording();
  else startAudioRecording();
});

/* ---- clear saved config: wipes the persisted UI config (model/mode/mark-line), sound config
   (mute/volume/channel mutes), and every game's save-state slots (jsgb-saveslots:<rom>) from
   localStorage, so the app falls back to its defaults next load with a clean slate. Save slots
   are keyed per-ROM title, so they're found by scanning all localStorage keys for the prefix
   rather than a single fixed key. */
const btnClearConfig = document.getElementById('btnClearConfig');
btnClearConfig.addEventListener('click', () => {
  const ok = confirm('Clear all saved emulator config (model, play/debug mode, sound settings) AND all game save states? This cannot be undone.');
  if (!ok) return;
  try {
    localStorage.removeItem('jsgb-config:ui');
    localStorage.removeItem('jsgb-config:sound');
    Object.keys(localStorage)
      .filter(k => k.startsWith('jsgb-saveslots:'))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* storage unavailable - nothing to clear */ }
  location.reload();
});
