/* emu-gb-stats-instrumentation.js — CoreStats + Instrumentation (debug-tool support)
   Two independent classes in one file, no effect on emulation:
     - CoreStats: frame/interrupt/memory-access counters (Frame Activity, Interrupts,
       Memory Map, MBC Banking panels). No constructor args.
     - Disassembler + Instrumentation: LR35902 disassembler, execution trace, breakpoints
       (Trace/Disasm/Registers/Stack panels). Takes `emulator`, since triggerBreakpoint()
       pauses the run loop.
   Emulator holds one of each: `this.stats`, `this.instrumentation`. */

/* CoreStats — frame/interrupt/memory-access counters for the debug UI. */

class CoreStats {
  constructor() {
    // Gate the hot read8/write8 path: skip bookkeeping unless a panel needs it.
    this.trackAccess = true;
    this.trackMemMap = false;

    // Frame Activity panel: per-frame hardware event counts, last FRAME_STATS_HISTORY frames.
    this.FRAME_STATS_HISTORY = 60; // ~1 second at 59.73fps
    this.frameStatsHistory = [];
    this.frameCounter = 0;
    this.frameStats = this.newFrameStats();

    // Interrupts panel: last INTERRUPT_LOG_SIZE interrupts actually dispatched (not just requested).
    this.INTERRUPT_LOG_SIZE = 60;
    this.interruptLog = []; // oldest first; each entry { seq, frame, bit, pcBefore }
    this.interruptSeq = 0;

    // Memory Map / MBC Banking panels: last touched region/address, last bank switch.
    this.accessSeq = 0;
    this.lastAccess = { addr: 0, region: 'ROM0', type: 'read', seq: 0 };
    this.regionLastTouch = new Uint32Array(REGION_COUNT);
    this.lastBankSwitch = null; // { kind, addr, val, romBank, ramBank, t } or null
  }

  // Fresh per-frame accumulator. spritesPerLine is indexed by scanline; events is an
  // ordered { line, kind } list for the Frame Activity strip.
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

  // Back to power-on/ROM-load state. Called from Emulator.loadROM().
  reset() {
    this.frameStatsHistory = [];
    this.frameCounter = 0;
    this.frameStats = this.newFrameStats();

    this.interruptLog = [];
    this.interruptSeq = 0;

    this.accessSeq = 0;
    this.lastAccess.addr = 0; this.lastAccess.region = 'ROM0'; this.lastAccess.type = 'read'; this.lastAccess.seq = 0;
    this.regionLastTouch.fill(0);
    this.lastBankSwitch = null;
  }

  // Per-frame lifecycle, called from Emulator.runFrame().

  startFrame() {
    this.frameStats = this.newFrameStats();
  }

  recordInstruction() {
    this.frameStats.instructions++;
  }

  finishFrame() {
    this.frameStatsHistory.push(this.frameStats);
    if (this.frameStatsHistory.length > this.FRAME_STATS_HISTORY) this.frameStatsHistory.shift();
    this.frameCounter++;
  }

  // Hardware event recorders, called from Emulator/MMU/PPU/APU.

  // bit: interrupt bit (0=vblank..4=joypad). ly: scanline it fired on.
  recordInterrupt(bit, ly) {
    const kind = INTERRUPT_KIND_NAMES[bit];
    if (!kind) return;
    this.frameStats.interrupts[kind]++;
    if (this.trackAccess) this.frameStats.events.push({ line: ly, kind: 'int-' + kind });
  }

  // Called when an interrupt is actually dispatched (PC pushed, jumped to handler) —
  // not just when the IF bit is set.
  recordInterruptServiced(bit, pcBefore, frame) {
    this.interruptLog.push({ seq: this.interruptSeq++, frame, bit, pcBefore });
    if (this.interruptLog.length > this.INTERRUPT_LOG_SIZE) this.interruptLog.shift();
  }

  recordDMA(ly) {
    this.frameStats.dma++;
    if (this.trackAccess) this.frameStats.events.push({ line: ly, kind: 'dma' });
  }

