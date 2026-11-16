/**
 * Holdings on the 3D map (docs/map.md, "3D map", Holdings): each barony's holding at the date drawn at its province's
 * `buildings` locator (gfx/map/map_object_data/building_locators.txt: `game_object_locator={ name="buildings" instances={
 * { id=<province> position={ x 0 z } rotation={ quaternion } scale } } }`). The model: the holding type's primary
 * building (common/holdings `primary_building`: castle_01, city_01, temple_01 …) and of its `assets = { asset = { type =
 * pdxmesh name graphical_cultures graphical_regions graphical_faiths provinces names } }` the first that fits: the
 * county culture's `building_gfx`, the province's graphical region (map_data/geographical_regions `graphical = yes`),
 * the county faith's `graphical_faith`, the province; the most specific that fits. DLC flags count as owned; levels above _01 are not read (history
 * names few buildings).
 * Special buildings (and great buildings, `type = special | great_building`) the same way at the province's
 * `special_building` locator (special_building_locators.txt), from their own assets; duchy capital buildings have none.
 * Walls around a holding: the `is_graphical_background` buildings (walls_00 … walls_04, wallRule / wallsOf) at its locator.
 */
import type { GameFiles } from '../mods/gamefiles.ts';
import { parse, type PNode } from '../indexer/parser.ts';

export interface HoldingAsset
{
    mesh: string;
    /** `names = { … }`: meshes to choose from (by the province) */
    names?: string[];
    cultures?: Set<string>;
    regions?: string[];
    faiths?: Set<string>;
    provinces?: Set<number>;
    /** (while reading: the names are entities') */
    entity?: boolean;
}

export interface HoldingRules
{
    /** holding type → its primary building */
    primary: Map<string, string>;
    /** building → its assets in order (the primary buildings', the special and great buildings') */
    assets: Map<string, HoldingAsset[]>;
    /** every mesh an asset can name (the objects build loads them) */
    meshes: string[];
    /** the background buildings (walls), in file order */
    walls: WallRule[];
    /** buildings that give a fort level of their own (`province_modifier = { fort_level }`: castle_01, tribe_01 …) */
    fortified: Set<string>;
}

/**
 * A background building's `is_enabled` as far as the map reads it (99_background_graphics_buildings.txt):
 * `has_building_or_higher` in its OR (`up`) and NOR (`nor`), `is_county_capital = yes` / `fort_level > 0` in the OR
 * (`capitalOrFort`), `NOT = { government_has_flag = government_is_tribal }` (`notTribal`), the no-walls rule (`none`:
 * `is_county_capital = no` with `fort_level < 1`).
 */
export interface WallRule
{
    building: string;
    up: string[];
    nor: string[];
    capitalOrFort: boolean;
    notTribal: boolean;
    none: boolean;
}

