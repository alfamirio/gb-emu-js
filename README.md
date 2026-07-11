# JS GB Emulator

A from-scratch, single-file DMG (original Game Boy) emulator written in plain JavaScript. Built as an educational reference demonstrating how the LR35902 CPU, PPU, and memory map work together.

## Features

* **Complete CPU implementation:** Full DMG CPU instruction set (LR35902) including bit-field decoding grids and CB-prefixed operations.
* **Pixel Processing Unit (PPU):** Support for background, window, and sprite layers with real hardware line limits.
* **Cartridge mappers:** Built-in memory management unit supporting ROM-only, MBC1, and basic MBC3 cartridges.
* **Peripherals:** Integrated hardware timer loops (DIV/TIMA/TMA/TAC) and joypad register logic.
* **Zero dependencies:** Everything fits inside a standalone HTML/JS page with an interactive web UI.

## Scope limitations

To maximize source code readability for students, the following features are intentionally omitted:
* Audio Processing Unit (APU) sound channels.
* Game Boy Color (GBC) enhancements.
* Sub-instruction cycle-exact PPU or timer edge cases.

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
3. Use the integrated CPU/PPU debug panel to trace register flags and live status details.
