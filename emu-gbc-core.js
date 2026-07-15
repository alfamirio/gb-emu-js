/* =========================================================================================
   emu-gbc-core.js — Game Boy Color (CGB) emulation core
   -----------------------------------------------------------------------------------------
   Adds CGB support on top of the DMG core (emu-gb-core.js). Timer, Joypad and APU are
   identical on both consoles and are reused as-is. CPU is subclassed (CGBCPU) since only
   boot values and STOP's double-speed switch differ. MMU and PPU are separate classes
   (CGBMMU, CGBPPU) since CGB memory layout (banked VRAM/WRAM, color palette RAM, HDMA) and
   rendering diverge too much from DMG to share cleanly.

   Load order: emu-gb-core.js -> emu-gbc-core.js -> emu-gb-app.js -> emu-gb-debug.js

   Simplifications: OAM DMA and HDMA transfers complete instantly rather than stalling the
   CPU cycle-accurately; OPRI (object priority mode) is accepted but CGB-default (OAM-index)
   priority is always used; DMG-compatibility mode approximates the boot ROM's per-game
   tinted palettes with the DMG core's grayscale ramp.
   ========================================================================================= */

/* ============================== 0. CGB-only config additions =========================== */
const EMU_CGB_CORE_CONFIG = {
  VRAM_BANK_SIZE: EMU_CORE_CONFIG.MEMORY.VRAM_SIZE, // 0x2000 per bank, 2 banks
  WRAM_BANK_SIZE: 0x1000,                            // 4KB per bank, 8 banks (bank 0 fixed + 1-7 switchable)
  WRAM_BANK_COUNT: 8,
  PALETTE_RAM_SIZE: 64, // 8 palettes x 4 colors x 2 bytes (BCPD and OCPD each get their own 64 bytes)
  HDMA_BLOCK_BYTES: 0x10, // one H-Blank DMA block

  // CGB boot ROM register state for a CGB-flagged cartridge (distinct from DMG's BOOT config).
  BOOT: {
    A: 0x11, B: 0x00, C: 0x00, D: 0x00, E: 0x08, H: 0x00, L: 0x7C,
    SP: 0xFFFE, PC: 0x0100,
    FLAG_Z: true, FLAG_N: false, FLAG_H: false, FLAG_C: false,
    IO: { P1: 0xCF, IF: 0xE1, LCDC: 0x91, BGP: 0xFC, OBP0: 0xFF, OBP1: 0xFF },
  },
};

/* ============================== 1. CGBMMU ================================================ */

class CGBMMU extends MMU {
  // MBC/cart-RAM/RTC/OAM/HRAM/IO/IE setup is identical to the DMG MMU and is inherited from
  // the base constructor unchanged. CGB replaces flat VRAM/WRAM with banked memory (via the
  // _initVRAMAndWRAM() override below) and adds palette RAM, HDMA, and double-speed state.

  // Called from the base MMU constructor in place of the flat vram/wram allocation.
  _initVRAMAndWRAM() {
    const CGB = EMU_CGB_CORE_CONFIG;

    // Two VRAM banks (0x8000-0x9FFF window), eight 4KB WRAM banks.
    this.vramBanks = [new Uint8Array(CGB.VRAM_BANK_SIZE), new Uint8Array(CGB.VRAM_BANK_SIZE)];
    this.vbk = 0; // 0xFF4F bit0: which VRAM bank is mapped
    this.wramBanks = Array.from({ length: CGB.WRAM_BANK_COUNT }, () => new Uint8Array(CGB.WRAM_BANK_SIZE));
    this.svbk = 1; // 0xFF70 bits0-2: which bank maps to 0xD000-0xDFFF (0 behaves as 1)

    // BG and OBJ palette RAM: 8 palettes x 4 colors x 2 bytes (RGB555) each.
    this.bgPaletteRAM  = new Uint8Array(CGB.PALETTE_RAM_SIZE);
    this.objPaletteRAM = new Uint8Array(CGB.PALETTE_RAM_SIZE);
    this.bcps = 0; // 0xFF68: bit7 = auto-increment, bits0-5 = index into bgPaletteRAM
    this.ocps = 0; // 0xFF6A: same, for objPaletteRAM

    // HDMA (0xFF51-0xFF55)
    this.hdmaSrc = 0;
    this.hdmaDst = 0;
    this.hdmaActive = false;   // H-Blank-mode transfer in progress
    this.hdmaBlocksLeft = 0;

    // KEY1 double-speed state (0xFF4D). Lives on the MMU since both CPU (STOP) and MMU
    // (register read/write) need to see it.
    this.doubleSpeed = false;
    this.speedSwitchArmed = false;
  }

