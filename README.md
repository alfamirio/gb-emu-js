# JS GB Emulator

A from-scratch, single-file DMG (original Game Boy) emulator written in plain JavaScript. Built as an educational reference demonstrating how the LR35902 CPU, PPU, and memory map work together to turn a ROM file into a running game.

**This project is intended for educational use** — for learning how a real CPU/PPU/memory bus fits together, not as a polished player. Alongside normal emulation, it exposes the machine's internals as you go:

* **Live execution traces:** step through decoded instructions as the CPU fetches and runs them, with register and flag values updated in real time.
* **Memory inspection:** browse live RAM/VRAM/OAM/I/O contents and an interactive map of the full `0x0000`–`0xFFFF` address space, showing which region backs which address.
* **MBC bank-switching visualizer:** watch cartridge ROM/RAM banks swap in and out of the CPU's address window as a game writes to mapper control registers.
* **PPU/CPU debug panel:** trace register flags and other live status details while a ROM runs.

## Features

* **Complete CPU implementation:** Full DMG CPU instruction set (LR35902) including bit-field decoding grids and CB-prefixed operations.
* **Pixel Processing Unit (PPU):** Support for background, window, and sprite layers with real hardware line limits.
* **Cartridge mappers:** Built-in memory management unit supporting ROM-only, MBC1, and basic MBC3 cartridges.
* **Peripherals:** Integrated hardware timer loops (DIV/TIMA/TMA/TAC) and joypad register logic.
* **Audio:** All four APU sound channels (two pulse channels, a wave channel, and a noise channel) synthesized live through the Web Audio API.
* **Zero dependencies:** Everything fits inside a standalone HTML/JS page with an interactive web UI, including a debug panel and visualizers for the memory map and MBC bank switching.

## Scope limitations

To maximize source code readability for students, the following features are intentionally omitted:
* Game Boy Color (GBC) enhancements.
* Sub-instruction cycle-exact PPU, timer, or APU edge cases.

Scope note: this implements the full DMG CPU instruction set, background/window/sprite rendering, timers, joypad input, sound (all 4 APU channels via Web Audio), and ROM-only / MBC1 / basic MBC3 cartridges — enough to run many real games. It intentionally leaves out GB Color features and cycle-exact PPU/timer/APU edge cases to keep the source readable as a learning reference.

Read the heavily commented source (view page source) to see how each piece works.

## How a Game Boy actually works

The original Game Boy (codenamed "DMG", for "Dot Matrix Game") is built around four cooperating pieces of hardware: a CPU that executes game code, a PPU that turns video RAM into pixels, an APU that generates sound, and a memory bus that ties everything — including the cartridge — together. Real hardware runs all of this in lockstep at a master clock of ~4.194304 MHz; this emulator reproduces that by stepping the PPU, timer, and APU forward by however many clock cycles each CPU instruction took, once per instruction, so every component stays in sync.

### 1. The CPU — Sharp LR35902

The LR35902 is a hybrid chip, roughly an Intel 8080 core with some Zilog Z80 instructions mixed in (and a few Z80 features, like an alternate register set, left out). It exposes:

* **Eight 8-bit registers** — `A, B, C, D, E, H, L`, plus a flags register — that are frequently paired up into four 16-bit "virtual" registers: `AF`, `BC`, `DE`, and `HL`. `HL` in particular is used constantly as a pointer into memory (e.g. `LD (HL), A` writes `A` to the address `HL` holds).
* **Two 16-bit pointers**: the **Stack Pointer (`SP`)**, used for `PUSH`/`POP` and `CALL`/`RET`, and the **Program Counter (`PC`)**, which always holds the address of the next instruction to fetch.
* **Four flag bits** in the low nibble of `F`: **Z** (zero — set when a result is 0), **N** (subtract — tracks whether the last op was addition or subtraction, used by `DAA`), **H** (half-carry — carry out of bit 3, needed for BCD correction), and **C** (carry — carry/borrow out of bit 7).
* **An instruction set decoded in two grids**: the base opcode table (`0x00`–`0xFF`) and a second table reached via the `0xCB` prefix byte, which holds all the single-bit test/set/reset and rotate/shift operations (e.g. `BIT 7, H`, `SET 3, (HL)`, `SRL A`).
* **Interrupts**, gated by the **IME** (Interrupt Master Enable) flag. Five interrupt sources exist — VBlank, LCD STAT, Timer, Serial, and Joypad — each with its own bit in the `IE` (enable) and `IF` (flag/request) registers at `0xFFFF` and `0xFF0F`. `EI` famously doesn't take effect until *after* the instruction following it has executed, a quirk this emulator models explicitly with an `eiDelay` counter.

