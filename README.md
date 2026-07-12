# JS GB Emulator

A from-scratch, single-file DMG (original Game Boy) emulator written in plain JavaScript. Built as an educational reference demonstrating how the LR35902 CPU, PPU, and memory map work together to turn a ROM file into a running game.

**This project is intended for educational use** — for learning how a real CPU/PPU/memory bus fits together, not as a polished player. 
Alongside normal emulation, it exposes the machine's internals as you go:

* **Live execution traces:** step through decoded instructions as the CPU fetches and runs them, with registers/flags updated in real time.
* **Memory inspection:** browse live RAM/VRAM/OAM/I/O contents and an interactive map of the full `0x0000`–`0xFFFF` address space.
* **MBC bank-switching visualizer:** watch cartridge ROM/RAM banks swap in and out as a game writes to mapper control registers.
* **PPU/CPU debug panel:** trace register flags and other live status details while a ROM runs.

## Features

* **Complete CPU implementation:** full DMG (LR35902) instruction set, including CB-prefixed operations.
* **PPU:** background, window, and sprite layers with real hardware line limits (10 sprites/line, etc.).
* **Peripherals:** hardware timers (`DIV`/`TIMA`/`TMA`/`TAC`) and joypad register logic.
* **Audio:** all four APU channels (2 pulse, 1 wave, 1 noise) synthesized live via Web Audio.
* **Zero dependencies:** a single standalone HTML/JS page with the full debug/visualizer UI built in.

## Scope limitations

Intentionally omitted to keep the source readable for students:
* Game Boy Color (GBC).
* Sub-instruction cycle-exact PPU/timer/APU edge cases.

It does implement the full DMG CPU, background/window/sprite rendering, timers, joypad input, all 4 sound channels, and several types of cartridges — enough to run many games.

Read the heavily commented source (view page source) for implementation details.

## How it fits together

Four pieces of hardware cooperate over a shared 16-bit bus: the **CPU** (LR35902 — an 8080/Z80 hybrid with 8 registers, `SP`/`PC`, and 4 flag bits `Z N H C`) executes code; the **PPU** turns VRAM/OAM into a 160×144 image; the **APU** generates 4-channel sound; and the **MMU** routes every address to the right backing memory. Real hardware — and this emulator — runs it all off one ~4.194304 MHz master clock, stepping PPU/timer/APU forward by however many cycles each CPU instruction took.

**Memory map:**

| Range | Region |
|---|---|
| `0x0000`–`0x3FFF` | ROM bank 0 (fixed) |
| `0x4000`–`0x7FFF` | ROM bank N (switchable via mapper) |
| `0x8000`–`0x9FFF` | Video RAM |
| `0xA000`–`0xBFFF` | Cartridge RAM (if present) |
| `0xC000`–`0xDFFF` | Work RAM |
| `0xFE00`–`0xFE9F` | OAM (sprite table) |
| `0xFF00`–`0xFF7F` | I/O registers |
| `0xFF80`–`0xFFFE` | High RAM (HRAM) |
| `0xFFFF` | Interrupt Enable register |

**Mappers (MBC):** a chip in the cartridge remaps 16KB/8KB ROM/RAM chunks into the CPU's address windows via writes to control addresses, keyed off header byte `0x0147`. This emulator implements ROM ONLY (`0x00`), MBC1 (`0x01`–`0x03`), and MBC3 (`0x0F`–`0x13`).

**PPU frame:** 154 scanlines/frame (144 visible + 10 V-Blank). Each visible line cycles Mode 2 (OAM search, 80 cycles) → Mode 3 (pixel transfer, ~172–289 cycles) → Mode 0 (H-Blank); V-Blank lines sit in Mode 1 and fire the V-Blank interrupt at line 144. Layers: scrollable 256×256 **background**, non-scrolling **window** (HUDs), and up to 40 **sprites** (max 10/line, matching real hardware). Controlled via `LCDC`, `STAT`, and palettes `BGP`/`OBP0`/`OBP1`.

**Timers:** free-running `DIV` (16384 Hz) plus configurable `TIMA`, which increments at a `TAC`-selected rate, firing a Timer interrupt and reloading from `TMA` on overflow.

**Joypad:** one register (`0xFF00`) multiplexed to read either buttons (A/B/Select/Start) or D-pad, with held buttons reading as `0`.

**Sound:** CH1/CH2 pulse (CH1 also has frequency sweep), CH3 custom wave (from Wave RAM), CH4 noise (LFSR-driven) — mixed and streamed live to Web Audio at the browser's actual sample rate.

**Interrupts:** gated by `IME`; five sources (VBlank, LCD STAT, Timer, Serial, Joypad) each with a bit in `IE` (`0xFFFF`)/`IF` (`0xFF0F`). A bit set in both is what fires the interrupt. `EI` takes effect only after the *following* instruction executes (modeled here via an `eiDelay` counter).

At power-on this emulator skips the real boot ROM and initializes registers directly to the standard post-boot state (`AF=0x01B0, BC=0x0013, DE=0x00D8, HL=0x014D, SP=0xFFFE, PC=0x0100`) before jumping to the cartridge at `0x0100`.

## Glossary

