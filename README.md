# JS GB Emulator

A Game Boy emulator written in plain JavaScript, with two selectable cores: **DMG** (original Game Boy) and **CGB** (Game Boy Color). Built as an educational reference demonstrating how the LR35902 CPU, PPU, and memory map work together to turn a ROM file into a running game.

**This project is intended for educational use** — for learning how a real CPU/PPU/memory bus fits together, not as a polished player. 
Alongside normal emulation, it exposes the machine's internals as you go:

* **Live execution traces:** step through decoded instructions as the CPU fetches and runs them, with registers/flags updated in real time.
* **Memory inspection:** browse live RAM/VRAM/OAM/I/O contents and an interactive map of the full `0x0000`–`0xFFFF` address space, plus a Memory Scanner with saved cheats.
* **MBC bank-switching visualizer:** watch cartridge ROM/RAM banks swap in and out as a game writes to mapper control registers, including an MBC3 RTC (clock) viewer.
* **PPU/CPU debug panel:** trace register flags and other live status details while a ROM runs, plus an Event Log of hardware events.
* **Graphics/audio visualizers:** VRAM tile viewer, tile map + tile inspector/editor, BG/window/sprite layer viewer, OAM/sprite inspector, palette viewer, per-channel audio oscilloscope, and scanline timeline.

## Features

* **Two selectable cores:** a **GB / GBC** toggle in the UI forces every loaded ROM onto either the DMG core (`emu-gb-core.js`) or the CGB core (`emu-gbc-core.js`), regardless of what the cartridge header requests.
* **Complete CPU implementation:** full LR35902 instruction set, including CB-prefixed operations, shared unchanged between both cores.
* **PPU:** background, window, and sprite layers with real hardware line limits (10 sprites/line, etc.); CGB adds 2 VRAM banks, 8 background/8 sprite color palettes, and HDMA/GDMA transfers.
* **Peripherals:** hardware timers (`DIV`/`TIMA`/`TMA`/`TAC`) and joypad register logic, identical on both cores.
* **Audio:** all four APU channels (2 pulse, 1 wave, 1 noise) synthesized live via Web Audio.
* **TAS-lite input recording/playback:** record joypad input per frame from a save-state snapshot, then replay it deterministically; JSON export/import for sharing recordings.
* **Network link cable:** connect two browsers over WebRTC (PeerJS) to exchange serial-port bytes, for link-cable features like trading or linked battles.
* **Zero dependencies:** a single standalone HTML/JS page with the full debug/visualizer UI built in.

## Scope limitations

