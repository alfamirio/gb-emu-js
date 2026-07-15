/* =========================================================================================
   emu-gb-debug.js — Debugging & Visualization Tools
   -----------------------------------------------------------------------------------------
   Manages all inspector and visualization panels.

   - Editable CPU registers/flags panel (writes directly to CPU state while paused).
   - Graphics viewers (VRAM tiles, tile maps, layers, sprites, palettes).
   - Audio/System metrics (oscilloscope, scanline timeline, execution trace, stack/interrupts).
   - UI controls (disassembler, tab switching, display toggles, refresh orchestration).

   Load order: emu-gb-core.js (core logic/types) -> emu-gb-app.js (UI config, app state, core
   DOM refs) -> emu-gb-debug.js (loads last; runs init code that depends on both).
   ========================================================================================= */

/* ---- shared: copy an address to the clipboard and briefly flash it in a tooltip/element.
   Used by the Sprite Sheet and Sprites (OAM) tabs when a cell is clicked. ---- */
function flashCopiedTooltip(tooltipEl, addrText) {
  navigator.clipboard.writeText(addrText).then(() => {
    clearTimeout(tooltipEl._copiedTimeout);
    tooltipEl.textContent = `Copied ${addrText}!`;
    tooltipEl.classList.add('copied');
    tooltipEl.style.display = 'block';
    tooltipEl._copiedTimeout = setTimeout(() => tooltipEl.classList.remove('copied'), 700);
  }).catch(() => { /* clipboard unavailable - silently ignore */ });
}

function flashCopiedRow(rowEl, addrText) {
  navigator.clipboard.writeText(addrText).then(() => {
    clearTimeout(rowEl._copiedTimeout);
    rowEl.classList.add('row-copied');
    rowEl._copiedTimeout = setTimeout(() => rowEl.classList.remove('row-copied'), 700);
  }).catch(() => { /* clipboard unavailable - silently ignore */ });
}

// Copies `text` and swaps el's own displayed text to "Copied!" briefly. Sets dataset.copied
// while flashing so a caller that periodically repaints el's textContent (e.g. a live-refreshing
// panel) can skip that repaint and avoid stomping on the flash. Used by the Inspector tab's
// clickable address-range and byte-values readouts.
function flashCopiedInline(el, text) {
  navigator.clipboard.writeText(text).then(() => {
    clearTimeout(el._copiedTimeout);
    el.dataset.copied = '1';
    el.textContent = 'Copied!';
    el.classList.add('copied');
    el._copiedTimeout = setTimeout(() => {
      delete el.dataset.copied;
      el.classList.remove('copied');
    }, 700);
  }).catch(() => { /* clipboard unavailable - silently ignore */ });
}

/* ---- 0. CPU registers editor refs ---- */
const regPausedNote = document.getElementById('regPausedNote');
const regIoReadout = document.getElementById('regIoReadout');
// 8-bit (A B C D E H L) + 16-bit (SP PC) registers, each { el, key, bits }
const REG_INPUTS = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'SP', 'PC'].map(key => {
  const el = document.getElementById('reg' + key);
  return { el, key, bits: (key === 'SP' || key === 'PC') ? 16 : 8 };
});
// Flags + CPU state toggles, paired with the CPU boolean field they read/write
const REG_FLAGS = [
  { el: document.getElementById('regFlagZ'), key: 'flagZ' },
  { el: document.getElementById('regFlagN'), key: 'flagN' },
  { el: document.getElementById('regFlagH'), key: 'flagH' },
  { el: document.getElementById('regFlagC'), key: 'flagC' },
  { el: document.getElementById('regIME'), key: 'IME' },
  { el: document.getElementById('regHalted'), key: 'halted' },
];
const REG_DERIVED = {
  BC: document.querySelector('[data-derived="BC"]'),
  DE: document.querySelector('[data-derived="DE"]'),
  HL: document.querySelector('[data-derived="HL"]'),
};

/* ---- 1. VRAM tile viewer refs ---- */
const tileViewerCanvas = document.getElementById('tileViewerCanvas');
const tileViewerCtx = tileViewerCanvas.getContext('2d');
// Grid: 16 cols x 24 rows, 1px gap between cells. Each GB pixel is a TV_SCALE x TV_SCALE block.
const TV_COLS = 16, TV_ROWS = 24, TV_SCALE = 3, TV_CELL = 8 * TV_SCALE, TV_GAP = 1;
const TV_PITCH = TV_CELL + TV_GAP;
const TV_W = TV_COLS * TV_PITCH + TV_GAP;  // 401
const TV_H = TV_ROWS * TV_PITCH + TV_GAP;  // 601
tileViewerCanvas.width = TV_W;
tileViewerCanvas.height = TV_H;
const tileViewerImageData = tileViewerCtx.createImageData(TV_W, TV_H);
const tileViewerWrap = document.getElementById('tileViewerWrap');
const tileViewerHover = document.getElementById('tileViewerHover');
const tileViewerTooltip = document.getElementById('tileViewerTooltip');


/* ---- 2a. Tile map viewer refs ---- */
const tileMapCanvas = document.getElementById('tileMapCanvas');
const tileMapCtx = tileMapCanvas.getContext('2d');
const tileMapImageData = tileMapCtx.createImageData(256, 256); // 32x32 tiles of 8x8

/* ---- 2b. Tile inspector refs: decodes 16 bytes at a given address as an 8x8 tile. ---- */
const tileInspectCanvas = document.getElementById('tileInspectCanvas');
const tileInspectCtx = tileInspectCanvas.getContext('2d');
tileInspectCtx.imageSmoothingEnabled = false;
const tileInspectSrcCanvas = document.createElement('canvas');
tileInspectSrcCanvas.width = 8; tileInspectSrcCanvas.height = 8;
const tileInspectSrcCtx = tileInspectSrcCanvas.getContext('2d');
const tileInspectImageData = tileInspectSrcCtx.createImageData(8, 8);
const tileInspectAddrInput = document.getElementById('tileInspectAddr');
const tileInspectRangeEl = document.getElementById('tileInspectRangeEl');
const tileInspectBytesValEl = document.getElementById('tileInspectBytesValEl');
const tileInspectPrevBtn = document.getElementById('tileInspectPrev');
const tileInspectNextBtn = document.getElementById('tileInspectNext');
const tileInspectGoBtn = document.getElementById('tileInspectGo');
const tileInspectPasteAddrBtn = document.getElementById('tileInspectPasteAddr');
const tileInspectBytesInput = document.getElementById('tileInspectBytesInput');
const tileInspectWriteBtn = document.getElementById('tileInspectWrite');
const tileInspectPasteStatus = document.getElementById('tileInspectPasteStatus');
const tileInspectSwatches = Array.from(document.querySelectorAll('.tileinspect-swatch'));
const tileInspectClearBtn = document.getElementById('tileInspectClear');
let tileInspectDrawColor = 3; // 2bpp color index 0-3; matches the swatch marked "active" in HTML
let tileInspectAddr = 0x8000; // default: start of tile data table 0

/* ---- 3. OAM / sprite inspector refs ---- */
const oamTableBody = document.getElementById('oamTableBody');
const oamCompCanvas = document.getElementById('oamCompCanvas');
const oamCompCtx = oamCompCanvas.getContext('2d');
const oamCompWrap = document.getElementById('oamCompWrap');
const oamCompHover = document.getElementById('oamCompHover');
const oamCompTooltip = document.getElementById('oamCompTooltip');

/* ---- 4. Palette panel refs ---- */
const paletteGrid = document.getElementById('paletteGrid');

/* ---- 5. Disassembly panel refs ---- */
const disasmList = document.getElementById('disasmList');

/* ---- 6. Stack panel refs ---- */
const stackList = document.getElementById('stackList');
const stackSpReadout = document.getElementById('stackSpReadout');

/* ---- 7. Interrupts panel refs ---- */
const intSummary = document.getElementById('intSummary');
const intTable = document.getElementById('intTable');
const intLog = document.getElementById('intLog');

/* ---- 8. Execution trace panel refs ---- */
const traceList = document.getElementById('traceList');
const btnExportTrace = document.getElementById('btnExportTrace');
const btnTraceFollow = document.getElementById('btnTraceFollow');
const traceFrozenNote = document.getElementById('traceFrozenNote');

/* ---- 9. Memory map panel refs ---- */
const memmapStrip = document.getElementById('memmapStrip');
const memmapReadout = document.getElementById('memmapReadout');

/* ---- 10. MBC banking panel refs ---- */
const bankingDesc = document.getElementById('bankingDesc');
const bankingWindows = document.getElementById('bankingWindows');
const romBankGrid = document.getElementById('romBankGrid');
const ramBankGrid = document.getElementById('ramBankGrid');
const romBankCountEl = document.getElementById('romBankCount');
const ramBankCountEl = document.getElementById('ramBankCount');
const bankingLog = document.getElementById('bankingLog');

/* ---- 11. RTC panel refs ---- */
const rtcEmptyEl = document.getElementById('rtcEmpty');
const rtcContentEl = document.getElementById('rtcContent');
const rtcClockDaysEl = document.getElementById('rtcClockDays');
const rtcClockTimeEl = document.getElementById('rtcClockTime');
const rtcFlagHaltEl = document.getElementById('rtcFlagHalt');
const rtcFlagCarryEl = document.getElementById('rtcFlagCarry');
const rtcRegsEl = document.getElementById('rtcRegs');
const rtcInputDays = document.getElementById('rtcInputDays');
const rtcInputHours = document.getElementById('rtcInputHours');
const rtcInputMinutes = document.getElementById('rtcInputMinutes');
const rtcInputSeconds = document.getElementById('rtcInputSeconds');
const rtcInputHalt = document.getElementById('rtcInputHalt');
const rtcInputCorrectionH = document.getElementById('rtcInputCorrectionH');
const rtcInputCorrectionM = document.getElementById('rtcInputCorrectionM');
const rtcInfoEl = document.getElementById('rtcInfo');
const btnRtcApply = document.getElementById('btnRtcApply');
const btnRtcNow = document.getElementById('btnRtcNow');
const btnRtcClearCarry = document.getElementById('btnRtcClearCarry');
const btnRtcZero = document.getElementById('btnRtcZero');

/* ============================ Memory Map + MBC Banking visualizers ===================== */

// Region layout for the 0x0000-0xFFFF strip. `weight` sets proportional width; `minPx` is a
// floor for tiny regions; `purpose` shows as a hover tooltip.
const MEM_REGIONS = [
  { key: 'ROM0',   label: 'ROM Bank 0',    range: '0x0000–0x3FFF', color: '#5a9bd8', weight: 0x4000, minPx: 46,
    purpose: 'Fixed 16KB ROM bank, always mapped. Entry point, interrupt vectors, resident code/data.' },
  { key: 'ROMX',   label: 'ROM Bank N',    range: '0x4000–0x7FFF', color: '#8fc0ec', weight: 0x4000, minPx: 46,
    purpose: 'Switchable 16KB ROM bank, swapped by the mapper (MBC) for games larger than 32KB.' },
  { key: 'VRAM',   label: 'VRAM',          range: '0x8000–0x9FFF', color: '#e0a63d', weight: 0x2000, minPx: 34,
    purpose: 'Video RAM: tile pixel data and BG/window tile maps, read by the PPU each scanline.' },
  { key: 'ERAM',   label: 'Cart RAM',      range: '0xA000–0xBFFF', color: '#d9534f', weight: 0x2000, minPx: 34,
    purpose: 'Optional cartridge RAM (SRAM) for save data or MBC3 RTC registers. Mapper-gated.' },
  { key: 'WRAM',   label: 'WRAM',          range: '0xC000–0xDFFF', color: '#5cb85c', weight: 0x2000, minPx: 34,
    purpose: 'General-purpose work RAM: variables, stack, internal state.' },
  { key: 'ECHO',   label: 'Echo RAM',      range: '0xE000–0xFDFF', color: '#3f7a3f', weight: 0x1E00, minPx: 22, aliasOf: 'WRAM',
    purpose: 'Mirror of WRAM 0xC000-0xDDFF; reads/writes here hit WRAM.' },
  { key: 'OAM',    label: 'OAM',           range: '0xFE00–0xFE9F', color: '#b366cc', weight: 0x00A0, minPx: 20,
    purpose: 'Object Attribute Memory: up to 40 sprite entries composited by the PPU each scanline.' },
  { key: 'UNUSED', label: 'Unused',        range: '0xFEA0–0xFEFF', color: '#3a3a42', weight: 0x0060, minPx: 16,
    purpose: 'Unmapped on DMG hardware; returns inconsistent values depending on model.' },
  { key: 'IO',     label: 'I/O Regs',      range: '0xFF00–0xFF7F', color: '#e05fb0', weight: 0x0080, minPx: 20,
    purpose: 'Memory-mapped hardware registers: joypad, serial, timers, sound, LCD/PPU control.' },
  { key: 'HRAM',   label: 'HRAM',          range: '0xFF80–0xFFFE', color: '#f0d84a', weight: 0x007F, minPx: 20,
    purpose: 'High RAM, 127 bytes, fastest to access. Common scratch space during OAM DMA.' },
  { key: 'IE',     label: 'IE',            range: '0xFFFF',        color: '#f5f5f5', weight: 0x0001, minPx: 16,
    purpose: 'Interrupt Enable register, one bit per interrupt source.' },
];
let memRegionEls = {}; // key -> { el, key } (ECHO shares WRAM's flash key via aliasOf)

function buildMemMapStrip() {
  memmapStrip.innerHTML = '';
  memRegionEls = {};
  MEM_REGIONS.forEach(r => {
    const el = document.createElement('div');
    el.className = 'mem-region';
    el.style.flex = `${r.weight} 0 ${r.minPx}px`;
    el.style.background = r.color;
    el.title = `${r.label} (${r.range})\n${r.purpose}`;
    el.innerHTML = `<span class="mem-label">${r.label}</span><span class="mem-range">${r.range}</span>` +
      (r.key === 'ROMX' ? '<span class="mem-bank" id="mmRomBankTag">Bank 1</span>' : '');
    memmapStrip.appendChild(el);
    memRegionEls[r.key] = el;
  });
}

let lastRenderedAccessSeq = -1;

function drawMemMap() {
  // Keep the ROM bank tag accurate even if nothing was read from it this frame
  const bankTag = document.getElementById('mmRomBankTag');
  if (bankTag) bankTag.textContent = 'Bank ' + emulator.instrumentation.readMBCState().romBank;

  const a = emulator.stats.lastAccess;
  if (a.seq === 0) return; // nothing accessed yet (no ROM loaded / not run)

  if (a.seq !== lastRenderedAccessSeq) {
    lastRenderedAccessSeq = a.seq;
    // Echo RAM writes flash the ECHO block itself, not WRAM
    const flashKey = a.region === 'WRAM' && a.addr >= 0xE000 ? 'ECHO' : a.region;
    const el = memRegionEls[flashKey];
    if (el) {
      el.classList.remove('mem-flash');
      void el.offsetWidth; // restart animation even on back-to-back hits in the same region
      el.classList.add('mem-flash');
    }
  }

  const regionMeta = MEM_REGIONS.find(r => r.key === (a.region === 'WRAM' && a.addr >= 0xE000 ? 'ECHO' : a.region));
  memmapReadout.innerHTML =
    `<span class="mm-swatch" style="background:${regionMeta ? regionMeta.color : '#888'}"></span>` +
    `<b>${hex16(a.addr)}</b> in <b>${regionMeta ? regionMeta.label : a.region}</b>` +
    ` &middot; <span class="mm-type-${a.type}">${a.type.toUpperCase()}</span>`;
}

const RTC_REG_LABEL = { 0x08: 'RTC Seconds', 0x09: 'RTC Minutes', 0x0A: 'RTC Hours', 0x0B: 'RTC Day (lo)', 0x0C: 'RTC Day (hi)/Flags' };

// Switchable 8KB cart-RAM banks a mapper exposes (MBC2's RAM has no banking).
// Takes the readMBCState() snapshot, not mmu, so every caller reads through instrumentation.
function getRamBankTotal(mbc) {
  if (mbc.mbcType === 0 || mbc.mbcType === 2) return 0;
  if (mbc.mbcType === 5) return 16;
  return 4;
}

// What's mapped into 0xA000-0xBFFF right now.
function ramBankTarget(mbc, ramBankTotal) {
  if (mbc.mbcType === 2) return mbc.ramEnabled ? 'Built-in RAM (512×4-bit)' : 'disabled';
  if (!ramBankTotal) return 'no cart RAM';
  if (!mbc.ramEnabled) return 'disabled';
  if (mbc.mbcType === 3 && mbc.rtcSelect !== -1) return RTC_REG_LABEL[mbc.rtcSelect] || 'RTC register';
  return 'RAM Bank ' + mbc.ramBank;
}

