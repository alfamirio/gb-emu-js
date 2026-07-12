/* =========================================================================================
   emu-gb-core.js — JS GB (DMG) emulation core
   -----------------------------------------------------------------------------------------
   The hardware emulation itself: MMU, CPU, PPU, Timer, Joypad, APU, and the Emulator class
   that glues them together and drives the main loop. No DOM/UI code lives here except the
   couple of spots the hardware genuinely needs (the screen <canvas> 2D context the PPU
   blits into, and the Web Audio API the APU writes samples to).

   Depends on: nothing else in this project - safe to load first, and reusable on its own
   (e.g. in a headless test harness or a different UI) without emu-gb-app.js/emu-gb-debug.js.

   One intentional exception: Emulator.loop() calls the global refreshDebugTools(), which is
   defined in emu-gb-debug.js. That's a pre-existing UI hook the debug layer installs into
   the core's main loop - harmless as long as emu-gb-debug.js has loaded by the time the
   emulator is actually running (true for the load order used in index.html), but worth
   knowing about if this file is ever reused standalone.

   Load order: emu-gb-core.js -> emu-gb-app.js -> emu-gb-debug.js (see index.html for why).
   ========================================================================================= */

/* =========================================================================================
   JS GB (DMG) EMULATOR
   -----------------------------------------------------------------------------------------
   This file is organized into seven main pieces, each modeling one real hardware component:

     1. MMU     - the memory map: ROM banking, RAM, VRAM, OAM, I/O registers
     2. CPU     - the LR35902 processor (a Z80 variant): registers, flags, instruction set
     3. PPU     - the pixel processing unit: turns VRAM/OAM into the 160x144 screen image
     4. Timer   - the DIV/TIMA/TMA/TAC timer circuit
     5. Joypad  - button state + the joypad I/O register
     6. APU     - the 4-channel sound generator, output through the Web Audio API
     7. Emulator- glues everything together and drives the main loop

   If you're reading this to learn how a GB works, the CPU section is the best place
   to start: opcodes are decoded the same way the real hardware does (as bit fields), which
   keeps the ~500 instruction/CB-instruction combinations to a very small amount of code.
   ========================================================================================= */

/* ============================== 0. Emulation core config =============================== */
// Every hardware-defined constant the core relies on lives here: clock speed, frame/PPU
// timing, memory-map layout and region sizes, timer periods, sprite limits, palettes, and
// the register/IO state the real boot ROM leaves behind. The classes below (MMU/CPU/PPU/
// Timer/APU/Emulator) read from this object instead of hardcoding these numbers inline, so
// the "what a Game Boy is" values are separate from the "how we emulate it" code, and the
// debug/visualizer UI can reuse the exact same numbers instead of keeping its own copies.
const EMU_CORE_CONFIG = {
  CLOCK_HZ: 4194304, // GB system clock speed, in T-cycles/second

  FRAME: {
    VISIBLE_LINES: 144,   // scanlines that actually draw to the screen
    VBLANK_LINES: 10,     // scanlines 144-153: VBlank
    CYCLES_PER_LINE: 456, // T-cycles per scanline (OAM search + pixel transfer + HBlank)
    get TOTAL_LINES() { return this.VISIBLE_LINES + this.VBLANK_LINES; },        // 154
    get CYCLES_PER_FRAME() { return this.CYCLES_PER_LINE * this.TOTAL_LINES; },  // 70224
  },

  // Fixed-length-per-mode PPU timing model (mode 1/VBlank uses FRAME.CYCLES_PER_LINE instead).
  PPU_MODE_CYCLES: {
    OAM_SEARCH: 80,      // mode 2
    PIXEL_TRANSFER: 172, // mode 3
    HBLANK: 204,         // mode 0
  },

  SCREEN: { WIDTH: 160, HEIGHT: 144 },

  SPRITES: {
    MAX_TOTAL: 40,      // entries in OAM
    MAX_PER_LINE: 10,   // hardware limit: sprites actually drawn on one scanline
    HEIGHT_SMALL: 8,
    HEIGHT_TALL: 16,
  },

  TIMER: {
    TIMA_PERIOD: [1024, 16, 64, 256], // T-cycles per TIMA increment, indexed by TAC[1:0]
    DIV_PERIOD: 256,                  // T-cycles per DIV increment
  },

  OAM_DMA_BYTES: 0xA0,

  // Two selectable four-shade palettes: the classic DMG green tint, and the neutral
  // grayscale used by the Game Boy Pocket's screen.
  PALETTE_GB:  [[155, 188, 15], [139, 172, 15], [48, 98, 48], [15, 56, 15]],
  PALETTE_GBP: [[255, 255, 255], [169, 169, 169], [84, 84, 84], [0, 0, 0]],

  // Layer-tint debug view: each rendering layer gets a distinct color wash.
  LAYER_TINTS: { bg: [255, 90, 90], window: [90, 220, 255], sprite: [140, 255, 110] },
  LAYER_TINT_MIX: 0.4, // 0 = no tint, 1 = solid tint color

  // Memory map: first address *past* each region (i.e. region is [prevEnd, thisEnd)).
  MEMORY: {
    ROM0_END: 0x4000,    // 0x0000-0x3FFF: ROM bank 0
    ROMX_END: 0x8000,    // 0x4000-0x7FFF: switchable ROM bank
    VRAM_END: 0xA000,    // 0x8000-0x9FFF: VRAM
    ERAM_END: 0xC000,    // 0xA000-0xBFFF: cart RAM / MBC2 RAM / MBC3 RTC
    WRAM_END: 0xE000,    // 0xC000-0xDFFF: WRAM
    ECHO_END: 0xFE00,    // 0xE000-0xFDFF: echo of WRAM
    OAM_END: 0xFEA0,     // 0xFE00-0xFE9F: OAM (sprite attribute table)
    UNUSABLE_END: 0xFF00,// 0xFEA0-0xFEFF: unusable
    IO_END: 0xFF80,      // 0xFF00-0xFF7F: I/O registers
    HRAM_END: 0xFFFF,    // 0xFF80-0xFFFE: HRAM
    // 0xFFFF: IE register

    ROM_BANK_SIZE: 0x4000, // size of one switchable ROM bank
    RAM_BANK_SIZE: 0x2000, // size of one switchable cart-RAM bank

    VRAM_SIZE: 0x2000,
    WRAM_SIZE: 0x2000,
    OAM_SIZE: 0xA0,
    HRAM_SIZE: 0x7F,
    IO_SIZE: 0x80,
    CART_RAM_SIZE: 0x20000, // up to 16 banks of 8KB external RAM (MBC5's max)
  },

  // Register/IO values the real boot ROM leaves behind right before a game's code starts.
  BOOT: {
    A: 0x01, B: 0x00, C: 0x13, D: 0x00, E: 0xD8, H: 0x01, L: 0x4D,
    SP: 0xFFFE, PC: 0x0100,
    FLAG_Z: true, FLAG_N: false, FLAG_H: true, FLAG_C: true,
    IO: { P1: 0xCF, IF: 0xE1, LCDC: 0x91, BGP: 0xFC, OBP0: 0xFF, OBP1: 0xFF },
  },
};

/* ============================== 1. MMU (Memory Management Unit) ======================= */

