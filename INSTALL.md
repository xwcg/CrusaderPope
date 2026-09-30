# Installing CrusaderPope

## The easy way: a release

On <https://github.com/xwcg/CrusaderPope/releases> download either

- **CrusaderPope-<version>-win-x64.exe** — the setup: installs for your user (no administrator rights needed), with a
  Start menu entry; or
- **CrusaderPope-<version>-win-x64.zip** — portable: unpack anywhere and start `CrusaderPope.exe`.

Windows may warn about an unknown publisher (SmartScreen) because the release is not code-signed yet: *More info* →
*Run anyway*. On the first start a short setup finds your game (see step 4 below).

## From the source code

For developers, or to run the newest state. You download the code, install its dependencies once, and start it with
one command.

### 1. What you need

- **Crusader Kings III** installed through Steam, and started at least once (that creates the folder where your mods
  and playsets live).
- **Node.js 22 or newer** — download the "LTS" version from <https://nodejs.org> and install it with the default
  options.
- **Git** (optional, to download and update the source) — <https://git-scm.com>. Without Git, use GitHub's
  "Code → Download ZIP" instead.

### 2. Download

With Git:

```
git clone https://github.com/xwcg/CrusaderPope.git CrusaderPope
cd CrusaderPope
```

Without Git: download the ZIP from the repository page, unpack it, and open a terminal (PowerShell) in the unpacked
folder.

### 3. Install the dependencies (once)

```
npm install
```

This downloads the libraries the app needs, including its own copy of Electron (~100 MB).

### 4. Start

```
npm run build
npm start
```

The first start opens a short setup:

1. **The game** — the folder Crusader Kings III is installed in, the one that holds the `game` folder (for example
   `…\steamapps\common\Crusader Kings III`). It is usually found automatically; otherwise use *Browse…*. In Steam you
   find it with right-click on the game → *Manage* → *Browse local files*.
2. **Your mods and playsets** — the game's user folder, usually `Documents\Paradox Interactive\Crusader Kings III`.
3. **Language and graphics** — *Low* for older or integrated graphics, *High* for a strong graphics card.

Then *Start*. The first time, reading the whole game takes a little while (longer with big mods); later starts load it
from a cache.

All of this can be changed later in **Settings** (⚙ at the top right).

## Updating (source code)

```
git pull
npm install
npm run build
npm start
```

## Building the installer

```
npm run dist
```

writes the setup and the portable zip to `dist/` (electron-builder; `npm run dist:dir` only the unpacked app).

## Where CrusaderPope keeps its data

- Settings, caches and the undo history: `%APPDATA%\crusader-pope` (Windows). Deleting this folder resets the app to
  its first start.
- Your mods stay where the game keeps them. CrusaderPope never writes into the game's installation folder.
- Before it changes the launcher's playsets it makes a backup in your user folder's `crusaderpope-backups` folder.

## Troubleshooting

- **The window stays empty or white**: start it from a terminal (`npm start`) and look at the messages there.
- **"No Crusader Kings III folder"**: open Settings and choose the folder that contains `game`.
- **Slow or out of memory**: lower the graphics quality in Settings, and close other big programs; very large mods
  (total conversions) need more memory.