function buildBankingPanel() {
  const rom = emulator.instrumentation.readROM();
  const mbc = emulator.instrumentation.readMBCState();
  const romBytes = rom ? rom.length : 0;
  const romBankTotal = romBytes > 0 ? Math.max(1, Math.ceil(romBytes / 0x4000)) : 0;
  const ramBankTotal = getRamBankTotal(mbc);

  bankingDesc.innerHTML = romBytes === 0
    ? 'Load a ROM to see its mapper and which ROM/RAM banks are currently switched in.'
    : `Mapper: <b>${getMBCName(rom)}</b> &middot; ${romBankTotal} ROM bank(s) of 16KB` +
      (mbc.mbcType === 2 ? ' &middot; 512×4-bit built-in RAM (no banking)'
        : ramBankTotal ? ` &middot; up to ${ramBankTotal} RAM bank(s) of 8KB` : ' &middot; no external RAM') +
      (!mbc.cartTypeSupported ? `<br><span style="color:#e8794b">⚠ Unsupported mapper - banking below is simulated as MBC1 and won't match real hardware.</span>` : '');

  bankingWindows.innerHTML = `
    <div class="bank-window" id="bwFixed">
      <div class="bw-range">CPU addresses 0x0000–0x3FFF</div>
      <div class="bw-arrow">↓ always mapped to</div>
      <div class="bw-target">ROM Bank 0</div>
      <div class="bw-note">Fixed - never switches. Interrupt vectors and the entry point live here.</div>
    </div>
    <div class="bank-window" id="bwSwitchable">
      <div class="bw-range">CPU addresses 0x4000–0x7FFF</div>
      <div class="bw-arrow">↓ currently mapped to</div>
      <div class="bw-target" id="bwSwitchableTarget">${romBankTotal ? 'ROM Bank ' + mbc.romBank : '—'}</div>
      <div class="bw-note">Switched by writing to 0x2000–0x3FFF (MBC1/MBC3), 0x0000–0x3FFF with address bit 8 set (MBC2), or 0x2000–0x2FFF + 0x3000–0x3FFF for the low/high bank bits (MBC5). This is what "bank switching" means.</div>
    </div>
    <div class="bank-window" id="bwRam">
      <div class="bw-range">CPU addresses 0xA000–0xBFFF</div>
      <div class="bw-arrow">↓ currently mapped to</div>
      <div class="bw-target" id="bwRamTarget">${ramBankTarget(mbc, ramBankTotal)}</div>
      <div class="bw-note" id="bwRamNote">${mbc.mbcType === 3 ? 'Must be enabled (write 0x0A to 0x0000–0x1FFF); writing 0x08–0x0C to 0x4000–0x5FFF maps an RTC register in here instead.' : 'Must be enabled (write 0x0A to 0x0000–0x1FFF) before it\'s readable/writable.'}</div>
    </div>`;

  romBankGrid.innerHTML = '';
  if (romBankTotal === 0) {
    romBankGrid.innerHTML = '<div class="bank-empty">No ROM loaded.</div>';
  } else {
    for (let i = 0; i < romBankTotal; i++) {
      const tile = document.createElement('div');
      tile.className = 'bank-tile' + (i === 0 ? ' bank-fixed' : '');
      tile.textContent = i;
      tile.title = i === 0 ? 'Bank 0 - fixed at 0x0000–0x3FFF' : `Bank ${i}`;
      tile.dataset.bank = i;
      romBankGrid.appendChild(tile);
    }
  }
  romBankCountEl.textContent = romBankTotal ? `(${romBankTotal} × 16KB = ${(romBankTotal * 16)}KB ROM)` : '';

  ramBankGrid.innerHTML = '';
  if (mbc.mbcType === 2) {
    ramBankGrid.innerHTML = '<div class="bank-empty">Built-in 512×4-bit RAM - not bank-switched, see readout above.</div>';
  } else if (ramBankTotal === 0) {
    ramBankGrid.innerHTML = '<div class="bank-empty">This mapper has no external RAM.</div>';
  } else {
    for (let i = 0; i < ramBankTotal; i++) {
      const tile = document.createElement('div');
      tile.className = 'bank-tile';
      tile.textContent = i;
      tile.title = `RAM Bank ${i}`;
      tile.dataset.bank = i;
      ramBankGrid.appendChild(tile);
    }
  }
  ramBankCountEl.textContent = ramBankTotal ? `(${ramBankTotal} × 8KB = ${(ramBankTotal * 8)}KB)` : '';

  bankingLog.textContent = 'No banking writes observed yet.';
}

let lastRenderedBankSwitchT = -1;
const BANK_KIND_LABEL = { rom: 'ROM bank switch', ram: 'RAM bank switch', enable: 'RAM enable/disable', mode: 'banking mode switch', rtc: 'RTC register select' };

function drawBanking() {
  const rom = emulator.instrumentation.readROM(); // ROM presence check, not banking state
  if (!rom || rom.length === 0) return;
  const mbc = emulator.instrumentation.readMBCState();

  // Keep readouts and active-tile highlight correct every frame
  const romTarget = document.getElementById('bwSwitchableTarget');
  if (romTarget) romTarget.textContent = 'ROM Bank ' + mbc.romBank;
  const ramTarget = document.getElementById('bwRamTarget');
  if (ramTarget) ramTarget.textContent = ramBankTarget(mbc, getRamBankTotal(mbc));

  romBankGrid.querySelectorAll('.bank-tile').forEach(t => {
    t.classList.toggle('bank-active', Number(t.dataset.bank) === mbc.romBank);
  });
  const ramBankMapped = mbc.ramEnabled && !(mbc.mbcType === 3 && mbc.rtcSelect !== -1);
  ramBankGrid.querySelectorAll('.bank-tile').forEach(t => {
    t.classList.toggle('bank-active', ramBankMapped && Number(t.dataset.bank) === mbc.ramBank);
  });

  const bs = emulator.stats.lastBankSwitch;
  if (bs && bs.t !== lastRenderedBankSwitchT) {
    lastRenderedBankSwitchT = bs.t;

    const flashWindow = bs.kind === 'ram' || bs.kind === 'enable' || bs.kind === 'rtc' ? 'bwRam' : (bs.kind === 'mode' ? 'bwSwitchable' : 'bwSwitchable');
    const winEl = document.getElementById(flashWindow);
    if (winEl) { winEl.classList.remove('bw-flash'); void winEl.offsetWidth; winEl.classList.add('bw-flash'); }

    const grid = bs.kind === 'ram' ? ramBankGrid : (bs.kind === 'rom' ? romBankGrid : null);
    const bankNum = bs.kind === 'ram' ? bs.ramBank : bs.romBank;
    if (grid) {
      const tile = grid.querySelector(`.bank-tile[data-bank="${bankNum}"]`);
      if (tile) { tile.classList.remove('bank-flash'); void tile.offsetWidth; tile.classList.add('bank-flash'); }
    }

    bankingLog.textContent = `Write ${hex8(bs.val)} → ${hex16(bs.addr)}  (${BANK_KIND_LABEL[bs.kind]})` +
      `  ⇒  ROM bank ${bs.romBank}` + (mbc.mbcType !== 0 ? `, ${ramBankTarget(mbc, getRamBankTotal(mbc))}` : '');
  }
}

buildMemMapStrip();
buildBankingPanel();

/* RAM Editor: read/write panel for RAM regions plus IE, with a bit-level view for I/O
   registers; ROM stays read-only. Reads/writes go through instrumentation.peekByte()/writeMemory(). */

const ramEditRegionsEl = document.getElementById('ramEditRegions');
const ramEditInfoEl = document.getElementById('ramEditInfo');
const ramEditNavEl = document.getElementById('ramEditNav');
const ramEditBodyEl = document.getElementById('ramEditBody');

// Per-region edit policy: ROM read-only; most regions as hex dump; I/O and IE use a per-bit editor.
const RAMEDIT_META = {
  ROM0: { editable: false, mode: 'hex', note: 'Read-only: on real hardware ROM can\'t be written either.' },
  ROMX: { editable: false, mode: 'hex', note: 'Read-only: on real hardware ROM can\'t be written either.' },
  VRAM: { editable: true, mode: 'hex' },
  ERAM: { editable: true, mode: 'hex', note: 'Cartridge RAM. If the game hasn\'t enabled it (RAMG), reads return 0xFF and writes are ignored - same as real hardware.' },
  WRAM: { editable: true, mode: 'hex' },
  ECHO: { editable: true, mode: 'hex', note: 'Mirror of 0xC000-0xDDFF: writing here actually writes to WRAM, exactly like the MMU itself does.' },
  OAM: { editable: true, mode: 'hex' },
  IO: { editable: true, mode: 'io', note: 'Many bits here are read-only, write-only, or trigger a side effect (resetting a counter, firing a DMA...) when written - that\'s why each register is edited bit by bit instead of as raw hex.' },
  HRAM: { editable: true, mode: 'hex' },
  IE: { editable: true, mode: 'io' },
};
const RAMEDIT_ORDER = ['ROM0', 'ROMX', 'VRAM', 'ERAM', 'WRAM', 'ECHO', 'OAM', 'IO', 'HRAM', 'IE'];
const RAMEDIT_BASE = { ROM0: 0x0000, ROMX: 0x4000, VRAM: 0x8000, ERAM: 0xA000, WRAM: 0xC000, ECHO: 0xE000, OAM: 0xFE00, IO: 0xFF00, HRAM: 0xFF80, IE: 0xFFFF };
const RAMEDIT_LEN = { ROM0: 0x4000, ROMX: 0x4000, VRAM: 0x2000, ERAM: 0x2000, WRAM: 0x2000, ECHO: 0x1E00, OAM: 0xA0, IO: 0x80, HRAM: 0x7F, IE: 0x1 };
const RAMEDIT_PAGE = 256; // bytes per page (16 rows x 16 bytes) for regions bigger than this

// Names/descriptions for known DMG I/O registers, with optional bit labels (MSB first).
// Unlisted registers fall back to a plain hex byte editor.
const IO_REG_INFO = {
  0xFF00: { name: 'P1/JOYP', desc: 'Joypad. Bits 5-4 select which button line is being read; bits 3-0 are inputs (0 = pressed) that real hardware doesn\'t let software force.' },
  0xFF01: { name: 'SB', desc: 'Serial data buffer.' },
  0xFF02: { name: 'SC', desc: 'Serial transfer control.' },
  0xFF04: { name: 'DIV', desc: 'Divider. Any write resets it to 0x00, regardless of the value written.' },
  0xFF05: { name: 'TIMA', desc: 'Timer counter.' },
  0xFF06: { name: 'TMA', desc: 'Timer reload value.' },
  0xFF07: { name: 'TAC', desc: 'Timer control.', bitLabels: ['-', '-', '-', '-', '-', 'Enable', 'Clk1', 'Clk0'] },
  0xFF0F: { name: 'IF', desc: 'Pending interrupts.', bitLabels: ['-', '-', '-', 'Joypad', 'Serial', 'Timer', 'STAT', 'VBlank'] },
  0xFF10: { name: 'NR10', desc: 'Channel 1: frequency sweep.' },
  0xFF11: { name: 'NR11', desc: 'Channel 1: duty/length.' },
  0xFF12: { name: 'NR12', desc: 'Channel 1: volume/envelope.' },
  0xFF13: { name: 'NR13', desc: 'Channel 1: frequency (low bits) - write-only on real hardware.' },
  0xFF14: { name: 'NR14', desc: 'Channel 1: frequency (high bits) + trigger.' },
  0xFF16: { name: 'NR21', desc: 'Channel 2: duty/length.' },
  0xFF17: { name: 'NR22', desc: 'Channel 2: volume/envelope.' },
  0xFF18: { name: 'NR23', desc: 'Channel 2: frequency (low bits) - write-only on real hardware.' },
  0xFF19: { name: 'NR24', desc: 'Channel 2: frequency (high bits) + trigger.' },
  0xFF1A: { name: 'NR30', desc: 'Channel 3: DAC on/off.' },
  0xFF1B: { name: 'NR31', desc: 'Channel 3: length - write-only on real hardware.' },
  0xFF1C: { name: 'NR32', desc: 'Channel 3: output level.' },
  0xFF1D: { name: 'NR33', desc: 'Channel 3: frequency (low bits) - write-only on real hardware.' },
  0xFF1E: { name: 'NR34', desc: 'Channel 3: frequency (high bits) + trigger.' },
  0xFF20: { name: 'NR41', desc: 'Channel 4: length - write-only on real hardware.' },
  0xFF21: { name: 'NR42', desc: 'Channel 4: volume/envelope.' },
  0xFF22: { name: 'NR43', desc: 'Channel 4: noise frequency.' },
  0xFF23: { name: 'NR44', desc: 'Channel 4: control + trigger.' },
  0xFF24: { name: 'NR50', desc: 'Master volume / VIN input.' },
  0xFF25: { name: 'NR51', desc: 'Left/right panning per channel.' },
  0xFF26: { name: 'NR52', desc: 'Master sound on/off. Bits 3-0 (per-channel status) are read-only.', bitLabels: ['Power', '-', '-', '-', 'Ch4', 'Ch3', 'Ch2', 'Ch1'] },
  0xFF40: { name: 'LCDC', desc: 'LCD control.', bitLabels: ['LCD On', 'WinMap', 'WinOn', 'BG/WinData', 'BGMap', 'ObjSize', 'ObjOn', 'BG/WinOn'] },
  0xFF41: { name: 'STAT', desc: 'LCD status. Bits 2-0 are hardware-controlled (current mode / LYC=LY flag) and get overwritten on the fly.', bitLabels: ['-', 'LYC int', 'M2 int', 'M1 int', 'M0 int', 'LYC=LY', 'Mode1', 'Mode0'] },
  0xFF42: { name: 'SCY', desc: 'Background scroll Y.' },
  0xFF43: { name: 'SCX', desc: 'Background scroll X.' },
  0xFF44: { name: 'LY', desc: 'Current scanline. Any write resets it to 0.' },
  0xFF45: { name: 'LYC', desc: 'Comparison line for the STAT interrupt.' },
  0xFF46: { name: 'DMA', desc: 'Writing here triggers a 160-byte DMA copy to OAM - it\'s not storage in itself, so the displayed value doesn\'t "stick".' },
  0xFF47: { name: 'BGP', desc: 'Background/window palette.' },
  0xFF48: { name: 'OBP0', desc: 'Sprite palette 0.' },
  0xFF49: { name: 'OBP1', desc: 'Sprite palette 1.' },
  0xFF4A: { name: 'WY', desc: 'Window Y position.' },
  0xFF4B: { name: 'WX', desc: 'Window X position (+7).' },
};
for (let a = 0xFF30; a <= 0xFF3F; a++) IO_REG_INFO[a] = { name: 'WAVE', desc: 'Channel 3 waveform RAM (two 4-bit samples per byte).' };
const IE_BIT_LABELS = ['-', '-', '-', 'Joypad', 'Serial', 'Timer', 'STAT', 'VBlank'];

let ramEditKey = 'VRAM';
let ramEditOffset = 0;

function ramEditRegionMeta(key) {
  const m = RAMEDIT_META[key];
  const mm = MEM_REGIONS.find(r => r.key === key) || {};
  return { key, base: RAMEDIT_BASE[key], length: RAMEDIT_LEN[key], editable: m.editable, mode: m.mode, note: m.note, label: mm.label || key, color: mm.color || '#888', range: mm.range || '', purpose: mm.purpose || '' };
}

