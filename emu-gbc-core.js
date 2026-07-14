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

class CGBMMU {
  constructor(emulator) {
    this.emulator = emulator;

    this.rom = new Uint8Array(0);
    this.mbcType = 0;
    this.hasRumble = false;
    this.currentROMBank = 1;
    this.currentRAMBank = 0;
    this.ramEnabled = false;
    this.bankingMode = 0;

    const MEM = EMU_CORE_CONFIG.MEMORY;
    const CGB = EMU_CGB_CORE_CONFIG;
    this.cartRAM = new Uint8Array(MEM.CART_RAM_SIZE);

    this.rtc = {
      s: 0, m: 0, h: 0, dl: 0, dh: 0,
      latched: { s: 0, m: 0, h: 0, dl: 0, dh: 0 },
      lastLatchWrite: 0xFF,
      lastRealMs: Date.now(),
    };
    this.rtcSelect = -1;
    this.hasTimer = false; // cart types 0x0F/0x10 (MBC3+TIMER)

    // Two VRAM banks (0x8000-0x9FFF window), eight 4KB WRAM banks.
    this.vramBanks = [new Uint8Array(CGB.VRAM_BANK_SIZE), new Uint8Array(CGB.VRAM_BANK_SIZE)];
    this.vbk = 0; // 0xFF4F bit0: which VRAM bank is mapped
    this.wramBanks = Array.from({ length: CGB.WRAM_BANK_COUNT }, () => new Uint8Array(CGB.WRAM_BANK_SIZE));
    this.svbk = 1; // 0xFF70 bits0-2: which bank maps to 0xD000-0xDFFF (0 behaves as 1)

    this.oam  = new Uint8Array(MEM.OAM_SIZE);
    this.hram = new Uint8Array(MEM.HRAM_SIZE);
    this.io   = new Uint8Array(MEM.IO_SIZE);
    this.ie   = 0;

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
  get vram() { return this.vramBanks[this.vbk & 1]; }

  regionForAddr(addr) {
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROM0_END) return REGION_ROM0;
    if (addr < MEM.ROMX_END) return REGION_ROMX;
    if (addr < MEM.VRAM_END) return REGION_VRAM;
    if (addr < MEM.ERAM_END) return REGION_ERAM;
    if (addr < MEM.WRAM_END) return REGION_WRAM;
    if (addr < MEM.ECHO_END) return REGION_WRAM;
    if (addr < MEM.OAM_END) return REGION_OAM;
    if (addr < MEM.UNUSABLE_END) return REGION_UNUSED;
    if (addr < MEM.IO_END) return REGION_IO;
    if (addr < MEM.HRAM_END) return REGION_HRAM;
    return REGION_IE;
  }

