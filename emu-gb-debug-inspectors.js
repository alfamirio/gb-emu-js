/* =========================================================================================
   emu-gb-debug-inspectors.js — Debug Tools sidebar
   -----------------------------------------------------------------------------------------
   Renders every panel under the "Debug Tools" sidebar tab group:

   - Editable CPU registers/flags panel (writes directly to CPU state while paused).
   - Memory map strip + MBC banking panel.
   - RAM editor (hex + I/O bit-level views).
   - Memory Scanner (Cheat Engine-style value search) + Saved Cheats.
   - Frame Activity (per-frame instruction count, frame anatomy, line anatomy) — always
     visible, not a tab, but grouped here since it's core execution/debug info.
   - Live disassembler.
   - Interrupts panel (IME/IE/IF + recently-serviced log).
   - Stack panel.
   - Execution trace (scrollback of executed instructions).
   - Event log (unified hardware + system event scrollback).

   Depends on DOM refs and helpers declared in emu-gb-debug-core.js (debugToolsContainer,
   flashCopiedInline) and on drawing functions from emu-gb-debug-visualizers.js
   (refreshDebugTools calls both, but only from callbacks/timers, so load order relative to
   the visualizers file doesn't matter — it just needs to load after emu-gb-debug-core.js).

   Load order (required): after emu-gb-debug-core.js.
   ========================================================================================= */

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
const traceAutoscrollToggle = document.getElementById('traceAutoscrollToggle');

/* ---- 8b. Event log panel refs ---- */
const eventLogList = document.getElementById('eventLogList');
const eventLogLevelSelect = document.getElementById('eventLogLevelSelect');
const eventLogFilterBoxes = [...document.querySelectorAll('.event-log-filter')];
const btnExportEventLog = document.getElementById('btnExportEventLog');
const btnEventLogFollow = document.getElementById('btnEventLogFollow');
const eventLogFrozenNote = document.getElementById('eventLogFrozenNote');
const eventLogAutoscrollToggle = document.getElementById('eventLogAutoscrollToggle');

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

// ---- Single source of truth for the GB address map (0x0000-0xFFFF). Every debug panel that
// needs to know where a region lives (Memory Map strip, RAM Editor, Memory Scanner) reads
// base/length/label/color/purpose from here instead of keeping its own copy, so a region's
// boundaries or description only ever need to change in one place. `minPx` is a rendering-only
// floor width used by the Memory Map strip; `aliasOf` marks ECHO as a mirror of WRAM for the
// access-flash logic below. `range` is filled in just below from base/length rather than
// hand-typed, so it can't drift out of sync with them. ----
const MEMORY_REGIONS = {
  ROM0:   { label: 'ROM Bank 0', base: 0x0000, length: 0x4000, color: '#5a9bd8', minPx: 46,
    purpose: 'Fixed 16KB ROM bank, always mapped. Entry point, interrupt vectors, resident code/data.' },
  ROMX:   { label: 'ROM Bank N', base: 0x4000, length: 0x4000, color: '#8fc0ec', minPx: 46,
    purpose: 'Switchable 16KB ROM bank, swapped by the mapper (MBC) for games larger than 32KB.' },
  VRAM:   { label: 'VRAM', base: 0x8000, length: 0x2000, color: '#e0a63d', minPx: 34,
    purpose: 'Video RAM: tile pixel data and BG/window tile maps, read by the PPU each scanline.' },
  ERAM:   { label: 'Cart RAM', base: 0xA000, length: 0x2000, color: '#d9534f', minPx: 34,
    purpose: 'Optional cartridge RAM (SRAM) for save data or MBC3 RTC registers. Mapper-gated.' },
  WRAM:   { label: 'WRAM', base: 0xC000, length: 0x2000, color: '#5cb85c', minPx: 34,
    purpose: 'General-purpose work RAM: variables, stack, internal state.' },
  ECHO:   { label: 'Echo RAM', base: 0xE000, length: 0x1E00, color: '#3f7a3f', minPx: 22, aliasOf: 'WRAM',
    purpose: 'Mirror of WRAM 0xC000-0xDDFF; reads/writes here hit WRAM.' },
  OAM:    { label: 'OAM', base: 0xFE00, length: 0x00A0, color: '#b366cc', minPx: 20,
    purpose: 'Object Attribute Memory: up to 40 sprite entries composited by the PPU each scanline.' },
  UNUSED: { label: 'Unused', base: 0xFEA0, length: 0x0060, color: '#3a3a42', minPx: 16,
    purpose: 'Unmapped on DMG hardware; returns inconsistent values depending on model.' },
  IO:     { label: 'I/O Regs', base: 0xFF00, length: 0x0080, color: '#e05fb0', minPx: 20,
    purpose: 'Memory-mapped hardware registers: joypad, serial, timers, sound, LCD/PPU control.' },
  HRAM:   { label: 'HRAM', base: 0xFF80, length: 0x007F, color: '#f0d84a', minPx: 20,
    purpose: 'High RAM, 127 bytes, fastest to access. Common scratch space during OAM DMA.' },
  IE:     { label: 'IE', base: 0xFFFF, length: 0x0001, color: '#f5f5f5', minPx: 16,
    purpose: 'Interrupt Enable register, one bit per interrupt source.' },
};
// Display order for the Memory Map strip (and the basis for RAMEDIT_ORDER below).
const MEMORY_REGION_ORDER = ['ROM0', 'ROMX', 'VRAM', 'ERAM', 'WRAM', 'ECHO', 'OAM', 'UNUSED', 'IO', 'HRAM', 'IE'];