  // Currently-mapped VRAM bank as a flat Uint8Array, mirroring reads to 0x8000-0x9FFF.
  // The base MMU's read8/peek8/write8 use `this.vram` directly, so overriding just this
  // getter is enough to make all of that dispatch logic work unchanged for CGB.
  get vram() { return this.vramBanks[this.vbk & 1]; }

  // WRAM window is two 4KB halves: 0x0000-0x0FFF (of the window) is always bank 0;
  // 0x1000-0x1FFF is whichever bank SVBK selects (0 behaves as 1, never selectable).
  _readWRAM(offset) {
    if (offset < 0x1000) return this.wramBanks[0][offset];
    const bank = (this.svbk & 0x07) || 1;
    return this.wramBanks[bank][offset - 0x1000];
  }
  _writeWRAM(offset, val) {
    if (offset < 0x1000) { this.wramBanks[0][offset] = val; return; }
    const bank = (this.svbk & 0x07) || 1;
    this.wramBanks[bank][offset - 0x1000] = val;
  }

  /* ---- ROM load / cartridge detection (same MBC1/2/3/5 support as the DMG MMU) ---- */
  loadROM(bytes) {
    this.rom = bytes;
    this._detectCartType(bytes);

    // CGB flag (0x143): 0x80 = CGB-enhanced (also runs on DMG), 0xC0 = CGB-exclusive.
    // Anything else never touches BCPS/BCPD, so palette RAM needs DMG-compat translation.
    const cgbFlag = bytes[0x143];
    this.cgbFlag = cgbFlag;
    this.isCGBCart = (cgbFlag === 0x80 || cgbFlag === 0xC0);

    this.vramBanks[0].fill(0); this.vramBanks[1].fill(0); this.vbk = 0;
    for (const bank of this.wramBanks) bank.fill(0);
    this.svbk = 1;
    this.bgPaletteRAM.fill(0); this.objPaletteRAM.fill(0);
    this.bcps = 0; this.ocps = 0;
    this.hdmaSrc = 0; this.hdmaDst = 0; this.hdmaActive = false; this.hdmaBlocksLeft = 0;
    this.doubleSpeed = false; this.speedSwitchArmed = false;

    const bootIO = EMU_CGB_CORE_CONFIG.BOOT.IO;
    this.io.fill(0);
    this.io[0x00] = bootIO.P1;
    this.io[0x0F] = bootIO.IF;
    this.io[0x40] = bootIO.LCDC;
    this.io[0x47] = bootIO.BGP;
    this.io[0x48] = bootIO.OBP0;
    this.io[0x49] = bootIO.OBP1;
    this.io[0x4F] = 0xFE; // VBK reads back with bits 1-7 set
    this.io[0x70] = 0xF8; // SVBK reads back with bits 3-7 set

    // Non-CGB carts never write BCPS/BCPD, so seed palette RAM from the boot registers now.
    if (!this.isCGBCart) {
      this._applyDMGCompatPalette(0x47, bootIO.BGP);
      this._applyDMGCompatPalette(0x48, bootIO.OBP0);
      this._applyDMGCompatPalette(0x49, bootIO.OBP1);
    }
  }