function wallRule(building: string, list: PNode[]): WallRule
{
    const rule: WallRule = { building, up: [], nor: [], capitalOrFort: false, notTribal: false, none: false };
    const walk = (l: PNode[], ctx: 'or' | 'nor' | 'not' | 'and'): void =>
    {
        for (const c of l)
        {
            const v = typeof c.v === 'string' ? c.v.replace(/"/g, '') : undefined;

            if (c.k === 'has_building_or_higher' && v && (ctx === 'or' || ctx === 'nor'))
                (ctx === 'or' ? rule.up : rule.nor).push(v);
            else if (c.k === 'is_county_capital' && v === 'yes' && ctx === 'or')
                rule.capitalOrFort = true;
            else if (c.k === 'fort_level' && c.op === '>' && ctx === 'or')
                rule.capitalOrFort = true;
            else if (c.k === 'is_county_capital' && v === 'no' && ctx === 'and')
                rule.none = true;
            else if (c.k === 'government_has_flag' && v === 'government_is_tribal' && ctx === 'not')
                rule.notTribal = true;
            else if (Array.isArray(c.v) && c.k !== 'scope:holder')
                walk(c.v, c.k === 'OR' ? 'or' : c.k === 'NOR' ? 'nor' : c.k === 'NOT' ? 'not' : c.k === 'AND' ? 'and' : ctx);
            else if (Array.isArray(c.v))
                walk(c.v, ctx === 'and' ? 'or' : ctx);
        }
    };
    walk(list, 'and');
    return rule;
}

/** `has_building_or_higher = X_0n`: a building of X's line at level n or above (`curtain_walls_03` has `curtain_walls_02`). */
function hasOrHigher(built: Set<string>, want: string): boolean
{
    if (built.has(want))
        return true;

    const m = /^(.*_)(\d+)$/.exec(want);

    if (!m)
        return false;

    for (const b of built)
        if (b.startsWith(m[1]) && /^\d+$/.test(b.slice(m[1].length)) && +b.slice(m[1].length) >= +m[2])
            return true;

    return false;
}

/**
 * Which walls a holding gets (the background building): the highest whose buildings it has (the special walls'
 * (Toledo, Lugo …) none), else the basic walls when it is the county capital or fortified, else none. `built`: the
 * province's buildings at the date (history `buildings`, its holding's primary building, its special building);
 * `tribal` its holder's government taken from the holding (tribal holding), `herder` the same (no walls).
 */
export function wallsOf(rules: WallRule[], built: Set<string>, capital: boolean, fort: boolean, tribal: boolean, herder: boolean): string | undefined
{
    const none = rules.find((r) => r.none);

    if (herder || (none && none.up.some((b) => hasOrHigher(built, b))))
        return none?.building;

    for (let i = rules.length - 1; i >= 0; i--)
    {
        const r = rules[i];

        if (r.none || !r.up.length || (r.notTribal && tribal) || r.nor.some((b) => hasOrHigher(built, b)))
            continue;

        if (r.up.some((b) => hasOrHigher(built, b)))
            return r.building;
    }

    const basic = rules.find((r) => r.capitalOrFort && !r.nor.some((b) => hasOrHigher(built, b)));
    return (capital || fort) && basic ? basic.building : none?.building;
}

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const words = (n: PNode | undefined): string[] => kids(n).flatMap((c) => (!c.k && typeof c.v === 'string' ? [c.v.replace(/"/g, '')] : []));
const scalar = (list: PNode[], k: string): string | undefined =>
{
    const v = list.find((c) => c.k === k)?.v;
    return typeof v === 'string' ? v.replace(/"/g, '') : undefined;
};

/** The holding types' primary buildings, the special and great buildings, and those buildings' assets (common/holdings, common/buildings). */
export function holdingRules(vfs: GameFiles): HoldingRules
{
    const primary = new Map<string, string>();

    for (const f of vfs.list('common/holdings', { ext: /\.txt$/i }))
        for (const n of parse(vfs.readText(f) ?? ''))
        {
            const b = n.k && scalar(kids(n), 'primary_building');

            if (n.k && b)
                primary.set(n.k, b);
        }

    // (the primary buildings' lines: castle_01 … castle_04: a level's own assets)
    const lines = new Set([...primary.values()].map((b) => b.replace(/\d+$/, '')));
    const wanted = (k: string): boolean => /\d+$/.test(k) && lines.has(k.replace(/\d+$/, ''));
    const assets = new Map<string, HoldingAsset[]>();
    const meshes = new Set<string>();
    const walls: WallRule[] = [];
    const entities = new Set<string>();
    const fortified = new Set<string>();

    for (const f of vfs.list('common/buildings', { ext: /\.txt$/i }))
        for (const n of parse(vfs.readText(f) ?? ''))
        {
            const background = scalar(kids(n), 'is_graphical_background') === 'yes';

            if (!n.k || !(wanted(n.k) || background || SPECIAL.test(scalar(kids(n), 'type') ?? '')))
                continue;

            if (background)
            {
                const en = kids(n).find((c) => c.k === 'is_enabled');
                walls.push(wallRule(n.k, kids(en)));
            }

            const block = kids(n).find((c) => c.k === 'assets');
            const list = (block ? kids(block) : kids(n)).filter((c) => c.k === 'asset');
            const out: HoldingAsset[] = [];

            for (const a of list)
            {
                const l = kids(a);

                const kind = scalar(l, 'type');

                if (kind !== 'pdxmesh' && kind !== 'entity')
                    continue;

                const names = words(l.find((c) => c.k === 'names'));
                const mesh = scalar(l, 'name') ?? names[0];

                if (!mesh)
                    continue;

                const set = (k: string): Set<string> | undefined =>
                {
                    const w = words(l.find((c) => c.k === k));
                    return w.length ? new Set(w) : undefined;
                };
                const regions = words(l.find((c) => c.k === 'graphical_regions'));
                const provinces = words(l.find((c) => c.k === 'provinces')).map(Number);
                out.push({
                    mesh,
                    ...(names.length ? { names } : {}),
                    ...(set('graphical_cultures') ? { cultures: set('graphical_cultures') } : {}),
                    ...(regions.length ? { regions } : {}),
                    ...(set('graphical_faiths') ? { faiths: set('graphical_faiths') } : {}),
                    ...(provinces.length ? { provinces: new Set(provinces) } : {})
                });

                for (const m of names.length ? names : [mesh])
                    (kind === 'entity' ? entities : meshes).add(m);

                if (kind === 'entity')
                    out[out.length - 1].entity = true;
            }

            assets.set(n.k, out);

            if (kids(kids(n).find((c) => c.k === 'province_modifier')).some((c) => c.k === 'fort_level'))
                fortified.add(n.k);
        }

    // (`type = entity` assets name an entity: its .asset's `entity = { name pdxmesh }`, drawn as that mesh)
    if (entities.size)
    {
        const of = entityMeshes(vfs, entities);

        for (const [k, list] of assets)
            assets.set(k, list.flatMap((a) =>
            {
                if (!a.entity)
                    return [a];

                const names = a.names?.map((n) => of.get(n)).filter((n): n is string => !!n);
                const mesh = of.get(a.mesh) ?? names?.[0];

                if (!mesh)
                    return [];

                for (const m of names?.length ? names : [mesh])
                    meshes.add(m);

                return [{ ...a, mesh, ...(names?.length ? { names } : {}), entity: false }];
            }));
    }

    return { primary, assets, meshes: [...meshes], walls, fortified };
}

/**
 * Entities' meshes (`dir`/**.asset `entity = { name = "x" pdxmesh = "y" … }`: the first pdxmesh of the block, which
 * runs to the next `entity =`) for the names asked.
 */
export function entityMeshes(vfs: GameFiles, names: Set<string>, dir = 'gfx/models/buildings', scales?: Map<string, number>): Map<string, string>
{
    const out = new Map<string, string>();

    for (const f of vfs.list(dir, { ext: /\.asset$/i, engine: true }))
    {
        const text = vfs.readText(f) ?? '';

        if (![...names].some((n) => text.includes(n)))
            continue;

        const starts = [...text.matchAll(/\bentity\s*=\s*\{/g)].map((m) => m.index);

        for (let i = 0; i < starts.length; i++)
        {
            const block = text.slice(starts[i], starts[i + 1] ?? text.length);
            const name = /\bname\s*=\s*"([^"]+)"/.exec(block)?.[1];
            const mesh = /\bpdxmesh\s*=\s*"([^"]+)"/.exec(block)?.[1];

            if (name && mesh && names.has(name) && !out.has(name))
            {
                out.set(name, mesh);
                // (the entity's own `scale = 0.02`: the sheep are modelled in centimetres; ahead of its states)
                const scale = parseFloat(/^[^]*?\bscale\s*=\s*([\d.]+)/.exec(block.split(/\bstate\s*=/)[0])?.[1] ?? '');
                scales?.set(name, Number.isFinite(scale) && scale > 0 ? scale : 1);
            }
        }
    }

    return out;
}

/** building types drawn at the special building locator */
const SPECIAL = /^(special|great_building)$/;

/**
 * Locators by province → x, z (game: from the bottom), yaw, scale: the holdings' (`buildings` in
 * building_locators.txt) or the special buildings' (`special_building` in special_building_locators.txt).
 */
export function holdingLocators(vfs: GameFiles, which: 'buildings' | 'special_building' = 'buildings'): Map<number, [number, number, number, number]>
{
    const out = new Map<number, [number, number, number, number]>();
    const f = vfs.get(`gfx/map/map_object_data/${which === 'buildings' ? 'building' : 'special_building'}_locators.txt`, { engine: true });
    const text = f && vfs.readText(f);

    if (!text)
        return out;

    for (const top of parse(text))
    {
        if (top.k !== 'game_object_locator' || scalar(kids(top), 'name') !== which)
            continue;

        for (const inst of kids(kids(top).find((c) => c.k === 'instances')))
        {
            const l = kids(inst);
            const id = Number(scalar(l, 'id'));
            const pos = words(l.find((c) => c.k === 'position')).map(Number);
            const rot = words(l.find((c) => c.k === 'rotation')).map(Number);
            const sc = words(l.find((c) => c.k === 'scale')).map(Number);

            if (id > 0 && pos.length >= 3)
                out.set(id, [pos[0], pos[2], rot.length >= 4 ? 2 * Math.atan2(rot[1], rot[3]) : 0, sc.length ? (sc[0] + (sc[1] ?? sc[0]) + (sc[2] ?? sc[0])) / 3 : 1]);
        }
    }

    return out;
}

/**
 * Whether a province is in a geographical region (map_data/geographical_regions: `<region> = { duchies = { … } counties =
 * { … } provinces = { … } regions = { … } }`, the lists' titles standing for their de jure provinces); sets made on first use.
 */
export function regionTester(texts: string[], tree: { titles: { province?: number; kids: number[]; }[]; byKey: Map<string, number>; }, count: number): (region: string, p: number) => boolean
{
    const defs = new Map<string, PNode[]>();

    for (const text of texts)
        for (const n of parse(text))
            if (n.k && Array.isArray(n.v))
                defs.set(n.k, n.v);

    const W = (count + 31) >>> 5;
    const sets = new Map<string, Uint32Array>();
    const add = (set: Uint32Array, p: number): void =>
    {
        if (p > 0 && p < count)
            set[p >>> 5] |= 1 << (p & 31);
    };
    const addTitle = (set: Uint32Array, t: number): void =>
    {
        const node = tree.titles[t];

        if (node.province !== undefined)
            add(set, node.province);

        for (const k of node.kids)
            addTitle(set, k);
    };
    const setOf = (key: string, seen: Set<string>): Uint32Array =>
    {
        let set = sets.get(key);

        if (set)
            return set;

        set = new Uint32Array(W);
        const block = defs.get(key);

        if (block && !seen.has(key))
        {
            seen.add(key);

            for (const list of ['hegemonies', 'empires', 'kingdoms', 'duchies', 'counties'])
                for (const t of words(block.find((c) => c.k === list)))
                    if (tree.byKey.has(t))
                        addTitle(set, tree.byKey.get(t)!);

            for (const p of words(block.find((c) => c.k === 'provinces')))
                add(set, +p);

            for (const r of words(block.find((c) => c.k === 'regions')))
            {
                const sub = setOf(r, seen);

                for (let i = 0; i < W; i++)
                    set[i] |= sub[i];
            }
        }

        sets.set(key, set);
        return set;
    };
    return (region, p) => p > 0 && p < count && (setOf(region, new Set())[p >>> 5] & (1 << (p & 31))) !== 0;
}

/** What a province's holding (or, `building`, a building of its own) is drawn with: its asset (the first that fits), or undefined. */
export function holdingMesh(rules: HoldingRules, holding: string, p: number, gfx: string | undefined, faith: string | undefined, inRegion: (region: string, p: number) => boolean, building = rules.primary.get(holding)): string | undefined
{
    const list = building ? rules.assets.get(building) : undefined;
    // (of those that fit, the most specific (the most conditions), the first on a tie: temple_01 lists its generic
    // temples first, each region's, before the faiths' own; a province's own castle before its culture's)
    let best: HoldingAsset | undefined;
    let bestScore = -1;

    for (const a of list ?? [])
    {
        if (a.provinces && !a.provinces.has(p))
            continue;

        if (a.cultures && (!gfx || !a.cultures.has(gfx)))
            continue;

        if (a.faiths && (!faith || !a.faiths.has(faith)))
            continue;

        if (a.regions && !a.regions.some((r) => inRegion(r, p)))
            continue;

        const score = (a.provinces ? 1 : 0) + (a.cultures ? 1 : 0) + (a.faiths ? 1 : 0) + (a.regions ? 1 : 0);

        if (score > bestScore)
            [best, bestScore] = [a, score];
    }

    return best && (best.names ? best.names[p % best.names.length] : best.mesh);
}

/** Per province: its history's `buildings = { … }` by date (history/provinces; a later list adds to the earlier). */
export function historyBuildings(history: { entries: Map<string, { date: number; node: PNode; }[]>; }, count: number): Map<number, { date: number; keys: string[]; }[]>
{
    const out = new Map<number, { date: number; keys: string[]; }[]>();

    for (const [id, stmts] of history.entries)
    {
        if (!/^\d+$/.test(id) || +id >= count)
            continue;

        for (const s of stmts)
            if (s.node.k === 'buildings' && Array.isArray(s.node.v))
            {
                const list = out.get(+id) ?? [];
                list.push({ date: s.date, keys: words(s.node) });
                out.set(+id, list);
            }
    }

    return out;
}

/** The holding's building at its level: the highest of its primary building's line among `built` that has assets. */
export function holdingLevel(rules: HoldingRules, primary: string | undefined, built: Set<string>): string | undefined
{
    const m = primary && /^(.*_)(\d+)$/.exec(primary);

    if (!m)
        return primary;

    let best = primary;
    let level = +m[2];

    for (const b of built)
        if (b.startsWith(m[1]) && /^\d+$/.test(b.slice(m[1].length)) && +b.slice(m[1].length) > level && rules.assets.get(b)?.length)
            [best, level] = [b, +b.slice(m[1].length)];

    return best;
}

/**
 * Each faith's `graphical_faith`: its own, else its `origin` faith's (1.20: common/religion/faith_types, `faith_details
 * = { religion graphical_faith }`), else its religion's (religion_types: `religion_details = { family graphical_faith }`
 * or, before 1.20, on the religion itself, the faiths inside it under `faiths`), else the family's (religion_family_types).
 * Values may be lists (`graphical_faith = { a b }`): the first.
 */
export function faithGfx(vfs: GameFiles): Map<string, string>
{
    const gfxOf = (list: PNode[]): string | undefined =>
    {
        const n = list.find((c) => c.k === 'graphical_faith');
        return typeof n?.v === 'string' ? n.v.replace(/"/g, '') : words(n)[0];
    };
    const read = (dir: string): PNode[] => vfs.list(`common/religion/${dir}`, { ext: /\.txt$/i }).flatMap((f) => parse(vfs.readText(f) ?? '').filter((n) => n.k && Array.isArray(n.v)));
    const families = new Map<string, string>();

    for (const n of read('religion_family_types'))
    {
        const g = gfxOf(kids(n));

        if (g)
            families.set(n.k!, g);
    }

    // religion → its graphical faith; faith → [own, origin, religion]
    const religions = new Map<string, string>();
    const faiths = new Map<string, { own?: string; origin?: string; religion?: string; }>();

    for (const r of read('religion_types'))
    {
        const details = kids(kids(r).find((c) => c.k === 'religion_details'));
        const list = [...kids(r), ...details];
        const g = gfxOf(list) ?? families.get(scalar(list, 'family') ?? '');

        if (g)
            religions.set(r.k!, g);

        for (const f of kids(kids(r).find((c) => c.k === 'faiths')))
            if (f.k && Array.isArray(f.v))
                faiths.set(f.k, { own: gfxOf(f.v), religion: r.k! });
    }

    for (const f of read('faith_types'))
    {
        const details = kids(kids(f).find((c) => c.k === 'faith_details'));
        faiths.set(f.k!, { own: gfxOf([...kids(f), ...details]), origin: scalar(kids(f), 'origin'), religion: scalar(details, 'religion') ?? scalar(kids(f), 'religion') });
    }

    const out = new Map<string, string>();
    const of = (k: string, depth: number): string | undefined =>
    {
        const f = faiths.get(k);
        return !f || depth > 8 ? undefined : (f.own ?? (f.origin ? of(f.origin, depth + 1) : undefined) ?? religions.get(f.religion ?? ''));
    };

    for (const k of faiths.keys())
    {
        const g = of(k, 0);

        if (g)
            out.set(k, g);
    }

    return out;
}