// "0x0000–0x3FFF"-style label, derived from base/length so it can't drift from the numbers above.
function memRegionRangeLabel(base, length) {
  return length <= 1 ? hex16(base) : `${hex16(base)}\u2013${hex16(base + length - 1)}`;
}
MEMORY_REGION_ORDER.forEach(key => { MEMORY_REGIONS[key].range = memRegionRangeLabel(MEMORY_REGIONS[key].base, MEMORY_REGIONS[key].length); });

let memRegionEls = {}; // key -> { el, key } (ECHO shares WRAM's flash key via aliasOf)

function buildMemMapStrip() {
  memmapStrip.innerHTML = '';
  memRegionEls = {};
  MEMORY_REGION_ORDER.forEach(key => {
    const r = MEMORY_REGIONS[key];
    const el = document.createElement('div');
    el.className = 'mem-region';
    el.style.flex = `${r.length} 0 ${r.minPx}px`;
    el.style.background = r.color;
    el.title = `${r.label} (${r.range})\n${r.purpose}`;
    el.innerHTML = `<span class="mem-label">${r.label}</span><span class="mem-range">${r.range}</span>` +
      (key === 'ROMX' ? '<span class="mem-bank" id="mmRomBankTag">Bank 1</span>' : '');
    memmapStrip.appendChild(el);
    memRegionEls[key] = el;
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

  const regionMeta = MEMORY_REGIONS[a.region === 'WRAM' && a.addr >= 0xE000 ? 'ECHO' : a.region];
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
// Same regions/order as the Memory Map strip, minus UNUSED (nothing to usefully edit there).
const RAMEDIT_ORDER = MEMORY_REGION_ORDER.filter(key => key !== 'UNUSED');
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
  const mm = MEMORY_REGIONS[key];
  return { key, base: mm.base, length: mm.length, editable: m.editable, mode: m.mode, note: m.note, label: mm.label, color: mm.color, range: mm.range, purpose: mm.purpose };
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


/* ---- Memory Scanner: Cheat Engine-style value search, used to hunt down which address holds
   something like lives/HP/coins/a timer. Two-phase workflow:
     1. "New Scan" snapshots every byte (or LE word) in the checked regions, optionally filtered
        to an exact starting value.
     2. "Next Scan" repeatedly narrows that candidate set by comparing each candidate's *live*
        value against the value it had at the last scan (changed/unchanged/increased/decreased/
        exact/by-delta) until only a couple of addresses are left.
   Also supports freezing a found address so its value is rewritten every frame - handy for
   confirming a find (infinite lives) or just for a permanent cheat. ---- */
const memScanRegionsEl = document.getElementById('memScanRegions');
const memScanSizeEl = document.getElementById('memScanSize');
const memScanTypeEl = document.getElementById('memScanType');
const memScanValueEl = document.getElementById('memScanValue');
const memScanValueWrapEl = document.getElementById('memScanValueWrap');
const memScanNewBtn = document.getElementById('memScanNewBtn');
const memScanNextBtn = document.getElementById('memScanNextBtn');
const memScanResetBtn = document.getElementById('memScanResetBtn');
const memScanSummaryEl = document.getElementById('memScanSummary');
const memScanBodyEl = document.getElementById('memScanBody');
const memScanFrozenSectionEl = document.getElementById('memScanFrozenSection');
const memScanFrozenListEl = document.getElementById('memScanFrozenList');
const memScanSavedListEl = document.getElementById('memScanSavedList');

// Regions worth scanning for live game state. ROM/banking regs are constant or side-effecting,
// and IO/IE are covered far better by the RAM Editor's per-bit view, so they're left out here.
// Which regions the Memory Scanner offers, and whether each is checked by default. base/length
// come from MEMORY_REGIONS (the single source of truth) rather than being retyped here.
const MEMSCAN_REGION_DEFAULTS = { WRAM: true, HRAM: true, OAM: false, ERAM: false, VRAM: false };
const MEMSCAN_REGIONS = Object.keys(MEMSCAN_REGION_DEFAULTS).map(key => ({
  key, base: MEMORY_REGIONS[key].base, length: MEMORY_REGIONS[key].length, defaultOn: MEMSCAN_REGION_DEFAULTS[key],
}));
const MEMSCAN_MAX_ROWS = 300; // render cap - narrow the scan further if you hit this

const MEMSCAN_INITIAL_TYPES = [
  { value: 'exact',   label: 'Exact value' },
  { value: 'unknown', label: 'Unknown initial value' },
];
const MEMSCAN_NEXT_TYPES = [
  { value: 'exact',       label: 'Equal to value' },
  { value: 'changed',     label: 'Changed' },
  { value: 'unchanged',   label: 'Unchanged' },
  { value: 'increased',   label: 'Increased' },
  { value: 'decreased',   label: 'Decreased' },
  { value: 'increasedby', label: 'Increased by...' },
  { value: 'decreasedby', label: 'Decreased by...' },
];

let memScanCandidates = null;      // null until a scan has run; else Map<addr, {value, size}>
let memScanActiveSize = 1;         // byte width locked in for the current scan
let memScanFrozen = new Map();     // addr -> {value, size} - rewritten every emulated frame

// ---- Saved cheats: name + address + size, persisted in localStorage keyed by the loaded
// ROM's CRC32 (plus its title, kept just for display/debugging the storage). Reappears in the
// "Saved cheats for this ROM" list any time this same ROM is loaded again, ready to re-apply
// (apply = freeze, same mechanism as the manual Freeze checkboxes below). Storage key comes
// from the central STORAGE_KEYS registry in app.js. ----

function loadCheatStore() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.MEMSCAN_CHEATS)) || {}; }
  catch (e) { return {}; } // corrupt JSON or storage blocked - fail to an empty store
}

