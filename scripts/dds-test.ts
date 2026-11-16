// Decodes a few DDS files of every format to PNG for visual checks.
// Usage: node --experimental-strip-types scripts/dds-test.ts <outDir> [relPath …]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { decodeDds, downscale, parseDds, formatLabel } from '../src/main/images/dds.ts';
import { encodePng, isPng } from '../src/main/images/png.ts';
import { defaultInstall } from './ck3-install.ts';

const GFX = defaultInstall() + '/game/';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const given = process.argv.slice(3).length > 0;
const files = given
    ? process.argv.slice(3)
    : [
        'gfx/interface/icons/traits/brave.dds', // BGRA32
        'gfx/interface/illustrations/event_scenes/throneroom_west.dds', // DXT1 or DXT5
        'gfx/interface/bookmarks/bm_1066_china.dds', // DXT5
        'gfx/interface/icons/knight_badge/icons/accolade_trait_aggressive_blue.dds', // BC7
        'gfx/interface/icons/character_interactions/artifact.dds', // DXT3
        'gfx/map/surround_map/surround_cloud.dds', // BC4
        'gfx/portraits/accessory_variations/textures/ccp5_helmet_high_palette.dds', // RGB24
        'gfx/models/portraits/male_head/male_head_diffuse.dds',
        'gfx/models/portraits/male_head/male_head_normal.dds',
        'gfx/interface/icons/knight_badge/frame/accolades_frames_background.dds' // a PNG under a .dds name (the game ships it)
    ];

for (const rel of files)
{
    // (a default file the game no longer has is skipped, not an error: files get renamed between versions)
    if (!given && !existsSync(join(GFX, rel)))
    {
        console.log(`${rel}: skipped, not in this game version`);
        continue;
    }

    try
    {
        const buf = readFileSync(join(GFX, rel));
        const info = isPng(buf) ? undefined : parseDds(buf);
        const t0 = performance.now();
        const img = downscale(await decodeDds(buf, 512), 512);
        const png = encodePng(img.rgba, img.width, img.height);
        const f = join(out, basename(rel).replace(/\.dds$/, '.png'));
        writeFileSync(f, png);
        // (the PNG sniff: a PNG under a .dds name must decode, with the PNG's own size)
        if (!info && !(img.width > 0 && img.height > 0 && img.rgba.length === img.width * img.height * 4))
            throw new Error('PNG under a .dds name did not decode to pixels');

        console.log(`${rel}: ${info ? `${formatLabel(info)} ${info.width}x${info.height} mips=${info.mips}` : `PNG under a .dds name ${img.width}x${img.height}`} → ${img.width}x${img.height} ${(performance.now() - t0).toFixed(1)}ms ${png.length}B`);
    }
    catch (e)
    {
        console.log(`${rel}: ERROR ${(e as Error).message}`);
        process.exitCode = 1;
    }
}
