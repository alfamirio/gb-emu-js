#!/usr/bin/env bash
#
# install-rgbds.sh - fetch and install the latest prebuilt RGBDS release
#                     (rgbasm, rgblink, rgbfix, rgbgfx) for Linux x86_64.
#                     No compiling - just downloads and installs the
#                     official prebuilt binaries.
#
# Usage:
#   ./install-rgbds.sh [prefix]
#
#   prefix   install prefix (default: /usr/local, falls back to
#            ~/.local if that's not writable and sudo isn't available)

set -euo pipefail

PREFIX="${1:-/usr/local}"
WORKDIR="$(mktemp -d)"
REPO="gbdev/rgbds"

cleanup() {
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> Looking up latest RGBDS release"
LATEST_TAG="$(curl -sL "https://github.com/$REPO/releases/latest" \
    | grep -oE "/$REPO/releases/tag/[^\"']+" \
    | head -1 \
    | sed -E "s#/$REPO/releases/tag/##")"

if [ -z "$LATEST_TAG" ]; then
    echo "error: could not determine the latest RGBDS release tag." >&2
    exit 1
fi
echo "    latest release: $LATEST_TAG"

ASSET="rgbds-linux-x86_64.tar.xz"
URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$ASSET"

echo "==> Downloading $ASSET"
curl -sL -o "$WORKDIR/$ASSET" "$URL"

if ! file "$WORKDIR/$ASSET" | grep -q "XZ compressed"; then
    echo "error: download failed or asset not found at $URL" >&2
    exit 1
fi

echo "==> Extracting"
tar -xf "$WORKDIR/$ASSET" -C "$WORKDIR"

echo "==> Installing to $PREFIX"
install_binaries() {
    local dest_bin="$1/bin"
    local dest_man1="$1/share/man/man1"
    local dest_man5="$1/share/man/man5"
    local dest_man7="$1/share/man/man7"

    install -d "$dest_bin" "$dest_man1" "$dest_man5" "$dest_man7"
    install -m 755 "$WORKDIR"/rgbasm "$WORKDIR"/rgblink "$WORKDIR"/rgbfix "$WORKDIR"/rgbgfx "$dest_bin/"
    install -m 644 "$WORKDIR"/rgbasm.1 "$WORKDIR"/rgblink.1 "$WORKDIR"/rgbfix.1 "$WORKDIR"/rgbgfx.1 "$dest_man1/"
    install -m 644 "$WORKDIR"/rgbds.5 "$WORKDIR"/rgbasm.5 "$WORKDIR"/rgbasm-old.5 "$WORKDIR"/rgblink.5 "$dest_man5/"
    install -m 644 "$WORKDIR"/rgbds.7 "$WORKDIR"/gbz80.7 "$dest_man7/"
}

if [ -w "$PREFIX" ] || [ "$(id -u)" -eq 0 ]; then
    install_binaries "$PREFIX"
elif command -v sudo >/dev/null 2>&1; then
    export WORKDIR
    sudo bash -c "$(declare -f install_binaries); install_binaries '$PREFIX'"
else
    PREFIX="$HOME/.local"
    echo "no write access to the requested prefix and no sudo available;"
    echo "falling back to $PREFIX"
    install_binaries "$PREFIX"
    echo "note: add '$PREFIX/bin' to your PATH if it isn't already:"
    echo "  export PATH=\"$PREFIX/bin:\$PATH\""
fi

echo "==> Done"
for tool in rgbasm rgblink rgbfix rgbgfx; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "  $("$tool" --version)"
    else
        echo "  $tool installed to $PREFIX/bin (not yet on PATH in this shell)"
    fi
done