  /* ---- ROM load / cartridge detection (same MBC1/2/3/5 support as the DMG MMU) ---- */
  loadROM(bytes) {
    this.rom = bytes;
    const cartType = bytes[0x147];
    this.cartTypeByte = cartType;

    // CGB flag (0x143): 0x80 = CGB-enhanced (also runs on DMG), 0xC0 = CGB-exclusive.
    // Anything else never touches BCPS/BCPD, so palette RAM needs DMG-compat translation.
    const cgbFlag = bytes[0x143];
    this.cgbFlag = cgbFlag;
    this.isCGBCart = (cgbFlag === 0x80 || cgbFlag === 0xC0);

    if (cartType === 0x00) { this.mbcType = 0; this.cartTypeSupported = true; }
    else if (cartType >= 0x01 && cartType <= 0x03) { this.mbcType = 1; this.cartTypeSupported = true; }
    else if (cartType === 0x05 || cartType === 0x06) { this.mbcType = 2; this.cartTypeSupported = true; }
    else if (cartType >= 0x0F && cartType <= 0x13) { this.mbcType = 3; this.cartTypeSupported = true; }
    else if (cartType >= 0x19 && cartType <= 0x1E) { this.mbcType = 5; this.cartTypeSupported = true; }
    else { this.mbcType = 1; this.cartTypeSupported = false; }
    this.hasRumble = (cartType >= 0x1C && cartType <= 0x1E);
    this.hasTimer = (cartType === 0x0F || cartType === 0x10);

    this.currentROMBank = 1;
    this.currentRAMBank = 0;
    this.ramEnabled = false;
    this.bankingMode = 0;

    this.rtc = {
      s: 0, m: 0, h: 0, dl: 0, dh: 0,
      latched: { s: 0, m: 0, h: 0, dl: 0, dh: 0 },
      lastLatchWrite: 0xFF,
      lastRealMs: Date.now(),
    };
    this.rtcSelect = -1;

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
      this.applyDMGCompatPalette(0x47, bootIO.BGP);
      this.applyDMGCompatPalette(0x48, bootIO.OBP0);
      this.applyDMGCompatPalette(0x49, bootIO.OBP1);
    }
  }

  /* ---- save state ---- */
  serialize() {
    return {
      mbcType: this.mbcType, currentROMBank: this.currentROMBank, currentRAMBank: this.currentRAMBank,
      ramEnabled: this.ramEnabled, bankingMode: this.bankingMode,
      cartRAM: u8ToBase64(this.cartRAM),
      vram0: u8ToBase64(this.vramBanks[0]), vram1: u8ToBase64(this.vramBanks[1]), vbk: this.vbk,
      wram: this.wramBanks.map(u8ToBase64), svbk: this.svbk,
      oam: u8ToBase64(this.oam), hram: u8ToBase64(this.hram), io: u8ToBase64(this.io), ie: this.ie,
      bgPaletteRAM: u8ToBase64(this.bgPaletteRAM), objPaletteRAM: u8ToBase64(this.objPaletteRAM),
      bcps: this.bcps, ocps: this.ocps,
      hdmaSrc: this.hdmaSrc, hdmaDst: this.hdmaDst, hdmaActive: this.hdmaActive, hdmaBlocksLeft: this.hdmaBlocksLeft,
      doubleSpeed: this.doubleSpeed, speedSwitchArmed: this.speedSwitchArmed,
      rtc: this.mbcType === 3 ? {
        s: this.rtc.s, m: this.rtc.m, h: this.rtc.h, dl: this.rtc.dl, dh: this.rtc.dh,
        latched: { ...this.rtc.latched }, lastLatchWrite: this.rtc.lastLatchWrite, lastRealMs: this.rtc.lastRealMs,
      } : undefined,
      rtcSelect: this.rtcSelect,
    };
  }
  deserialize(s) {
    this.mbcType = s.mbcType; this.currentROMBank = s.currentROMBank; this.currentRAMBank = s.currentRAMBank;
    this.ramEnabled = s.ramEnabled; this.bankingMode = s.bankingMode;
    this.cartRAM.set(base64ToU8(s.cartRAM));
    this.vramBanks[0].set(base64ToU8(s.vram0)); this.vramBanks[1].set(base64ToU8(s.vram1)); this.vbk = s.vbk;
    s.wram.forEach((b64, i) => this.wramBanks[i].set(base64ToU8(b64))); this.svbk = s.svbk;
    this.oam.set(base64ToU8(s.oam)); this.hram.set(base64ToU8(s.hram)); this.io.set(base64ToU8(s.io));
    this.ie = s.ie;
    this.bgPaletteRAM.set(base64ToU8(s.bgPaletteRAM)); this.objPaletteRAM.set(base64ToU8(s.objPaletteRAM));
    this.bcps = s.bcps; this.ocps = s.ocps;
    this.hdmaSrc = s.hdmaSrc; this.hdmaDst = s.hdmaDst; this.hdmaActive = s.hdmaActive; this.hdmaBlocksLeft = s.hdmaBlocksLeft;
    this.doubleSpeed = s.doubleSpeed; this.speedSwitchArmed = s.speedSwitchArmed;
    if (s.rtc) {
      this.rtc.s = s.rtc.s; this.rtc.m = s.rtc.m; this.rtc.h = s.rtc.h; this.rtc.dl = s.rtc.dl; this.rtc.dh = s.rtc.dh;
      this.rtc.latched = { ...s.rtc.latched };
      this.rtc.lastLatchWrite = s.rtc.lastLatchWrite;
      this.rtc.lastRealMs = Date.now();
    }
    this.rtcSelect = (s.rtcSelect === undefined) ? -1 : s.rtcSelect;
  }

  read8(addr) {
    addr &= 0xFFFF;
    if (this.emulator.stats?.trackMemMap) this.emulator.stats.recordMemAccess(addr, this.regionForAddr(addr), 'read');
    return this.peek8(addr);
  }

  peek8(addr) {
    addr &= 0xFFFF;
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROM0_END) return this.rom[addr] ?? 0xFF;
    if (addr < MEM.ROMX_END) return this.rom[this.currentROMBank * MEM.ROM_BANK_SIZE + (addr - MEM.ROM0_END)] ?? 0xFF;
    if (addr < MEM.VRAM_END) return this.vram[addr - MEM.ROMX_END];
    if (addr < MEM.ERAM_END) {
      if (this.mbcType === 3 && this.rtcSelect !== -1) return this.readRTCRegister();
      if (this.mbcType === 2) {
        if (!this.ramEnabled) return 0xFF;
        return 0xF0 | (this.cartRAM[addr & 0x1FF] & 0x0F);
      }
      return this.ramEnabled ? this.cartRAM[this.currentRAMBank * MEM.RAM_BANK_SIZE + (addr - MEM.VRAM_END)] : 0xFF;
    }
    if (addr < MEM.WRAM_END) return this.readWRAM(addr - MEM.ERAM_END);       // 0xC000-0xDFFF
    if (addr < MEM.ECHO_END) return this.readWRAM(addr - MEM.WRAM_END);       // echo of WRAM
    if (addr < MEM.OAM_END) return this.oam[addr - MEM.ECHO_END];
    if (addr < MEM.UNUSABLE_END) return 0xFF;
    if (addr < MEM.IO_END) return this.readIO(addr);
    if (addr < MEM.HRAM_END) return this.hram[addr - MEM.IO_END];
    return this.ie;
  }

  // WRAM window is two 4KB halves: 0x0000-0x0FFF (of the window) is always bank 0;
  // 0x1000-0x1FFF is whichever bank SVBK selects (0 behaves as 1, never selectable).
  readWRAM(offset) {
    if (offset < 0x1000) return this.wramBanks[0][offset];
    const bank = (this.svbk & 0x07) || 1;
    return this.wramBanks[bank][offset - 0x1000];
  }
  writeWRAM(offset, val) {
    if (offset < 0x1000) { this.wramBanks[0][offset] = val; return; }
    const bank = (this.svbk & 0x07) || 1;
    this.wramBanks[bank][offset - 0x1000] = val;
  }

  write8(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    if (this.emulator.stats?.trackMemMap) this.emulator.stats.recordMemAccess(addr, this.regionForAddr(addr), 'write');
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROMX_END) { this.handleBanking(addr, val); return; }
    if (addr < MEM.VRAM_END) { this.vram[addr - MEM.ROMX_END] = val; return; }
    if (addr < MEM.ERAM_END) {
      if (!this.ramEnabled) return;
      if (this.mbcType === 3 && this.rtcSelect !== -1) { this.writeRTCRegister(val); return; }
      if (this.mbcType === 2) { this.cartRAM[addr & 0x1FF] = val & 0x0F; return; }
      this.cartRAM[this.currentRAMBank * MEM.RAM_BANK_SIZE + (addr - MEM.VRAM_END)] = val;
      return;
    }
    if (addr < MEM.WRAM_END) { this.writeWRAM(addr - MEM.ERAM_END, val); return; }
    if (addr < MEM.ECHO_END) { this.writeWRAM(addr - MEM.WRAM_END, val); return; }
    if (addr < MEM.OAM_END) { this.oam[addr - MEM.ECHO_END] = val; return; }
    if (addr < MEM.UNUSABLE_END) return;
    if (addr < MEM.IO_END) { this.writeIO(addr, val); return; }
    if (addr < MEM.HRAM_END) { this.hram[addr - MEM.IO_END] = val; return; }
    this.ie = val;
  }

  /* ---- MBC banking (same logic as the DMG MMU - GBC carts use the same mapper chips) ---- */
  handleBanking(addr, val) {
    if (this.mbcType === 0) return;
    const prevROM = this.currentROMBank, prevRAM = this.currentRAMBank,
          prevEnabled = this.ramEnabled, prevMode = this.bankingMode, prevRtcSelect = this.rtcSelect;

    if (this.mbcType === 1) {
      if (addr < 0x2000) { this.ramEnabled = (val & 0x0F) === 0x0A; }
      else if (addr < 0x4000) {
        let bank = val & 0x1F; if (bank === 0) bank = 1;
        this.currentROMBank = (this.currentROMBank & 0x60) | bank;
      } else if (addr < 0x6000) {
        if (this.bankingMode === 0) this.currentROMBank = (this.currentROMBank & 0x1F) | ((val & 0x03) << 5);
        else this.currentRAMBank = val & 0x03;
      } else { this.bankingMode = val & 0x01; }
    } else if (this.mbcType === 2) {
      if (addr < 0x4000) {
        if ((addr & 0x0100) === 0) { this.ramEnabled = (val & 0x0F) === 0x0A; }
        else { let bank = val & 0x0F; if (bank === 0) bank = 1; this.currentROMBank = bank; }
      }
    } else if (this.mbcType === 3) {
      if (addr < 0x2000) { this.ramEnabled = (val & 0x0F) === 0x0A; }
      else if (addr < 0x4000) { let bank = val & 0x7F; if (bank === 0) bank = 1; this.currentROMBank = bank; }
      else if (addr < 0x6000) {
        if (val <= 0x03) { this.currentRAMBank = val; this.rtcSelect = -1; }
        else if (val >= 0x08 && val <= 0x0C) { this.rtcSelect = val; }
      } else {
        if (this.rtc.lastLatchWrite === 0x00 && val === 0x01) {
          this.tickRTC();
          this.rtc.latched.s = this.rtc.s; this.rtc.latched.m = this.rtc.m; this.rtc.latched.h = this.rtc.h;
          this.rtc.latched.dl = this.rtc.dl; this.rtc.latched.dh = this.rtc.dh;
        }
        this.rtc.lastLatchWrite = val;
      }
    } else if (this.mbcType === 5) {
      if (addr < 0x2000) { this.ramEnabled = (val & 0x0F) === 0x0A; }
      else if (addr < 0x3000) { this.currentROMBank = (this.currentROMBank & 0x100) | val; }
      else if (addr < 0x4000) { this.currentROMBank = (this.currentROMBank & 0xFF) | ((val & 0x01) << 8); }
      else if (addr < 0x6000) { this.currentRAMBank = val & (this.hasRumble ? 0x07 : 0x0F); }
    }

    if (this.currentROMBank !== prevROM) {
      this.emulator.stats?.recordBankSwitch('rom', addr, val, this.currentROMBank, this.currentRAMBank, this.emulator.ppu.ly);
    } else if (this.currentRAMBank !== prevRAM) {
      this.emulator.stats?.recordBankSwitch('ram', addr, val, this.currentROMBank, this.currentRAMBank, this.emulator.ppu.ly);
    } else if (this.rtcSelect !== prevRtcSelect) {
      this.emulator.stats?.recordBankSwitch('rtc', addr, val, this.currentROMBank, this.currentRAMBank, this.emulator.ppu.ly);
    } else if (this.ramEnabled !== prevEnabled) {
      this.emulator.stats?.recordBankSwitch('enable', addr, val, this.currentROMBank, this.currentRAMBank, this.emulator.ppu.ly);
    } else if (this.bankingMode !== prevMode) {
      this.emulator.stats?.recordBankSwitch('mode', addr, val, this.currentROMBank, this.currentRAMBank, this.emulator.ppu.ly);
    }
  }

  tickRTC() {
    const rtc = this.rtc;
    const halted = (rtc.dh & 0x40) !== 0;
    const now = Date.now();
    if (halted) { rtc.lastRealMs = now; return; }
    let elapsedSec = Math.floor((now - rtc.lastRealMs) / 1000);
    if (elapsedSec <= 0) return;
    rtc.lastRealMs += elapsedSec * 1000;
    rtc.s += elapsedSec;
    if (rtc.s >= 60) { rtc.m += Math.floor(rtc.s / 60); rtc.s %= 60; }
    if (rtc.m >= 60) { rtc.h += Math.floor(rtc.m / 60); rtc.m %= 60; }
    if (rtc.h >= 24) {
      let days = ((rtc.dh & 0x01) << 8) | rtc.dl;
      days += Math.floor(rtc.h / 24);
      rtc.h %= 24;
      if (days > 0x1FF) { rtc.dh |= 0x80; days &= 0x1FF; }
      rtc.dl = days & 0xFF;
      rtc.dh = (rtc.dh & 0xFE) | ((days >> 8) & 0x01);
    }
  }
  readRTCRegister() {
    const l = this.rtc.latched;
    switch (this.rtcSelect) {
      case 0x08: return l.s; case 0x09: return l.m; case 0x0A: return l.h;
      case 0x0B: return l.dl; case 0x0C: return l.dh; default: return 0xFF;
    }
  }
  writeRTCRegister(val) {
    this.tickRTC();
    switch (this.rtcSelect) {
      case 0x08: this.rtc.s = val % 60; break; case 0x09: this.rtc.m = val % 60; break;
      case 0x0A: this.rtc.h = val % 24; break; case 0x0B: this.rtc.dl = val & 0xFF; break;
      case 0x0C: this.rtc.dh = val & 0xC1; break;
    }
  }

  /* ---- I/O ---- */
  readIO(addr) {
    const reg = addr & 0xFF;
    if (reg >= 0x10 && reg <= 0x3F) return this.emulator.apu.read(0xFF00 | reg);
    switch (reg) {
      case 0x00: return this.emulator.joypad.read();
      case 0x04: return this.emulator.timer.div;
      case 0x05: return this.emulator.timer.tima;
      case 0x06: return this.emulator.timer.tma;
      case 0x07: return this.emulator.timer.tac;
      case 0x4D: return (this.doubleSpeed ? 0x80 : 0) | 0x7E | (this.speedSwitchArmed ? 0x01 : 0); // KEY1
      case 0x4F: return 0xFE | (this.vbk & 0x01); // VBK
      case 0x55: return this.hdmaActive ? ((this.hdmaBlocksLeft - 1) & 0x7F) : 0xFF; // HDMA5
      case 0x68: return this.bcps; // BCPS/BGPI
      case 0x69: return this.bgPaletteRAM[this.bcps & 0x3F]; // BCPD/BGPD
      case 0x6A: return this.ocps; // OCPS/OBPI
      case 0x6B: return this.objPaletteRAM[this.ocps & 0x3F]; // OCPD/OBPD
      case 0x70: return 0xF8 | ((this.svbk & 0x07) || 1); // SVBK (0 always reads back as 1)
      default: return this.io[reg];
    }
  }

  writeIO(addr, val) {
    const reg = addr & 0xFF;
    if (reg >= 0x10 && reg <= 0x3F) { this.emulator.apu.write(0xFF00 | reg, val); return; }
    switch (reg) {
      case 0x00: this.emulator.joypad.write(val); return;
      case 0x04: this.emulator.timer.div = 0; return;
      case 0x05: this.emulator.timer.tima = val; return;
      case 0x06: this.emulator.timer.tma = val; return;
      case 0x07: this.emulator.timer.tac = val & 0x07; return;
      case 0x41: this.io[reg] = (this.io[reg] & 0x07) | (val & 0xF8); return;
      case 0x44: this.io[reg] = 0; return;
      case 0x46: this.doDMA(val); return;
      // BGP/OBP0/OBP1 only actually drive the screen for a non-CGB cart (DMG-compat mode).
      case 0x47: this.io[reg] = val; if (!this.isCGBCart) this.applyDMGCompatPalette(0x47, val); return;
      case 0x48: this.io[reg] = val; if (!this.isCGBCart) this.applyDMGCompatPalette(0x48, val); return;
      case 0x49: this.io[reg] = val; if (!this.isCGBCart) this.applyDMGCompatPalette(0x49, val); return;
      case 0x4D: this.speedSwitchArmed = !!(val & 0x01); return; // KEY1: only bit0 is writable
      case 0x4F: this.vbk = val & 0x01; return;
      case 0x51: this.hdmaSrc = (this.hdmaSrc & 0x00FF) | (val << 8); return;               // HDMA1 (src hi)
      case 0x52: this.hdmaSrc = (this.hdmaSrc & 0xFF00) | (val & 0xF0); return;              // HDMA2 (src lo)
      case 0x53: this.hdmaDst = (this.hdmaDst & 0x00FF) | ((val & 0x1F) << 8); return;       // HDMA3 (dst hi)
      case 0x54: this.hdmaDst = (this.hdmaDst & 0xFF00) | (val & 0xF0); return;              // HDMA4 (dst lo)
      case 0x55: this.startHDMA(val); return;                                                // HDMA5
      case 0x68: this.bcps = val; return;
      case 0x69: this.writeBGPaletteByte(val); return;
      case 0x6A: this.ocps = val; return;
      case 0x6B: this.writeOBJPaletteByte(val); return;
      case 0x6C: this.io[reg] = val; return; // OPRI - accepted but not acted on
      case 0x70: this.svbk = val & 0x07; return;
      default: this.io[reg] = val; return;
    }
  }

  writeBGPaletteByte(val) {
    this.bgPaletteRAM[this.bcps & 0x3F] = val;
    if (this.bcps & 0x80) this.bcps = 0x80 | ((this.bcps + 1) & 0x3F); // auto-increment
  }
  writeOBJPaletteByte(val) {
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
  applyDMGCompatPalette(reg, val) {
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

  doDMA(val) {
    const src = val << 8;
    for (let i = 0; i < EMU_CORE_CONFIG.OAM_DMA_BYTES; i++) this.oam[i] = this.read8(src + i);
    this.emulator.stats?.recordDMA(this.emulator.ppu.ly);
  }

  // HDMA5 write: bit7 picks general-purpose (instant) vs H-Blank-mode transfer; bits0-6 are
  // (length / 0x10) - 1, i.e. 1-128 blocks of 16 bytes each.
  startHDMA(val) {
    const blocks = (val & 0x7F) + 1;
    if (val & 0x80) {
      this.hdmaActive = true; // transferred one block per H-Blank via serviceHDMABlock()
      this.hdmaBlocksLeft = blocks;
    } else {
      if (this.hdmaActive) { this.hdmaActive = false; return; } // GP-mode write cancels an active HBlank transfer
      for (let b = 0; b < blocks; b++) this.transferHDMABlock();
    }
  }

  // Moves one 0x10-byte block from hdmaSrc to hdmaDst (both auto-advance).
  transferHDMABlock() {
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
    this.transferHDMABlock();
    this.hdmaBlocksLeft--;
    if (this.hdmaBlocksLeft <= 0) this.hdmaActive = false;
  }
}

/* ============================== 2. CGBCPU (subclass of CPU) ============================= */

class CGBCPU extends CPU {
  reset() {
    const boot = EMU_CGB_CORE_CONFIG.BOOT;
    this.A = boot.A; this.B = boot.B; this.C = boot.C; this.D = boot.D; this.E = boot.E;
    this.H = boot.H; this.L = boot.L;
    this.SP = boot.SP;
    this.PC = boot.PC;
    this.flagZ = boot.FLAG_Z; this.flagN = boot.FLAG_N; this.flagH = boot.FLAG_H; this.flagC = boot.FLAG_C;
    this.IME = false;
    this.eiDelay = 0;
    this.halted = false;
    this.cycles = 0;
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

class CGBPPU {
  constructor(emulator) {
    this.emulator = emulator;
    this.mmu = emulator.mmu;
    this.modeClock = 0;
    this.mode = 2;
    this.windowLineCounter = 0;
    this.framebuffer = new Uint8ClampedArray(EMU_CORE_CONFIG.SCREEN.WIDTH * EMU_CORE_CONFIG.SCREEN.HEIGHT * 4);

    this._spriteCandidates = [];
    this._spriteSlotPool = Array.from({ length: EMU_CORE_CONFIG.SPRITES.MAX_PER_LINE },
      () => ({ spriteY: 0, spriteX: 0, tileIndex: 0, attrs: 0, oamIndex: 0 }));
  }

  serialize() {
    return {
      modeClock: this.modeClock, mode: this.mode, windowLineCounter: this.windowLineCounter,
      framebuffer: u8ToBase64(this.framebuffer),
    };
  }
  deserialize(s) {
    this.modeClock = s.modeClock; this.mode = s.mode; this.windowLineCounter = s.windowLineCounter;
    this.framebuffer.set(base64ToU8(s.framebuffer));
  }

  get lcdc() { return this.mmu.io[0x40]; }
  get stat() { return this.mmu.io[0x41]; } set stat(v) { this.mmu.io[0x41] = v; }
  get scy()  { return this.mmu.io[0x42]; }
  get scx()  { return this.mmu.io[0x43]; }
  get ly()   { return this.mmu.io[0x44]; } set ly(v)   { this.mmu.io[0x44] = v & 0xFF; }
  get lyc()  { return this.mmu.io[0x45]; }
  get bgp()  { return this.mmu.io[0x47]; }
  get obp0() { return this.mmu.io[0x48]; }
  get obp1() { return this.mmu.io[0x49]; }
  get wy()   { return this.mmu.io[0x4A]; }
  get wx()   { return this.mmu.io[0x4B]; }

  step(cycles) {
    if (!(this.lcdc & 0x80)) { this.modeClock = 0; this.ly = 0; this.mode = 0; this.setStatMode(0); return; }

    const MODE = EMU_CORE_CONFIG.PPU_MODE_CYCLES, FRAME = EMU_CORE_CONFIG.FRAME;
    this.modeClock += cycles;
    switch (this.mode) {
      case 2: // OAM search
        if (this.modeClock >= MODE.OAM_SEARCH) { this.modeClock -= MODE.OAM_SEARCH; this.mode = 3; }
        break;

      case 3: // pixel transfer
        if (this.modeClock >= MODE.PIXEL_TRANSFER) {
          this.modeClock -= MODE.PIXEL_TRANSFER;
          this.mode = 0; this.setStatMode(0);
          this.renderScanline();
          this.checkStatInterrupt(0x08);
          this.mmu.serviceHDMABlock(); // one HDMA block per H-Blank
        }
        break;

      case 0: // H-Blank
        if (this.modeClock >= MODE.HBLANK) {
          this.modeClock -= MODE.HBLANK;
          this.ly++;
          this.checkLYC();
          if (this.ly === FRAME.VISIBLE_LINES) {
            this.mode = 1; this.setStatMode(1);
            this.emulator.requestInterrupt(0);
            this.checkStatInterrupt(0x10);
            this.emulator.frameReady = true;
          } else {
            this.mode = 2; this.setStatMode(2);
            this.checkStatInterrupt(0x20);
          }
        }
        break;

      case 1: // V-Blank
        if (this.modeClock >= FRAME.CYCLES_PER_LINE) {
          this.modeClock -= FRAME.CYCLES_PER_LINE;
          this.ly++;
          if (this.ly > FRAME.TOTAL_LINES - 1) {
            this.ly = 0; this.windowLineCounter = 0;
            this.mode = 2; this.setStatMode(2);
            this.checkStatInterrupt(0x20);
          }
          this.checkLYC();
        }
        break;
    }
  }

  setStatMode(mode) { this.stat = (this.stat & 0xFC) | mode; }
  checkLYC() {
    if (this.ly === this.lyc) { this.stat |= 0x04; if (this.stat & 0x40) this.emulator.requestInterrupt(1); }
    else this.stat &= ~0x04;
  }
  checkStatInterrupt(bit) { if (this.stat & bit) this.emulator.requestInterrupt(1); }

  renderScanline() {
    const y = this.ly;
    if (y >= EMU_CORE_CONFIG.SCREEN.HEIGHT) return;
    // Per-pixel BG info for sprite priority: bit0 = BG/window color was non-zero,
    // bit1 = the tile's BG-to-OAM priority attribute was set.
    const bgPriority = new Uint8Array(EMU_CORE_CONFIG.SCREEN.WIDTH);

    // LCDC.0 is a master sprite-priority toggle on CGB (not "BG off" like DMG): when clear,
    // sprites draw on top of everything regardless of any priority bit.
    this.renderBackgroundLine(y, bgPriority);
    if (this.lcdc & 0x20) this.renderWindowLine(y, bgPriority);
    if (this.lcdc & 0x02) this.renderSpritesLine(y, bgPriority);
  }

  // Tile map entry + CGB attribute byte at tile-space (mapX, mapY). Tile pixel data lives in
  // whichever VRAM bank the attribute byte's bit3 selects, independent of VBK.
  getTileInfo(tileMapBase, mapX, mapY) {
    const tileRow = mapY >> 3, tileCol = mapX >> 3;
    const mapOffset = (tileMapBase + tileRow * 32 + tileCol) - 0x8000;
    const tileIndexRaw = this.mmu.vramBanks[0][mapOffset]; // tile map always lives in bank 0
    const attrs = this.mmu.vramBanks[1][mapOffset];        // attributes live in bank 1, same address
    return { tileIndexRaw, attrs };
  }

  bgWindowTileDataConfig() {
    const signedIndex = !(this.lcdc & 0x10);
    if (this._tdConfig && this._tdConfig.signedIndex === signedIndex) return this._tdConfig;
    this._tdConfig = { tileDataBase: signedIndex ? 0x9000 : 0x8000, signedIndex };
    return this._tdConfig;
  }

  // Color index (0-3) plus resolved CGB palette number/bank/priority for a BG or window
  // pixel at tile-space (mapX, mapY).
  getBGWindowPixel(tileMapBase, mapX, mapY) {
    const { tileIndexRaw, attrs } = this.getTileInfo(tileMapBase, mapX, mapY);
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

  renderBackgroundLine(y, bgPriority) {
    const tileMapBase = (this.lcdc & 0x08) ? 0x9C00 : 0x9800;
    const tint = this.emulator.layerTint;
    for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const bgX = (x + this.scx) & 0xFF, bgY = (y + this.scy) & 0xFF;
      const { colorIndex, paletteNum, priority } = this.getBGWindowPixel(tileMapBase, bgX, bgY);
      bgPriority[x] = (colorIndex !== 0 ? 1 : 0) | (priority ? 2 : 0);
      const [r, g, b] = this.mmu.getPaletteRGB(false, paletteNum, colorIndex);
      if (tint) {
        const [tr, tg, tb] = this.tintForLayer(r, g, b, 'bg');
        this.setPixel(x, y, tr, tg, tb);
      } else {
        this.setPixel(x, y, r, g, b);
      }
    }
  }

  renderWindowLine(y, bgPriority) {
    if (y < this.wy) return;
    const wx = this.wx - 7;
    if (wx > EMU_CORE_CONFIG.SCREEN.WIDTH - 1) return;
    const tileMapBase = (this.lcdc & 0x40) ? 0x9C00 : 0x9800;
    const winY = this.windowLineCounter;
    let drewAny = false;
    const tint = this.emulator.layerTint;

    for (let x = Math.max(wx, 0); x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const { colorIndex, paletteNum, priority } = this.getBGWindowPixel(tileMapBase, x - wx, winY);
      bgPriority[x] = (colorIndex !== 0 ? 1 : 0) | (priority ? 2 : 0);
      const [r, g, b] = this.mmu.getPaletteRGB(false, paletteNum, colorIndex);
      if (tint) {
        const [tr, tg, tb] = this.tintForLayer(r, g, b, 'window');
        this.setPixel(x, y, tr, tg, tb);
      } else {
        this.setPixel(x, y, r, g, b);
      }
      drewAny = true;
    }
    if (drewAny) this.windowLineCounter++;
  }

  getSpriteCandidatesForLine(y, spriteHeight) {
    const SPR = EMU_CORE_CONFIG.SPRITES;
    const candidates = this._spriteCandidates;
    const pool = this._spriteSlotPool;
    candidates.length = 0;
    // CGB default priority: OAM index order, lowest index drawn on top (not DMG's X-coordinate rule).
    for (let i = 0; i < SPR.MAX_TOTAL && candidates.length < SPR.MAX_PER_LINE; i++) {
      const base = i * 4;
      const spriteY = this.mmu.oam[base] - 16;
      if (y >= spriteY && y < spriteY + spriteHeight) {
        const slot = pool[candidates.length];
        slot.spriteY = spriteY;
        slot.spriteX = this.mmu.oam[base + 1] - 8;
        slot.tileIndex = this.mmu.oam[base + 2];
        slot.attrs = this.mmu.oam[base + 3];
        slot.oamIndex = i;
        candidates.push(slot);
      }
    }
    // Draw lowest-priority (highest OAM index) first so higher-priority sprites win overlaps.
    candidates.sort((a, b) => b.oamIndex - a.oamIndex);
    return candidates;
  }

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

  static spriteRowColorIndex(lo, hi, xFlip, px) {
    const bit = xFlip ? px : 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  renderSpritesLine(y, bgPriority) {
    const SPR = EMU_CORE_CONFIG.SPRITES;
    const spriteHeight = (this.lcdc & 0x04) ? SPR.HEIGHT_TALL : SPR.HEIGHT_SMALL;
    const candidates = this.getSpriteCandidatesForLine(y, spriteHeight);

    this.emulator.stats?.recordSprites(y, candidates.length);

    // LCDC.0 master priority: when clear, sprites always draw on top.
    const masterPriority = !!(this.lcdc & 0x01);
    const tint = this.emulator.layerTint;

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
        if (tint) {
          const [tr, tg, tb] = this.tintForLayer(r, g, b, 'sprite');
          this.setPixel(sx, y, tr, tg, tb);
        } else {
          this.setPixel(sx, y, r, g, b);
        }
      }
    }
  }

  // Blends a pixel toward its layer's debug tint color when layer-tint mode is on.
  tintForLayer(r, g, b, layer) {
    if (!this.emulator.layerTint) return [r, g, b];
    const [tr, tg, tb] = EMU_CORE_CONFIG.LAYER_TINTS[layer];
    const m = EMU_CORE_CONFIG.LAYER_TINT_MIX;
    return [r * (1 - m) + tr * m, g * (1 - m) + tg * m, b * (1 - m) + tb * m];
  }

  toSigned8(v) { return (v & 0x80) ? v - 256 : v; }
  setPixel(x, y, r, g, b) { const i = (y * EMU_CORE_CONFIG.SCREEN.WIDTH + x) * 4; this.framebuffer[i] = r; this.framebuffer[i + 1] = g; this.framebuffer[i + 2] = b; this.framebuffer[i + 3] = 255; }
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
