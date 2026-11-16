#!/bin/bash
# WSL (Ubuntu): the Linux AppImage and .deb of the app built on Windows (`npm run build` first), offline, from the
# folder scripts/linux-tools.sh filled. Works in ~/cpb (WSL's own disk: Linux file modes, fast), copies the packages
# to the repo's dist/. On a Linux machine with internet `npm run dist:linux` does the same directly.
# Usage (from Windows): wsl -d Ubuntu -- bash /mnt/d/CrusaderPope/scripts/dist-linux-wsl.sh /mnt/c/…/<tools folder> [--modules]
set -e
T=${1:?usage: dist-linux-wsl.sh <tools folder> [--modules]}
R=$(cd "$(dirname "$0")/.." && pwd)
W=~/cpb
A=$W/app

# Node, the AppImage toolset, fpm and Electron from the tools folder (once)
if [ ! -x ~/.local/node/bin/node ]; then
  mkdir -p ~/.local/node
  tar -xJf "$T/node-linux.tar.xz" -C ~/.local/node --strip-components=1
fi
mkdir -p $W/tools/appimage $W/electron
[ -x $W/tools/appimage/mksquashfs ] || tar -xzf "$T/appimage-tools-runtime-20251108.tar.gz" -C $W/tools/appimage
[ -x $W/tools/fpm/fpm ] || { cp -r "$T/fpm" $W/tools/fpm; chmod -R u+x $W/tools/fpm; }
cp -u "$T"/electron/*.zip $W/electron/
export PATH=~/.local/node/bin:$PATH

# the app: package.json, LICENSE, the built out/, the script database (package.json's extraResources),
# node_modules (copied once, or again with --modules) without Electron's Windows binaries
mkdir -p $A
rm -rf $A/out $A/dist $A/data
cp "$R/package.json" "$R/LICENSE" $A/
cp -r "$R/out" $A/out
mkdir -p $A/data/script-db
cp "$R"/data/script-db/*.sqlite $A/data/script-db/
if [ ! -d $A/node_modules ] || [ "$2" = "--modules" ]; then
  rm -rf $A/node_modules
  (cd "$R" && tar --exclude='node_modules/electron/dist' --exclude='node_modules/dprint' --exclude='node_modules/@dprint' -cf - node_modules) | (cd $A && tar -xf -)
fi

cd $A
APPIMAGE_TOOLS_PATH=$W/tools/appimage CUSTOM_FPM_PATH=$W/tools/fpm/fpm \
  node node_modules/electron-builder/cli.js --linux -c.electronDist=$W/electron -c.npmRebuild=false
cp dist/*.AppImage dist/*.deb dist/latest-linux.yml "$R/dist/"
ls -la "$R/dist" | grep -i linux
