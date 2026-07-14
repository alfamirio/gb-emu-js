/* =========================================================================================
   emu-gb-core.js — JS GB (DMG) emulation core
   -----------------------------------------------------------------------------------------
   Hardware emulation: MMU, CPU, PPU, Timer, Joypad, APU, and the Emulator that drives them.

   Organized into seven parts, one per hardware component:
     1. MMU      - memory map: ROM banking, RAM, VRAM, OAM, I/O registers
     2. CPU      - the LR35902 processor: registers, flags, instruction set
     3. PPU      - turns VRAM/OAM into the 160x144 screen image
     4. Timer    - DIV/TIMA/TMA/TAC timer circuit
     5. Joypad   - button state + joypad I/O register
     6. APU      - 4-channel sound generator (Web Audio output)
     7. Emulator - glues everything together and drives the main loop

   New to GB internals? Start with the CPU: opcodes are decoded as bit fields, the same
   way the hardware does it, so ~500 instruction/CB combinations stay compact.
   ========================================================================================= */

/* ============================== 0. Emulation core config =============================== */
// Hardware constants: clock speed, frame/PPU timing, memory map, timer periods,
// sprite limits, palettes, boot-state register/IO values.
const EMU_CORE_CONFIG = {
  CLOCK_HZ: 4194304, // T-cycles/second

  FRAME: {
    VISIBLE_LINES: 144,
    VBLANK_LINES: 10,
    CYCLES_PER_LINE: 456,
    get TOTAL_LINES() { return this.VISIBLE_LINES + this.VBLANK_LINES; },        // 154
    get CYCLES_PER_FRAME() { return this.CYCLES_PER_LINE * this.TOTAL_LINES; },  // 70224
  },

  // Fixed cycle length per PPU mode (VBlank instead uses FRAME.CYCLES_PER_LINE).
  PPU_MODE_CYCLES: {
    OAM_SEARCH: 80,      // mode 2
    PIXEL_TRANSFER: 172, // mode 3
    HBLANK: 204,         // mode 0
  },

  SCREEN: { WIDTH: 160, HEIGHT: 144 },

  SPRITES: {
    MAX_TOTAL: 40,      // OAM entries
    MAX_PER_LINE: 10,   // hardware limit per scanline
    HEIGHT_SMALL: 8,
    HEIGHT_TALL: 16,
  },

  TIMER: {
    TIMA_PERIOD: [1024, 16, 64, 256], // T-cycles per TIMA tick, indexed by TAC[1:0]
    DIV_PERIOD: 256,
  },

  OAM_DMA_BYTES: 0xA0,

  // Classic DMG green tint, and the neutral grayscale of the GB Pocket.
  PALETTE_GB:  [[155, 188, 15], [139, 172, 15], [48, 98, 48], [15, 56, 15]],
  PALETTE_GBP: [[255, 255, 255], [169, 169, 169], [84, 84, 84], [0, 0, 0]],

  LAYER_TINTS: { bg: [255, 90, 90], window: [90, 220, 255], sprite: [140, 255, 110] },
  LAYER_TINT_MIX: 0.4,

  // First address *past* each region: region is [prevEnd, thisEnd).
  MEMORY: {
    ROM0_END: 0x4000,     // 0x0000-0x3FFF: ROM bank 0
    ROMX_END: 0x8000,     // 0x4000-0x7FFF: switchable ROM bank
    VRAM_END: 0xA000,     // 0x8000-0x9FFF: VRAM
    ERAM_END: 0xC000,     // 0xA000-0xBFFF: cart RAM / MBC2 RAM / MBC3 RTC
    WRAM_END: 0xE000,     // 0xC000-0xDFFF: WRAM
    ECHO_END: 0xFE00,     // 0xE000-0xFDFF: echo of WRAM
    OAM_END: 0xFEA0,      // 0xFE00-0xFE9F: OAM
    UNUSABLE_END: 0xFF00, // 0xFEA0-0xFEFF: unusable
    IO_END: 0xFF80,       // 0xFF00-0xFF7F: I/O registers
    HRAM_END: 0xFFFF,     // 0xFF80-0xFFFE: HRAM
    // 0xFFFF: IE register

    ROM_BANK_SIZE: 0x4000,
    RAM_BANK_SIZE: 0x2000,

    VRAM_SIZE: 0x2000,
    WRAM_SIZE: 0x2000,
    OAM_SIZE: 0xA0,
    HRAM_SIZE: 0x7F,
    IO_SIZE: 0x80,
    CART_RAM_SIZE: 0x20000, // up to 16 banks of 8KB (MBC5 max)
  },

  // Register/IO state the boot ROM leaves behind right before game code starts.
  BOOT: {
    A: 0x01, B: 0x00, C: 0x13, D: 0x00, E: 0xD8, H: 0x01, L: 0x4D,
    SP: 0xFFFE, PC: 0x0100,
    FLAG_Z: true, FLAG_N: false, FLAG_H: true, FLAG_C: true,
    IO: { P1: 0xCF, IF: 0xE1, LCDC: 0x91, BGP: 0xFC, OBP0: 0xFF, OBP1: 0xFF },
  },
};

/* ============================== 1. MMU (Memory Management Unit) ======================= */

// Small-int ids for each memory region, used to index Uint32Array/array lookups on the
// hot access path instead of a string-keyed object.
const REGION_ROM0 = 0, REGION_ROMX = 1, REGION_VRAM = 2, REGION_ERAM = 3, REGION_WRAM = 4,
      REGION_OAM = 5, REGION_UNUSED = 6, REGION_IO = 7, REGION_HRAM = 8, REGION_IE = 9;
const REGION_COUNT = 10;
const REGION_NAMES = ['ROM0', 'ROMX', 'VRAM', 'ERAM', 'WRAM', 'OAM', 'UNUSED', 'IO', 'HRAM', 'IE'];

class MMU {
  constructor(emulator) {
    this.emulator = emulator;

    this.rom = new Uint8Array(0);
    this.mbcType = 0;        // 0 = ROM only, 1 = MBC1, 2 = MBC2, 3 = MBC3, 5 = MBC5
    this.hasRumble = false;  // MBC5+RUMBLE masks an extra bit out of the RAM bank register
    this.currentROMBank = 1;
    this.currentRAMBank = 0;
    this.ramEnabled = false;
    this.bankingMode = 0;    // MBC1: 0 = ROM banking mode, 1 = RAM banking mode

    this.cartRAM = new Uint8Array(EMU_CORE_CONFIG.MEMORY.CART_RAM_SIZE);

    // MBC3 real-time clock. `rtc` is the live counter, advanced from wall-clock time;
    // `rtc.latched` is the frozen snapshot 0xA000-0xBFFF reads actually return, updated
    // only on the 0x00-then-0x01 latch write sequence.
    this.rtc = {
      s: 0, m: 0, h: 0, dl: 0, dh: 0,
      latched: { s: 0, m: 0, h: 0, dl: 0, dh: 0 },
      lastLatchWrite: 0xFF,
      lastRealMs: Date.now(),
    };
    this.rtcSelect = -1;   // -1 = 0xA000-0xBFFF maps to cart RAM; 0x08-0x0C = that RTC register
    this.hasTimer = false; // true only for cart types with an actual RTC chip (0x0F/0x10)

    const MEM = EMU_CORE_CONFIG.MEMORY;
    this.vram = new Uint8Array(MEM.VRAM_SIZE);
    this.wram = new Uint8Array(MEM.WRAM_SIZE);
    this.oam  = new Uint8Array(MEM.OAM_SIZE);
    this.hram = new Uint8Array(MEM.HRAM_SIZE);
    this.io   = new Uint8Array(MEM.IO_SIZE);
    this.ie   = 0; // 0xFFFF interrupt enable register

    // Debug-UI instrumentation: which region/address was last touched, and the last
    // bank-switch event. Purely observational, no effect on emulation.
    this.accessSeq = 0;
    this.lastAccess = { addr: 0, region: 'ROM0', type: 'read', seq: 0 };
    this.regionLastTouch = new Uint32Array(REGION_COUNT);
    this.lastBankSwitch = null; // { kind, addr, val, romBank, ramBank, t } or null
  }

