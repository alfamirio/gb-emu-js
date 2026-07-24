/* =========================================================================================
   emu-gb-core.js — a small, educational Game Boy (DMG) emulator core

   This is a "just play games" build: it emulates the real hardware but has none of the
   debugging, tracing, save-states, or rewind machinery a full emulator project would add
   on top. If you're reading this to learn how a Game Boy works, start with the CPU class —
   opcodes decode as bit fields, exactly like the real chip does.

     1. MMU        - memory map: ROM banking, RAM, VRAM, OAM, I/O registers
     2. CPU        - the LR35902 processor: registers, flags, instruction set
     3. PPU        - turns VRAM/OAM into the 160x144 screen image, one scanline at a time
     4. Timer      - DIV/TIMA/TMA/TAC timer circuit
     5. Joypad     - button state + joypad I/O register
     6. APU        - 4-channel sound generator (Web Audio output)
     7. GBEmulator - glues everything together and drives the main loop

   ---- Known simplifications (accepted trade-offs, not oversights) ----
   - No CGB (Game Boy Color) support — DMG only.
   - No save states / rewind — just load a ROM and play.
   - No link cable / multiplayer.
   - No MBC3 real-time clock — cart RAM banking still works, but games that use the RTC
     chip for in-game clocks/calendars (e.g. Pokémon Gold/Silver) won't track real time.
   - No MBC5 rumble motor — nothing to feel it on in a browser tab anyway.
   - HALT bug not modeled (a rare timing quirk that affects a few commercial games).
   - OAM DMA completes instantly instead of stalling the CPU for its real ~160-cycle duration.

   ---- A student's guide: how a computer works, illustrated by this file -----------------
   An "emulator" is just a program that pretends to be a piece of hardware closely enough
   that real software (here, Game Boy games) can't tell the difference. Every general idea
   below in *italics-by-description* is genuinely how real computers work — a laptop, a
   phone, and a 1989 Game Boy all use these same basic pieces, just at wildly different
   scales and speeds.

   1. THE CPU IS A LOOP THAT NEVER STOPS ("fetch-decode-execute")
      A processor doesn't "run a program" the way you might imagine — it repeats one tiny
      cycle, forever, extremely fast: read the next instruction from memory (fetch), figure
      out what it means (decode), do it (execute), then move on to the next one. See
      CPU.step() below — it is *literally* that loop, one iteration at a time. A "program"
      is nothing more than a long list of numbers in memory that the CPU interprets as
      instructions, one after another, in order (until something tells it to jump elsewhere).

   2. REGISTERS: THE CPU'S OWN, TINY, SUPER-FAST MEMORY
      Before a CPU can add two numbers, both numbers have to be somewhere the arithmetic
      circuitry can reach instantly. That "somewhere" is a small set of named storage slots
      built directly into the chip, called registers — here, A, B, C, D, E, H, L (each holds
      one byte, i.e. a number 0-255). They're not RAM; there are only a handful of them, and
      reading/writing them costs no time at all, unlike main memory. Most instructions exist
      to move data between registers and memory, or to combine two register values with
      arithmetic/logic. See the register fields at the top of the CPU class.

   3. MEMORY IS ONE GIANT NUMBERED LIST OF BYTES (an "address space")
      RAM is just a very long array where every byte has a numeric address, from 0x0000 up
      to 0xFFFF on this CPU (65,536 addresses — a 16-bit address bus). "Load the value at
      address 0x8000" and "arr[0x8000]" are the same idea. See MMU.read8()/write8() below.

   4. MEMORY-MAPPED I/O: HARDWARE THAT PRETENDS TO BE MEMORY
      Here's a trick real computers use everywhere: instead of giving the screen, sound
      chip, and buttons their own separate wiring the CPU has to know about specially, you
      give each of them a small range of addresses inside the *same* address space memory
      uses. Reading address 0xFF00 doesn't read RAM — it asks the joypad hardware "which
      buttons are pressed?" Writing 0xFF26 doesn't write RAM — it toggles the sound chip's
      power. From the CPU's point of view it's just "read/write this address" — the special
      behavior is hidden inside MMU._readIO()/_writeIO(). This is exactly how a real
      computer's keyboard controller, disk controller, and graphics card look to its CPU.

   5. THE STACK: A CPU-LEVEL "PUT THIS DOWN, I'LL COME BACK FOR IT" SCRATCHPAD
      A stack is a last-in-first-out pile of values: you can push a value onto the top, and
      later pop the most recently pushed value back off. CPUs use a stack (SP = "stack
      pointer", one more register that just holds an address) so that when code jumps into
      a subroutine, it can remember exactly where to return to afterward — push the return
      address before jumping in, pop it to jump back. See CPU._push16()/_pop16() and how
      CALL/RET use them.

   6. FLAGS: ONE-BIT ANSWERS THE CPU REMEMBERS ABOUT ITS LAST CALCULATION
      After arithmetic, a CPU records a few true/false facts about the result — "was it
      zero?", "did it carry/overflow?" — in a special flags register (here: flagZ, flagN,
      flagH, flagC). Later instructions like "jump if the last result was zero" read these
      flags instead of redoing the comparison. This is how `if`, `while`, and `for` in a
      language like JavaScript ultimately get compiled down into real machine behavior.

   7. INTERRUPTS: HOW HARDWARE "TAPS THE CPU ON THE SHOULDER"
      The CPU is busy running the game's instructions in a loop — but what happens when the
      screen finishes drawing a frame, or the player presses a button? The relevant hardware
      raises an interrupt: a signal that says "stop what you're doing, run this small handler
      routine, then go back to what you were doing." This is how a computer reacts to events
      instead of having to constantly ask "did anything happen yet?" in its main loop. See
      CPU.tryDispatchInterrupt() and the IME/IF/IE registers.

   8. CLOCKS AND CYCLES: EVERYTHING HAPPENS IN SYNCHRONIZED, COUNTED TICKS
      A chip has a clock — a signal that pulses millions of times a second (4,194,304 times/
      sec here) — and every instruction takes a fixed, known number of those pulses ("T-
      cycles") to finish. Because every component (CPU, screen, sound, timer) advances by
      the same number of cycles together, they all stay in lockstep, exactly as the real
      chips inside a Game Boy's circuit board do. See GBEmulator.stepHardware() — after
      every instruction, all the other chips are told "that took N cycles, catch up."

   9. RENDERING A SCREEN IS DRAWING ONE LINE AT A TIME, OVER AND OVER
      Old displays (and this one, faithfully) don't compute a whole image at once — they
      generate it top row to bottom row, ~60 times a second, exactly like the electron beam
      in a CRT swept across each scanline. See the PPU class: it tracks "which line am I
      drawing right now" (LY) and produces one row of 160 pixels at a time.

   With those nine ideas in hand, the rest of this file is just "which specific numbers does
   *this specific 1989 chip* use for all of the above" — the interesting conceptual work is
   already done above.
   ========================================================================================= */