function buildRamEditRegionTabs() {
  ramEditRegionsEl.innerHTML = '';
  RAMEDIT_ORDER.forEach(key => {
    const meta = ramEditRegionMeta(key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ramedit-region-btn' + (meta.editable ? '' : ' readonly') + (key === ramEditKey ? ' active' : '');
    btn.style.setProperty('--region-color', meta.color);
    btn.title = `${meta.label} (${meta.range})\n${meta.purpose}`;
    btn.innerHTML = `<span class="ramedit-region-name">${meta.label}</span><span class="ramedit-region-range">${meta.range}</span>`;
    btn.addEventListener('click', () => {
      if (ramEditKey === key) return;
      ramEditKey = key;
      ramEditOffset = 0;
      buildRamEditRegionTabs();
      buildRamEditBody();
    });
    ramEditRegionsEl.appendChild(btn);
  });
}

function buildRamEditNav(meta) {
  ramEditNavEl.innerHTML = '';
  if (meta.length <= RAMEDIT_PAGE) return; // whole region already fits on one page
  const pageLen = Math.min(RAMEDIT_PAGE, meta.length - ramEditOffset);
  const row = document.createElement('div');
  row.className = 'ramedit-nav-row';

  const prev = document.createElement('button');
  prev.className = 'ui-btn small ghost';
  prev.textContent = '◀ Prev';
  prev.disabled = ramEditOffset === 0;
  prev.addEventListener('click', () => { ramEditOffset = Math.max(0, ramEditOffset - RAMEDIT_PAGE); buildRamEditBody(); });

  const next = document.createElement('button');
  next.className = 'ui-btn small ghost';
  next.textContent = 'Next ▶';
  next.disabled = ramEditOffset + RAMEDIT_PAGE >= meta.length;
  next.addEventListener('click', () => { ramEditOffset = Math.min(meta.length - RAMEDIT_PAGE, ramEditOffset + RAMEDIT_PAGE); buildRamEditBody(); });

  const label = document.createElement('span');
  label.className = 'ramedit-nav-label';
  label.textContent = `${hex16(meta.base + ramEditOffset)}–${hex16(meta.base + ramEditOffset + pageLen - 1)}`;

  const jump = document.createElement('input');
  jump.className = 'ramedit-jump';
  jump.placeholder = 'go to 0x....';
  jump.spellcheck = false;
  jump.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = parseInt(jump.value.replace(/^0x/i, ''), 16);
    if (Number.isNaN(v)) return;
    const rel = Math.max(0, Math.min(meta.length - 1, v - meta.base));
    ramEditOffset = Math.max(0, Math.min(meta.length - RAMEDIT_PAGE, Math.floor(rel / 16) * 16));
    buildRamEditBody();
  });

  row.appendChild(prev); row.appendChild(label); row.appendChild(next); row.appendChild(jump);
  ramEditNavEl.appendChild(row);
}

// Applies a hex-cell edit through the real MMU write path.
function commitRamEditCell(input) {
  if (input.value === '') return; // next live refresh repaints the real value
  const addr = parseInt(input.dataset.addr, 10);
  const val = parseInt(input.value, 16) & 0xFF;
  emulator.instrumentation.writeMemory(addr, val);
}

function makeRamEditHexInput(addr) {
  const input = document.createElement('input');
  input.className = 'ramedit-cell';
  input.maxLength = 2;
  input.spellcheck = false;
  input.dataset.addr = addr;
  input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 2).toUpperCase(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('blur', () => commitRamEditCell(input));
  return input;
}

function buildRamEditHexTable(meta) {
  ramEditBodyEl.innerHTML = '';
  const pageLen = Math.min(RAMEDIT_PAGE, meta.length - ramEditOffset);
  const table = document.createElement('table');
  table.className = 'ramedit-hex-table';
  table.innerHTML = '<thead><tr><th>Addr</th>' + Array.from({ length: 16 }, (_, i) => `<th>${i.toString(16).toUpperCase()}</th>`).join('') + '<th>ASCII</th></tr></thead>';
  const tbody = document.createElement('tbody');

  for (let row = 0; row < pageLen; row += 16) {
    const tr = document.createElement('tr');
    const rowAddr = meta.base + ramEditOffset + row;
    const tdAddr = document.createElement('td');
    tdAddr.className = 'ramedit-addr';
    tdAddr.textContent = hex16(rowAddr);
    tr.appendChild(tdAddr);

    const asciiAddrs = [];
    for (let col = 0; col < 16; col++) {
      const addr = rowAddr + col;
      const td = document.createElement('td');
      if (addr >= meta.base + meta.length) { td.innerHTML = '&nbsp;'; tr.appendChild(td); continue; }
      if (meta.editable) {
        td.appendChild(makeRamEditHexInput(addr));
      } else {
        const span = document.createElement('span');
        span.className = 'ramedit-cell-ro';
        span.dataset.addr = addr;
        td.appendChild(span);
      }
      tr.appendChild(td);
      asciiAddrs.push(addr);
    }
    const tdAscii = document.createElement('td');
    tdAscii.className = 'ramedit-ascii';
    tdAscii.dataset.addrs = asciiAddrs.join(',');
    tr.appendChild(tdAscii);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  ramEditBodyEl.appendChild(table);
}

function buildRamEditIoBitRow(row, addr, labels) {
  const bits = document.createElement('div');
  bits.className = 'ramedit-io-bits';
  for (let bit = 7; bit >= 0; bit--) {
    const item = document.createElement('label');
    item.className = 'ramedit-bit';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.bit = bit;
    cb.addEventListener('change', () => {
      const cur = emulator.instrumentation.peekByte(addr);
      const next = cb.checked ? (cur | (1 << bit)) : (cur & ~(1 << bit));
      emulator.instrumentation.writeMemory(addr, next & 0xFF); // always through the real write path (handles IO side effects/masks)
    });
    const lab = document.createElement('span');
    lab.textContent = labels ? labels[7 - bit] : ('b' + bit);
    item.appendChild(cb);
    item.appendChild(lab);
    bits.appendChild(item);
  }
  row.appendChild(bits);
}

function buildRamEditIoTable(meta) {
  ramEditBodyEl.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'ramedit-io-list';

  for (let addr = meta.base; addr < meta.base + meta.length; addr++) {
    const info = IO_REG_INFO[addr];
    const isIE = addr === 0xFFFF;
    const row = document.createElement('div');
    row.className = 'ramedit-io-row';
    row.dataset.addr = addr;

    const head = document.createElement('div');
    head.className = 'ramedit-io-head';
    head.innerHTML = `<span class="ramedit-io-addr">${hex16(addr)}</span>` +
      `<span class="ramedit-io-name">${isIE ? 'IE' : (info ? info.name : '—')}</span>` +
      `<span class="ramedit-io-hex">${hex8(0)}</span>`;
    row.appendChild(head);

    const descText = isIE ? 'Interrupt Enable - enables which sources can interrupt the CPU while IME is on.' : (info && info.desc);
    if (descText) {
      const desc = document.createElement('div');
      desc.className = 'ramedit-io-desc';
      desc.textContent = descText;
      row.appendChild(desc);
    }

    if (isIE) {
      buildRamEditIoBitRow(row, addr, IE_BIT_LABELS);
    } else if (info) {
      buildRamEditIoBitRow(row, addr, info.bitLabels || null);
    } else {
      // No documented bit semantics for this address: fall back to a raw hex editor
      const hexRow = document.createElement('div');
      hexRow.className = 'ramedit-io-hexrow';
      hexRow.appendChild(makeRamEditHexInput(addr));
      const note = document.createElement('span');
      note.className = 'ramedit-io-unknown-note';
      note.textContent = 'no known name in this emulator — edited as a raw byte';
      hexRow.appendChild(note);
      row.appendChild(hexRow);
    }
    list.appendChild(row);
  }
  ramEditBodyEl.appendChild(list);
}

function buildRamEditBody() {
  const meta = ramEditRegionMeta(ramEditKey);
  ramEditInfoEl.innerHTML = `<span class="ramedit-info-range">${meta.range}</span>` +
    (meta.editable ? '' : '<span class="ramedit-readonly-badge">read-only</span>') +
    (meta.note ? `<p class="ramedit-note">${meta.note}</p>` : '') +
    ((meta.key === 'ROMX' || meta.key === 'ERAM') ? `<p class="ramedit-dynamic-note" id="ramEditDynamicNote"></p>` : '');
  buildRamEditNav(meta);
  if (meta.mode === 'io') buildRamEditIoTable(meta);
  else buildRamEditHexTable(meta);
  drawRamEditor(); // paint real values immediately, don't wait for the next tick
}

// Live refresh: repaints visible cells from instrumentation.peekByte(), skipping any focused input.
function drawRamEditor() {
  const meta = ramEditRegionMeta(ramEditKey);

  const dyn = document.getElementById('ramEditDynamicNote');
  if (dyn) {
    const mbc = emulator.instrumentation.readMBCState();
    if (meta.key === 'ROMX') dyn.textContent = `Bank currently mapped at 0x4000–0x7FFF: ${mbc.romBank}`;
    else if (meta.key === 'ERAM') dyn.textContent = mbc.ramEnabled ? `RAM enabled — current bank: ${mbc.ramBank}` : 'RAM disabled (RAMG) — reads return 0xFF, writes are ignored.';
  }

  if (meta.mode === 'io') {
    ramEditBodyEl.querySelectorAll('.ramedit-io-row').forEach(row => {
      const addr = parseInt(row.dataset.addr, 10);
      const val = emulator.instrumentation.peekByte(addr);
      const hexEl = row.querySelector('.ramedit-io-hex');
      if (hexEl) hexEl.textContent = hex8(val);
      row.querySelectorAll('.ramedit-bit input').forEach(cb => {
        if (document.activeElement === cb) return;
        cb.checked = !!(val & (1 << parseInt(cb.dataset.bit, 10)));
      });
      const hexInput = row.querySelector('.ramedit-cell');
      if (hexInput && document.activeElement !== hexInput) hexInput.value = hex8(val).slice(2);
    });
    return;
  }

  ramEditBodyEl.querySelectorAll('.ramedit-cell').forEach(input => {
    if (document.activeElement === input) return;
    input.value = hex8(emulator.instrumentation.peekByte(parseInt(input.dataset.addr, 10))).slice(2);
  });
  ramEditBodyEl.querySelectorAll('.ramedit-cell-ro').forEach(span => {
    span.textContent = hex8(emulator.instrumentation.peekByte(parseInt(span.dataset.addr, 10))).slice(2);
  });
  ramEditBodyEl.querySelectorAll('.ramedit-ascii').forEach(td => {
    const addrs = (td.dataset.addrs || '').split(',').filter(Boolean).map(Number);
    td.textContent = addrs.map(a => { const v = emulator.instrumentation.peekByte(a); return (v >= 32 && v < 127) ? String.fromCharCode(v) : '.'; }).join('');
  });
}

buildRamEditRegionTabs();
buildRamEditBody();

/* ---- tab switching (each sidebar tracks its own active tab) ---- */
const debugToolsContainer = document.getElementById('debugTools');
const visualToolsContainer = document.getElementById('visualTools');
const cpuDebugControls = document.getElementById('cpuDebugControls');
const TOOLS_NEEDING_CPU_CONTROLS = ['trace', 'disasm', 'stack'];
const rtcTabBtn = visualToolsContainer.querySelector('.tool-tab[data-tool="rtc"]');

function updateCpuControlsVisibility(tool) {
  cpuDebugControls.classList.toggle('hidden', !TOOLS_NEEDING_CPU_CONTROLS.includes(tool));
}

// Keep emulator.stats.trackMemMap/emulator.instrumentation.trackTrace synced to (debug mode
// on) AND (that tab active), so the hot instrumentation only runs when its tab is actually open.
function syncAccessTracking(activeDebugTool) {
  const debugging = !document.body.classList.contains('playing-mode');
  emulator.stats.trackMemMap = debugging && (activeDebugTool === 'memmap' || activeDebugTool === 'banking');
  emulator.instrumentation.trackTrace = debugging && (activeDebugTool === 'trace');
}

function setupTabGroup(container) {
  const tabs = container.querySelectorAll('.tool-tab');
  const panels = container.querySelectorAll('.tool-panel');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tool).classList.remove('hidden');
      if (container === debugToolsContainer) {
        updateCpuControlsVisibility(btn.dataset.tool);
        syncAccessTracking(btn.dataset.tool);
      }
      if (btn.dataset.tool === 'rtc') syncRtcInputsFromLive(); // fresh "Set clock" defaults each time the tab is opened
      if (btn.dataset.tool === 'tileinspect') autoPasteTileInspectAddrFromClipboard();
      refreshDebugTools();
    });
  });
}

setupTabGroup(debugToolsContainer);
setupTabGroup(visualToolsContainer);

updateCpuControlsVisibility(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool);
syncAccessTracking(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool);

// RTC only exists on MBC3+TIMER carts (0x0F/0x10); the tab hides otherwise.
// Called on every ROM (re)load/reset.
function rtcUsable() {
  if (!emulator.hasROM()) return false;
  const mbc = emulator.instrumentation.readMBCState();
  return mbc.mbcType === 3 && mbc.hasTimer;
}
function updateRtcTabAvailability() {
  const usable = rtcUsable();
  rtcTabBtn.classList.toggle('hidden', !usable);
  if (!usable && rtcTabBtn.classList.contains('active')) {
    // Active tab just stopped being usable: steer back via a real click so normal bookkeeping runs
    visualToolsContainer.querySelector('.tool-tab[data-tool="layers"]').click();
  } else if (usable) {
    syncRtcInputsFromLive();
  }
}
updateRtcTabAvailability();

// Keep the trace panel's height matched to its sibling column on resize, while its tab is active
window.addEventListener('resize', () => {
  if (debugToolsContainer.querySelector('.tool-tab.active').dataset.tool === 'trace') syncTraceListHeight();
});

let tileMapSelect = '9800';
document.querySelectorAll('input[name="tmSelect"]').forEach(r => {
  r.addEventListener('change', () => { tileMapSelect = r.value; refreshDebugTools(); });
});

/* ---- play / debug mode toggle: checked = debugging GUI (default), unchecked = playing.
   Persisted in the shared UI config. ---- */
const modeToggle = document.getElementById('modeToggle');
const modeLabelPlay = document.getElementById('modeLabelPlay');
const modeLabelDebug = document.getElementById('modeLabelDebug');

function applyMode() {
  const debugging = modeToggle.checked;
  document.body.classList.toggle('playing-mode', !debugging);
  emulator.stats.trackAccess = debugging; // skip the coarser frame-activity bookkeeping entirely while just playing
  syncAccessTracking(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool); // and the finer memmap/trace gates
  modeLabelDebug.classList.toggle('active', debugging);
  modeLabelPlay.classList.toggle('active', !debugging);
  saveUIConfig({ debugMode: debugging });
  if (debugging) refreshDebugTools();
}

// Restore saved mode before first render to avoid a flash of the default
if (typeof savedUIConfig.debugMode === 'boolean') modeToggle.checked = savedUIConfig.debugMode;

modeToggle.addEventListener('change', applyMode);

/* ---- screen model toggle: checked = GBP (grayscale, default), unchecked = GB (green tint) ---- */
const modelToggle = document.getElementById('modelToggle');
const modelLabelGB = document.getElementById('modelLabelGB');
const modelLabelGBP = document.getElementById('modelLabelGBP');

function applyScreenModel() {
  const isGBP = modelToggle.checked;
  emulator.setScreenModel(isGBP ? 'gbp' : 'gb');
  document.documentElement.style.setProperty('--screen-bg', isGBP ? '#343434' : '#0f380f');
  modelLabelGBP.classList.toggle('active', isGBP);
  modelLabelGB.classList.toggle('active', !isGBP);
  saveUIConfig({ gbp: isGBP });
  // Repaint immediately with the new palette and refresh any open color panels
  if (emulator.hasROM()) draw();
  refreshDebugTools();
}

if (typeof savedUIConfig.gbp === 'boolean') modelToggle.checked = savedUIConfig.gbp;

modelToggle.addEventListener('change', applyScreenModel);

/* ---- navbar toggle: overlay a line at the PPU's current scanline (LY).
   Not persisted; always starts off on load. ---- */
const scanlineMarkToggle = document.getElementById('scanlineMarkToggle');
const scanlineMarkLabelOn = document.getElementById('scanlineMarkLabelOn');

function applyScanlineMark() {
  const on = scanlineMarkToggle.checked;
  markCurrentLine = on;
  scanlineMarkLabelOn.classList.toggle('active', on);
  // Repaint immediately so toggling is visible even while paused/no frame is running.
  if (emulator.hasROM()) draw();
}

scanlineMarkToggle.addEventListener('change', applyScanlineMark);

// Lock the toggle while running (only meaningful while paused); driven by emulator.onRunStateChange
const scanlineMarkToggleWrap = scanlineMarkToggle.closest('.scanline-mark-toggle');
function setScanlineMarkToggleLocked(running) {
  scanlineMarkToggle.disabled = running;
  scanlineMarkToggleWrap.title = running ? 'Pause the emulator to change this (debug-only)' : '';
}
setScanlineMarkToggleLocked(emulator.running);
emulator.onRunStateChange = setScanlineMarkToggleLocked;

/* ---- navbar toggle: tint each PPU layer (BG/window/sprites) so overlaps are easy to tell apart.
   Not persisted; always starts off on load. ---- */
const layerTintToggle = document.getElementById('layerTintToggle');
const layerTintLabelOn = document.getElementById('layerTintLabelOn');