  /* ---- save state ----
     The MBC/cart-RAM/OAM/HRAM/IO/RTC portion is identical to the DMG MMU and comes from
     _serializeCommon()/_deserializeCommon(); only the memory layout below it differs. */
  serialize() {
    return {
      ...this._serializeCommon(),
      vram0: u8ToBase64(this.vramBanks[0]), vram1: u8ToBase64(this.vramBanks[1]), vbk: this.vbk,
      wram: this.wramBanks.map(u8ToBase64), svbk: this.svbk,
      bgPaletteRAM: u8ToBase64(this.bgPaletteRAM), objPaletteRAM: u8ToBase64(this.objPaletteRAM),
      bcps: this.bcps, ocps: this.ocps,
      hdmaSrc: this.hdmaSrc, hdmaDst: this.hdmaDst, hdmaActive: this.hdmaActive, hdmaBlocksLeft: this.hdmaBlocksLeft,
      doubleSpeed: this.doubleSpeed, speedSwitchArmed: this.speedSwitchArmed,
    };
  }
  deserialize(s) {
    this._deserializeCommon(s);
    this.vramBanks[0].set(base64ToU8(s.vram0)); this.vramBanks[1].set(base64ToU8(s.vram1)); this.vbk = s.vbk;
    s.wram.forEach((b64, i) => this.wramBanks[i].set(base64ToU8(b64))); this.svbk = s.svbk;
    this.bgPaletteRAM.set(base64ToU8(s.bgPaletteRAM)); this.objPaletteRAM.set(base64ToU8(s.objPaletteRAM));
    this.bcps = s.bcps; this.ocps = s.ocps;
    this.hdmaSrc = s.hdmaSrc; this.hdmaDst = s.hdmaDst; this.hdmaActive = s.hdmaActive; this.hdmaBlocksLeft = s.hdmaBlocksLeft;
    this.doubleSpeed = s.doubleSpeed; this.speedSwitchArmed = s.speedSwitchArmed;
  }

  /* ---- I/O ----
     read8/peek8/write8, _regionForAddr, _handleBanking (MBC1/2/3/5 - GBC carts use the same
     mapper chips), and the RTC helpers are all inherited unchanged from the base MMU. Only
     the CGB-only registers need handling here; anything else falls through to super. */
  _readIO(addr) {
    const reg = addr & 0xFF;
    switch (reg) {
      case 0x4D: return (this.doubleSpeed ? 0x80 : 0) | 0x7E | (this.speedSwitchArmed ? 0x01 : 0); // KEY1
      case 0x4F: return 0xFE | (this.vbk & 0x01); // VBK
      case 0x55: return this.hdmaActive ? ((this.hdmaBlocksLeft - 1) & 0x7F) : 0xFF; // HDMA5
      case 0x68: return this.bcps; // BCPS/BGPI
      case 0x69: return this.bgPaletteRAM[this.bcps & 0x3F]; // BCPD/BGPD
      case 0x6A: return this.ocps; // OCPS/OBPI
      case 0x6B: return this.objPaletteRAM[this.ocps & 0x3F]; // OCPD/OBPD
      case 0x70: return 0xF8 | ((this.svbk & 0x07) || 1); // SVBK (0 always reads back as 1)
      default: return super._readIO(addr);
    }
  }

  _writeIO(addr, val) {
    const reg = addr & 0xFF;
    switch (reg) {
      // BGP/OBP0/OBP1 only actually drive the screen for a non-CGB cart (DMG-compat mode).
      case 0x47: this.io[reg] = val; if (!this.isCGBCart) this._applyDMGCompatPalette(0x47, val); return;
      case 0x48: this.io[reg] = val; if (!this.isCGBCart) this._applyDMGCompatPalette(0x48, val); return;
      case 0x49: this.io[reg] = val; if (!this.isCGBCart) this._applyDMGCompatPalette(0x49, val); return;
      case 0x4D: this.speedSwitchArmed = !!(val & 0x01); return; // KEY1: only bit0 is writable
      case 0x4F: this.vbk = val & 0x01; return;
      case 0x51: this.hdmaSrc = (this.hdmaSrc & 0x00FF) | (val << 8); return;               // HDMA1 (src hi)
      case 0x52: this.hdmaSrc = (this.hdmaSrc & 0xFF00) | (val & 0xF0); return;              // HDMA2 (src lo)
      case 0x53: this.hdmaDst = (this.hdmaDst & 0x00FF) | ((val & 0x1F) << 8); return;       // HDMA3 (dst hi)
      case 0x54: this.hdmaDst = (this.hdmaDst & 0xFF00) | (val & 0xF0); return;              // HDMA4 (dst lo)
      case 0x55: this._startHDMA(val); return;                                                // HDMA5
      case 0x68: this.bcps = val; return;
      case 0x69: this._writeBGPaletteByte(val); return;
      case 0x6A: this.ocps = val; return;
      case 0x6B: this._writeOBJPaletteByte(val); return;
      case 0x6C: this.io[reg] = val; return; // OPRI - accepted but not acted on
      case 0x70: this.svbk = val & 0x07; return;
      default: super._writeIO(addr, val); return;
    }
  }

