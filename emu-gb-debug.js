/* =========================================================================================
   emu-gb-debug.js — debugging / visualization tools
   -----------------------------------------------------------------------------------------
   The inspector panels: an editable CPU registers/flags panel (the one panel here that can
   write back to emulator state - directly onto the CPU instance's own fields, never through
   the MMU - and only while paused), plus the read-only ones: VRAM tile viewer, tile map
   viewer, per-layer viewer, OAM/sprite inspector, palette viewer, per-channel oscilloscope,
   scanline timeline, live disassembler, stack panel, interrupts panel, execution trace, memory
   map strip, and MBC banking panel - plus the tab-switching, mode/model/scanline-mark/layer-
   tint/dot-matrix toggles, and the refreshDebugTools() orchestrator that redraws whichever tab
   is active.

   Depends on: emu-gb-core.js (Emulator instance, EMU_CORE_CONFIG, hex8/hex16) AND
   emu-gb-app.js (savedUIConfig/saveUIConfig, APP_CONFIG, getMBCName, the `emulator` global,
   and the DOM refs those set up) must both be loaded first - several toggle sections here
   read savedUIConfig and call buildBankingPanel()/buildMemMapStrip() immediately at the top
   level, not inside a deferred handler.

   Load order: emu-gb-core.js -> emu-gb-app.js -> emu-gb-debug.js.
   ========================================================================================= */

/* ============================ Debugging / visualization tools ============================
   Six independent read-only views into emulator state, decoded straight from the same
   MMU/PPU data the real rendering pipeline uses. These live in the left sidebar and run on
   their own low-frequency timer (not the main 60fps loop) since they're for inspection,
   not real-time display; only the active tab's view is redrawn.
   ========================================================================================= */

/* ---- 0. CPU registers editor refs ---- */
const regPausedNote = document.getElementById('regPausedNote');
const regIoReadout = document.getElementById('regIoReadout');
// 8-bit registers (A B C D E H L) + 16-bit registers (SP PC), each { el, key, bits }
const REG_INPUTS = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'SP', 'PC'].map(key => {
  const el = document.getElementById('reg' + key);
  return { el, key, bits: (key === 'SP' || key === 'PC') ? 16 : 8 };
});
// Flags + CPU state toggles - checkbox element paired with the exact CPU property name it
// reads/writes (flagZ/flagN/flagH/flagC/IME/halted are all plain boolean fields on the CPU).
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
// Grid layout: 16 cols x 24 rows of tiles, with a 1px (native) gap between/around cells so
// hovering can visually pick out one tile from the next. Each source pixel is drawn as a
// TV_SCALE x TV_SCALE block (supersampled) rather than 1:1, so that fixed 1px gap ends up
// thinner relative to the tile art - and thinner on screen, since the canvas's overall CSS
// size doesn't change, just its internal pixel density. TV_W/TV_H are the canvas's real pixel
// dimensions once cells + gaps are included.
const TV_COLS = 16, TV_ROWS = 24, TV_SCALE = 2, TV_CELL = 8 * TV_SCALE, TV_GAP = 1;
const TV_PITCH = TV_CELL + TV_GAP;
const TV_W = TV_COLS * TV_PITCH + TV_GAP;  // 273
const TV_H = TV_ROWS * TV_PITCH + TV_GAP;  // 409
const tileViewerImageData = tileViewerCtx.createImageData(TV_W, TV_H);
const tileViewerWrap = document.getElementById('tileViewerWrap');
const tileViewerHover = document.getElementById('tileViewerHover');
const tileViewerTooltip = document.getElementById('tileViewerTooltip');


/* ---- 2a. Tile map viewer refs ---- */
const tileMapCanvas = document.getElementById('tileMapCanvas');
const tileMapCtx = tileMapCanvas.getContext('2d');
const tileMapImageData = tileMapCtx.createImageData(256, 256); // 32x32 tiles of 8x8

/* ---- 2b. Tile inspector refs: decodes any 16 bytes at a user-given address as one 8x8 tile.
   Rendered by painting the true 8x8 pixels onto an offscreen canvas, then scaling that up onto
   the visible (larger) canvas with smoothing off, so it stays crisp instead of blurry. */
const tileInspectCanvas = document.getElementById('tileInspectCanvas');
const tileInspectCtx = tileInspectCanvas.getContext('2d');
tileInspectCtx.imageSmoothingEnabled = false;
const tileInspectSrcCanvas = document.createElement('canvas');
tileInspectSrcCanvas.width = 8; tileInspectSrcCanvas.height = 8;
const tileInspectSrcCtx = tileInspectSrcCanvas.getContext('2d');
const tileInspectImageData = tileInspectSrcCtx.createImageData(8, 8);
const tileInspectAddrInput = document.getElementById('tileInspectAddr');
const tileInspectBytesEl = document.getElementById('tileInspectBytes');
const tileInspectPrevBtn = document.getElementById('tileInspectPrev');
const tileInspectNextBtn = document.getElementById('tileInspectNext');
const tileInspectGoBtn = document.getElementById('tileInspectGo');
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

/* ============================ Memory Map + MBC Banking visualizers ===================== */

// Static region layout for the 0x0000-0xFFFF strip. `weight` drives proportional width via
// flex-grow; `minPx` is a floor so tiny regions (OAM/IO/HRAM/IE) don't disappear entirely.
const MEM_REGIONS = [
  { key: 'ROM0',   label: 'ROM Bank 0',    range: '0x0000–0x3FFF', color: '#5a9bd8', weight: 0x4000, minPx: 46 },
  { key: 'ROMX',   label: 'ROM Bank N',    range: '0x4000–0x7FFF', color: '#8fc0ec', weight: 0x4000, minPx: 46 },
  { key: 'VRAM',   label: 'VRAM',          range: '0x8000–0x9FFF', color: '#e0a63d', weight: 0x2000, minPx: 34 },
  { key: 'ERAM',   label: 'Cart RAM',      range: '0xA000–0xBFFF', color: '#d9534f', weight: 0x2000, minPx: 34 },
  { key: 'WRAM',   label: 'WRAM',          range: '0xC000–0xDFFF', color: '#5cb85c', weight: 0x2000, minPx: 34 },
  { key: 'ECHO',   label: 'Echo RAM',      range: '0xE000–0xFDFF', color: '#3f7a3f', weight: 0x1E00, minPx: 22, aliasOf: 'WRAM' },
  { key: 'OAM',    label: 'OAM',           range: '0xFE00–0xFE9F', color: '#b366cc', weight: 0x00A0, minPx: 20 },
  { key: 'UNUSED', label: 'Unused',        range: '0xFEA0–0xFEFF', color: '#3a3a42', weight: 0x0060, minPx: 16 },
  { key: 'IO',     label: 'I/O Regs',      range: '0xFF00–0xFF7F', color: '#e05fb0', weight: 0x0080, minPx: 20 },
  { key: 'HRAM',   label: 'HRAM',          range: '0xFF80–0xFFFE', color: '#f0d84a', weight: 0x007F, minPx: 20 },
  { key: 'IE',     label: 'IE',            range: '0xFFFF',        color: '#f5f5f5', weight: 0x0001, minPx: 16 },
];
let memRegionEls = {}; // key -> { el, key } (ECHO shares the 'WRAM' flash key via aliasOf)

function buildMemMapStrip() {
  memmapStrip.innerHTML = '';
  memRegionEls = {};
  MEM_REGIONS.forEach(r => {
    const el = document.createElement('div');
    el.className = 'mem-region';
    el.style.flex = `${r.weight} 0 ${r.minPx}px`;
    el.style.background = r.color;
    el.title = `${r.label}  (${r.range})`;
    el.innerHTML = `<span class="mem-label">${r.label}</span><span class="mem-range">${r.range}</span>` +
      (r.key === 'ROMX' ? '<span class="mem-bank" id="mmRomBankTag">Bank 1</span>' : '');
    memmapStrip.appendChild(el);
    memRegionEls[r.key] = el;
  });
}

let lastRenderedAccessSeq = -1;