class MMU {
  constructor(emulator) {
    this.emulator = emulator;

    this.rom = new Uint8Array(0);        // raw cartridge ROM file
    this.mbcType = 0;                    // 0 = ROM only, 1 = MBC1, 2 = MBC2, 3 = MBC3, 5 = MBC5
    this.hasRumble = false;              // MBC5+RUMBLE carts mask an extra bit out of the RAM bank register
    this.currentROMBank = 1;
    this.currentRAMBank = 0;
    this.ramEnabled = false;
    this.bankingMode = 0;                // MBC1: 0 = ROM banking mode, 1 = RAM banking mode

    this.cartRAM = new Uint8Array(EMU_CORE_CONFIG.MEMORY.CART_RAM_SIZE); // up to 16 banks of 8KB external RAM (MBC5's max)

    // ---- MBC3 Real Time Clock (RTC) state ----
    // `rtc` holds the "live" counters, which keep advancing (based on wall-clock time)
    // whenever the clock isn't halted. `rtc.latched` is a frozen snapshot that 0xA000-0xBFFF
    // reads actually return - real MBC3 hardware only updates what the CPU can see when the
    // game performs the 0x00-then-0x01 latch write sequence to 0x6000-0x7FFF.
    this.rtc = {
      s: 0, m: 0, h: 0, dl: 0, dh: 0,           // seconds, minutes, hours, day-counter lo/hi+flags
      latched: { s: 0, m: 0, h: 0, dl: 0, dh: 0 },
      lastLatchWrite: 0xFF,                     // tracks the 0x00 -> 0x01 write sequence
      lastRealMs: Date.now(),                   // wall-clock time the live registers are caught up to
    };
    this.rtcSelect = -1; // -1 = 0xA000-0xBFFF maps to cart RAM; 0x08-0x0C = that RTC register instead
    const MEM = EMU_CORE_CONFIG.MEMORY;
    this.vram    = new Uint8Array(MEM.VRAM_SIZE); // 0x8000-0x9FFF
    this.wram    = new Uint8Array(MEM.WRAM_SIZE); // 0xC000-0xDFFF
    this.oam     = new Uint8Array(MEM.OAM_SIZE);  // 0xFE00-0xFE9F (sprite attribute table)
    this.hram    = new Uint8Array(MEM.HRAM_SIZE); // 0xFF80-0xFFFE
    this.io      = new Uint8Array(MEM.IO_SIZE);   // 0xFF00-0xFF7F
    this.ie      = 0;                      // 0xFFFF interrupt enable register

    // ---- live instrumentation for the Memory Map / Banking visualizers (no effect on
    // emulation itself - purely observational state the UI reads on each redraw). ----
    this.accessSeq = 0;                                  // monotonic counter, bumped on every read/write
    this.lastAccess = { addr: 0, region: 'ROM0', type: 'read', seq: 0 }; // mutated in place (avoid per-access GC)
    this.regionLastTouch = { ROM0: 0, ROMX: 0, VRAM: 0, ERAM: 0, WRAM: 0, OAM: 0, UNUSED: 0, IO: 0, HRAM: 0, IE: 0 };
    this.lastBankSwitch = null;                           // { kind, addr, val, romBank, ramBank, t } or null
  }

