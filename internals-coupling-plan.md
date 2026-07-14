# Decoupling plan: stop `app.js`/`debug.js` touching `cpu`/`mmu`/`ppu`/`apu`/`joypad` directly

Scope: no module/loading changes here — everything below happens inside the current
classic-script codebase. The goal is that by the end, `app.js` and `debug.js` only ever
call methods on `emulator` (the public runtime API) or `emulator.instrumentation` /
`emulator.stats` (debug introspection) — never `emulator.cpu.X`, `emulator.mmu.X`,
`emulator.ppu.X`, `emulator.apu.X`, `emulator.joypad.X`, or a bare `PPU`/`CGBPPU` class
reference.

An audit of every such touch in both files found two genuinely different things happening,
which is why this is two tracks, not one:

- **Track A — real runtime operation.** Rendering a frame, playing audio, reading input,
  loading/saving battery RAM, checking "is a ROM loaded" — a host *has* to be able to do
  these to run the emulator at all. This becomes part of `GBEmulator`'s actual public API.
- **Track B — debug-only introspection/mutation.** Register/memory/PPU-state viewers,
  the disassembler, breakpoints, the MBC/RTC/OAM inspector panels, the tile/palette
  viewers. Nothing here is required to play a game. This goes through `Instrumentation`
  (execution/state) or `CoreStats` (counters — already isolated, not touched here).

Both tracks are broken into independent phases: add the method, swap the call sites that
need it, delete the old direct access, verify, move on. Order between the two tracks
doesn't matter — they touch disjoint call sites — so do them in whichever order you like,
or interleave them.

---

## Track A — widen `GBEmulator`'s public API

### A1. Video — `getFramebuffer()`
```js
getFramebuffer() { return this.ppu.framebuffer; }
```
Replaces: `app.js:42` (`emulator.ppu.framebuffer` in `draw()`).

### A2. Audio output — `drainAudioSamples(n)`, `setSampleRate(hz)`
`app.js`'s `drainAudioRing()` currently pokes `apu.available`, `apu.ringL/ringR`,
`apu.readPos`, `apu.RING_SIZE`, `apu.lastL/lastR` directly — five separate internal
fields for what is really one operation. Move the whole loop into `GBEmulator`/`APU`:
```js
// on GBEmulator, delegating to this.apu
drainAudioSamples(bufferSize) { return this.apu.drain(bufferSize); } // returns {left, right}
setSampleRate(hz) { this.apu.setSampleRate(hz); }
```
Replaces: `app.js:73-86` (`drainAudioRing`, rewritten to call `emulator.drainAudioSamples(n)`
and delete the ring-buffer logic from `app.js` entirely), `app.js:100`, `app.js:147`.

### A3. Input — `setButton(bit, pressed, isDirection)`
Thin passthrough — signature unchanged, just moved from `joypad` onto `emulator`:
```js
setButton(bit, pressed, isDirection) { this.joypad.setButton(bit, pressed, isDirection); }
```
Replaces: `app.js:908-909` (`emulator.joypad.setButton(...)` → `emulator.setButton(...)`).

### A4. ROM / battery-save state — `hasROM()`, `getCartRAM()`, `setCartRAM(bytes)`
```js
hasROM() { return !!(this.mmu.rom && this.mmu.rom.length); }
getCartRAM(size) { return this.mmu.cartRAM.slice(0, size ?? this.mmu.cartRAM.length); }
setCartRAM(bytes) {
  const n = Math.min(bytes.length, this.mmu.cartRAM.length);
  this.mmu.cartRAM.set(bytes.subarray(0, n));
}
```
Replaces: `app.js:957`, `app.js:1036` (`hasROM()`), `app.js:1151` (`.sav` export →
`getCartRAM(size)`), `app.js:1175-1177` (`.sav` import → `setCartRAM(bytes)`), and the
same `mmu.rom` check repeated at `debug.js:785`, `debug.js:803`, `debug.js:827`.

### A5. Channel mute — `getChannelMuted(ch)`, `setChannelMuted(ch, muted)`, `getAllChannelMuted()`
This is a real audio-engine parameter (it gates `amp1..amp4` in the mixer), not just a
debug readout — `app.js` persists it on every save regardless of whether any debug panel
is open, so it belongs on the emulator's own API even though the toggle UI for it lives
in `debug.js`'s oscilloscope panel.
```js
getChannelMuted(ch) { return this.apu.chMuted[ch]; }
setChannelMuted(ch, muted) { this.apu.chMuted[ch] = muted; }
getAllChannelMuted() { return this.apu.chMuted.slice(); }
```
Replaces: `app.js:837`, `debug.js:1412`, `debug.js:1416`, `debug.js:1423`.