function applyLayerTint() {
  const on = layerTintToggle.checked;
  emulator.layerTint = on;
  layerTintLabelOn.classList.toggle('active', on);
  // Repaint immediately so toggling is visible even while paused/no frame is running.
  if (emulator.hasROM()) draw();
}

layerTintToggle.addEventListener('change', applyLayerTint);

/* ---- navbar toggle: overlay a hairline pixel grid mimicking a real GB LCD's dot matrix ---- */
const dotMatrixToggle = document.getElementById('dotMatrixToggle');
const dotMatrixLabelOn = document.getElementById('dotMatrixLabelOn');

function applyDotMatrix() {
  const on = dotMatrixToggle.checked;
  document.body.classList.toggle('dot-matrix-on', on);
  dotMatrixLabelOn.classList.toggle('active', on);
  saveUIConfig({ dotMatrix: on });
}

if (typeof savedUIConfig.dotMatrix === 'boolean') dotMatrixToggle.checked = savedUIConfig.dotMatrix;

dotMatrixToggle.addEventListener('change', applyDotMatrix);

/* ---- hidden click-combo for enableEmuDevUnlock(): click the navbar badge 13 times while
   dotMatrix is on and model is set to GB. Sets the same localStorage flag as the console
   path; requires a page reload to take effect. ---- */
const navTitle = document.getElementById('navTitle');
const DEV_UNLOCK_CLICKS_NEEDED = 13;
let devUnlockClickCount = 0;
navTitle.addEventListener('click', () => {
  if (!(dotMatrixToggle.checked && !modelToggle.checked)) {
    devUnlockClickCount = 0;
    return;
  }
  devUnlockClickCount++;
  if (devUnlockClickCount >= DEV_UNLOCK_CLICKS_NEEDED) {
    devUnlockClickCount = 0;
    enableEmuDevUnlock();
  }
});

/* ---- navbar toggles: show/hide the Debug Tools sidebar, Visualization Tools sidebar,
   and Frame Activity panel (display:none, reclaiming layout space). Persisted in UI config. ---- */
function makePanelVisToggle(toggleId, labelId, bodyClass, configKey, onShow) {
  const toggle = document.getElementById(toggleId);
  const label = document.getElementById(labelId);

  // Reflects toggle.checked into the DOM only; split from apply() so initial sync
  // doesn't fire onShow before this panel's elements exist.
  function syncVisualState() {
    const visible = toggle.checked;
    document.body.classList.toggle(bodyClass, !visible);
    label.classList.toggle('active', visible);
  }

  function apply() {
    syncVisualState();
    saveUIConfig({ [configKey]: toggle.checked });
    if (toggle.checked && typeof onShow === 'function') onShow();
  }

  if (typeof savedUIConfig[configKey] === 'boolean') toggle.checked = savedUIConfig[configKey];
  syncVisualState(); // apply initial hidden/visible state before any user interaction
  toggle.addEventListener('change', apply);
  return apply;
}

const applyDebugToolsVisibility = makePanelVisToggle(
  'debugToolsVisToggle', 'debugToolsVisLabel', 'hide-debug-tools', 'showDebugTools',
  () => refreshDebugTools()
);
const applyVisualToolsVisibility = makePanelVisToggle(
  'visualToolsVisToggle', 'visualToolsVisLabel', 'hide-visual-tools', 'showVisualTools',
  () => refreshDebugTools()
);
const applyFrameActivityVisibility = makePanelVisToggle(
  'frameActivityVisToggle', 'frameActivityVisLabel', 'hide-frame-activity', 'showFrameActivity',
  () => { drawFrameActivity(); drawFrameAnatomy(); drawLineAnatomy(); }
);

/* ---- 1. VRAM tile viewer: every tile in a VRAM bank, raw, greyscale (no palette applied).
   CGB has two 384-tile banks; a bank selector below (CGB ROMs only) picks which is shown. ---- */
let tileViewerBank = 0;
// Decodes one pixel of a GB tile row into a palette-agnostic grayscale shade (0->white,
// 3->black). Shared by the Sprite Sheet viewer and the Tile Inspector, which both render
// raw 2bpp tile data without a real BG/OBJ palette applied.
function tileRowGrayShade(lo, hi, px) {
  const bit = 7 - px;
  const colorNum = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  return 255 - colorNum * 85;
}

function drawTileViewer() {
  const cgb = emulator.instrumentation.isCGBRun();
  tvBankRow.style.display = cgb ? 'inline' : 'none';
  const vram = emulator.instrumentation.readVRAM(cgb ? tileViewerBank : 0);
  const data = tileViewerImageData.data;

  // Fill with the grid-line color first; tile pixels painted over it leave only the gaps visible.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 42; data[i + 1] = 42; data[i + 2] = 50; data[i + 3] = 255;
  }

  for (let tile = 0; tile < 384; tile++) {
    const col = tile % TV_COLS, row = Math.floor(tile / TV_COLS);
    const originX = TV_GAP + col * TV_PITCH, originY = TV_GAP + row * TV_PITCH;
    const base = tile * 16;
    for (let py = 0; py < 8; py++) {
      const lo = vram[base + py * 2], hi = vram[base + py * 2 + 1];
      for (let px = 0; px < 8; px++) {
        const shade = tileRowGrayShade(lo, hi, px);
        // Supersample: each source pixel becomes a TV_SCALE x TV_SCALE block.
        for (let sy = 0; sy < TV_SCALE; sy++) {
          for (let sx = 0; sx < TV_SCALE; sx++) {
            const idx = ((originY + py * TV_SCALE + sy) * TV_W + (originX + px * TV_SCALE + sx)) * 4;
            data[idx] = shade; data[idx + 1] = shade; data[idx + 2] = shade; data[idx + 3] = 255;
          }
        }
      }
    }
  }
  tileViewerCtx.putImageData(tileViewerImageData, 0, 0);
}

const tvBankRow = document.getElementById('tvBankRow');
document.querySelectorAll('input[name="tvBank"]').forEach(r => {
  r.addEventListener('change', () => { tileViewerBank = parseInt(r.value, 10); drawTileViewer(); });
});

/* ---- 1b. Sprite Sheet hover: highlight the cell under the cursor, show tile index + VRAM
   address in a tooltip. Percentage-based positioning keeps it aligned when CSS-scaled. ---- */
function tileViewerCellAt(clientX, clientY) {
  const rect = tileViewerCanvas.getBoundingClientRect();
  const relX = clientX - rect.left, relY = clientY - rect.top;
  if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) return null;
  const col = Math.min(TV_COLS - 1, Math.max(0, Math.floor((relX / rect.width) * TV_W / TV_PITCH)));
  const row = Math.min(TV_ROWS - 1, Math.max(0, Math.floor((relY / rect.height) * TV_H / TV_PITCH)));
  return { col, row, tile: row * TV_COLS + col };
}

tileViewerCanvas.addEventListener('mousemove', (e) => {
  const cell = tileViewerCellAt(e.clientX, e.clientY);
  if (!cell) { tileViewerHover.style.display = 'none'; tileViewerTooltip.style.display = 'none'; return; }

  const leftPct = ((TV_GAP + cell.col * TV_PITCH) / TV_W) * 100;
  const topPct = ((TV_GAP + cell.row * TV_PITCH) / TV_H) * 100;
  const wPct = (TV_CELL / TV_W) * 100;
  const hPct = (TV_CELL / TV_H) * 100;
  tileViewerHover.style.left = leftPct + '%';
  tileViewerHover.style.top = topPct + '%';
  tileViewerHover.style.width = wPct + '%';
  tileViewerHover.style.height = hPct + '%';
  tileViewerHover.style.display = 'block';

  const addr = 0x8000 + cell.tile * 16;
  tileViewerTooltip.textContent = `Tile #${cell.tile}  \u2013  ${hex16(addr)}`;
  tileViewerTooltip.style.left = (e.clientX + 14) + 'px';
  tileViewerTooltip.style.top = (e.clientY + 14) + 'px';
  tileViewerTooltip.style.display = 'block';
});

tileViewerCanvas.addEventListener('mouseleave', () => {
  tileViewerHover.style.display = 'none';
  tileViewerTooltip.style.display = 'none';
});

// Click a cell to copy that tile's VRAM address to the clipboard.
tileViewerCanvas.addEventListener('click', (e) => {
  const cell = tileViewerCellAt(e.clientX, e.clientY);
  if (!cell) return;
  const addr = 0x8000 + cell.tile * 16;
  flashCopiedTooltip(tileViewerTooltip, hex16(addr));
});

/* ---- 2. Tile map viewer: full 32x32 map rendered with BG palette + viewport box ---- */

// Writes an opaque [r,g,b,255] pixel into an ImageData buffer at pixel index idx. Shared by
// every debug-view renderer that plots decoded BG/window pixels one at a time.
function plotRGB(data, idx, r, g, b) {
  data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
}

function setMapPixel(data, x, y, r, g, b) {
  x = ((x % 256) + 256) % 256; y = ((y % 256) + 256) % 256; // wrap into the 256x256 map
  plotRGB(data, (y * 256 + x) * 4, r, g, b);
}

function drawTileMap() {
  const ppu = emulator.ppu;
  const mapBase = tileMapSelect === '9800' ? 0x9800 : 0x9C00;
  const data = tileMapImageData.data;

  // instrumentation.bgWindowPixelRGB() handles the full tile lookup (index, bank, flip, palette).
  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const [r, g, b] = emulator.instrumentation.bgWindowPixelRGB(ppu, mapBase, tx * 8 + px, ty * 8 + py);
          plotRGB(data, ((ty * 8 + py) * 256 + (tx * 8 + px)) * 4, r, g, b);
        }
      }
    }
  }

  // Highlight the current viewport (SCX/SCY), wrapping around the map edges.
  const { scx, scy } = emulator.instrumentation.readPPUState();
  const vw = EMU_CORE_CONFIG.SCREEN.WIDTH, vh = EMU_CORE_CONFIG.SCREEN.HEIGHT;
  for (let x = 0; x < vw; x++) {
    setMapPixel(data, scx + x, scy, 255, 221, 0);
    setMapPixel(data, scx + x, scy + vh - 1, 255, 221, 0);
  }
  for (let y = 0; y < vh; y++) {
    setMapPixel(data, scx, scy + y, 255, 221, 0);
    setMapPixel(data, scx + vw - 1, scy + y, 255, 221, 0);
  }

  tileMapCtx.putImageData(tileMapImageData, 0, 0);
}

/* ---- 2c. Tile inspector: decode+render the 16 bytes at tileInspectAddr as an 8x8 tile.
   Uses peekByte() so this never triggers real side effects or CPU-activity tracking. */
function drawTileInspector() {
  const instr = emulator.instrumentation;
  const data = tileInspectImageData.data;
  for (let py = 0; py < 8; py++) {
    const lo = instr.peekByte((tileInspectAddr + py * 2) & 0xFFFF);
    const hi = instr.peekByte((tileInspectAddr + py * 2 + 1) & 0xFFFF);
    for (let px = 0; px < 8; px++) {
      const shade = tileRowGrayShade(lo, hi, px);
      const idx = (py * 8 + px) * 4;
      data[idx] = shade; data[idx + 1] = shade; data[idx + 2] = shade; data[idx + 3] = 255;
    }
  }
  tileInspectSrcCtx.putImageData(tileInspectImageData, 0, 0);
  tileInspectCtx.clearRect(0, 0, 128, 128);
  tileInspectCtx.drawImage(tileInspectSrcCanvas, 0, 0, 128, 128);

  const bytes = [];
  for (let i = 0; i < 16; i++) bytes.push(hex8(instr.peekByte((tileInspectAddr + i) & 0xFFFF)).slice(2));
  if (!tileInspectRangeEl.dataset.copied) {
    tileInspectRangeEl.textContent = `${hex16(tileInspectAddr)}\u2013${hex16((tileInspectAddr + 15) & 0xFFFF)}`;
  }
  if (!tileInspectBytesValEl.dataset.copied) {
    tileInspectBytesValEl.textContent = bytes.join(' ');
  }
}

function setTileInspectAddr(addr) {
  tileInspectAddr = addr & 0xFFFF;
  tileInspectAddrInput.value = hex16(tileInspectAddr);
  drawTileInspector();
}

tileInspectAddrInput.value = hex16(tileInspectAddr);

function commitTileInspectAddr() {
  const v = parseInt(tileInspectAddrInput.value.trim().replace(/^0x/i, ''), 16);
  if (Number.isNaN(v)) { tileInspectAddrInput.value = hex16(tileInspectAddr); return; }
  setTileInspectAddr(v);
}

tileInspectGoBtn.addEventListener('click', commitTileInspectAddr);
tileInspectAddrInput.addEventListener('keydown', e => { if (e.key === 'Enter') commitTileInspectAddr(); });
tileInspectPrevBtn.addEventListener('click', () => setTileInspectAddr(tileInspectAddr - 16));
tileInspectNextBtn.addEventListener('click', () => setTileInspectAddr(tileInspectAddr + 16));

function showTileInspectStatus(msg, ok) {
  clearTimeout(tileInspectPasteStatus._timeout);
  tileInspectPasteStatus.textContent = msg;
  tileInspectPasteStatus.classList.toggle('ok', ok);
  tileInspectPasteStatus.classList.toggle('err', !ok);
  tileInspectPasteStatus._timeout = setTimeout(() => { tileInspectPasteStatus.textContent = ''; }, 2500);
}

// Reads an address from the clipboard (e.g. copied via the Sprite Sheet or Sprites (OAM)
// tabs' click-to-copy) and jumps the inspector there. Accepts a bare/"0x"-prefixed hex value,
// pulling the first hex-looking token out of the clipboard text if there's extra content.
// Pulls the first hex-looking address out of clipboard text (bare or "0x"-prefixed).
function parseAddressFromClipboardText(text) {
  const match = text.trim().match(/(?:0x)?([0-9a-fA-F]{1,4})/);
  return match ? parseInt(match[1], 16) : null;
}

tileInspectPasteAddrBtn.addEventListener('click', async () => {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showTileInspectStatus('⚠ Clipboard access was blocked or denied.', false);
    return;
  }
  const addr = parseAddressFromClipboardText(text);
  if (addr === null) { showTileInspectStatus('⚠ Clipboard doesn\u2019t contain an address.', false); return; }
  setTileInspectAddr(addr);
  showTileInspectStatus(`✓ Jumped to ${hex16(tileInspectAddr)}.`, true);
});

// Runs automatically whenever the Inspector tab is opened: silently checks the clipboard for
// an address (e.g. one copied via the Sprite Sheet or Sprites (OAM) tabs' click-to-copy) and,
// if found, jumps there. Unlike the Paste addr button, failures stay silent - opening the tab
// shouldn't surface clipboard-permission noise, only a genuine hit is worth mentioning.
async function autoPasteTileInspectAddrFromClipboard() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  const addr = parseAddressFromClipboardText(text);
  if (addr === null) return;
  setTileInspectAddr(addr);
  showTileInspectStatus(`✓ Jumped to ${hex16(tileInspectAddr)} (from clipboard).`, true);
}

// Parses typed text into exactly 16 byte values (0-255). Accepts space/comma/newline
// separated hex pairs with optional "0x" prefixes (e.g. "3C 7E 42 ..." or "0x3C,0x7E,...")
// as well as one contiguous 32-hex-digit blob ("3C7E4242...") with no separators at all.
function parseHexByteList(text) {
  const cleaned = text.replace(/0x/gi, ' ');
  const tokens = cleaned.split(/[^0-9a-fA-F]+/).filter(Boolean);
  let bytes;
  if (tokens.length === 16 && tokens.every(t => t.length <= 2)) {
    bytes = tokens.map(t => parseInt(t, 16));
  } else {
    const blob = tokens.join('');
    if (blob.length !== 32) return null;
    bytes = [];
    for (let i = 0; i < 32; i += 2) bytes.push(parseInt(blob.slice(i, i + 2), 16));
  }
  if (bytes.length !== 16 || bytes.some(b => Number.isNaN(b) || b < 0 || b > 255)) return null;
  return bytes;
}

// Writes the 16 typed bytes at tileInspectAddr through the real MMU write path (same as the
// RAM editor), replacing the tile currently shown.
function commitTileInspectWrite() {
  const bytes = parseHexByteList(tileInspectBytesInput.value);
  if (!bytes) {
    showTileInspectStatus('⚠ Enter exactly 16 hex bytes.', false);
    return;
  }
  for (let i = 0; i < 16; i++) emulator.instrumentation.writeMemory((tileInspectAddr + i) & 0xFFFF, bytes[i]);
  drawTileInspector();
  showTileInspectStatus(`✓ Wrote 16 bytes at ${hex16(tileInspectAddr)}.`, true);
}