  // Classifies an address into the same region buckets the Memory Map view draws.
  regionForAddr(addr) {
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROM0_END) return 'ROM0';
    if (addr < MEM.ROMX_END) return 'ROMX';
    if (addr < MEM.VRAM_END) return 'VRAM';
    if (addr < MEM.ERAM_END) return 'ERAM';
    if (addr < MEM.WRAM_END) return 'WRAM';
    if (addr < MEM.ECHO_END) return 'WRAM'; // echo RAM mirrors WRAM
    if (addr < MEM.OAM_END) return 'OAM';
    if (addr < MEM.UNUSABLE_END) return 'UNUSED';
    if (addr < MEM.IO_END) return 'IO';
    if (addr < MEM.HRAM_END) return 'HRAM';
    return 'IE';
  }

  // Records that the CPU just touched `addr` (read or write), for the Memory Map view.
  noteAccess(addr, type) {
    const region = this.regionForAddr(addr);
    this.accessSeq++;
    this.regionLastTouch[region] = this.accessSeq;
    const a = this.lastAccess;
    a.addr = addr; a.region = region; a.type = type; a.seq = this.accessSeq;
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
    else { this.mbcType = 1; this.cartTypeSupported = false; } // unrecognized mapper: fall back to MBC1 behavior, best-effort only
    this.hasRumble = (cartType >= 0x1C && cartType <= 0x1E); // MBC5+RUMBLE variants

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

    // Reset the visualizer instrumentation on every (re)load.
    this.accessSeq = 0;
    this.lastAccess.addr = 0; this.lastAccess.region = 'ROM0'; this.lastAccess.type = 'read'; this.lastAccess.seq = 0;
    for (const k in this.regionLastTouch) this.regionLastTouch[k] = 0;
    this.lastBankSwitch = null;

    // Values the real boot ROM would have left behind by the time a game starts running.
    const bootIO = EMU_CORE_CONFIG.BOOT.IO;
    this.io.fill(0);
    this.io[0x00] = bootIO.P1;   // P1 (joypad)
    this.io[0x0F] = bootIO.IF;   // IF
    this.io[0x40] = bootIO.LCDC; // LCDC
    this.io[0x47] = bootIO.BGP;  // BGP
    this.io[0x48] = bootIO.OBP0; // OBP0
    this.io[0x49] = bootIO.OBP1; // OBP1
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
      // Resume the live clock from "now" using the saved counters rather than trusting the
      // old lastRealMs (the machine's clock may have jumped, or the save may be old) -
      // this avoids a giant one-time catch-up tick immediately after loading a save state.
      this.rtc.lastRealMs = Date.now();
    }
    this.rtcSelect = (s.rtcSelect === undefined) ? -1 : s.rtcSelect;
  }

  read8(addr) {
    addr &= 0xFFFF;
    this.noteAccess(addr, 'read');
    return this.peek8(addr);
  }

  // Same address decoding/mapping as read8 (ROM banking, echo RAM, RTC-mapped registers,
  // I/O side-reads, everything) but WITHOUT recording the access via noteAccess(). Reading
  // a byte just to paint it on a debug panel isn't something the CPU/game actually did, so
  // routing that through read8 would falsely attribute it to CPU activity and spam the
  // Memory Map visualizer's "last access" flash. Used by the RAM Editor's live refresh and
  // available to any other inspector that needs a read8-equivalent without that side effect.
  peek8(addr) {
    addr &= 0xFFFF;
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROM0_END) return this.rom[addr] ?? 0xFF;                              // ROM bank 0
    if (addr < MEM.ROMX_END) return this.rom[this.currentROMBank * MEM.ROM_BANK_SIZE + (addr - MEM.ROM0_END)] ?? 0xFF; // switchable ROM bank
    if (addr < MEM.VRAM_END) return this.vram[addr - MEM.ROMX_END];                      // VRAM
    if (addr < MEM.ERAM_END) {                                                           // cart RAM / MBC2 built-in RAM / MBC3 RTC
      if (this.mbcType === 3 && this.rtcSelect !== -1) return this.readRTCRegister();
      if (this.mbcType === 2) {
        if (!this.ramEnabled) return 0xFF;
        // MBC2's built-in RAM is only 512 nibbles, mirrored across the whole 0xA000-0xBFFF
        // window (bank switching doesn't apply - there's only ever one "bank"). Real hardware
        // only wires up 4 data lines here, so the upper nibble of every byte reads back as 1s.
        return 0xF0 | (this.cartRAM[addr & 0x1FF] & 0x0F);
      }
      return this.ramEnabled ? this.cartRAM[this.currentRAMBank * MEM.RAM_BANK_SIZE + (addr - MEM.VRAM_END)] : 0xFF;
    }
    if (addr < MEM.WRAM_END) return this.wram[addr - MEM.ERAM_END];                      // WRAM
    if (addr < MEM.ECHO_END) return this.wram[addr - MEM.WRAM_END];                      // echo of WRAM
    if (addr < MEM.OAM_END) return this.oam[addr - MEM.ECHO_END];                        // OAM
    if (addr < MEM.UNUSABLE_END) return 0xFF;                                            // unusable
    if (addr < MEM.IO_END) return this.readIO(addr);                                     // I/O registers
    if (addr < MEM.HRAM_END) return this.hram[addr - MEM.IO_END];                        // HRAM
    return this.ie;                                                                      // IE register
  }

  write8(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    this.noteAccess(addr, 'write');
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROMX_END) { this.handleBanking(addr, val); return; }
    if (addr < MEM.VRAM_END) { this.vram[addr - MEM.ROMX_END] = val; return; }
    if (addr < MEM.ERAM_END) {                                                           // cart RAM / MBC2 built-in RAM / MBC3 RTC
      if (!this.ramEnabled) return;
      if (this.mbcType === 3 && this.rtcSelect !== -1) { this.writeRTCRegister(val); return; }
      if (this.mbcType === 2) { this.cartRAM[addr & 0x1FF] = val & 0x0F; return; } // only the low nibble is real hardware
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

  // Cartridge "banking" writes: these addresses don't hold real RAM. Writing to them sends
  // commands to the Memory Bank Controller chip inside the cartridge, which switches which
  // 16KB slice of the ROM (or 8KB slice of external RAM) is currently visible.
  handleBanking(addr, val) {
    if (this.mbcType === 0) return; // no MBC: nothing to switch

    const prevROM = this.currentROMBank, prevRAM = this.currentRAMBank,
          prevEnabled = this.ramEnabled, prevMode = this.bankingMode, prevRtcSelect = this.rtcSelect;

    if (this.mbcType === 1) {
      if (addr < 0x2000) {
        this.ramEnabled = (val & 0x0F) === 0x0A;
      } else if (addr < 0x4000) {
        let bank = val & 0x1F;
        if (bank === 0) bank = 1; // bank 0 is never selectable here, hardware quirk
        this.currentROMBank = (this.currentROMBank & 0x60) | bank;
      } else if (addr < 0x6000) {
        if (this.bankingMode === 0) this.currentROMBank = (this.currentROMBank & 0x1F) | ((val & 0x03) << 5);
        else this.currentRAMBank = val & 0x03;
      } else {
        this.bankingMode = val & 0x01;
      }
    } else if (this.mbcType === 2) {
      // MBC2 crams both RAM-enable and ROM-bank-select into 0x0000-0x3FFF; which one a write
      // does depends on bit 8 of the address (the least significant bit of the address's high
      // byte), not on which half of the 0x0000-0x3FFF range it falls in like MBC1/MBC3.
      if (addr < 0x4000) {
        if ((addr & 0x0100) === 0) {
          this.ramEnabled = (val & 0x0F) === 0x0A;
        } else {
          let bank = val & 0x0F; // only 4 bits: max 16 ROM banks (256KB)
          if (bank === 0) bank = 1; // same "0 is never selectable" quirk as MBC1/MBC3
          this.currentROMBank = bank;
        }
      }
      // 0x4000-0x7FFF isn't wired to anything on MBC2 - no RAM bank select, no latch.
    } else if (this.mbcType === 3) {
      if (addr < 0x2000) {
        this.ramEnabled = (val & 0x0F) === 0x0A;
      } else if (addr < 0x4000) {
        let bank = val & 0x7F;
        if (bank === 0) bank = 1;
        this.currentROMBank = bank;
      } else if (addr < 0x6000) {
        // 0x00-0x03 selects a cart RAM bank; 0x08-0x0C instead maps the RTC register of that
        // number into the 0xA000-0xBFFF window (real MBC3 RAM/RTC select is one shared register).
        if (val <= 0x03) {
          this.currentRAMBank = val;
          this.rtcSelect = -1;
        } else if (val >= 0x08 && val <= 0x0C) {
          this.rtcSelect = val;
        }
      } else {
        // 0x6000-0x7FFF: writing 0x00 then 0x01 latches the live RTC counters into the
        // snapshot that 0xA000-0xBFFF reads actually return.
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
      // MBC5 has a full 9-bit ROM bank number (up to 512 banks / 8MB) split across two
      // registers, and - unlike MBC1/MBC2/MBC3 - bank 0 has no special substitution here:
      // writing 0 to the low-byte register really does map ROM bank 0 into 0x4000-0x7FFF.
      if (addr < 0x2000) {
        this.ramEnabled = (val & 0x0F) === 0x0A;
      } else if (addr < 0x3000) {
        this.currentROMBank = (this.currentROMBank & 0x100) | val; // low 8 bits
      } else if (addr < 0x4000) {
        this.currentROMBank = (this.currentROMBank & 0xFF) | ((val & 0x01) << 8); // bit 8
      } else if (addr < 0x6000) {
        // Bit 3 doubles as the rumble motor control on MBC5+RUMBLE carts, and isn't part of
        // the RAM bank number there (real rumble carts only ship up to 8 RAM banks anyway).
        // We don't drive a motor, but still need to mask bit 3 off so it can't be mistaken
        // for a bank-select bit and switch away from the RAM bank the game actually wants.
        this.currentRAMBank = val & (this.hasRumble ? 0x07 : 0x0F);
      }
    }

    // Record what kind of banking event just happened, for the MBC Banking visualizer to
    // flash the right thing. Priority: a ROM bank change is the one beginners hit constantly
    // (calling a function in another bank), so it's checked first when several bits changed
    // in the same write (rare, but possible on the MBC1 mode-select boundary).
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
      fs.events.push({ line: this.emulator.ppu.ly, kind: 'bank' });
    }
  }

  // Advances the live RTC counters (seconds/minutes/hours/days) by however much wall-clock
  // time has passed since they were last brought up to date. Skipped entirely while the
  // clock is halted (dh bit 6), which is how games freeze the clock to set it precisely.
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
      if (days > 0x1FF) { rtc.dh |= 0x80; days &= 0x1FF; } // day counter overflowed 511: set carry bit
      rtc.dl = days & 0xFF;
      rtc.dh = (rtc.dh & 0xFE) | ((days >> 8) & 0x01);
    }
  }

  // Reads whichever RTC register is currently mapped into 0xA000-0xBFFF. Per real MBC3
  // behavior this returns the *latched* snapshot, not the live counters, so the value stays
  // stable while the game reads it until the next latch write.
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

  // Writing to 0xA000-0xBFFF while an RTC register is selected sets that register on the
  // *live* clock directly (this is how games initialize or adjust the time, typically while
  // halted). Syncs live time first so the write lands on an up-to-date base.
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
    if (reg >= 0x10 && reg <= 0x3F) return this.emulator.apu.read(0xFF00 | reg); // sound registers + wave RAM
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
    if (reg >= 0x10 && reg <= 0x3F) { this.emulator.apu.write(0xFF00 | reg, val); return; } // sound registers + wave RAM
    switch (reg) {
      case 0x00: this.emulator.joypad.write(val); return;
      case 0x04: this.emulator.timer.div = 0; return;       // any write resets DIV to 0
      case 0x05: this.emulator.timer.tima = val; return;
      case 0x06: this.emulator.timer.tma = val; return;
      case 0x07: this.emulator.timer.tac = val & 0x07; return;
      case 0x41: this.io[reg] = (this.io[reg] & 0x07) | (val & 0xF8); return; // STAT: low 3 bits are hardware-controlled
      case 0x44: this.io[reg] = 0; return;                   // writing LY resets it
      case 0x46: this.doDMA(val); return;                    // OAM DMA transfer
      default:   this.io[reg] = val; return;
    }
  }

  // OAM DMA: copies 160 bytes from XX00-XX9F into OAM. Real hardware takes 160 machine
  // cycles and blocks most other memory access during the transfer; we do it instantly,
  // which is a common, harmless simplification for most games.
  doDMA(val) {
    const src = val << 8;
    for (let i = 0; i < EMU_CORE_CONFIG.OAM_DMA_BYTES; i++) this.oam[i] = this.read8(src + i);
    const fs = this.emulator.frameStats;
    fs.dma++;
    fs.events.push({ line: this.emulator.ppu.ly, kind: 'dma' });
  }
}

/* ==================================== 2. CPU (LR35902) ================================= */

class CPU {
  constructor(mmu) {
    this.mmu = mmu;
    this.reset();
  }