At power-on, the boot ROM has already run and left the CPU in a known state before handing off to the cartridge at address `0x0100`: `AF=0x01B0, BC=0x0013, DE=0x00D8, HL=0x014D, SP=0xFFFE, PC=0x0100`, with `Z`, `H`, and `C` all set. Emulators that skip the actual boot ROM image (as this one does) simply initialize the registers to these values directly and jump straight to `0x0100`.

**Example — a tiny loop the CPU might execute:**
```
LD  A, 0x05      ; A = 5
loop:
DEC A            ; A = A - 1   (sets Z when A hits 0, sets N)
JR  NZ, loop      ; jump back to `loop` while Z is not set
```
This decrements `A` from 5 to 0, looping four times before falling through — the same kind of tight timing loop real games use to wait out a fixed number of cycles.

### 2. Memory map

The CPU sees a single flat 16-bit address space (`0x0000`–`0xFFFF`), but different address ranges are physically backed by different hardware — cartridge ROM, cartridge RAM, the console's own work RAM, video RAM, and memory-mapped I/O registers:

| Range | Region |
|---|---|
| `0x0000`–`0x3FFF` | ROM bank 0 (fixed) |
| `0x4000`–`0x7FFF` | ROM bank N (switchable via the mapper) |
| `0x8000`–`0x9FFF` | Video RAM (tile data + tile maps) |
| `0xA000`–`0xBFFF` | Cartridge RAM (switchable, if present) |
| `0xC000`–`0xDFFF` | Work RAM |
| `0xFE00`–`0xFE9F` | OAM (sprite attribute table) |
| `0xFF00`–`0xFF7F` | I/O registers (joypad, timer, PPU, sound, etc.) |
| `0xFF80`–`0xFFFE` | High RAM ("HRAM"), fast scratch space |
| `0xFFFF` | Interrupt Enable register |

### 3. Cartridges and memory bank controllers (MBCs)

A Game Boy cartridge is just ROM (and sometimes battery-backed RAM) — but most games are bigger than the 32 KB the CPU can address directly at once. A **mapper chip** inside the cartridge sits between the CPU and the ROM/RAM chips and remaps ("banks") different 16 KB or 8 KB chunks into the CPU's visible address windows whenever the game writes to specific "control" addresses. This emulator's MMU recognizes the cartridge header byte at `0x0147` and implements:

* **ROM ONLY** (type `0x00`) — no banking at all; the whole 32 KB ROM is just mapped in directly.
* **MBC1** (types `0x01`–`0x03`) — the most common mapper. Writing to `0x2000`–`0x3FFF` selects the ROM bank visible at `0x4000`–`0x7FFF`; writing to `0x4000`–`0x5FFF` selects either the RAM bank or the upper ROM bank bits, depending on a banking-mode bit set via `0x6000`–`0x7FFF`.
* **MBC3** (types `0x0F`–`0x13`) — similar bank-select scheme to MBC1, plus support for larger ROM/RAM sizes and (on real hardware) a real-time-clock chip.

**Example:** if a 512 KB game writes the value `0x05` to address `0x2000`, the MBC1 logic swaps ROM bank 5 into the `0x4000`–`0x7FFF` window, so the next instruction fetched from, say, `0x4010` now comes from byte `5 × 0x4000 + 0x0010` of the ROM file rather than bank 1. The in-app "MBC Banking" visualizer shows exactly this happening in real time as a loaded game runs.

### 4. The PPU (Pixel Processing Unit) and how a frame is drawn

The Game Boy's LCD is 160×144 pixels with a 4-shade grayscale (or green-tinted, on original DMG hardware) palette. The PPU builds each frame line-by-line, cycling through four modes for every one of the 154 scanlines (144 visible + 10 vertical blank):