function saveCheatStore(store) {
  try { localStorage.setItem(STORAGE_KEYS.MEMSCAN_CHEATS, JSON.stringify(store)); }
  catch (e) { /* storage full/blocked - silently ignore, matches saveSlots() precedent in app.js */ }
}

// CRC32 of the currently loaded ROM's raw bytes, used as the storage key so cheats are matched
// to the exact ROM image (not just its title, which different hacks/homebrews can share).
function currentRomCrc32() {
  if (!lastROMBytes) return null;
  return crc32(lastROMBytes).toString(16).toUpperCase().padStart(8, '0');
}

function getCheatsForCurrentRom() {
  const key = currentRomCrc32();
  if (!key) return [];
  return loadCheatStore()[key]?.cheats || [];
}

// Adds a new named cheat, or overwrites an existing one already saved at the same address+size.
function saveCheatForCurrentRom(name, addr, size) {
  const key = currentRomCrc32();
  if (!key) return;
  const store = loadCheatStore();
  if (!store[key]) store[key] = { romName: emulator.romTitle || 'Untitled', cheats: [] };
  store[key].romName = emulator.romTitle || store[key].romName || 'Untitled';
  const idx = store[key].cheats.findIndex(c => c.addr === addr && c.size === size);
  const entry = { name, addr, size };
  if (idx >= 0) store[key].cheats[idx] = entry; else store[key].cheats.push(entry);
  saveCheatStore(store);
}

function deleteCheatForCurrentRom(addr, size) {
  const key = currentRomCrc32();
  if (!key) return;
  const store = loadCheatStore();
  if (!store[key]) return;
  store[key].cheats = store[key].cheats.filter(c => !(c.addr === addr && c.size === size));
  saveCheatStore(store);
}

// Saved cheat names are user text rendered via innerHTML below - escape before inserting.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildMemScanRegionCheckboxes() {
  memScanRegionsEl.innerHTML = '';
  MEMSCAN_REGIONS.forEach(r => {
    const meta = MEMORY_REGIONS[r.key];
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.region = r.key;
    cb.checked = r.defaultOn;
    label.appendChild(cb);
    label.append(`${meta.label} (${meta.range})`);
    memScanRegionsEl.appendChild(label);
  });
}

function memScanPopulateTypeOptions(list) {
  const prevValue = memScanTypeEl.value;
  memScanTypeEl.innerHTML = '';
  list.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    memScanTypeEl.appendChild(opt);
  });
  memScanTypeEl.value = list.some(o => o.value === prevValue) ? prevValue : list[0].value;
  memScanUpdateValueVisibility();
}

function memScanUpdateValueVisibility() {
  const needsValue = ['exact', 'increasedby', 'decreasedby'].includes(memScanTypeEl.value);
  memScanValueEl.disabled = !needsValue;
  memScanValueWrapEl.style.opacity = needsValue ? '1' : '.4';
}
memScanTypeEl.addEventListener('change', memScanUpdateValueVisibility);

// Accepts decimal ("3") or hex ("0x03"); returns null if empty/invalid/out of range for `size`.
function parseMemScanValue(str, size) {
  if (str == null) return null;
  const s = str.trim();
  if (s === '') return null;
  const v = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  if (Number.isNaN(v)) return null;
  const max = size === 1 ? 0xFF : 0xFFFF;
  if (v < 0 || v > max) return null;
  return v;
}

function memScanReadValue(addr, size) {
  const lo = emulator.instrumentation.peekByte(addr);
  if (size === 1) return lo;
  return lo | (emulator.instrumentation.peekByte(addr + 1) << 8);
}

function memScanRegionKeyForAddr(addr) {
  const r = MEMSCAN_REGIONS.find(m => addr >= m.base && addr < m.base + m.length);
  return r ? r.key : '?';
}

