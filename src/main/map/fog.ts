/**
 * The map's fog of war settings (docs/map.md, "Fog of war"): common/defines NFogOfWar (vanilla jomini/fog_of_war.txt,
 * a mod's own file replaces values (AGOT: `ALPHA_MIN = 0`, `KERNEL_SCALE = 12`)), read on every request through the
 * mods' layering, and the `sea` rows of adjacencies.csv (two provinces across a strait are neighbours too). The
 * drawing is the renderer's (components/map/fog*.ts).
 */
import { GameFiles } from '../mods/gamefiles.ts';
import type { MapFogInfo } from '../../shared/api.ts';
import { parse } from '../indexer/parser.ts';
import { seaAdjacencies } from './overlays-crossings.ts';

/** NFogOfWar's values: every file that has the block, later ones win. */
function fogDefines(vfs: GameFiles): Map<string, string | string[]>
{
    const d = new Map<string, string | string[]>();

    // (the game's files first, then each mod's in load order; within a source by path: a mod's own file beats the game's
    // whatever its name sorts as, AGOT's gh_vic3_fog_of_war.txt vs jomini/fog_of_war.txt)
    for (const f of vfs.list('common/defines', { ext: /\.txt$/i }).sort((a, b) => a.source - b.source))
    {
        const text = vfs.readText(f);

        if (!text || !/\bNFogOfWar\b/.test(text))
            continue;

        for (const top of parse(text))
            if (top.k === 'NFogOfWar' && Array.isArray(top.v))
            {
                for (const c of top.v)
                {
                    if (!c.k)
                        continue;

                    if (typeof c.v === 'string')
                        d.set(c.k, c.v);
                    else
                        d.set(c.k, c.v.map((x) => (typeof x.v === 'string' ? x.v : '')));
                }
            }
    }

    return d;
}

/** The fog of war's settings and the sea links of the loaded map. */
export function mapFog(vfs: GameFiles): MapFogInfo
{
    const d = fogDefines(vfs);
    const num = (k: string, def: number, lo = -Infinity, hi = Infinity): number =>
    {
        const v = d.get(k);
        const n = typeof v === 'string' ? parseFloat(v) : NaN;
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    const noise = d.get('NOISE_TEXTURE');
    const defaultMap = vfs.readText('map_data/default.map') ?? '';
    const af = vfs.get('map_data/' + (/^\s*adjacencies\s*=\s*"([^"]+)"/m.exec(defaultMap)?.[1] ?? 'adjacencies.csv'));
    const links: number[] = [];

    for (const a of af ? seaAdjacencies(vfs.readText(af) ?? '') : [])
        if (!a.river)
            links.push(a.from, a.to);

    // a mod that ships the mask's shader brings its own fog (AGOT: Victoria 3's clouds and shadow): its formulas cannot
    // be run here, so only the mask and the blend to black are drawn, no noise pattern
    const own = vfs.get('gfx/FX/jomini/jomini_fog_of_war.shader', { engine: true });
    // (a mod that only carries the engine's own text, like the generated patch mod's copy, changes nothing)
    const ownShader = !!own && own.source > 0 && vfs.readText(own, { engine: true }) !== new GameFiles(vfs.gameDir).readText('gfx/FX/jomini/jomini_fog_of_war.shader', { engine: true });
    return {
        alphaMin: num('ALPHA_MIN', 0.5, 0, 1),
        ownShader,
        patternStrength: ownShader ? 0 : num('PATTERN_STRENGTH', 0.6, 0, 1),
        patternTiling: num('PATTERN_TILING', 10, 0.01),
        fadeOutZoomStep: num('FADE_OUT_ZOOM_STEP', 9, 0),
        fadeOutSpeed: num('FADE_OUT_SPEED', 2, 0.1),
        contrast: num('CONTRAST', -0.8, -1, 1),
        brightness: num('BRIGHTNESS', 0, -1, 1),
        textureWidth: Math.round(num('TEXTURE_WIDTH', 4096, 64, 8192)),
        textureHeight: Math.round(num('TEXTURE_HEIGHT', 2048, 64, 8192)),
        kernelScale: num('KERNEL_SCALE', 4, 0),
        ...(typeof noise === 'string' && noise ? { noiseTexture: noise } : {}),
        realmAlpha: num('REALM_ALPHA', 1, 0, 1),
        neighborAlpha: num('REALM_NEIGHBOR_ALPHA', 1, 0, 1),
        links
    };
}
