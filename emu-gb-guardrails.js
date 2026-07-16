/* =========================================================================================
   emu-gb-guardrails.js — Educational-use guardrails
   -----------------------------------------------------------------------------------------
   Keeps this an emulator-debugging/teaching tool rather than a way to just play games, all
   gated behind one master switch (GUARDRAIL_CONFIG.ENABLED):

   - Dev-unlock override: a hidden localStorage flag (plus a navbar click-combo in
     emu-gb-debug-core.js) that lets a developer bypass both guardrails below.
   - Play-time cap: the badge next to "Load ROM" colors amber/red, warns, and eventually
     auto-reloads the page after a set amount of continuous runtime.
   - Commercial-ROM filter: blocks ROMs matching a prebuilt No-Intro bloom filter, so only
     homebrew/non-commercial ROMs load. Both GB and GBC filters are checked regardless of core.

   Load order: after filters/game-filter-data.js and the crc-32 library; before emu-gb-app.js
   and emu-gb-debug-core.js.
   ========================================================================================= */

const GUARDRAIL_CONFIG = {
  ENABLED: true,             // master switch: gates both the play-time cap and the commercial-ROM filter
  PLAY_TIME_BASE_UNIT: 60,   // seconds per unit; set to 1 for fast manual testing
  PLAY_TIME_UNITS_TOTAL: 20, // hard cap, in units of PLAY_TIME_BASE_UNIT
};

/* Hidden dev/debug override: lets a developer bypass the guardrails below without exposing
   this in the UI. Enable/disable via enableEmuDevUnlock()/disableEmuDevUnlock() in the console. */
const DEV_UNLOCK_KEY = 'emuDevUnlock';
const DEV_UNLOCK_VALUE = 'you shall not pass!';
function isDevUnlocked() {
  try {
    return localStorage.getItem(DEV_UNLOCK_KEY) === DEV_UNLOCK_VALUE;
  } catch {
    return false; // localStorage blocked - fail safe, guardrails stay on
  }
}
// Console-only helpers for toggling the dev unlock; require a reload to take effect.
function enableEmuDevUnlock() {
  try {
    localStorage.setItem(DEV_UNLOCK_KEY, DEV_UNLOCK_VALUE);
    console.log('You are a wizard. Dev unlock enabled. Reload the page for it to take effect.');
  } catch (err) {
    console.warn('Could not enable dev unlock:', err.message);
  }
}
function disableEmuDevUnlock() {
  try {
    localStorage.removeItem(DEV_UNLOCK_KEY);
    console.log('You put away your wand. Dev unlock disabled. Reload the page for it to take effect.');
  } catch (err) {
    console.warn('Could not disable dev unlock:', err.message);
  }
}

function isEduGuardrailEnabled() {
  return isDevUnlocked() ? false : GUARDRAIL_CONFIG.ENABLED;
}

/* ---- play-time limit: caps continuous emulator runtime so this stays a debugging tool
   rather than a way to play through games. Thresholds are fractions of TOTAL_LIMIT. ---- */
const PLAY_TIME_LIMIT = isEduGuardrailEnabled(); // master switch
const PLAY_TIME_TOTAL_LIMIT = GUARDRAIL_CONFIG.PLAY_TIME_UNITS_TOTAL * GUARDRAIL_CONFIG.PLAY_TIME_BASE_UNIT; // hard cap
const PLAY_TIME_LIMIT_CONFIG = {
  TOTAL_LIMIT: PLAY_TIME_TOTAL_LIMIT,          // page reloads automatically once reached
  AMBER_AT: 0.5 * PLAY_TIME_TOTAL_LIMIT,       // badge switches green -> amber
  RED_AT: 0.8 * PLAY_TIME_TOTAL_LIMIT,         // badge switches amber -> red
  WARNING_ALERT: 0.8 * PLAY_TIME_TOTAL_LIMIT,  // one-time alert() threshold
};

// Play-time timer (badge next to "Load ROM"): wall-clock time the current ROM has been
// running, polled so it stays correct regardless of how playback was started/stopped.
const playTimeLabel = document.getElementById('playTime');
let playTimeSeconds = 0;
let playTimeLastTick = null; // performance.now() at last tick while running, else null
let playTimeWarningShown = false; // fires the WARNING_ALERT alert() only once per run
let playTimeLimitReached = false; // guards location.reload() to fire only once

function formatPlayTime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
}

function resetPlayTime() {
  playTimeSeconds = 0;
  playTimeLastTick = emulator.running ? performance.now() : null;
  playTimeWarningShown = false;
  playTimeLimitReached = false;
  playTimeLabel.textContent = formatPlayTime(0);
  playTimeLabel.classList.remove('playtime-green', 'playtime-amber', 'playtime-red');
}