  reset() {
    // Register values the real boot ROM leaves behind right before a game's code starts.
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

  // The 8-bit register field used throughout the opcode table: 0=B 1=C 2=D 3=E 4=H 5=L 6=(HL) 7=A
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

  // The 16-bit register-pair field: 0=BC 1=DE 2=HL 3=SP
  getRP(p) { switch (p) { case 0: return this.getBC(); case 1: return this.getDE(); case 2: return this.getHL(); case 3: return this.SP; } }
  setRP(p, v) { switch (p) { case 0: this.setBC(v); break; case 1: this.setDE(v); break; case 2: this.setHL(v); break; case 3: this.SP = v & 0xFFFF; break; } }

  fetch8() { const v = this.mmu.read8(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch8(); const hi = this.fetch8(); return (hi << 8) | lo; }

  push16(v) { this.SP = (this.SP - 1) & 0xFFFF; this.mmu.write8(this.SP, (v >> 8) & 0xFF); this.SP = (this.SP - 1) & 0xFFFF; this.mmu.write8(this.SP, v & 0xFF); }
  pop16() { const lo = this.mmu.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; const hi = this.mmu.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; return (hi << 8) | lo; }

  /* ---- arithmetic / logic helpers (each updates the flag register) ---- */
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

  // Binary-coded-decimal adjust after an 8-bit add/sub, so arithmetic on "decimal" values
  // (like a two-digit score) produces correct decimal digits instead of raw hex.
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

  /* ---- rotate/shift helpers, shared between the accumulator-only ops (07/0F/17/1F)
     and the full CB-prefixed register/mem versions ---- */
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

  /* ---- main fetch/execute step. Returns the number of T-cycles the instruction used. ---- */
  step() {
    if (this.eiDelay > 0) { this.eiDelay--; if (this.eiDelay === 0) this.IME = true; }
    this.cycles = 0;

    // Interrupt dispatch must be checked *here* - immediately after the eiDelay
    // transition above, before this step's opcode is fetched - not only at the end of
    // the step. EI takes effect after the next instruction, so the moment IME flips
    // true is exactly the boundary real hardware dispatches on. If the very next
    // opcode happens to be DI (a common "wait for a flag, then disable interrupts
    // again" idiom: DI / BIT flag / JR NZ / HALT / EI / JR loop), checking only after
    // that opcode runs means IME is already false again by the time we look - the
    // interrupt is silently missed and the flag it would have set never gets set,
    // hanging the CPU in that loop forever.
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

  // Level-sensitive HALT wake: runs regardless of IME, since HALT exits on any
  // pending (IF & IE), whether or not interrupts are actually enabled to service it.
  wakeFromHaltIfPending() {
    const IF = this.mmu.io[0x0F] & 0x1F;
    const IE = this.mmu.ie & 0x1F;
    if ((IF & IE) && this.halted) this.halted = false;
  }

  // Attempts to dispatch one pending, enabled interrupt. Returns true if it did (in
  // which case this step consumed its cycles pushing PC and jumping to the vector,
  // and no opcode fetch happens this step - matching real hardware, where interrupt
  // dispatch takes the place of the next instruction fetch).
  tryDispatchInterrupt() {
    const IF = this.mmu.io[0x0F] & 0x1F;
    const IE = this.mmu.ie & 0x1F;
    const pending = IF & IE;
    if (pending && this.halted) this.halted = false; // HALT always wakes on a pending interrupt
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

  // Instructions are decoded the same way the real hardware does: most of the opcode space
  // is a regular grid of [register/operation][register] bit fields, so those blocks are
  // handled generically instead of writing out 200+ nearly-identical switch cases.
  execute(opcode) {
    // 0x40-0x7F: LD r,r' (0x76 is the odd one out: HALT)
    if (opcode >= 0x40 && opcode <= 0x7F) {
      if (opcode === 0x76) { this.halted = true; this.tick(4); return; }
      const dst = (opcode >> 3) & 7, src = opcode & 7;
      this.setReg8(dst, this.getReg8(src));
      this.tick((dst === 6 || src === 6) ? 8 : 4);
      return;
    }
    // 0x80-0xBF: ALU A,r  (ADD/ADC/SUB/SBC/AND/XOR/OR/CP)
    if (opcode >= 0x80 && opcode <= 0xBF) {
      const op = (opcode >> 3) & 7, src = opcode & 7;
      this.aluOp(op, this.getReg8(src));
      this.tick(src === 6 ? 8 : 4);
      return;
    }
    // INC r / DEC r / LD r,d8 columns (share the same "row" pattern across 0x04-0x3E)
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

      case 0x10: this.PC = (this.PC + 1) & 0xFFFF; this.tick(4); break; // STOP (2-byte opcode; simplified - see footer note)
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

  // CB-prefixed instructions are a clean 8x8 bit-field grid: rotate/shift ops (00-3F),
  // then BIT (40-7F), RES (80-BF), SET (C0-FF) — each column selecting one of B,C,D,E,H,L,(HL),A.
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
   A standalone decoder that mirrors CPU.execute()/executeCB() case-for-case, but only reads
   bytes (via a caller-supplied readByte function) and never mutates any state. Used by the
   live disassembly view and the execution trace, so it works whether the bytes come straight
   from memory (disassembleAt) or from a snapshot captured back when an instruction actually
   ran (disassembleBytes), which matters if that memory has since changed. ========================================================================================= */

const REG8_NAMES = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const ALU_NAMES  = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const ROT_NAMES  = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SWAP', 'SRL'];

// readByte(offset) must return the byte at pc+offset (0, 1, or 2), without side effects.
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

// Convenience wrapper that reads live from an MMU (used by the "next instructions" view).
function disassembleAt(mmu, addr) {
  return disassembleBytes((off) => mmu.read8((addr + off) & 0xFFFF), addr & 0xFFFF);
}

// Short, plain-English gloss for a decoded mnemonic, for the execution trace view. Checked
// against a handful of full-text prefixes first (for addressing modes worth calling out
// specifically), then falls back to a description keyed on just the base mnemonic word.
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
  // Conditional control-flow instructions (JP NZ, JR Z, CALL C, RET NC, ...) only act
  // when the named flag condition holds - worth calling out since it's easy to miss.
  if (opWord === 'JP' || opWord === 'JR' || opWord === 'CALL' || opWord === 'RET') {
    const rest = mnemonicText.slice(opWord.length).trim();
    const condMatch = rest.match(/^(NZ|NC|Z|C)\b/);
    if (condMatch) note += ` Only taken if ${COND_NOTE[condMatch[1]]}.`;
  }
  return note;
}

/* ==================================== 3. PPU (graphics) ================================= */

class PPU {
  // Two selectable four-shade palettes: the classic DMG (original Game Boy) green tint,
  // and the neutral grayscale used by the Game Boy Pocket's screen. SHADES points at
  // whichever is currently active (see setScreenModel() on Emulator) and is what
  // applyPalette() actually reads from.
  static PALETTE_GB  = EMU_CORE_CONFIG.PALETTE_GB;
  static PALETTE_GBP = EMU_CORE_CONFIG.PALETTE_GBP;
  static SHADES = PPU.PALETTE_GBP;

  // Layer-tint debug view: each rendering layer gets a distinct color wash so it's
  // obvious at a glance which layer drew which pixel (background layer / window "tiles" / sprites).
  static LAYER_TINTS = EMU_CORE_CONFIG.LAYER_TINTS;
  static LAYER_TINT_MIX = EMU_CORE_CONFIG.LAYER_TINT_MIX;

  constructor(emulator) {
    this.emulator = emulator;
    this.mmu = emulator.mmu;
    this.modeClock = 0;
    this.mode = 2;
    this.windowLineCounter = 0;
    this.framebuffer = new Uint8ClampedArray(EMU_CORE_CONFIG.SCREEN.WIDTH * EMU_CORE_CONFIG.SCREEN.HEIGHT * 4);
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

  // Advances the PPU's internal state machine (OAM search -> pixel transfer -> HBlank,
  // repeated for 144 visible lines, followed by 10 VBlank lines) using a simplified,
  // fixed-length-per-mode timing model rather than pixel-by-pixel FIFO simulation.
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

      case 1: // VBlank (10 lines x one line's worth of cycles)
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
    const bgPriority = new Uint8Array(EMU_CORE_CONFIG.SCREEN.WIDTH); // tracks BG/window color index per pixel, for sprite priority

    if (this.lcdc & 0x01) {
      this.renderBackgroundLine(y, bgPriority);
      if (this.lcdc & 0x20) this.renderWindowLine(y, bgPriority);
    } else {
      for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) this.setPixel(x, y, 255, 255, 255);
    }
    if (this.lcdc & 0x02) this.renderSpritesLine(y, bgPriority);
  }

  /* ---- Shared pixel-decoding helpers ----
     Single source of truth for tile/sprite pixel math. Both the real per-scanline renderer
     below (renderBackgroundLine/renderWindowLine/renderSpritesLine) and the debug "layer
     viewer" (drawLayers(), further down in the file) call these, so a rendering fix only
     ever needs to be made once and the debug view can never silently drift from what's
     actually on screen. */

  // Decodes the 2bpp color index (0-3) of the pixel at tile-space coordinates (mapX, mapY)
  // for the given tile map / tile data configuration. mapX/mapY are already-resolved pixel
  // coordinates into that tile map's own space (BG wraps them mod 256; window doesn't need to).
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

  // Tile-data addressing (LCDC.4) is shared between the BG and window layers.
  bgWindowTileDataConfig() {
    const signedIndex = !(this.lcdc & 0x10);
    return { tileDataBase: signedIndex ? 0x9000 : 0x8000, signedIndex };
  }

  // Color index of the background pixel that would be shown at screen (x, y) right now,
  // per current SCX/SCY/LCDC.
  getBackgroundColorIndex(x, y) {
    const tileMapBase = (this.lcdc & 0x08) ? 0x9C00 : 0x9800;
    const { tileDataBase, signedIndex } = this.bgWindowTileDataConfig();
    const bgX = (x + this.scx) & 0xFF, bgY = (y + this.scy) & 0xFF;
    return this.getTileColorIndex(tileMapBase, tileDataBase, signedIndex, bgX, bgY);
  }

  // Color index of the window pixel at window-space coordinates (winX, winY). Callers
  // resolve winY differently (the real renderer advances an internal window-line counter;
  // the debug layer viewer just uses y - WY per line) but the tile lookup itself is identical.
  getWindowColorIndex(winX, winY) {
    const tileMapBase = (this.lcdc & 0x40) ? 0x9C00 : 0x9800;
    const { tileDataBase, signedIndex } = this.bgWindowTileDataConfig();
    return this.getTileColorIndex(tileMapBase, tileDataBase, signedIndex, winX, winY);
  }

  // Sprite candidates for scanline y: OAM entries whose Y range covers this line, capped at
  // the hardware's 10-per-line limit and sorted lowest-priority-first (drawing them in this
  // order and letting later draws win overlap reproduces the real X-then-OAM-index priority
  // rule). Pure - doesn't touch frameStats - so both the real renderer and the debug layer
  // viewer can safely call it.
  getSpriteCandidatesForLine(y, spriteHeight) {
    const SPR = EMU_CORE_CONFIG.SPRITES;
    const candidates = [];
    for (let i = 0; i < SPR.MAX_TOTAL && candidates.length < SPR.MAX_PER_LINE; i++) { // hardware limit: 10 sprites/line
      const base = i * 4;
      const spriteY = this.mmu.oam[base] - 16;
      if (y >= spriteY && y < spriteY + spriteHeight) {
        candidates.push({
          spriteY, spriteX: this.mmu.oam[base + 1] - 8,
          tileIndex: this.mmu.oam[base + 2], attrs: this.mmu.oam[base + 3], oamIndex: i
        });
      }
    }
    candidates.sort((a, b) => (b.spriteX - a.spriteX) || (b.oamIndex - a.oamIndex));
    return candidates;
  }

  // Decodes a sprite's bit-planes (lo/hi) for its row on scanline y, honoring Y-flip and
  // (for 8x16 sprites) which half-tile the row falls in. Decoded once per sprite per
  // scanline; spriteRowColorIndex() below just extracts individual pixel bits from it.
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

  // Color index (0-3) at column px (0-7) within a sprite row, given the bit-planes from getSpriteRowBits().
  static spriteRowColorIndex(lo, hi, xFlip, px) {
    const bit = xFlip ? px : 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  renderBackgroundLine(y, bgPriority) {
    for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const colorNum = this.getBackgroundColorIndex(x, y);
      bgPriority[x] = colorNum;
      const [r, g, b] = this.tintForLayer(...this.applyPalette(colorNum, this.bgp), 'bg');
      this.setPixel(x, y, r, g, b);
    }
  }

  renderWindowLine(y, bgPriority) {
    if (y < this.wy) return;
    const wx = this.wx - 7;
    if (wx > EMU_CORE_CONFIG.SCREEN.WIDTH - 1) return;
    const winY = this.windowLineCounter;
    let drewAny = false;

    for (let x = Math.max(wx, 0); x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const colorNum = this.getWindowColorIndex(x - wx, winY);
      bgPriority[x] = colorNum;
      const [r, g, b] = this.tintForLayer(...this.applyPalette(colorNum, this.bgp), 'window');
      this.setPixel(x, y, r, g, b);
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
        const [r, g, b] = this.tintForLayer(...this.applyPalette(colorNum, palette), 'sprite');
        this.setPixel(sx, y, r, g, b);
      }
    }
  }

  applyPalette(colorNum, palette) { return PPU.SHADES[(palette >> (colorNum * 2)) & 0x03]; }

  // Blends a rendered pixel toward its layer's debug tint color when layer-tint mode is on;
  // returns the color unchanged otherwise. `layer` is one of 'bg' | 'window' | 'sprite'.
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
  static TIMA_PERIOD = EMU_CORE_CONFIG.TIMER.TIMA_PERIOD; // T-cycles per TIMA increment, indexed by TAC[1:0]

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
  set div(v) { this.divReg = 0; this.divCounter = 0; }

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
  The DMG has 4 sound channels sharing 3 "voices" worth of hardware:
    Ch1 - square wave with a pitch sweep
    Ch2 - square wave (no sweep)
    Ch3 - arbitrary waveform played from 32 4-bit samples ("wave RAM")
    Ch4 - pseudo-random noise, generated by a shifting LFSR (linear feedback shift register)

  Each channel has its own frequency/length/volume-envelope logic, all driven by a shared
  "frame sequencer" that ticks at 512 Hz and doles out slower clocks to length counters
  (256 Hz), the frequency sweep (128 Hz), and volume envelopes (64 Hz) - see clockFrameSequencer().

  Rather than trying to render exact analog waveforms, this generates one output sample per
  channel every time enough CPU cycles have passed for one Web Audio sample (~44.1kHz), using
  whatever the channel's current duty/volume/LFSR state happens to be at that instant. That's
  a common, simple approximation ("naive resampling") - it sounds correct for essentially all
  game music/SFX even though it isn't cycle-exact or band-limited like a real APU.
*/

const APU_DUTY_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
  [1, 0, 0, 0, 0, 0, 0, 1], // 25%
  [1, 0, 0, 0, 0, 1, 1, 1], // 50%
  [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];
const APU_NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

// Read/write masks: bits that always read back as 1 regardless of what was written
// (real hardware doesn't have storage for these bits - they're write-only or unused).
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

    // 44100 is a fallback only - initAudio() overwrites this with the AudioContext's *actual*
    // sample rate (commonly 48000, but it varies by OS/hardware). Getting this wrong causes
    // the emulator to produce samples slower or faster than the audio hardware consumes them,
    // which slowly drains or fills the ring buffer and causes periodic clicking/crackling.
    this.sampleRate = 44100;
    this.cyclesPerSample = EMU_CORE_CONFIG.CLOCK_HZ / this.sampleRate;
    this.sampleCounter = 0;

    // Ring buffer feeding the Web Audio callback (producer: emulator loop, consumer: audio thread)
    this.RING_SIZE = 8192;
    this.ringL = new Float32Array(this.RING_SIZE);
    this.ringR = new Float32Array(this.RING_SIZE);
    this.writePos = 0; this.readPos = 0; this.available = 0;
    this.lastL = 0; this.lastR = 0; // last sample played, used to fade out gracefully on underrun

    // Running sum accumulators used to *average* (rather than just instantaneously snapshot)
    // each channel's DAC output over every raw cycle since the last output sample was emitted.
    // This matters once the speed slider is away from 1x: at e.g. 4x, ~380 raw GB cycles pass
    // per output sample instead of ~95, and a single instantaneous snapshot only "sees" the
    // state at that one instant while silently ignoring the other ~285 cycles of activity in
    // between. Because the sped-up channels also genuinely oscillate faster in real time (their
    // freqTimer is driven by raw, unscaled cycles), naive point-sampling badly *undersamples*
    // that faster waveform - a classic aliasing bug - and the resulting pitch comes out wrong
    // (sometimes wildly so) instead of merely "a bit rough". Integrating (summing amplitude*cycles)
    // over the whole interval and dividing by the elapsed cycles on emission acts as a simple
    // box-filter low-pass, which tames that aliasing at 2x-4x while leaving 1x/slow-motion
    // (where the interval between samples is already small) effectively unchanged.
    this.accL = 0; this.accR = 0; this.accCycles = 0;

    // Per-channel raw DAC output history, purely for the oscilloscope UI - separate from the
    // mixed ringL/ringR buffer above so each channel's own waveform (duty cycle, envelope,
    // wave-table shape, noise) can be inspected independently of panning/mixing.
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
    // Per-channel mute, driven by the oscilloscope UI - silences that channel's contribution
    // to both the mixed audio output and its own scope trace (which flatlines, same as a
    // channel that's simply off). Indexed 0-3 for CH1-CH4.
    this.chMuted = [false, false, false, false];
    this.volume = 0.5;
  }

  newSquareState() {
    return { enabled: false, dacEnabled: false, duty: 2, dutyStep: 0, frequency: 0, freqTimer: 0,
             lengthCounter: 0, lengthEnabled: false,
             envVolume: 0, envDirection: 0, envPeriod: 0, envTimer: 0, volume: 0 };
  }

  // Channel 1 is a square-wave channel plus a frequency sweep unit the other channels don't
  // have, so it needs newSquareState()'s fields *and* the sweep ones together. Every place
  // that resets ch1 to a fresh state (constructor, powerOff(), reset()) wants exactly this.
  newCh1State() {
    return Object.assign(this.newSquareState(), {
      sweepPeriodReg: 0, sweepDirection: 0, sweepShift: 0,
      sweepTimer: 0, sweepEnabled: false, shadowFreq: 0,
    });
  }

  /* ---- save state ----
     The ring buffer, AudioContext, and other Web-Audio plumbing are runtime/output-device
     concerns, not emulated console state, so they're deliberately left out and just reset
     to a clean, silent buffer on restore. */
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
    // Drop any buffered audio so playback resumes cleanly instead of replaying stale samples.
    this.writePos = 0; this.readPos = 0; this.available = 0; this.lastL = 0; this.lastR = 0;
  }

  /* ---- Web Audio plumbing ---- */
  // ScriptProcessorNode is deprecated in favor of AudioWorklet, but it works synchronously
  // and inline (no separate worklet module file to load), which keeps this a single file.
  initAudio() {
    if (this.audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.audioCtx = new Ctx();

    // Use the real hardware/OS sample rate instead of assuming 44100 - a mismatch here is
    // the classic cause of periodic crackling (the ring buffer slowly drains or overflows).
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
          // Rare underrun (e.g. a dropped frame): decay toward silence instead of an abrupt
          // jump to 0, which is what actually produces an audible "click".
          this.lastL *= 0.9; this.lastR *= 0.9;
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
    if (!this.enabled) return; // powered off: ignore writes to FF10-FF25 (simplification - real DMG
                                // hardware still allows length-counter writes here; skipped for clarity)

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
    // Real hardware clears everything except wave RAM (and, on DMG, length counters - skipped here for simplicity).
    this.regs.fill(0);
    this.ch1 = this.newCh1State();
    this.ch2 = this.newSquareState();
    Object.assign(this.ch4, { enabled: false, dacEnabled: false, envVolume: 0, envDirection: 0, envPeriod: 0, clockShift: 0, widthMode: 0, divisorCode: 0 });
    this.leftVol = 7; this.rightVol = 7; this.panning = 0;
  }
  powerOn() { this.fsStep = 0; this.frameSeqTimer = 0; this.ch1.dutyStep = 0; this.ch2.dutyStep = 0; }

  // Sets up all registers/state the way they'd be left by the time a game boots (power on
  // plus the standard post-boot-ROM values), matching how MMU.loadROM() does the same for I/O.
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

    // The NR14/NR19/NR1E/NR23 writes above set each channel's trigger bit (bit 7) to match
    // the register *bytes* real hardware leaves behind post-boot - but routing them through
    // write() also actually triggers those channels, same as a game would. Channel 1's DAC is
    // on (NR12 = 0xF3), so that trigger is audible: a stray beep the instant playback starts,
    // on every ROM load and reset. Real hardware's equivalent is the tail of the boot ROM's
    // chime, already decayed to silence by the time a game's own code runs; since this snapshot
    // doesn't replay that whole chime, silence what the trigger just started so only the
    // (harmless) register values carry over, not an audible reprise.
    this.ch1.enabled = false;
    this.ch2.enabled = false;
    this.ch3.enabled = false;
    this.ch4.enabled = false;
  }

  /* ---- channel triggers (NRx4 bit 7 write) ---- */
  // Records that some channel was (re)triggered this frame, for the Frame Activity anatomy
  // strip - purely observational, doesn't affect sound generation.
  noteTrigger() {
    const fs = this.emulator.frameStats;
    fs.apuTriggers++;
    fs.events.push({ line: this.emulator.ppu.ly, kind: 'apu' });
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

    // Fold this chunk's instantaneous DAC output into the running-sum accumulators (weighted
    // by how many raw cycles it covers) rather than only keeping the very latest instant. See
    // the accumulator fields' comment in the constructor for why this matters once speed != 1x.
    this.accumulateMix(cycles);

    // The emulator's frame clock (~59.73fps via requestAnimationFrame) and the audio
    // hardware's clock aren't perfectly locked together, so even with the right sample rate
    // above, tiny timing differences accumulate over minutes of play. Nudge the effective
    // sample period by up to +-1% based on how full the ring buffer is, to gently pull it back
    // toward half-full instead of letting it slowly drift into underruns or overflows.
    const fillRatio = this.available / this.RING_SIZE;
    const correction = 1 + (fillRatio - 0.5) * 0.02;

    // this.cyclesPerSample assumes emulated cycles arrive at the real Game Boy clock rate
    // (one real second = 4194304 cycles). The speed slider breaks that assumption: at e.g.
    // 10% speed, only ~419430 cycles happen per real second, so if we kept using the normal
    // cyclesPerSample the ring buffer would fill 10x slower than the audio callback drains
    // it (constant underrun -> crackling/silence). Scaling the target down by the same
    // speed factor keeps sample *production* paced to real time again, matching what the
    // audio hardware *consumes* - which also naturally pitches audio down during slow motion,
    // just like real hardware running underclocked.
    const targetCyclesPerSample = this.cyclesPerSample * correction * this.emulator.speed;

    this.sampleCounter += cycles;
    while (this.sampleCounter >= targetCyclesPerSample) { this.sampleCounter -= targetCyclesPerSample; this.emitSample(); }
  }

  // Computes each channel's instantaneous DAC output (-1..1) plus the mixed/panned/volumed
  // left+right instant, and adds left*cycles / right*cycles into the running-sum accumulators.
  // Also remembers the latest instantaneous per-channel values for the oscilloscope (which wants
  // to see the raw waveform, not an averaged one).
  accumulateMix(cycles) {
    if (!this.enabled) {
      this._lastA1 = this._lastA2 = this._lastA3 = this._lastA4 = 0;
      this.accCycles += cycles;
      return; // silence contributes 0 either way, nothing to add to accL/accR
    }

    const amp1 = (this.ch1.enabled && !this.chMuted[0]) ? APU_DUTY_TABLE[this.ch1.duty][this.ch1.dutyStep] * this.ch1.volume : 0;
    const amp2 = (this.ch2.enabled && !this.chMuted[1]) ? APU_DUTY_TABLE[this.ch2.duty][this.ch2.dutyStep] * this.ch2.volume : 0;
    let amp3 = 0;
    if (this.ch3.enabled && !this.chMuted[2] && this.ch3.volumeShift > 0) amp3 = this.getWaveSample() >> (this.ch3.volumeShift - 1);
    const amp4 = (this.ch4.enabled && !this.chMuted[3]) ? ((~this.ch4.lfsr) & 1) * this.ch4.volume : 0;

    // Each channel's 4-bit DAC maps 0-15 to roughly -1..1
    const dac = v => (v / 7.5) - 1;
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

  // Emits one output sample: the *average* mixed level over every cycle since the last emitted
  // sample (rather than just whatever the state instantaneously happened to be), then resets the
  // accumulators for the next interval. Averaging acts as a simple anti-aliasing low-pass, which
  // matters most at speed > 1x where each output sample now spans many more raw cycles than the
  // audio hardware's natural ~95-cycles-per-sample - without it, that gap between samples let the
  // faster-oscillating (speed-scaled) waveform slip through un-sampled, aliasing into garbled or
  // outright wrong-sounding pitches instead of a clean sped-up tone.
  emitSample() {
    const left = this.accCycles > 0 ? this.accL / this.accCycles : 0;
    const right = this.accCycles > 0 ? this.accR / this.accCycles : 0;
    this.pushSample(left, right);
    this.pushScopeSample(this._lastA1 || 0, this._lastA2 || 0, this._lastA3 || 0, this._lastA4 || 0);
    this.accL = 0; this.accR = 0; this.accCycles = 0;
  }

  // Records this instant's raw per-channel DAC output for the oscilloscope UI. Kept as a
  // separate small ring buffer from the audio-output one so the visualization can be read
  // independently (and at a different rate) from the Web Audio consumer.
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
    this.frameReady = false;
    this._rafId = null;
    this.markCurrentLine = false;
    this.layerTint = false;

    this.speed = 1;          // 0.1-1.0 multiplier applied to how fast emulated frames advance
    this._lastTime = null;   // real-time timestamp of the previous loop() tick
    this._frameAcc = 0;      // accumulated (speed-scaled) ms available to spend on emulated frames

    this._fpsFrames = 0;
    this._fpsLast = performance.now();

    this.romTitle = null; // set in loadROM; used to key save states and warn on mismatched loads

    /* ---- step / breakpoint debugging ---- */
    this.breakpointPC = null;      // number 0-0xFFFF, or null if unset
    this.breakpointOpcode = null;  // number 0-0xFF, or null if unset
    this.breakHitReason = null;    // human-readable reason the emulator last auto-stopped
    this._bpSkipFirstMatch = false; // avoids instantly re-triggering a PC breakpoint we're already sitting on
    this.onBreakpointHit = null;   // optional callback(reason), wired up by the UI

    /* ---- rewind: in-memory-only ring buffer of full state snapshots, taken once per emulated
       second, holding up to REWIND_MAX_SECONDS of history. Deliberately kept as plain JS
       objects in a normal array - never touches localStorage or the save-state slots, so it
       vanishes on page reload and can't collide with anything the user explicitly saved. ---- */
    this.REWIND_MAX_SECONDS = 15;
    this.rewindBuffer = [];      // oldest first, most recent last; each entry is a getSaveState() snapshot
    this.rewindFrameAcc = 0;     // counts frames since the last snapshot was taken (60 = ~1s)

    /* ---- frame activity: emulated-hardware content per frame (instructions, interrupts,
       sprites, DMA, banking, APU triggers) - purely observational, for the Frame Activity
       panel. Not JS/host timing - just counts of things the emulated hardware itself did. ---- */
    this.FRAME_STATS_HISTORY = 60;    // ~1 second at 59.73fps
    this.frameStatsHistory = [];      // completed frame snapshots, oldest first
    this.frameCounter = 0;            // monotonic frame index, identifies history entries
    this.frameStats = this.newFrameStats(); // accumulator for the frame currently in progress

    /* ---- execution trace: ring buffer of the last TRACE_SIZE fetched instructions ---- */
    this.TRACE_SIZE = 500;
    this.traceAddr = new Uint16Array(this.TRACE_SIZE);
    this.traceB0 = new Uint8Array(this.TRACE_SIZE);
    this.traceB1 = new Uint8Array(this.TRACE_SIZE);
    this.traceB2 = new Uint8Array(this.TRACE_SIZE);
    this.traceDiff = new Array(this.TRACE_SIZE).fill(''); // human-readable "A: 0x00→0x05 Z:1→0" string per entry
    this.traceWritePos = 0;
    this.traceFilled = 0;

    /* ---- interrupt log: ring buffer of the last INTERRUPT_LOG_SIZE interrupts the CPU
       actually serviced (i.e. dispatched to their handler), for the Interrupts debug panel.
       Distinct from frameStats.interrupts above, which counts *requests* (IF bit set) - this
       counts *dispatches*, which only happen once IME is on and the CPU gets around to them. ---- */
    this.INTERRUPT_LOG_SIZE = 60;
    this.interruptLog = []; // oldest first; each entry { seq, frame, bit, pcBefore }
    this.interruptSeq = 0;
  }

  // A fresh accumulator for one frame's worth of hardware activity. spritesPerLine is indexed
  // by scanline (0-143); events is an ordered list of { line, kind } markers used to place
  // interrupt/DMA/bank/APU ticks on the Frame Activity anatomy strip.
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
    const kind = ['vblank', 'stat', 'timer', 'serial', 'joypad'][bit];
    if (kind) {
      this.frameStats.interrupts[kind]++;
      this.frameStats.events.push({ line: this.ppu.ly, kind: 'int-' + kind });
    }
  }

