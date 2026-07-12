#!/usr/bin/env bash
#
# install-gbdk.sh - Automate GBDK-2020 installation on Linux x64

set -euo pipefail

INSTALL_DIR="$HOME/gbdk"
BASHRC="$HOME/.bashrc"

echo "=== GBDK-2020 Installer ==="

# 1. Fetch the latest release tag from GitHub API
echo "Checking for the latest version..."
LATEST_TAG=$(curl -s https://api.github.com/repos/gbdk-2020/gbdk-2020/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
echo "Found version: $LATEST_TAG"

# 2. Download the Linux 64-bit tarball
URL="https://github.com/gbdk-2020/gbdk-2020/releases/download/${LATEST_TAG}/gbdk-linux64.tar.gz"
echo "Downloading from $URL ..."
curl -L -o /tmp/gbdk-linux64.tar.gz "$URL"

# 3. Clean old installation if it exists and extract
if [ -d "$INSTALL_DIR" ]; then
    echo "Removing previous GBDK installation at $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
fi

echo "Extracting files to $HOME ..."
tar -xzf /tmp/gbdk-linux64.tar.gz -C "$HOME"
rm /tmp/gbdk-linux64.tar.gz

# 4. Add to PATH inside .bashrc if not already present
if ! grep -q "gbdk/bin" "$BASHRC"; then
    echo "Adding GBDK to PATH inside $BASHRC..."
    echo 'export PATH=$PATH:$HOME/gbdk/bin' >> "$BASHRC"
    echo 'export GBDKDIR=$HOME/gbdk/' >> "$BASHRC"
else
    echo "GBDK path configuration already exists in $BASHRC."
fi

echo "=== Installation complete ==="
echo "Please reload your terminal profile by running:"
echo "  source ~/.bashrc"
echo "Then verify the installation with: lcc --version"