  // ROM/RAM bank, RAM enable, banking mode, or RTC register select, for the MBC Banking panel.
  recordBankSwitch(kind, addr, val, romBank, ramBank, ly) {
    this.lastBankSwitch = { kind, addr, val, romBank, ramBank, t: performance.now() };
    this.frameStats.bankSwitches++;
    if (this.trackAccess) this.frameStats.events.push({ line: ly, kind: 'bank' });
  }

  recordAPUTrigger(ly) {
    this.frameStats.apuTriggers++;
    if (this.trackAccess) this.frameStats.events.push({ line: ly, kind: 'apu' });
  }

  recordSprites(y, count) {
    this.frameStats.spritesPerLine[y] = count;
    this.frameStats.spritesTotal += count;
    if (count > this.frameStats.spritesMaxLine) this.frameStats.spritesMaxLine = count;
  }

  // Single memory read/write for the Memory Map panel. regionId: REGION_* id (emu-gb-core.js).
  recordMemAccess(addr, regionId, type) {
    this.accessSeq++;
    this.regionLastTouch[regionId] = this.accessSeq;
    const a = this.lastAccess;
    a.addr = addr; a.region = REGION_NAMES[regionId]; a.type = type; a.seq = this.accessSeq;
  }
}

/* Disassembler + Instrumentation — execution trace, breakpoints. Takes an `emulator`
   back-reference (unlike CoreStats): triggerBreakpoint() needs to pause the run loop. */

/* Disassembler: mirrors CPU.execute()/executeCB(), but read-only via a caller-supplied
   readByte(offset), so it can decode live memory or a captured snapshot. */

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

// Plain-English gloss for a decoded mnemonic, for the execution trace. Checked against
// full-text prefixes first, then falls back to the base mnemonic word.
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
  // JP/JR/CALL/RET with a condition (NZ/Z/NC/C) only act when that flag holds.
  if (opWord === 'JP' || opWord === 'JR' || opWord === 'CALL' || opWord === 'RET') {
    const rest = mnemonicText.slice(opWord.length).trim();
    const condMatch = rest.match(/^(NZ|NC|Z|C)\b/);
    if (condMatch) note += ` Only taken if ${COND_NOTE[condMatch[1]]}.`;
  }
  return note;
}

/* Instrumentation — execution trace ring buffer + breakpoint state.
   Holds a back-reference to `emulator` rather than caching cpu/mmu, since CGBEmulator
   replaces this.cpu/this.mmu right after super() — anything needing "the current cpu"
   must read this.emulator.cpu fresh, not a stale copy. */

class Instrumentation {
  constructor(emulator) {
    this.emulator = emulator;

    // Gate the per-instruction snapshot/diff work: only runs when the Trace panel is open.
    this.trackTrace = false;

    // Execution trace: ring buffer of the last TRACE_SIZE fetched instructions.
    this.TRACE_SIZE = 500;
    this.traceAddr = new Uint16Array(this.TRACE_SIZE);
    this.traceB0 = new Uint8Array(this.TRACE_SIZE);
    this.traceB1 = new Uint8Array(this.TRACE_SIZE);
    this.traceB2 = new Uint8Array(this.TRACE_SIZE);
    this.traceDiff = new Array(this.TRACE_SIZE).fill(''); // "A: 0x00→0x05 Z:1→0" style string per entry
    this.traceWritePos = 0;
    this.traceFilled = 0;

    // Step / breakpoint debugging.
    this.breakpointPC = null;
    this.breakpointOpcode = null;
    this.breakHitReason = null;
    this._bpSkipFirstMatch = false; // don't re-trigger a PC breakpoint we're already sitting on
    this.onBreakpointHit = null;
  }

  pushTrace(addr, b0, b1, b2) {
    const i = this.traceWritePos;
    this.traceAddr[i] = addr; this.traceB0[i] = b0; this.traceB1[i] = b1; this.traceB2[i] = b2;
    this.traceDiff[i] = '';
    this.traceWritePos = (i + 1) % this.TRACE_SIZE;
    if (this.traceFilled < this.TRACE_SIZE) this.traceFilled++;
    return i;
  }