  // Classifies an address into a REGION_* id.
  regionForAddr(addr) {
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROM0_END) return REGION_ROM0;
    if (addr < MEM.ROMX_END) return REGION_ROMX;
    if (addr < MEM.VRAM_END) return REGION_VRAM;
    if (addr < MEM.ERAM_END) return REGION_ERAM;
    if (addr < MEM.WRAM_END) return REGION_WRAM;
    if (addr < MEM.ECHO_END) return REGION_WRAM; // echo RAM mirrors WRAM
    if (addr < MEM.OAM_END) return REGION_OAM;
    if (addr < MEM.UNUSABLE_END) return REGION_UNUSED;
    if (addr < MEM.IO_END) return REGION_IO;
    if (addr < MEM.HRAM_END) return REGION_HRAM;
    return REGION_IE;
  }

  // Records a read/write for the Memory Map debug view.
  noteAccess(addr, type) {
    const regionId = this.regionForAddr(addr);
    this.accessSeq++;
    this.regionLastTouch[regionId] = this.accessSeq;
    const a = this.lastAccess;
    a.addr = addr; a.region = REGION_NAMES[regionId]; a.type = type; a.seq = this.accessSeq;
  }

  loadROM(bytes) {
    this.rom = bytes;
    const cartType = bytes[0x147];
    this.cartTypeByte = cartType;
    if (cartType === 0x00) { this.mbcType = 0; this.cartTypeSupported = true; }
    else if (cartType >= 0x01 && cartType <= 0x03) { this.mbcType = 1; this.cartTypeSupported = true; }
    else if (cartType === 0x05 || cartType === 0x06) { this.mbcType = 2; this.cartTypeSupported = true; }
    else if (cartType >= 0x0F && cartType <= 0x13) { this.mbcType = 3; this.cartTypeSupported = true; }
    else if (cartType >= 0x19 && cartType <= 0x1E) { this.mbcType = 5; this.cartTypeSupported = true; }
    else { this.mbcType = 1; this.cartTypeSupported = false; } // unknown mapper: best-effort MBC1 fallback
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

    this.accessSeq = 0;
    this.lastAccess.addr = 0; this.lastAccess.region = 'ROM0'; this.lastAccess.type = 'read'; this.lastAccess.seq = 0;
    this.regionLastTouch.fill(0);
    this.lastBankSwitch = null;

    // I/O state as left by the boot ROM.
    const bootIO = EMU_CORE_CONFIG.BOOT.IO;
    this.io.fill(0);
    this.io[0x00] = bootIO.P1;
    this.io[0x0F] = bootIO.IF;
    this.io[0x40] = bootIO.LCDC;
    this.io[0x47] = bootIO.BGP;
    this.io[0x48] = bootIO.OBP0;
    this.io[0x49] = bootIO.OBP1;
  }

  /* ---- save state ---- */
  serialize() {
    return {
      mbcType: this.mbcType, currentROMBank: this.currentROMBank, currentRAMBank: this.currentRAMBank,
      ramEnabled: this.ramEnabled, bankingMode: this.bankingMode,
      cartRAM: u8ToBase64(this.cartRAM), vram: u8ToBase64(this.vram), wram: u8ToBase64(this.wram),
      oam: u8ToBase64(this.oam), hram: u8ToBase64(this.hram), io: u8ToBase64(this.io), ie: this.ie,
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
    this.vram.set(base64ToU8(s.vram));
    this.wram.set(base64ToU8(s.wram));
    this.oam.set(base64ToU8(s.oam));
    this.hram.set(base64ToU8(s.hram));
    this.io.set(base64ToU8(s.io));
    this.ie = s.ie;
    if (s.rtc) {
      this.rtc.s = s.rtc.s; this.rtc.m = s.rtc.m; this.rtc.h = s.rtc.h; this.rtc.dl = s.rtc.dl; this.rtc.dh = s.rtc.dh;
      this.rtc.latched = { ...s.rtc.latched };
      this.rtc.lastLatchWrite = s.rtc.lastLatchWrite;
      this.rtc.lastRealMs = Date.now(); // resume live clock from now, not the saved timestamp
    }
    this.rtcSelect = (s.rtcSelect === undefined) ? -1 : s.rtcSelect;
  }

  read8(addr) {
    addr &= 0xFFFF;
    if (this.emulator.trackMemMap) this.noteAccess(addr, 'read');
    return this.peek8(addr);
  }

  // Same address decoding as read8, without recording the access (for inspection reads
  // like a RAM viewer, which shouldn't be misattributed to CPU activity).
  peek8(addr) {
    addr &= 0xFFFF;
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROM0_END) return this.rom[addr] ?? 0xFF;                              // ROM bank 0
    if (addr < MEM.ROMX_END) return this.rom[this.currentROMBank * MEM.ROM_BANK_SIZE + (addr - MEM.ROM0_END)] ?? 0xFF; // switchable ROM bank
    if (addr < MEM.VRAM_END) return this.vram[addr - MEM.ROMX_END];
    if (addr < MEM.ERAM_END) {
      if (this.mbcType === 3 && this.rtcSelect !== -1) return this.readRTCRegister();
      if (this.mbcType === 2) {
        if (!this.ramEnabled) return 0xFF;
        // MBC2's built-in RAM is only 512 nibbles, mirrored across 0xA000-0xBFFF; only 4
        // data lines are wired up, so the upper nibble always reads back as 1s.
        return 0xF0 | (this.cartRAM[addr & 0x1FF] & 0x0F);
      }
      return this.ramEnabled ? this.cartRAM[this.currentRAMBank * MEM.RAM_BANK_SIZE + (addr - MEM.VRAM_END)] : 0xFF;
    }
    if (addr < MEM.WRAM_END) return this.wram[addr - MEM.ERAM_END];
    if (addr < MEM.ECHO_END) return this.wram[addr - MEM.WRAM_END];  // echo of WRAM
    if (addr < MEM.OAM_END) return this.oam[addr - MEM.ECHO_END];
    if (addr < MEM.UNUSABLE_END) return 0xFF;
    if (addr < MEM.IO_END) return this.readIO(addr);
    if (addr < MEM.HRAM_END) return this.hram[addr - MEM.IO_END];
    return this.ie;
  }

  write8(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    if (this.emulator.trackMemMap) this.noteAccess(addr, 'write');
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROMX_END) { this.handleBanking(addr, val); return; }
    if (addr < MEM.VRAM_END) { this.vram[addr - MEM.ROMX_END] = val; return; }
    if (addr < MEM.ERAM_END) {
      if (!this.ramEnabled) return;
      if (this.mbcType === 3 && this.rtcSelect !== -1) { this.writeRTCRegister(val); return; }
      if (this.mbcType === 2) { this.cartRAM[addr & 0x1FF] = val & 0x0F; return; } // only the low nibble is real
      this.cartRAM[this.currentRAMBank * MEM.RAM_BANK_SIZE + (addr - MEM.VRAM_END)] = val;
      return;
    }
    if (addr < MEM.WRAM_END) { this.wram[addr - MEM.ERAM_END] = val; return; }
    if (addr < MEM.ECHO_END) { this.wram[addr - MEM.WRAM_END] = val; return; }
    if (addr < MEM.OAM_END) { this.oam[addr - MEM.ECHO_END] = val; return; }
    if (addr < MEM.UNUSABLE_END) return;
    if (addr < MEM.IO_END) { this.writeIO(addr, val); return; }
    if (addr < MEM.HRAM_END) { this.hram[addr - MEM.IO_END] = val; return; }
    this.ie = val;
  }

  // Writes into 0x0000-0x7FFF don't touch real ROM; they're commands to the cartridge's
  // Memory Bank Controller, which switches which ROM/RAM bank is currently mapped in.
  handleBanking(addr, val) {
    if (this.mbcType === 0) return; // no MBC: nothing to switch

    const prevROM = this.currentROMBank, prevRAM = this.currentRAMBank,
          prevEnabled = this.ramEnabled, prevMode = this.bankingMode, prevRtcSelect = this.rtcSelect;

    if (this.mbcType === 1) {
      if (addr < 0x2000) {
        this.ramEnabled = (val & 0x0F) === 0x0A;
      } else if (addr < 0x4000) {
        let bank = val & 0x1F;
        if (bank === 0) bank = 1; // bank 0 is never selectable here
        this.currentROMBank = (this.currentROMBank & 0x60) | bank;
      } else if (addr < 0x6000) {
        if (this.bankingMode === 0) this.currentROMBank = (this.currentROMBank & 0x1F) | ((val & 0x03) << 5);
        else this.currentRAMBank = val & 0x03;
      } else {
        this.bankingMode = val & 0x01;
      }
    } else if (this.mbcType === 2) {
      // MBC2: RAM-enable vs. ROM-bank-select is chosen by address bit 8, not by range.
      if (addr < 0x4000) {
        if ((addr & 0x0100) === 0) {
          this.ramEnabled = (val & 0x0F) === 0x0A;
        } else {
          let bank = val & 0x0F; // 4 bits: max 16 ROM banks
          if (bank === 0) bank = 1;
          this.currentROMBank = bank;
        }
      }
    } else if (this.mbcType === 3) {
      if (addr < 0x2000) {
        this.ramEnabled = (val & 0x0F) === 0x0A;
      } else if (addr < 0x4000) {
        let bank = val & 0x7F;
        if (bank === 0) bank = 1;
        this.currentROMBank = bank;
      } else if (addr < 0x6000) {
        // 0x00-0x03 selects a RAM bank; 0x08-0x0C maps that RTC register in instead.
        if (val <= 0x03) {
          this.currentRAMBank = val;
          this.rtcSelect = -1;
        } else if (val >= 0x08 && val <= 0x0C) {
          this.rtcSelect = val;
        }
      } else {
        // 0x00 then 0x01 latches the live RTC counters into the readable snapshot.
        if (this.rtc.lastLatchWrite === 0x00 && val === 0x01) {
          this.tickRTC();
          this.rtc.latched.s = this.rtc.s;
          this.rtc.latched.m = this.rtc.m;
          this.rtc.latched.h = this.rtc.h;
          this.rtc.latched.dl = this.rtc.dl;
          this.rtc.latched.dh = this.rtc.dh;
        }
        this.rtc.lastLatchWrite = val;
      }
    } else if (this.mbcType === 5) {
      // Full 9-bit ROM bank number across two registers; unlike MBC1/2/3, bank 0 is valid here.
      if (addr < 0x2000) {
        this.ramEnabled = (val & 0x0F) === 0x0A;
      } else if (addr < 0x3000) {
        this.currentROMBank = (this.currentROMBank & 0x100) | val; // low 8 bits
      } else if (addr < 0x4000) {
        this.currentROMBank = (this.currentROMBank & 0xFF) | ((val & 0x01) << 8); // bit 8
      } else if (addr < 0x6000) {
        // Bit 3 also drives the rumble motor on RUMBLE carts, so mask it out of the bank number.
        this.currentRAMBank = val & (this.hasRumble ? 0x07 : 0x0F);
      }
    }

    // Track what changed, for the MBC Banking debug view (ROM bank change checked first,
    // since it's by far the most common event).
    if (this.currentROMBank !== prevROM) {
      this.lastBankSwitch = { kind: 'rom', addr, val, romBank: this.currentROMBank, ramBank: this.currentRAMBank, t: performance.now() };
    } else if (this.currentRAMBank !== prevRAM) {
      this.lastBankSwitch = { kind: 'ram', addr, val, romBank: this.currentROMBank, ramBank: this.currentRAMBank, t: performance.now() };
    } else if (this.rtcSelect !== prevRtcSelect) {
      this.lastBankSwitch = { kind: 'rtc', addr, val, romBank: this.currentROMBank, ramBank: this.currentRAMBank, t: performance.now() };
    } else if (this.ramEnabled !== prevEnabled) {
      this.lastBankSwitch = { kind: 'enable', addr, val, romBank: this.currentROMBank, ramBank: this.currentRAMBank, t: performance.now() };
    } else if (this.bankingMode !== prevMode) {
      this.lastBankSwitch = { kind: 'mode', addr, val, romBank: this.currentROMBank, ramBank: this.currentRAMBank, t: performance.now() };
    }

    if (this.currentROMBank !== prevROM || this.currentRAMBank !== prevRAM || this.rtcSelect !== prevRtcSelect ||
        this.ramEnabled !== prevEnabled || this.bankingMode !== prevMode) {
      const fs = this.emulator.frameStats;
      fs.bankSwitches++;
      if (this.emulator.trackAccess) fs.events.push({ line: this.emulator.ppu.ly, kind: 'bank' });
    }
  }

  // Advances the live RTC counters by however much wall-clock time has passed. Skipped
  // while halted (dh bit 6), which is how games freeze the clock to set it precisely.
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
      if (days > 0x1FF) { rtc.dh |= 0x80; days &= 0x1FF; } // day counter overflow: set carry bit
      rtc.dl = days & 0xFF;
      rtc.dh = (rtc.dh & 0xFE) | ((days >> 8) & 0x01);
    }
  }

  // Returns the latched (not live) snapshot of whichever RTC register is selected.
  readRTCRegister() {
    const l = this.rtc.latched;
    switch (this.rtcSelect) {
      case 0x08: return l.s;
      case 0x09: return l.m;
      case 0x0A: return l.h;
      case 0x0B: return l.dl;
      case 0x0C: return l.dh;
      default:   return 0xFF;
    }
  }

  // Writing 0xA000-0xBFFF with an RTC register selected sets that register on the live clock.
  writeRTCRegister(val) {
    this.tickRTC();
    switch (this.rtcSelect) {
      case 0x08: this.rtc.s = val % 60; break;
      case 0x09: this.rtc.m = val % 60; break;
      case 0x0A: this.rtc.h = val % 24; break;
      case 0x0B: this.rtc.dl = val & 0xFF; break;
      case 0x0C: this.rtc.dh = val & 0xC1; break; // bit0: day MSB, bit6: halt, bit7: day carry
    }
  }

  readIO(addr) {
    const reg = addr & 0xFF;
    if (reg >= 0x10 && reg <= 0x3F) return this.emulator.apu.read(0xFF00 | reg); // sound + wave RAM
    switch (reg) {
      case 0x00: return this.emulator.joypad.read();
      case 0x04: return this.emulator.timer.div;
      case 0x05: return this.emulator.timer.tima;
      case 0x06: return this.emulator.timer.tma;
      case 0x07: return this.emulator.timer.tac;
      default:   return this.io[reg];
    }
  }

  writeIO(addr, val) {
    const reg = addr & 0xFF;
    if (reg >= 0x10 && reg <= 0x3F) { this.emulator.apu.write(0xFF00 | reg, val); return; }
    switch (reg) {
      case 0x00: this.emulator.joypad.write(val); return;
      case 0x04: this.emulator.timer.div = 0; return;  // any write resets DIV
      case 0x05: this.emulator.timer.tima = val; return;
      case 0x06: this.emulator.timer.tma = val; return;
      case 0x07: this.emulator.timer.tac = val & 0x07; return;
      case 0x41: this.io[reg] = (this.io[reg] & 0x07) | (val & 0xF8); return; // STAT: low 3 bits are hw-controlled
      case 0x44: this.io[reg] = 0; return; // writing LY resets it
      case 0x46: this.doDMA(val); return; // OAM DMA
      default:   this.io[reg] = val; return;
    }
  }

  // OAM DMA: copies 160 bytes from XX00-XX9F into OAM. Real hardware takes 160 cycles
  // and blocks memory access meanwhile; done instantly here.
  doDMA(val) {
    const src = val << 8;
    for (let i = 0; i < EMU_CORE_CONFIG.OAM_DMA_BYTES; i++) this.oam[i] = this.read8(src + i);
    const fs = this.emulator.frameStats;
    fs.dma++;
    if (this.emulator.trackAccess) fs.events.push({ line: this.emulator.ppu.ly, kind: 'dma' });
  }
}

/* ==================================== 2. CPU (LR35902) ================================= */

class CPU {
  constructor(mmu) {
    this.mmu = mmu;
    this.reset();
  }

  reset() {
    const boot = EMU_CORE_CONFIG.BOOT;
    this.A = boot.A; this.B = boot.B; this.C = boot.C; this.D = boot.D; this.E = boot.E;
    this.H = boot.H; this.L = boot.L;
    this.SP = boot.SP;
    this.PC = boot.PC;
    this.flagZ = boot.FLAG_Z; this.flagN = boot.FLAG_N; this.flagH = boot.FLAG_H; this.flagC = boot.FLAG_C;
    this.IME = false;      // Interrupt Master Enable
    this.eiDelay = 0;      // EI takes effect after the *next* instruction, not immediately
    this.halted = false;
    this.cycles = 0;       // T-cycles used by the instruction currently executing
  }

  /* ---- save state ---- */
  serialize() {
    return {
      A: this.A, B: this.B, C: this.C, D: this.D, E: this.E, H: this.H, L: this.L,
      SP: this.SP, PC: this.PC,
      flagZ: this.flagZ, flagN: this.flagN, flagH: this.flagH, flagC: this.flagC,
      IME: this.IME, eiDelay: this.eiDelay, halted: this.halted,
    };
  }
  deserialize(s) {
    this.A = s.A; this.B = s.B; this.C = s.C; this.D = s.D; this.E = s.E; this.H = s.H; this.L = s.L;
    this.SP = s.SP; this.PC = s.PC;
    this.flagZ = s.flagZ; this.flagN = s.flagN; this.flagH = s.flagH; this.flagC = s.flagC;
    this.IME = s.IME; this.eiDelay = s.eiDelay; this.halted = s.halted;
    this.cycles = 0;
  }

  /* ---- small helpers ---- */
  tick(n) { this.cycles += n; }
  toSigned8(v) { return (v & 0x80) ? v - 256 : v; }

  getF() { return (this.flagZ ? 0x80 : 0) | (this.flagN ? 0x40 : 0) | (this.flagH ? 0x20 : 0) | (this.flagC ? 0x10 : 0); }
  setF(v) { this.flagZ = !!(v & 0x80); this.flagN = !!(v & 0x40); this.flagH = !!(v & 0x20); this.flagC = !!(v & 0x10); }

  getBC() { return (this.B << 8) | this.C; }  setBC(v) { this.B = (v >> 8) & 0xFF; this.C = v & 0xFF; }
  getDE() { return (this.D << 8) | this.E; }  setDE(v) { this.D = (v >> 8) & 0xFF; this.E = v & 0xFF; }
  getHL() { return (this.H << 8) | this.L; }  setHL(v) { this.H = (v >> 8) & 0xFF; this.L = v & 0xFF; }
  getAF() { return (this.A << 8) | this.getF(); } setAF(v) { this.A = (v >> 8) & 0xFF; this.setF(v & 0xFF); }

  // 8-bit register field used throughout the opcode table: 0=B 1=C 2=D 3=E 4=H 5=L 6=(HL) 7=A
  getReg8(i) {
    switch (i) {
      case 0: return this.B; case 1: return this.C; case 2: return this.D; case 3: return this.E;
      case 4: return this.H; case 5: return this.L; case 6: return this.mmu.read8(this.getHL()); case 7: return this.A;
    }
  }
  setReg8(i, v) {
    v &= 0xFF;
    switch (i) {
      case 0: this.B = v; break; case 1: this.C = v; break; case 2: this.D = v; break; case 3: this.E = v; break;
      case 4: this.H = v; break; case 5: this.L = v; break; case 6: this.mmu.write8(this.getHL(), v); break; case 7: this.A = v; break;
    }
  }

  // 16-bit register-pair field: 0=BC 1=DE 2=HL 3=SP
  getRP(p) { switch (p) { case 0: return this.getBC(); case 1: return this.getDE(); case 2: return this.getHL(); case 3: return this.SP; } }
  setRP(p, v) { switch (p) { case 0: this.setBC(v); break; case 1: this.setDE(v); break; case 2: this.setHL(v); break; case 3: this.SP = v & 0xFFFF; break; } }