function tickPlayTime() {
  // Timer always runs; PLAY_TIME_LIMIT only gates enforcement (coloring/alert/reload).
  const now = performance.now();
  if (emulator.running) {
    if (playTimeLastTick !== null) playTimeSeconds += (now - playTimeLastTick) / 1000;
    playTimeLastTick = now;
  } else {
    playTimeLastTick = null;
  }
  playTimeLabel.textContent = formatPlayTime(playTimeSeconds);

  if (!PLAY_TIME_LIMIT) return;

  const { TOTAL_LIMIT, AMBER_AT, RED_AT, WARNING_ALERT } = PLAY_TIME_LIMIT_CONFIG;

  playTimeLabel.classList.toggle('playtime-red', playTimeSeconds >= RED_AT);
  playTimeLabel.classList.toggle('playtime-amber', playTimeSeconds >= AMBER_AT && playTimeSeconds < RED_AT);
  playTimeLabel.classList.toggle('playtime-green', playTimeSeconds < AMBER_AT);

  if (!playTimeWarningShown && playTimeSeconds >= WARNING_ALERT) {
    playTimeWarningShown = true;
    alert(`This emulator is for educational purposes and isn't intended for playing games. ` +
          `This session has been running for ${formatPlayTime(WARNING_ALERT)}. ` +
          `It'll auto-reload at ${formatPlayTime(TOTAL_LIMIT)} of continuous use.`);
  }

  if (!playTimeLimitReached && playTimeSeconds >= TOTAL_LIMIT) {
    playTimeLimitReached = true;
    location.reload();
  }
}
setInterval(tickPlayTime, 500);

/* ---- commercial-ROM filter: blocks ROMs matching a prebuilt No-Intro bloom filter, keeping
   this limited to homebrew/non-commercial ROMs. Both GB and GBC filters are checked regardless of core. ---- */

// Bloom filter used to exclude commercial games.
class BloomFilter {
    constructor(arrayBuffer) {
        // Header: 4-byte bit-array size (m) + 1-byte hash count (k), then the bit array.
        const dataView = new DataView(arrayBuffer, 0, 5);
        this.m = dataView.getUint32(0, true);
        this.k = dataView.getUint8(4);

        this.bitArray = new Uint8Array(arrayBuffer, 5);

        console.log(`Configured from header -> Bits (m): ${this.m}, Hashes (k): ${this.k}`);
    }

    _hash(item, i) {
        const salted = `${i}:${item.toLowerCase()}`;
        let hash = 0x811c9dc5;
        for (let j = 0; j < salted.length; j++) {
            hash ^= salted.charCodeAt(j);
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        return Math.abs(hash) % this.m;
    }

    isCommercial(crc32) {
        for (let i = 0; i < this.k; i++) {
            const bitPosition = this._hash(crc32, i);
            const byteIndex = Math.floor(bitPosition / 8);
            const bitIndex = bitPosition % 8;

            if ((this.bitArray[byteIndex] & (1 << bitIndex)) === 0) {
                return false; 
            }
        }
        return true; 
    }
}

const GAME_FILTER_ENABLED = isEduGuardrailEnabled(); // master switch

let commercialRomFilters = { gb: null, gbc: null }; // each becomes a BloomFilter instance once decoded; stays null if disabled, missing, or unparsable

function loadCommercialRomFilter(coreKey) {
  try {
    const b64 = window.GAME_FILTER_DATA && window.GAME_FILTER_DATA[coreKey];
    if (!b64) throw new Error('no data for this core in GAME_FILTER_DATA - is filters/game-filter-data.js included in index.html before this file?');
    const buf = base64ToU8(b64).buffer;
    commercialRomFilters[coreKey] = new BloomFilter(buf);
    console.log(`Commercial-ROM filter (${coreKey.toUpperCase()}) loaded (${(buf.byteLength / 1024).toFixed(1)} KB, m=${commercialRomFilters[coreKey].m}, k=${commercialRomFilters[coreKey].k}).`);
  } catch (err) {
    console.warn(`Commercial-ROM filter (${coreKey.toUpperCase()}) not loaded (${err.message}) - commercial-ROM check is disabled for ${coreKey.toUpperCase()} ROMs this session.`);
  }
}
if (GAME_FILTER_ENABLED) {
  loadCommercialRomFilter('gb');
  loadCommercialRomFilter('gbc');
}

// Checks `bytes` against both GB/GBC filters. Called before touching any loaded-ROM state,
// and returns the CRC32 too so the caller can show it in its "blocked" message.
function checkCommercialRomGate(bytes) {
  const crc32Hex = crc32(bytes).toString(16).toUpperCase().padStart(8, '0');
  const blocked = (commercialRomFilters.gb && commercialRomFilters.gb.isCommercial(crc32Hex))
    || (commercialRomFilters.gbc && commercialRomFilters.gbc.isCommercial(crc32Hex));
  return { blocked, crc32: crc32Hex };
}