/* ============================== 0. Hardware constants =================================== */
const EMU_CORE_CONFIG = {
  CLOCK_HZ: 4194304, // T-cycles/second

  FRAME: {
    VISIBLE_LINES: 144,
    VBLANK_LINES: 10,
    CYCLES_PER_LINE: 456,
    get TOTAL_LINES() { return this.VISIBLE_LINES + this.VBLANK_LINES; },        // 154
    get CYCLES_PER_FRAME() { return this.CYCLES_PER_LINE * this.TOTAL_LINES; },  // 70224
  },

  // Cycle length per PPU mode. OAM_SEARCH is fixed; PIXEL_TRANSFER_BASE/HBLANK are the
  // *floor* mode-3/mode-0 lengths — real hardware stretches mode 3 (and shrinks mode 0 to
  // compensate) based on scroll and sprites, so PPU.step() computes the real per-scanline
  // split at runtime. See PPU._mode3Length().
  PPU_MODE_CYCLES: {
    OAM_SEARCH: 80,           // mode 2
    PIXEL_TRANSFER_BASE: 172, // mode 3 floor
    HBLANK: 204,              // mode 0 floor
  },

  SCREEN: { WIDTH: 160, HEIGHT: 144 },

  SPRITES: { MAX_TOTAL: 40, MAX_PER_LINE: 10, HEIGHT_SMALL: 8, HEIGHT_TALL: 16 },

  TIMER: {
    TIMA_PERIOD: [1024, 16, 64, 256], // T-cycles per TIMA tick, indexed by TAC[1:0]
    DIV_PERIOD: 256,
  },

  OAM_DMA_BYTES: 0xA0,

  // Neutral grayscale palette, as used by the Game Boy Pocket (GBP).
  PALETTE_GBP: [[255, 255, 255], [169, 169, 169], [84, 84, 84], [0, 0, 0]],

  // First address *past* each region: region is [prevEnd, thisEnd).
  MEMORY: {
    ROM0_END: 0x4000, ROMX_END: 0x8000, VRAM_END: 0xA000, ERAM_END: 0xC000,
    WRAM_END: 0xE000, ECHO_END: 0xFE00, OAM_END: 0xFEA0, UNUSABLE_END: 0xFF00,
    IO_END: 0xFF80, HRAM_END: 0xFFFF,
    ROM_BANK_SIZE: 0x4000, RAM_BANK_SIZE: 0x2000,
    VRAM_SIZE: 0x2000, WRAM_SIZE: 0x2000, OAM_SIZE: 0xA0, HRAM_SIZE: 0x7F, IO_SIZE: 0x80,
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

/* ============================== 1. MMU (Memory Management Unit) =========================
   The MMU is the "address space" from primer idea #3 and the "memory-mapped I/O" trick
   from idea #4, both made concrete. Every read/write the CPU ever does — for data, for
   code, for talking to the screen or buttons — funnels through read8()/write8() below.
   That's the whole trick of memory-mapped I/O: the CPU doesn't know or care whether an
   address is "real" RAM or secretly a piece of hardware; the MMU decides that per-address.

   One extra wrinkle specific to old cartridge-based systems: a 16-bit address can only
   reach 65,536 bytes, but many Game Boy games are bigger than that. The cartridge solves
   this with a Memory Bank Controller (MBC) chip — a middleman that lets the game swap
   which chunk ("bank") of its own ROM is currently visible at a given address range, sort
   of like a bookshelf where only one book's pages are open at a time, but you can flip to
   a different book whenever you want. See _handleBanking() below.
   ========================================================================================= */

class MMU {
  constructor(emulator) {
    this.emulator = emulator;

    this.rom = new Uint8Array(0);
    this.mbcType = 0;        // 0 = ROM only, 1 = MBC1, 2 = MBC2, 3 = MBC3, 5 = MBC5
    this._resetBankingRegisters();

    this.cartRAM = new Uint8Array(EMU_CORE_CONFIG.MEMORY.CART_RAM_SIZE);

    const MEM = EMU_CORE_CONFIG.MEMORY;
    this.vram = new Uint8Array(MEM.VRAM_SIZE);
    this.wram = new Uint8Array(MEM.WRAM_SIZE);
    this.oam  = new Uint8Array(MEM.OAM_SIZE);
    this.hram = new Uint8Array(MEM.HRAM_SIZE);
    this.io   = new Uint8Array(MEM.IO_SIZE);
    this.ie   = 0; // 0xFFFF interrupt enable register
  }

  // MBC bank-select defaults: bank 1 is mapped at boot (bank 0 can't be selected into
  // 0x4000-0x7FFF), everything else starts zeroed.
  _resetBankingRegisters() {
    this.currentROMBank = 1;
    this.currentRAMBank = 0;
    this.ramEnabled = false;
    this.bankingMode = 0;    // MBC1: 0 = ROM banking mode, 1 = RAM banking mode
  }

  // Detects the MBC type from the cartridge header (byte 0x147) and resets banking state.
  // Note: this only needs to know which *banking scheme* a cart uses (MBC1/2/3/5) — extra
  // hardware some carts also carry (a real-time clock on some MBC3 carts, a rumble motor on
  // some MBC5 carts) isn't emulated, since it's not needed to run the game itself.
  _detectCartType(bytes) {
    const cartType = bytes[0x147];
    if (cartType === 0x00) this.mbcType = 0;
    else if (cartType >= 0x01 && cartType <= 0x03) this.mbcType = 1;
    else if (cartType === 0x05 || cartType === 0x06) this.mbcType = 2;
    else if (cartType >= 0x0F && cartType <= 0x13) this.mbcType = 3;
    else if (cartType >= 0x19 && cartType <= 0x1E) this.mbcType = 5;
    else this.mbcType = 1; // unknown mapper: best-effort MBC1 fallback

    this._resetBankingRegisters();
  }

  loadROM(bytes) {
    this.rom = bytes;
    this._detectCartType(bytes);

    const bootIO = EMU_CORE_CONFIG.BOOT.IO;
    this.io.fill(0);
    this.io[0x00] = bootIO.P1;
    this.io[0x0F] = bootIO.IF;
    this.io[0x40] = bootIO.LCDC;
    this.io[0x47] = bootIO.BGP;
    this.io[0x48] = bootIO.OBP0;
    this.io[0x49] = bootIO.OBP1;
  }

  read8(addr) {
    addr &= 0xFFFF;
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROM0_END) return this.rom[addr] ?? 0xFF;                              // ROM bank 0
    if (addr < MEM.ROMX_END) return this.rom[this.currentROMBank * MEM.ROM_BANK_SIZE + (addr - MEM.ROM0_END)] ?? 0xFF; // switchable ROM bank
    if (addr < MEM.VRAM_END) return this.vram[addr - MEM.ROMX_END];
    if (addr < MEM.ERAM_END) {
      if (this.mbcType === 2) {
        if (!this.ramEnabled) return 0xFF;
        // MBC2's built-in RAM is only 512 nibbles, mirrored across 0xA000-0xBFFF; only 4
        // data lines are wired up, so the upper nibble always reads back as 1s.
        return 0xF0 | (this.cartRAM[addr & 0x1FF] & 0x0F);
      }
      return this.ramEnabled ? this.cartRAM[this.currentRAMBank * MEM.RAM_BANK_SIZE + (addr - MEM.VRAM_END)] : 0xFF;
    }
    if (addr < MEM.WRAM_END) return this.wram[addr - MEM.ERAM_END];
    if (addr < MEM.ECHO_END) return this.wram[addr - MEM.WRAM_END]; // echo of WRAM
    if (addr < MEM.OAM_END) return this.oam[addr - MEM.ECHO_END];
    if (addr < MEM.UNUSABLE_END) return 0xFF;
    if (addr < MEM.IO_END) return this._readIO(addr);
    if (addr < MEM.HRAM_END) return this.hram[addr - MEM.IO_END];
    return this.ie;
  }

  write8(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    const MEM = EMU_CORE_CONFIG.MEMORY;
    if (addr < MEM.ROMX_END) { this._handleBanking(addr, val); return; } // writes here talk to the MBC, not ROM
    if (addr < MEM.VRAM_END) { this.vram[addr - MEM.ROMX_END] = val; return; }
    if (addr < MEM.ERAM_END) {
      if (this.mbcType === 2) { if (this.ramEnabled) this.cartRAM[addr & 0x1FF] = val & 0x0F; return; }
      if (this.ramEnabled) this.cartRAM[this.currentRAMBank * MEM.RAM_BANK_SIZE + (addr - MEM.VRAM_END)] = val;
      return;
    }
    if (addr < MEM.WRAM_END) { this.wram[addr - MEM.ERAM_END] = val; return; }
    if (addr < MEM.ECHO_END) { this.wram[addr - MEM.WRAM_END] = val; return; }
    if (addr < MEM.OAM_END) { this.oam[addr - MEM.ECHO_END] = val; return; }
    if (addr < MEM.UNUSABLE_END) return; // unusable region: writes ignored
    if (addr < MEM.IO_END) { this._writeIO(addr, val); return; }
    if (addr < MEM.HRAM_END) { this.hram[addr - MEM.IO_END] = val; return; }
    this.ie = val;
  }

  // Writes to 0x0000-0x7FFF don't touch ROM — they're commands to the cartridge's Memory
  // Bank Controller, which switches which ROM/RAM bank is currently mapped in.
  _handleBanking(addr, val) {
    if (this.mbcType === 0) return; // no MBC: nothing to switch

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
        // 0x00-0x03 selects a cart-RAM bank. (Real MBC3+RTC cartridges also accept
        // 0x08-0x0C here to map in a real-time-clock register instead of RAM — this
        // simplified core doesn't emulate that clock chip, so those values are ignored.)
        if (val <= 0x03) this.currentRAMBank = val;
      }
      // (0x6000-0x7FFF latches the RTC snapshot on real MBC3+RTC hardware; not needed here.)
    } else if (this.mbcType === 5) {
      // Full 9-bit ROM bank number across two registers; unlike MBC1/2/3, bank 0 is valid here.
      if (addr < 0x2000) {
        this.ramEnabled = (val & 0x0F) === 0x0A;
      } else if (addr < 0x3000) {
        this.currentROMBank = (this.currentROMBank & 0x100) | val; // low 8 bits
      } else if (addr < 0x4000) {
        this.currentROMBank = (this.currentROMBank & 0xFF) | ((val & 0x01) << 8); // bit 8
      } else if (addr < 0x6000) {
        this.currentRAMBank = val & 0x0F;
      }
    }
  }

  _readIO(addr) {
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

  _writeIO(addr, val) {
    const reg = addr & 0xFF;
    if (reg >= 0x10 && reg <= 0x3F) { this.emulator.apu.write(0xFF00 | reg, val); return; }
    switch (reg) {
      case 0x00: this.emulator.joypad.write(val); return;
      case 0x04: this.emulator.timer.div = 0; return;  // any write resets DIV
      case 0x05: this.emulator.timer.tima = val; return;
      case 0x06: this.emulator.timer.tma = val; return;
      case 0x07: this.emulator.timer.tac = val & 0x07; return;
      case 0x41: this.io[reg] = (this.io[reg] & 0x07) | (val & 0xF8); return; // STAT: low 3 bits are hardware-controlled
      case 0x44: this.io[reg] = 0; return; // writing LY resets it
      case 0x46: this._doDMA(val); return; // OAM DMA
      default:   this.io[reg] = val; return;
    }
  }

  // OAM DMA: copies 160 bytes from XX00-XX9F into OAM. Real hardware takes 160 cycles and
  // blocks memory access meanwhile; done instantly here.
  _doDMA(val) {
    const src = val << 8;
    for (let i = 0; i < EMU_CORE_CONFIG.OAM_DMA_BYTES; i++) this.oam[i] = this.read8(src + i);
  }
}

