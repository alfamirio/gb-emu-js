#!/usr/bin/env bash
#
# build.sh - Master script to run both assembly and C build processes
#
# Usage:
#   ./build.sh [source_dir] [output_dir]

set -euo pipefail

SRC_DIR="${1:-./games}"
OUT_DIR="${2:-$SRC_DIR}"

echo "============================================="
echo " Starting Master Game Boy Build Pipeline"
echo "============================================="
echo "Source Directory: $SRC_DIR"
echo "Output Directory: $OUT_DIR"
echo "---------------------------------------------"

# Check for required child scripts in the current directory
if [ ! -x "./build-asm.sh" ] || [ ! -x "./build-c.sh" ]; then
    echo "error: build-asm.sh and build-c.sh must exist and be executable in this directory." >&2
    exit 1
fi

# Run Assembly Compilation
if [ -f "$SRC_DIR/snake.asm" ]; then
    echo ">>> Processing Assembly targets (found snake.asm)..."
    if ! ./build-asm.sh "$SRC_DIR" "$OUT_DIR"; then
        echo "Warning or error occurred during C compilation."
    fi
else
    echo ">>> Skipping Assembly targets (no recognized Assembly entry file found in $SRC_DIR)."
fi

echo "---------------------------------------------"

# Run C Compilation
if [ -f "$SRC_DIR/main.c" ]; then
    echo ">>> Processing C targets (found main.c)..."
    if ! ./build-c.sh "$SRC_DIR" "$OUT_DIR"; then
        echo "Warning or error occurred during C compilation."
    fi
else
    echo ">>> Skipping C targets (no recognized C entry file found in $SRC_DIR)."
fi

echo "============================================="
echo " Master Pipeline Execution Completed."
echo "============================================="