// Jumps into the RAM Editor tab focused on `addr` - lets a scan result be inspected/edited
// with the fuller hex-dump view (ASCII column, surrounding bytes, etc).
function jumpToRamEditor(addr) {
  const key = RAMEDIT_ORDER.find(k => addr >= MEMORY_REGIONS[k].base && addr < MEMORY_REGIONS[k].base + MEMORY_REGIONS[k].length);
  if (!key) return;
  ramEditKey = key;
  const rel = addr - MEMORY_REGIONS[key].base;
  ramEditOffset = Math.max(0, Math.min(MEMORY_REGIONS[key].length - RAMEDIT_PAGE, Math.floor(rel / 16) * 16));
  buildRamEditRegionTabs();
  buildRamEditBody();
  debugToolsContainer.querySelector('.tool-tab[data-tool="ramedit"]').click();
}

function toggleMemScanFreeze(addr, size, checked) {
  if (checked) memScanFrozen.set(addr, { value: memScanReadValue(addr, size), size });
  else memScanFrozen.delete(addr);
  refreshFreezeRelatedUI();
}

// Freeze state is shown in three places at once (scan-table checkboxes, the Frozen addresses
// list, and the Apply checkboxes in Saved Cheats) - whenever memScanFrozen changes, redraw all
// three from it rather than trying to keep each mutation in sync by hand.
function refreshFreezeRelatedUI() {
  drawMemScanFrozenList();
  drawSavedCheats();
  memScanBodyEl.querySelectorAll('.memscan-freeze-cell input').forEach(cb => {
    cb.checked = memScanFrozen.has(parseInt(cb.dataset.addr, 10));
  });
}

function drawMemScanFrozenList() {
  memScanFrozenSectionEl.style.display = memScanFrozen.size > 0 ? '' : 'none';
  memScanFrozenListEl.innerHTML = '';
  memScanFrozen.forEach((entry, addr) => {
    const row = document.createElement('div');
    row.className = 'memscan-frozen-row';
    row.innerHTML = `
      <span class="memscan-frozen-addr">${hex16(addr)}</span>
      <input type="text" class="memscan-value-input" style="width:70px" value="${entry.value}">
      <button class="ui-btn small ghost" type="button">Unfreeze</button>
    `;
    row.querySelector('input').addEventListener('change', e => {
      const v = parseMemScanValue(e.target.value, entry.size);
      if (v !== null) entry.value = v;
      else e.target.value = entry.value; // reject bad input, restore last-good value
    });
    row.querySelector('button').addEventListener('click', () => {
      memScanFrozen.delete(addr);
      refreshFreezeRelatedUI();
    });
    memScanFrozenListEl.appendChild(row);
  });
}

// Renders the persistent "Saved cheats for this ROM" list from localStorage. Each row's Apply
// checkbox just drives the same memScanFrozen map as the ad-hoc Freeze checkboxes in the scan
// results table - saving a cheat only remembers the address; it doesn't apply it by itself.
function drawSavedCheats() {
  if (!lastROMBytes) {
    memScanSavedListEl.innerHTML = '<div class="memscan-empty">Load a ROM to manage cheats.</div>';
    return;
  }
  const cheats = getCheatsForCurrentRom();
  if (cheats.length === 0) {
    memScanSavedListEl.innerHTML = '<div class="memscan-empty">No saved cheats for this ROM yet — find an address below, name it, and save it.</div>';
    return;
  }
  memScanSavedListEl.innerHTML = '';
  cheats.forEach(({ name, addr, size }) => {
    const applied = memScanFrozen.has(addr);
    const curVal = applied ? memScanFrozen.get(addr).value : memScanReadValue(addr, size);
    const row = document.createElement('div');
    row.className = 'memscan-saved-row';
    row.innerHTML = `
      <input type="checkbox" class="memscan-saved-apply" ${applied ? 'checked' : ''} title="Apply (freeze this address)">
      <span class="memscan-saved-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="memscan-saved-addr">${hex16(addr)}</span>
      <span class="memscan-saved-size">${size === 1 ? '1B' : '2B'}</span>
      <input type="text" class="memscan-value-input memscan-saved-value" value="${curVal}" ${applied ? '' : 'disabled'}>
      <button class="ui-btn small ghost" type="button" data-action="view">View</button>
      <button class="ui-btn small ghost" type="button" data-action="delete">Delete</button>
    `;
    row.querySelector('.memscan-saved-apply').addEventListener('change', e => {
      toggleMemScanFreeze(addr, size, e.target.checked);
    });
    row.querySelector('.memscan-saved-value').addEventListener('change', e => {
      const v = parseMemScanValue(e.target.value, size);
      const frozen = memScanFrozen.get(addr);
      if (v !== null && frozen) frozen.value = v;
      else e.target.value = frozen ? frozen.value : curVal;
    });
    row.querySelector('[data-action="view"]').addEventListener('click', () => jumpToRamEditor(addr));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      deleteCheatForCurrentRom(addr, size);
      if (memScanFrozen.has(addr)) { memScanFrozen.delete(addr); refreshFreezeRelatedUI(); }
      else drawSavedCheats();
    });
    memScanSavedListEl.appendChild(row);
  });
}