/* ==================================== 2. CPU (LR35902) ===================================
   This is primer ideas #1, #2, #5, #6, and #7 all in one class. The LR35902 (the Game
   Boy's processor) is a close cousin of the famous Z80/8080 chip family, so this class is
   a reasonable introduction to "what a real, simple CPU actually looks like inside":

     - The register fields (A, B, C, D, E, H, L, SP, PC) *are* the whole "CPU state" —
       everything the processor currently knows, other than what's out in main memory.
     - PC ("program counter") is the register that says "which instruction is next" — it's
       what makes the fetch-decode-execute loop in step() advance through a program.
     - execute() is the "decode" step: it looks at the numeric opcode it just fetched and
       works out which specific operation (add, jump, load, ...) that number represents,
       then performs it. Real CPU chips do this same lookup in hardware, using circuitry
       instead of a switch statement — but the logical operation is identical.
   ========================================================================================= */

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

  /* ---- small helpers ---- */
  tick(n) { this.cycles += n; }
  toSigned8(v) { return (v & 0x80) ? v - 256 : v; }

  _getF() { return (this.flagZ ? 0x80 : 0) | (this.flagN ? 0x40 : 0) | (this.flagH ? 0x20 : 0) | (this.flagC ? 0x10 : 0); }
  _setF(v) { this.flagZ = !!(v & 0x80); this.flagN = !!(v & 0x40); this.flagH = !!(v & 0x20); this.flagC = !!(v & 0x10); }

  getBC() { return (this.B << 8) | this.C; }  _setBC(v) { this.B = (v >> 8) & 0xFF; this.C = v & 0xFF; }
  getDE() { return (this.D << 8) | this.E; }  _setDE(v) { this.D = (v >> 8) & 0xFF; this.E = v & 0xFF; }
  getHL() { return (this.H << 8) | this.L; }  _setHL(v) { this.H = (v >> 8) & 0xFF; this.L = v & 0xFF; }
  _getAF() { return (this.A << 8) | this._getF(); } _setAF(v) { this.A = (v >> 8) & 0xFF; this._setF(v & 0xFF); }

  // 8-bit register field used throughout the opcode table: 0=B 1=C 2=D 3=E 4=H 5=L 6=(HL) 7=A
  _getReg8(i) {
    switch (i) {
      case 0: return this.B; case 1: return this.C; case 2: return this.D; case 3: return this.E;
      case 4: return this.H; case 5: return this.L; case 6: return this.mmu.read8(this.getHL()); case 7: return this.A;
    }
  }
  _setReg8(i, v) {
    v &= 0xFF;
    switch (i) {
      case 0: this.B = v; break; case 1: this.C = v; break; case 2: this.D = v; break; case 3: this.E = v; break;
      case 4: this.H = v; break; case 5: this.L = v; break; case 6: this.mmu.write8(this.getHL(), v); break; case 7: this.A = v; break;
    }
  }

  _fetch8() { const v = this.mmu.read8(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
  _fetch16() { const lo = this._fetch8(); const hi = this._fetch8(); return (hi << 8) | lo; }

  _push16(v) { this.SP = (this.SP - 1) & 0xFFFF; this.mmu.write8(this.SP, (v >> 8) & 0xFF); this.SP = (this.SP - 1) & 0xFFFF; this.mmu.write8(this.SP, v & 0xFF); }
  _pop16() { const lo = this.mmu.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; const hi = this.mmu.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; return (hi << 8) | lo; }

  /* ---- arithmetic / logic (each updates the flag register) ---- */
  _add8(v) { const a = this.A, r = a + v; this.flagH = (a & 0xF) + (v & 0xF) > 0xF; this.flagC = r > 0xFF; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = false; }
  _adc8(v) { const a = this.A, c = this.flagC ? 1 : 0, r = a + v + c; this.flagH = (a & 0xF) + (v & 0xF) + c > 0xF; this.flagC = r > 0xFF; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = false; }
  _sub8(v) { const a = this.A, r = a - v; this.flagH = (a & 0xF) < (v & 0xF); this.flagC = r < 0; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = true; }
  _sbc8(v) { const a = this.A, c = this.flagC ? 1 : 0, r = a - v - c; this.flagH = (a & 0xF) - (v & 0xF) - c < 0; this.flagC = r < 0; this.A = r & 0xFF; this.flagZ = this.A === 0; this.flagN = true; }
  _and8(v) { this.A &= v; this.flagZ = this.A === 0; this.flagN = false; this.flagH = true; this.flagC = false; }
  _xor8(v) { this.A ^= v; this.flagZ = this.A === 0; this.flagN = false; this.flagH = false; this.flagC = false; }
  _or8(v)  { this.A |= v; this.flagZ = this.A === 0; this.flagN = false; this.flagH = false; this.flagC = false; }
  _cp8(v)  { const a = this.A, r = a - v; this.flagH = (a & 0xF) < (v & 0xF); this.flagC = r < 0; this.flagZ = (r & 0xFF) === 0; this.flagN = true; }
  _inc8(v) { const r = (v + 1) & 0xFF; this.flagH = (v & 0xF) === 0xF; this.flagZ = r === 0; this.flagN = false; return r; }
  _dec8(v) { const r = (v - 1) & 0xFF; this.flagH = (v & 0xF) === 0x0; this.flagZ = r === 0; this.flagN = true; return r; }

  _addHL(v) { const hl = this.getHL(), r = hl + v; this.flagH = (hl & 0xFFF) + (v & 0xFFF) > 0xFFF; this.flagC = r > 0xFFFF; this._setHL(r & 0xFFFF); this.flagN = false; }
  _addSPr8(offset) {
    const sp = this.SP, r = (sp + offset) & 0xFFFF;
    this.flagZ = false; this.flagN = false;
    this.flagH = (sp & 0xF) + (offset & 0xF) > 0xF;
    this.flagC = (sp & 0xFF) + (offset & 0xFF) > 0xFF;
    return r;
  }

  _aluOp(op, v) {
    switch (op) {
      case 0: this._add8(v); break; case 1: this._adc8(v); break; case 2: this._sub8(v); break; case 3: this._sbc8(v); break;
      case 4: this._and8(v); break; case 5: this._xor8(v); break; case 6: this._or8(v); break;  case 7: this._cp8(v); break;
    }
  }

  // Decimal-adjust after an 8-bit add/sub so arithmetic on BCD values (e.g. a two-digit
  // score) yields correct decimal digits instead of raw hex.
  _daa() {
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
  _rlc(v) { const c = !!(v & 0x80); const r = ((v << 1) | (c ? 1 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  _rrc(v) { const c = !!(v & 0x01); const r = ((v >> 1) | (c ? 0x80 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  _rl(v)  { const c = !!(v & 0x80); const r = ((v << 1) | (this.flagC ? 1 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  _rr(v)  { const c = !!(v & 0x01); const r = ((v >> 1) | (this.flagC ? 0x80 : 0)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  _sla(v) { const c = !!(v & 0x80); const r = (v << 1) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  _sra(v) { const c = !!(v & 0x01); const r = ((v >> 1) | (v & 0x80)) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  _swap(v){ const r = ((v << 4) | (v >> 4)) & 0xFF; this.flagC = false; this.flagN = false; this.flagH = false; return r; }
  _srl(v) { const c = !!(v & 0x01); const r = (v >> 1) & 0xFF; this.flagC = c; this.flagN = false; this.flagH = false; return r; }
  _rotOp(op, v) {
    switch (op) {
      case 0: return this._rlc(v); case 1: return this._rrc(v); case 2: return this._rl(v); case 3: return this._rr(v);
      case 4: return this._sla(v); case 5: return this._sra(v); case 6: return this._swap(v); case 7: return this._srl(v);
    }
  }

  _checkCond(cc) { switch (cc) { case 0: return !this.flagZ; case 1: return this.flagZ; case 2: return !this.flagC; case 3: return this.flagC; } }

  // ---- The fetch-decode-execute loop (primer idea #1), one iteration per call ----
  // fetch:   this._fetch8() below reads the byte at PC and advances PC past it.
  // decode:  execute(opcode) works out which operation that byte number represents.
  // execute: ...and execute() performs it (and, for most opcodes, its decoded operands).
  // Returns how many T-cycles that one instruction took, so the caller can advance every
  // other chip (PPU/Timer/APU) by the same amount — see GBEmulator.stepHardware().
  step() {
    if (this.eiDelay > 0) { this.eiDelay--; if (this.eiDelay === 0) this.IME = true; }
    this.cycles = 0;

    // Checked right after the eiDelay transition, before fetching this step's opcode:
    // EI takes effect exactly on this boundary, so a following DI can't mask the interrupt.
    if (this.tryDispatchInterrupt()) return this.cycles;

    if (this.halted) {
      this.tick(4);
    } else {
      const opcode = this._fetch8();
      this.execute(opcode);
    }
    this._wakeFromHaltIfPending();
    return this.cycles;
  }

  // Level-sensitive HALT wake: exits on any pending (IF & IE), regardless of IME.
  _wakeFromHaltIfPending() {
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
        this._push16(this.PC);
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
      this._setReg8(dst, this._getReg8(src));
      this.tick((dst === 6 || src === 6) ? 8 : 4);
      return;
    }
    // 0x80-0xBF: ALU A,r (ADD/ADC/SUB/SBC/AND/XOR/OR/CP)
    if (opcode >= 0x80 && opcode <= 0xBF) {
      const op = (opcode >> 3) & 7, src = opcode & 7;
      this._aluOp(op, this._getReg8(src));
      this.tick(src === 6 ? 8 : 4);
      return;
    }
    // INC r / DEC r / LD r,d8 share the same row pattern across 0x04-0x3E
    if ((opcode & 0xC7) === 0x04) { const r = (opcode >> 3) & 7; this._setReg8(r, this._inc8(this._getReg8(r))); this.tick(r === 6 ? 12 : 4); return; }
    if ((opcode & 0xC7) === 0x05) { const r = (opcode >> 3) & 7; this._setReg8(r, this._dec8(this._getReg8(r))); this.tick(r === 6 ? 12 : 4); return; }
    if ((opcode & 0xC7) === 0x06) { const r = (opcode >> 3) & 7; this._setReg8(r, this._fetch8());             this.tick(r === 6 ? 12 : 8); return; }

    switch (opcode) {
      case 0x00: this.tick(4); break; // NOP

      case 0x01: this._setBC(this._fetch16()); this.tick(12); break;
      case 0x02: this.mmu.write8(this.getBC(), this.A); this.tick(8); break;
      case 0x03: this._setBC((this.getBC() + 1) & 0xFFFF); this.tick(8); break;
      case 0x07: this.A = this._rlc(this.A); this.flagZ = false; this.tick(4); break;
      case 0x08: { const addr = this._fetch16(); this.mmu.write8(addr, this.SP & 0xFF); this.mmu.write8(addr + 1, (this.SP >> 8) & 0xFF); this.tick(20); break; }
      case 0x09: this._addHL(this.getBC()); this.tick(8); break;
      case 0x0A: this.A = this.mmu.read8(this.getBC()); this.tick(8); break;
      case 0x0B: this._setBC((this.getBC() - 1) & 0xFFFF); this.tick(8); break;
      case 0x0F: this.A = this._rrc(this.A); this.flagZ = false; this.tick(4); break;

      case 0x10: this.PC = (this.PC + 1) & 0xFFFF; this.tick(4); break; // STOP (2-byte opcode, simplified)
      case 0x11: this._setDE(this._fetch16()); this.tick(12); break;
      case 0x12: this.mmu.write8(this.getDE(), this.A); this.tick(8); break;
      case 0x13: this._setDE((this.getDE() + 1) & 0xFFFF); this.tick(8); break;
      case 0x17: this.A = this._rl(this.A); this.flagZ = false; this.tick(4); break;
      case 0x18: { const off = this.toSigned8(this._fetch8()); this.PC = (this.PC + off) & 0xFFFF; this.tick(12); break; }
      case 0x19: this._addHL(this.getDE()); this.tick(8); break;
      case 0x1A: this.A = this.mmu.read8(this.getDE()); this.tick(8); break;
      case 0x1B: this._setDE((this.getDE() - 1) & 0xFFFF); this.tick(8); break;
      case 0x1F: this.A = this._rr(this.A); this.flagZ = false; this.tick(4); break;

      case 0x20: { const off = this.toSigned8(this._fetch8()); if (!this.flagZ) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x21: this._setHL(this._fetch16()); this.tick(12); break;
      case 0x22: this.mmu.write8(this.getHL(), this.A); this._setHL((this.getHL() + 1) & 0xFFFF); this.tick(8); break;
      case 0x23: this._setHL((this.getHL() + 1) & 0xFFFF); this.tick(8); break;
      case 0x27: this._daa(); this.tick(4); break;
      case 0x28: { const off = this.toSigned8(this._fetch8()); if (this.flagZ) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x29: this._addHL(this.getHL()); this.tick(8); break;
      case 0x2A: this.A = this.mmu.read8(this.getHL()); this._setHL((this.getHL() + 1) & 0xFFFF); this.tick(8); break;
      case 0x2B: this._setHL((this.getHL() - 1) & 0xFFFF); this.tick(8); break;
      case 0x2F: this.A = (~this.A) & 0xFF; this.flagN = true; this.flagH = true; this.tick(4); break;

      case 0x30: { const off = this.toSigned8(this._fetch8()); if (!this.flagC) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x31: this.SP = this._fetch16(); this.tick(12); break;
      case 0x32: this.mmu.write8(this.getHL(), this.A); this._setHL((this.getHL() - 1) & 0xFFFF); this.tick(8); break;
      case 0x33: this.SP = (this.SP + 1) & 0xFFFF; this.tick(8); break;
      case 0x37: this.flagC = true; this.flagN = false; this.flagH = false; this.tick(4); break;
      case 0x38: { const off = this.toSigned8(this._fetch8()); if (this.flagC) { this.PC = (this.PC + off) & 0xFFFF; this.tick(12); } else this.tick(8); break; }
      case 0x39: this._addHL(this.SP); this.tick(8); break;
      case 0x3A: this.A = this.mmu.read8(this.getHL()); this._setHL((this.getHL() - 1) & 0xFFFF); this.tick(8); break;
      case 0x3B: this.SP = (this.SP - 1) & 0xFFFF; this.tick(8); break;
      case 0x3F: this.flagC = !this.flagC; this.flagN = false; this.flagH = false; this.tick(4); break;

      case 0xC0: if (!this.flagZ) { this.PC = this._pop16(); this.tick(20); } else this.tick(8); break;
      case 0xC1: this._setBC(this._pop16()); this.tick(12); break;
      case 0xC2: { const addr = this._fetch16(); if (!this.flagZ) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xC3: this.PC = this._fetch16(); this.tick(16); break;
      case 0xC4: { const addr = this._fetch16(); if (!this.flagZ) { this._push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xC5: this._push16(this.getBC()); this.tick(16); break;
      case 0xC6: this._add8(this._fetch8()); this.tick(8); break;
      case 0xC7: this._push16(this.PC); this.PC = 0x00; this.tick(16); break;
      case 0xC8: if (this.flagZ) { this.PC = this._pop16(); this.tick(20); } else this.tick(8); break;
      case 0xC9: this.PC = this._pop16(); this.tick(16); break;
      case 0xCA: { const addr = this._fetch16(); if (this.flagZ) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xCB: this._executeCB(this._fetch8()); break;
      case 0xCC: { const addr = this._fetch16(); if (this.flagZ) { this._push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xCD: { const addr = this._fetch16(); this._push16(this.PC); this.PC = addr; this.tick(24); break; }
      case 0xCE: this._adc8(this._fetch8()); this.tick(8); break;
      case 0xCF: this._push16(this.PC); this.PC = 0x08; this.tick(16); break;

      case 0xD0: if (!this.flagC) { this.PC = this._pop16(); this.tick(20); } else this.tick(8); break;
      case 0xD1: this._setDE(this._pop16()); this.tick(12); break;
      case 0xD2: { const addr = this._fetch16(); if (!this.flagC) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xD4: { const addr = this._fetch16(); if (!this.flagC) { this._push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xD5: this._push16(this.getDE()); this.tick(16); break;
      case 0xD6: this._sub8(this._fetch8()); this.tick(8); break;
      case 0xD7: this._push16(this.PC); this.PC = 0x10; this.tick(16); break;
      case 0xD8: if (this.flagC) { this.PC = this._pop16(); this.tick(20); } else this.tick(8); break;
      case 0xD9: this.PC = this._pop16(); this.IME = true; this.tick(16); break; // RETI
      case 0xDA: { const addr = this._fetch16(); if (this.flagC) { this.PC = addr; this.tick(16); } else this.tick(12); break; }
      case 0xDC: { const addr = this._fetch16(); if (this.flagC) { this._push16(this.PC); this.PC = addr; this.tick(24); } else this.tick(12); break; }
      case 0xDE: this._sbc8(this._fetch8()); this.tick(8); break;
      case 0xDF: this._push16(this.PC); this.PC = 0x18; this.tick(16); break;

      case 0xE0: { const addr = 0xFF00 + this._fetch8(); this.mmu.write8(addr, this.A); this.tick(12); break; }
      case 0xE1: this._setHL(this._pop16()); this.tick(12); break;
      case 0xE2: this.mmu.write8(0xFF00 + this.C, this.A); this.tick(8); break;
      case 0xE5: this._push16(this.getHL()); this.tick(16); break;
      case 0xE6: this._and8(this._fetch8()); this.tick(8); break;
      case 0xE7: this._push16(this.PC); this.PC = 0x20; this.tick(16); break;
      case 0xE8: { const off = this.toSigned8(this._fetch8()); this.SP = this._addSPr8(off); this.tick(16); break; }
      case 0xE9: this.PC = this.getHL(); this.tick(4); break;
      case 0xEA: { const addr = this._fetch16(); this.mmu.write8(addr, this.A); this.tick(16); break; }
      case 0xEE: this._xor8(this._fetch8()); this.tick(8); break;
      case 0xEF: this._push16(this.PC); this.PC = 0x28; this.tick(16); break;

      case 0xF0: { const addr = 0xFF00 + this._fetch8(); this.A = this.mmu.read8(addr); this.tick(12); break; }
      case 0xF1: this._setAF(this._pop16() & 0xFFF0); this.tick(12); break;
      case 0xF2: this.A = this.mmu.read8(0xFF00 + this.C); this.tick(8); break;
      case 0xF3: this.IME = false; this.eiDelay = 0; this.tick(4); break; // DI
      case 0xF5: this._push16(this._getAF()); this.tick(16); break;
      case 0xF6: this._or8(this._fetch8()); this.tick(8); break;
      case 0xF7: this._push16(this.PC); this.PC = 0x30; this.tick(16); break;
      case 0xF8: { const off = this.toSigned8(this._fetch8()); this._setHL(this._addSPr8(off)); this.tick(12); break; }
      case 0xF9: this.SP = this.getHL(); this.tick(8); break;
      case 0xFA: { const addr = this._fetch16(); this.A = this.mmu.read8(addr); this.tick(16); break; }
      case 0xFB: this.eiDelay = 2; this.tick(4); break; // EI (delayed by one instruction)
      case 0xFE: this._cp8(this._fetch8()); this.tick(8); break;
      case 0xFF: this._push16(this.PC); this.PC = 0x38; this.tick(16); break;

      default:
        console.warn('Unimplemented opcode 0x' + opcode.toString(16) + ' at PC=0x' + ((this.PC - 1) & 0xFFFF).toString(16));
        this.tick(4);
        break;
    }
  }

  // CB-prefixed ops are an 8x8 bit-field grid: rotate/shift (00-3F), then BIT (40-7F),
  // RES (80-BF), SET (C0-FF) — each column selecting one of B,C,D,E,H,L,(HL),A.
  _executeCB(opcode) {
    const op = (opcode >> 3) & 7, r = opcode & 7;
    const val = this._getReg8(r);
    if (opcode < 0x40) {
      const result = this._rotOp(op, val);
      this.flagZ = result === 0;
      this._setReg8(r, result);
      this.tick(r === 6 ? 16 : 8);
    } else if (opcode < 0x80) { // BIT b,r
      this.flagZ = ((val >> op) & 1) === 0;
      this.flagN = false; this.flagH = true;
      this.tick(r === 6 ? 12 : 8);
    } else if (opcode < 0xC0) { // RES b,r
      this._setReg8(r, val & ~(1 << op));
      this.tick(r === 6 ? 16 : 8);
    } else { // SET b,r
      this._setReg8(r, val | (1 << op));
      this.tick(r === 6 ? 16 : 8);
    }
  }
}

/* ==================================== 3. PPU (graphics) ===================================
   The PPU ("Picture Processing Unit") is a second, independent processor running alongside
   the CPU — it doesn't execute game code, it just continuously turns the bytes sitting in
   VRAM/OAM into pixels, line by line (primer idea #9). "Independent" is the key word: the
   CPU and PPU tick forward together (both are handed the same cycle counts every step —
   see GBEmulator.stepHardware()), but they're doing two completely different jobs at once.
   This same division of labor — one chip running program logic, another dedicated purely
   to producing the picture — is the ancestor of the CPU/GPU split in every modern computer.

   VRAM holds tile graphics data (small 8x8-pixel image tiles) and a "tile map" that says
   which tile goes in which grid cell of the background; OAM ("Object Attribute Memory")
   holds the position/appearance of up to 40 movable sprites. The PPU reads both every
   frame and composites them into the framebuffer a UI can display.
   ========================================================================================= */

// Sign-extends an 8-bit tile index, used when LCDC.4 selects the signed 0x9000-relative
// tile data area.
function toSigned8(v) { return (v & 0x80) ? v - 256 : v; }

// Writes one RGBA pixel into the framebuffer.
function setFramebufferPixel(framebuffer, x, y, r, g, b) {
  const i = (y * EMU_CORE_CONFIG.SCREEN.WIDTH + x) * 4;
  framebuffer[i] = r; framebuffer[i + 1] = g; framebuffer[i + 2] = b; framebuffer[i + 3] = 255;
}

class PPU {
  static SHADES = EMU_CORE_CONFIG.PALETTE_GBP;
  static _compareSpritePriority(a, b) { return (b.spriteX - a.spriteX) || (b.oamIndex - a.oamIndex); }

  constructor(emulator) {
    this.emulator = emulator;
    this.mmu = emulator.mmu;
    this.modeClock = 0;
    this.mode = 2;
    this.windowLineCounter = 0;
    // This scanline's mode-3 (pixel transfer) length, locked in the instant mode 3 starts
    // (see _mode3Length()); defaults to the bare-minimum length until the first OAM search
    // completes.
    this._curMode3Length = EMU_CORE_CONFIG.PPU_MODE_CYCLES.PIXEL_TRANSFER_BASE;
    this.framebuffer = new Uint8ClampedArray(EMU_CORE_CONFIG.SCREEN.WIDTH * EMU_CORE_CONFIG.SCREEN.HEIGHT * 4);

    // Reused every getSpriteCandidatesForLine() call instead of allocating: a fixed array
    // plus one fixed slot object per hardware sprites-per-line slot.
    this._spriteCandidates = [];
    this._spriteSlotPool = Array.from({ length: EMU_CORE_CONFIG.SPRITES.MAX_PER_LINE },
      () => ({ spriteY: 0, spriteX: 0, tileIndex: 0, attrs: 0, oamIndex: 0 }));
  }

  // Approximates real hardware's variable mode-3 (pixel transfer) length for the upcoming
  // scanline: a fixed 172-cycle floor, stretched by fine-scroll discard (SCX % 8), by each
  // sprite visible on the line, and by the window turning on this line. Games commonly time
  // their HBlank/STAT interrupt handlers against the *real* per-scanline length, so treating
  // mode 3 as always exactly 172 cycles would fire those interrupts a few cycles early/late.
  _mode3Length() {
    const MODE = EMU_CORE_CONFIG.PPU_MODE_CYCLES;
    let length = MODE.PIXEL_TRANSFER_BASE + (this.scx & 7);

    if (this.lcdc & 0x02) { // OBJ enabled
      const SPR = EMU_CORE_CONFIG.SPRITES;
      const spriteHeight = (this.lcdc & 0x04) ? SPR.HEIGHT_TALL : SPR.HEIGHT_SMALL;
      const candidates = this.getSpriteCandidatesForLine(this.ly, spriteHeight);
      for (const s of candidates) length += 11 - Math.min(5, (s.spriteX + this.scx) & 7);
    }

    if ((this.lcdc & 0x20) && this.ly >= this.wy && this.wx <= 166) length += 6; // window active this line

    return length;
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
    if (!(this.lcdc & 0x80)) { this.modeClock = 0; this.ly = 0; this.mode = 0; this._setStatMode(0); return; }

    const MODE = EMU_CORE_CONFIG.PPU_MODE_CYCLES, FRAME = EMU_CORE_CONFIG.FRAME;
    this.modeClock += cycles;
    switch (this.mode) {
      case 2: // OAM search
        if (this.modeClock >= MODE.OAM_SEARCH) {
          this.modeClock -= MODE.OAM_SEARCH;
          this.mode = 3; this._setStatMode(3); // no STAT interrupt source for mode 3, but the
                                                // register's mode bits still need to reflect it
          this._curMode3Length = this._mode3Length();
        }
        break;

      case 3: // pixel transfer
        if (this.modeClock >= this._curMode3Length) {
          this.modeClock -= this._curMode3Length;
          this.mode = 0; this._setStatMode(0);
          this._renderScanline();
          this._checkStatInterrupt(0x08);
        }
        break;

      case 0: { // HBlank
        // Mode 0 shrinks/grows to absorb whatever mode 3 didn't spend of/spent beyond its
        // base length, so OAM_SEARCH + mode3 + mode0 always totals 456 cycles for this line.
        const hblankLength = MODE.HBLANK + (MODE.PIXEL_TRANSFER_BASE - this._curMode3Length);
        if (this.modeClock >= hblankLength) {
          this.modeClock -= hblankLength;
          this.ly++;
          this._checkLYC();
          if (this.ly === FRAME.VISIBLE_LINES) {
            this.mode = 1; this._setStatMode(1);
            this.emulator.requestInterrupt(0); // VBlank interrupt
            this._checkStatInterrupt(0x10);
            this.emulator.frameReady = true;
          } else {
            this.mode = 2; this._setStatMode(2);
            this._checkStatInterrupt(0x20);
          }
        }
        break;
      }

      case 1: // VBlank (10 lines, each one line's worth of cycles)
        if (this.modeClock >= FRAME.CYCLES_PER_LINE) {
          this.modeClock -= FRAME.CYCLES_PER_LINE;
          this.ly++;
          if (this.ly > FRAME.TOTAL_LINES - 1) {
            this.ly = 0; this.windowLineCounter = 0;
            this.mode = 2; this._setStatMode(2);
            this._checkStatInterrupt(0x20);
          }
          this._checkLYC();
        }
        break;
    }
  }

  _setStatMode(mode) { this.stat = (this.stat & 0xFC) | mode; }

  _checkLYC() {
    if (this.ly === this.lyc) { this.stat |= 0x04; if (this.stat & 0x40) this.emulator.requestInterrupt(1); }
    else this.stat &= ~0x04;
  }

  _checkStatInterrupt(bit) { if (this.stat & bit) this.emulator.requestInterrupt(1); }

  _renderScanline() {
    const y = this.ly;
    if (y >= EMU_CORE_CONFIG.SCREEN.HEIGHT) return;
    const bgPriority = new Uint8Array(EMU_CORE_CONFIG.SCREEN.WIDTH); // per-pixel BG/window color index, for sprite priority

    if (this.lcdc & 0x01) {
      this._renderBackgroundLine(y, bgPriority);
      if (this.lcdc & 0x20) this._renderWindowLine(y, bgPriority);
    } else {
      for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) this._setPixel(x, y, 255, 255, 255);
    }
    if (this.lcdc & 0x02) this._renderSpritesLine(y, bgPriority);
  }

  // Decodes the 2bpp color index (0-3) at tile-space coordinates (mapX, mapY) for the given
  // tile map / tile data base. mapX/mapY are already resolved into that map's own space.
  getTileColorIndex(tileMapBase, tileDataBase, signedIndex, mapX, mapY) {
    const tileRow = mapY >> 3, tileCol = mapX >> 3;
    const tileIndexRaw = this.mmu.vram[(tileMapBase + tileRow * 32 + tileCol) - 0x8000];
    const tileIndex = signedIndex ? toSigned8(tileIndexRaw) : tileIndexRaw;
    const tileAddr = tileDataBase + tileIndex * 16;
    const py = mapY & 7, px = mapX & 7;
    const lo = this.mmu.vram[(tileAddr - 0x8000) + py * 2];
    const hi = this.mmu.vram[(tileAddr - 0x8000) + py * 2 + 1];
    const bit = 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  // Tile-data addressing (LCDC.4) is shared by the BG and window layers.
  bgWindowTileDataConfig() {
    const signedIndex = !(this.lcdc & 0x10);
    if (this._tdConfig && this._tdConfig.signedIndex === signedIndex) return this._tdConfig;
    this._tdConfig = { tileDataBase: signedIndex ? 0x9000 : 0x8000, signedIndex };
    return this._tdConfig;
  }

  // Color index of the background pixel at screen (x, y), per current SCX/SCY/LCDC.
  _getBackgroundColorIndex(x, y) {
    const tileMapBase = (this.lcdc & 0x08) ? 0x9C00 : 0x9800;
    const { tileDataBase, signedIndex } = this.bgWindowTileDataConfig();
    const bgX = (x + this.scx) & 0xFF, bgY = (y + this.scy) & 0xFF;
    return this.getTileColorIndex(tileMapBase, tileDataBase, signedIndex, bgX, bgY);
  }

  // Color index of the window pixel at window-space coordinates (winX, winY).
  _getWindowColorIndex(winX, winY) {
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
    candidates.length = 0;
    for (let i = 0; i < SPR.MAX_TOTAL && candidates.length < SPR.MAX_PER_LINE; i++) {
      const base = i * 4;
      const spriteY = this.mmu.oam[base] - 16;
      if (y >= spriteY && y < spriteY + spriteHeight) {
        const slot = this._spriteSlotPool[candidates.length];
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

    const lo = this.mmu.vram[tileOffset + rowInSprite * 2];
    const hi = this.mmu.vram[tileOffset + rowInSprite * 2 + 1];
    return { lo, hi, xFlip };
  }

  // Color index (0-3) at column px (0-7) within a sprite row.
  static spriteRowColorIndex(lo, hi, xFlip, px) {
    const bit = xFlip ? px : 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  _renderBackgroundLine(y, bgPriority) {
    for (let x = 0; x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const colorNum = this._getBackgroundColorIndex(x, y);
      bgPriority[x] = colorNum;
      const shade = this.applyPalette(colorNum, this.bgp);
      this._setPixel(x, y, shade[0], shade[1], shade[2]);
    }
  }

  // Bounds-checks WY/WX, walks the visible window columns, and bumps windowLineCounter only
  // if a pixel actually drew this scanline (the window's line counter freezes when off-screen).
  _renderWindowLine(y, bgPriority) {
    if (y < this.wy) return;
    const wx = this.wx - 7;
    if (wx > EMU_CORE_CONFIG.SCREEN.WIDTH - 1) return;
    const winY = this.windowLineCounter;
    let drewAny = false;

    for (let x = Math.max(wx, 0); x < EMU_CORE_CONFIG.SCREEN.WIDTH; x++) {
      const colorNum = this._getWindowColorIndex(x - wx, winY);
      bgPriority[x] = colorNum;
      const shade = this.applyPalette(colorNum, this.bgp);
      this._setPixel(x, y, shade[0], shade[1], shade[2]);
      drewAny = true;
    }
    if (drewAny) this.windowLineCounter++;
  }

  // Gathers this scanline's sprite candidates, decodes each one's row bits, and walks its
  // 8 columns for non-transparent pixels.
  _renderSpritesLine(y, bgPriority) {
    const SPR = EMU_CORE_CONFIG.SPRITES;
    const spriteHeight = (this.lcdc & 0x04) ? SPR.HEIGHT_TALL : SPR.HEIGHT_SMALL;
    const candidates = this.getSpriteCandidatesForLine(y, spriteHeight);

    for (const s of candidates) {
      if (s.spriteX <= -8 || s.spriteX >= EMU_CORE_CONFIG.SCREEN.WIDTH) continue;
      const behindBG = !!(s.attrs & 0x80);
      const { lo, hi, xFlip } = this.getSpriteRowBits(s, y, spriteHeight);

      for (let px = 0; px < 8; px++) {
        const sx = s.spriteX + px;
        if (sx < 0 || sx >= EMU_CORE_CONFIG.SCREEN.WIDTH) continue;
        const colorNum = PPU.spriteRowColorIndex(lo, hi, xFlip, px);
        if (colorNum === 0) continue; // color 0 is always transparent for sprites
        if (behindBG && bgPriority[sx] !== 0) continue;
        const palette = (s.attrs & 0x10) ? this.obp1 : this.obp0;
        const shade = this.applyPalette(colorNum, palette);
        this._setPixel(sx, y, shade[0], shade[1], shade[2]);
      }
    }
  }

  applyPalette(colorNum, palette) { return PPU.SHADES[(palette >> (colorNum * 2)) & 0x03]; }
  _setPixel(x, y, r, g, b) { setFramebufferPixel(this.framebuffer, x, y, r, g, b); }
}

/* ==================================== 4. Timer ============================================
   A hardware timer is one of the simplest possible pieces of memory-mapped I/O (primer
   idea #4): it's a number that counts itself upward automatically, at a steady rate, purely
   from clock ticks (primer idea #8) — no CPU instructions required. Game code reads the
   current count whenever it wants to measure elapsed time, and can optionally ask to be
   interrupted (primer idea #7) once the count overflows. This is the same basic idea behind
   every "timer interrupt" a real operating system relies on to periodically regain control
   of the CPU (e.g. to switch between running programs).
   ========================================================================================= */

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

/* ==================================== 5. Joypad ============================================
   The simplest possible example of memory-mapped I/O (primer idea #4): the buttons aren't
   "sent" to the CPU proactively — the CPU just reads one I/O address (0xFF00) whenever it
   wants to know the current button state, exactly like reading any other memory location.
   All the real work is figuring out what value that read should return.
   ========================================================================================= */

class Joypad {
  constructor(emulator) {
    this.emulator = emulator;
    this.selectDirections = false;
    this.selectButtons = false;
    this.directionState = 0x0F; // bit0 Right, bit1 Left, bit2 Up, bit3 Down (0 = pressed)
    this.buttonState = 0x0F;    // bit0 A, bit1 B, bit2 Select, bit3 Start (0 = pressed)
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

/* ==================================== 6. APU (sound) =======================================
   A third independent unit alongside the CPU and PPU (same pattern as primer idea #9): the
   APU ("Audio Processing Unit") continuously generates sound-wave samples from settings the
   game writes into its I/O registers, without any CPU involvement in producing the actual
   waveform. Four independent channels (two simple tone generators, one arbitrary-waveform
   channel, and one noise generator) are combined into a single output signal — this
   act of combining several sources into one is called "mixing," see _step() below.
   ========================================================================================= */
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

    this.ch1 = this._newCh1State();
    this.ch2 = this._newSquareState();
    this.ch3 = this._newCh3State();
    this.waveRAM = new Uint8Array(16); // 0xFF30-0xFF3F, 32 packed 4-bit samples
    this.ch4 = this._newCh4State();

    this.regs = new Uint8Array(0x30); // raw bytes for 0xFF10-0xFF3F, indexed by (addr - 0xFF10)
    this.leftVol = 7; this.rightVol = 7; this.panning = 0xF3;

    this.fsStep = 0;
    this.frameSeqTimer = 0;

    // Defaults to 44100; setSampleRate() overwrites this with the real output device rate.
    this.sampleRate = 44100;
    this.cyclesPerSample = EMU_CORE_CONFIG.CLOCK_HZ / this.sampleRate;
    this.sampleCounter = 0;

    // Ring buffer feeding the Web Audio callback (producer: emulator loop, consumer: audio thread).
    this.RING_SIZE = 8192;
    this.ringL = new Float32Array(this.RING_SIZE);
    this.ringR = new Float32Array(this.RING_SIZE);
    this.writePos = 0; this.readPos = 0; this.available = 0;
    this.lastL = 0; this.lastR = 0; // last sample played, for a graceful underrun fade-out

    // Running sums used to *average* each channel's DAC output since the last output
    // sample, rather than point-sampling it — avoids aliasing at speed > 1x.
    this.accL = 0; this.accR = 0; this.accCycles = 0;

    // One-pole DC-blocking filter (mirrors the coupling capacitor real DMG hardware has on
    // its audio output).
    this.dcPrevInL = 0; this.dcPrevOutL = 0; this.dcPrevInR = 0; this.dcPrevOutR = 0;
    this._dcPrimed = false;
  }

  _newSquareState() {
    return { enabled: false, dacEnabled: false, duty: 2, dutyStep: 0, frequency: 0, freqTimer: 0,
             lengthCounter: 0, lengthEnabled: false,
             envVolume: 0, envDirection: 0, envPeriod: 0, envTimer: 0, volume: 0 };
  }
  // Ch1 is a square channel plus a frequency-sweep unit the others don't have.
  _newCh1State() {
    return Object.assign(this._newSquareState(), {
      sweepPeriodReg: 0, sweepDirection: 0, sweepShift: 0,
      sweepTimer: 0, sweepEnabled: false, shadowFreq: 0,
    });
  }
  // Ch3: wave channel (plays samples from waveRAM instead of a duty cycle).
  _newCh3State() {
    return { enabled: false, dacEnabled: false, frequency: 0, freqTimer: 0,
             lengthCounter: 0, lengthEnabled: false, volumeShift: 0, samplePos: 0 };
  }
  // Ch4: noise channel (LFSR instead of a frequency).
  _newCh4State() {
    return { enabled: false, dacEnabled: false, lengthCounter: 0, lengthEnabled: false,
             envVolume: 0, envDirection: 0, envPeriod: 0, envTimer: 0, volume: 0,
             clockShift: 0, widthMode: 0, divisorCode: 0, freqTimer: 8, lfsr: 0x7FFF };
  }

  // Tells APU the real output sample rate, so its sampling cadence matches reality instead
  // of assuming 44100.
  setSampleRate(rate) {
    if (!rate) return;
    this.sampleRate = rate;
    this.cyclesPerSample = EMU_CORE_CONFIG.CLOCK_HZ / rate;
  }

  _pushSample(l, r) {
    this.ringL[this.writePos] = l; this.ringR[this.writePos] = r;
    this.writePos = (this.writePos + 1) % this.RING_SIZE;
    if (this.available < this.RING_SIZE) this.available++;
    else this.readPos = (this.readPos + 1) % this.RING_SIZE; // full: drop oldest sample
  }

  // Drains `bufferSize` samples out of the ring buffer for the audio output device. An
  // underrun (buffer empty) decays toward silence via lastL/lastR instead of a hard click.
  drain(bufferSize) {
    const left = new Float32Array(bufferSize);
    const right = new Float32Array(bufferSize);
    for (let i = 0; i < bufferSize; i++) {
      if (this.available > 0) {
        this.lastL = this.ringL[this.readPos];
        this.lastR = this.ringR[this.readPos];
        this.readPos = (this.readPos + 1) % this.RING_SIZE;
        this.available--;
      } else {
        this.lastL *= 0.9; this.lastR *= 0.9;
      }
      left[i] = this.lastL; right[i] = this.lastR;
    }
    return { left, right };
  }

  /* ---- register read/write (mapped from MMU._readIO/_writeIO for 0xFF10-0xFF3F) ---- */
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
      if (wasEnabled && !this.enabled) this._powerOff();
      else if (!wasEnabled && this.enabled) this._powerOn();
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
        if (val & 0x80) this._triggerCh1();
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
        if (val & 0x80) this._triggerCh2();
        break;

      case 0xFF1A: this.ch3.dacEnabled = !!(val & 0x80); if (!this.ch3.dacEnabled) this.ch3.enabled = false; break;
      case 0xFF1B: this.ch3.lengthCounter = 256 - val; break;
      case 0xFF1C: this.ch3.volumeShift = (val >> 5) & 3; break;
      case 0xFF1D: this.ch3.frequency = (this.ch3.frequency & 0x700) | val; break;
      case 0xFF1E:
        this.ch3.frequency = (this.ch3.frequency & 0xFF) | ((val & 7) << 8);
        this.ch3.lengthEnabled = !!(val & 0x40);
        if (val & 0x80) this._triggerCh3();
        break;

      case 0xFF20: this.ch4.lengthCounter = 64 - (val & 0x3F); break;
      case 0xFF21:
        this.ch4.envVolume = (val >> 4) & 0xF; this.ch4.envDirection = (val >> 3) & 1; this.ch4.envPeriod = val & 7;
        this.ch4.dacEnabled = (val & 0xF8) !== 0; if (!this.ch4.dacEnabled) this.ch4.enabled = false;
        break;
      case 0xFF22: this.ch4.clockShift = (val >> 4) & 0xF; this.ch4.widthMode = (val >> 3) & 1; this.ch4.divisorCode = val & 7; break;
      case 0xFF23:
        this.ch4.lengthEnabled = !!(val & 0x40);
        if (val & 0x80) this._triggerCh4();
        break;

      case 0xFF24: this.leftVol = (val >> 4) & 7; this.rightVol = val & 7; break; // VIN-to-speaker bits ignored
      case 0xFF25: this.panning = val; break;
    }
  }

  _powerOff() {
    // Real hardware clears everything except wave RAM.
    this.regs.fill(0);
    this.ch1 = this._newCh1State();
    this.ch2 = this._newSquareState();
    Object.assign(this.ch4, { enabled: false, dacEnabled: false, envVolume: 0, envDirection: 0, envPeriod: 0, clockShift: 0, widthMode: 0, divisorCode: 0 });
    this.leftVol = 7; this.rightVol = 7; this.panning = 0;
  }
  _powerOn() { this.fsStep = 0; this.frameSeqTimer = 0; this.ch1.dutyStep = 0; this.ch2.dutyStep = 0; }

  // Sets every register/state field the way the boot ROM would leave it just before a game starts.
  reset() {
    this.regs.fill(0); this.waveRAM.fill(0);
    this.ch1 = this._newCh1State();
    this.ch2 = this._newSquareState();
    this.ch3 = this._newCh3State();
    this.ch4 = this._newCh4State();
    this.fsStep = 0; this.frameSeqTimer = 0; this.sampleCounter = 0;
    this.enabled = false;

    this.accL = 0; this.accR = 0; this.accCycles = 0;
    this.ringL.fill(0); this.ringR.fill(0);
    this.writePos = 0; this.readPos = 0; this.available = 0;
    this.lastL = 0; this.lastR = 0;
    this.dcPrevInL = 0; this.dcPrevOutL = 0; this.dcPrevInR = 0; this.dcPrevOutR = 0;
    this._dcPrimed = false;

    this.write(0xFF26, 0x80); // power on first, or the writes below would be ignored
    this.write(0xFF10, 0x80); this.write(0xFF11, 0xBF); this.write(0xFF12, 0xF3); this.write(0xFF14, 0xBF);
    this.write(0xFF16, 0x3F); this.write(0xFF17, 0x00); this.write(0xFF19, 0xBF);
    this.write(0xFF1A, 0x7F); this.write(0xFF1B, 0xFF); this.write(0xFF1C, 0x9F); this.write(0xFF1E, 0xBF);
    this.write(0xFF20, 0xFF); this.write(0xFF21, 0x00); this.write(0xFF22, 0x00); this.write(0xFF23, 0xBF);
    this.write(0xFF24, 0x77); this.write(0xFF25, 0xF3);

    // Those NR14/19/1E/23 writes also trigger each channel for real. Real hardware's boot
    // chime has decayed to silence by the time a game runs, so mute what the trigger just
    // started, keeping only the register values.
    this.ch1.enabled = false; this.ch2.enabled = false; this.ch3.enabled = false; this.ch4.enabled = false;
  }

  /* ---- channel triggers (NRx4 bit 7 write) ---- */
  _triggerCh1() {
    this.ch1.enabled = this.ch1.dacEnabled;
    if (this.ch1.lengthCounter === 0) this.ch1.lengthCounter = 64;
    this.ch1.freqTimer = (2048 - this.ch1.frequency) * 4;
    this.ch1.envTimer = this.ch1.envPeriod || 8;
    this.ch1.volume = this.ch1.envVolume;
    this.ch1.shadowFreq = this.ch1.frequency;
    this.ch1.sweepTimer = this.ch1.sweepPeriodReg || 8;
    this.ch1.sweepEnabled = this.ch1.sweepPeriodReg > 0 || this.ch1.sweepShift > 0;
    if (this.ch1.sweepShift > 0) this._calcSweep(); // immediate overflow check
  }
  _triggerCh2() {
    this.ch2.enabled = this.ch2.dacEnabled;
    if (this.ch2.lengthCounter === 0) this.ch2.lengthCounter = 64;
    this.ch2.freqTimer = (2048 - this.ch2.frequency) * 4;
    this.ch2.envTimer = this.ch2.envPeriod || 8;
    this.ch2.volume = this.ch2.envVolume;
  }
  _triggerCh3() {
    this.ch3.enabled = this.ch3.dacEnabled;
    if (this.ch3.lengthCounter === 0) this.ch3.lengthCounter = 256;
    this.ch3.freqTimer = (2048 - this.ch3.frequency) * 2;
    this.ch3.samplePos = 0;
  }
  _triggerCh4() {
    this.ch4.enabled = this.ch4.dacEnabled;
    if (this.ch4.lengthCounter === 0) this.ch4.lengthCounter = 64;
    this.ch4.envTimer = this.ch4.envPeriod || 8;
    this.ch4.volume = this.ch4.envVolume;
    this.ch4.lfsr = 0x7FFF;
    this.ch4.freqTimer = APU_NOISE_DIVISORS[this.ch4.divisorCode] << this.ch4.clockShift;
  }

  _calcSweep() {
    let newFreq = this.ch1.shadowFreq >> this.ch1.sweepShift;
    newFreq = this.ch1.sweepDirection ? this.ch1.shadowFreq - newFreq : this.ch1.shadowFreq + newFreq;
    if (newFreq > 2047) this.ch1.enabled = false;
    return newFreq;
  }

  /* ---- frame sequencer: 512 Hz clock feeding length/sweep/envelope ---- */
  _clockFrameSequencer() {
    this.fsStep = (this.fsStep + 1) & 7;
    if (this.fsStep % 2 === 0) this._clockLength();
    if (this.fsStep === 2 || this.fsStep === 6) this._clockSweep();
    if (this.fsStep === 7) this._clockEnvelope();
  }
  _clockLength() {
    [this.ch1, this.ch2, this.ch3, this.ch4].forEach(ch => {
      if (ch.lengthEnabled && ch.lengthCounter > 0) { ch.lengthCounter--; if (ch.lengthCounter === 0) ch.enabled = false; }
    });
  }
  _clockSweep() {
    const ch = this.ch1;
    if (ch.sweepTimer > 0) {
      ch.sweepTimer--;
      if (ch.sweepTimer === 0) {
        ch.sweepTimer = ch.sweepPeriodReg || 8;
        if (ch.sweepEnabled && ch.sweepPeriodReg > 0) {
          const newFreq = this._calcSweep();
          if (newFreq <= 2047 && ch.sweepShift > 0) {
            ch.shadowFreq = newFreq; ch.frequency = newFreq;
            this._calcSweep(); // second overflow check per hardware behavior
          }
        }
      }
    }
  }
  _clockEnvelope() {
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
  _stepSquare(ch, cycles) {
    ch.freqTimer -= cycles;
    while (ch.freqTimer <= 0) { ch.freqTimer += (2048 - ch.frequency) * 4; ch.dutyStep = (ch.dutyStep + 1) & 7; }
  }
  _stepWave(cycles) {
    this.ch3.freqTimer -= cycles;
    while (this.ch3.freqTimer <= 0) { this.ch3.freqTimer += (2048 - this.ch3.frequency) * 2; this.ch3.samplePos = (this.ch3.samplePos + 1) & 31; }
  }
  _stepNoise(cycles) {
    const period = APU_NOISE_DIVISORS[this.ch4.divisorCode] << this.ch4.clockShift;
    this.ch4.freqTimer -= cycles;
    while (this.ch4.freqTimer <= 0) {
      this.ch4.freqTimer += period;
      const xorBit = (this.ch4.lfsr & 1) ^ ((this.ch4.lfsr >> 1) & 1);
      this.ch4.lfsr = (this.ch4.lfsr >> 1) | (xorBit << 14);
      if (this.ch4.widthMode) this.ch4.lfsr = (this.ch4.lfsr & ~0x40) | (xorBit << 6);
    }
  }

  _getWaveSample() {
    const byte = this.waveRAM[this.ch3.samplePos >> 1];
    return (this.ch3.samplePos & 1) === 0 ? (byte >> 4) & 0xF : byte & 0xF;
  }

  step(cycles) {
    this.frameSeqTimer += cycles;
    while (this.frameSeqTimer >= 8192) { this.frameSeqTimer -= 8192; this._clockFrameSequencer(); }

    this._stepSquare(this.ch1, cycles);
    this._stepSquare(this.ch2, cycles);
    this._stepWave(cycles);
    this._stepNoise(cycles);

    this._accumulateMix(cycles);

    // Emulated and audio clocks aren't perfectly locked, so timing drift accumulates over
    // time. Nudge the sample period by up to +-1% based on ring-buffer fill, pulling it
    // back toward half-full.
    const fillRatio = this.available / this.RING_SIZE;
    const correction = 1 + (fillRatio - 0.5) * 0.02;

    // Scale by emulator.speed so sample production stays paced to real time.
    const targetCyclesPerSample = this.cyclesPerSample * correction * this.emulator.speed;

    this.sampleCounter += cycles;
    while (this.sampleCounter >= targetCyclesPerSample) { this.sampleCounter -= targetCyclesPerSample; this._emitSample(); }
  }

  // Computes each channel's instantaneous DAC output (-1..1) and the mixed/panned/volumed
  // left+right instant, folding left*cycles / right*cycles into the running-sum accumulators.
  _accumulateMix(cycles) {
    if (!this.enabled) { this.accCycles += cycles; return; }

    const amp1 = this.ch1.enabled ? APU_DUTY_TABLE[this.ch1.duty][this.ch1.dutyStep] * this.ch1.volume : 0;
    const amp2 = this.ch2.enabled ? APU_DUTY_TABLE[this.ch2.duty][this.ch2.dutyStep] * this.ch2.volume : 0;
    let amp3 = 0;
    if (this.ch3.enabled && this.ch3.volumeShift > 0) amp3 = this._getWaveSample() >> (this.ch3.volumeShift - 1);
    const amp4 = this.ch4.enabled ? ((~this.ch4.lfsr) & 1) * this.ch4.volume : 0;

    // Each channel's 4-bit DAC maps 0-15 to roughly -1..1 - but only while that channel's
    // DAC is actually powered (dacEnabled).
    const dac = v => (v / 7.5) - 1;
    const a1 = this.ch1.dacEnabled ? dac(amp1) : 0;
    const a2 = this.ch2.dacEnabled ? dac(amp2) : 0;
    const a3 = this.ch3.dacEnabled ? dac(amp3) : 0;
    const a4 = this.ch4.dacEnabled ? dac(amp4) : 0;

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
  // acts as a simple anti-aliasing low-pass, which matters most at speed > 1x.
  _emitSample() {
    const left = this.accCycles > 0 ? this.accL / this.accCycles : 0;
    const right = this.accCycles > 0 ? this.accR / this.accCycles : 0;

    // DC-blocking one-pole highpass (y[n] = x[n] - x[n-1] + R*y[n-1]) — see the field
    // comment in the constructor. R just under 1 sits far below audible frequencies, so it
    // only removes slow DC drift/offset, not the actual waveform.
    if (!this._dcPrimed) { this.dcPrevInL = left; this.dcPrevInR = right; this._dcPrimed = true; }
    const R = 0.995;
    const outL = left - this.dcPrevInL + R * this.dcPrevOutL;
    this.dcPrevInL = left; this.dcPrevOutL = outL;
    const outR = right - this.dcPrevInR + R * this.dcPrevOutR;
    this.dcPrevInR = right; this.dcPrevOutR = outR;

    this._pushSample(outL, outR);
    this.accL = 0; this.accR = 0; this.accCycles = 0;
  }
}

/* ================================= 7. GBEmulator (glue) ====================================
   Ties primer idea #8 ("everything advances in synchronized clock ticks") together in code:
   every time the CPU finishes one instruction, this class immediately tells the PPU, Timer,
   and APU "that took N cycles — you advance by N cycles too" (see stepHardware() below).
   That's the entire secret to keeping independent chips in sync with each other: nobody
   needs a global clock signal in software, because every component is explicitly told how
   much (simulated) time has passed after each step.

   Drives everything: feeds CPU instructions, steps the other components the same number of
   T-cycles, paces playback against real time, and exposes the small API a UI needs
   (load a ROM, press buttons, get pixels/audio out).
   ========================================================================================= */

class GBEmulator {
  static CYCLES_PER_FRAME = EMU_CORE_CONFIG.FRAME.CYCLES_PER_FRAME; // 154 scanlines x 456 T-cycles

  constructor() {
    this.mmu = new MMU(this);
    this.cpu = new CPU(this.mmu);
    this.ppu = new PPU(this);
    this.timer = new Timer(this);
    this.joypad = new Joypad(this);
    this.apu = new APU(this);

    this.running = false;
    this.onFrame = null;          // called after each rendered frame, so a UI can draw the framebuffer
    this.onRunStateChange = null; // called with the new boolean whenever start()/pause() flips this.running
    this.onFpsUpdate = null;      // called ~once/sec during play, with the rendered-frames-per-second count
    this.onAudioResume = null;    // called from start() (a real user gesture) so audio playback can begin
    this.onAudioSuspend = null;   // called from pause()

    this.frameReady = false;
    this.romTitle = null;

    this.speed = 1;           // 1 = normal speed; e.g. 2 = double speed
    this._lastTime = null;    // real-time timestamp of the previous _loop() tick
    this._frameAcc = 0;       // accumulated (speed-scaled) ms available to spend on emulated frames
    this._rafId = null;

    this._fpsFrames = 0;
    this._fpsLast = (typeof performance !== 'undefined') ? performance.now() : 0;
  }

  requestInterrupt(bit) { this.mmu.io[0x0F] |= (1 << bit); }

  // ---- Video ----
  getFramebuffer() { return this.ppu.framebuffer; }

  // ---- Audio output ----
  drainAudioSamples(bufferSize) { return this.apu.drain(bufferSize); }
  setSampleRate(hz) { this.apu.setSampleRate(hz); }

  // ---- Input ----
  setButton(bit, pressed, isDirection) { this.joypad.setButton(bit, pressed, isDirection); }

  // ---- Cartridge battery-backed RAM (for games with in-game saves) ----
  hasROM() { return !!(this.mmu.rom && this.mmu.rom.length); }
  getCartRAM(size) { return this.mmu.cartRAM.slice(0, size ?? this.mmu.cartRAM.length); }
  setCartRAM(bytes) {
    const n = Math.min(bytes.length, this.mmu.cartRAM.length);
    this.mmu.cartRAM.set(bytes.subarray(0, n));
  }

  loadROM(bytes) {
    this.mmu.loadROM(bytes);
    this.cpu.reset();
    this.ppu.modeClock = 0; this.ppu.mode = 2; this.ppu.windowLineCounter = 0;
    this.timer.divCounter = 0; this.timer.divReg = 0; this.timer.timaCounter = 0; this.timer.tima = 0;
    this.apu.reset();
    this.romTitle = parseROMTitle(bytes);
  }

  // Runs one CPU instruction and steps the other components the same number of T-cycles.
  _stepInstruction() {
    const cycles = this.cpu.step();
    this.stepHardware(cycles);
    return cycles;
  }

  stepHardware(cycles) {
    this.ppu.step(cycles);
    this.timer.step(cycles);
    this.apu.step(cycles);
  }

  // Runs exactly one emulated frame's worth of CPU cycles (70224 T-cycles).
  runFrame() {
    let cyclesThisFrame = 0;
    while (cyclesThisFrame < GBEmulator.CYCLES_PER_FRAME) {
      cyclesThisFrame += this._stepInstruction();
    }
  }

  // Single-choke point for flipping this.running, so UI code can hook play/pause boundaries.
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
    this.onAudioResume?.(); // must happen inside a user gesture (click/drop), which start() always is
    this._loop(typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  pause() {
    this._setRunning(false);
    if (this._rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._rafId);
    this.onAudioSuspend?.();
  }

  // Paces emulated frames against real elapsed time, scaled by this.speed. An accumulator
  // (rather than "one frame per animation-frame tick") means changing speed actually
  // speeds/slows the game, not just how often we redraw.
  _loop(now) {
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
      this._frameAcc -= FRAME_MS;
      framesRun++;
    }

    if (framesRun > 0) {
      this._fpsFrames++;
      if (this.onFrame) this.onFrame();
    }
    if (now - this._fpsLast >= 1000) {
      if (this.onFpsUpdate) this.onFpsUpdate(this._fpsFrames);
      this._fpsFrames = 0; this._fpsLast = now;
    }
    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }
}

// Cartridge title, header bytes 0x134-0x143: uppercase ASCII, NUL-padded (NUL also
// terminates early).
function parseROMTitle(bytes) {
  let title = '';
  for (let i = 0x134; i < 0x144; i++) {
    const c = bytes[i];
    if (c === 0) break;
    if (c >= 32 && c < 127) title += String.fromCharCode(c);
  }
  return title.trim() || 'Unknown';
}