Both cores implement the full CPU, background/window/sprite rendering, timers, joypad input, all 4 sound channels, and several types of cartridges — enough to run many games. The CGB core additionally implements VRAM/WRAM banking, the BG/OBJ color palette RAM, HDMA/GDMA, and the double-speed mode — see [Game Boy vs Game Boy Color hardware](#game-boy-vs-game-boy-color-hardware) below for the full comparison and its known simplifications.

Read the heavily commented source for implementation details.

## How it fits together

Four pieces of hardware cooperate over a shared 16-bit bus: the **CPU** (LR35902 — an 8080/Z80 hybrid with 8 registers, `SP`/`PC`, and 4 flag bits `Z N H C`) executes code; the **PPU** turns VRAM/OAM into a 160×144 image; the **APU** generates 4-channel sound; and the **MMU** routes every address to the right backing memory. Real hardware — and this emulator — runs it all off one ~4.194304 MHz master clock, stepping PPU/timer/APU forward by however many cycles each CPU instruction took.

**Memory map:**

| Range | Region | On CGB |
|---|---|---|
| `0x0000`–`0x3FFF` | ROM bank 0 (fixed) | same |
| `0x4000`–`0x7FFF` | ROM bank N (switchable via mapper) | same |
| `0x8000`–`0x9FFF` | Video RAM | 2 banks, switchable via `VBK` (`0xFF4F`) |
| `0xA000`–`0xBFFF` | Cartridge RAM (if present) | same |
| `0xC000`–`0xDFFF` | Work RAM | bank 0 fixed + banks 1–7 switchable via `SVBK` (`0xFF70`) |
| `0xFE00`–`0xFE9F` | OAM (sprite table) | same |
| `0xFF00`–`0xFF7F` | I/O registers | adds `KEY1`/`VBK`/`HDMA1-5`/`BCPS`/`BCPD`/`OCPS`/`OCPD`/`SVBK` |
| `0xFF80`–`0xFFFE` | High RAM (HRAM) | same |
| `0xFFFF` | Interrupt Enable register | same |

**Mappers (MBC):** a chip in the cartridge remaps 16KB/8KB ROM/RAM chunks into the CPU's address windows via writes to control addresses, keyed off header byte `0x0147`. This emulator implements only the most common ones, see the [MBC reference](#mbc-reference-every-known-game-boy-mapper) below.

**PPU frame:** 154 scanlines/frame (144 visible + 10 V-Blank). Each visible line cycles Mode 2 (OAM search, 80 cycles) → Mode 3 (pixel transfer, ~172–289 cycles) → Mode 0 (H-Blank); V-Blank lines sit in Mode 1 and fire the V-Blank interrupt at line 144. Layers: scrollable 256×256 **background**, non-scrolling **window** (HUDs), and up to 40 **sprites** (max 10/line, matching real hardware). On the DMG core, color comes from `LCDC`/`STAT` and palettes `BGP`/`OBP0`/`OBP1`; the CGB core replaces those three palettes with 8 background + 8 sprite palettes in color palette RAM (`BCPS`/`BCPD`/`OCPS`/`OCPD`).

**Timers:** free-running `DIV` (16384 Hz) plus configurable `TIMA`, which increments at a `TAC`-selected rate, firing a Timer interrupt and reloading from `TMA` on overflow.

**Joypad:** one register (`0xFF00`) multiplexed to read either buttons (A/B/Select/Start) or D-pad, with held buttons reading as `0`.

**Sound:** CH1/CH2 pulse (CH1 also has frequency sweep), CH3 custom wave (from Wave RAM), CH4 noise (LFSR-driven) — mixed and streamed live to Web Audio at the browser's actual sample rate.

**Interrupts:** gated by `IME`; five sources (VBlank, LCD STAT, Timer, Serial, Joypad) each with a bit in `IE` (`0xFFFF`)/`IF` (`0xFF0F`). A bit set in both is what fires the interrupt. `EI` takes effect only after the *following* instruction executes (modeled here via an `eiDelay` counter).

At power-on this emulator skips the real boot ROM and initializes registers directly to the standard post-boot state before jumping to the cartridge at `0x0100`.

## Game Boy vs Game Boy Color hardware

Both cores share the same CPU instruction set, PPU timing, timers, joypad register, and 4-channel APU. The CGB core adds the following on top:

| Aspect | DMG (GB) | CGB (GBC) |
|---|---|---|
| CPU clock | 4.194304 MHz, single speed only | 4.194304 MHz, or 8.388608 MHz in double-speed mode (toggled via `KEY1`, `0xFF4D`) |
| Video RAM | 8 KB, 1 bank | 16 KB, 2 banks switchable via `VBK` (`0xFF4F`) — bank 1 holds BG/window tile attributes (palette, bank, flip) instead of tile data |
| Work RAM | 8 KB, fixed | 32 KB, 8×4KB banks — bank 0 fixed at `0xC000`, banks 1–7 switchable into `0xD000` via `SVBK` (`0xFF70`) |
| Background/window color | 1 palette, 4 fixed shades (`BGP`) | 8 palettes × 4 colors, addressed via `BCPS`/`BCPD` (`0xFF68`/`0xFF69`) |
| Sprite color | 2 palettes, 4 fixed shades (`OBP0`/`OBP1`) | 8 palettes × 4 colors, addressed via `OCPS`/`OCPD` (`0xFF6A`/`0xFF6B`) |
| Bulk VRAM transfer | Manual CPU writes only | HDMA/GDMA (`0xFF51`-`0xFF55`): instant general-purpose transfers, or one 16-byte block per H-Blank |
| Sprite priority mode | X-coordinate, then OAM index | OAM-index only (the CGB's `OPRI` register can request DMG-style priority; not implemented here) |
| Boot `A` register | `0x01` | `0x11` — the flag a game's own code checks to detect CGB hardware |

Known CGB-specific simplifications (consistent with the DMG core's own documented simplifications, like instant OAM DMA): general-purpose HDMA transfers happen instantly rather than costing M-cycles; H-Blank-mode HDMA transfers one block per H-Blank but doesn't stall the CPU for it; and CGB carts always boot with blank palette RAM rather than the real boot ROM's DMG-compatibility greyscale assignment, since every CGB-aware game writes its own palettes immediately anyway.

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
| **CGB** | Color Game Boy — the Game Boy Color's hardware name, as used in Pan Docs and this README. |
| **KEY1** | `0xFF4D` — arms and reports the CGB's double-speed CPU mode. |
| **VBK / SVBK** | `0xFF4F`/`0xFF70` — bank-select registers for CGB's 2 VRAM banks and 8 WRAM banks. |
| **BCPS/BCPD, OCPS/OCPD** | CGB background/sprite color palette index and data registers (`0xFF68`-`0xFF6B`). |
| **HDMA / GDMA** | CGB bulk VRAM transfer, either instant (general-purpose) or one block per H-Blank. |

## MBC reference: every known Game Boy mapper
**Only GB and GBC cores implemented.** No GBA or beyond (and will not implement, out of scope of this project).

Only **ROM ONLY**, **MBC1**, **MBC2**, **MBC3** and **MBC5** are implemented here. Other MBC or custom solutions not worth implementing.

| Mapper | Impl? | Max ROM | Max RAM | RTC | Rumble | ~% of library | Example games |
|---|---|---|---|---|---|---|---|
| **ROM ONLY** | ✅ | 32 KB | 8 KB opt | ❌ | ❌ | ~2-3% | *Tetris*, *SML1* |
| **MBC1** | ✅ | 2 MB | 32 KB | ❌ | ❌ | ~35-40% | *Pok Red*, *Zelda LA*, *SML2*, *WL1* |
| **MBC2** | ✅ | 256 KB | 512×4 bit, on-chip | ❌ | ❌ | ~2-3% | *Kirby PL* |
| **MBC3** | ✅ | 2 MB | 32 KB (64 KB MBC30) | ✅ | ❌ | ~15-20% | *Pok Gold* |
| **MBC5** | ✅ | 8 MB | 128 KB | ❌ | ✅ opt | ~35-40% | *Pok Yellow*, *Zelda OoS*, *WL3* |

## Further reading

**[Pan Docs](https://gbdev.io/pandocs/)** is the definitive community-maintained Game Boy hardware reference this emulator is based on. You can use rgbds and [rgbds-live](https://github.com/gbdev/rgbds-live) to compile your own games. A small snake demo game is included in this repository, compiled from asm and c code also included.

If you prefer to run local, [BGB](https://bgb.bircd.org/) is a highly accurate GB/GBC and debugger, widely used for testing and debugging homebrew code.

You can find GB homebrew games at [itch.io](https://itch.io/games/free/tag-gameboy). Check also itch.io [gbjam](https://itch.io/jam/gbjam-13).
Plain GB ROMs are recommended for a first look since they're simpler to reason about, but GBC ROMs work too — just make sure the GB/GBC core toggle matches what the ROM needs (see below).

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
2. Set the **GB / GBC** toggle in the navbar to match the ROM you're loading — GB forces the DMG core, GBC forces the CGB core, regardless of what the cartridge header requests.
3. Drag and drop any compatible legal `.gb`/`.gbc` ROM into the interface.
4. Use the CPU/PPU debug panel and the memory-map / MBC banking visualizers to watch the emulator's internals in real time.

## Play-Time Guardrail & Commercial Game Filter

This emulator is for academic use only, not recreation. It includes two automated controls:

1. **Time Limit**: Tracks ROM runtime. Warns at 80% and reloads the page at 100% (20 minutes default) to end the session.
2. **Game Filter**: Checks the ROM's CRC32 against a database of commercial No-Intro titles. Matches are blocked immediately, restricting use to homebrew and student projects.


## Disclaimer

This project is an independently developed Game Boy emulator written entirely in JavaScript for educational purposes. It is not affiliated with, endorsed, sponsored, or approved by Nintendo or any of its subsidiaries.

All emulator code in this repository does not contain private source code. No BIOS/boot ROM files, commercial game ROMs, graphics, audio, or other proprietary assets are included.

Users are responsible for obtaining and using any ROM files in accordance with applicable laws. The use of freely licensed or public-domain homebrew ROMs is strongly recommended.
