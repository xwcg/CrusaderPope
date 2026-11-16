#!/bin/bash
# Windows (Git Bash), for scripts/dist-linux-wsl.sh: downloads what electron-builder's Linux targets need into one
# folder: Node for Linux, the Linux Electron, the AppImage toolset (static runtime: no libfuse2 on the user's side) and
# fpm (the .deb), fpm unpacked with Windows' tar (libarchive reads 7z). For a WSL without internet (docs/dev-gotchas.md).
# Usage: scripts/linux-tools.sh <folder>      (versions below: keep them in step with package.json / electron-builder)
set -e
OUT=${1:?usage: scripts/linux-tools.sh <folder>}
ELECTRON=$(node -p "require('./node_modules/electron/package.json').version")
NODE=v22.20.0
BIN=https://github.com/electron-userland/electron-builder-binaries/releases/download
mkdir -p "$OUT/electron" "$OUT/fpm"
cd "$OUT"
curl -sSfL -o node-linux.tar.xz "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz"
curl -sSfL -o "electron/electron-v$ELECTRON-linux-x64.zip" "https://github.com/electron/electron/releases/download/v$ELECTRON/electron-v$ELECTRON-linux-x64.zip"
curl -sSfL -o appimage-tools-runtime-20251108.tar.gz "$BIN/appimage%401.0.3/appimage-tools-runtime-20251108.tar.gz"
curl -sSfL -o fpm.7z "$BIN/fpm%402.1.4/fpm-1.17.0-ruby-3.4.3-linux-amd64.7z"
/c/Windows/System32/tar.exe -xf fpm.7z -C fpm
rm fpm.7z
echo "ready: $OUT (Electron $ELECTRON, Node $NODE)"