tileInspectWriteBtn.addEventListener('click', commitTileInspectWrite);
tileInspectBytesInput.addEventListener('keydown', e => { if (e.key === 'Enter') commitTileInspectWrite(); });

// Click the address range to copy just its start address; click the byte values to copy
// all 16 bytes as a space-separated hex string.
tileInspectRangeEl.addEventListener('click', () => flashCopiedInline(tileInspectRangeEl, hex16(tileInspectAddr)));
tileInspectBytesValEl.addEventListener('click', () => {
  if (tileInspectBytesValEl.dataset.copied) return; // already mid-flash; textContent is "Copied!" right now
  flashCopiedInline(tileInspectBytesValEl, tileInspectBytesValEl.textContent);
});

/* ---- 2c. Tile editor: paint pixels directly onto the tile shown above, writing straight
   through the real MMU write path (same as the RAM editor) so edits take effect immediately -
   lets you touch up an existing tile or, combined with Clear Tile, draw a brand new one. ---- */
tileInspectSwatches.forEach(sw => {
  sw.addEventListener('click', () => {
    tileInspectDrawColor = parseInt(sw.dataset.color, 10);
    tileInspectSwatches.forEach(s => s.classList.toggle('active', s === sw));
  });
});

tileInspectClearBtn.addEventListener('click', () => {
  for (let i = 0; i < 16; i++) emulator.instrumentation.writeMemory((tileInspectAddr + i) & 0xFFFF, 0x00);
  drawTileInspector();
  showTileInspectStatus(`✓ Cleared tile at ${hex16(tileInspectAddr)}.`, true);
});

// Sets one pixel's 2bpp color by rewriting its row's lo/hi byte pair, preserving the other 7
// pixels in that row.
function paintTileInspectPixel(col, row, color) {
  const rowLoAddr = (tileInspectAddr + row * 2) & 0xFFFF;
  const rowHiAddr = (tileInspectAddr + row * 2 + 1) & 0xFFFF;
  const instr = emulator.instrumentation;
  const bit = 7 - col;
  const mask = ~(1 << bit) & 0xFF;
  const lo = (instr.peekByte(rowLoAddr) & mask) | ((color & 1) << bit);
  const hi = (instr.peekByte(rowHiAddr) & mask) | (((color >> 1) & 1) << bit);
  instr.writeMemory(rowLoAddr, lo);
  instr.writeMemory(rowHiAddr, hi);
}

function tileInspectCellAt(clientX, clientY) {
  const rect = tileInspectCanvas.getBoundingClientRect();
  const relX = clientX - rect.left, relY = clientY - rect.top;
  if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) return null;
  const col = Math.min(7, Math.max(0, Math.floor((relX / rect.width) * 8)));
  const row = Math.min(7, Math.max(0, Math.floor((relY / rect.height) * 8)));
  return { col, row };
}

let tileInspectPainting = false;
let tileInspectLastPaintedCell = null;

function tileInspectPaintAt(clientX, clientY) {
  const cell = tileInspectCellAt(clientX, clientY);
  if (!cell) return;
  const key = cell.row * 8 + cell.col;
  if (tileInspectLastPaintedCell === key) return; // skip redundant writes to the same pixel
  tileInspectLastPaintedCell = key;
  paintTileInspectPixel(cell.col, cell.row, tileInspectDrawColor);
  drawTileInspector();
}

tileInspectCanvas.addEventListener('mousedown', (e) => {
  tileInspectPainting = true;
  tileInspectLastPaintedCell = null;
  tileInspectPaintAt(e.clientX, e.clientY);
});
tileInspectCanvas.addEventListener('mousemove', (e) => {
  if (tileInspectPainting) tileInspectPaintAt(e.clientX, e.clientY);
});
window.addEventListener('mouseup', () => { tileInspectPainting = false; tileInspectLastPaintedCell = null; });
tileInspectCanvas.addEventListener('mouseleave', () => { tileInspectLastPaintedCell = null; });

tileInspectCanvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  tileInspectLastPaintedCell = null;
  const t = e.touches[0];
  if (t) tileInspectPaintAt(t.clientX, t.clientY);
}, { passive: false });
tileInspectCanvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  if (t) tileInspectPaintAt(t.clientX, t.clientY);
}, { passive: false });
tileInspectCanvas.addEventListener('touchend', () => { tileInspectLastPaintedCell = null; });


/* ---- 2b. Layer viewer: background / window / sprites, each rendered independently at full
   frame resolution using the PPU's current registers. Window/sprites use transparent pixels
   where nothing is drawn. ---- */
const layerCanvasBG = document.getElementById('layerCanvasBG');
const layerCtxBG = layerCanvasBG.getContext('2d');
const layerImageDataBG = layerCtxBG.createImageData(EMU_CORE_CONFIG.SCREEN.WIDTH, EMU_CORE_CONFIG.SCREEN.HEIGHT);
const layerCanvasWindow = document.getElementById('layerCanvasWindow');
const layerCtxWindow = layerCanvasWindow.getContext('2d');
const layerImageDataWindow = layerCtxWindow.createImageData(EMU_CORE_CONFIG.SCREEN.WIDTH, EMU_CORE_CONFIG.SCREEN.HEIGHT);
const layerCanvasSprites = document.getElementById('layerCanvasSprites');
const layerCtxSprites = layerCanvasSprites.getContext('2d');
const layerImageDataSprites = layerCtxSprites.createImageData(EMU_CORE_CONFIG.SCREEN.WIDTH, EMU_CORE_CONFIG.SCREEN.HEIGHT);

const layerStatusBG = document.getElementById('layerStatusBG');
const layerStatusWindow = document.getElementById('layerStatusWindow');
const layerStatusSprites = document.getElementById('layerStatusSprites');

function fillLayerImage(imgData, r, g, b, a = 255) {
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
}

function setLayerStatus(el, blockEl, on, offReason) {
  el.textContent = on ? 'On' : `Off (${offReason})`;
  el.classList.toggle('off', !on);
  blockEl.classList.toggle('dimmed', !on);
}

document.querySelectorAll('.layer-download-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const canvas = document.getElementById(btn.dataset.layerCanvas);
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `layer-${btn.dataset.layerName}.webp`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }, 'image/webp');
  });
});

// Renders every on-screen sprite into an RGBA pixel buffer, using the same per-scanline
// candidate selection and priority rules as the real renderer (10-sprite-per-line cap
// included). Shared by the Layers > Sprites panel and the OAM composited view.
function renderSpriteLayerPixels(data, W, H) {
  const ppu = emulator.ppu; // still passed through to spritePixelRGB(), which needs the ppu handle itself
  const { lcdc } = emulator.instrumentation.readPPUState();
  const spriteHeight = (lcdc & 0x04) ? EMU_CORE_CONFIG.SPRITES.HEIGHT_TALL : EMU_CORE_CONFIG.SPRITES.HEIGHT_SMALL;
  for (let y = 0; y < H; y++) {
    const candidates = emulator.instrumentation.readSpritesForLine(y, spriteHeight);

    for (const s of candidates) {
      if (s.spriteX <= -8 || s.spriteX >= W) continue;
      const { lo, hi, xFlip } = s;

      for (let px = 0; px < 8; px++) {
        const sx = s.spriteX + px;
        if (sx < 0 || sx >= W) continue;
        const colorNum = emulator.instrumentation.spriteRowColorIndex(lo, hi, xFlip, px);
        if (colorNum === 0) continue; // color 0 is always transparent for sprites
        const [r, g, b] = emulator.instrumentation.spritePixelRGB(ppu, s.attrs, colorNum);
        plotRGB(data, (y * W + sx) * 4, r, g, b);
      }
    }
  }
}

function drawLayers() {
  const ppu = emulator.ppu; // still passed through to bgWindowPixelRGB(), which needs the ppu handle itself
  const { lcdc, scx, scy, wx: wxReg, wy } = emulator.instrumentation.readPPUState();
  const W = EMU_CORE_CONFIG.SCREEN.WIDTH, H = EMU_CORE_CONFIG.SCREEN.HEIGHT;

  /* ---- Background: covers the full frame when enabled, using the same pixel decode as
     the real renderer. ---- */
  const bgOn = !!(lcdc & 0x01);
  setLayerStatus(layerStatusBG, layerCanvasBG.closest('.layer-block'), bgOn, 'LCDC.0');
  if (!bgOn) {
    fillLayerImage(layerImageDataBG, 255, 255, 255); // matches real hardware: BG off = blank white
  } else {
    const bgTileMapBase = (lcdc & 0x08) ? 0x9C00 : 0x9800;
    const data = layerImageDataBG.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bgX = (x + scx) & 0xFF, bgY = (y + scy) & 0xFF;
        const [r, g, b] = emulator.instrumentation.bgWindowPixelRGB(ppu, bgTileMapBase, bgX, bgY);
        plotRGB(data, (y * W + x) * 4, r, g, b);
      }
    }
  }
  layerCtxBG.putImageData(layerImageDataBG, 0, 0);

  /* ---- Window: only draws where WX/WY place it; requires BG to be on. Static snapshot,
     using a plain y - WY per line rather than the renderer's live window-line counter. ---- */
  const winOn = bgOn && !!(lcdc & 0x20);
  setLayerStatus(layerStatusWindow, layerCanvasWindow.closest('.layer-block'), winOn, bgOn ? 'LCDC.5' : 'LCDC.0');
  fillLayerImage(layerImageDataWindow, 0, 0, 0, 0);
  if (winOn) {
    const wx = wxReg - 7;
    if (wx <= W - 1) {
      const winTileMapBase = (lcdc & 0x40) ? 0x9C00 : 0x9800;
      const data = layerImageDataWindow.data;
      for (let y = Math.max(wy, 0); y < H; y++) {
        const winY = y - wy;
        for (let x = Math.max(wx, 0); x < W; x++) {
          const [r, g, b] = emulator.instrumentation.bgWindowPixelRGB(ppu, winTileMapBase, x - wx, winY);
          plotRGB(data, (y * W + x) * 4, r, g, b);
        }
      }
    }
  }
  layerCtxWindow.putImageData(layerImageDataWindow, 0, 0);

  /* ---- Sprites: every on-screen OAM entry, with the real 10-per-line cap and priority,
     ignoring BG-priority occlusion so the full sprite layer stays visible. ---- */
  const sprOn = !!(lcdc & 0x02);
  setLayerStatus(layerStatusSprites, layerCanvasSprites.closest('.layer-block'), sprOn, 'LCDC.1');
  fillLayerImage(layerImageDataSprites, 0, 0, 0, 0);
  if (sprOn) {
    renderSpriteLayerPixels(layerImageDataSprites.data, W, H);
  }
  layerCtxSprites.putImageData(layerImageDataSprites, 0, 0);
}

/* ---- 3. OAM / sprite inspector: all 40 entries, decoded ---- */
function makeTd(text) { const td = document.createElement('td'); td.textContent = text; return td; }

// Screen-space X/Y for OAM entry i, and its tile-data offset (8x16 mode forces low tile bit to 0).
function oamSpriteGeometry(i, spriteHeight) {
  const entry = emulator.instrumentation.readOAM(i * 4, 4);
  const rawY = entry[0], rawX = entry[1];
  const spriteX = rawX - 8, spriteY = rawY - 16;
  const tileIndex = entry[2];
  const attrs = entry[3];
  let idxTile = tileIndex;
  if (spriteHeight === 16) idxTile &= 0xFE;
  return { spriteX, spriteY, tileIndex, idxTile, attrs };
}

/* ---- 3a. Composited sprite view: same rendering as Layers > Sprites, always drawn
   regardless of LCDC.1 since this tab inspects raw OAM data, not what's currently visible.
   Sprites only - no background/window layer underneath. ---- */
function drawOAMComposition() {
  const W = EMU_CORE_CONFIG.SCREEN.WIDTH, H = EMU_CORE_CONFIG.SCREEN.HEIGHT;
  const imgData = oamCompCtx.createImageData(W, H);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) { data[i] = 32; data[i + 1] = 32; data[i + 2] = 40; data[i + 3] = 255; }
  renderSpriteLayerPixels(data, W, H);
  oamCompCtx.putImageData(imgData, 0, 0);
}

// Finds the highest-priority sprite (lowest OAM index) whose bounding box covers (px, py).
function oamSpriteAt(px, py) {
  const { lcdc } = emulator.instrumentation.readPPUState();
  const spriteHeight = (lcdc & 0x04) ? 16 : 8;
  for (let i = 0; i < 40; i++) {
    const { spriteX, spriteY } = oamSpriteGeometry(i, spriteHeight);
    if (px >= spriteX && px < spriteX + 8 && py >= spriteY && py < spriteY + spriteHeight) {
      return { index: i, spriteX, spriteY, spriteHeight };
    }
  }
  return null;
}

oamCompCanvas.addEventListener('mousemove', (e) => {
  const W = EMU_CORE_CONFIG.SCREEN.WIDTH, H = EMU_CORE_CONFIG.SCREEN.HEIGHT;
  const rect = oamCompCanvas.getBoundingClientRect();
  const relX = e.clientX - rect.left, relY = e.clientY - rect.top;
  if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) {
    oamCompHover.style.display = 'none'; oamCompTooltip.style.display = 'none';
    return;
  }
  const px = Math.floor((relX / rect.width) * W), py = Math.floor((relY / rect.height) * H);
  const hit = oamSpriteAt(px, py);
  if (!hit) { oamCompHover.style.display = 'none'; oamCompTooltip.style.display = 'none'; return; }

  // Clamp the highlight box to the visible canvas area.
  const boxX = Math.max(0, hit.spriteX), boxY = Math.max(0, hit.spriteY);
  const boxRight = Math.min(W, hit.spriteX + 8), boxBottom = Math.min(H, hit.spriteY + hit.spriteHeight);
  oamCompHover.style.left = (boxX / W * 100) + '%';
  oamCompHover.style.top = (boxY / H * 100) + '%';
  oamCompHover.style.width = ((boxRight - boxX) / W * 100) + '%';
  oamCompHover.style.height = ((boxBottom - boxY) / H * 100) + '%';
  oamCompHover.style.display = 'block';

  oamCompTooltip.textContent = `Sprite #${hit.index}  \u2013  X:${hit.spriteX} Y:${hit.spriteY}  \u2013  ${hex16(0xFE00 + hit.index * 4)}`;
  oamCompTooltip.style.left = (e.clientX + 14) + 'px';
  oamCompTooltip.style.top = (e.clientY + 14) + 'px';
  oamCompTooltip.style.display = 'block';
});

oamCompCanvas.addEventListener('mouseleave', () => {
  oamCompHover.style.display = 'none';
  oamCompTooltip.style.display = 'none';
});

// Click a sprite to copy the VRAM address of the tile it's drawn from.
oamCompCanvas.addEventListener('click', (e) => {
  const W = EMU_CORE_CONFIG.SCREEN.WIDTH, H = EMU_CORE_CONFIG.SCREEN.HEIGHT;
  const rect = oamCompCanvas.getBoundingClientRect();
  const relX = e.clientX - rect.left, relY = e.clientY - rect.top;
  if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) return;
  const px = Math.floor((relX / rect.width) * W), py = Math.floor((relY / rect.height) * H);
  const hit = oamSpriteAt(px, py);
  if (!hit) return;
  const { idxTile } = oamSpriteGeometry(hit.index, hit.spriteHeight);
  const addr = 0x8000 + idxTile * 16;
  flashCopiedTooltip(oamCompTooltip, hex16(addr));
});