  // Called by CPU.tryDispatchInterrupt() the instant it actually dispatches an interrupt
  // (pushes PC and jumps to the handler) - not just when the IF bit gets set. Feeds the
  // "Recently serviced" list in the Interrupts debug panel.
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
     Composes a JSON-serializable snapshot of every emulated component. The cartridge ROM
     itself is intentionally NOT included (it can be multiple MB and the user already has
     the file) - only RAM/registers/CPU state, i.e. everything that changes as the game runs. */
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
  // number of T-cycles, recording it into the execution trace on the way. Shared by the
  // normal continuous runFrame() loop and by the single-step debugger.
  stepInstruction() {
    // A PC breakpoint fires the moment execution is *about to* fetch the opcode at that
    // address, so it's checked here rather than after stepping.
    if (this.breakpointPC !== null && this.cpu.PC === this.breakpointPC) {
      if (this._bpSkipFirstMatch) { this._bpSkipFirstMatch = false; }
      else { this.triggerBreakpoint(`PC reached ${hex16(this.breakpointPC)}`); return 0; }
    }

    const pcBefore = this.cpu.PC;
    const wasHalted = this.cpu.halted;
    let opcode = null;
    let traceIndex = -1;
    let regsBefore = null;
    if (!wasHalted) {
      opcode = this.mmu.read8(pcBefore);
      regsBefore = this.snapshotRegs();
      traceIndex = this.pushTrace(pcBefore, opcode, this.mmu.read8((pcBefore + 1) & 0xFFFF), this.mmu.read8((pcBefore + 2) & 0xFFFF));
    }

    const cycles = this.cpu.step();
    this.ppu.step(cycles);
    this.timer.step(cycles);
    this.apu.step(cycles);

    if (!wasHalted) {
      this.traceDiff[traceIndex] = this.diffRegs(regsBefore, this.snapshotRegs());
    }

    if (!wasHalted && this.breakpointOpcode !== null && opcode === this.breakpointOpcode) {
      this.triggerBreakpoint(`opcode ${hex8(this.breakpointOpcode)} executed at ${hex16(pcBefore)}`);
    }
    return cycles;
  }