  _writeBGPaletteByte(val) {
    this.bgPaletteRAM[this.bcps & 0x3F] = val;
    if (this.bcps & 0x80) this.bcps = 0x80 | ((this.bcps + 1) & 0x3F); // auto-increment
  }
  _writeOBJPaletteByte(val) {
    this.objPaletteRAM[this.ocps & 0x3F] = val;
    if (this.ocps & 0x80) this.ocps = 0x80 | ((this.ocps + 1) & 0x3F);
  }

  // Reads one of the 8 BG or OBJ palettes (4 RGB555 colors each) as an [r,g,b] 0-255 triple.
  getPaletteRGB(isObj, paletteIndex, colorIndex) {
    const ram = isObj ? this.objPaletteRAM : this.bgPaletteRAM;
    const base = paletteIndex * 8 + colorIndex * 2;
    const lo = ram[base], hi = ram[base + 1];
    const word = (hi << 8) | lo;
    const r5 = word & 0x1F, g5 = (word >> 5) & 0x1F, b5 = (word >> 10) & 0x1F;
    // 5-bit -> 8-bit: replicate the top 3 bits into the low bits for an even spread.
    return [(r5 << 3) | (r5 >> 2), (g5 << 3) | (g5 >> 2), (b5 << 3) | (b5 >> 2)];
  }

  // DMG-compatibility mode: a non-CGB cart only writes BGP/OBP0/OBP1, so translate each
  // write into CGB palette RAM through the DMG grayscale ramp. BGP -> BG palette 0,
  // OBP0/OBP1 -> OBJ palettes 0/1.
  _applyDMGCompatPalette(reg, val) {
    const SHADES = EMU_CORE_CONFIG.PALETTE_GBP;
    const isObj = reg !== 0x47;
    const paletteIndex = reg === 0x49 ? 1 : 0;
    const ram = isObj ? this.objPaletteRAM : this.bgPaletteRAM;
    for (let colorNum = 0; colorNum < 4; colorNum++) {
      const [r, g, b] = SHADES[(val >> (colorNum * 2)) & 0x03];
      const word = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
      const base = paletteIndex * 8 + colorNum * 2;
      ram[base] = word & 0xFF;
      ram[base + 1] = (word >> 8) & 0xFF;
    }
  }

  // HDMA5 write: bit7 picks general-purpose (instant) vs H-Blank-mode transfer; bits0-6 are
  // (length / 0x10) - 1, i.e. 1-128 blocks of 16 bytes each.
  _startHDMA(val) {
    const blocks = (val & 0x7F) + 1;
    if (val & 0x80) {
      this.hdmaActive = true; // transferred one block per H-Blank via serviceHDMABlock()
      this.hdmaBlocksLeft = blocks;
    } else {
      if (this.hdmaActive) { this.hdmaActive = false; return; } // GP-mode write cancels an active HBlank transfer
      for (let b = 0; b < blocks; b++) this._transferHDMABlock();
    }
  }