function drawOAMTable() {
  const ppu = emulator.ppu; // still passed through to spritePixelRGB(), which needs the ppu handle itself
  const { lcdc } = emulator.instrumentation.readPPUState();
  const spriteHeight = (lcdc & 0x04) ? 16 : 8;
  oamTableBody.innerHTML = '';

  for (let i = 0; i < 40; i++) {
    const entry = emulator.instrumentation.readOAM(i * 4, 4);
    const rawY = entry[0], rawX = entry[1];
    const spriteY = rawY - 16, spriteX = rawX - 8;
    const tileIndex = entry[2];
    const attrs = entry[3];
    const offscreen = spriteX <= -8 || spriteX >= EMU_CORE_CONFIG.SCREEN.WIDTH || spriteY <= -16 || spriteY >= EMU_CORE_CONFIG.SCREEN.HEIGHT;
    const xFlip = !!(attrs & 0x20), yFlip = !!(attrs & 0x40), behindBG = !!(attrs & 0x80);
    const cgb = emulator.instrumentation.isCGBRun();
    const vram = emulator.instrumentation.readVRAM((attrs & 0x08) ? 1 : 0);

    let idxTile = tileIndex;
    if (spriteHeight === 16) idxTile &= 0xFE;

    const c = document.createElement('canvas');
    c.width = 8; c.height = spriteHeight;
    const cctx = c.getContext('2d');
    const imgData = cctx.createImageData(8, spriteHeight);
    for (let row = 0; row < spriteHeight; row++) {
      let r2 = yFlip ? spriteHeight - 1 - row : row;
      let tileOffset = idxTile * 16;
      if (r2 >= 8) { tileOffset += 16; r2 -= 8; }
      const lo = vram[tileOffset + r2 * 2], hi = vram[tileOffset + r2 * 2 + 1];
      for (let px = 0; px < 8; px++) {
        const bit = xFlip ? px : 7 - px;
        const colorNum = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        const pidx = (row * 8 + px) * 4;
        if (colorNum === 0) { imgData.data[pidx + 3] = 0; continue; } // transparent
        const [r3, g3, b3] = emulator.instrumentation.spritePixelRGB(ppu, attrs, colorNum);
        imgData.data[pidx] = r3; imgData.data[pidx + 1] = g3; imgData.data[pidx + 2] = b3; imgData.data[pidx + 3] = 255;
      }
    }
    cctx.putImageData(imgData, 0, 0);

    const tr = document.createElement('tr');
    if (offscreen) tr.classList.add('offscreen');
    tr.dataset.tileAddr = hex16(0x8000 + idxTile * 16);
    const tdThumb = document.createElement('td');
    tdThumb.appendChild(c);
    tr.appendChild(tdThumb);
    tr.appendChild(makeTd(i));
    tr.appendChild(makeTd(spriteX));
    tr.appendChild(makeTd(spriteY));
    tr.appendChild(makeTd(hex8(tileIndex)));
    tr.appendChild(makeTd(cgb ? `OBJ${attrs & 0x07} Bank${(attrs & 0x08) ? 1 : 0}` : ((attrs & 0x10) ? 'OBP1' : 'OBP0')));
    tr.appendChild(makeTd(`${behindBG ? 'BG' : 'OBJ'} ${yFlip ? 'Y' : '-'}${xFlip ? 'X' : '-'}`));
    oamTableBody.appendChild(tr);
  }
}

// Click a row (event-delegated since the table body is rebuilt every redraw) to copy that
// sprite's tile VRAM address to the clipboard.
oamTableBody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.tileAddr) return;
  flashCopiedRow(tr, tr.dataset.tileAddr);
});

/* ---- 4. Palette viewer: BGP/OBP0/OBP1 swatches on DMG; all 8 BG + 8 OBJ palettes on CGB. ---- */
function drawPalettes() {
  paletteGrid.innerHTML = '';

  function addBlock(col, name, valLabel, colorFn) {
    const block = document.createElement('div');
    block.className = 'palette-block';

    const h3 = document.createElement('h3'); h3.textContent = name;
    const regVal = document.createElement('div'); regVal.className = 'reg-val'; regVal.textContent = valLabel;
    block.appendChild(h3); block.appendChild(regVal);

    const row = document.createElement('div'); row.className = 'swatch-row';
    for (let c = 0; c < 4; c++) {
      const [r, g, b] = colorFn(c);
      const sw = document.createElement('div'); sw.className = 'swatch';
      const chip = document.createElement('div'); chip.className = 'chip'; chip.style.background = `rgb(${r},${g},${b})`;
      const label = document.createElement('div'); label.className = 'label'; label.textContent = c;
      sw.appendChild(chip); sw.appendChild(label);
      row.appendChild(sw);
    }
    block.appendChild(row);
    col.appendChild(block);
  }

  function addColumn(title) {
    const col = document.createElement('div'); col.className = 'palette-col';
    const h4 = document.createElement('h4'); h4.className = 'palette-col-title'; h4.textContent = title;
    col.appendChild(h4);
    paletteGrid.appendChild(col);
    return col;
  }

  // Background palette(s) on the left, Object palette(s) on the right, for both DMG and CGB.
  const bgCol = addColumn('Background');
  const objCol = addColumn('Objects (Sprites)');

  if (emulator.instrumentation.isCGBRun()) {
    for (let p = 0; p < 8; p++) addBlock(bgCol, `BG ${p}`, '', (c) => emulator.instrumentation.paletteSwatchRGB(false, p, c));
    for (let p = 0; p < 8; p++) addBlock(objCol, `OBJ ${p}`, '', (c) => emulator.instrumentation.paletteSwatchRGB(true, p, c));
  } else {
    const { bgp, obp0, obp1 } = emulator.instrumentation.readPaletteRegisters();
    addBlock(bgCol, 'BGP', hex8(bgp), (c) => emulator.instrumentation.paletteSwatchRGB(false, bgp, c));
    addBlock(objCol, 'OBP0', hex8(obp0), (c) => emulator.instrumentation.paletteSwatchRGB(true, obp0, c));
    addBlock(objCol, 'OBP1', hex8(obp1), (c) => emulator.instrumentation.paletteSwatchRGB(true, obp1, c));
  }
}

/* ---- 4b. Per-channel oscilloscope: raw DAC waveform for each of the 4 sound channels ---- */
const SCOPE_COLORS = { 1: '#e0765a', 2: '#5ac2e0', 3: '#c25ae0', 4: '#a0c25a' };
const scopeCanvases = {
  1: document.getElementById('scopeCh1'),
  2: document.getElementById('scopeCh2'),
  3: document.getElementById('scopeCh3'),
  4: document.getElementById('scopeCh4'),
};

// Per-channel mute buttons: toggles emulator's channel-mute state, silencing both audio
// output and the scope trace for that channel. Persisted with the master sound settings.
const scopeMuteButtons = document.querySelectorAll('.scope-mute-btn');
scopeMuteButtons.forEach(btn => {
  const ch = Number(btn.dataset.ch);
  if (savedSoundConfig && Array.isArray(savedSoundConfig.channelMuted) && savedSoundConfig.channelMuted[ch]) {
    emulator.setChannelMuted(ch, true);
  }
  updateScopeMuteButton(btn, ch);
  btn.addEventListener('click', () => {
    emulator.setChannelMuted(ch, !emulator.getChannelMuted(ch));
    updateScopeMuteButton(btn, ch);
    saveSoundConfig();
  });
});

function updateScopeMuteButton(btn, ch) {
  const muted = emulator.getChannelMuted(ch);
  btn.textContent = muted ? '🔇' : '🔊';
  btn.title = (muted ? 'Unmute CH' : 'Mute CH') + (ch + 1);
  btn.classList.toggle('muted', muted);
  btn.closest('.scope-block').classList.toggle('muted', muted);
}

