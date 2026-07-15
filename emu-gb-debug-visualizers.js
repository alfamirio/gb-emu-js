/* =========================================================================================
   emu-gb-debug-visualizers.js — Visualization Tools sidebar
   -----------------------------------------------------------------------------------------
   Renders every panel under the "Visualization Tools" sidebar tab group:

   - VRAM tile viewer (raw greyscale tile sheet, both CGB banks).
   - Tile map viewer + Tile inspector/editor (decode and paint an 8x8 tile by address).
   - Layer viewer (BG/window/sprites, independently toggleable).
   - OAM / sprite inspector (table + composited view).
   - Palette viewer (BGP/OBP0/OBP1 on DMG, all BG+OBJ palettes on CGB).
   - Per-channel audio oscilloscope.
   - Scanline timeline (frame + zoomed line view).
   - RTC (MBC3 real-time clock) viewer, including its tab-availability check.

   Depends on DOM refs and helpers declared in emu-gb-debug-core.js (debugToolsContainer,
   visualToolsContainer, rtcTabBtn, flashCopied* helpers) and on a couple of functions from
   emu-gb-debug-inspectors.js (e.g. syncTraceListHeight) that are only ever called from
   deferred event callbacks, not at load time.

   Load order (required): must load after emu-gb-debug-core.js — this file checks initial
   RTC-tab availability synchronously at the bottom of its top-level code, which reads
   emu-gb-debug-core.js's rtcTabBtn/visualToolsContainer refs.
   ========================================================================================= */

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

let tileMapSelect = '9800';
document.querySelectorAll('input[name="tmSelect"]').forEach(r => {
  r.addEventListener('change', () => { tileMapSelect = r.value; refreshDebugTools(); });
});

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