  // Moves one 0x10-byte block from hdmaSrc to hdmaDst (both auto-advance). Destination is
  // always within the currently VBK-selected VRAM bank, same bank the `vram` getter exposes.
  _transferHDMABlock() {
    const CGB = EMU_CGB_CORE_CONFIG;
    for (let i = 0; i < CGB.HDMA_BLOCK_BYTES; i++) {
      this.vram[(this.hdmaDst & 0x1FFF) + i] = this.read8((this.hdmaSrc + i) & 0xFFFF);
    }
    this.hdmaSrc = (this.hdmaSrc + CGB.HDMA_BLOCK_BYTES) & 0xFFFF;
    this.hdmaDst = (this.hdmaDst + CGB.HDMA_BLOCK_BYTES) & 0x1FFF;
  }

  // Called by CGBPPU once per H-Blank while an H-Blank-mode HDMA transfer is pending.
  serviceHDMABlock() {
    if (!this.hdmaActive) return;
    this._transferHDMABlock();
    this.hdmaBlocksLeft--;
    if (this.hdmaBlocksLeft <= 0) this.hdmaActive = false;
  }
}


/* ============================== 2. CGBCPU (subclass of CPU) ============================= */

class CGBCPU extends CPU {
  // Register reset logic is identical to the base CPU; only the boot register values differ.
  reset() {
    super.reset(EMU_CGB_CORE_CONFIG.BOOT);
  }

  // Only STOP's double-speed switch differs from the base CPU; every other opcode is unchanged.
  handleStop() {
    this.PC = (this.PC + 1) & 0xFFFF;
    if (this.mmu.speedSwitchArmed) {
      this.mmu.doubleSpeed = !this.mmu.doubleSpeed;
      this.mmu.speedSwitchArmed = false;
    }
    this.tick(4);
  }

  get doubleSpeed() { return this.mmu.doubleSpeed; }
}

/* ============================== 3. CGBPPU ================================================ */

class CGBPPU extends PPU {
  // Constructor, serialize/deserialize, all mmu.io-backed getters (lcdc/stat/scy/scx/ly/lyc/
  // bgp/obp0/obp1/wy/wx), step(), _setStatMode/_checkLYC/_checkStatInterrupt,
  // bgWindowTileDataConfig(), _tintForLayer/toSigned8/_setPixel, and getSpriteCandidatesForLine()
  // are all inherited unchanged from the base PPU. Only HDMA servicing, tile/sprite pixel
  // decoding (banked VRAM + CGB palettes), and sprite priority genuinely differ.

  // One H-Blank-mode HDMA block transfers per H-Blank, right after the scanline renders.
  _afterPixelTransfer() {
    this.mmu.serviceHDMABlock();
  }

  _renderScanline() {
    const y = this.ly;
    if (y >= EMU_CORE_CONFIG.SCREEN.HEIGHT) return;
    // Per-pixel BG info for sprite priority: bit0 = BG/window color was non-zero,
    // bit1 = the tile's BG-to-OAM priority attribute was set.
    const bgPriority = new Uint8Array(EMU_CORE_CONFIG.SCREEN.WIDTH);

    // LCDC.0 is a master sprite-priority toggle on CGB (not "BG off" like DMG): when clear,
    // sprites draw on top of everything regardless of any priority bit.
    this._renderBackgroundLine(y, bgPriority);
    if (this.lcdc & 0x20) this._renderWindowLine(y, bgPriority);
    if (this.lcdc & 0x02) this._renderSpritesLine(y, bgPriority);
  }

  // Tile map entry + CGB attribute byte at tile-space (mapX, mapY). Tile pixel data lives in
  // whichever VRAM bank the attribute byte's bit3 selects, independent of VBK.
  _getTileInfo(tileMapBase, mapX, mapY) {
    const tileRow = mapY >> 3, tileCol = mapX >> 3;
    const mapOffset = (tileMapBase + tileRow * 32 + tileCol) - 0x8000;
    const tileIndexRaw = this.mmu.vramBanks[0][mapOffset]; // tile map always lives in bank 0
    const attrs = this.mmu.vramBanks[1][mapOffset];        // attributes live in bank 1, same address
    return { tileIndexRaw, attrs };
  }

