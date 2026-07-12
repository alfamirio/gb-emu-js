#!/usr/bin/env bash
#
# build.sh - compile main.c into csnake.gb using GBDK-2020 lcc
#            without the boot logo.
#
# Usage:
#   ./build.sh [source_dir] [output_dir]

set -euo pipefail

SRC_DIR="${1:-./games}"
OUT_DIR="${2:-$SRC_DIR}"

# Check for GBDK-2020 compiler
if ! command -v lcc >/dev/null 2>&1; then
    echo "error: 'lcc' not found in PATH. Install GBDK-2020 to compile C files." >&2
    exit 1
fi

# Check for RGBDS tool to patch checksums
if ! command -v rgbfix >/dev/null 2>&1; then
    echo "error: 'rgbfix' not found in PATH. Install RGBDS to fix ROM headers." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "error: source directory '$SRC_DIR' not found" >&2
    exit 1
fi

if [ ! -f "$SRC_DIR/main.c" ]; then
    echo "error: main.c not found in '$SRC_DIR'" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
c_out="$OUT_DIR/c_snake.gb"

echo "=== Compiling csnake ==="

# Compile tiles.c alongside main.c if it exists
if [ -f "$SRC_DIR/tiles.c" ]; then
    echo "Compiling main.c and tiles.c with lcc -> $c_out ..."
    lcc -o "$c_out" "$SRC_DIR/main.c" "$SRC_DIR/tiles.c"
else
    echo "Compiling main.c with lcc -> $c_out ..."
    lcc -o "$c_out" "$SRC_DIR/main.c"
fi

echo "Fixing C header (checksums only, no logo) ..."
# -f hg = fix header checksum (h) + global checksum (g).
# The 'l' flag (which writes the real logo) is deliberately omitted.
rgbfix -f hg -p 0xFF "$c_out"

# --- Automatically clean up intermediate files ---
echo "Cleaning up intermediate build files..."
# Deletes intermediate files in both the root and the source folder
rm -f *.o *.obj *.s *.lst *.sym *.noi *.ihx *.map
rm -f "$SRC_DIR"/*.o "$SRC_DIR"/*.obj "$SRC_DIR"/*.s "$SRC_DIR"/*.lst "$SRC_DIR"/*.sym "$SRC_DIR"/*.noi "$SRC_DIR"/*.ihx "$SRC_DIR"/*.map

echo "Done: $c_out"
echo "ROM built successfully."