// Called every emulated frame (play or step), independent of which debug tab is open, so a
// freeze keeps working while actually playing and not just while the scanner panel is visible.
function applyMemScanFreezes() {
  memScanFrozen.forEach((entry, addr) => {
    emulator.instrumentation.writeMemory(addr, entry.value & 0xFF);
    if (entry.size === 2) emulator.instrumentation.writeMemory(addr + 1, (entry.value >> 8) & 0xFF);
  });
}
const _memScanPrevOnFrame = emulator.onFrame;
emulator.onFrame = frameStats => {
  applyMemScanFreezes();
  if (_memScanPrevOnFrame) _memScanPrevOnFrame(frameStats);
};

// Full rebuild of the results table - only called when the candidate *set* changes (New/Next/
// Reset), not on every refresh tick, since redoing ~300 rows of DOM every frame would be wasteful.
function buildMemScanTable() {
  memScanBodyEl.innerHTML = '';
  if (!memScanCandidates || memScanCandidates.size === 0) {
    memScanBodyEl.innerHTML = `<div class="memscan-empty">${
      memScanCandidates ? 'No addresses match — hit Reset and try a different scan.' : 'No scan yet.'
    }</div>`;
    return;
  }
  const entries = [...memScanCandidates.entries()].slice(0, MEMSCAN_MAX_ROWS);
  const table = document.createElement('table');
  table.className = 'memscan-table';
  table.innerHTML = '<thead><tr><th>Address</th><th>Region</th><th>Value</th><th>Prev</th><th>Freeze</th><th>Name &amp; save</th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  entries.forEach(([addr, entry]) => {
    const tr = document.createElement('tr');
    const cur = memScanReadValue(addr, entry.size);
    tr.innerHTML = `
      <td class="memscan-addr" data-addr="${addr}">${hex16(addr)}</td>
      <td class="memscan-region">${memScanRegionKeyForAddr(addr)}</td>
      <td class="memscan-cur" data-addr="${addr}" data-size="${entry.size}">${cur}</td>
      <td class="memscan-prev">${entry.value}</td>
      <td class="memscan-freeze-cell"><input type="checkbox" data-addr="${addr}" ${memScanFrozen.has(addr) ? 'checked' : ''}></td>
      <td class="memscan-name-cell">
        <input type="text" class="memscan-value-input memscan-name-input" placeholder="e.g. Lives">
        <button class="ui-btn small ghost memscan-save-btn" type="button" title="Save as a cheat for this ROM">💾</button>
      </td>
    `;
    tr.querySelector('.memscan-addr').addEventListener('click', () => jumpToRamEditor(addr));
    tr.querySelector('.memscan-freeze-cell input').addEventListener('change', e => toggleMemScanFreeze(addr, entry.size, e.target.checked));
    const nameInput = tr.querySelector('.memscan-name-input');
    tr.querySelector('.memscan-save-btn').addEventListener('click', evt => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.classList.add('memscan-name-error');
        setTimeout(() => nameInput.classList.remove('memscan-name-error'), 700);
        nameInput.focus();
        return;
      }
      saveCheatForCurrentRom(name, addr, entry.size);
      const btn = evt.currentTarget;
      const original = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = original; }, 900);
      drawSavedCheats();
    });
    tbody.appendChild(tr);
  });
  memScanBodyEl.appendChild(table);
}

// Cheap per-tick refresh: just repaints the live "Value" column and flags cells that have
// drifted from what they were at the last New/Next scan. Called from refreshDebugTools().
function drawMemScan() {
  if (!emulator.hasROM()) { memScanSummaryEl.textContent = 'Load a ROM first.'; return; }
  if (memScanCandidates) {
    const n = memScanCandidates.size;
    const capped = n > MEMSCAN_MAX_ROWS;
    memScanSummaryEl.innerHTML = `${n} candidate${n === 1 ? '' : 's'}` +
      (capped ? ` <span class="memscan-warn">(showing first ${MEMSCAN_MAX_ROWS} — narrow it down with another scan)</span>` : '');
  }
  memScanBodyEl.querySelectorAll('.memscan-cur').forEach(td => {
    const addr = parseInt(td.dataset.addr, 10);
    const size = parseInt(td.dataset.size, 10);
    const cur = memScanReadValue(addr, size);
    const prevVal = memScanCandidates?.get(addr)?.value;
    td.textContent = cur;
    td.classList.toggle('changed', prevVal !== undefined && cur !== prevVal);
  });
}