  // Color index (0-3) plus resolved CGB palette number/bank/priority for a BG or window
  // pixel at tile-space (mapX, mapY).
  getBGWindowPixel(tileMapBase, mapX, mapY) {
    const { tileIndexRaw, attrs } = this._getTileInfo(tileMapBase, mapX, mapY);
    const { tileDataBase, signedIndex } = this.bgWindowTileDataConfig();
    const tileIndex = signedIndex ? this.toSigned8(tileIndexRaw) : tileIndexRaw;
    const bank = (attrs & 0x08) ? 1 : 0;
    const xFlip = !!(attrs & 0x20), yFlip = !!(attrs & 0x40);
    const priority = !!(attrs & 0x80);
    const paletteNum = attrs & 0x07;

    let py = mapY & 7, px = mapX & 7;
    if (yFlip) py = 7 - py;
    if (xFlip) px = 7 - px;
    const tileAddr = tileDataBase + tileIndex * 16;
    const lo = this.mmu.vramBanks[bank][(tileAddr - 0x8000) + py * 2];
    const hi = this.mmu.vramBanks[bank][(tileAddr - 0x8000) + py * 2 + 1];
    const bit = 7 - px;
    const colorIndex = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
    return { colorIndex, paletteNum, priority };
  }

  // DEAD CODE (flagged, not renamed): zero callers anywhere, not just outside this class.
  // Comment below claims these are shims for emu-gb-debug.js's layer viewer, but
  // emu-gb-stats-instrumentation.js (~line 620-625) confirms that responsibility moved to
  // getBGWindowPixel() and these two were never cleaned up. Candidates for removal rather
  // than underscoring — underscoring would imply "kept, but private", which isn't the case.
  // DMG-PPU-compatible shims for emu-gb-debug.js's layer viewer. CGB color depends on which
  // of 8 BG/OBJ palettes a tile/sprite selects, so these approximate using BG palette 0.
  getBackgroundColorIndex(x, y) {
    const tileMapBase = (this.lcdc & 0x08) ? 0x9C00 : 0x9800;
    const bgX = (x + this.scx) & 0xFF, bgY = (y + this.scy) & 0xFF;
    return this.getBGWindowPixel(tileMapBase, bgX, bgY).colorIndex;
  }

  getWindowColorIndex(winX, winY) {
    const tileMapBase = (this.lcdc & 0x40) ? 0x9C00 : 0x9800;
    return this.getBGWindowPixel(tileMapBase, winX, winY).colorIndex;
  }

  // `palette` is ignored (CGB has no such register) - BG palette 0 is used as the reference.
  applyPalette(colorNum, palette) {
    return this.mmu.getPaletteRGB(false, 0, colorNum);
  }