1. **Mode 2 — OAM search** (80 cycles): scans the 40-entry sprite table (OAM, at `0xFE00`–`0xFE9F`) to find up to 10 sprites that intersect the current line.
2. **Mode 3 — pixel transfer** (~172–289 cycles): actually draws the line, compositing background, window, and sprite pixels together.
3. **Mode 0 — HBlank**: idle time padding the line out to a fixed total length, during which the CPU may safely modify VRAM/OAM without visual corruption.
4. **Mode 1 — VBlank** (10 scanlines' worth): after all 144 visible lines are drawn, the PPU fires the VBlank interrupt and idles, giving the game a safe window to update graphics data for the next frame.

The three layers composited each line are:
* **Background** — a scrollable 256×256 pixel tilemap (scrolled via the `SCX`/`SCY` registers) built from 8×8 pixel tiles stored in VRAM.
* **Window** — a second, non-scrolling tile layer (positioned via `WX`/`WY`) typically used for HUDs and status bars, drawn on top of the background.
* **Sprites (objects)** — up to 40 movable 8×8 or 8×16 pixel entities read from OAM, each with its own tile, position, and palette/flip flags, with a hardware limit of 10 visible per scanline (a real limitation this emulator reproduces, so too many sprites on one line will flicker or vanish just like on real hardware).

All of this is driven by `LCDC` (`0xFF40`, the master on/off and layer-enable register), `STAT` (`0xFF41`, current mode + interrupt sources), and the palette registers `BGP`/`OBP0`/`OBP1` (`0xFF47`–`0xFF49`), which map each tile's 2-bit color index to one of the four on-screen shades.

### 5. Timers

A free-running **`DIV`** register (`0xFF04`) increments continuously at 16384 Hz and resets to 0 whenever written. A separate, configurable **`TIMA`** counter (`0xFF05`) increments at a rate chosen by `TAC` (`0xFF07`), and fires a Timer interrupt and reloads itself from `TMA` (`0xFF06`) whenever it overflows past `0xFF` — the basic mechanism games use for time-based logic (animation timing, frame pacing, etc.) independent of the PPU.

### 6. Joypad input

A single register at `0xFF00` is read twice by software, once with a "select buttons" bit set (to read A/B/Select/Start) and once with a "select d-pad" bit set (to read Up/Down/Left/Right) — the same four physical input lines are multiplexed to report both button groups. Bits read `0` when the corresponding button is held, `1` when released.

### 7. Sound (APU)

The Audio Processing Unit mixes four independent channels into stereo output, each with its own enable/length/volume/frequency controls in the `0xFF10`–`0xFF3F` register range:

* **Channel 1 & 2 — Pulse/square wave**, each with programmable duty cycle and a volume envelope; channel 1 additionally supports a frequency sweep effect (rising/falling pitch, as heard in classic power-up or laser sound effects).
* **Channel 3 — Custom wave**, playing back a 32-sample, 4-bit waveform the game writes directly into "Wave RAM" (`0xFF30`–`0xFF3F`) — used for melodic instrument-style sounds.
* **Channel 4 — Noise**, driven by a linear-feedback shift register (LFSR) rather than a waveform, used for percussion and explosion-style effects.

This emulator synthesizes all four channels live and streams them to the Web Audio API, matching the AudioContext's actual sample rate at runtime rather than assuming a fixed 44.1 kHz, since that varies by OS and hardware.

## Further reading

For the full, definitive hardware reference this emulator is based on, see **[Pan Docs](https://gbdev.io/pandocs/)** — the community-maintained, single most comprehensive Game Boy technical reference, covering the CPU instruction set, memory map, PPU/LCD behavior, MBC mappers, timers, and sound hardware in far more depth than this README.

## Keyboard controls

| Key | Game Boy Button |
|---|---|
| **Arrow keys** | D-Pad |
| **Z** | A button |
| **X** | B button |
| **Enter** | Start |
| **Shift** | Select |

## Development and usage

1. Open the source `.html` file in any modern web browser.
2. Drag and drop any compatible legal `.gb` or `.gbc` ROM into the interface.
3. Use the integrated CPU/PPU debug panel to trace register flags and live status details, and the memory-map / MBC banking visualizers to watch cartridge bank switching happen in real time as the game runs.