### A6. Screen model / tint — `setScreenModel(mode)`
Currently `debug.js:779` does `PPU.SHADES = isGBP ? PPU.PALETTE_GBP : PPU.PALETTE_GB` —
a direct mutation of a **static property on the PPU class**, from outside core. Move it
onto the emulator:
```js
setScreenModel(mode /* 'gb' | 'gbp' */) {
  PPU.SHADES = mode === 'gbp' ? PPU.PALETTE_GBP : PPU.PALETTE_GB;
}
```
Replaces: `debug.js:779`. This is the highest-value fix in Track A — it's the one place
something outside core was rewriting shared engine state rather than reading it, and it's
also what lets `PPU` disappear from core's export list once modularization happens.

**Verification after Track A:** play a ROM end to end — video renders, audio plays and
responds to the sample-rate the AudioContext reports, input works, save/load `.sav`
round-trips, per-channel mute buttons still silence the right channel, the GB/GBP model
toggle still repaints with the right tint. `app.js` should have zero remaining references
to `emulator.cpu`, `.mmu`, `.ppu`, `.apu`, `.joypad`, or bare `PPU`/`CGBPPU`.

---

## Track B — extend `Instrumentation` (and lean on what already exists)

Good news first: `readRegisters()` and `walkStack()` already exist and are already used
correctly by the register panel and stack viewer. The gaps are everything below.

### B1. Register reads that bypass `readRegisters()` — call-site fix only, no new code
`app.js:800/812/818/824/830` (`Stepped — now at PC=${hex16(emulator.cpu.PC)}` status
text) and `debug.js:1977` (`emulator.cpu.PC` for disassembly) and `debug.js:2077`
(`emulator.cpu.SP` for the stack view) all read a single register directly instead of
calling the method that already exists for this. Swap them to
`emulator.instrumentation.readRegisters().PC` / `.SP`. Zero new methods — purely deleting
five bypasses of an API that's already there.

### B2. Register writes — `writeRegister(key, value)`
The register editor already reads through `readRegisters()` but writes straight to
`emulator.cpu[spec.key]` (`debug.js:2111`, `debug.js:2119`). Mirror the read method:
```js
writeRegister(key, value) { this.emulator.cpu[key] = value; }
```
Replaces: `commitRegInput`/`commitRegFlag` in `debug.js` (~2109-2120).

### B3. Memory editor write — `writeMemory(addr, value)`
`debug.js:495` calls `emulator.mmu.write8(addr, val)` directly — deliberately the *real*
write path (side effects included), unlike `walkStack()`'s use of `peek8`. Give it the
same treatment as B2:
```js
writeMemory(addr, value) { this.emulator.mmu.write8(addr, value); }
```

### B4. Generic byte/region reads — `peekByte(addr)`, `readROM(range)`, `readVRAM(bank, range)`, `readOAM(range)`
`debug.js` currently calls `mmu.peek8` directly at nine separate call sites (lines 347,
563, 635, 649, 664, 667, 671, 1049, 1054/1055/1069) plus reads `mmu.rom` (1982, 1985,
2016), `mmu.oam` (1228-1305), and `mmu.vram`/`vramBanks` via the local `vramBank()`
helper (911, 936). Consolidate into a small set of Instrumentation methods:
```js
peekByte(addr) { return this.emulator.mmu.peek8(addr); }
readROM(start, length) { return this.emulator.mmu.rom.subarray(start, start + length); }
readVRAM(bank, start, length) {
  const src = this.emulator.mmu.vramBanks ? this.emulator.mmu.vramBanks[bank & 1] : this.emulator.mmu.vram;
  return src.subarray(start, start + length);
}
readOAM(start, length) { return this.emulator.mmu.oam.subarray(start, start + length); }
```
This also absorbs the current standalone `vramBank(mmu, bank)` helper in `debug.js`,
which can be deleted once callers use `readVRAM()` instead.

### B5. MBC / banking state — `readMBCState()`
The MBC Banking panel (`debug.js` ~189-350, 642-726) reads `mmu.mbcType`,
`.currentROMBank`, `.currentRAMBank`, `.ramEnabled`, `.rtcSelect`, `.hasTimer`,
`.cartTypeSupported`, `.ie`, `.io` across a dozen-plus call sites. One aggregate read
method covers all of it, same shape as `readRegisters()`:
```js
readMBCState() {
  const m = this.emulator.mmu;
  return {
    mbcType: m.mbcType, romBank: m.currentROMBank, ramBank: m.currentRAMBank,
    ramEnabled: m.ramEnabled, rtcSelect: m.rtcSelect, hasTimer: m.hasTimer,
    cartTypeSupported: m.cartTypeSupported, ie: m.ie, io: m.io,
  };
}
```
Treat this list as a starting point, not final — re-check the full MBC panel section
against it while doing this phase, since that section is large enough that a field could
easily have been missed in this audit.