  // Snapshot of everything an instruction could change, for the trace's before/after diff.
  snapshotRegs() {
    const c = this.emulator.cpu;
    return {
      A: c.A, B: c.B, C: c.C, D: c.D, E: c.E, H: c.H, L: c.L, SP: c.SP,
      fZ: c.flagZ, fN: c.flagN, fH: c.flagH, fC: c.flagC,
    };
  }

  // "A: 0x00→0x05 Z:1→0" style string of only what changed; empty if nothing did.
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

  // Trace entries oldest-first, tagged with the ring buffer's physical `idx` so callers
  // can cache decoded text per slot instead of recomputing it every redraw.
  getTraceEntries() {
    const entries = [];
    const oldest = this.traceFilled < this.TRACE_SIZE ? 0 : this.traceWritePos;
    for (let i = 0; i < this.traceFilled; i++) {
      const idx = (oldest + i) % this.TRACE_SIZE;
      entries.push({ idx, addr: this.traceAddr[idx], b0: this.traceB0[idx], b1: this.traceB1[idx], b2: this.traceB2[idx], diff: this.traceDiff[idx] });
    }
    return entries;
  }

  // Arms PC/opcode breakpoints, called from Emulator.runToBreakpoint() before resuming.
  // Either target may be null to leave it unset.
  arm(pcTarget, opcodeTarget) {
    this.breakpointPC = pcTarget;
    this.breakpointOpcode = opcodeTarget;
    this._bpSkipFirstMatch = true; // don't instantly stop if already sitting on a PC match
    this.breakHitReason = null;
  }

  clearBreakpoints() {
    this.breakpointPC = null;
    this.breakpointOpcode = null;
    this.breakHitReason = null;
    this._bpSkipFirstMatch = false;
  }

  // Pauses emulation and records why, so a breakpoint hit looks like pressing Pause.
  // Reaches into the emulator to stop the run loop — the one bit of control-flow a
  // breakpoint requires.
  triggerBreakpoint(reason) {
    const e = this.emulator;
    e._setRunning(false);
    if (e._rafId) cancelAnimationFrame(e._rafId);
    e.apu.suspend();
    this.breakHitReason = reason;
    this._bpSkipFirstMatch = false;
    if (this.onBreakpointHit) this.onBreakpointHit(reason);
  }

  // Generic register/stack introspection for any CPU-state panel (register editor, stack
  // view). Generic to DMG or GBC since it's keyed off the same cpu/mmu field names.

  // Snapshot of every displayable register/flag, plus BC/DE/HL pairs. Wider than
  // snapshotRegs() above, which is just the hot-path trace-diff snapshot.
  readRegisters() {
    const c = this.emulator.cpu;
    return {
      A: c.A, B: c.B, C: c.C, D: c.D, E: c.E, H: c.H, L: c.L,
      SP: c.SP, PC: c.PC,
      flagZ: c.flagZ, flagN: c.flagN, flagH: c.flagH, flagC: c.flagC,
      IME: c.IME, halted: c.halted,
      BC: c.getBC(), DE: c.getDE(), HL: c.getHL(),
    };
  }

  // Window of 16-bit words around `sp`: `aboveWords` above (already-popped) through
  // `belowWords` below (still on the stack), each tagged with its signed word-offset.
  // Uses peek8, not read8 — debugger inspection, not real CPU memory activity.
  walkStack(sp, aboveWords, belowWords) {
    const mmu = this.emulator.mmu;
    const words = [];
    for (let i = -aboveWords; i <= belowWords; i++) {
      const addr = (sp + i * 2) & 0xFFFF;
      const lo = mmu.peek8(addr);
      const hi = mmu.peek8((addr + 1) & 0xFFFF);
      words.push({ addr, word: lo | (hi << 8), offsetWords: i });
    }
    return words;
  }
}