function drawScopeChannel(canvas, buffer, writePos, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Center reference line (a silent channel sits at the DAC's -1 level, not 0).
  ctx.strokeStyle = '#2a2a2a';
  ctx.beginPath();
  ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
  ctx.stroke();

  const n = buffer.length;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const idx = (writePos + i) % n; // walk the ring oldest-to-newest so the wave reads left-to-right
    const v = buffer[idx]; // roughly -1..1
    const x = (i / (n - 1)) * w;
    const y = h / 2 - v * (h / 2 - 3);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawOscilloscope() {
  const scope = emulator.instrumentation.readOscilloscope();
  drawScopeChannel(scopeCanvases[1], scope.ch1, scope.writePos, SCOPE_COLORS[1]);
  drawScopeChannel(scopeCanvases[2], scope.ch2, scope.writePos, SCOPE_COLORS[2]);
  drawScopeChannel(scopeCanvases[3], scope.ch3, scope.writePos, SCOPE_COLORS[3]);
  drawScopeChannel(scopeCanvases[4], scope.ch4, scope.writePos, SCOPE_COLORS[4]);
}

/* ---- 4c. Scanline timeline: PPU position within the 154-line frame, plus a zoomed-in view
   of the current line's OAM Search / Pixel Transfer / H-Blank split. ---- */
const SCANLINE_OAM = EMU_CORE_CONFIG.PPU_MODE_CYCLES.OAM_SEARCH;
const SCANLINE_TRANSFER = EMU_CORE_CONFIG.PPU_MODE_CYCLES.PIXEL_TRANSFER;
const SCANLINE_HBLANK = EMU_CORE_CONFIG.PPU_MODE_CYCLES.HBLANK;
const SCANLINE_LINE_CYCLES = EMU_CORE_CONFIG.FRAME.CYCLES_PER_LINE; // 456
const SCANLINE_VISIBLE_LINES = EMU_CORE_CONFIG.FRAME.VISIBLE_LINES, SCANLINE_VBLANK_LINES = EMU_CORE_CONFIG.FRAME.VBLANK_LINES;
const SCANLINE_TOTAL_LINES = EMU_CORE_CONFIG.FRAME.TOTAL_LINES;         // 154
const SCANLINE_FRAME_CYCLES = EMU_CORE_CONFIG.FRAME.CYCLES_PER_FRAME;   // 70224
const GB_CLOCK_HZ = EMU_CORE_CONFIG.CLOCK_HZ;

const frameTimelineCanvas = document.getElementById('frameTimelineCanvas');
const lineTimelineCanvas = document.getElementById('lineTimelineCanvas');
const scanlineStatsEl = document.getElementById('scanlineStats');

// Color-coded PPU-mode legend (Mode 2/3/0/1), shared by the Scanline Timeline tool's
// "current scanline" chart and the Frame Anatomy tool's "line anatomy" chart — identical
// except for how precisely V-Blank's duration is spelled out.
function ppuModeLegendHTML(vblankLabel) {
  return `<span><i style="background:#e0b45a"></i>Mode 2: OAM Search (80T)</span>
    <span><i style="background:#5ac2e0"></i>Mode 3: Pixel Transfer (172T)</span>
    <span><i style="background:#4a4a55"></i>Mode 0: H-Blank (204T)</span>
    <span><i style="background:#8a5ac2"></i>Mode 1: V-Blank (${vblankLabel})</span>`;
}
document.getElementById('lineTimelineLegend').innerHTML = ppuModeLegendHTML('whole line');
document.getElementById('lineAnatomyLegend').innerHTML = ppuModeLegendHTML('whole line, 456T');

function drawFrameTimeline(ppuState) {
  const ctx = frameTimelineCanvas.getContext('2d');
  const w = frameTimelineCanvas.width, h = frameTimelineCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const visibleW = w * (SCANLINE_VISIBLE_LINES / SCANLINE_TOTAL_LINES);
  ctx.fillStyle = '#5ac2e0'; ctx.fillRect(0, 0, visibleW, h);
  ctx.fillStyle = '#8a5ac2'; ctx.fillRect(visibleW, 0, w - visibleW, h);

  // Tick marks every 16 lines
  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  for (let line = 16; line < SCANLINE_TOTAL_LINES; line += 16) {
    const x = Math.round((line / SCANLINE_TOTAL_LINES) * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  // Playhead: current scanline
  const playX = (ppuState.ly / SCANLINE_TOTAL_LINES) * w;
  const playW = Math.max(2, w / SCANLINE_TOTAL_LINES);
  ctx.fillStyle = '#ffdd00';
  ctx.fillRect(playX, 0, playW, h);

  ctx.font = '10px Consolas, monospace';
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';  ctx.fillText('0', 3, h - 4);
  ctx.textAlign = 'right'; ctx.fillText('143', visibleW - 3, h - 4);
  ctx.textAlign = 'left';  ctx.fillText('144', visibleW + 3, h - 4);
  ctx.textAlign = 'right'; ctx.fillText('153', w - 3, h - 4);
}

function drawLineTimeline(ppuState) {
  const ctx = lineTimelineCanvas.getContext('2d');
  const w = lineTimelineCanvas.width, h = lineTimelineCanvas.height;
  ctx.clearRect(0, 0, w, h);

  if (ppuState.mode === 1) {
    // V-Blank: single mode for the whole 456-cycle line
    ctx.fillStyle = '#8a5ac2';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('V-Blank line — no OAM/Transfer/H-Blank split here', w / 2, h / 2);
    return;
  }

  const oamW = (SCANLINE_OAM / SCANLINE_LINE_CYCLES) * w;
  const transferW = (SCANLINE_TRANSFER / SCANLINE_LINE_CYCLES) * w;
  const hblankW = w - oamW - transferW;

  ctx.fillStyle = '#e0b45a'; ctx.fillRect(0, 0, oamW, h);
  ctx.fillStyle = '#5ac2e0'; ctx.fillRect(oamW, 0, transferW, h);
  ctx.fillStyle = '#4a4a55'; ctx.fillRect(oamW + transferW, 0, hblankW, h);

  const [segStart, segWidth, modeTotal] =
    ppuState.mode === 2 ? [0, oamW, SCANLINE_OAM] :
    ppuState.mode === 3 ? [oamW, transferW, SCANLINE_TRANSFER] :
                      [oamW + transferW, hblankW, SCANLINE_HBLANK];
  const frac = Math.min(1, ppuState.modeClock / modeTotal);
  ctx.fillStyle = '#ffdd00';
  ctx.fillRect(Math.max(0, segStart + frac * segWidth - 1.5), 0, 3, h);
}

function scanlineStat(label, value) {
  return `<div class="scanline-stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function drawScanlineStats(ppuState) {
  const ly = ppuState.ly, mode = ppuState.mode;
  const modeNames  = { 0: 'H-Blank', 1: 'V-Blank', 2: 'OAM Search', 3: 'Pixel Transfer' };
  const modeTotals = { 0: SCANLINE_HBLANK, 1: SCANLINE_LINE_CYCLES, 2: SCANLINE_OAM, 3: SCANLINE_TRANSFER };
  const modeClock = Math.min(ppuState.modeClock, modeTotals[mode]);

  const intraLine =
    mode === 2 ? modeClock :
    mode === 3 ? SCANLINE_OAM + modeClock :
    mode === 0 ? SCANLINE_OAM + SCANLINE_TRANSFER + modeClock :
    modeClock; // mode 1, V-Blank
  const cyclesIntoFrame = ly * SCANLINE_LINE_CYCLES + intraLine;
  const framePct = (cyclesIntoFrame / SCANLINE_FRAME_CYCLES * 100).toFixed(1);
  const usIntoFrame = (cyclesIntoFrame / GB_CLOCK_HZ * 1e6).toFixed(0);

  scanlineStatsEl.innerHTML =
    scanlineStat('Scanline (LY)', `${ly} / 153`) +
    scanlineStat('PPU mode', `${mode} · ${modeNames[mode]}`) +
    scanlineStat('Cycles into mode', `${modeClock} / ${modeTotals[mode]} T`) +
    scanlineStat('Cycles into frame', `${cyclesIntoFrame} / ${SCANLINE_FRAME_CYCLES} T`) +
    scanlineStat('Frame progress', `${framePct}%`) +
    scanlineStat('Time into frame', `${usIntoFrame} µs`);
}

function drawScanlineTimeline() {
  const ppuState = emulator.instrumentation.readPPUState();
  drawFrameTimeline(ppuState);
  drawLineTimeline(ppuState);
  drawScanlineStats(ppuState);
}

/* ---- 4d. RTC (MBC3 real-time clock) viewer: for MBC3+TIMER carts (0x0F/0x10) ---- */
function pad2(n) { return String(n).padStart(2, '0'); }
function rtcClamp(v, lo, hi) {
  let n = Math.floor(Number(v));
  if (!Number.isFinite(n)) n = lo;
  return Math.min(hi, Math.max(lo, n));
}

// Clock correction: offsets some games apply on top of raw RTC (e.g. Pokémon G/S/C).
// Added when the clock is set; persisted per save file.
const rtcCorrectionStore = makePersistedConfig('jsgb-config:rtc-correction', { h: 0, m: 0 });
function loadRtcCorrection() { return rtcCorrectionStore.load(); }
function saveRtcCorrection(partial) { rtcCorrectionStore.save(partial); }

// Like rtcClamp, but blank/NaN falls back to 0 (signed range)
function rtcClampSigned(v, lo, hi) {
  let n = Math.floor(Number(v));
  if (!Number.isFinite(n)) n = 0;
  return Math.min(hi, Math.max(lo, n));
}

(function initRtcCorrectionInputs() {
  const saved = loadRtcCorrection();
  rtcInputCorrectionH.value = saved.h;
  rtcInputCorrectionM.value = saved.m;
  rtcInputCorrectionH.addEventListener('input', () => { if (rtcUsable()) drawRTC(); });
  rtcInputCorrectionM.addEventListener('input', () => { if (rtcUsable()) drawRTC(); });
  rtcInputCorrectionH.addEventListener('change', () => {
    saveRtcCorrection({ h: rtcClampSigned(rtcInputCorrectionH.value, -23, 23) });
  });
  rtcInputCorrectionM.addEventListener('change', () => {
    saveRtcCorrection({ m: rtcClampSigned(rtcInputCorrectionM.value, -59, 59) });
  });
})();

// Reads the correction fields as signed hours/minutes
function getRtcCorrectionSeconds() {
  const h = rtcClampSigned(rtcInputCorrectionH.value, -23, 23);
  const m = rtcClampSigned(rtcInputCorrectionM.value, -59, 59);
  return h * 3600 + m * 60;
}

// Applies the correction offset to an h/m/s/day tuple, wrapping into a signed day delta
function applyRtcCorrection(hours, minutes, seconds, days, sign = 1) {
  const correctionSecs = getRtcCorrectionSeconds() * sign;
  const totalSecs = hours * 3600 + minutes * 60 + seconds + correctionSecs;
  const dayDelta = Math.floor(totalSecs / 86400);
  const secOfDay = ((totalSecs % 86400) + 86400) % 86400;
  return {
    hours: Math.floor(secOfDay / 3600),
    minutes: Math.floor((secOfDay % 3600) / 60),
    seconds: secOfDay % 60,
    days: days + dayDelta,
  };
}

let rtcInfoTimer = null;
function setRtcInfo(msg) {
  rtcInfoEl.textContent = msg;
  clearTimeout(rtcInfoTimer);
  rtcInfoTimer = setTimeout(() => { rtcInfoEl.textContent = ''; }, 2500);
}

// Fills "Set clock" fields from the live clock. Called on tab open / Zero clock only,
// not on every redraw, so mid-edit fields aren't clobbered.
function syncRtcInputsFromLive() {
  if (!rtcUsable()) return;
  const rtc = emulator.instrumentation.readRTCState();
  rtcInputDays.value = ((rtc.dh & 0x01) << 8) | rtc.dl;
  rtcInputHours.value = rtc.h;
  rtcInputMinutes.value = rtc.m;
  rtcInputSeconds.value = rtc.s;
  rtcInputHalt.checked = (rtc.dh & 0x40) !== 0;
}

function drawRTC() {
  const usable = rtcUsable();
  rtcEmptyEl.classList.toggle('hidden', usable);
  rtcContentEl.classList.toggle('hidden', !usable);
  if (!usable) return;

  const rtc = emulator.instrumentation.readRTCState(); // catches counters up to "now"
  const halted = (rtc.dh & 0x40) !== 0;
  const carry = (rtc.dh & 0x80) !== 0;
  const days = ((rtc.dh & 0x01) << 8) | rtc.dl;

  // Live registers hold the corrected time; subtract the correction back out for display.
  const plain = applyRtcCorrection(rtc.h, rtc.m, rtc.s, days, -1);
  rtcClockDaysEl.textContent = `Day ${plain.days}`;
  rtcClockTimeEl.textContent = `${pad2(plain.hours)}:${pad2(plain.minutes)}:${pad2(plain.seconds)}`;

  rtcFlagHaltEl.classList.toggle('active', halted);
  rtcFlagCarryEl.classList.toggle('active', carry);

  const l = rtc.latched;
  rtcRegsEl.textContent =
    `live  S:${hex8(rtc.s)} M:${hex8(rtc.m)} H:${hex8(rtc.h)} DL:${hex8(rtc.dl)} DH:${hex8(rtc.dh)}` +
    `   latched (what the game reads)  S:${hex8(l.s)} M:${hex8(l.m)} H:${hex8(l.h)} DL:${hex8(l.dl)} DH:${hex8(l.dh)}`;
}

btnRtcApply.addEventListener('click', () => {
  if (!rtcUsable()) return;
  const rawDays = rtcClamp(rtcInputDays.value, 0, 511);
  const rawHours = rtcClamp(rtcInputHours.value, 0, 23);
  const rawMinutes = rtcClamp(rtcInputMinutes.value, 0, 59);
  const rawSeconds = rtcClamp(rtcInputSeconds.value, 0, 59);
  const halt = rtcInputHalt.checked;

  // Apply the clock correction, then clamp the day count to 0-511.
  const corrected = applyRtcCorrection(rawHours, rawMinutes, rawSeconds, rawDays);
  const days = rtcClamp(corrected.days, 0, 511);

  emulator.instrumentation.setRTCTime(corrected.seconds, corrected.minutes, corrected.hours, days, halt);

  setRtcInfo('Clock set.');
  refreshDebugTools();
});

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

btnRtcNow.addEventListener('click', () => {
  if (!rtcUsable()) return;
  // Re-base the day counter to today's weekday so (day counter % 7) matches reality.
  const now = new Date();
  const rawWeekday = now.getDay(); // 0-6, Sunday = 0

  // Apply the clock correction; day-delta wraps mod 7 instead of clamping to 0-511.
  const corrected = applyRtcCorrection(now.getHours(), now.getMinutes(), now.getSeconds(), rawWeekday);
  const hours = corrected.hours, minutes = corrected.minutes, seconds = corrected.seconds;
  const weekday = ((corrected.days % 7) + 7) % 7;

  emulator.instrumentation.setRTCToWeekday(seconds, minutes, hours, weekday);

  // Fill the Set Clock boxes with the plain system time, not the corrected hardware value.
  rtcInputDays.value = rawWeekday;
  rtcInputHours.value = now.getHours();
  rtcInputMinutes.value = now.getMinutes();
  rtcInputSeconds.value = now.getSeconds();
  rtcInputHalt.checked = false;

  setRtcInfo(`Clock set to today (${WEEKDAY_NAMES[weekday]}), ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.`);
  refreshDebugTools();
});

btnRtcClearCarry.addEventListener('click', () => {
  if (!rtcUsable()) return;
  emulator.instrumentation.clearRTCCarry();
  setRtcInfo('Day-carry flag cleared.');
  refreshDebugTools();
});

btnRtcZero.addEventListener('click', () => {
  if (!rtcUsable()) return;
  emulator.instrumentation.zeroRTC();
  syncRtcInputsFromLive();
  setRtcInfo('Clock zeroed.');
  refreshDebugTools();
});

/* ---- 5. Live disassembler: decodes the bytes around PC into mnemonics ---- */
/* ---- Frame Activity: emulated-hardware content per frame, not JS/host timing ----
   Left canvas: instructions per recent frame, click a bar to select it. Middle canvas: the
   selected frame's 154 scanlines with event markers and a sprites-per-line sparkline, click
   to select a line. Bottom canvas: that scanline's mode structure plus its recorded events. */
const frameActivityCanvas = document.getElementById('frameActivityCanvas');
const frameAnatomyCanvas = document.getElementById('frameAnatomyCanvas');
const lineAnatomyCanvas = document.getElementById('lineAnatomyCanvas');
const frameActivityCountEl = document.getElementById('frameActivityCount');
const frameAnatomyIndexEl = document.getElementById('frameAnatomyIndex');
const frameAnatomyStatsEl = document.getElementById('frameAnatomyStats');
const lineAnatomyIndexEl = document.getElementById('lineAnatomyIndex');
const lineAnatomyFrameIndexEl = document.getElementById('lineAnatomyFrameIndex');
const lineAnatomyStatsEl = document.getElementById('lineAnatomyStats');

let selectedFrameStatsIndex = null; // frameStats.index, or null to follow the latest frame
let selectedAnatomyLine = null;     // scanline 0-153, or null if none chosen

function getFrameActivitySlice() {
  const hist = emulator.stats.frameStatsHistory;
  return hist.slice(Math.max(0, hist.length - emulator.stats.FRAME_STATS_HISTORY));
}

// The frame entry shown by both "Anatomy of frame" and "Anatomy of line".
function getSelectedAnatomyEntry() {
  const hist = emulator.stats.frameStatsHistory;
  if (hist.length === 0) return null;
  return (selectedFrameStatsIndex === null ? null : hist.find(f => f.index === selectedFrameStatsIndex))
         || hist[hist.length - 1];
}

// Shared by the Frame Activity / Frame Anatomy / Line Anatomy panels: grabs the 2D context,
// reads the canvas's pixel dimensions, and clears it to the panels' common dark background.
function setupDebugCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawFrameActivity() {
  const { ctx, w, h } = setupDebugCanvas(frameActivityCanvas);

  const slice = getFrameActivitySlice();
  frameActivityCountEl.textContent = slice.length;
  if (slice.length === 0) return;

  // Manual max to avoid extra array allocations from map()/spread
  let maxInstr = 1;
  for (let i = 0; i < slice.length; i++) if (slice[i].instructions > maxInstr) maxInstr = slice[i].instructions;
  const barW = w / slice.length;
  const selected = selectedFrameStatsIndex === null ? slice[slice.length - 1].index : selectedFrameStatsIndex;

  for (let i = 0; i < slice.length; i++) {
    const f = slice[i];
    const barH = Math.max(1, (f.instructions / maxInstr) * (h - 4));
    ctx.fillStyle = f.index === selected ? '#ffdd00' : '#5ac2e0';
    ctx.fillRect(i * barW + 1, h - barH, Math.max(1, barW - 2), barH);
  }
}

// Clicking a bar pins the anatomy view to that frame; the previously-selected line carries over.
frameActivityCanvas.addEventListener('click', (e) => {
  const slice = getFrameActivitySlice();
  if (slice.length === 0) return;
  const rect = frameActivityCanvas.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  const i = Math.min(slice.length - 1, Math.max(0, Math.floor(frac * slice.length)));
  selectedFrameStatsIndex = slice[i].index;
  drawFrameActivity();
  drawFrameAnatomy();
  drawLineAnatomy();
});

const FRAME_EVENT_COLORS = {
  'int-vblank': '#e05a5a', 'int-stat': '#e0785a', 'int-timer': '#e0a45a',
  'int-serial': '#e0c85a', 'int-joypad': '#e0e05a',
  dma: '#5ac2e0', bank: '#8a5ac2', apu: '#4ade80',
};
const FRAME_EVENT_LABELS = {
  'int-vblank': 'V-Blank interrupt', 'int-stat': 'STAT interrupt', 'int-timer': 'Timer interrupt',
  'int-serial': 'Serial interrupt', 'int-joypad': 'Joypad interrupt',
  dma: 'OAM DMA', bank: 'Bank switch', apu: 'APU trigger',
};

function drawFrameAnatomy() {
  const { ctx, w, h } = setupDebugCanvas(frameAnatomyCanvas);

  const entry = getSelectedAnatomyEntry();
  if (!entry) {
    frameAnatomyIndexEl.textContent = '—';
    frameAnatomyStatsEl.textContent = 'Load a ROM and let it run to see frame data.';
    return;
  }
  frameAnatomyIndexEl.textContent = '#' + entry.index;

  // Background split: visible lines 0-143 vs V-Blank lines 144-153
  const visibleW = w * (144 / 154);
  ctx.fillStyle = '#20303a'; ctx.fillRect(0, 0, visibleW, h);
  ctx.fillStyle = '#2a2036'; ctx.fillRect(visibleW, 0, w - visibleW, h);

  // Sprites-per-line sparkline (0-10, hardware's per-line cap)
  ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let line = 0; line < 144; line++) {
    const x = (line / 154) * w;
    const y = h - 3 - (entry.spritesPerLine[line] / 10) * (h - 8);
    if (line === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Event ticks at the scanline they fired on
  for (const ev of entry.events) {
    const x = (ev.line / 154) * w;
    ctx.fillStyle = FRAME_EVENT_COLORS[ev.kind] || '#fff';
    ctx.fillRect(x - 1.5, 2, 3, h - 4);
  }

  // Highlight the selected scanline
  if (selectedAnatomyLine !== null) {
    const lineW = w / 154;
    ctx.strokeStyle = '#ffdd00'; ctx.lineWidth = 2;
    ctx.strokeRect(selectedAnatomyLine * lineW + 1, 1, lineW - 2, h - 2);
  }

  const ints = entry.interrupts;
  const intTotal = ints.vblank + ints.stat + ints.timer + ints.serial + ints.joypad;
  frameAnatomyStatsEl.innerHTML =
    `<span><b>${entry.instructions.toLocaleString()}</b> instructions</span>` +
    `<span><b>${intTotal}</b> interrupts (V-Blank ${ints.vblank}, STAT ${ints.stat}, Timer ${ints.timer}, Serial ${ints.serial}, Joypad ${ints.joypad})</span>` +
    `<span><b>${entry.spritesTotal}</b> sprites drawn (peak ${entry.spritesMaxLine}/line)</span>` +
    `<span><b>${entry.dma}</b> OAM DMA</span>` +
    `<span><b>${entry.bankSwitches}</b> bank switches</span>` +
    `<span><b>${entry.apuTriggers}</b> APU triggers</span>`;
}

// Clicking a scanline pins "Anatomy of line" below it to that line.
frameAnatomyCanvas.addEventListener('click', (e) => {
  if (!getSelectedAnatomyEntry()) return;
  const rect = frameAnatomyCanvas.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  selectedAnatomyLine = Math.min(153, Math.max(0, Math.floor(frac * 154)));
  drawFrameAnatomy();
  drawLineAnatomy();
});

// Draws the selected scanline's 456T mode timeline plus its recorded sprites/events.
function drawLineAnatomy() {
  const { ctx, w, h } = setupDebugCanvas(lineAnatomyCanvas);

  const entry = getSelectedAnatomyEntry();
  if (!entry || selectedAnatomyLine === null) {
    lineAnatomyIndexEl.textContent = '—';
    lineAnatomyFrameIndexEl.textContent = '—';
    lineAnatomyStatsEl.textContent = 'Click a scanline in the "Anatomy of frame" chart above to see its details.';
    return;
  }
  const line = selectedAnatomyLine;
  lineAnatomyIndexEl.textContent = line;
  lineAnatomyFrameIndexEl.textContent = '#' + entry.index;

  if (line < 144) {
    // Mode 2 (80T) -> Mode 3 (172T) -> Mode 0 (204T), to scale
    const modes = [
      { t: 80,  color: '#e0b45a' },
      { t: 172, color: '#5ac2e0' },
      { t: 204, color: '#4a4a55' },
    ];
    let x = 0;
    for (const m of modes) {
      const mw = (m.t / 456) * w;
      ctx.fillStyle = m.color; ctx.fillRect(x, 0, mw, h);
      x += mw;
    }
  } else {
    // V-Blank lines are Mode 1 for the entire 456T
    ctx.fillStyle = '#8a5ac2'; ctx.fillRect(0, 0, w, h);
  }

  const events = entry.events.filter(ev => ev.line === line);
  const sprites = line < 144 ? entry.spritesPerLine[line] : 0;
  const pctOfLine = (t) => ((t / 456) * 100).toFixed(1) + '%';
  const pctOfFrame = (t) => ((t / 70224) * 100).toFixed(2) + '%';

  let html = '';
  if (line < 144) {
    html += `<span><b>Visible line</b> — Mode 2 80T (${pctOfLine(80)} of line, ${pctOfFrame(80)} of frame) &rarr; `
          + `Mode 3 172T (${pctOfLine(172)}, ${pctOfFrame(172)}) &rarr; Mode 0 204T (${pctOfLine(204)}, ${pctOfFrame(204)})</span>`;
    html += `<span><b>${sprites}</b>/10 sprites drawn on this line</span>`;
  } else {
    html += `<span><b>V-Blank line</b> — Mode 1 for the whole 456T (${pctOfFrame(456)} of frame)</span>`;
  }
  if (events.length === 0) {
    html += `<span>No interrupt/DMA/bank/APU events recorded on this line this frame.</span>`;
  } else {
    // Group same-kind events into a single "x N" entry
    const counts = {};
    for (const ev of events) counts[ev.kind] = (counts[ev.kind] || 0) + 1;
    for (const kind of Object.keys(counts)) {
      html += `<span><i style="background:${FRAME_EVENT_COLORS[kind] || '#fff'};width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:5px;"></i>`
            + `${FRAME_EVENT_LABELS[kind] || kind}${counts[kind] > 1 ? ' &times;' + counts[kind] : ''}</span>`;
    }
  }
  lineAnatomyStatsEl.innerHTML = html;
}

// Cache of the previous frame's "before PC" resync result for the Disassembly panel. On
// straight-line execution, slides the window forward instead of re-running the resync search.
// Falls back to a full resync on jumps, single-steps, breakpoints, or a new ROM.
let disasmResyncCache = null; // { pc, rom, beforeLines, currentText, nextExpectedPc } or null

function drawDisassembly() {
  if (!lastROMBytes) { disasmList.innerHTML = '<div class="disasm-empty">Load a ROM to see disassembly.</div>'; disasmResyncCache = null; return; }
  const pc = emulator.instrumentation.readRegisters().PC;
  const rom = emulator.instrumentation.readROM();
  const COUNT_BEFORE = 5, COUNT_AFTER = 9, MAX_LOOKBACK = 12;

  let beforeLines;
  const cache = disasmResyncCache;
  if (cache && cache.rom === rom && cache.pc === pc) {
    // PC hasn't moved (e.g. HALTed) - reuse as-is.
    beforeLines = cache.beforeLines;
  } else if (cache && cache.rom === rom && cache.nextExpectedPc === pc) {
    // Straight-line advance: slide the window forward instead of re-resyncing.
    beforeLines = cache.beforeLines.slice(1);
    beforeLines.push({ addr: cache.pc, text: cache.currentText });
  } else {
    // GB code isn't self-synchronizing: try progressively shorter lookbacks and keep the
    // longest one that decodes forward and lands exactly back on PC.
    beforeLines = [];
    for (let back = MAX_LOOKBACK; back >= 1; back--) {
      let addr = pc - back;
      if (addr < 0) continue;
      const insns = [];
      while (addr < pc) {
        const { text, length } = emulator.instrumentation.disassembleAt(addr & 0xFFFF);
        insns.push({ addr: addr & 0xFFFF, text });
        addr += length;
      }
      if (addr === pc) { beforeLines = insns.slice(-COUNT_BEFORE); break; }
    }
  }

  const lines = beforeLines.map(l => ({ ...l, current: false }));
  let addr = pc;
  let currentText = null, currentLength = 0;
  for (let i = 0; i <= COUNT_AFTER; i++) {
    const { text, length } = emulator.instrumentation.disassembleAt(addr & 0xFFFF);
    lines.push({ addr: addr & 0xFFFF, text, current: i === 0 });
    if (i === 0) { currentText = text; currentLength = length; }
    addr += length;
  }

  disasmResyncCache = { pc, rom, beforeLines, currentText, nextExpectedPc: (pc + currentLength) & 0xFFFF };

  disasmList.innerHTML = lines.map(l =>
    `<div class="disasm-line${l.current ? ' current' : ''}">${hex16(l.addr)}&nbsp;&nbsp;${l.text}</div>`
  ).join('');

  if (lines.some(l => l.current)) {
    const cur = disasmList.querySelector('.disasm-line.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }
}

/* ---- Interrupts panel: IME/IE/IF status plus recently-serviced interrupt log ---- */
const INTERRUPT_SOURCES = [
  { name: 'V-Blank',  bit: 0, vector: 0x40 },
  { name: 'LCD STAT', bit: 1, vector: 0x48 },
  { name: 'Timer',    bit: 2, vector: 0x50 },
  { name: 'Serial',   bit: 3, vector: 0x58 },
  { name: 'Joypad',   bit: 4, vector: 0x60 },
];

function drawInterrupts() {
  if (!lastROMBytes) {
    intSummary.textContent = '—';
    intTable.innerHTML = '';
    intLog.innerHTML = '<div class="int-log-empty">No interrupts serviced yet.</div>';
    return;
  }
  const regs = emulator.instrumentation.readRegisters();
  const mbc = emulator.instrumentation.readMBCState();
  const ie = mbc.ie & 0x1F;
  const iff = mbc.io[0x0F] & 0x1F;

  intSummary.innerHTML =
    `<span class="int-ime ${regs.IME ? 'on' : 'off'}">IME ${regs.IME ? 'ON' : 'OFF'}</span>` +
    `<span class="int-reg">IE=${hex8(ie)}</span>` +
    `<span class="int-reg">IF=${hex8(iff)}</span>` +
    (regs.halted ? `<span class="int-halted">HALTed — waiting for an interrupt</span>` : '');

  intTable.innerHTML = INTERRUPT_SOURCES.map(src => {
    const enabled = (ie >> src.bit) & 1;
    const pending = (iff >> src.bit) & 1;
    return `<div class="int-row${pending && enabled ? ' int-row-firing' : ''}">` +
      `<span class="int-name">${src.name}</span>` +
      `<span class="int-vector">${hex16(src.vector)}</span>` +
      `<span class="int-badge ${enabled ? 'int-on' : 'int-off'}">IE ${enabled}</span>` +
      `<span class="int-badge ${pending ? 'int-pending' : 'int-off'}">IF ${pending}</span>` +
      `</div>`;
  }).join('');

  const log = emulator.stats.interruptLog;
  intLog.innerHTML = log.length === 0
    ? '<div class="int-log-empty">No interrupts serviced yet.</div>'
    : log.slice().reverse().map(e =>
        `<div class="int-log-line">frame ${e.frame}&nbsp;&nbsp;${INTERRUPT_SOURCES[e.bit].name} → ${hex16(INTERRUPT_SOURCES[e.bit].vector)}` +
        `&nbsp;&nbsp;(from ${hex16(e.pcBefore)})</div>`
      ).join('');
}

/* ---- Stack panel: a window of 16-bit words around SP, row-aligned to SP itself ---- */
function drawStack() {
  if (!lastROMBytes) { stackList.innerHTML = '<div class="disasm-empty">Load a ROM to see the stack.</div>'; stackSpReadout.textContent = '—'; return; }
  const sp = emulator.instrumentation.readRegisters().SP;
  const WORDS_ABOVE = 6, WORDS_BELOW = 22;

  stackSpReadout.textContent = `SP = ${hex16(sp)}  (top of stack — next POP/RET reads from here)`;

  const rows = emulator.instrumentation.walkStack(sp, WORDS_ABOVE, WORDS_BELOW)
    .map(({ addr, word, offsetWords }) => ({ addr, word, current: offsetWords === 0, below: offsetWords > 0 }));

  stackList.innerHTML = rows.map(r =>
    `<div class="disasm-line${r.current ? ' current' : ''}${r.below && !r.current ? ' stack-line-below' : ''}">` +
    `${hex16(r.addr)}&nbsp;&nbsp;${hex16(r.word)}${r.current ? '&nbsp;&nbsp;← SP' : ''}</div>`
  ).join('');

  const cur = stackList.querySelector('.disasm-line.current');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

/* ---- 5b. CPU registers editor: reads/writes CPU fields directly, no MMU involved ---- */

// Accepts an optional "0x" prefix; returns null (reject, keep old value) for non-hex input.
function parseHexInput(str, maxVal) {
  const clean = str.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(clean)) return null;
  const v = parseInt(clean, 16);
  if (Number.isNaN(v)) return null;
  return Math.max(0, Math.min(maxVal, v));
}

// Applies one 8/16-bit register field on blur/Enter. No-op while running (second line of
// defense in case a value was in flight when Start/Resume was pressed).
function commitRegInput(input) {
  const spec = REG_INPUTS.find(r => r.el === input);
  if (!emulator.running && spec) {
    const parsed = parseHexInput(input.value, spec.bits === 16 ? 0xFFFF : 0xFF);
    if (parsed !== null) emulator.instrumentation.writeRegister(spec.key, parsed);
  }
  drawRegisters();
}

function commitRegFlag(checkbox) {
  if (!emulator.running) {
    const spec = REG_FLAGS.find(r => r.el === checkbox);
    if (spec) emulator.instrumentation.writeRegister(spec.key, checkbox.checked);
  }
  drawRegisters();
}

REG_INPUTS.forEach(({ el }) => {
  el.addEventListener('blur', () => commitRegInput(el));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
});
REG_FLAGS.forEach(({ el }) => { el.addEventListener('change', () => commitRegFlag(el)); });

function drawRegisters() {
  const regs = emulator.instrumentation.readRegisters();
  const running = emulator.running;

  REG_INPUTS.forEach(({ el, key, bits }) => {
    // Only repaint fields that aren't currently focused, to avoid stomping on typing.
    if (document.activeElement !== el) el.value = bits === 16 ? hex16(regs[key]) : hex8(regs[key]);
    el.disabled = running;
  });

  REG_FLAGS.forEach(({ el, key }) => {
    el.checked = !!regs[key];
    el.disabled = running;
  });

  REG_DERIVED.BC.textContent = `BC = ${hex16(regs.BC)}`;
  REG_DERIVED.DE.textContent = `DE = ${hex16(regs.DE)}`;
  REG_DERIVED.HL.textContent = `HL = ${hex16(regs.HL)}`;

  regPausedNote.style.display = running ? '' : 'none';

  const ppuState = emulator.instrumentation.readPPUState();
  regIoReadout.textContent = `LY=${ppuState.ly}  Mode=${ppuState.mode}  LCDC=${hex8(ppuState.lcdc)}`;
}

drawRegisters(); // paint the boot-state register values immediately, before any ROM is loaded

/* ---- 6. Execution trace: scrollback of the last instructions actually executed ---- */

// Sizes #traceList to match the height of the neighboring main-content column. Only called
// while the Execution Trace tab is active; other panels keep their normal compact height.
function syncTraceListHeight() {
  const mainContent = document.querySelector('.main-content');
  const sidebar = document.querySelector('.debug-tools-sidebar');
  if (!mainContent || !sidebar) return;
  const mainHeight = mainContent.getBoundingClientRect().height;
  // Keep sidebar chrome (heading, tabs, controls) at natural size; stretch only the trace list.
  const chrome = sidebar.getBoundingClientRect().height - traceList.getBoundingClientRect().height;
  const target = Math.round(mainHeight - chrome);
  if (target > 0) {
    traceList.style.height = target + 'px';
    traceList.style.maxHeight = target + 'px';
  }
}

function isTraceAtBottom() {
  return traceList.scrollHeight - traceList.scrollTop - traceList.clientHeight < 24;
}

// Cache of decoded mnemonic + explanation per trace ring-buffer slot, keyed by (addr,b0,b1,b2)
// so a slot is only recomputed when its content actually changed.
const traceDecodeCache = new Array(emulator.instrumentation.TRACE_SIZE).fill(null);

function getTraceDecoded(idx, addr, b0, b1, b2) {
  const cached = traceDecodeCache[idx];
  if (cached && cached.addr === addr && cached.b0 === b0 && cached.b1 === b1 && cached.b2 === b2) {
    return cached;
  }
  const { text } = disassembleBytes((off) => (off === 0 ? b0 : off === 1 ? b1 : b2), addr);
  const explain = explainInstruction(text);
  const entry = { addr, b0, b1, b2, text, explain };
  traceDecodeCache[idx] = entry;
  return entry;
}

function drawTrace() {
  syncTraceListHeight();

  // Only live-update while pinned to the bottom; otherwise freeze the DOM so scrolled-up
  // content doesn't get swapped out under the user.
  if (!isTraceAtBottom() && traceList.childElementCount > 0 && !traceList.querySelector('.trace-empty')) {
    btnTraceFollow.style.display = '';
    traceFrozenNote.style.display = '';
    return;
  }
  btnTraceFollow.style.display = 'none';
  traceFrozenNote.style.display = 'none';

  const entries = emulator.instrumentation.getTraceEntries();
  if (entries.length === 0) { traceList.innerHTML = '<div class="trace-empty">No instructions executed yet.</div>'; return; }
  const recent = entries.slice(-200); // cap rendered rows; ring buffer holds more

  // Collapse consecutive entries sharing (addr, opcode) into a single "x N" row.
  const groups = [];
  for (const e of recent) {
    const last = groups[groups.length - 1];
    if (last && last.addr === e.addr && last.b0 === e.b0) { last.count++; last.last = e; }
    else groups.push({ addr: e.addr, b0: e.b0, b1: e.b1, b2: e.b2, idx: e.idx, count: 1, last: e });
  }

  traceList.innerHTML = groups.map((g, i) => {
    const { text, explain } = getTraceDecoded(g.idx, g.addr, g.b0, g.b1, g.b2);
    const isLatest = i === groups.length - 1;
    // Diff from the most recent occurrence in the run.
    const diff = g.last.diff;
    const repeatBadge = g.count > 1 ? `<span class="trace-repeat">× ${g.count}</span>` : '';
    return `<div class="trace-line${isLatest ? ' latest' : ''}">` +
             `<span class="trace-code">${hex16(g.addr)}&nbsp;&nbsp;${hex8(g.b0)}&nbsp;&nbsp;${text}</span>` +
             repeatBadge +
             (diff ? `<span class="trace-diff">${diff}</span>` : '') +
             `<span class="trace-explain">${explain}</span>` +
           `</div>`;
  }).join('');
  traceList.scrollTop = traceList.scrollHeight;
}

// Manual scroll should immediately reflect frozen/live state.
traceList.addEventListener('scroll', () => {
  const atBottom = isTraceAtBottom();
  btnTraceFollow.style.display = atBottom ? 'none' : '';
  traceFrozenNote.style.display = atBottom ? 'none' : '';
});

btnTraceFollow.addEventListener('click', () => {
  traceList.scrollTop = traceList.scrollHeight;
  drawTrace();
});

// Exports the entire trace ring buffer as plain text: address, opcode, disassembly, diff,
// and explanation per line. Consecutive repeats are collapsed with "x N", same as on screen.
function buildTraceExportText() {
  const entries = emulator.instrumentation.getTraceEntries();
  const lines = [];
  lines.push(`; JS GB Emulator — execution trace export`);
  lines.push(`; ROM: ${emulator.romTitle || 'Unknown'}`);
  lines.push(`; Exported: ${new Date().toISOString()}`);
  lines.push(`; Format: ADDR  OPCODE  MNEMONIC                 [register/flag diff]  ; explanation`);
  lines.push('');

  if (entries.length === 0) { lines.push('(no instructions executed yet)'); return lines.join('\n'); }

  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.addr === e.addr && last.b0 === e.b0) { last.count++; last.last = e; }
    else groups.push({ addr: e.addr, b0: e.b0, b1: e.b1, b2: e.b2, count: 1, last: e });
  }

  for (const g of groups) {
    const { text } = disassembleBytes((off) => (off === 0 ? g.b0 : off === 1 ? g.b1 : g.b2), g.addr);
    const repeat = g.count > 1 ? `  x${g.count}` : '';
    const diff = g.last.diff ? `  [${g.last.diff}]` : '';
    const explain = explainInstruction(text);
    const note = explain ? `  ; ${explain}` : '';
    lines.push(`${hex16(g.addr)}  ${hex8(g.b0)}  ${text.padEnd(22)}${diff}${repeat}${note}`);
  }
  return lines.join('\n');
}

btnExportTrace.addEventListener('click', () => {
  try {
    const text = buildTraceExportText();
    const blob = new Blob([text], { type: 'text/plain' });
    downloadBlob(blob, `${safeRomName()}.trace.txt`); // downloadBlob/safeRomName defined in emu-gb-app.js, loaded first
  } catch (e) {
    alert('Could not export trace: ' + e.message);
  }
});

/* ---- orchestration: redraw whichever tab is currently active in each sidebar ---- */
function refreshDebugTools() {
  if (document.body.classList.contains('playing-mode')) return;

  const activeDebug = debugToolsContainer.querySelector('.tool-tab.active').dataset.tool;
  if (activeDebug === 'registers') drawRegisters();
  else if (activeDebug === 'disasm') drawDisassembly();
  else if (activeDebug === 'trace') drawTrace();
  else if (activeDebug === 'stack') drawStack();
  else if (activeDebug === 'memmap') drawMemMap();
  else if (activeDebug === 'banking') drawBanking();
  else if (activeDebug === 'interrupts') drawInterrupts();
  else if (activeDebug === 'ramedit') drawRamEditor();

  const activeVisual = visualToolsContainer.querySelector('.tool-tab.active').dataset.tool;
  if (activeVisual === 'tiles') drawTileViewer();
  else if (activeVisual === 'tilemap') drawTileMap();
  else if (activeVisual === 'tileinspect') drawTileInspector();
  else if (activeVisual === 'oam') { drawOAMComposition(); drawOAMTable(); }
  else if (activeVisual === 'palettes') drawPalettes();
  else if (activeVisual === 'layers') drawLayers();
  else if (activeVisual === 'oscilloscope') drawOscilloscope();
  else if (activeVisual === 'scanline') drawScanlineTimeline();
  else if (activeVisual === 'rtc') drawRTC();

  // Frame Activity isn't a tab - it's always visible - so it redraws every time.
  drawFrameActivity();
  drawFrameAnatomy();
  drawLineAnatomy();
}

// Fallback redraw for when the emulator isn't running (paused, stepping, no ROM loaded).
// While running, loop() calls refreshDebugTools() itself, paced by the current speed.
setInterval(() => { if (!emulator.running) refreshDebugTools(); }, 150);