memScanNewBtn.addEventListener('click', () => {
  if (!emulator.hasROM()) { memScanSummaryEl.textContent = 'Load a ROM first.'; return; }
  const size = parseInt(memScanSizeEl.value, 10);
  const type = memScanTypeEl.value;
  const targetVal = parseMemScanValue(memScanValueEl.value, size);
  if (type === 'exact' && targetVal === null) {
    memScanSummaryEl.textContent = 'Enter a valid value (decimal or 0x hex) to search for.';
    return;
  }
  const checkedRegions = MEMSCAN_REGIONS.filter(r => memScanRegionsEl.querySelector(`input[data-region="${r.key}"]`).checked);
  if (checkedRegions.length === 0) {
    memScanSummaryEl.textContent = 'Check at least one region to search in.';
    return;
  }
  memScanActiveSize = size;
  memScanCandidates = new Map();
  checkedRegions.forEach(region => {
    const maxAddr = region.base + region.length - size;
    for (let addr = region.base; addr <= maxAddr; addr++) {
      const v = memScanReadValue(addr, size);
      if (type === 'unknown' || v === targetVal) memScanCandidates.set(addr, { value: v, size });
    }
  });
  memScanSizeEl.disabled = true;
  memScanRegionsEl.querySelectorAll('input').forEach(cb => cb.disabled = true);
  memScanNextBtn.disabled = false;
  memScanResetBtn.disabled = false;
  memScanPopulateTypeOptions(MEMSCAN_NEXT_TYPES);
  buildMemScanTable();
  drawMemScan();
});

memScanNextBtn.addEventListener('click', () => {
  if (!memScanCandidates) return;
  const type = memScanTypeEl.value;
  const cmpVal = parseMemScanValue(memScanValueEl.value, memScanActiveSize);
  if (['exact', 'increasedby', 'decreasedby'].includes(type) && cmpVal === null) {
    memScanSummaryEl.textContent = 'Enter a valid value.';
    return;
  }
  const next = new Map();
  memScanCandidates.forEach((entry, addr) => {
    const cur = memScanReadValue(addr, entry.size);
    let keep = false;
    switch (type) {
      case 'exact':       keep = cur === cmpVal; break;
      case 'changed':     keep = cur !== entry.value; break;
      case 'unchanged':   keep = cur === entry.value; break;
      case 'increased':   keep = cur > entry.value; break;
      case 'decreased':   keep = cur < entry.value; break;
      case 'increasedby': keep = cur === (entry.value + cmpVal) % (memScanActiveSize === 1 ? 0x100 : 0x10000); break;
      case 'decreasedby': keep = cur === (((entry.value - cmpVal) % (memScanActiveSize === 1 ? 0x100 : 0x10000)) + (memScanActiveSize === 1 ? 0x100 : 0x10000)) % (memScanActiveSize === 1 ? 0x100 : 0x10000); break;
    }
    if (keep) next.set(addr, { value: cur, size: entry.size });
  });
  memScanCandidates = next;
  buildMemScanTable();
  drawMemScan();
});

memScanResetBtn.addEventListener('click', () => {
  memScanCandidates = null;
  memScanSizeEl.disabled = false;
  memScanRegionsEl.querySelectorAll('input').forEach(cb => cb.disabled = false);
  memScanNextBtn.disabled = true;
  memScanResetBtn.disabled = true;
  memScanPopulateTypeOptions(MEMSCAN_INITIAL_TYPES);
  memScanSummaryEl.textContent = 'No scan yet — pick regions above and hit New Scan.';
  buildMemScanTable();
});

// Any candidate set or freeze from before is meaningless once a (possibly different) ROM is
// (re)loaded - the address space is the same, but what lives there has changed. The Saved
// Cheats list is rebuilt from localStorage for the newly-active ROM's CRC32 instead.
function onRomChangedForMemScan() {
  memScanCandidates = null;
  memScanFrozen.clear();
  memScanSizeEl.disabled = false;
  memScanRegionsEl.querySelectorAll('input').forEach(cb => cb.disabled = false);
  memScanNextBtn.disabled = true;
  memScanResetBtn.disabled = true;
  memScanPopulateTypeOptions(MEMSCAN_INITIAL_TYPES);
  memScanSummaryEl.textContent = 'No scan yet — pick regions above and hit New Scan.';
  buildMemScanTable();
  drawMemScanFrozenList();
  drawSavedCheats();
}

// refreshBankingAndRtcPanels() (app.js) is the shared "a ROM was just (re)loaded" hook - it's
// called from both loadROMBytes() and resetEmulator(), which is exactly when the Memory
// Scanner needs to reset itself and reload the Saved Cheats list for whichever ROM is now active.
const _memScanPrevRefreshBankingAndRtcPanels = window.refreshBankingAndRtcPanels;
window.refreshBankingAndRtcPanels = function () {
  _memScanPrevRefreshBankingAndRtcPanels();
  onRomChangedForMemScan();
};

buildMemScanRegionCheckboxes();
memScanPopulateTypeOptions(MEMSCAN_INITIAL_TYPES);
buildMemScanTable();
drawSavedCheats();

