#!/usr/bin/env bash
#
# build.sh - assemble every .asm file in a folder into a GB ROM
#            with RGBDS, without the logo.
#
# Usage:
#   ./build.sh [source_dir] [output_dir]
#
# Defaults to the current directory for both source and output if no
# arguments are given. Each foo.asm produces foo.gb.
#
# Note: skipping the logo means the header will fail the boot-logo check
# on real GB hardware (and on strict emulators/flash carts that
# enforce it). Most emulators (BGB, Emulicious, SameBoy in non-strict
# mode, mGBA, etc.) don't check it and will run the ROM fine.

set -euo pipefail

SRC_DIR="${1:-.}"
OUT_DIR="${2:-$SRC_DIR}"

for tool in rgbasm rgblink rgbfix; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "error: '$tool' not found in PATH. Install RGBDS: https://rgbds.gbdev.io/install" >&2
        exit 1
    fi
done

if [ ! -d "$SRC_DIR" ]; then
    echo "error: source directory '$SRC_DIR' not found" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

shopt -s nullglob
asm_files=("$SRC_DIR"/*.asm)
shopt -u nullglob

if [ ${#asm_files[@]} -eq 0 ]; then
    echo "error: no .asm files found in '$SRC_DIR'" >&2
    exit 1
fi

fail_count=0

for src in "${asm_files[@]}"; do
    name="$(basename "$src" .asm)"
    obj="$(mktemp -u --suffix=.o)"
    out="$OUT_DIR/$name.gb"

    echo "=== $name ==="
    echo "Assembling $src ..."
    if ! rgbasm -o "$obj" "$src"; then
        echo "error: failed to assemble $src" >&2
        rm -f "$obj"
        fail_count=$((fail_count + 1))
        continue
    fi

    echo "Linking -> $out ..."
    if ! rgblink -o "$out" "$obj"; then
        echo "error: failed to link $src" >&2
        rm -f "$obj"
        fail_count=$((fail_count + 1))
        continue
    fi

    echo "Fixing header (checksums only, no logo) ..."
    # -f hg = fix header checksum (h) + global checksum (g).
    # The 'l' flag (which writes the real logo) is deliberately omitted.
    rgbfix -f hg -p 0xFF "$out"

    rm -f "$obj"
    echo "Done: $out"
    echo
done

if [ "$fail_count" -gt 0 ]; then
    echo "Finished with $fail_count failure(s)." >&2
    exit 1
fi

echo "All ROMs built successfully."