  _renderBackgroundLine(y, bgPriority) {
    const tileMapBase = (this.lcdc & 0x08) ? 0x9C00 : 0x9800;
    for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const bgX = (x + this.scx) & 0xFF, bgY = (y + this.scy) & 0xFF;
      const { colorIndex, paletteNum, priority } = this.getBGWindowPixel(tileMapBase, bgX, bgY);
      bgPriority[x] = (colorIndex !== 0 ? 1 : 0) | (priority ? 2 : 0);
      const [r, g, b] = this.mmu.getPaletteRGB(false, paletteNum, colorIndex);
      this._plotTintedPixel(x, y, r, g, b, 'bg');
    }
  }

  _renderWindowLine(y, bgPriority) {
    if (y < this.wy) return;
    const wx = this.wx - 7;
    if (wx > EMU_CORE_CONFIG.SCREEN.WIDTH - 1) return;
    const tileMapBase = (this.lcdc & 0x40) ? 0x9C00 : 0x9800;
    const winY = this.windowLineCounter;
    let drewAny = false;

    for (let x = Math.max(wx, 0); x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const { colorIndex, paletteNum, priority } = this.getBGWindowPixel(tileMapBase, x - wx, winY);
      bgPriority[x] = (colorIndex !== 0 ? 1 : 0) | (priority ? 2 : 0);
      const [r, g, b] = this.mmu.getPaletteRGB(false, paletteNum, colorIndex);
      this._plotTintedPixel(x, y, r, g, b, 'window');
      drewAny = true;
    }
    if (drewAny) this.windowLineCounter++;
  }

  // CGB default priority: OAM index order, lowest index drawn on top (not DMG's X-coordinate
  // rule). getSpriteCandidatesForLine() itself is inherited from PPU, which looks up this
  // comparator via `this.constructor._compareSpritePriority`.
  static _compareSpritePriority(a, b) { return b.oamIndex - a.oamIndex; }

  getSpriteRowBits(sprite, y, spriteHeight) {
    const yFlip = !!(sprite.attrs & 0x40), xFlip = !!(sprite.attrs & 0x20);
    const bank = (sprite.attrs & 0x08) ? 1 : 0;
    let tileIndex = sprite.tileIndex;
    if (spriteHeight === 16) tileIndex &= 0xFE;

    let rowInSprite = y - sprite.spriteY;
    if (yFlip) rowInSprite = spriteHeight - 1 - rowInSprite;
    let tileOffset = tileIndex * 16;
    if (rowInSprite >= 8) { tileOffset += 16; rowInSprite -= 8; }

    return {
      lo: this.mmu.vramBanks[bank][tileOffset + rowInSprite * 2],
      hi: this.mmu.vramBanks[bank][tileOffset + rowInSprite * 2 + 1],
      xFlip,
    };
  }

  _renderSpritesLine(y, bgPriority) {
    const SPR = EMU_CORE_CONFIG.SPRITES;
    const spriteHeight = (this.lcdc & 0x04) ? SPR.HEIGHT_TALL : SPR.HEIGHT_SMALL;
    const candidates = this.getSpriteCandidatesForLine(y, spriteHeight);

    this.emulator.stats?.recordSprites(y, candidates.length);

    // LCDC.0 master priority: when clear, sprites always draw on top.
    const masterPriority = !!(this.lcdc & 0x01);

    for (const s of candidates) {
      if (s.spriteX <= -8 || s.spriteX >= EMU_CORE_CONFIG.SCREEN.WIDTH) continue;
      const behindBG = !!(s.attrs & 0x80);
      // CGB carts use the full 3-bit OBJ palette index; non-CGB carts only set attribute
      // bit4 (DMG OBP0/OBP1 select), so fall back to that bit for them.
      const paletteNum = this.mmu.isCGBCart ? (s.attrs & 0x07) : ((s.attrs & 0x10) ? 1 : 0);
      const { lo, hi, xFlip } = this.getSpriteRowBits(s, y, spriteHeight);

      for (let px = 0; px < 8; px++) {
        const sx = s.spriteX + px;
        if (sx < 0 || sx >= EMU_CORE_CONFIG.SCREEN.WIDTH) continue;
        const colorNum = CGBPPU.spriteRowColorIndex(lo, hi, xFlip, px);
        if (colorNum === 0) continue;
        if (masterPriority) {
          const bgHasColor = !!(bgPriority[sx] & 1);
          const bgHasPriority = !!(bgPriority[sx] & 2);
          if ((behindBG || bgHasPriority) && bgHasColor) continue;
        }
        const [r, g, b] = this.mmu.getPaletteRGB(true, paletteNum, colorNum);
        this._plotTintedPixel(sx, y, r, g, b, 'sprite');
      }
    }
  }
}


/* ================================== 4. CGBEmulator ======================================= */

class CGBEmulator extends GBEmulator {
  constructor(opts = {}) {
    super(opts); // builds DMG mmu/cpu/ppu first; replaced below
    this.mmu = new CGBMMU(this);
    this.cpu = new CGBCPU(this.mmu);
    this.ppu = new CGBPPU(this);
    // timer/joypad/apu are already correct - they're console-agnostic and already point at `this`.
  }

  // In double-speed mode the CPU consumes T-cycles twice as fast, so the PPU/APU (which run
  // at real-time rate) get half as many cycles. The Timer runs off the full, un-halved clock.
  stepHardware(cycles) {
    const speedDiv = this.cpu.doubleSpeed ? 2 : 1;
    const ppuCycles = cycles / speedDiv;
    this.ppu.step(ppuCycles);
    this.apu.step(ppuCycles);
    this.timer.step(cycles);
    return ppuCycles;
  }
}