// Keep the trace panel's height matched to its sibling column on resize, while its tab is active
window.addEventListener('resize', () => {
  if (debugToolsContainer.querySelector('.tool-tab.active').dataset.tool === 'trace') syncTraceListHeight();
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

// Autoscroll toggle: off by default, so the list never jumps on its own until the person
// opts in. Even when on, scrolling up still freezes it (see drawTrace below) — the toggle
// only controls whether being at the bottom is enough to keep following new instructions.
let traceAutoscrollEnabled = typeof savedUIConfig.traceAutoscroll === 'boolean' ? savedUIConfig.traceAutoscroll : false;
traceAutoscrollToggle.checked = traceAutoscrollEnabled;

// Shows/hides the "frozen" UI (note + jump button) to match current state, without
// touching the trace list content itself. The note text only applies to the scrolled-up
// case; when autoscroll is simply off (but we're at the bottom), the button alone is enough.
function setTraceFrozenUI(frozen) {
  btnTraceFollow.style.display = frozen ? '' : 'none';
  traceFrozenNote.style.display = (frozen && !isTraceAtBottom()) ? '' : 'none';
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

// Rebuilds the trace list content from the ring buffer and pins the scroll to the bottom.
// Split out from drawTrace() so "Jump to latest" can force a refresh even while autoscroll
// is off (it's a one-off catch-up, not a way to silently turn autoscroll on).
const TRACE_VISIBLE_ROWS = 50; // on-screen cap; export still covers the full ring buffer
function renderTraceEntries() {
  const entries = emulator.instrumentation.getTraceEntries();
  if (entries.length === 0) { traceList.innerHTML = '<div class="trace-empty">No instructions executed yet.</div>'; return; }
  const recent = entries.slice(-TRACE_VISIBLE_ROWS);

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

function drawTrace() {
  syncTraceListHeight();

  // Only live-update while autoscroll is on AND pinned to the bottom; otherwise freeze the
  // DOM so scrolled-up (or deliberately paused) content doesn't get swapped out under the user.
  const hasContent = traceList.childElementCount > 0 && !traceList.querySelector('.trace-empty');
  if (hasContent && (!traceAutoscrollEnabled || !isTraceAtBottom())) {
    setTraceFrozenUI(true);
    return;
  }
  setTraceFrozenUI(false);
  renderTraceEntries();
}

// Manual scroll should immediately reflect frozen/live state.
traceList.addEventListener('scroll', () => {
  setTraceFrozenUI(!traceAutoscrollEnabled || !isTraceAtBottom());
});

// Jump to latest always renders the current entries and scrolls down, regardless of the
// autoscroll setting — a one-off catch-up, not a way to silently turn autoscroll on. If
// autoscroll is still off, the next new instruction will freeze it again, which is correct.
btnTraceFollow.addEventListener('click', () => {
  renderTraceEntries();
  setTraceFrozenUI(false);
});

traceAutoscrollToggle.addEventListener('change', () => {
  traceAutoscrollEnabled = traceAutoscrollToggle.checked;
  saveUIConfig({ traceAutoscroll: traceAutoscrollEnabled });
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

/* ---- 6b. Event log: unified scrollback of hardware + system events, see CoreStats.logEvent() ---- */

// Same freeze-while-scrolled-up behavior as the Trace panel, so a burst of events (e.g. an
// interrupt storm) doesn't yank the view out from under someone reading older entries.
function isEventLogAtBottom() {
  return eventLogList.scrollHeight - eventLogList.scrollTop - eventLogList.clientHeight < 24;
}

// Autoscroll toggle: off by default, same rationale as the Trace panel's. Even when on,
// scrolling up still freezes it — the toggle only controls whether being at the bottom is
// enough to keep following new events.
let eventLogAutoscrollEnabled = typeof savedUIConfig.eventLogAutoscroll === 'boolean' ? savedUIConfig.eventLogAutoscroll : false;
eventLogAutoscrollToggle.checked = eventLogAutoscrollEnabled;

// Shows/hides the "frozen" UI (note + jump button). The note text only applies to the
// scrolled-up case; when autoscroll is simply off (but we're at the bottom), the button
// alone is enough.
function setEventLogFrozenUI(frozen) {
  btnEventLogFollow.style.display = frozen ? '' : 'none';
  eventLogFrozenNote.style.display = (frozen && !isEventLogAtBottom()) ? '' : 'none';
}

function activeEventLogComponents() {
  return new Set(eventLogFilterBoxes.filter(b => b.checked).map(b => b.value));
}

// Formats a millisecond duration compactly: sub-second as "12.34ms", otherwise "1:23.4".
// Used for both the emulated (hardware) clock and the real (wall) clock on each event.
function formatEventTime(ms) {
  if (ms < 1000) return ms.toFixed(2) + 'ms';
  const totalSec = ms / 1000;
  if (totalSec < 60) return totalSec.toFixed(2) + 's';
  const m = Math.floor(totalSec / 60);
  const s = (totalSec - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// Rebuilds the event log content from the buffer and pins the scroll to the bottom. Split
// out from drawEventLog() so "Jump to latest" can force a refresh even while autoscroll is
// off (it's a one-off catch-up, not a way to silently turn autoscroll on).
const EVENT_LOG_VISIBLE_ROWS = 50; // on-screen cap; export still covers the full buffer
function renderEventLogEntries() {
  const shown = activeEventLogComponents();
  const entries = emulator.stats.eventLog.filter(e => shown.has(e.component));
  if (entries.length === 0) {
    eventLogList.innerHTML = '<div class="event-empty">No events logged yet.</div>';
    return;
  }
  const recent = entries.slice(-EVENT_LOG_VISIBLE_ROWS);

  eventLogList.innerHTML = recent.map(e =>
    `<div class="event-line level-${e.level}">` +
      `<span class="event-time" title="Emulated Game Boy hardware time since ROM load (4.194304MHz clock)">${formatEventTime(e.emuMs)}</span>` +
      `<span class="event-time-wall" title="Real time on this machine since ROM load — diverges from hardware time at non-1x speed">(real ${formatEventTime(e.wallMs)})</span>` +
      `<span class="event-frame">f${e.frame}${e.ly !== null ? ' LY:' + e.ly : ''}</span>` +
      `<span class="event-comp event-comp-${e.component}">[${e.component}]</span>` +
      `<span class="event-detail">${e.detail}</span>` +
    `</div>`
  ).join('');
  eventLogList.scrollTop = eventLogList.scrollHeight;
}

function drawEventLog() {
  // Only live-update while autoscroll is on AND pinned to the bottom; otherwise freeze the
  // DOM so scrolled-up (or deliberately paused) content doesn't get swapped out under the user.
  const hasContent = eventLogList.childElementCount > 0 && !eventLogList.querySelector('.event-empty');
  if (hasContent && (!eventLogAutoscrollEnabled || !isEventLogAtBottom())) {
    setEventLogFrozenUI(true);
    return;
  }
  setEventLogFrozenUI(false);
  renderEventLogEntries();
}

eventLogList.addEventListener('scroll', () => {
  setEventLogFrozenUI(!eventLogAutoscrollEnabled || !isEventLogAtBottom());
});

// Jump to latest always renders the current entries and scrolls down, regardless of the
// autoscroll setting. If autoscroll is still off, the next new event will freeze it again,
// which is correct.
btnEventLogFollow.addEventListener('click', () => {
  renderEventLogEntries();
  setEventLogFrozenUI(false);
});

eventLogAutoscrollToggle.addEventListener('change', () => {
  eventLogAutoscrollEnabled = eventLogAutoscrollToggle.checked;
  saveUIConfig({ eventLogAutoscroll: eventLogAutoscrollEnabled });
  drawEventLog();
});

// Changing the level threshold only affects what gets recorded going forward (see
// CoreStats.logEvent) — it doesn't retroactively filter what's already in the ring buffer.
eventLogLevelSelect.addEventListener('change', () => {
  emulator.stats.eventLogLevel = eventLogLevelSelect.value;
});
emulator.stats.eventLogLevel = eventLogLevelSelect.value;

// Component filters are display-only: they don't change what's recorded, just what's shown.
eventLogFilterBoxes.forEach(box => box.addEventListener('change', drawEventLog));

function buildEventLogExportText() {
  const level = emulator.stats.eventLogLevel;
  const shown = activeEventLogComponents();
  const lines = [];
  lines.push(`; JS GB Emulator — event log export`);
  lines.push(`; ROM: ${emulator.romTitle || 'Unknown'}`);
  lines.push(`; Exported: ${new Date().toISOString()}`);
  lines.push(`; Level threshold: ${level} (matches current panel selection)`);
  lines.push(`; Components: ${[...shown].join(', ') || '(none selected)'}`);
  lines.push(`; emuMs = emulated Game Boy hardware time since ROM load (fixed 4.194304MHz clock)`);
  lines.push(`; wallMs = real time on this machine since ROM load (diverges from emuMs at non-1x speed)`);
  lines.push(`; Format: emuMs  wallMs  frame  LY  [component]  detail`);
  lines.push('');

  // Same filters as the on-screen view: component checkboxes, plus the level threshold (in
  // case entries recorded under a more verbose setting are still sitting in the buffer).
  const entries = emulator.stats.eventLog.filter(e =>
    shown.has(e.component) && EVENT_LEVELS[e.level] >= EVENT_LEVELS[level]);
  if (entries.length === 0) { lines.push('(no events match the current filters)'); return lines.join('\n'); }

  for (const e of entries) {
    const ly = e.ly !== null ? String(e.ly).padStart(3) : '  —';
    const emuMs = e.emuMs.toFixed(2).padStart(10);
    const wallMs = e.wallMs.toFixed(2).padStart(10);
    lines.push(`${emuMs}ms  ${wallMs}ms  ${String(e.frame).padStart(7)}  LY:${ly}  [${e.component.padEnd(6)}]  ${e.detail}`);
  }
  return lines.join('\n');
}

btnExportEventLog.addEventListener('click', () => {
  try {
    const text = buildEventLogExportText();
    const blob = new Blob([text], { type: 'text/plain' });
    downloadBlob(blob, `${safeRomName()}.eventlog.txt`);
  } catch (e) {
    alert('Could not export event log: ' + e.message);
  }
});