| Term | Meaning |
|---|---|
| **T-cycle** | One tick of the 4.194304 MHz master clock (~0.238µs). |
| **M-cycle** | 4 T-cycles; the unit most instruction timings are given in. |
| **CPU (LR35902)** | The Game Boy's processor, a Sharp 8080/Z80 hybrid. |
| **PPU** | Turns VRAM/OAM into the 160×144 image, one scanline at a time. |
| **APU** | The 4-channel sound generator. |
| **MMU** | Routes CPU memory accesses to the right RAM/ROM/register bank. |
| **MBC** | Cartridge chip that bank-switches ROM/RAM into the CPU's address window. |
| **VRAM / OAM / HRAM / WRAM** | `0x8000-0x9FFF` tiles/tilemaps; `0xFE00-0xFE9F` sprite table; `0xFF80-0xFFFE` scratch RAM (DMA-safe); `0xC000-0xDFFF` general game RAM. |
| **DMA** | Hardware bulk copy — here, OAM DMA (160 bytes, 160 M-cycles). |
| **LCDC / STAT** | `0xFF40` master PPU control; `0xFF41` mode + interrupt sources. |
| **SCX/SCY, WX/WY** | Background scroll and window position registers. |
| **BGP/OBP0/OBP1** | Palette registers mapping 2-bit color indices to on-screen shades. |
| **DIV/TIMA/TMA/TAC** | Timer divider, counter, reload value, control register. |
| **IE/IF/IME** | Interrupt Enable, Interrupt Flag, and the CPU-internal master enable. |
| **LFSR** | Pseudo-random generator driving the noise channel (CH4). |
| **Duty cycle / Envelope / Sweep** | Pulse-wave shape; auto volume-over-time; CH1's auto pitch-slide. |
| **Tile / Tilemap** | 8×8 pixel graphic block; 32×32 grid of tile indices forming a layer. |

## MBC reference: every known Game Boy mapper
**Only GB. no GBC implemented.**

Only **ROM ONLY**, **MBC1**, **MBC2**, **MBC3** and **MBC5** are implemented here (percentages are rough estimates):

| Mapper | Implemented? | Max ROM | Max RAM | RTC | Rumble | ~% of library | Example games |
|---|---|---|---|---|---|---|---|
| **ROM ONLY** | ✅ | 32 KB | 8 KB (optional) | No | No | ~2-3% | *Tetris*, *Alleyway* |
| **MBC1** | ✅ | 2 MB (125 usable banks) | 32 KB | No | No | ~35-40% | *Pokémon Red/Blue*, *Zelda: Link's Awakening* |
| **MBC2** | ✅ | 256 KB | 512×4 bit, on-chip | No | No | ~2-3% | *Kirby's Pinball Land*, *Final Fantasy Legend* |
| **MBC3** | ✅ | 2 MB | 32 KB (64 KB Crystal/MBC30) | ✅ | No | ~15-20% | *Pokémon Gold/Silver/Crystal* |
| **MBC5** | ✅ | 8 MB | 128 KB | No | ✅ optional | ~35-40% | *Pokémon Yellow*, *Wario Land 2* |

Notes: MBC1 and MBC5 together dominate the library (adoption flipped to MBC5 once GBC launched, since it's the only Nintendo mapper guaranteed correct in CGB double-speed mode). MBC3 is the only one here with a built-in RTC (used by *Pokémon Gold/Silver/Crystal* for day/night and berry growth). Other MBC or custom solutions not worth implementing.

## Further reading

**[Pan Docs](https://gbdev.io/pandocs/)** is the definitive community-maintained Game Boy hardware reference this emulator is based on. You can use rgbds and [rgbds-live](https://github.com/gbdev/rgbds-live) to compile your own games. A small snake demo game is included in this repository, compiled from asm and c code also included.

You can find GB homebrew games at [itch.io](https://itch.io/games/free/tag-gameboy). Check also itch.io [gbjam](https://itch.io/jam/gbjam-13).

Examples:
- [birb](https://lazydevs.itch.io/birb). H platf.
- [cherry rescue](https://grafxkid.itch.io/cherry-rescue). H platf.
- [dmg deals damage](https://drludos.itch.io/dmg-deals-damage). Battle.
- [wrecking balloon](https://neighto.itch.io/wrecking-balloon). Battle.
- [dangan gb](https://snorpung.itch.io/dangan-gb). Battle.
- [dino advance](https://frzit.itch.io/google-dino-advance). Survive.
- [black castle](https://user0x7f.itch.io/black-castle) and [black castle 2](https://user0x7f.itch.io/black-castle-2). Exploration.
- [dogs muck island](https://soully.itch.io/dogs-muck-island). Exploration.
- [hop n revoke](https://jaiware.itch.io/hop-n-revoke). Puzzle.
- [sheep it up](https://drludos.itch.io/sheep-it-up). V platf.
- [tobu tobu girl](https://tangramgames.itch.io/tobutobugirl). V platf.

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
2. Drag and drop any compatible legal `.gb` ROM into the interface.
3. Use the CPU/PPU debug panel and the memory-map / MBC banking visualizers to watch the emulator's internals in real time.

## Disclaimer

This project is an independently developed Game Boy emulator written entirely in JavaScript for educational purposes. It is not affiliated with, endorsed, sponsored, or approved by Nintendo or any of its subsidiaries.

All emulator code in this repository does not contain private source code. No BIOS/boot ROM files, commercial game ROMs, graphics, audio, or other proprietary assets are included.

Users are responsible for obtaining and using any ROM files in accordance with applicable laws. The use of freely licensed or public-domain homebrew ROMs is strongly recommended.
