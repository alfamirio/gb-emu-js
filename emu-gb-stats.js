/* =========================================================================================
   emu-gb-stats.js — CoreStats: frame/interrupt/memory-access instrumentation
   -----------------------------------------------------------------------------------------
   Everything here is purely observational bookkeeping for the debug UI (Frame Activity,
   Interrupts, Memory Map, MBC Banking panels) — none of it affects emulation behavior.
   It was previously a grab-bag of fields grafted directly onto `Emulator` (and duplicated
   onto `MMU`/`CGBMMU` for the memory-access bits); this pulls all of that into one plain
   class with a clean constructor, so it composes with any `{ cpu, mmu, ppu }`-shaped core
   instead of being welded to `Emulator` specifically.

   `Emulator` holds one instance (`this.stats = new CoreStats()`) and calls into it instead
   of mutating fields inline; `MMU`/`CGBMMU` reach it via `this.emulator.stats`.
   ========================================================================================= */

class CoreStats {
  constructor() {
    // ---- opt-in gates: skip the coarser frame-activity bookkeeping (trackAccess) and the
    // finer per-memory-access bookkeeping (trackMemMap) unless a debug panel actually wants
    // them, since both run on the hot read8/write8 path. ----
    this.trackAccess = true;
    this.trackMemMap = false;

    /* ---- frame activity: per-frame counts of hardware events (instructions, interrupts,
       sprites, DMA, banking, APU triggers), for the Frame Activity panel. ---- */
    this.FRAME_STATS_HISTORY = 60; // ~1 second at 59.73fps
    this.frameStatsHistory = [];
    this.frameCounter = 0;
    this.frameStats = this.newFrameStats();

    /* ---- interrupt log: last INTERRUPT_LOG_SIZE interrupts actually dispatched (not just
       requested), for the Interrupts debug panel. ---- */
    this.INTERRUPT_LOG_SIZE = 60;
    this.interruptLog = []; // oldest first; each entry { seq, frame, bit, pcBefore }
    this.interruptSeq = 0;

    /* ---- memory access: which region/address was last touched, and the last bank-switch
       event, for the Memory Map / MBC Banking panels. ---- */
    this.accessSeq = 0;
    this.lastAccess = { addr: 0, region: 'ROM0', type: 'read', seq: 0 };
    this.regionLastTouch = new Uint32Array(REGION_COUNT);
    this.lastBankSwitch = null; // { kind, addr, val, romBank, ramBank, t } or null
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

  // Clears everything back to its power-on/ROM-load state. Called from Emulator.loadROM().
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

  /* ---- per-frame lifecycle, called from Emulator.runFrame() ---- */

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

  /* ---- hardware event recorders, called from Emulator/MMU/PPU/APU ---- */

  // `bit` is the interrupt bit (0=vblank..4=joypad); `ly` is the scanline it fired on.
  recordInterrupt(bit, ly) {
    const kind = INTERRUPT_KIND_NAMES[bit];
    if (!kind) return;
    this.frameStats.interrupts[kind]++;
    if (this.trackAccess) this.frameStats.events.push({ line: ly, kind: 'int-' + kind });
  }

  // Called the instant an interrupt is actually dispatched (pushed PC and jumped to the
  // handler) — not just when the IF bit is set. `frame` is the frame it happened on.
  recordInterruptServiced(bit, pcBefore, frame) {
    this.interruptLog.push({ seq: this.interruptSeq++, frame, bit, pcBefore });
    if (this.interruptLog.length > this.INTERRUPT_LOG_SIZE) this.interruptLog.shift();
  }

  recordDMA(ly) {
    this.frameStats.dma++;
    if (this.trackAccess) this.frameStats.events.push({ line: ly, kind: 'dma' });
  }

  // Records a single bank-switch event (ROM/RAM bank, RAM enable, banking mode, RTC
  // register select) for the MBC Banking panel. Callers only invoke this once something
  // actually changed, so both the "last event" snapshot and the per-frame count always agree.
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

  // Records a single memory read/write for the Memory Map debug view. `regionId` is a
  // REGION_* id (see emu-gb-core.js), classified by the caller's own regionForAddr().
  recordMemAccess(addr, regionId, type) {
    this.accessSeq++;
    this.regionLastTouch[regionId] = this.accessSeq;
    const a = this.lastAccess;
    a.addr = addr; a.region = REGION_NAMES[regionId]; a.type = type; a.seq = this.accessSeq;
  }
}