  runFrame() {
    // Starting a fresh frame: the accumulator built up during the previous call is done being
    // written to by now (nothing outside runFrame() touches frameStats), so it's safe to swap
    // in a new one before pushing the finished one into history below.
    this.frameStats = this.newFrameStats();
    let cyclesThisFrame = 0;
    while (cyclesThisFrame < Emulator.CYCLES_PER_FRAME) {
      const cycles = this.stepInstruction();
      this.frameStats.instructions++;
      if (!this.running) return; // a breakpoint fired mid-frame; stop immediately (stats for this partial frame are discarded)
      cyclesThisFrame += cycles;
    }
    this.frameStatsHistory.push(this.frameStats);
    if (this.frameStatsHistory.length > this.FRAME_STATS_HISTORY) this.frameStatsHistory.shift();
    this.frameCounter++;

    this.rewindFrameAcc++;
    if (this.rewindFrameAcc >= 60) { // ~1 emulated second at 59.73fps, same granularity as stepOneSecond()
      this.rewindFrameAcc = 0;
      this.pushRewindSnapshot();
    }
  }

  // Records a snapshot for the rewind buffer, capped to REWIND_MAX_SECONDS entries (oldest
  // dropped first). In-memory only - never written to localStorage or the save-state slots.
  pushRewindSnapshot() {
    this.rewindBuffer.push(this.getSaveState());
    if (this.rewindBuffer.length > this.REWIND_MAX_SECONDS) this.rewindBuffer.shift();
  }

