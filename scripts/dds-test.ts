// Decodes a few DDS files of every format to PNG for visual checks.
// Usage: node --experimental-strip-types scripts/dds-test.ts <outDir> [relPath …]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { decodeDds, downscale, parseDds, formatLabel } from '../src/main/images/dds.ts';
import { encodePng } from '../src/main/images/png.ts';
import { defaultInstall } from './ck3-install.ts';

const GFX = defaultInstall() + '/game/';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const files = process.argv.slice(3).length
    ? process.argv.slice(3)
    : [
        'gfx/interface/icons/traits/brave.dds', // BGRA32
        'gfx/interface/illustrations/event_scenes/throne_room.dds', // DXT1 or DXT5
        'gfx/interface/bookmarks/bm_1066_china.dds', // DXT5
        'gfx/interface/icons/knight_badge/icons/accolade_trait_aggressive_blue.dds', // BC7
        'gfx/interface/icons/character_interactions/artifact.dds', // DXT3
        'gfx/map/surround_map/surround_cloud.dds', // BC4
        'gfx/portraits/accessory_variations/textures/ccp5_helmet_high_palette.dds', // RGB24
        'gfx/models/portraits/male_head/male_head_diffuse.dds',
        'gfx/models/portraits/male_head/male_head_normal.dds'
    ];

for (const rel of files)
{
    try
    {
        const buf = readFileSync(join(GFX, rel));
        const info = parseDds(buf);
        const t0 = performance.now();
        const img = downscale(await decodeDds(buf, 512), 512);
        const png = encodePng(img.rgba, img.width, img.height);
        const f = join(out, basename(rel).replace(/\.dds$/, '.png'));
        writeFileSync(f, png);
        console.log(`${rel}: ${formatLabel(info)} ${info.width}x${info.height} mips=${info.mips} → ${img.width}x${img.height} ${(performance.now() - t0).toFixed(1)}ms ${png.length}B`);
    }
    catch (e)
    {
        console.log(`${rel}: ERROR ${(e as Error).message}`);
    }
}