  fetch8() { const v = this.mmu.read8(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch8(); const hi = this.fetch8(); return (hi << 8) | lo; }

  push16(v) { this.SP = (this.SP - 1) & 0xFFFF; this.mmu.write8(this.SP, (v >> 8) & 0xFF); this.SP = (this.SP - 1) & 0xFFFF; this.mmu.write8(this.SP, v & 0xFF); }
  pop16() { const lo = this.mmu.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; const hi = this.mmu.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; return (hi << 8) | lo; }

  /* ---- arithmetic / logic (each updates the flag register) ---- */
  add8(v) { const a = this.A, r = a + v; this.flagH = (a & 0xF) + (v & 0xF) > 0xF; this.flagC = r > 0xFF; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = false; }
  adc8(v) { const a = this.A, c = this.flagC ? 1 : 0, r = a + v + c; this.flagH = (a & 0xF) + (v & 0xF) + c > 0xF; this.flagC = r > 0xFF; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = false; }
  sub8(v) { const a = this.A, r = a - v; this.flagH = (a & 0xF) < (v & 0xF); this.flagC = r < 0; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = true; }
  sbc8(v) { const a = this.A, c = this.flagC ? 1 : 0, r = a - v - c; this.flagH = (a & 0xF) - (v & 0xF) - c < 0; this.flagC = r < 0; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = true; }
  and8(v) { this.A &= v; this.flagZ = this.A === 0; this.flagN = false; this.flagH = true; this.flagC = false; }
  xor8(v) { this.A ^= v; this.flagZ = this.A === 0; this.flagN = false; this.flagH = false; this.flagC = false; }
  or8(v)  { this.A |= v; this.flagZ = this.A === 0; this.flagN = false; this.flagH = false; this.flagC = false; }
  cp8(v)  { const a = this.A, r = a - v; this.flagH = (a & 0xF) < (v & 0xF); this.flagC = r < 0; this.flagZ = (r & 0xFF) === 0; this.flagN = true; }
  inc8(v) { const r = (v + 1) & 0xFF; this.flagH = (v & 0xF) === 0xF; this.flagZ = r === 0; this.flagN = false; return r; }
  dec8(v) { const r = (v - 1) & 0xFF; this.flagH = (v & 0xF) === 0x0; this.flagZ = r === 0; this.flagN = true; return r; }

  addHL(v) { const hl = this.getHL(), r = hl + v; this.flagH = (hl & 0xFFF) + (v & 0xFFF) > 0xFFF; this.flagC = r > 0xFFFF; this.setHL(r & 0xFFFF); this.flagN = false; }
  addSPr8(offset) {
    const sp = this.SP, r = (sp + offset) & 0xFFFF;
    this.flagZ = false; this.flagN = false;
    this.flagH = (sp & 0xF) + (offset & 0xF) > 0xF;
    this.flagC = (sp & 0xFF) + (offset & 0xFF) > 0xFF;
    return r;
  }

  aluOp(op, v) {
    switch (op) {
      case 0: this.add8(v); break; case 1: this.adc8(v); break; case 2: this.sub8(v); break; case 3: this.sbc8(v); break;
      case 4: this.and8(v); break; case 5: this.xor8(v); break; case 6: this.or8(v); break;  case 7: this.cp8(v); break;
    }
  }

  // Decimal-adjust after an 8-bit add/sub so arithmetic on BCD values (e.g. a two-digit
  // score) yields correct decimal digits instead of raw hex.
  daa() {
    let a = this.A, adjust = 0, carry = this.flagC;
    if (this.flagN) {
      if (this.flagH) adjust |= 0x06;
      if (this.flagC) adjust |= 0x60;
      a = (a - adjust) & 0xFF;
    } else {
      if (this.flagH || (a & 0xF) > 9) adjust |= 0x06;
      if (this.flagC || a > 0x99) { adjust |= 0x60; carry = true; }
      a = (a + adjust) & 0xFF;
    }
    this.A = a; this.flagZ = a === 0; this.flagH = false; this.flagC = carry;
  }

  /* ---- rotate/shift, shared by the accumulator-only ops (07/0F/17/1F) and CB variants ---- */
  rlc(v) { const c = !!(v & 0x80); const r = ((v << 1) | (c ? 1 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  rrc(v) { const c = !!(v & 0x01); const r = ((v >> 1) | (c ? 0x80 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  rl(v)  { const c = !!(v & 0x80); const r = ((v << 1) | (this.flagC ? 1 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  rr(v)  { const c = !!(v & 0x01); const r = ((v >> 1) | (this.flagC ? 0x80 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  sla(v) { const c = !!(v & 0x80); const r = (v << 1) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  sra(v) { const c = !!(v & 0x01); const r = ((v >> 1) | (v & 0x80)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  swap(v){ const r = ((v << 4) | (v >> 4)) & 0xFF; this.flagC = false; this.flagN = false; this.flagH = false; return r; }
  srl(v) { const c = !!(v & 0x01); const r = (v >> 1) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  rotOp(op, v) {
    switch (op) {
      case 0: return this.rlc(v); case 1: return this.rrc(v); case 2: return this.rl(v); case 3: return this.rr(v);
      case 4: return this.sla(v); case 5: return this.sra(v); case 6: return this.swap(v); case 7: return this.srl(v);
    }
  }

  checkCond(cc) { switch (cc) { case 0: return !this.flagZ; case 1: return this.flagZ; case 2: return !this.flagC; case 3: return this.flagC; } }

  // STOP (0x10) halts CPU + LCD until a button press on real hardware; that low-power
  // mode isn't modeled here. Kept as its own method so subclasses can override it (e.g. CGB speed switch).
  handleStop() { this.PC = (this.PC + 1) & 0xFFFF; this.tick(4); }

  /* ---- fetch/execute step; returns T-cycles used ---- */
  step() {
    if (this.eiDelay > 0) { this.eiDelay--; if (this.eiDelay === 0) this.IME = true; }
    this.cycles = 0;

    // Checked right after the eiDelay transition, before fetching this step's opcode:
    // EI takes effect exactly on this boundary, so a following DI can't mask the interrupt.
    if (this.tryDispatchInterrupt()) return this.cycles;

    if (this.halted) {
      this.tick(4);
    } else {
      const opcode = this.fetch8();
      this.execute(opcode);
    }
    this.wakeFromHaltIfPending();
    return this.cycles;
  }

  // Level-sensitive HALT wake: exits on any pending (IF & IE), regardless of IME.
  wakeFromHaltIfPending() {
    const IF = this.mmu.io[0x0F] & 0x1F;
    const IE = this.mmu.ie & 0x1F;
    if ((IF & IE) && this.halted) this.halted = false;
  }

  // Dispatches one pending, enabled interrupt if any. Returns true if it did — dispatch
  // consumes the cycles for this step and replaces the opcode fetch, as on real hardware.
  tryDispatchInterrupt() {
    const IF = this.mmu.io[0x0F] & 0x1F;
    const IE = this.mmu.ie & 0x1F;
    const pending = IF & IE;
    if (pending && this.halted) this.halted = false;
    if (!this.IME || !pending) return false;
    const vectors = [0x40, 0x48, 0x50, 0x58, 0x60]; // VBlank, LCD STAT, Timer, Serial, Joypad
    for (let i = 0; i < 5; i++) {
      if (pending & (1 << i)) {
        this.IME = false;
        this.mmu.io[0x0F] &= ~(1 << i);
        this.mmu.emulator.logInterruptServiced(i, this.PC);
        this.push16(this.PC);
        this.PC = vectors[i];
        this.tick(20);
        return true;
      }
    }
    return false;
  }

  // Most of the opcode space is a regular grid of [operation][register] bit fields,
  // decoded generically here instead of 200+ near-identical switch cases.
  execute(opcode) {
    // 0x40-0x7F: LD r,r' (0x76 is the odd one out: HALT)
    if (opcode >= 0x40 && opcode <= 0x7F) {
      if (opcode === 0x76) { this.halted = true; this.tick(4); return; }
      const dst = (opcode >> 3) & 7, src = opcode & 7;
      this.setReg8(dst, this.getReg8(src));
      this.tick((dst === 6 || src === 6) ? 8 : 4);
      return;
    }
    // 0x80-0xBF: ALU A,r (ADD/ADC/SUB/SBC/AND/XOR/OR/CP)
    if (opcode >= 0x80 && opcode <= 0xBF) {
      const op = (opcode >> 3) & 7, src = opcode & 7;
      this.aluOp(op, this.getReg8(src));
      this.tick(src === 6 ? 8 : 4);
      return;
    }
    // INC r / DEC r / LD r,d8 share the same row pattern across 0x04-0x3E
    if ((opcode & 0xC7) === 0x04) { const r = (opcode >> 3) & 7; this.setReg8(r, this.inc8(this.getReg8(r))); this.tick(r === 6 ? 12 : 4); return; }
    if ((opcode & 0xC7) === 0x05) { const r = (opcode >> 3) & 7; this.setReg8(r, this.dec8(this.getReg8(r))); this.tick(r === 6 ? 12 : 4); return; }
    if ((opcode & 0xC7) === 0x06) { const r = (opcode >> 3) & 7; this.setReg8(r, this.fetch8());             this.tick(r === 6 ? 12 : 8); return; }

    switch (opcode) {
      case 0x00: this.tick(4); break; // NOP

      case 0x01: this.setBC(this.fetch16()); this.tick(12); break;
      case 0x02: this.mmu.write8(this.getBC(), this.A); this.tick(8); break;
      case 0x03: this.setBC((this.getBC() + 1) & 0xFFFF); this.tick(8); break;
      case 0x07: this.A = this.rlc(this.A); this.flagZ = false; this.tick(4); break;
      case 0x08: { const addr = this.fetch16(); this.mmu.write8(addr, this.SP & 0xFF); this.mmu.write8(addr + 1, (this.SP >> 8) & 0xFF); this.tick(20); break; }
      case 0x09: this.addHL(this.getBC()); this.tick(8); break;
      case 0x0A: this.A = this.mmu.read8(this.getBC()); this.tick(8); break;
      case 0x0B: this.setBC((this.getBC() - 1) & 0xFFFF); this.tick(8); break;
      case 0x0F: this.A = this.rrc(this.A); this.flagZ = false; this.tick(4); break;

      case 0x10: this.handleStop(); break; // STOP (2-byte opcode, simplified)
      case 0x11: this.setDE(this.fetch16()); this.tick(12); break;
      case 0x12: this.mmu.write8(this.getDE(), this.A); this.tick(8); break;
      case 0x13: this.setDE((this.getDE() + 1) & 0xFFFF); this.tick(8); break;
      case 0x17: this.A = this.rl(this.A); this.flagZ = false; this.tick(4); break;
      case 0x18: { const off = this.toSigned8(this.fetch8()); this.PC = (this.PC + off) & 0xFFFF; this.tick(12); break; }
      case 0x19: this.addHL(this.getDE()); this.tick(8); break;
      case 0x1A: this.A = this.mmu.read8(this.getDE()); this.tick(8); break;
      case 0x1B: this.setDE((this.getDE() - 1) & 0xFFFF); this.tick(8); break;
      case 0x1F: this.A = this.rr(this.A); this.flagZ = false; this.tick(4); break;

      case 0x20: { const off = this.toSigned8(this.fetch8()); if (!this.flagZ) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x21: this.setHL(this.fetch16()); this.tick(12); break;
      case 0x22: this.mmu.write8(this.getHL(), this.A); this.setHL((this.getHL() + 1) & 0xFFFF); this.tick(8); break;
      case 0x23: this.setHL((this.getHL() + 1) & 0xFFFF); this.tick(8); break;
      case 0x27: this.daa(); this.tick(4); break;
      case 0x28: { const off = this.toSigned8(this.fetch8()); if (this.flagZ) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x29: this.addHL(this.getHL()); this.tick(8); break;
      case 0x2A: this.A = this.mmu.read8(this.getHL()); this.setHL((this.getHL() + 1) & 0xFFFF); this.tick(8); break;
      case 0x2B: this.setHL((this.getHL() - 1) & 0xFFFF); this.tick(8); break;
      case 0x2F: this.A = (~this.A) & 0xFF; this.flagN = true; this.flagH = true; this.tick(4); break;

      case 0x30: { const off = this.toSigned8(this.fetch8()); if (!this.flagC) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x31: this.SP = this.fetch16(); this.tick(12); break;
      case 0x32: this.mmu.write8(this.getHL(), this.A); this.setHL((this.getHL() - 1) & 0xFFFF); this.tick(8); break;
      case 0x33: this.SP = (this.SP + 1) & 0xFFFF; this.tick(8); break;
      case 0x37: this.flagC = true; this.flagN = false; this.flagH = false; this.tick(4); break;
      case 0x38: { const off = this.toSigned8(this.fetch8()); if (this.flagC) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x39: this.addHL(this.SP); this.tick(8); break;
      case 0x3A: this.A = this.mmu.read8(this.getHL()); this.setHL((this.getHL() - 1) & 0xFFFF); this.tick(8); break;
      case 0x3B: this.SP = (this.SP - 1) & 0xFFFF; this.tick(8); break;
      case 0x3F: this.flagC = !this.flagC; this.flagN = false; this.flagH = false; this.tick(4); break;

      case 0xC0: if (!this.flagZ) { this.PC = this.pop16(); this.tick(20); } else this.tick(8); break;
      case 0xC1: this.setBC(this.pop16()); this.tick(12); break;
      case 0xC2: { const addr = this.fetch16(); if (!this.flagZ) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xC3: this.PC = this.fetch16(); this.tick(16); break;
      case 0xC4: { const addr = this.fetch16(); if (!this.flagZ) { this.push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xC5: this.push16(this.getBC()); this.tick(16); break;
      case 0xC6: this.add8(this.fetch8()); this.tick(8); break;
      case 0xC7: this.push16(this.PC); this.PC = 0x00; this.tick(16); break;
      case 0xC8: if (this.flagZ) { this.PC = this.pop16(); this.tick(20); } else this.tick(8); break;
      case 0xC9: this.PC = this.pop16(); this.tick(16); break;
      case 0xCA: { const addr = this.fetch16(); if (this.flagZ) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xCB: this.executeCB(this.fetch8()); break;
      case 0xCC: { const addr = this.fetch16(); if (this.flagZ) { this.push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xCD: { const addr = this.fetch16(); this.push16(this.PC); this.PC = addr; this.tick(24); break; }
      case 0xCE: this.adc8(this.fetch8()); this.tick(8); break;
      case 0xCF: this.push16(this.PC); this.PC = 0x08; this.tick(16); break;

      case 0xD0: if (!this.flagC) { this.PC = this.pop16(); this.tick(20); } else this.tick(8); break;
      case 0xD1: this.setDE(this.pop16()); this.tick(12); break;
      case 0xD2: { const addr = this.fetch16(); if (!this.flagC) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xD4: { const addr = this.fetch16(); if (!this.flagC) { this.push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xD5: this.push16(this.getDE()); this.tick(16); break;
      case 0xD6: this.sub8(this.fetch8()); this.tick(8); break;
      case 0xD7: this.push16(this.PC); this.PC = 0x10; this.tick(16); break;
      case 0xD8: if (this.flagC) { this.PC = this.pop16(); this.tick(20); } else this.tick(8); break;
      case 0xD9: this.PC = this.pop16(); this.IME = true; this.tick(16); break; // RETI
      case 0xDA: { const addr = this.fetch16(); if (this.flagC) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xDC: { const addr = this.fetch16(); if (this.flagC) { this.push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xDE: this.sbc8(this.fetch8()); this.tick(8); break;
      case 0xDF: this.push16(this.PC); this.PC = 0x18; this.tick(16); break;

      case 0xE0: { const addr = 0xFF00 + this.fetch8(); this.mmu.write8(addr, this.A); this.tick(12); break; }
      case 0xE1: this.setHL(this.pop16()); this.tick(12); break;
      case 0xE2: this.mmu.write8(0xFF00 + this.C, this.A); this.tick(8); break;
      case 0xE5: this.push16(this.getHL()); this.tick(16); break;
      case 0xE6: this.and8(this.fetch8()); this.tick(8); break;
      case 0xE7: this.push16(this.PC); this.PC = 0x20; this.tick(16); break;
      case 0xE8: { const off = this.toSigned8(this.fetch8()); this.SP = this.addSPr8(off); this.tick(16); break; }
      case 0xE9: this.PC = this.getHL(); this.tick(4); break;
      case 0xEA: { const addr = this.fetch16(); this.mmu.write8(addr, this.A); this.tick(16); break; }
      case 0xEE: this.xor8(this.fetch8()); this.tick(8); break;
      case 0xEF: this.push16(this.PC); this.PC = 0x28; this.tick(16); break;

      case 0xF0: { const addr = 0xFF00 + this.fetch8(); this.A = this.mmu.read8(addr); this.tick(12); break; }
      case 0xF1: this.setAF(this.pop16() & 0xFFF0); this.tick(12); break;
      case 0xF2: this.A = this.mmu.read8(0xFF00 + this.C); this.tick(8); break;
      case 0xF3: this.IME = false; this.eiDelay = 0; this.tick(4); break; // DI
      case 0xF5: this.push16(this.getAF()); this.tick(16); break;
      case 0xF6: this.or8(this.fetch8()); this.tick(8); break;
      case 0xF7: this.push16(this.PC); this.PC = 0x30; this.tick(16); break;
      case 0xF8: { const off = this.toSigned8(this.fetch8()); this.setHL(this.addSPr8(off)); this.tick(12); break; }
      case 0xF9: this.SP = this.getHL(); this.tick(8); break;
      case 0xFA: { const addr = this.fetch16(); this.A = this.mmu.read8(addr); this.tick(16); break; }
      case 0xFB: this.eiDelay = 2; this.tick(4); break; // EI (delayed by one instruction)
      case 0xFE: this.cp8(this.fetch8()); this.tick(8); break;
      case 0xFF: this.push16(this.PC); this.PC = 0x38; this.tick(16); break;

      default:
        console.warn('Unimplemented opcode 0x' + opcode.toString(16) + ' at PC=0x' + ((this.PC - 1) & 0xFFFF).toString(16));
        this.tick(4);
        break;
    }
  }

  // CB-prefixed ops are an 8x8 bit-field grid: rotate/shift (00-3F), then BIT (40-7F),
  // RES (80-BF), SET (C0-FF) — each column selecting one of B,C,D,E,H,L,(HL),A.
  executeCB(opcode) {
    const op = (opcode >> 3) & 7, r = opcode & 7;
    const val = this.getReg8(r);
    if (opcode < 0x40) {
      const result = this.rotOp(op, val);
      this.flagZ = result === 0;
      this.setReg8(r, result);
      this.tick(r === 6 ? 16 : 8);
    } else if (opcode < 0x80) { // BIT b,r
      this.flagZ = ((val >> op) & 1) === 0;
      this.flagN = false; this.flagH = true;
      this.tick(r === 6 ? 12 : 8);
    } else if (opcode < 0xC0) { // RES b,r
      this.setReg8(r, val & ~(1 << op));
      this.tick(r === 6 ? 16 : 8);
    } else { // SET b,r
      this.setReg8(r, val | (1 << op));
      this.tick(r === 6 ? 16 : 8);
    }
  }
}

/* ============================== Disassembler (debug tool) ================================
   A standalone decoder mirroring CPU.execute()/executeCB(), but read-only: it takes a
   caller-supplied readByte(offset) function instead of touching CPU/MMU state, so it can
   decode either live memory or a snapshot of bytes captured earlier.
   ========================================================================================= */

const REG8_NAMES = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const ALU_NAMES  = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const ROT_NAMES  = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SWAP', 'SRL'];

// readByte(offset) returns the byte at pc+offset (0, 1, or 2).
function disassembleBytes(readByte, pc) {
  const b0 = readByte(0);
  const d8 = () => readByte(1);
  const d16 = () => readByte(1) | (readByte(2) << 8);
  const r8 = () => { const v = readByte(1); return v & 0x80 ? v - 256 : v; };

  if (b0 >= 0x40 && b0 <= 0x7F) {
    if (b0 === 0x76) return { text: 'HALT', length: 1 };
    const dst = (b0 >> 3) & 7, src = b0 & 7;
    return { text: `LD ${REG8_NAMES[dst]},${REG8_NAMES[src]}`, length: 1 };
  }
  if (b0 >= 0x80 && b0 <= 0xBF) {
    const op = (b0 >> 3) & 7, src = b0 & 7;
    return { text: `${ALU_NAMES[op]}${REG8_NAMES[src]}`, length: 1 };
  }
  if ((b0 & 0xC7) === 0x04) { const r = (b0 >> 3) & 7; return { text: `INC ${REG8_NAMES[r]}`, length: 1 }; }
  if ((b0 & 0xC7) === 0x05) { const r = (b0 >> 3) & 7; return { text: `DEC ${REG8_NAMES[r]}`, length: 1 }; }
  if ((b0 & 0xC7) === 0x06) { const r = (b0 >> 3) & 7; return { text: `LD ${REG8_NAMES[r]},${hex8(d8())}`, length: 2 }; }

  switch (b0) {
    case 0x00: return { text: 'NOP', length: 1 };
    case 0x01: return { text: `LD BC,${hex16(d16())}`, length: 3 };
    case 0x02: return { text: 'LD (BC),A', length: 1 };
    case 0x03: return { text: 'INC BC', length: 1 };
    case 0x07: return { text: 'RLCA', length: 1 };
    case 0x08: return { text: `LD (${hex16(d16())}),SP`, length: 3 };
    case 0x09: return { text: 'ADD HL,BC', length: 1 };
    case 0x0A: return { text: 'LD A,(BC)', length: 1 };
    case 0x0B: return { text: 'DEC BC', length: 1 };
    case 0x0F: return { text: 'RRCA', length: 1 };

    case 0x10: return { text: 'STOP', length: 1 };
    case 0x11: return { text: `LD DE,${hex16(d16())}`, length: 3 };
    case 0x12: return { text: 'LD (DE),A', length: 1 };
    case 0x13: return { text: 'INC DE', length: 1 };
    case 0x17: return { text: 'RLA', length: 1 };
    case 0x18: return { text: `JR ${hex16((pc + 2 + r8()) & 0xFFFF)}`, length: 2 };
    case 0x19: return { text: 'ADD HL,DE', length: 1 };
    case 0x1A: return { text: 'LD A,(DE)', length: 1 };
    case 0x1B: return { text: 'DEC DE', length: 1 };
    case 0x1F: return { text: 'RRA', length: 1 };

    case 0x20: return { text: `JR NZ,${hex16((pc + 2 + r8()) & 0xFFFF)}`, length: 2 };
    case 0x21: return { text: `LD HL,${hex16(d16())}`, length: 3 };
    case 0x22: return { text: 'LD (HL+),A', length: 1 };
    case 0x23: return { text: 'INC HL', length: 1 };
    case 0x27: return { text: 'DAA', length: 1 };
    case 0x28: return { text: `JR Z,${hex16((pc + 2 + r8()) & 0xFFFF)}`, length: 2 };
    case 0x29: return { text: 'ADD HL,HL', length: 1 };
    case 0x2A: return { text: 'LD A,(HL+)', length: 1 };
    case 0x2B: return { text: 'DEC HL', length: 1 };
    case 0x2F: return { text: 'CPL', length: 1 };

    case 0x30: return { text: `JR NC,${hex16((pc + 2 + r8()) & 0xFFFF)}`, length: 2 };
    case 0x31: return { text: `LD SP,${hex16(d16())}`, length: 3 };
    case 0x32: return { text: 'LD (HL-),A', length: 1 };
    case 0x33: return { text: 'INC SP', length: 1 };
    case 0x37: return { text: 'SCF', length: 1 };
    case 0x38: return { text: `JR C,${hex16((pc + 2 + r8()) & 0xFFFF)}`, length: 2 };
    case 0x39: return { text: 'ADD HL,SP', length: 1 };
    case 0x3A: return { text: 'LD A,(HL-)', length: 1 };
    case 0x3B: return { text: 'DEC SP', length: 1 };
    case 0x3F: return { text: 'CCF', length: 1 };

    case 0xC0: return { text: 'RET NZ', length: 1 };
    case 0xC1: return { text: 'POP BC', length: 1 };
    case 0xC2: return { text: `JP NZ,${hex16(d16())}`, length: 3 };
    case 0xC3: return { text: `JP ${hex16(d16())}`, length: 3 };
    case 0xC4: return { text: `CALL NZ,${hex16(d16())}`, length: 3 };
    case 0xC5: return { text: 'PUSH BC', length: 1 };
    case 0xC6: return { text: `ADD A,${hex8(d8())}`, length: 2 };
    case 0xC7: return { text: 'RST 0x00', length: 1 };
    case 0xC8: return { text: 'RET Z', length: 1 };
    case 0xC9: return { text: 'RET', length: 1 };
    case 0xCA: return { text: `JP Z,${hex16(d16())}`, length: 3 };
    case 0xCB: { const op2 = readByte(1); const rr = (op2 >> 3) & 7, r = op2 & 7;
      if (op2 < 0x40) return { text: `${ROT_NAMES[rr]} ${REG8_NAMES[r]}`, length: 2 };
      if (op2 < 0x80) return { text: `BIT ${rr},${REG8_NAMES[r]}`, length: 2 };
      if (op2 < 0xC0) return { text: `RES ${rr},${REG8_NAMES[r]}`, length: 2 };
      return { text: `SET ${rr},${REG8_NAMES[r]}`, length: 2 }; }
    case 0xCC: return { text: `CALL Z,${hex16(d16())}`, length: 3 };
    case 0xCD: return { text: `CALL ${hex16(d16())}`, length: 3 };
    case 0xCE: return { text: `ADC A,${hex8(d8())}`, length: 2 };
    case 0xCF: return { text: 'RST 0x08', length: 1 };

    case 0xD0: return { text: 'RET NC', length: 1 };
    case 0xD1: return { text: 'POP DE', length: 1 };
    case 0xD2: return { text: `JP NC,${hex16(d16())}`, length: 3 };
    case 0xD4: return { text: `CALL NC,${hex16(d16())}`, length: 3 };
    case 0xD5: return { text: 'PUSH DE', length: 1 };
    case 0xD6: return { text: `SUB ${hex8(d8())}`, length: 2 };
    case 0xD7: return { text: 'RST 0x10', length: 1 };
    case 0xD8: return { text: 'RET C', length: 1 };
    case 0xD9: return { text: 'RETI', length: 1 };
    case 0xDA: return { text: `JP C,${hex16(d16())}`, length: 3 };
    case 0xDC: return { text: `CALL C,${hex16(d16())}`, length: 3 };
    case 0xDE: return { text: `SBC A,${hex8(d8())}`, length: 2 };
    case 0xDF: return { text: 'RST 0x18', length: 1 };

    case 0xE0: return { text: `LDH (0xFF00+${hex8(d8())}),A`, length: 2 };
    case 0xE1: return { text: 'POP HL', length: 1 };
    case 0xE2: return { text: 'LD (0xFF00+C),A', length: 1 };
    case 0xE5: return { text: 'PUSH HL', length: 1 };
    case 0xE6: return { text: `AND ${hex8(d8())}`, length: 2 };
    case 0xE7: return { text: 'RST 0x20', length: 1 };
    case 0xE8: return { text: `ADD SP,${r8()}`, length: 2 };
    case 0xE9: return { text: 'JP (HL)', length: 1 };
    case 0xEA: return { text: `LD (${hex16(d16())}),A`, length: 3 };
    case 0xEE: return { text: `XOR ${hex8(d8())}`, length: 2 };
    case 0xEF: return { text: 'RST 0x28', length: 1 };

    case 0xF0: return { text: `LDH A,(0xFF00+${hex8(d8())})`, length: 2 };
    case 0xF1: return { text: 'POP AF', length: 1 };
    case 0xF2: return { text: 'LD A,(0xFF00+C)', length: 1 };
    case 0xF3: return { text: 'DI', length: 1 };
    case 0xF5: return { text: 'PUSH AF', length: 1 };
    case 0xF6: return { text: `OR ${hex8(d8())}`, length: 2 };
    case 0xF7: return { text: 'RST 0x30', length: 1 };
    case 0xF8: return { text: `LD HL,SP+${r8()}`, length: 2 };
    case 0xF9: return { text: 'LD SP,HL', length: 1 };
    case 0xFA: return { text: `LD A,(${hex16(d16())})`, length: 3 };
    case 0xFB: return { text: 'EI', length: 1 };
    case 0xFE: return { text: `CP ${hex8(d8())}`, length: 2 };
    case 0xFF: return { text: 'RST 0x38', length: 1 };

    default: return { text: `DB ${hex8(b0)} (illegal)`, length: 1 };
  }
}

// Reads live from an MMU (used by the "next instructions" view).
function disassembleAt(mmu, addr) {
  return disassembleBytes((off) => mmu.read8((addr + off) & 0xFFFF), addr & 0xFFFF);
}

// Plain-English gloss for a decoded mnemonic, for the execution trace view. Checked against
// full-text prefixes first (addressing modes worth calling out specifically), then falls
// back to a description keyed on the base mnemonic word.
const INSTRUCTION_PREFIX_NOTES = [
  ['ADD HL,', 'Adds a 16-bit register pair into HL.'],
  ['ADD SP,', 'Adds a signed offset to the stack pointer.'],
  ['LD (HL+),A', 'Stores A at (HL), then increments HL — the classic auto-advancing write.'],
  ['LD (HL-),A', 'Stores A at (HL), then decrements HL — the classic auto-advancing write.'],
  ['LD A,(HL+)', 'Loads A from (HL), then increments HL.'],
  ['LD A,(HL-)', 'Loads A from (HL), then decrements HL.'],
  ['LD HL,SP+', 'Loads HL with SP plus a signed offset (stack-relative addressing).'],
  ['LD SP,HL', 'Copies HL into the stack pointer.'],
  ['LD (0xFF00+C),A', 'Stores A into the I/O register selected by C (fast 0xFF00-page write).'],
  ['LD A,(0xFF00+C)', 'Loads A from the I/O register selected by C (fast 0xFF00-page read).'],
  ['LD (BC),A', 'Stores A into the address held in BC.'],
  ['LD (DE),A', 'Stores A into the address held in DE.'],
  ['LD A,(BC)', 'Loads A from the address held in BC.'],
  ['LD A,(DE)', 'Loads A from the address held in DE.'],
];
const INSTRUCTION_WORD_NOTES = {
  NOP: 'No operation — does nothing for one cycle.',
  HALT: 'Halts the CPU until an interrupt occurs, to save power while idle.',
  STOP: 'Stops the CPU and LCD until a button is pressed (deep low-power mode).',
  DAA: "Adjusts A after BCD add/sub so it holds a valid two-digit decimal value.",
  CPL: 'Flips every bit of A (bitwise NOT).',
  SCF: 'Sets the carry flag.',
  CCF: 'Flips (complements) the carry flag.',
  DI: 'Disables interrupts (IME = 0).',
  EI: 'Enables interrupts, taking effect after the next instruction.',
  RETI: 'Returns from an interrupt handler and re-enables interrupts.',
  RET: 'Returns from a subroutine, popping the return address off the stack.',
  LD: 'Copies a value into a register or memory location.',
  LDH: 'Loads/stores A via a fast one-byte, 0xFF00-prefixed I/O address.',
  INC: 'Increments the value by 1.',
  DEC: 'Decrements the value by 1.',
  ADD: 'Adds the operand into the destination.',
  ADC: 'Adds the operand plus the carry flag into A.',
  SUB: 'Subtracts the operand from A.',
  SBC: 'Subtracts the operand and the carry flag from A.',
  AND: 'Bitwise ANDs A with the operand.',
  OR: 'Bitwise ORs A with the operand.',
  XOR: 'Bitwise XORs A with the operand.',
  CP: "Compares A with the operand (like SUB, but discards the result — only flags change).",
  JP: 'Jumps to the given address.',
  JR: 'Jumps to a nearby address via a signed 8-bit relative offset.',
  CALL: 'Calls a subroutine: pushes the return address, then jumps.',
  RST: 'Calls one of 8 fixed reset vectors — a compact 1-byte CALL.',
  PUSH: 'Pushes a 16-bit register pair onto the stack.',
  POP: 'Pops a 16-bit register pair off the stack.',
  RLCA: "Rotates A left; bit 7 also goes into the carry flag.",
  RRCA: "Rotates A right; bit 0 also goes into the carry flag.",
  RLA: 'Rotates A left through the carry flag.',
  RRA: 'Rotates A right through the carry flag.',
  RLC: "Rotates left; bit 7 also goes into the carry flag.",
  RRC: "Rotates right; bit 0 also goes into the carry flag.",
  RL: 'Rotates left through the carry flag.',
  RR: 'Rotates right through the carry flag.',
  SLA: 'Shifts left; 0 comes in at bit 0, bit 7 goes to carry.',
  SRA: 'Shifts right; bit 7 is preserved, bit 0 goes to carry.',
  SRL: 'Shifts right; 0 comes in at bit 7, bit 0 goes to carry.',
  SWAP: 'Swaps the high and low nibbles of the byte.',
  BIT: 'Tests one bit and sets the zero flag if it is 0.',
  RES: 'Clears (resets) one bit to 0.',
  SET: 'Sets one bit to 1.',
  DB: 'Illegal/unimplemented opcode byte — not a real instruction.',
};
const COND_NOTE = { NZ: 'not zero', Z: 'zero', NC: 'no carry', C: 'carry' };

function explainInstruction(mnemonicText) {
  for (const [prefix, note] of INSTRUCTION_PREFIX_NOTES) {
    if (mnemonicText.startsWith(prefix)) return note;
  }
  const opWord = mnemonicText.split(/[ ,]/)[0];
  let note = INSTRUCTION_WORD_NOTES[opWord];
  if (!note) return 'Executes this CPU opcode.';
  // Conditional control-flow ops (JP NZ, JR Z, CALL C, RET NC, ...) only act when the
  // named flag condition holds.
  if (opWord === 'JP' || opWord === 'JR' || opWord === 'CALL' || opWord === 'RET') {
    const rest = mnemonicText.slice(opWord.length).trim();
    const condMatch = rest.match(/^(NZ|NC|Z|C)\b/);
    if (condMatch) note += ` Only taken if ${COND_NOTE[condMatch[1]]}.`;
  }
  return note;
}

/* ==================================== 3. PPU (graphics) ================================= */

class PPU {
  // Classic DMG green tint, and the neutral grayscale of the GB Pocket. SHADES points at
  // whichever palette is active (see Emulator.setScreenModel()).
  static PALETTE_GB  = EMU_CORE_CONFIG.PALETTE_GB;
  static PALETTE_GBP = EMU_CORE_CONFIG.PALETTE_GBP;
  static SHADES = PPU.PALETTE_GBP;

  // Layer-tint debug view: washes each layer (background/window/sprites) a distinct color.
  static LAYER_TINTS = EMU_CORE_CONFIG.LAYER_TINTS;
  static LAYER_TINT_MIX = EMU_CORE_CONFIG.LAYER_TINT_MIX;

  static _compareSpritePriority(a, b) { return (b.spriteX - a.spriteX) || (b.oamIndex - a.oamIndex); }

  constructor(emulator) {
    this.emulator = emulator;
    this.mmu = emulator.mmu;
    this.modeClock = 0;
    this.mode = 2;
    this.windowLineCounter = 0;
    this.framebuffer = new Uint8ClampedArray(EMU_CORE_CONFIG.SCREEN.WIDTH * EMU_CORE_CONFIG.SCREEN.HEIGHT * 4);

    // Reused every getSpriteCandidatesForLine() call instead of allocating: a fixed array
    // plus one fixed slot object per hardware sprites-per-line slot.
    this._spriteCandidates = [];
    this._spriteSlotPool = Array.from({ length: EMU_CORE_CONFIG.SPRITES.MAX_PER_LINE },
      () => ({ spriteY: 0, spriteX: 0, tileIndex: 0, attrs: 0, oamIndex: 0 }));
  }

  /* ---- save state ---- */
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

  // Advances OAM search -> pixel transfer -> HBlank, over 144 visible lines then 10 VBlank
  // lines, using a simplified fixed-length-per-mode timing model rather than a pixel FIFO.
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
        }
        break;

      case 0: // HBlank
        if (this.modeClock >= MODE.HBLANK) {
          this.modeClock -= MODE.HBLANK;
          this.ly++;
          this.checkLYC();
          if (this.ly === FRAME.VISIBLE_LINES) {
            this.mode = 1; this.setStatMode(1);
            this.emulator.requestInterrupt(0); // VBlank interrupt
            this.checkStatInterrupt(0x10);
            this.emulator.frameReady = true;
          } else {
            this.mode = 2; this.setStatMode(2);
            this.checkStatInterrupt(0x20);
          }
        }
        break;

      case 1: // VBlank (10 lines, each one line's worth of cycles)
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
    const bgPriority = new Uint8Array(EMU_CORE_CONFIG.SCREEN.WIDTH); // per-pixel BG/window color index, for sprite priority

    if (this.lcdc & 0x01) {
      this.renderBackgroundLine(y, bgPriority);
      if (this.lcdc & 0x20) this.renderWindowLine(y, bgPriority);
    } else {
      for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) this.setPixel(x, y, 255, 255, 255);
    }
    if (this.lcdc & 0x02) this.renderSpritesLine(y, bgPriority);
  }

  /* ---- shared pixel-decoding helpers ----
     Single source of truth for tile/sprite pixel math, used both by the real per-scanline
     renderer below and the debug layer viewer, so the two can never drift apart. */

  // Decodes the 2bpp color index (0-3) at tile-space coordinates (mapX, mapY) for the given
  // tile map / tile data base. mapX/mapY are already resolved into that map's own space.
  getTileColorIndex(tileMapBase, tileDataBase, signedIndex, mapX, mapY) {
    const tileRow = mapY >> 3, tileCol = mapX >> 3;
    const tileIndexRaw = this.mmu.vram[(tileMapBase + tileRow * 32 + tileCol) - 0x8000];
    const tileIndex = signedIndex ? this.toSigned8(tileIndexRaw) : tileIndexRaw;
    const tileAddr = tileDataBase + tileIndex * 16;
    const py = mapY & 7, px = mapX & 7;
    const lo = this.mmu.vram[(tileAddr - 0x8000) + py * 2];
    const hi = this.mmu.vram[(tileAddr - 0x8000) + py * 2 + 1];
    const bit = 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  // Tile-data addressing (LCDC.4) is shared by the BG and window layers; cached since it
  // rarely changes but is queried once per pixel.
  bgWindowTileDataConfig() {
    const signedIndex = !(this.lcdc & 0x10);
    if (this._tdConfig && this._tdConfig.signedIndex === signedIndex) return this._tdConfig;
    this._tdConfig = { tileDataBase: signedIndex ? 0x9000 : 0x8000, signedIndex };
    return this._tdConfig;
  }

  // Color index of the background pixel at screen (x, y), per current SCX/SCY/LCDC.
  getBackgroundColorIndex(x, y) {
    const tileMapBase = (this.lcdc & 0x08) ? 0x9C00 : 0x9800;
    const { tileDataBase, signedIndex } = this.bgWindowTileDataConfig();
    const bgX = (x + this.scx) & 0xFF, bgY = (y + this.scy) & 0xFF;
    return this.getTileColorIndex(tileMapBase, tileDataBase, signedIndex, bgX, bgY);
  }

  // Color index of the window pixel at window-space coordinates (winX, winY).
  getWindowColorIndex(winX, winY) {
    const tileMapBase = (this.lcdc & 0x40) ? 0x9C00 : 0x9800;
    const { tileDataBase, signedIndex } = this.bgWindowTileDataConfig();
    return this.getTileColorIndex(tileMapBase, tileDataBase, signedIndex, winX, winY);
  }

  // Sprite candidates for scanline y: OAM entries covering this line, capped at the
  // hardware's 10-per-line limit and sorted so drawing lowest-priority-first reproduces
  // the real X-then-OAM-index priority rule.
  getSpriteCandidatesForLine(y, spriteHeight) {
    const SPR = EMU_CORE_CONFIG.SPRITES;
    const candidates = this._spriteCandidates;
    const pool = this._spriteSlotPool;
    candidates.length = 0;
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
    candidates.sort(PPU._compareSpritePriority);
    return candidates;
  }

  // Decodes a sprite's bit-planes for its row on scanline y, honoring Y-flip and (for
  // 8x16 sprites) which half-tile the row falls in.
  getSpriteRowBits(sprite, y, spriteHeight) {
    const yFlip = !!(sprite.attrs & 0x40), xFlip = !!(sprite.attrs & 0x20);
    let tileIndex = sprite.tileIndex;
    if (spriteHeight === 16) tileIndex &= 0xFE;

    let rowInSprite = y - sprite.spriteY;
    if (yFlip) rowInSprite = spriteHeight - 1 - rowInSprite;
    let tileOffset = tileIndex * 16;
    if (rowInSprite >= 8) { tileOffset += 16; rowInSprite -= 8; }

    return {
      lo: this.mmu.vram[tileOffset + rowInSprite * 2],
      hi: this.mmu.vram[tileOffset + rowInSprite * 2 + 1],
      xFlip,
    };
  }

  // Color index (0-3) at column px (0-7) within a sprite row.
  static spriteRowColorIndex(lo, hi, xFlip, px) {
    const bit = xFlip ? px : 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  renderBackgroundLine(y, bgPriority) {
    const tint = this.emulator.layerTint;
    for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const colorNum = this.getBackgroundColorIndex(x, y);
      bgPriority[x] = colorNum;
      const shade = this.applyPalette(colorNum, this.bgp);
      if (tint) {
        const [r, g, b] = this.tintForLayer(shade[0], shade[1], shade[2], 'bg');
        this.setPixel(x, y, r, g, b);
      } else {
        this.setPixel(x, y, shade[0], shade[1], shade[2]);
      }
    }
  }

  renderWindowLine(y, bgPriority) {
    if (y < this.wy) return;
    const wx = this.wx - 7;
    if (wx > EMU_CORE_CONFIG.SCREEN.WIDTH - 1) return;
    const winY = this.windowLineCounter;
    let drewAny = false;
    const tint = this.emulator.layerTint;

    for (let x = Math.max(wx, 0); x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const colorNum = this.getWindowColorIndex(x - wx, winY);
      bgPriority[x] = colorNum;
      const shade = this.applyPalette(colorNum, this.bgp);
      if (tint) {
        const [r, g, b] = this.tintForLayer(shade[0], shade[1], shade[2], 'window');
        this.setPixel(x, y, r, g, b);
      } else {
        this.setPixel(x, y, shade[0], shade[1], shade[2]);
      }
      drewAny = true;
    }
    if (drewAny) this.windowLineCounter++;
  }

  renderSpritesLine(y, bgPriority) {
    const SPR = EMU_CORE_CONFIG.SPRITES;
    const spriteHeight = (this.lcdc & 0x04) ? SPR.HEIGHT_TALL : SPR.HEIGHT_SMALL;
    const candidates = this.getSpriteCandidatesForLine(y, spriteHeight);

    const fs = this.emulator.frameStats;
    fs.spritesPerLine[y] = candidates.length;
    fs.spritesTotal += candidates.length;
    if (candidates.length > fs.spritesMaxLine) fs.spritesMaxLine = candidates.length;

    const tint = this.emulator.layerTint;

    for (const s of candidates) {
      if (s.spriteX <= -8 || s.spriteX >= EMU_CORE_CONFIG.SCREEN.WIDTH) continue;
      const behindBG = !!(s.attrs & 0x80);
      const palette = (s.attrs & 0x10) ? this.obp1 : this.obp0;
      const { lo, hi, xFlip } = this.getSpriteRowBits(s, y, spriteHeight);

      for (let px = 0; px < 8; px++) {
        const sx = s.spriteX + px;
        if (sx < 0 || sx >= EMU_CORE_CONFIG.SCREEN.WIDTH) continue;
        const colorNum = PPU.spriteRowColorIndex(lo, hi, xFlip, px);
        if (colorNum === 0) continue; // color 0 is always transparent for sprites
        if (behindBG && bgPriority[sx] !== 0) continue;
        const shade = this.applyPalette(colorNum, palette);
        if (tint) {
          const [r, g, b] = this.tintForLayer(shade[0], shade[1], shade[2], 'sprite');
          this.setPixel(sx, y, r, g, b);
        } else {
          this.setPixel(sx, y, shade[0], shade[1], shade[2]);
        }
      }
    }
  }

  applyPalette(colorNum, palette) { return PPU.SHADES[(palette >> (colorNum * 2)) & 0x03]; }

  // Blends a pixel toward its layer's debug tint color when layer-tint mode is on.
  tintForLayer(r, g, b, layer) {
    if (!this.emulator.layerTint) return [r, g, b];
    const [tr, tg, tb] = PPU.LAYER_TINTS[layer];
    const m = PPU.LAYER_TINT_MIX;
    return [r * (1 - m) + tr * m, g * (1 - m) + tg * m, b * (1 - m) + tb * m];
  }
  toSigned8(v) { return (v & 0x80) ? v - 256 : v; }
  setPixel(x, y, r, g, b) { const i = (y * EMU_CORE_CONFIG.SCREEN.WIDTH + x) * 4; this.framebuffer[i] = r; this.framebuffer[i + 1] = g; this.framebuffer[i + 2] = b; this.framebuffer[i + 3] = 255; }
}

/* ==================================== 4. Timer ========================================== */

class Timer {
  static TIMA_PERIOD = EMU_CORE_CONFIG.TIMER.TIMA_PERIOD; // T-cycles per TIMA tick, indexed by TAC[1:0]

  constructor(emulator) {
    this.emulator = emulator;
    this.divCounter = 0;
    this.divReg = 0;
    this.timaCounter = 0;
    this.tima = 0;
    this.tma = 0;
    this.tac = 0;
  }

  /* ---- save state ---- */
  serialize() {
    return {
      divCounter: this.divCounter, divReg: this.divReg, timaCounter: this.timaCounter,
      tima: this.tima, tma: this.tma, tac: this.tac,
    };
  }
  deserialize(s) {
    this.divCounter = s.divCounter; this.divReg = s.divReg; this.timaCounter = s.timaCounter;
    this.tima = s.tima; this.tma = s.tma; this.tac = s.tac;
  }

  get div() { return this.divReg; }
  set div(v) { this.divReg = 0; this.divCounter = 0; } // any write resets DIV

  step(cycles) {
    const DIV_PERIOD = EMU_CORE_CONFIG.TIMER.DIV_PERIOD;
    this.divCounter += cycles;
    while (this.divCounter >= DIV_PERIOD) { this.divCounter -= DIV_PERIOD; this.divReg = (this.divReg + 1) & 0xFF; }

    if (this.tac & 0x04) { // timer enabled
      this.timaCounter += cycles;
      const period = Timer.TIMA_PERIOD[this.tac & 0x03];
      while (this.timaCounter >= period) {
        this.timaCounter -= period;
        this.tima = (this.tima + 1) & 0xFF;
        if (this.tima === 0) {
          this.tima = this.tma;
          this.emulator.requestInterrupt(2); // Timer interrupt
        }
      }
    }
  }
}

/* ==================================== 5. Joypad ========================================= */

class Joypad {
  constructor(emulator) {
    this.emulator = emulator;
    this.selectDirections = false;
    this.selectButtons = false;
    this.directionState = 0x0F; // bit0 Right, bit1 Left, bit2 Up, bit3 Down (0 = pressed)
    this.buttonState = 0x0F;    // bit0 A, bit1 B, bit2 Select, bit3 Start (0 = pressed)
  }

  /* ---- save state ---- */
  serialize() {
    return {
      selectDirections: this.selectDirections, selectButtons: this.selectButtons,
      directionState: this.directionState, buttonState: this.buttonState,
    };
  }
  deserialize(s) {
    this.selectDirections = s.selectDirections; this.selectButtons = s.selectButtons;
    this.directionState = s.directionState; this.buttonState = s.buttonState;
  }

  write(val) {
    this.selectDirections = (val & 0x10) === 0;
    this.selectButtons = (val & 0x20) === 0;
  }

  read() {
    let nibble = 0x0F;
    if (this.selectDirections) nibble &= this.directionState;
    if (this.selectButtons) nibble &= this.buttonState;
    let selectBits = 0x30;
    if (this.selectDirections) selectBits &= ~0x10;
    if (this.selectButtons) selectBits &= ~0x20;
    return 0xC0 | selectBits | nibble;
  }

  setButton(bit, pressed, isDirection) {
    const key = isDirection ? 'directionState' : 'buttonState';
    const wasPressed = !(this[key] & (1 << bit));
    if (pressed) this[key] &= ~(1 << bit); else this[key] |= (1 << bit);
    if (pressed && !wasPressed) this.emulator.requestInterrupt(4); // Joypad interrupt
  }
}

/* ==================================== 6. APU (sound) ==================================== */
/*
  4 sound channels:
    Ch1 - square wave with a pitch sweep
    Ch2 - square wave (no sweep)
    Ch3 - arbitrary waveform played from 32 4-bit samples ("wave RAM")
    Ch4 - pseudo-random noise from a shifting LFSR (linear feedback shift register)

  Each channel has its own frequency/length/volume-envelope logic, driven by a shared
  "frame sequencer" ticking at 512 Hz that doles out slower clocks to length counters
  (256 Hz), the frequency sweep (128 Hz), and volume envelopes (64 Hz).

  Output is one sample per channel per Web Audio tick (~44.1kHz), read off the channel's
  current duty/volume/LFSR state at that instant — a simple, non-band-limited approximation
  that sounds correct for essentially all game music/SFX.
*/

const APU_DUTY_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
  [1, 0, 0, 0, 0, 0, 0, 1], // 25%
  [1, 0, 0, 0, 0, 1, 1, 1], // 50%
  [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];
const APU_NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

// Bits that always read back as 1 (real hardware has no storage for them — write-only/unused).
const APU_IO_MASK = {
  0xFF10: 0x80, 0xFF11: 0x3F, 0xFF12: 0x00, 0xFF13: 0xFF, 0xFF14: 0xBF,
  0xFF16: 0x3F, 0xFF17: 0x00, 0xFF18: 0xFF, 0xFF19: 0xBF,
  0xFF1A: 0x7F, 0xFF1B: 0xFF, 0xFF1C: 0x9F, 0xFF1D: 0xFF, 0xFF1E: 0xBF,
  0xFF20: 0xFF, 0xFF21: 0x00, 0xFF22: 0x00, 0xFF23: 0xBF,
  0xFF24: 0x00, 0xFF25: 0x00,
};

class APU {
  constructor(emulator) {
    this.emulator = emulator;
    this.enabled = false; // NR52 master power bit

    this.ch1 = this.newCh1State();
    this.ch2 = this.newSquareState();

    this.ch3 = { enabled: false, dacEnabled: false, frequency: 0, freqTimer: 0,
                 lengthCounter: 0, lengthEnabled: false, volumeShift: 0, samplePos: 0 };
    this.waveRAM = new Uint8Array(16); // 0xFF30-0xFF3F, 32 packed 4-bit samples

    this.ch4 = { enabled: false, dacEnabled: false, lengthCounter: 0, lengthEnabled: false,
                 envVolume: 0, envDirection: 0, envPeriod: 0, envTimer: 0, volume: 0,
                 clockShift: 0, widthMode: 0, divisorCode: 0, freqTimer: 8, lfsr: 0x7FFF };

    this.regs = new Uint8Array(0x30); // raw bytes for 0xFF10-0xFF3F, indexed by (addr - 0xFF10)
    this.leftVol = 7; this.rightVol = 7; this.panning = 0xF3;

    this.fsStep = 0;
    this.frameSeqTimer = 0;

    // Overwritten by initAudio() with the AudioContext's actual sample rate (often not
    // 44100) — getting this wrong desyncs sample production from consumption and causes
    // periodic clicking.
    this.sampleRate = 44100;
    this.cyclesPerSample = EMU_CORE_CONFIG.CLOCK_HZ / this.sampleRate;
    this.sampleCounter = 0;

    // Ring buffer feeding the Web Audio callback (producer: emulator loop, consumer: audio thread).
    this.RING_SIZE = 8192;
    this.ringL = new Float32Array(this.RING_SIZE);
    this.ringR = new Float32Array(this.RING_SIZE);
    this.writePos = 0; this.readPos = 0; this.available = 0;
    this.lastL = 0; this.lastR = 0; // last sample played, for a graceful underrun fade-out

    // Running sums used to *average* each channel's DAC output over every raw cycle since
    // the last output sample, rather than point-sampling it. At speed > 1x many more cycles
    // pass per output sample, so this box-filter averaging avoids aliasing into the wrong pitch.
    this.accL = 0; this.accR = 0; this.accCycles = 0;

    // Per-channel raw DAC history for the oscilloscope UI, independent of the mixed
    // ringL/ringR buffer so each channel's waveform can be inspected on its own.
    this.SCOPE_SIZE = 512;
    this.scopeCh1 = new Float32Array(this.SCOPE_SIZE);
    this.scopeCh2 = new Float32Array(this.SCOPE_SIZE);
    this.scopeCh3 = new Float32Array(this.SCOPE_SIZE);
    this.scopeCh4 = new Float32Array(this.SCOPE_SIZE);
    this.scopeWritePos = 0;

    this.audioCtx = null;
    this.scriptNode = null;
    this.masterGain = null;
    this.muted = false;
    this.chMuted = [false, false, false, false]; // per-channel mute (oscilloscope UI), indexed CH1-CH4
    this.volume = 0.5;
  }

  newSquareState() {
    return { enabled: false, dacEnabled: false, duty: 2, dutyStep: 0, frequency: 0, freqTimer: 0,
             lengthCounter: 0, lengthEnabled: false,
             envVolume: 0, envDirection: 0, envPeriod: 0, envTimer: 0, volume: 0 };
  }

  // Ch1 is a square channel plus a frequency-sweep unit the others don't have.
  newCh1State() {
    return Object.assign(this.newSquareState(), {
      sweepPeriodReg: 0, sweepDirection: 0, sweepShift: 0,
      sweepTimer: 0, sweepEnabled: false, shadowFreq: 0,
    });
  }

  /* ---- save state ----
     The ring buffer, AudioContext, and other Web Audio plumbing are runtime/output-device
     concerns, not console state — left out and reset to a clean, silent buffer on restore. */
  serialize() {
    return {
      enabled: this.enabled,
      ch1: { ...this.ch1 }, ch2: { ...this.ch2 }, ch3: { ...this.ch3 }, ch4: { ...this.ch4 },
      waveRAM: u8ToBase64(this.waveRAM), regs: u8ToBase64(this.regs),
      leftVol: this.leftVol, rightVol: this.rightVol, panning: this.panning,
      fsStep: this.fsStep, frameSeqTimer: this.frameSeqTimer, sampleCounter: this.sampleCounter,
    };
  }
  deserialize(s) {
    this.enabled = s.enabled;
    Object.assign(this.ch1, s.ch1);
    Object.assign(this.ch2, s.ch2);
    Object.assign(this.ch3, s.ch3);
    Object.assign(this.ch4, s.ch4);
    this.waveRAM.set(base64ToU8(s.waveRAM));
    this.regs.set(base64ToU8(s.regs));
    this.leftVol = s.leftVol; this.rightVol = s.rightVol; this.panning = s.panning;
    this.fsStep = s.fsStep; this.frameSeqTimer = s.frameSeqTimer; this.sampleCounter = s.sampleCounter;
    this.writePos = 0; this.readPos = 0; this.available = 0; this.lastL = 0; this.lastR = 0;
  }

  /* ---- Web Audio plumbing ---- */
  // ScriptProcessorNode (rather than AudioWorklet) keeps this synchronous and inline,
  // with no separate module file to load.
  initAudio() {
    if (this.audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.audioCtx = new Ctx();

    // Use the real hardware/OS sample rate rather than assuming 44100.
    this.sampleRate = this.audioCtx.sampleRate;
    this.cyclesPerSample = EMU_CORE_CONFIG.CLOCK_HZ / this.sampleRate;

    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.volume;
    this.masterGain.connect(this.audioCtx.destination);

    const bufferSize = 2048;
    this.scriptNode = this.audioCtx.createScriptProcessor(bufferSize, 0, 2);
    this.scriptNode.onaudioprocess = (e) => {
      const left = e.outputBuffer.getChannelData(0);
      const right = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < bufferSize; i++) {
        if (this.available > 0) {
          this.lastL = this.ringL[this.readPos];
          this.lastR = this.ringR[this.readPos];
          this.readPos = (this.readPos + 1) % this.RING_SIZE;
          this.available--;
        } else {
          this.lastL *= 0.9; this.lastR *= 0.9; // underrun: decay toward silence, not a hard click
        }
        left[i] = this.lastL; right[i] = this.lastR;
      }
    };
    this.scriptNode.connect(this.masterGain);
  }

  resume() { if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume(); }
  suspend() { if (this.audioCtx && this.audioCtx.state === 'running') this.audioCtx.suspend(); }
  setVolume(v) { this.volume = v; if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : v; }
  setMuted(m) { this.muted = m; if (this.masterGain) this.masterGain.gain.value = m ? 0 : this.volume; }

  pushSample(l, r) {
    this.ringL[this.writePos] = l; this.ringR[this.writePos] = r;
    this.writePos = (this.writePos + 1) % this.RING_SIZE;
    if (this.available < this.RING_SIZE) this.available++;
    else this.readPos = (this.readPos + 1) % this.RING_SIZE; // full: drop oldest sample
  }

  /* ---- register read/write (mapped from MMU.readIO/writeIO for 0xFF10-0xFF3F) ---- */
  read(reg) {
    if (reg === 0xFF26) {
      return 0x70 | (this.enabled ? 0x80 : 0) |
        (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) |
        (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
    }
    if (reg >= 0xFF30 && reg <= 0xFF3F) return this.waveRAM[reg - 0xFF30];
    const off = reg - 0xFF10;
    const mask = APU_IO_MASK[reg] !== undefined ? APU_IO_MASK[reg] : 0xFF;
    return this.regs[off] | mask;
  }

  write(reg, val) {
    val &= 0xFF;
    if (reg === 0xFF26) {
      const wasEnabled = this.enabled;
      this.enabled = !!(val & 0x80);
      if (wasEnabled && !this.enabled) this.powerOff();
      else if (!wasEnabled && this.enabled) this.powerOn();
      return;
    }
    if (reg >= 0xFF30 && reg <= 0xFF3F) { this.waveRAM[reg - 0xFF30] = val; return; } // wave RAM always writable
    if (!this.enabled) return; // powered off: writes to FF10-FF25 are ignored

    const off = reg - 0xFF10;
    this.regs[off] = val;
    switch (reg) {
      case 0xFF10: this.ch1.sweepPeriodReg = (val >> 4) & 7; this.ch1.sweepDirection = (val >> 3) & 1; this.ch1.sweepShift = val & 7; break;
      case 0xFF11: this.ch1.duty = (val >> 6) & 3; this.ch1.lengthCounter = 64 - (val & 0x3F); break;
      case 0xFF12:
        this.ch1.envVolume = (val >> 4) & 0xF; this.ch1.envDirection = (val >> 3) & 1; this.ch1.envPeriod = val & 7;
        this.ch1.dacEnabled = (val & 0xF8) !== 0; if (!this.ch1.dacEnabled) this.ch1.enabled = false;
        break;
      case 0xFF13: this.ch1.frequency = (this.ch1.frequency & 0x700) | val; break;
      case 0xFF14:
        this.ch1.frequency = (this.ch1.frequency & 0xFF) | ((val & 7) << 8);
        this.ch1.lengthEnabled = !!(val & 0x40);
        if (val & 0x80) this.triggerCh1();
        break;

      case 0xFF16: this.ch2.duty = (val >> 6) & 3; this.ch2.lengthCounter = 64 - (val & 0x3F); break;
      case 0xFF17:
        this.ch2.envVolume = (val >> 4) & 0xF; this.ch2.envDirection = (val >> 3) & 1; this.ch2.envPeriod = val & 7;
        this.ch2.dacEnabled = (val & 0xF8) !== 0; if (!this.ch2.dacEnabled) this.ch2.enabled = false;
        break;
      case 0xFF18: this.ch2.frequency = (this.ch2.frequency & 0x700) | val; break;
      case 0xFF19:
        this.ch2.frequency = (this.ch2.frequency & 0xFF) | ((val & 7) << 8);
        this.ch2.lengthEnabled = !!(val & 0x40);
        if (val & 0x80) this.triggerCh2();
        break;

      case 0xFF1A: this.ch3.dacEnabled = !!(val & 0x80); if (!this.ch3.dacEnabled) this.ch3.enabled = false; break;
      case 0xFF1B: this.ch3.lengthCounter = 256 - val; break;
      case 0xFF1C: this.ch3.volumeShift = (val >> 5) & 3; break;
      case 0xFF1D: this.ch3.frequency = (this.ch3.frequency & 0x700) | val; break;
      case 0xFF1E:
        this.ch3.frequency = (this.ch3.frequency & 0xFF) | ((val & 7) << 8);
        this.ch3.lengthEnabled = !!(val & 0x40);
        if (val & 0x80) this.triggerCh3();
        break;

      case 0xFF20: this.ch4.lengthCounter = 64 - (val & 0x3F); break;
      case 0xFF21:
        this.ch4.envVolume = (val >> 4) & 0xF; this.ch4.envDirection = (val >> 3) & 1; this.ch4.envPeriod = val & 7;
        this.ch4.dacEnabled = (val & 0xF8) !== 0; if (!this.ch4.dacEnabled) this.ch4.enabled = false;
        break;
      case 0xFF22: this.ch4.clockShift = (val >> 4) & 0xF; this.ch4.widthMode = (val >> 3) & 1; this.ch4.divisorCode = val & 7; break;
      case 0xFF23:
        this.ch4.lengthEnabled = !!(val & 0x40);
        if (val & 0x80) this.triggerCh4();
        break;

      case 0xFF24: this.leftVol = (val >> 4) & 7; this.rightVol = val & 7; break; // VIN-to-speaker bits ignored
      case 0xFF25: this.panning = val; break;
    }
  }

  powerOff() {
    // Real hardware clears everything except wave RAM.
    this.regs.fill(0);
    this.ch1 = this.newCh1State();
    this.ch2 = this.newSquareState();
    Object.assign(this.ch4, { enabled: false, dacEnabled: false, envVolume: 0, envDirection: 0, envPeriod: 0, clockShift: 0, widthMode: 0, divisorCode: 0 });
    this.leftVol = 7; this.rightVol = 7; this.panning = 0;
  }
  powerOn() { this.fsStep = 0; this.frameSeqTimer = 0; this.ch1.dutyStep = 0; this.ch2.dutyStep = 0; }

  // Sets every register/state field the way the boot ROM would leave it just before a game starts.
  reset() {
    this.regs.fill(0); this.waveRAM.fill(0);
    this.ch1 = this.newCh1State();
    this.ch2 = this.newSquareState();
    this.ch3 = { enabled: false, dacEnabled: false, frequency: 0, freqTimer: 0, lengthCounter: 0, lengthEnabled: false, volumeShift: 0, samplePos: 0 };
    this.ch4 = { enabled: false, dacEnabled: false, lengthCounter: 0, lengthEnabled: false,
                 envVolume: 0, envDirection: 0, envPeriod: 0, envTimer: 0, volume: 0,
                 clockShift: 0, widthMode: 0, divisorCode: 0, freqTimer: 8, lfsr: 0x7FFF };
    this.fsStep = 0; this.frameSeqTimer = 0; this.sampleCounter = 0;
    this.enabled = false;

    this.write(0xFF26, 0x80); // power on first, or the writes below would be ignored
    this.write(0xFF10, 0x80); this.write(0xFF11, 0xBF); this.write(0xFF12, 0xF3); this.write(0xFF14, 0xBF);
    this.write(0xFF16, 0x3F); this.write(0xFF17, 0x00); this.write(0xFF19, 0xBF);
    this.write(0xFF1A, 0x7F); this.write(0xFF1B, 0xFF); this.write(0xFF1C, 0x9F); this.write(0xFF1E, 0xBF);
    this.write(0xFF20, 0xFF); this.write(0xFF21, 0x00); this.write(0xFF22, 0x00); this.write(0xFF23, 0xBF);
    this.write(0xFF24, 0x77); this.write(0xFF25, 0xF3);

    // Those NR14/19/1E/23 writes also trigger each channel for real. Real hardware's boot
    // chime has already decayed to silence by the time a game runs, so mute what the
    // trigger just started, keeping only the harmless register values.
    this.ch1.enabled = false;
    this.ch2.enabled = false;
    this.ch3.enabled = false;
    this.ch4.enabled = false;
  }

  /* ---- channel triggers (NRx4 bit 7 write) ---- */
  noteTrigger() {
    const fs = this.emulator.frameStats;
    fs.apuTriggers++;
    if (this.emulator.trackAccess) fs.events.push({ line: this.emulator.ppu.ly, kind: 'apu' });
  }
  triggerCh1() {
    this.noteTrigger();
    this.ch1.enabled = this.ch1.dacEnabled;
    if (this.ch1.lengthCounter === 0) this.ch1.lengthCounter = 64;
    this.ch1.freqTimer = (2048 - this.ch1.frequency) * 4;
    this.ch1.envTimer = this.ch1.envPeriod || 8;
    this.ch1.volume = this.ch1.envVolume;
    this.ch1.shadowFreq = this.ch1.frequency;
    this.ch1.sweepTimer = this.ch1.sweepPeriodReg || 8;
    this.ch1.sweepEnabled = this.ch1.sweepPeriodReg > 0 || this.ch1.sweepShift > 0;
    if (this.ch1.sweepShift > 0) this.calcSweep(); // immediate overflow check
  }
  triggerCh2() {
    this.noteTrigger();
    this.ch2.enabled = this.ch2.dacEnabled;
    if (this.ch2.lengthCounter === 0) this.ch2.lengthCounter = 64;
    this.ch2.freqTimer = (2048 - this.ch2.frequency) * 4;
    this.ch2.envTimer = this.ch2.envPeriod || 8;
    this.ch2.volume = this.ch2.envVolume;
  }
  triggerCh3() {
    this.noteTrigger();
    this.ch3.enabled = this.ch3.dacEnabled;
    if (this.ch3.lengthCounter === 0) this.ch3.lengthCounter = 256;
    this.ch3.freqTimer = (2048 - this.ch3.frequency) * 2;
    this.ch3.samplePos = 0;
  }
  triggerCh4() {
    this.noteTrigger();
    this.ch4.enabled = this.ch4.dacEnabled;
    if (this.ch4.lengthCounter === 0) this.ch4.lengthCounter = 64;
    this.ch4.envTimer = this.ch4.envPeriod || 8;
    this.ch4.volume = this.ch4.envVolume;
    this.ch4.lfsr = 0x7FFF;
    this.ch4.freqTimer = APU_NOISE_DIVISORS[this.ch4.divisorCode] << this.ch4.clockShift;
  }

  calcSweep() {
    let newFreq = this.ch1.shadowFreq >> this.ch1.sweepShift;
    newFreq = this.ch1.sweepDirection ? this.ch1.shadowFreq - newFreq : this.ch1.shadowFreq + newFreq;
    if (newFreq > 2047) this.ch1.enabled = false;
    return newFreq;
  }

  /* ---- frame sequencer: 512 Hz clock feeding length/sweep/envelope ---- */
  clockFrameSequencer() {
    this.fsStep = (this.fsStep + 1) & 7;
    if (this.fsStep % 2 === 0) this.clockLength();
    if (this.fsStep === 2 || this.fsStep === 6) this.clockSweep();
    if (this.fsStep === 7) this.clockEnvelope();
  }
  clockLength() {
    [this.ch1, this.ch2, this.ch3, this.ch4].forEach(ch => {
      if (ch.lengthEnabled && ch.lengthCounter > 0) { ch.lengthCounter--; if (ch.lengthCounter === 0) ch.enabled = false; }
    });
  }
  clockSweep() {
    const ch = this.ch1;
    if (ch.sweepTimer > 0) {
      ch.sweepTimer--;
      if (ch.sweepTimer === 0) {
        ch.sweepTimer = ch.sweepPeriodReg || 8;
        if (ch.sweepEnabled && ch.sweepPeriodReg > 0) {
          const newFreq = this.calcSweep();
          if (newFreq <= 2047 && ch.sweepShift > 0) {
            ch.shadowFreq = newFreq; ch.frequency = newFreq;
            this.calcSweep(); // second overflow check per hardware behavior
          }
        }
      }
    }
  }
  clockEnvelope() {
    [this.ch1, this.ch2, this.ch4].forEach(ch => {
      if (ch.envPeriod === 0) return;
      ch.envTimer--;
      if (ch.envTimer <= 0) {
        ch.envTimer = ch.envPeriod;
        if (ch.envDirection === 1 && ch.volume < 15) ch.volume++;
        else if (ch.envDirection === 0 && ch.volume > 0) ch.volume--;
      }
    });
  }

  /* ---- per-channel frequency timers, stepped every CPU instruction ---- */
  stepSquare(ch, cycles) {
    ch.freqTimer -= cycles;
    while (ch.freqTimer <= 0) { ch.freqTimer += (2048 - ch.frequency) * 4; ch.dutyStep = (ch.dutyStep + 1) & 7; }
  }
  stepWave(cycles) {
    this.ch3.freqTimer -= cycles;
    while (this.ch3.freqTimer <= 0) { this.ch3.freqTimer += (2048 - this.ch3.frequency) * 2; this.ch3.samplePos = (this.ch3.samplePos + 1) & 31; }
  }
  stepNoise(cycles) {
    const period = APU_NOISE_DIVISORS[this.ch4.divisorCode] << this.ch4.clockShift;
    this.ch4.freqTimer -= cycles;
    while (this.ch4.freqTimer <= 0) {
      this.ch4.freqTimer += period;
      const xorBit = (this.ch4.lfsr & 1) ^ ((this.ch4.lfsr >> 1) & 1);
      this.ch4.lfsr = (this.ch4.lfsr >> 1) | (xorBit << 14);
      if (this.ch4.widthMode) this.ch4.lfsr = (this.ch4.lfsr & ~0x40) | (xorBit << 6);
    }
  }

  getWaveSample() {
    const byte = this.waveRAM[this.ch3.samplePos >> 1];
    return (this.ch3.samplePos & 1) === 0 ? (byte >> 4) & 0xF : byte & 0xF;
  }

  step(cycles) {
    this.frameSeqTimer += cycles;
    while (this.frameSeqTimer >= 8192) { this.frameSeqTimer -= 8192; this.clockFrameSequencer(); }

    this.stepSquare(this.ch1, cycles);
    this.stepSquare(this.ch2, cycles);
    this.stepWave(cycles);
    this.stepNoise(cycles);

    this.accumulateMix(cycles);

    // The emulated frame clock and the audio hardware's clock aren't perfectly locked
    // together, so tiny timing differences accumulate over minutes of play. Nudge the
    // effective sample period by up to +-1% based on ring-buffer fill, gently pulling it
    // back toward half-full instead of drifting into underruns or overflows.
    const fillRatio = this.available / this.RING_SIZE;
    const correction = 1 + (fillRatio - 0.5) * 0.02;

    // Scale the target by emulator.speed so sample production stays paced to real time —
    // otherwise the speed slider (e.g. 10%) would starve the ring buffer, since cycles
    // would arrive far slower than the audio callback drains them.
    const targetCyclesPerSample = this.cyclesPerSample * correction * this.emulator.speed;

    this.sampleCounter += cycles;
    while (this.sampleCounter >= targetCyclesPerSample) { this.sampleCounter -= targetCyclesPerSample; this.emitSample(); }
  }

  // Computes each channel's instantaneous DAC output (-1..1) and the mixed/panned/volumed
  // left+right instant, folding left*cycles / right*cycles into the running-sum accumulators.
  accumulateMix(cycles) {
    if (!this.enabled) {
      this._lastA1 = this._lastA2 = this._lastA3 = this._lastA4 = 0;
      this.accCycles += cycles;
      return;
    }

    const amp1 = (this.ch1.enabled && !this.chMuted[0]) ? APU_DUTY_TABLE[this.ch1.duty][this.ch1.dutyStep] * this.ch1.volume : 0;
    const amp2 = (this.ch2.enabled && !this.chMuted[1]) ? APU_DUTY_TABLE[this.ch2.duty][this.ch2.dutyStep] * this.ch2.volume : 0;
    let amp3 = 0;
    if (this.ch3.enabled && !this.chMuted[2] && this.ch3.volumeShift > 0) amp3 = this.getWaveSample() >> (this.ch3.volumeShift - 1);
    const amp4 = (this.ch4.enabled && !this.chMuted[3]) ? ((~this.ch4.lfsr) & 1) * this.ch4.volume : 0;

    const dac = v => (v / 7.5) - 1; // each channel's 4-bit DAC maps 0-15 to roughly -1..1
    const a1 = dac(amp1), a2 = dac(amp2), a3 = dac(amp3), a4 = dac(amp4);
    this._lastA1 = a1; this._lastA2 = a2; this._lastA3 = a3; this._lastA4 = a4;

    let left = 0, right = 0;
    if (this.panning & 0x01) right += a1;
    if (this.panning & 0x02) right += a2;
    if (this.panning & 0x04) right += a3;
    if (this.panning & 0x08) right += a4;
    if (this.panning & 0x10) left += a1;
    if (this.panning & 0x20) left += a2;
    if (this.panning & 0x40) left += a3;
    if (this.panning & 0x80) left += a4;

    left = (left / 4) * ((this.leftVol + 1) / 8);
    right = (right / 4) * ((this.rightVol + 1) / 8);

    this.accL += left * cycles;
    this.accR += right * cycles;
    this.accCycles += cycles;
  }

  // Emits one output sample: the average mixed level since the last emitted sample. This
  // acts as a simple anti-aliasing low-pass, which matters most at speed > 1x, where each
  // output sample spans many more raw cycles than at 1x.
  emitSample() {
    const left = this.accCycles > 0 ? this.accL / this.accCycles : 0;
    const right = this.accCycles > 0 ? this.accR / this.accCycles : 0;
    this.pushSample(left, right);
    this.pushScopeSample(this._lastA1 || 0, this._lastA2 || 0, this._lastA3 || 0, this._lastA4 || 0);
    this.accL = 0; this.accR = 0; this.accCycles = 0;
  }

  // Records this instant's raw per-channel DAC output for the oscilloscope UI.
  pushScopeSample(a1, a2, a3, a4) {
    const i = this.scopeWritePos;
    this.scopeCh1[i] = a1; this.scopeCh2[i] = a2; this.scopeCh3[i] = a3; this.scopeCh4[i] = a4;
    this.scopeWritePos = (i + 1) % this.SCOPE_SIZE;
  }
}

/* ================================= 7. Emulator (glue) ==================================== */

class Emulator {
  static CYCLES_PER_FRAME = EMU_CORE_CONFIG.FRAME.CYCLES_PER_FRAME; // 154 scanlines x 456 T-cycles

  constructor(canvas) {
    this.mmu = new MMU(this);
    this.cpu = new CPU(this.mmu);
    this.ppu = new PPU(this);
    this.timer = new Timer(this);
    this.joypad = new Joypad(this);
    this.apu = new APU(this);

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.imageData = this.ctx.createImageData(EMU_CORE_CONFIG.SCREEN.WIDTH, EMU_CORE_CONFIG.SCREEN.HEIGHT);

    this.running = false;
    this.onRunStateChange = null; // called with the new boolean whenever _setRunning() flips this.running
    this.frameReady = false;
    this._rafId = null;
    this.markCurrentLine = false;
    this.layerTint = false;

    this.trackAccess = true;  // gates frame-activity/interrupt-log bookkeeping
    this.trackMemMap = false; // gates per-memory-access bookkeeping (Memory Map / MBC Banking views)
    this.trackTrace = false;  // gates per-instruction bookkeeping (Execution Trace view)

    this.speed = 1;          // 0.1-1.0 multiplier applied to how fast emulated frames advance
    this._lastTime = null;   // real-time timestamp of the previous loop() tick
    this._frameAcc = 0;      // accumulated (speed-scaled) ms available to spend on emulated frames

    // Rendering (canvas draw + debug panel refresh) is paced against real elapsed time,
    // separately from _frameAcc, so draws stay capped at ~60/s regardless of emulation
    // speed or display refresh rate.
    this._lastRenderTime = 0;

    this._fpsFrames = 0;
    this._fpsLast = performance.now();

    this.romTitle = null; // set in loadROM; used to key save states and warn on mismatched loads

    /* ---- step / breakpoint debugging ---- */
    this.breakpointPC = null;
    this.breakpointOpcode = null;
    this.breakHitReason = null;
    this._bpSkipFirstMatch = false; // avoids instantly re-triggering a PC breakpoint we're already sitting on
    this.onBreakpointHit = null;

    /* ---- rewind: in-memory ring buffer of full state snapshots, taken every
       REWIND_SNAPSHOT_INTERVAL_SECONDS of emulated time, holding up to REWIND_MAX_SNAPSHOTS.
       Lives only in a plain array — never touches localStorage or the save-state slots, so
       it vanishes on reload. ---- */
    this.REWIND_MAX_SNAPSHOTS = 10;
    this.REWIND_SNAPSHOT_INTERVAL_SECONDS = 2;
    this.rewindBuffer = [];  // oldest first, most recent last
    this.rewindFrameAcc = 0; // frames since the last snapshot

    /* ---- frame activity: per-frame counts of hardware events (instructions, interrupts,
       sprites, DMA, banking, APU triggers), for the Frame Activity panel. ---- */
    this.FRAME_STATS_HISTORY = 60; // ~1 second at 59.73fps
    this.frameStatsHistory = [];
    this.frameCounter = 0;
    this.frameStats = this.newFrameStats();

    /* ---- execution trace: ring buffer of the last TRACE_SIZE fetched instructions ---- */
    this.TRACE_SIZE = 500;
    this.traceAddr = new Uint16Array(this.TRACE_SIZE);
    this.traceB0 = new Uint8Array(this.TRACE_SIZE);
    this.traceB1 = new Uint8Array(this.TRACE_SIZE);
    this.traceB2 = new Uint8Array(this.TRACE_SIZE);
    this.traceDiff = new Array(this.TRACE_SIZE).fill(''); // "A: 0x00→0x05 Z:1→0" style string per entry
    this.traceWritePos = 0;
    this.traceFilled = 0;

    /* ---- interrupt log: last INTERRUPT_LOG_SIZE interrupts actually dispatched (not just
       requested), for the Interrupts debug panel. ---- */
    this.INTERRUPT_LOG_SIZE = 60;
    this.interruptLog = []; // oldest first; each entry { seq, frame, bit, pcBefore }
    this.interruptSeq = 0;
  }

  // Fresh accumulator for one frame's hardware activity. spritesPerLine is indexed by
  // scanline; events is an ordered { line, kind } list used by the Frame Activity strip.
  newFrameStats() {
    return {
      index: this.frameCounter,
      instructions: 0,
      interrupts: { vblank: 0, stat: 0, timer: 0, serial: 0, joypad: 0 },
      events: [],
      dma: 0,
      bankSwitches: 0,
      apuTriggers: 0,
      spritesPerLine: new Uint8Array(EMU_CORE_CONFIG.SCREEN.HEIGHT),
      spritesTotal: 0,
      spritesMaxLine: 0,
    };
  }

  requestInterrupt(bit) {
    this.mmu.io[0x0F] |= (1 << bit);
    const kind = INTERRUPT_KIND_NAMES[bit];
    if (kind) {
      this.frameStats.interrupts[kind]++;
      if (this.trackAccess) this.frameStats.events.push({ line: this.ppu.ly, kind: 'int-' + kind });
    }
  }

  // Called by CPU.tryDispatchInterrupt() the instant it actually dispatches (pushes PC and
  // jumps to the handler) — not just when the IF bit is set.
  logInterruptServiced(bit, pcBefore) {
    this.interruptLog.push({ seq: this.interruptSeq++, frame: this.frameCounter, bit, pcBefore });
    if (this.interruptLog.length > this.INTERRUPT_LOG_SIZE) this.interruptLog.shift();
  }

  loadROM(bytes) {
    this.mmu.loadROM(bytes);
    this.cpu.reset();
    this.ppu.modeClock = 0; this.ppu.mode = 2; this.ppu.windowLineCounter = 0;
    this.timer.divCounter = 0; this.timer.divReg = 0; this.timer.timaCounter = 0; this.timer.tima = 0;
    this.apu.reset();

    this.frameStatsHistory = [];
    this.frameCounter = 0;
    this.frameStats = this.newFrameStats();
    this.rewindBuffer = [];
    this.rewindFrameAcc = 0;
    this.interruptLog = [];
    this.interruptSeq = 0;

    let title = '';
    for (let i = 0x134; i < 0x144; i++) {
      const c = bytes[i];
      if (c === 0) break;
      if (c >= 32 && c < 127) title += String.fromCharCode(c);
    }
    this.romTitle = title.trim() || 'Unknown';
  }

  /* ---- save state ----
     A JSON-serializable snapshot of every emulated component. The cartridge ROM itself is
     intentionally excluded (can be multiple MB, and the user already has the file). */
  getSaveState() {
    return {
      format: 'jsgb-savestate',
      version: 1,
      savedAt: new Date().toISOString(),
      romTitle: this.romTitle,
      cpu: this.cpu.serialize(),
      mmu: this.mmu.serialize(),
      ppu: this.ppu.serialize(),
      timer: this.timer.serialize(),
      joypad: this.joypad.serialize(),
      apu: this.apu.serialize(),
    };
  }

  loadSaveState(state) {
    if (!state || state.format !== 'jsgb-savestate' || !state.cpu || !state.mmu) {
      throw new Error('This does not look like a valid save state file.');
    }
    this.cpu.deserialize(state.cpu);
    this.mmu.deserialize(state.mmu);
    this.ppu.deserialize(state.ppu);
    this.timer.deserialize(state.timer);
    this.joypad.deserialize(state.joypad);
    this.apu.deserialize(state.apu);
  }

  // Runs one CPU instruction (or one HALT tick) and steps the other components the same
  // number of T-cycles, recording it into the execution trace. Shared by the continuous
  // runFrame() loop and the single-step debugger.
  stepInstruction() {
    // A PC breakpoint fires the moment execution is about to fetch the opcode at that address.
    if (this.breakpointPC !== null && this.cpu.PC === this.breakpointPC) {
      if (this._bpSkipFirstMatch) { this._bpSkipFirstMatch = false; }
      else { this.triggerBreakpoint(`PC reached ${hex16(this.breakpointPC)}`); return 0; }
    }

    const pcBefore = this.cpu.PC;
    const wasHalted = this.cpu.halted;
    const tracking = this.trackTrace; // gates the trace snapshot/diff work below
    let opcode = null;
    let traceIndex = -1;
    let regsBefore = null;
    if (!wasHalted) {
      // peek8, not read8: this is an inspection read for breakpoint/trace bookkeeping, not
      // the CPU's real memory access (cpu.step()'s own fetch8() below is the real one).
      opcode = this.mmu.peek8(pcBefore);
      if (tracking) {
        regsBefore = this.snapshotRegs();
        traceIndex = this.pushTrace(pcBefore, opcode, this.mmu.peek8((pcBefore + 1) & 0xFFFF), this.mmu.peek8((pcBefore + 2) & 0xFFFF));
      }
    }

    const cycles = this.cpu.step();
    const budgetCycles = this.stepHardware(cycles);

    if (!wasHalted && tracking) {
      this.traceDiff[traceIndex] = this.diffRegs(regsBefore, this.snapshotRegs());
    }

    if (!wasHalted && this.breakpointOpcode !== null && opcode === this.breakpointOpcode) {
      this.triggerBreakpoint(`opcode ${hex8(this.breakpointOpcode)} executed at ${hex16(pcBefore)}`);
    }
    return budgetCycles;
  }

  // Feeds the T-cycles one CPU step took to the PPU/timer/APU, and returns how many cycles
  // that step counts against the per-frame budget runFrame() uses. Its own method so a CGB
  // subclass can override it: in double-speed mode the CPU burns T-cycles twice as fast, but
  // PPU/APU real-time behavior must not speed up, so they need half as many cycles fed in.
  stepHardware(cycles) {
    this.ppu.step(cycles);
    this.timer.step(cycles);
    this.apu.step(cycles);
    return cycles;
  }

  runFrame() {
    this.frameStats = this.newFrameStats();
    let cyclesThisFrame = 0;
    while (cyclesThisFrame < Emulator.CYCLES_PER_FRAME) {
      const cycles = this.stepInstruction();
      this.frameStats.instructions++;
      if (!this.running) return; // a breakpoint fired mid-frame; stop immediately
      cyclesThisFrame += cycles;
    }
    this.frameStatsHistory.push(this.frameStats);
    if (this.frameStatsHistory.length > this.FRAME_STATS_HISTORY) this.frameStatsHistory.shift();
    this.frameCounter++;

    this.rewindFrameAcc++;
    const rewindIntervalFrames = Math.round(this.REWIND_SNAPSHOT_INTERVAL_SECONDS * 59.73);
    if (this.rewindFrameAcc >= rewindIntervalFrames) {
      this.rewindFrameAcc = 0;
      this.pushRewindSnapshot();
    }
  }

  // Records a rewind snapshot, capped to REWIND_MAX_SNAPSHOTS (oldest dropped first).
  // In-memory only; never written to localStorage or the save-state slots.
  pushRewindSnapshot() {
    this.rewindBuffer.push(this.getSaveState());
    if (this.rewindBuffer.length > this.REWIND_MAX_SNAPSHOTS) this.rewindBuffer.shift();
  }

  // Steps backward one snapshot (REWIND_SNAPSHOT_INTERVAL_SECONDS of emulated time) per call.
  // Returns false once the buffer is exhausted.
  rewind() {
    if (this.rewindBuffer.length === 0) return false;
    if (this.running) this.pause();
    const state = this.rewindBuffer.pop();
    this.loadSaveState(state);
    this.rewindFrameAcc = 0;
    this.draw();
    refreshDebugTools();
    return true;
  }

  // Pauses and records why, so a breakpoint hit looks the same in the UI as pressing Pause.
  triggerBreakpoint(reason) {
    this._setRunning(false);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.apu.suspend();
    this.breakHitReason = reason;
    this._bpSkipFirstMatch = false;
    if (this.onBreakpointHit) this.onBreakpointHit(reason);
  }

  // Executes exactly one instruction while paused, then redraws immediately.
  stepOne() {
    if (this.running) this.pause();
    this.stepInstruction();
    this.draw();
    refreshDebugTools();
  }

  // Runs until the PPU moves to the next scanline (LY changes), then redraws. Capped at one
  // frame's cycles so it can't spin forever if the LCD is off (LY then never changes).
  stepLine() {
    if (this.running) this.pause();
    this._setRunning(true);
    const startLy = this.ppu.ly;
    let cyclesSpent = 0;
    while (this.ppu.ly === startLy && cyclesSpent < Emulator.CYCLES_PER_FRAME) {
      const cycles = this.stepInstruction();
      if (!this.running) break; // a breakpoint fired mid-step
      cyclesSpent += cycles;
    }
    this._setRunning(false);
    this.draw();
    refreshDebugTools();
  }

  // Runs exactly one full frame (same budget runFrame() uses for normal play), then redraws.
  stepFrame() {
    if (this.running) this.pause();
    this._setRunning(true); // runFrame() bails early if this flips false mid-frame (breakpoint)
    this.runFrame();
    this._setRunning(false);
    this.draw();
    refreshDebugTools();
  }

  // Runs 60 full frames back to back (~1.005s of emulated time), then redraws — a coarse
  // "step frame" for skipping past a slow intro, which also conveniently fills the Frame
  // Activity ring buffer (60 entries) so every one becomes browsable afterwards.
  stepOneSecond() {
    if (this.running) this.pause();
    this._setRunning(true);
    for (let i = 0; i < 60; i++) {
      this.runFrame();
      if (!this.running) break; // a breakpoint fired mid-frame
    }
    this._setRunning(false);
    this.draw();
    refreshDebugTools();
  }

  // Resumes continuous execution, auto-pausing the moment PC reaches pcTarget and/or
  // opcodeTarget is fetched. Either may be null to leave it unset.
  runToBreakpoint(pcTarget, opcodeTarget) {
    this.breakpointPC = pcTarget;
    this.breakpointOpcode = opcodeTarget;
    this._bpSkipFirstMatch = true; // don't instantly stop if already sitting on a PC match
    this.breakHitReason = null;
    this.start();
  }

  clearBreakpoints() {
    this.breakpointPC = null;
    this.breakpointOpcode = null;
    this.breakHitReason = null;
    this._bpSkipFirstMatch = false;
  }

  pushTrace(addr, b0, b1, b2) {
    const i = this.traceWritePos;
    this.traceAddr[i] = addr; this.traceB0[i] = b0; this.traceB1[i] = b1; this.traceB2[i] = b2;
    this.traceDiff[i] = '';
    this.traceWritePos = (i + 1) % this.TRACE_SIZE;
    if (this.traceFilled < this.TRACE_SIZE) this.traceFilled++;
    return i;
  }

  // Snapshot of everything an instruction could plausibly change, used to compute the
  // before/after diff shown in the execution trace.
  snapshotRegs() {
    const c = this.cpu;
    return {
      A: c.A, B: c.B, C: c.C, D: c.D, E: c.E, H: c.H, L: c.L, SP: c.SP,
      fZ: c.flagZ, fN: c.flagN, fH: c.flagH, fC: c.flagC,
    };
  }

  // Compares two snapshots into a compact "A: 0x00→0x05 Z:1→0" string of only the
  // registers/flags that changed — empty string if nothing changed.
  diffRegs(before, after) {
    const parts = [];
    for (const r of ['A', 'B', 'C', 'D', 'E', 'H', 'L']) {
      if (before[r] !== after[r]) parts.push(`${r}:${hex8(before[r])}→${hex8(after[r])}`);
    }
    if (before.SP !== after.SP) parts.push(`SP:${hex16(before.SP)}→${hex16(after.SP)}`);
    for (const [label, key] of [['Z', 'fZ'], ['N', 'fN'], ['H', 'fH'], ['C', 'fC']]) {
      if (before[key] !== after[key]) parts.push(`${label}:${before[key] ? 1 : 0}→${after[key] ? 1 : 0}`);
    }
    return parts.join(' ');
  }

  // Returns trace entries oldest-first. Each includes the ring buffer's physical `idx`,
  // letting callers cache decoded text per slot instead of recomputing it every redraw.
  getTraceEntries() {
    const entries = [];
    const oldest = this.traceFilled < this.TRACE_SIZE ? 0 : this.traceWritePos;
    for (let i = 0; i < this.traceFilled; i++) {
      const idx = (oldest + i) % this.TRACE_SIZE;
      entries.push({ idx, addr: this.traceAddr[idx], b0: this.traceB0[idx], b1: this.traceB1[idx], b2: this.traceB2[idx], diff: this.traceDiff[idx] });
    }
    return entries;
  }

  // Single choke point for flipping this.running. Fires onRunStateChange only on an actual
  // transition, so UI code can hook play/pause boundaries instead of polling.
  _setRunning(running) {
    if (this.running === running) return;
    this.running = running;
    if (this.onRunStateChange) this.onRunStateChange(running);
  }

  start() {
    if (this.running) return;
    this._setRunning(true);
    this._lastTime = null;
    this._frameAcc = 0;
    this.apu.initAudio(); // must happen inside a user gesture (click/drop), which start() always is
    this.apu.resume();
    this.loop(performance.now());
  }
  pause() { this._setRunning(false); if (this._rafId) cancelAnimationFrame(this._rafId); this.apu.suspend(); }

  // Paces emulated frames against real elapsed time, scaled by this.speed (1 = normal,
  // 0.1 = 10%, etc). An accumulator (rather than "one frame per rAF tick") means slowing
  // down actually slows the game, not just the frame counter.
  loop(now) {
    if (!this.running) return;
    if (typeof now !== 'number') now = performance.now();
    if (this._lastTime === null) this._lastTime = now;
    let elapsed = now - this._lastTime;
    this._lastTime = now;
    elapsed = Math.min(elapsed, 200); // clamp so a backgrounded/stalled tab doesn't spiral

    const FRAME_MS = 1000 / 59.73;
    this._frameAcc += elapsed * this.speed;

    let framesRun = 0;
    while (this._frameAcc >= FRAME_MS && framesRun < 8) {
      this.runFrame();
      if (!this.running) return; // a breakpoint fired mid-frame
      this._frameAcc -= FRAME_MS;
      framesRun++;
    }

    if (framesRun > 0) {
      // Cap actual rendering to ~60/s with a real-time gate, independent of _frameAcc —
      // otherwise draws would fire near a high-refresh display's native rate at speed > 1x,
      // even though the game itself only produces a new frame every ~16.74ms of emulated time.
      const RENDER_MS = 1000 / 60;
      if (now - this._lastRenderTime >= RENDER_MS - 1) { // -1ms slack absorbs rAF jitter
        this._lastRenderTime = now;
        this.draw();
        this._fpsFrames++; // counts renders, not emulated frames, so the fps label stays ~60 even at 2x/3x/4x speed
        refreshDebugTools();
      }
    }
    if (now - this._fpsLast >= 1000) {
      document.getElementById('fps').textContent = this._fpsFrames + ' fps';
      this._fpsFrames = 0; this._fpsLast = now;
    }
    this._rafId = requestAnimationFrame((t) => this.loop(t));
  }

  draw() {
    this.imageData.data.set(this.ppu.framebuffer);
    this.ctx.putImageData(this.imageData, 0, 0);
    if (this.markCurrentLine) this.drawCurrentLineMarker();
  }

  // Draws a bright horizontal marker over the PPU's current scanline (LY), so the raster
  // position is visible on the actual screen output too, not just in a debug panel.
  drawCurrentLineMarker() {
    const ly = this.ppu.ly;
    if (ly > EMU_CORE_CONFIG.SCREEN.HEIGHT - 1) return; // VBlank lines are off the visible screen
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 221, 0, 0.55)';
    ctx.fillRect(0, ly, EMU_CORE_CONFIG.SCREEN.WIDTH, 1);
    ctx.strokeStyle = 'rgba(255, 221, 0, 0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, Math.max(0, ly - 0.5), EMU_CORE_CONFIG.SCREEN.WIDTH, 1);
    ctx.restore();
  }
}

function hex8(v) { return '0x' + v.toString(16).padStart(2, '0').toUpperCase(); }
function hex16(v) { return '0x' + v.toString(16).padStart(4, '0').toUpperCase(); }

// Interrupt bit -> name, shared by Emulator.requestInterrupt().
const INTERRUPT_KIND_NAMES = ['vblank', 'stat', 'timer', 'serial', 'joypad'];

// Typed arrays (VRAM, WRAM, etc.) go into save-state JSON as base64 rather than number
// arrays — much smaller, and fast to encode/decode via the browser's atob/btoa.
function u8ToBase64(u8) {
  let binary = '';
  const chunkSize = 0x8000; // avoid overflowing the call stack on String.fromCharCode.apply for large arrays
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToU8(b64) {
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}