  // Steps backward one second at a time: pops the most recent rewind snapshot and restores
  // it, pausing the emulator. Each call goes one second further back; returns false once the
  // buffer (up to REWIND_MAX_SECONDS deep) is exhausted.
  rewind() {
    if (this.rewindBuffer.length === 0) return false;
    if (this.running) this.pause();
    const state = this.rewindBuffer.pop();
    this.loadSaveState(state);
    this.rewindFrameAcc = 0; // the restored moment shouldn't count as partway into a new second
    this.draw();
    refreshDebugTools();
    return true;
  }

  // Pauses the emulator and records why, so a breakpoint hit looks the same in the UI as
  // pressing Pause by hand.
  triggerBreakpoint(reason) {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.apu.suspend();
    this.breakHitReason = reason;
    this._bpSkipFirstMatch = false;
    if (this.onBreakpointHit) this.onBreakpointHit(reason);
  }

  // Executes exactly one instruction while paused, then redraws so the screen/debug views
  // reflect the new state immediately (no need to wait for the 60fps loop).
  stepOne() {
    if (this.running) this.pause();
    this.stepInstruction();
    this.draw();
    refreshDebugTools();
  }

  // Runs instructions until the PPU moves on to the next scanline (LY changes), then redraws.
  // Capped at one frame's worth of cycles so it can't spin forever if the LCD is off (LY is
  // pinned at 0 while LCDC bit 7 is clear, so it would otherwise never change).
  stepLine() {
    if (this.running) this.pause();
    this.running = true;
    const startLy = this.ppu.ly;
    let cyclesSpent = 0;
    while (this.ppu.ly === startLy && cyclesSpent < Emulator.CYCLES_PER_FRAME) {
      const cycles = this.stepInstruction();
      if (!this.running) break; // a breakpoint fired mid-step
      cyclesSpent += cycles;
    }
    this.running = false;
    this.draw();
    refreshDebugTools();
  }