### B6. RTC panel — `readRTCState()` + passthroughs for the existing actions
`syncRtcInputsFromLive()`/`drawRTC()` call `mmu.tickRTC()` then read `mmu.rtc.{dh,dl,h,m,s}`
directly; the panel's buttons (Set clock / Set to now / Clear day-carry / Zero clock,
~lines 1889-1911 in `index.html`) presumably call further `mmu`/`rtc` methods not fully
enumerated here. Wrap the read side first:
```js
readRTCState() { this.emulator.mmu.tickRTC(); return { ...this.emulator.mmu.rtc }; }
```
then give each RTC button a matching `Instrumentation` passthrough method (e.g.
`setRTCTime(...)`, `haltRTC(bool)`, `applyRTCCorrection(h, m)`, `clearRTCCarry()`,
`zeroRTC()`) once you've read the button handlers and confirmed the exact set of
`mmu`/`rtc` calls each one makes — this phase needs a closer look at that click-handler
code than this audit covered.

### B7. PPU / scanline state — `readPPUState()`
Covers the register/IO readout (`debug.js:2151`), the scanline timeline panel
(`ppu.mode`, `.modeClock`, `.ly`, ~1495-1550), and scattered `ppu.lcdc`/`.scx`/`.scy`/
`.wx`/`.wy` reads used by the layer/tile viewers (~1035-1297):
```js
readPPUState() {
  const p = this.emulator.ppu;
  return { ly: p.ly, mode: p.mode, modeClock: p.modeClock, lcdc: p.lcdc,
           scx: p.scx, scy: p.scy, wx: p.wx, wy: p.wy };
}
```

### B8. Sprite/OAM inspection — `readSpritesForLine(line)`
Wraps `ppu.getSpriteCandidatesForLine()` / `ppu.getSpriteRowBits()` plus the `mmu.oam`
reads used together in the sprite-per-line viewer (~1142-1231):
```js
readSpritesForLine(line) {
  const p = this.emulator.ppu;
  return p.getSpriteCandidatesForLine(line); // shape depends on what the viewer needs from getSpriteRowBits/mmu.oam alongside this — confirm during implementation
}
```

### B9. Pixel/palette decode — absorb `isCGBRun()`, `bgWindowPixelRGB()`, `spritePixelRGB()`
These three functions already exist in `debug.js` (~908-928) and already correctly
encapsulate the DMG/CGB branching logic for the tile/layer/palette viewers — they just
live on the wrong side of the boundary, reaching into `ppu.mmu.getPaletteRGB`,
`ppu.applyPalette`, `ppu.bgp`/`.obp0`/`.obp1`, `ppu.getBGWindowPixel`,
`ppu.bgWindowTileDataConfig`, `ppu.getTileColorIndex`, and the static
`PPU.spriteRowColorIndex` (line 1154). Move all three functions verbatim into
`Instrumentation` as methods (`instrumentation.bgWindowPixelRGB(...)`,
`instrumentation.spritePixelRGB(...)`) and delete them from `debug.js`. This is the
phase that removes the last two reasons `PPU`/`CGBPPU` were ever needed as class
references in `debug.js`.

### B10. CGB-mode detection — call-site fix only, no new code
`debug.js`'s `isCGBRun()` currently does `emulator.ppu instanceof CGBPPU`. Once B9 moves
`isCGBRun()` itself into `Instrumentation`, that method can switch to
`this.emulator instanceof CGBEmulator` — the exact same check `app.js:652` already uses
for the model-toggle-disable logic. One consistent way to detect CGB mode, and `CGBPPU`
no longer needs to be referenced from outside `emu-gbc-core.js` at all.

**Verification after Track B:** open every debug panel (Registers/Stack, Trace/Disasm,
Memory Map, MBC Banking, RTC, Tile Viewer, Layer Viewer, Palette Viewer, Scanline
Timeline, Oscilloscope) against both a DMG and a CGB ROM, edit a register, edit a memory
cell, toggle the screen model. `debug.js` should have zero remaining references to
`emulator.cpu`, `.mmu`, `.ppu`, `.apu`, or bare `PPU`/`CGBPPU`.

---

## Suggested order

Both tracks are internally ordered roughly cheapest/lowest-risk → most involved. A
reasonable overall sequence:

1. **A1–A6** (Track A) — self-contained, and it's what actually blocks anyone from ever
   needing to import `MMU`/`APU`/`Joypad`/`PPU` later.
2. **B1** — free, call-site-only, builds confidence in the pattern.
3. **B2–B4** — the generic read/write primitives most other phases lean on.
4. **B9–B10** — kills the remaining `PPU`/`CGBPPU` class references, the other thing
   blocking a minimal module export list.
5. **B5–B8** — the larger panel-specific state readers; do these last since they're the
   ones most likely to need re-checking against code this audit didn't fully trace
   (RTC button handlers, the exact sprite-viewer data shape).

Once both tracks are done, revisit the modularization plan — at that point `emu-gb-core.js`
and `emu-gbc-core.js` should genuinely only need to export `GBEmulator` and `CGBEmulator`.