function drawMemMap() {
  const mmu = emulator.mmu;
  // Keep the "currently mapped bank" tag on the switchable ROM block accurate even when
  // nothing has been read from it yet this frame.
  const bankTag = document.getElementById('mmRomBankTag');
  if (bankTag) bankTag.textContent = 'Bank ' + mmu.currentROMBank;

  const a = mmu.lastAccess;
  if (a.seq === 0) return; // nothing accessed yet (no ROM loaded / not run)

  if (a.seq !== lastRenderedAccessSeq) {
    lastRenderedAccessSeq = a.seq;
    // Echo RAM writes are drawn on the ECHO block itself (not WRAM) so the "why is there a
    // second green-ish strip" question has an obvious visual answer.
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

// How many switchable 8KB cart-RAM banks a mapper exposes. MBC2 has RAM, but it's a single
// built-in 512x4-bit chip with no bank switching at all, so it's called out separately rather
// than counted here (see ramBankTarget/bankingDesc below).
function getRamBankTotal(mmu) {
  if (mmu.mbcType === 0 || mmu.mbcType === 2) return 0;
  if (mmu.mbcType === 5) return 16; // MBC5's RAM bank register is a full 4 bits
  return 4; // this MMU always allocates 4 cart-RAM banks' worth of space for MBC1/MBC3
}

// Describes what's currently mapped into the 0xA000-0xBFFF window: a cart RAM bank, MBC2's
// built-in RAM, an MBC3 RTC register, "disabled", or "no cart RAM" for mappers with none.
function ramBankTarget(mmu, ramBankTotal) {
  if (mmu.mbcType === 2) return mmu.ramEnabled ? 'Built-in RAM (512×4-bit)' : 'disabled';
  if (!ramBankTotal) return 'no cart RAM';
  if (!mmu.ramEnabled) return 'disabled';
  if (mmu.mbcType === 3 && mmu.rtcSelect !== -1) return RTC_REG_LABEL[mmu.rtcSelect] || 'RTC register';
  return 'RAM Bank ' + mmu.currentRAMBank;
}

function buildBankingPanel() {
  const mmu = emulator.mmu;
  const romBytes = mmu.rom ? mmu.rom.length : 0;
  const romBankTotal = romBytes > 0 ? Math.max(1, Math.ceil(romBytes / 0x4000)) : 0;
  const ramBankTotal = getRamBankTotal(mmu);

  bankingDesc.innerHTML = romBytes === 0
    ? 'Load a ROM to see its mapper and which ROM/RAM banks are currently switched in.'
    : `Mapper: <b>${getMBCName(mmu.rom)}</b> &middot; ${romBankTotal} ROM bank(s) of 16KB` +
      (mmu.mbcType === 2 ? ' &middot; 512×4-bit built-in RAM (no banking)'
        : ramBankTotal ? ` &middot; up to ${ramBankTotal} RAM bank(s) of 8KB` : ' &middot; no external RAM') +
      (!mmu.cartTypeSupported ? `<br><span style="color:#e8794b">⚠ Unsupported mapper - banking below is simulated as MBC1 and won't match real hardware.</span>` : '');

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
      <div class="bw-target" id="bwSwitchableTarget">${romBankTotal ? 'ROM Bank ' + mmu.currentROMBank : '—'}</div>
      <div class="bw-note">Switched by writing to 0x2000–0x3FFF (MBC1/MBC3), 0x0000–0x3FFF with address bit 8 set (MBC2), or 0x2000–0x2FFF + 0x3000–0x3FFF for the low/high bank bits (MBC5). This is what "bank switching" means.</div>
    </div>
    <div class="bank-window" id="bwRam">
      <div class="bw-range">CPU addresses 0xA000–0xBFFF</div>
      <div class="bw-arrow">↓ currently mapped to</div>
      <div class="bw-target" id="bwRamTarget">${ramBankTarget(mmu, ramBankTotal)}</div>
      <div class="bw-note" id="bwRamNote">${mmu.mbcType === 3 ? 'Must be enabled (write 0x0A to 0x0000–0x1FFF); writing 0x08–0x0C to 0x4000–0x5FFF maps an RTC register in here instead.' : 'Must be enabled (write 0x0A to 0x0000–0x1FFF) before it\'s readable/writable.'}</div>
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
  if (mmu.mbcType === 2) {
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
  const mmu = emulator.mmu;
  if (!mmu.rom || mmu.rom.length === 0) return;

  // Keep the "currently mapped" readouts and the active-tile highlight correct every frame,
  // independent of whether a fresh switch just happened.
  const romTarget = document.getElementById('bwSwitchableTarget');
  if (romTarget) romTarget.textContent = 'ROM Bank ' + mmu.currentROMBank;
  const ramTarget = document.getElementById('bwRamTarget');
  if (ramTarget) ramTarget.textContent = ramBankTarget(mmu, getRamBankTotal(mmu));

  romBankGrid.querySelectorAll('.bank-tile').forEach(t => {
    t.classList.toggle('bank-active', Number(t.dataset.bank) === mmu.currentROMBank);
  });
  const ramBankMapped = mmu.ramEnabled && !(mmu.mbcType === 3 && mmu.rtcSelect !== -1);
  ramBankGrid.querySelectorAll('.bank-tile').forEach(t => {
    t.classList.toggle('bank-active', ramBankMapped && Number(t.dataset.bank) === mmu.currentRAMBank);
  });

  const bs = mmu.lastBankSwitch;
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
      `  ⇒  ROM bank ${bs.romBank}` + (mmu.mbcType !== 0 ? `, ${ramBankTarget(mmu, getRamBankTotal(mmu))}` : '');
  }
}

buildMemMapStrip();
buildBankingPanel();

/* ============================ RAM Editor ================================================
   Read/write panel for the regions that are real RAM (VRAM, cart RAM, WRAM/Echo, OAM, HRAM),
   plus IE, plus a dedicated bit-level view for the I/O registers - ROM stays read-only. Every
   read here goes through mmu.peek8 (same address decoding as the CPU's read8, just without
   flagging the access to the Memory Map visualizer) and every write goes through the real
   mmu.write8 - never touching mmu.vram/wram/oam/etc. arrays directly - so banking, Echo RAM
   mirroring, and I/O side effects (DIV reset, DMA trigger, APU register masks, ...) all behave
   exactly as they would for a write coming from the CPU.
   ========================================================================================= */

const ramEditRegionsEl = document.getElementById('ramEditRegions');
const ramEditInfoEl = document.getElementById('ramEditInfo');
const ramEditNavEl = document.getElementById('ramEditNav');
const ramEditBodyEl = document.getElementById('ramEditBody');

// Per-region edit policy. ROM is always read-only (real hardware can't write it either).
// VRAM/WRAM+Echo/OAM/HRAM are plain RAM, edited as a hex dump. Cart RAM is real RAM too, but
// only actually backed by storage while the cartridge's mapper has it enabled. I/O and IE get
// the dedicated per-bit editor instead of raw hex, since many of their bits are write-only,
// read-only, or trigger a side effect the moment they're written.
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

// Friendly names/descriptions for the well-known DMG I/O registers, with optional bit labels
// (MSB first, matching the checkbox order the row is built in) for the ones worth spelling
// out. Registers not listed here still get a row, just with a plain hex byte editor instead
// of bit toggles, since we don't have documented per-bit semantics to expose for them.
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
  return { key, base: RAMEDIT_BASE[key], length: RAMEDIT_LEN[key], editable: m.editable, mode: m.mode, note: m.note, label: mm.label || key, color: mm.color || '#888', range: mm.range || '' };
}

function buildRamEditRegionTabs() {
  ramEditRegionsEl.innerHTML = '';
  RAMEDIT_ORDER.forEach(key => {
    const meta = ramEditRegionMeta(key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ramedit-region-btn' + (meta.editable ? '' : ' readonly') + (key === ramEditKey ? ' active' : '');
    btn.style.setProperty('--region-color', meta.color);
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

// Applies a hex-cell edit through the real MMU write path (never mmu.vram/wram/... directly).
function commitRamEditCell(input) {
  if (input.value === '') return; // leave it blank; the next live refresh repaints the real value
  const addr = parseInt(input.dataset.addr, 10);
  const val = parseInt(input.value, 16) & 0xFF;
  emulator.mmu.write8(addr, val);
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
      const mmu = emulator.mmu;
      const cur = mmu.peek8(addr);
      const next = cb.checked ? (cur | (1 << bit)) : (cur & ~(1 << bit));
      mmu.write8(addr, next & 0xFF); // always through the real write path (handles IO side effects/masks)
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
      // No documented bit semantics in this emulator for this address: fall back to a plain
      // single-byte hex editor rather than guessing at bit meanings.
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

// Live refresh: repaints every visible cell/register from mmu.peek8 so a value the game
// itself changes shows up, not just what the student typed - same idea as the always-live
// VRAM/OAM panels. Never repaints whichever input currently has focus, so it doesn't fight
// the student mid-edit.
function drawRamEditor() {
  const mmu = emulator.mmu;
  const meta = ramEditRegionMeta(ramEditKey);

  const dyn = document.getElementById('ramEditDynamicNote');
  if (dyn) {
    if (meta.key === 'ROMX') dyn.textContent = `Bank currently mapped at 0x4000–0x7FFF: ${mmu.currentROMBank}`;
    else if (meta.key === 'ERAM') dyn.textContent = mmu.ramEnabled ? `RAM enabled — current bank: ${mmu.currentRAMBank}` : 'RAM disabled (RAMG) — reads return 0xFF, writes are ignored.';
  }

  if (meta.mode === 'io') {
    ramEditBodyEl.querySelectorAll('.ramedit-io-row').forEach(row => {
      const addr = parseInt(row.dataset.addr, 10);
      const val = mmu.peek8(addr);
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
    input.value = hex8(mmu.peek8(parseInt(input.dataset.addr, 10))).slice(2);
  });
  ramEditBodyEl.querySelectorAll('.ramedit-cell-ro').forEach(span => {
    span.textContent = hex8(mmu.peek8(parseInt(span.dataset.addr, 10))).slice(2);
  });
  ramEditBodyEl.querySelectorAll('.ramedit-ascii').forEach(td => {
    const addrs = (td.dataset.addrs || '').split(',').filter(Boolean).map(Number);
    td.textContent = addrs.map(a => { const v = mmu.peek8(a); return (v >= 32 && v < 127) ? String.fromCharCode(v) : '.'; }).join('');
  });
}

buildRamEditRegionTabs();
buildRamEditBody();

/* ---- tab switching (scoped per sidebar, so each tracks its own active tab) ---- */
const debugToolsContainer = document.getElementById('debugTools');
const visualToolsContainer = document.getElementById('visualTools');
const cpuDebugControls = document.getElementById('cpuDebugControls');
const TOOLS_NEEDING_CPU_CONTROLS = ['trace', 'disasm', 'stack'];

function updateCpuControlsVisibility(tool) {
  cpuDebugControls.classList.toggle('hidden', !TOOLS_NEEDING_CPU_CONTROLS.includes(tool));
}

// MMU.noteAccess() (Mem Map/Banking) and the CPU's per-instruction trace snapshot/diff
// (Execution Trace) are the two hottest pieces of debug instrumentation - each runs on
// every memory access or every instruction respectively. Both are wasted work unless the
// one specific tab that consumes them is actually the open tab, so keep emulator.trackMemMap
// / emulator.trackTrace synced to (debug mode on) AND (that tab is active), rather than just
// mirroring the play/debug toggle the way the coarser emulator.trackAccess does. Called both
// on tab switches and from applyMode() (play/debug toggle) so either kind of change is caught.
function syncAccessTracking(activeDebugTool) {
  const debugging = !document.body.classList.contains('playing-mode');
  emulator.trackMemMap = debugging && (activeDebugTool === 'memmap' || activeDebugTool === 'banking');
  emulator.trackTrace = debugging && (activeDebugTool === 'trace');
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
      refreshDebugTools();
    });
  });
}

setupTabGroup(debugToolsContainer);
setupTabGroup(visualToolsContainer);

updateCpuControlsVisibility(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool);
syncAccessTracking(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool);

// Keep the trace panel's height matched to its sibling column across window resizes, but
// only while it's actually the visible tab - other debug panels are unaffected either way.
// (No initial call needed here: Registers is the default active tab, and syncTraceListHeight()
// runs itself via drawTrace() the moment the Execution Trace tab is actually opened.)
window.addEventListener('resize', () => {
  if (debugToolsContainer.querySelector('.tool-tab.active').dataset.tool === 'trace') syncTraceListHeight();
});

let tileMapSelect = '9800';
document.querySelectorAll('input[name="tmSelect"]').forEach(r => {
  r.addEventListener('change', () => { tileMapSelect = r.value; refreshDebugTools(); });
});

/* ---- play / debug mode toggle: checked = debugging GUI (default), unchecked = playing ----
   The chosen mode is persisted (in the shared UI config) so it's restored on the next visit. */
const modeToggle = document.getElementById('modeToggle');
const modeLabelPlay = document.getElementById('modeLabelPlay');
const modeLabelDebug = document.getElementById('modeLabelDebug');

function applyMode() {
  const debugging = modeToggle.checked;
  document.body.classList.toggle('playing-mode', !debugging);
  emulator.trackAccess = debugging; // skip the coarser frame-activity bookkeeping entirely while just playing
  syncAccessTracking(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool); // and the finer memmap/trace gates
  modeLabelDebug.classList.toggle('active', debugging);
  modeLabelPlay.classList.toggle('active', !debugging);
  saveUIConfig({ debugMode: debugging });
  if (debugging) refreshDebugTools();
}

// Restore the saved mode (if any) before the first render so the UI doesn't flash the default.
if (typeof savedUIConfig.debugMode === 'boolean') modeToggle.checked = savedUIConfig.debugMode;

modeToggle.addEventListener('change', applyMode);

/* ---- screen model toggle: checked = GBP (grayscale, default), unchecked = GB (green tint) ---- */
const modelToggle = document.getElementById('modelToggle');
const modelLabelGB = document.getElementById('modelLabelGB');
const modelLabelGBP = document.getElementById('modelLabelGBP');

function applyScreenModel() {
  const isGBP = modelToggle.checked;
  PPU.SHADES = isGBP ? PPU.PALETTE_GBP : PPU.PALETTE_GB;
  document.documentElement.style.setProperty('--screen-bg', isGBP ? '#343434' : '#0f380f');
  modelLabelGBP.classList.toggle('active', isGBP);
  modelLabelGB.classList.toggle('active', !isGBP);
  saveUIConfig({ gbp: isGBP });
  // Repaint immediately with the new palette instead of waiting for the next emulated frame,
  // and refresh any open debug/visualization panels that render colors (tile map, palettes, etc).
  if (emulator.mmu.rom && emulator.mmu.rom.length) emulator.draw();
  refreshDebugTools();
}

if (typeof savedUIConfig.gbp === 'boolean') modelToggle.checked = savedUIConfig.gbp;

modelToggle.addEventListener('change', applyScreenModel);

/* ---- navbar toggle: overlay a line on the GB screen at the PPU's current scanline (LY) ---- */
const scanlineMarkToggle = document.getElementById('scanlineMarkToggle');
const scanlineMarkLabelOff = document.getElementById('scanlineMarkLabelOff');
const scanlineMarkLabelOn = document.getElementById('scanlineMarkLabelOn');

function applyScanlineMark() {
  const on = scanlineMarkToggle.checked;
  emulator.markCurrentLine = on;
  scanlineMarkLabelOn.classList.toggle('active', on);
  scanlineMarkLabelOff.classList.toggle('active', !on);
  saveUIConfig({ markCurrentLine: on });
  // Repaint immediately so toggling is visible even while paused/no frame is running.
  if (emulator.mmu.rom && emulator.mmu.rom.length) emulator.draw();
}

if (typeof savedUIConfig.markCurrentLine === 'boolean') scanlineMarkToggle.checked = savedUIConfig.markCurrentLine;

scanlineMarkToggle.addEventListener('change', applyScanlineMark);

/* ---- navbar toggle: wash each PPU layer (background / window "tiles" / sprites) with its
   own tint color, so overlapping layers are easy to tell apart on the GB screen ---- */
const layerTintToggle = document.getElementById('layerTintToggle');
const layerTintLabelOff = document.getElementById('layerTintLabelOff');
const layerTintLabelOn = document.getElementById('layerTintLabelOn');

function applyLayerTint() {
  const on = layerTintToggle.checked;
  emulator.layerTint = on;
  layerTintLabelOn.classList.toggle('active', on);
  layerTintLabelOff.classList.toggle('active', !on);
  saveUIConfig({ layerTint: on });
  // Repaint immediately so toggling is visible even while paused/no frame is running.
  if (emulator.mmu.rom && emulator.mmu.rom.length) emulator.draw();
}

if (typeof savedUIConfig.layerTint === 'boolean') layerTintToggle.checked = savedUIConfig.layerTint;

layerTintToggle.addEventListener('change', applyLayerTint);

/* ---- navbar toggle: overlay a hairline pixel grid on the GB screen, mimicking the visible
   dot matrix of a real Game Boy LCD. Purely cosmetic (CSS overlay, no canvas/shader work
   needed), so no repaint is required when toggling. ---- */
const dotMatrixToggle = document.getElementById('dotMatrixToggle');
const dotMatrixLabelOff = document.getElementById('dotMatrixLabelOff');
const dotMatrixLabelOn = document.getElementById('dotMatrixLabelOn');

function applyDotMatrix() {
  const on = dotMatrixToggle.checked;
  document.body.classList.toggle('dot-matrix-on', on);
  dotMatrixLabelOn.classList.toggle('active', on);
  dotMatrixLabelOff.classList.toggle('active', !on);
  saveUIConfig({ dotMatrix: on });
}

if (typeof savedUIConfig.dotMatrix === 'boolean') dotMatrixToggle.checked = savedUIConfig.dotMatrix;

dotMatrixToggle.addEventListener('change', applyDotMatrix);

/* ---- navbar toggles: independently show/hide the Debugging Tools sidebar, the
   Visualization Tools sidebar, and the Frame Activity panel. Each one is a simple
   checked=visible/unchecked=hidden switch (unlike the play/debug toggle above, these use
   display:none in CSS, so hiding a panel actually reclaims its layout space). Persisted
   in the shared UI config so hidden panels stay hidden on the next visit. */
function makePanelVisToggle(toggleId, labelId, bodyClass, configKey, onShow) {
  const toggle = document.getElementById(toggleId);
  const label = document.getElementById(labelId);

  function apply() {
    const visible = toggle.checked;
    document.body.classList.toggle(bodyClass, !visible);
    label.classList.toggle('active', visible);
    saveUIConfig({ [configKey]: visible });
    if (visible && typeof onShow === 'function') onShow();
  }

  if (typeof savedUIConfig[configKey] === 'boolean') toggle.checked = savedUIConfig[configKey];
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

/* ---- 1. VRAM tile viewer: every tile in 0x8000-0x97FF, raw, no palette ---- */
function drawTileViewer() {
  const vram = emulator.mmu.vram;
  const data = tileViewerImageData.data;

  // Fill the whole canvas with the grid-line color first; tile pixels get painted over the
  // top of it below, so only the 1px gaps between/around cells are left showing through.
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
        const bit = 7 - px;
        const colorNum = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        const shade = 255 - colorNum * 85; // 0->white .. 3->black, palette-agnostic
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

/* ---- 1b. Sprite Sheet hover: highlight the cell under the cursor and show its tile index +
   VRAM address in a small floating tooltip. Uses percentage-based positioning for the highlight
   box so it stays aligned with the canvas's displayed (CSS-scaled) size without recalculating
   pixel offsets on resize. ---- */
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

/* ---- 2. Tile map viewer: full 32x32 map rendered with BG palette + viewport box ---- */
function setMapPixel(data, x, y, r, g, b) {
  x = ((x % 256) + 256) % 256; y = ((y % 256) + 256) % 256; // wrap into the 256x256 map
  const idx = (y * 256 + x) * 4;
  data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
}

function drawTileMap() {
  const ppu = emulator.ppu;
  const vram = emulator.mmu.vram;
  const mapBase = tileMapSelect === '9800' ? 0x9800 : 0x9C00;
  const signedIndex = !(ppu.lcdc & 0x10);
  const tileDataBase = signedIndex ? 0x9000 : 0x8000;
  const data = tileMapImageData.data;

  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      const tileIndexRaw = vram[(mapBase + ty * 32 + tx) - 0x8000];
      const tileIndex = signedIndex ? ppu.toSigned8(tileIndexRaw) : tileIndexRaw;
      const tileAddr = tileDataBase + tileIndex * 16;
      for (let py = 0; py < 8; py++) {
        const lo = vram[(tileAddr - 0x8000) + py * 2];
        const hi = vram[(tileAddr - 0x8000) + py * 2 + 1];
        for (let px = 0; px < 8; px++) {
          const bit = 7 - px;
          const colorNum = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
          const [r, g, b] = ppu.applyPalette(colorNum, ppu.bgp);
          const idx = ((ty * 8 + py) * 256 + (tx * 8 + px)) * 4;
          data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
        }
      }
    }
  }

  // Highlight the current 160x144 viewport (SCX/SCY), wrapping around the map edges.
  const scx = ppu.scx, scy = ppu.scy, vw = EMU_CORE_CONFIG.SCREEN.WIDTH, vh = EMU_CORE_CONFIG.SCREEN.HEIGHT;
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

/* ---- 2c. Tile inspector: decode+render the 16 bytes at tileInspectAddr as a single 8x8 tile.
   Uses mmu.peek8() (not read8()) so pointing this at live hardware registers or ROM never
   triggers real side effects or shows up as CPU activity in the Memory Map visualizer. */
function drawTileInspector() {
  const mmu = emulator.mmu;
  const data = tileInspectImageData.data;
  for (let py = 0; py < 8; py++) {
    const lo = mmu.peek8((tileInspectAddr + py * 2) & 0xFFFF);
    const hi = mmu.peek8((tileInspectAddr + py * 2 + 1) & 0xFFFF);
    for (let px = 0; px < 8; px++) {
      const bit = 7 - px;
      const colorNum = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      const shade = 255 - colorNum * 85; // same palette-agnostic grayscale as the Sprite Sheet tab
      const idx = (py * 8 + px) * 4;
      data[idx] = shade; data[idx + 1] = shade; data[idx + 2] = shade; data[idx + 3] = 255;
    }
  }
  tileInspectSrcCtx.putImageData(tileInspectImageData, 0, 0);
  tileInspectCtx.clearRect(0, 0, 128, 128);
  tileInspectCtx.drawImage(tileInspectSrcCanvas, 0, 0, 128, 128);

  const bytes = [];
  for (let i = 0; i < 16; i++) bytes.push(hex8(mmu.peek8((tileInspectAddr + i) & 0xFFFF)).slice(2));
  tileInspectBytesEl.textContent = `${hex16(tileInspectAddr)}\u2013${hex16((tileInspectAddr + 15) & 0xFFFF)}:  ${bytes.join(' ')}`;
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


/* ---- 2b. Layer viewer: background / window / sprites, each rendered independently at full
   160x144 frame resolution using the PPU's *current* registers - a static "what does this
   layer alone look like right now" snapshot, not tied to the current scanline like the real
   per-line renderer. Window and sprites fill with transparent pixels where they don't draw
   anything, so empty areas show through to whatever sits behind the canvas. ---- */
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

// Renders every on-screen sprite into an RGBA pixel buffer (data, sized W*H*4), using the
// exact same per-scanline candidate selection and priority rules the real renderer uses
// (PPU.getSpriteCandidatesForLine / getSpriteRowBits / spriteRowColorIndex) - the hardware's
// 10-sprites-per-line cap and X-then-OAM-index priority included. Shared by the Layers >
// Sprites panel and the OAM tab's composited view, so the two can never drift apart.
function renderSpriteLayerPixels(data, W, H) {
  const ppu = emulator.ppu;
  const spriteHeight = (ppu.lcdc & 0x04) ? EMU_CORE_CONFIG.SPRITES.HEIGHT_TALL : EMU_CORE_CONFIG.SPRITES.HEIGHT_SMALL;
  for (let y = 0; y < H; y++) {
    const candidates = ppu.getSpriteCandidatesForLine(y, spriteHeight);

    for (const s of candidates) {
      if (s.spriteX <= -8 || s.spriteX >= W) continue;
      const palette = (s.attrs & 0x10) ? ppu.obp1 : ppu.obp0;
      const { lo, hi, xFlip } = ppu.getSpriteRowBits(s, y, spriteHeight);

      for (let px = 0; px < 8; px++) {
        const sx = s.spriteX + px;
        if (sx < 0 || sx >= W) continue;
        const colorNum = PPU.spriteRowColorIndex(lo, hi, xFlip, px);
        if (colorNum === 0) continue; // color 0 is always transparent for sprites
        const [r, g, b] = ppu.applyPalette(colorNum, palette);
        const idx = (y * W + sx) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
  }
}

function drawLayers() {
  const ppu = emulator.ppu;
  const W = EMU_CORE_CONFIG.SCREEN.WIDTH, H = EMU_CORE_CONFIG.SCREEN.HEIGHT;

  /* ---- Background: always covers the full 160x144 frame when enabled. Pixel decoding
     goes through PPU.getBackgroundColorIndex() - the same helper renderBackgroundLine()
     uses - so this view can never drift from what the real renderer draws. ---- */
  const bgOn = !!(ppu.lcdc & 0x01);
  setLayerStatus(layerStatusBG, layerCanvasBG.closest('.layer-block'), bgOn, 'LCDC.0');
  if (!bgOn) {
    fillLayerImage(layerImageDataBG, 255, 255, 255); // matches real hardware: BG off = blank white
  } else {
    const data = layerImageDataBG.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const colorNum = ppu.getBackgroundColorIndex(x, y);
        const [r, g, b] = ppu.applyPalette(colorNum, ppu.bgp);
        const idx = (y * W + x) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
  }
  layerCtxBG.putImageData(layerImageDataBG, 0, 0);

  /* ---- Window: only draws where WX/WY currently place it; black elsewhere. Real hardware
     also requires BG to be on for the window to render at all. Uses a plain y - WY per line
     (rather than the real renderer's internal window-line counter) since this is a static
     snapshot, not a live per-scanline render - but the tile lookup itself is the same
     PPU.getWindowColorIndex() helper renderWindowLine() uses. ---- */
  const winOn = bgOn && !!(ppu.lcdc & 0x20);
  setLayerStatus(layerStatusWindow, layerCanvasWindow.closest('.layer-block'), winOn, bgOn ? 'LCDC.5' : 'LCDC.0');
  fillLayerImage(layerImageDataWindow, 0, 0, 0, 0);
  if (winOn) {
    const wx = ppu.wx - 7, wy = ppu.wy;
    if (wx <= W - 1) {
      const data = layerImageDataWindow.data;
      for (let y = Math.max(wy, 0); y < H; y++) {
        const winY = y - wy;
        for (let x = Math.max(wx, 0); x < W; x++) {
          const colorNum = ppu.getWindowColorIndex(x - wx, winY);
          const [r, g, b] = ppu.applyPalette(colorNum, ppu.bgp);
          const idx = (y * W + x) * 4;
          data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
        }
      }
    }
  }
  layerCtxWindow.putImageData(layerImageDataWindow, 0, 0);

  /* ---- Sprites: every OAM entry currently on-screen, drawn with the real 10-per-line
     hardware cap and OAM-index priority (via PPU.getSpriteCandidatesForLine(), the same
     candidate selection renderSpritesLine() uses) - but ignoring BG-priority occlusion, so
     the full sprite layer is visible even where the background would normally sit on top
     of it. ---- */
  const sprOn = !!(ppu.lcdc & 0x02);
  setLayerStatus(layerStatusSprites, layerCanvasSprites.closest('.layer-block'), sprOn, 'LCDC.1');
  fillLayerImage(layerImageDataSprites, 0, 0, 0, 0);
  if (sprOn) {
    renderSpriteLayerPixels(layerImageDataSprites.data, W, H);
  }
  layerCtxSprites.putImageData(layerImageDataSprites, 0, 0);
}

/* ---- 3. OAM / sprite inspector: all 40 entries, decoded ---- */
function makeTd(text) { const td = document.createElement('td'); td.textContent = text; return td; }

// Shared by both the composited view and the hover hit-test: real screen-space X/Y for OAM
// entry i, and the tile-data offset (accounting for 8x16 mode forcing the low tile bit to 0).
function oamSpriteGeometry(i, spriteHeight) {
  const mmu = emulator.mmu;
  const base = i * 4;
  const rawY = mmu.oam[base], rawX = mmu.oam[base + 1];
  const spriteX = rawX - 8, spriteY = rawY - 16;
  const tileIndex = mmu.oam[base + 2];
  const attrs = mmu.oam[base + 3];
  let idxTile = tileIndex;
  if (spriteHeight === 16) idxTile &= 0xFE;
  return { spriteX, spriteY, tileIndex, idxTile, attrs };
}

/* ---- 3a. Composited sprite view: same per-scanline candidate/priority rendering as the
   Layers > Sprites panel (via the shared renderSpriteLayerPixels()), just always drawn
   regardless of LCDC.1 - this tab is for inspecting the raw OAM data as configured, not "what's
   currently visible", so a sprite-disable toggle shouldn't blank it out. No background/window
   layer is drawn under it - this is sprites-only, so transparent pixels just show the canvas's
   plain dark fill. ---- */
function drawOAMComposition() {
  const W = EMU_CORE_CONFIG.SCREEN.WIDTH, H = EMU_CORE_CONFIG.SCREEN.HEIGHT;
  const imgData = oamCompCtx.createImageData(W, H);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) { data[i] = 32; data[i + 1] = 32; data[i + 2] = 40; data[i + 3] = 255; }
  renderSpriteLayerPixels(data, W, H);
  oamCompCtx.putImageData(imgData, 0, 0);
}

// Finds the highest-priority sprite (lowest OAM index) whose bounding box covers screen pixel
// (px, py), matching the same priority order the composited view was painted in.
function oamSpriteAt(px, py) {
  const ppu = emulator.ppu;
  const spriteHeight = (ppu.lcdc & 0x04) ? 16 : 8;
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

  // Clamp the highlight box to the visible canvas area (a sprite's origin can be negative).
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

function drawOAMTable() {
  const ppu = emulator.ppu;
  const mmu = emulator.mmu;
  const spriteHeight = (ppu.lcdc & 0x04) ? 16 : 8;
  oamTableBody.innerHTML = '';

  for (let i = 0; i < 40; i++) {
    const base = i * 4;
    const rawY = mmu.oam[base], rawX = mmu.oam[base + 1];
    const spriteY = rawY - 16, spriteX = rawX - 8;
    const tileIndex = mmu.oam[base + 2];
    const attrs = mmu.oam[base + 3];
    const offscreen = spriteX <= -8 || spriteX >= EMU_CORE_CONFIG.SCREEN.WIDTH || spriteY <= -16 || spriteY >= EMU_CORE_CONFIG.SCREEN.HEIGHT;
    const xFlip = !!(attrs & 0x20), yFlip = !!(attrs & 0x40), behindBG = !!(attrs & 0x80);
    const paletteByte = (attrs & 0x10) ? ppu.obp1 : ppu.obp0;

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
      const lo = mmu.vram[tileOffset + r2 * 2], hi = mmu.vram[tileOffset + r2 * 2 + 1];
      for (let px = 0; px < 8; px++) {
        const bit = xFlip ? px : 7 - px;
        const colorNum = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        const pidx = (row * 8 + px) * 4;
        if (colorNum === 0) { imgData.data[pidx + 3] = 0; continue; } // transparent
        const [r3, g3, b3] = ppu.applyPalette(colorNum, paletteByte);
        imgData.data[pidx] = r3; imgData.data[pidx + 1] = g3; imgData.data[pidx + 2] = b3; imgData.data[pidx + 3] = 255;
      }
    }
    cctx.putImageData(imgData, 0, 0);

    const tr = document.createElement('tr');
    if (offscreen) tr.classList.add('offscreen');
    const tdThumb = document.createElement('td');
    tdThumb.appendChild(c);
    tr.appendChild(tdThumb);
    tr.appendChild(makeTd(i));
    tr.appendChild(makeTd(spriteX));
    tr.appendChild(makeTd(spriteY));
    tr.appendChild(makeTd(hex8(tileIndex)));
    tr.appendChild(makeTd((attrs & 0x10) ? 'OBP1' : 'OBP0'));
    tr.appendChild(makeTd(`${behindBG ? 'BG' : 'OBJ'} ${yFlip ? 'Y' : '-'}${xFlip ? 'X' : '-'}`));
    oamTableBody.appendChild(tr);
  }
}

/* ---- 4. Palette viewer: BGP / OBP0 / OBP1 as swatches ---- */
function drawPalettes() {
  const ppu = emulator.ppu;
  const regs = [['BGP', ppu.bgp], ['OBP0', ppu.obp0], ['OBP1', ppu.obp1]];
  paletteGrid.innerHTML = '';

  for (const [name, val] of regs) {
    const block = document.createElement('div');
    block.className = 'palette-block';

    const h3 = document.createElement('h3'); h3.textContent = name;
    const regVal = document.createElement('div'); regVal.className = 'reg-val'; regVal.textContent = hex8(val);
    block.appendChild(h3); block.appendChild(regVal);

    const row = document.createElement('div'); row.className = 'swatch-row';
    for (let c = 0; c < 4; c++) {
      const [r, g, b] = ppu.applyPalette(c, val);
      const sw = document.createElement('div'); sw.className = 'swatch';
      const chip = document.createElement('div'); chip.className = 'chip'; chip.style.background = `rgb(${r},${g},${b})`;
      const label = document.createElement('div'); label.className = 'label'; label.textContent = c;
      sw.appendChild(chip); sw.appendChild(label);
      row.appendChild(sw);
    }
    block.appendChild(row);
    paletteGrid.appendChild(block);
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

// Per-channel mute buttons: toggles emulator.apu.chMuted[i], which silences that channel in
// both the mixed audio output and its own scope trace. Restored from - and persisted to -
// the same sound-settings storage as the master mute/volume controls.
const scopeMuteButtons = document.querySelectorAll('.scope-mute-btn');
scopeMuteButtons.forEach(btn => {
  const ch = Number(btn.dataset.ch);
  if (savedSoundConfig && Array.isArray(savedSoundConfig.channelMuted) && savedSoundConfig.channelMuted[ch]) {
    emulator.apu.chMuted[ch] = true;
  }
  updateScopeMuteButton(btn, ch);
  btn.addEventListener('click', () => {
    emulator.apu.chMuted[ch] = !emulator.apu.chMuted[ch];
    updateScopeMuteButton(btn, ch);
    saveSoundConfig();
  });
});

function updateScopeMuteButton(btn, ch) {
  const muted = emulator.apu.chMuted[ch];
  btn.textContent = muted ? '🔇' : '🔊';
  btn.title = (muted ? 'Unmute CH' : 'Mute CH') + (ch + 1);
  btn.classList.toggle('muted', muted);
  btn.closest('.scope-block').classList.toggle('muted', muted);
}

function drawScopeChannel(canvas, buffer, writePos, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Center line, so a silent/off channel (which sits at the DAC's -1 "digital zero" level,
  // not a centered 0) still has a visible reference point.
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
  const apu = emulator.apu;
  drawScopeChannel(scopeCanvases[1], apu.scopeCh1, apu.scopeWritePos, SCOPE_COLORS[1]);
  drawScopeChannel(scopeCanvases[2], apu.scopeCh2, apu.scopeWritePos, SCOPE_COLORS[2]);
  drawScopeChannel(scopeCanvases[3], apu.scopeCh3, apu.scopeWritePos, SCOPE_COLORS[3]);
  drawScopeChannel(scopeCanvases[4], apu.scopeCh4, apu.scopeWritePos, SCOPE_COLORS[4]);
}

/* ---- 4c. Scanline timeline: where the PPU is right now within the 154-line frame, plus a
   zoomed-in view of the current line's OAM Search / Pixel Transfer / H-Blank split. Uses the
   same fixed per-mode cycle counts the PPU's step() switch above runs on, so the picture
   always matches this emulator's actual timing model. ---- */
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

function drawFrameTimeline(ppu) {
  const ctx = frameTimelineCanvas.getContext('2d');
  const w = frameTimelineCanvas.width, h = frameTimelineCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const visibleW = w * (SCANLINE_VISIBLE_LINES / SCANLINE_TOTAL_LINES);
  ctx.fillStyle = '#5ac2e0'; ctx.fillRect(0, 0, visibleW, h);
  ctx.fillStyle = '#8a5ac2'; ctx.fillRect(visibleW, 0, w - visibleW, h);

  // Faint tick marks every 16 lines, just for a sense of scale.
  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  for (let line = 16; line < SCANLINE_TOTAL_LINES; line += 16) {
    const x = Math.round((line / SCANLINE_TOTAL_LINES) * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  // Playhead: the scanline the PPU is on right now.
  const playX = (ppu.ly / SCANLINE_TOTAL_LINES) * w;
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

function drawLineTimeline(ppu) {
  const ctx = lineTimelineCanvas.getContext('2d');
  const w = lineTimelineCanvas.width, h = lineTimelineCanvas.height;
  ctx.clearRect(0, 0, w, h);

  if (ppu.mode === 1) {
    // V-Blank lines don't go through OAM Search / Pixel Transfer / H-Blank at all -
    // it's one mode for the entire 456-cycle line.
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
    ppu.mode === 2 ? [0, oamW, SCANLINE_OAM] :
    ppu.mode === 3 ? [oamW, transferW, SCANLINE_TRANSFER] :
                      [oamW + transferW, hblankW, SCANLINE_HBLANK];
  const frac = Math.min(1, ppu.modeClock / modeTotal);
  ctx.fillStyle = '#ffdd00';
  ctx.fillRect(Math.max(0, segStart + frac * segWidth - 1.5), 0, 3, h);
}

function scanlineStat(label, value) {
  return `<div class="scanline-stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function drawScanlineStats(ppu) {
  const ly = ppu.ly, mode = ppu.mode;
  const modeNames  = { 0: 'H-Blank', 1: 'V-Blank', 2: 'OAM Search', 3: 'Pixel Transfer' };
  const modeTotals = { 0: SCANLINE_HBLANK, 1: SCANLINE_LINE_CYCLES, 2: SCANLINE_OAM, 3: SCANLINE_TRANSFER };
  const modeClock = Math.min(ppu.modeClock, modeTotals[mode]);

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
  const ppu = emulator.ppu;
  drawFrameTimeline(ppu);
  drawLineTimeline(ppu);
  drawScanlineStats(ppu);
}

/* ---- 5. Live disassembler: decodes the bytes around PC into mnemonics ---- */
/* ---- Frame Activity: emulated-hardware content per frame, not JS/host timing ----
   Left canvas: one bar per recent frame, height = instructions executed that frame; click a
   bar to select it. Middle canvas: the selected frame's 154 scanlines with markers showing
   where interrupts, OAM DMA, bank switches, and APU triggers happened, plus a sprites-per-line
   sparkline; click a scanline to select it. Bottom canvas: that single scanline's fixed 456T
   mode structure plus the exact events/sprite count recorded on it. Selection defaults to
   whichever frame most recently completed. */
const frameActivityCanvas = document.getElementById('frameActivityCanvas');
const frameAnatomyCanvas = document.getElementById('frameAnatomyCanvas');
const lineAnatomyCanvas = document.getElementById('lineAnatomyCanvas');
const frameActivityCountEl = document.getElementById('frameActivityCount');
const frameAnatomyIndexEl = document.getElementById('frameAnatomyIndex');
const frameAnatomyStatsEl = document.getElementById('frameAnatomyStats');
const lineAnatomyIndexEl = document.getElementById('lineAnatomyIndex');
const lineAnatomyFrameIndexEl = document.getElementById('lineAnatomyFrameIndex');
const lineAnatomyStatsEl = document.getElementById('lineAnatomyStats');

let selectedFrameStatsIndex = null; // a frameStats.index value, or null to always follow the latest frame
let selectedAnatomyLine = null;     // a scanline 0-153 within the selected frame, or null if none chosen yet

function getFrameActivitySlice() {
  const hist = emulator.frameStatsHistory;
  return hist.slice(Math.max(0, hist.length - emulator.FRAME_STATS_HISTORY));
}

// The single frame entry both the "Anatomy of frame" and "Anatomy of line" views are showing -
// whichever frame is pinned by selectedFrameStatsIndex, or the latest one if none is pinned.
function getSelectedAnatomyEntry() {
  const hist = emulator.frameStatsHistory;
  if (hist.length === 0) return null;
  return (selectedFrameStatsIndex === null ? null : hist.find(f => f.index === selectedFrameStatsIndex))
         || hist[hist.length - 1];
}

function drawFrameActivity() {
  const ctx = frameActivityCanvas.getContext('2d');
  const w = frameActivityCanvas.width, h = frameActivityCanvas.height;
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);

  const slice = getFrameActivitySlice();
  frameActivityCountEl.textContent = slice.length;
  if (slice.length === 0) return;

  // Manual max instead of Math.max(1, ...slice.map(...)) - that allocated a fresh array via
  // map() and another via the spread every call, up to 60x/sec while running in debug mode.
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

// Clicking a bar pins the anatomy view to that specific frame; the x position maps directly
// to an index into the currently-displayed slice regardless of how the canvas is CSS-scaled.
// The previously-selected line (if any) carries over, so switching frames while a line is
// pinned lets you compare the same scanline across different frames.
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
  const ctx = frameAnatomyCanvas.getContext('2d');
  const w = frameAnatomyCanvas.width, h = frameAnatomyCanvas.height;
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);

  const entry = getSelectedAnatomyEntry();
  if (!entry) {
    frameAnatomyIndexEl.textContent = '—';
    frameAnatomyStatsEl.textContent = 'Load a ROM and let it run to see frame data.';
    return;
  }
  frameAnatomyIndexEl.textContent = '#' + entry.index;

  // Background split: visible lines 0-143 vs V-Blank lines 144-153, same proportions as the
  // scanline timeline above so the two views read consistently.
  const visibleW = w * (144 / 154);
  ctx.fillStyle = '#20303a'; ctx.fillRect(0, 0, visibleW, h);
  ctx.fillStyle = '#2a2036'; ctx.fillRect(visibleW, 0, w - visibleW, h);

  // Sprites-per-line sparkline (0-10, the hardware's per-line sprite cap) across the visible region.
  ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let line = 0; line < 144; line++) {
    const x = (line / 154) * w;
    const y = h - 3 - (entry.spritesPerLine[line] / 10) * (h - 8);
    if (line === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Event ticks: interrupts, DMA, bank switches, APU triggers, placed at the scanline they fired on.
  for (const ev of entry.events) {
    const x = (ev.line / 154) * w;
    ctx.fillStyle = FRAME_EVENT_COLORS[ev.kind] || '#fff';
    ctx.fillRect(x - 1.5, 2, 3, h - 4);
  }

  // Highlight the currently-selected scanline (if any) with an outlined column, so it's clear
  // which slice "Anatomy of line" below is describing.
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

// Clicking a scanline in "Anatomy of frame" pins the "Anatomy of line" view below it to that line.
frameAnatomyCanvas.addEventListener('click', (e) => {
  if (!getSelectedAnatomyEntry()) return;
  const rect = frameAnatomyCanvas.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  selectedAnatomyLine = Math.min(153, Math.max(0, Math.floor(frac * 154)));
  drawFrameAnatomy(); // redraw to show the highlighted column
  drawLineAnatomy();
});

// Draws the selected scanline's fixed 456T mode timeline (Mode 2/3/0 for a visible line, or a
// single Mode 1 span for a V-Blank line) and lists exactly what was recorded on that line:
// sprites drawn and any interrupt/DMA/bank/APU events. This emulator uses fixed-length modes
// (see the Scanline Timeline tool above), so the mode split is always the same shape for every
// visible line - what differs line to line is only the sprite count and the events list.
function drawLineAnatomy() {
  const ctx = lineAnatomyCanvas.getContext('2d');
  const w = lineAnatomyCanvas.width, h = lineAnatomyCanvas.height;
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);

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
    // Mode 2 (80T) -> Mode 3 (172T) -> Mode 0 (204T), drawn to scale across the 456T line.
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
    // V-Blank lines are Mode 1 for their entire 456T - no OAM Search / Pixel Transfer / H-Blank split.
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
    // Group same-kind events (e.g. two APU triggers on one line) into a single "x N" entry.
    const counts = {};
    for (const ev of events) counts[ev.kind] = (counts[ev.kind] || 0) + 1;
    for (const kind of Object.keys(counts)) {
      html += `<span><i style="background:${FRAME_EVENT_COLORS[kind] || '#fff'};width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:5px;"></i>`
            + `${FRAME_EVENT_LABELS[kind] || kind}${counts[kind] > 1 ? ' &times;' + counts[kind] : ''}</span>`;
    }
  }
  lineAnatomyStatsEl.innerHTML = html;
}

// Cache of the previous frame's "before PC" resync result for the Disassembly panel. PC
// almost always advances by exactly the length of whatever instruction was "current" last
// frame (straight-line execution - no jump/call/ret actually taken this step), in which case
// the previous frame's already-resynced boundaries are still valid: just slide the window
// forward by pushing that now-past instruction onto the tail and dropping the oldest line,
// with zero new resync decoding needed. Also short-circuits when PC didn't move at all (e.g.
// HALTed). Only falls back to the up-to-12x-forward-decode resync search when neither holds
// (an actual jump was taken, single-stepped over one, a breakpoint landed elsewhere, or a
// new ROM was loaded - the `rom` reference check below invalidates the cache in that case).
let disasmResyncCache = null; // { pc, rom, beforeLines, currentText, nextExpectedPc } or null

function drawDisassembly() {
  if (!lastROMBytes) { disasmList.innerHTML = '<div class="disasm-empty">Load a ROM to see disassembly.</div>'; disasmResyncCache = null; return; }
  const mmu = emulator.mmu, pc = emulator.cpu.PC;
  const COUNT_BEFORE = 5, COUNT_AFTER = 9, MAX_LOOKBACK = 12;

  let beforeLines;
  const cache = disasmResyncCache;
  if (cache && cache.rom === mmu.rom && cache.pc === pc) {
    // PC hasn't moved since the last redraw (e.g. HALTed) - identical result, no work needed.
    beforeLines = cache.beforeLines;
  } else if (cache && cache.rom === mmu.rom && cache.nextExpectedPc === pc) {
    // Straight-line advance from last frame: slide the window forward instead of re-running
    // the resync search - the instruction that was "current" becomes the new newest "before" line.
    beforeLines = cache.beforeLines.slice(1);
    beforeLines.push({ addr: cache.pc, text: cache.currentText });
  } else {
    // GB machine code isn't self-synchronizing, so to find instruction boundaries *before*
    // PC, try progressively shorter lookbacks and keep the longest one that decodes forward
    // and lands exactly back on PC (a genuine resync), rather than guessing at a byte offset.
    beforeLines = [];
    for (let back = MAX_LOOKBACK; back >= 1; back--) {
      let addr = pc - back;
      if (addr < 0) continue;
      const insns = [];
      while (addr < pc) {
        const { text, length } = disassembleAt(mmu, addr & 0xFFFF);
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
    const { text, length } = disassembleAt(mmu, addr & 0xFFFF);
    lines.push({ addr: addr & 0xFFFF, text, current: i === 0 });
    if (i === 0) { currentText = text; currentLength = length; }
    addr += length;
  }

  disasmResyncCache = { pc, rom: mmu.rom, beforeLines, currentText, nextExpectedPc: (pc + currentLength) & 0xFFFF };

  disasmList.innerHTML = lines.map(l =>
    `<div class="disasm-line${l.current ? ' current' : ''}">${hex16(l.addr)}&nbsp;&nbsp;${l.text}</div>`
  ).join('');

  if (lines.some(l => l.current)) {
    const cur = disasmList.querySelector('.disasm-line.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }
}

/* ---- Interrupts panel: IME/IE/IF live status plus a log of recently-serviced interrupts ---- */
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
  const cpu = emulator.cpu, mmu = emulator.mmu;
  const ie = mmu.ie & 0x1F;
  const iff = mmu.io[0x0F] & 0x1F;

  intSummary.innerHTML =
    `<span class="int-ime ${cpu.IME ? 'on' : 'off'}">IME ${cpu.IME ? 'ON' : 'OFF'}</span>` +
    `<span class="int-reg">IE=${hex8(ie)}</span>` +
    `<span class="int-reg">IF=${hex8(iff)}</span>` +
    (cpu.halted ? `<span class="int-halted">HALTed — waiting for an interrupt</span>` : '');

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

  const log = emulator.interruptLog;
  intLog.innerHTML = log.length === 0
    ? '<div class="int-log-empty">No interrupts serviced yet.</div>'
    : log.slice().reverse().map(e =>
        `<div class="int-log-line">frame ${e.frame}&nbsp;&nbsp;${INTERRUPT_SOURCES[e.bit].name} → ${hex16(INTERRUPT_SOURCES[e.bit].vector)}` +
        `&nbsp;&nbsp;(from ${hex16(e.pcBefore)})</div>`
      ).join('');
}

/* ---- Stack panel: a window of 16-bit words around SP ----
   Rows are aligned to SP itself (not to an even/odd address) since that's what PUSH/POP
   actually step by two from. WORDS_ABOVE covers still-unused stack space just below SP
   in address terms (deeper future pushes); WORDS_BELOW covers words already on the stack
   that a POP/RET further up the call chain would eventually read. */
function drawStack() {
  if (!lastROMBytes) { stackList.innerHTML = '<div class="disasm-empty">Load a ROM to see the stack.</div>'; stackSpReadout.textContent = '—'; return; }
  const mmu = emulator.mmu, sp = emulator.cpu.SP;
  const WORDS_ABOVE = 6, WORDS_BELOW = 22;

  stackSpReadout.textContent = `SP = ${hex16(sp)}  (top of stack — next POP/RET reads from here)`;

  const rows = [];
  for (let i = -WORDS_ABOVE; i <= WORDS_BELOW; i++) {
    const addr = (sp + i * 2) & 0xFFFF;
    // peek8, not read8: this is the debugger looking at memory, not something the CPU/game
    // actually did - read8 would both pay noteAccess's bookkeeping cost needlessly and
    // misattribute these 29 reads/frame to CPU activity on the Mem Map's "last access" flash.
    const lo = mmu.peek8(addr);
    const hi = mmu.peek8((addr + 1) & 0xFFFF);
    const word = lo | (hi << 8);
    rows.push({ addr, word, current: i === 0, below: i > 0 });
  }

  stackList.innerHTML = rows.map(r =>
    `<div class="disasm-line${r.current ? ' current' : ''}${r.below && !r.current ? ' stack-line-below' : ''}">` +
    `${hex16(r.addr)}&nbsp;&nbsp;${hex16(r.word)}${r.current ? '&nbsp;&nbsp;← SP' : ''}</div>`
  ).join('');

  const cur = stackList.querySelector('.disasm-line.current');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

/* ---- 5b. CPU registers editor: reads straight off (and, when paused, writes straight onto)
   the CPU instance's own fields - A B C D E H L, SP, PC, the four flag bits, and IME/halted.
   These are plain JS properties on the CPU object, not memory addresses, so edits never go
   through the MMU (no mmu.write8() involved) - just `cpu[key] = value` directly. ---- */

// Accepts an optional "0x" prefix (case-insensitive) so the field can round-trip hex8/hex16's
// own formatting; returns null (meaning "reject, keep the old value") for anything that isn't
// clean hex, rather than trying to guess what the student meant.
function parseHexInput(str, maxVal) {
  const clean = str.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(clean)) return null;
  const v = parseInt(clean, 16);
  if (Number.isNaN(v)) return null;
  return Math.max(0, Math.min(maxVal, v));
}

// Applies one 8/16-bit register field on blur/Enter. Bails out (just redrawing to restore the
// live value) if the emulator is running - inputs are disabled while running, but this is a
// second line of defense in case a value was already in flight when Start/Resume was pressed.
function commitRegInput(input) {
  const spec = REG_INPUTS.find(r => r.el === input);
  if (!emulator.running && spec) {
    const parsed = parseHexInput(input.value, spec.bits === 16 ? 0xFFFF : 0xFF);
    if (parsed !== null) emulator.cpu[spec.key] = parsed;
  }
  drawRegisters();
}

function commitRegFlag(checkbox) {
  if (!emulator.running) {
    const spec = REG_FLAGS.find(r => r.el === checkbox);
    if (spec) emulator.cpu[spec.key] = checkbox.checked;
  }
  drawRegisters();
}

REG_INPUTS.forEach(({ el }) => {
  el.addEventListener('blur', () => commitRegInput(el));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
});
REG_FLAGS.forEach(({ el }) => { el.addEventListener('change', () => commitRegFlag(el)); });

function drawRegisters() {
  const cpu = emulator.cpu;
  const running = emulator.running;

  REG_INPUTS.forEach(({ el, key, bits }) => {
    // Never stomp on what's currently being typed - only the field the student isn't
    // actively focused on gets repainted from the live CPU value.
    if (document.activeElement !== el) el.value = bits === 16 ? hex16(cpu[key]) : hex8(cpu[key]);
    el.disabled = running;
  });

  REG_FLAGS.forEach(({ el, key }) => {
    el.checked = !!cpu[key];
    el.disabled = running;
  });

  REG_DERIVED.BC.textContent = `BC = ${hex16(cpu.getBC())}`;
  REG_DERIVED.DE.textContent = `DE = ${hex16(cpu.getDE())}`;
  REG_DERIVED.HL.textContent = `HL = ${hex16(cpu.getHL())}`;

  regPausedNote.style.display = running ? '' : 'none';

  regIoReadout.textContent = `LY=${emulator.ppu.ly}  Mode=${emulator.ppu.mode}  LCDC=${hex8(emulator.ppu.lcdc)}`;
}

drawRegisters(); // paint the boot-state register values immediately, before any ROM is loaded

/* ---- 6. Execution trace: scrollback of the last instructions actually executed ---- */

// Sizes #traceList to match the height of the neighboring main-content column (screen +
// controls + save states) - no taller, and normally with no inner scrollbar. This is only
// ever called while the Execution Trace tab is the active one; the disassembler,
// registers, memory map, and MBC banking panels are never touched by it and keep their
// own normal compact height.
function syncTraceListHeight() {
  const mainContent = document.querySelector('.main-content');
  const sidebar = document.querySelector('.debug-tools-sidebar');
  if (!mainContent || !sidebar) return;
  const mainHeight = mainContent.getBoundingClientRect().height;
  // Everything in the sidebar other than the trace list itself (heading, tabs,
  // step/breakpoint controls, description text) - keep that chrome at its natural
  // size and only stretch the trace list, so the sidebar's *total* height ends up
  // matching main-content rather than just the trace list in isolation.
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

// Cache of decoded mnemonic + plain-English explanation for each execution-trace ring-buffer
// slot (0..TRACE_SIZE-1), so drawTrace() doesn't have to re-run disassembleBytes()/
// explainInstruction() for every visible row on every redraw - only for slots whose content
// actually changed since we last drew that physical index. A game idling in a wait loop (the
// common case while staring at the Trace tab) tends to keep landing on the same handful of
// (addr, opcode) pairs at roughly the same ring-buffer offsets frame to frame, so most slots
// hit the cache; addr/b0/b1/b2 are checked on every lookup so a slot that really did get
// overwritten with different bytes is always recomputed rather than shown stale.
const traceDecodeCache = new Array(emulator.TRACE_SIZE).fill(null);

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

  // This runs every rendered frame while the emulator is running. Thousands of
  // instructions can execute per frame, so the "last 200" window below is effectively
  // brand new content each call. Re-rendering it while the user is scrolled up would make
  // whatever they're reading get silently swapped out for newer instructions - which looks
  // exactly like the view auto-scrolling down, even though nothing touches scrollTop.
  // So: only live-update while the user is pinned to the bottom (i.e. actively following
  // execution). Otherwise, freeze the DOM as-is until they scroll back down or click
  // "Jump to latest" themselves.
  if (!isTraceAtBottom() && traceList.childElementCount > 0 && !traceList.querySelector('.trace-empty')) {
    btnTraceFollow.style.display = '';
    traceFrozenNote.style.display = '';
    return;
  }
  btnTraceFollow.style.display = 'none';
  traceFrozenNote.style.display = 'none';

  const entries = emulator.getTraceEntries();
  if (entries.length === 0) { traceList.innerHTML = '<div class="trace-empty">No instructions executed yet.</div>'; return; }
  const recent = entries.slice(-200); // cap rendered rows; the ring buffer itself holds more

  // Collapse runs of consecutive entries that share the same (addr, opcode) - e.g. a tight
  // `JR NZ,-5`-style spin loop landing on the same instruction over and over - into a single
  // row with a "× N" badge, so the interesting instructions before/after it aren't buried.
  // idx is carried along from the first entry in the run - decode only depends on the bytes
  // (identical for the whole group by construction), so any member's slot works as the cache key.
  const groups = [];
  for (const e of recent) {
    const last = groups[groups.length - 1];
    if (last && last.addr === e.addr && last.b0 === e.b0) { last.count++; last.last = e; }
    else groups.push({ addr: e.addr, b0: e.b0, b1: e.b1, b2: e.b2, idx: e.idx, count: 1, last: e });
  }

  traceList.innerHTML = groups.map((g, i) => {
    const { text, explain } = getTraceDecoded(g.idx, g.addr, g.b0, g.b1, g.b2);
    const isLatest = i === groups.length - 1;
    // Show the diff from the most recent occurrence in the run - the one whose effect is
    // still visible in the current register state.
    const diff = g.last.diff;
    const repeatBadge = g.count > 1 ? `<span class="trace-repeat">× ${g.count}</span>` : '';
    return `<div class="trace-line${isLatest ? ' latest' : ''}">` +
             `<span class="trace-code">${hex16(g.addr)}&nbsp;&nbsp;${hex8(g.b0)}&nbsp;&nbsp;${text}</span>` +
             repeatBadge +
             (diff ? `<span class="trace-diff">${diff}</span>` : '') +
             `<span class="trace-explain">${explain}</span>` +
           `</div>`;
  }).join('');
  traceList.scrollTop = traceList.scrollHeight; // we're pinned to the bottom, so stay pinned
}

// Manual scroll (not caused by our own re-render) should immediately reflect frozen/live
// state, rather than waiting for the next emulation frame to notice.
traceList.addEventListener('scroll', () => {
  const atBottom = isTraceAtBottom();
  btnTraceFollow.style.display = atBottom ? 'none' : '';
  traceFrozenNote.style.display = atBottom ? 'none' : '';
});

btnTraceFollow.addEventListener('click', () => {
  traceList.scrollTop = traceList.scrollHeight;
  drawTrace(); // immediately refresh with whatever's happened since we froze, instead of waiting for the next frame
});

// Exports the *entire* trace ring buffer (up to TRACE_SIZE entries, not just the ~200
// rows drawTrace() renders to the DOM) as a plain-text file: one line per executed
// instruction, address + raw opcode byte + disassembly + the register/flag diff it
// caused + the same plain-English explanation shown next to each row on screen.
// Consecutive repeats are collapsed with a "x N" suffix, same as the on-screen view, so
// a tight spin loop doesn't produce hundreds of identical lines.
function buildTraceExportText() {
  const entries = emulator.getTraceEntries();
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
    const url = URL.createObjectURL(blob);
    const safeName = (emulator.romTitle || 'rom').replace(/[^a-z0-9_-]+/gi, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.trace.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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

  // Frame Activity isn't a tab - it's always visible below the 3-column layout - so it
  // redraws every time regardless of which tabs are currently active above.
  drawFrameActivity();
  drawFrameAnatomy();
  drawLineAnatomy();
}

// Fallback redraw for when the emulator isn't actively running (paused, stepping, or no
// ROM loaded yet) - e.g. after loading a save state by hand. While running, the loop()
// itself calls refreshDebugTools() paced by the current speed, so this skips redundant
// (and speed-uncorrelated) redraws in that case.
setInterval(() => { if (!emulator.running) refreshDebugTools(); }, 150);