  // Runs exactly one full frame's worth of cycles (same budget runFrame() uses for normal
  // play), then redraws - a "step frame" for the paused debugger.
  stepFrame() {
    if (this.running) this.pause();
    this.running = true; // runFrame() bails out early if this flips false mid-frame (breakpoint hit)
    this.runFrame();
    this.running = false;
    this.draw();
    refreshDebugTools();
  }

  // Runs 60 full frames back to back (~1.005s of emulated time, matching the ~60fps figure
  // used elsewhere in this UI) then redraws - a coarse "step frame" for skipping past a slow
  // intro/cutscene, and it conveniently fills the Frame Activity ring buffer (60 entries) with
  // exactly the frames this call just ran, so every one of them becomes browsable afterwards.
  stepOneSecond() {
    if (this.running) this.pause();
    this.running = true; // runFrame() bails out early if this flips false mid-frame (breakpoint hit)
    for (let i = 0; i < 60; i++) {
      this.runFrame();
      if (!this.running) break; // a breakpoint fired mid-frame; stop immediately
    }
    this.running = false;
    this.draw();
    refreshDebugTools();
  }

  // Resumes continuous execution, but auto-pauses (via triggerBreakpoint) the moment PC
  // reaches pcTarget and/or opcodeTarget is fetched. Either may be null to leave it unset.
  runToBreakpoint(pcTarget, opcodeTarget) {
    this.breakpointPC = pcTarget;
    this.breakpointOpcode = opcodeTarget;
    this._bpSkipFirstMatch = true; // don't instantly stop if we're already sitting on a PC match
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

  // Compares two snapshots and returns a compact "A: 0x00→0x05 Z:1→0" style string listing
  // only the registers/flags that actually changed - empty string if nothing changed.
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

  // Returns trace entries oldest-first, most-recently-executed last.
  getTraceEntries() {
    const entries = [];
    const oldest = this.traceFilled < this.TRACE_SIZE ? 0 : this.traceWritePos;
    for (let i = 0; i < this.traceFilled; i++) {
      const idx = (oldest + i) % this.TRACE_SIZE;
      entries.push({ addr: this.traceAddr[idx], b0: this.traceB0[idx], b1: this.traceB1[idx], b2: this.traceB2[idx], diff: this.traceDiff[idx] });
    }
    return entries;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTime = null;
    this._frameAcc = 0;
    this.apu.initAudio(); // must happen inside a user gesture (click/drop), which start() is always called from
    this.apu.resume();
    this.loop(performance.now());
  }
  pause() { this.running = false; if (this._rafId) cancelAnimationFrame(this._rafId); this.apu.suspend(); }

  // Paces emulated frames against real elapsed time, scaled by this.speed (1 = normal speed,
  // 0.1 = 10%, etc). Using an accumulator instead of just "run one frame per rAF tick" means
  // slowing down actually slows the game down, rather than only slowing the frame counter.
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
      if (!this.running) return; // a breakpoint fired mid-frame; stop immediately
      this._frameAcc -= FRAME_MS;
      framesRun++;
    }

    if (framesRun > 0) {
      this.draw();
      this._fpsFrames += framesRun;
      // Redraw the trace/disasm/tile/etc. panels only when a frame actually ran, so their
      // visible update rate is paced by real emulation speed instead of a fixed wall-clock
      // timer (which used to make them look identical regardless of the speed slider).
      refreshDebugTools();
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

  // Draws a bright horizontal marker over the row the PPU is currently on (LY), so you can
  // see the raster position on the actual screen output, not just in the Scanline Timeline panel.
  drawCurrentLineMarker() {
    const ly = this.ppu.ly;
    if (ly > EMU_CORE_CONFIG.SCREEN.HEIGHT - 1) return; // V-Blank lines are off the visible screen
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

// Typed arrays (VRAM, WRAM, etc.) go into save-state JSON as base64 strings rather than
// JSON number arrays - much smaller, and fast to encode/decode via the browser's atob/btoa.
function u8ToBase64(u8) {
  let binary = '';
  const chunkSize = 0x8000; // avoid blowing the call stack on String.fromCharCode.apply for large arrays
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
