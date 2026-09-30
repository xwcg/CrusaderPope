// The map's history and realms against known facts (docs/map.md, "History and realms"): builds the index, the
// province raster and MapData in plain Node, reads the map at dates — its static and dated parts composed as the
// renderer does (shared/mapCompose.ts) — and checks realms, holders, names and de jure lieges; prints a short report with
// timings and sizes and exits non-zero when a check fails.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/map-check.ts
//   AGOT=1                  layered over A Game of Thrones (the Steam Workshop copy)
//   MODS=<playset>          the mods of a launcher playset (the real user folder, read only)
//   SETTINGS=<settings.json> the mod list of an app settings file (userDir + modList: a test environment)
//   SHOW=<title keys>       also print these titles at every checked date
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { discoverMods } from '../src/main/mods/discover.ts';
import { MapData } from '../src/main/map/mapData.ts';
import { buildRaster } from '../src/main/map/raster.ts';
import { composeMapInfo } from '../src/shared/mapCompose.ts';
import type { MapInfo } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

let files = new GameFiles(gameDir);
const agot = !!process.env.AGOT;

if (agot)
{
    const mod = discoverMods(join(homedir(), 'no-user-folder'), gameDir, null).find((m) => m.remoteId === '2962333032');

    if (!mod)
        throw new Error('A Game of Thrones (Workshop 2962333032) is not installed');

    files = new GameFiles(gameDir, [mod]);
}
else if (process.env.MODS || process.env.SETTINGS)
{
    // (the launcher database needs node:sqlite: --experimental-sqlite)
    const { readModsState, modsOfList } = await import('../src/main/mods/manager.ts');
    const settings = process.env.SETTINGS ? JSON.parse(readFileSync(process.env.SETTINGS, 'utf8')) : { gameDir: install, language: 'english' };
    const state = await readModsState(settings, gameDir, join(homedir(), 'Documents'));
    const ref = process.env.SETTINGS ? settings.modList : state.lists.find((l) => l.name === process.env.MODS || l.ref === process.env.MODS)?.ref;

    if (!ref)
        throw new Error(`No mod list "${process.env.MODS}": ${state.lists.map((l) => l.name).join(', ')}`);

    files = new GameFiles(gameDir, modsOfList(state, ref));
}

if (files.sources.length > 1)
    console.log('mods:', files.sources.map((s) => s.name).join(' → '));

let t = performance.now();
const idx = new GameIndex(files, 'english');
idx.build();
console.log(`index ${Math.round(performance.now() - t)} ms`);
const md = new MapData(idx);
const mf = md.mapFiles();
t = performance.now();
const { meta } = buildRaster(files.read(mf.provinces)!, files.readText(mf.definitions)!, 'check');
console.log(`raster ${Math.round(performance.now() - t)} ms: ${meta.width} × ${meta.height}, ${meta.count} provinces`);

/** A fact at a date: the realm of a county (its first barony's province), its holder, names, de jure lieges. */
interface Check
{
    date: string;
    what: string;
    test: (m: MapInfo, title: (key: string) => number, county: (key: string) => number) => string | true;
}

const realmIs = (date: string, county: string, realm: string, extra?: { holder?: string; name?: string | RegExp; }): Check => ({
    date,
    what: `${county} in ${realm}${extra?.holder ? ` held by ${extra.holder}` : ''}${extra?.name ? ` named ${extra.name}` : ''}`,
    test: (m, title, prov) =>
    {
        const p = prov(county);
        const r = m.province.realm[p];
        const got = m.titles[r];

        if (!got)
            return `no realm (province ${p})`;

        if (got.key !== realm)
            return `realm ${got.key} (${got.name})`;

        if (extra?.holder && got.holder?.id !== extra.holder)
            return `holder ${got.holder?.id} (${got.holder?.name})`;

        if (extra?.name && !(typeof extra.name === 'string' ? got.name === extra.name : extra.name.test(got.name)))
            return `name "${got.name}"`;

        return true;
    }
});
const titleIs = (date: string, key: string, what: string, test: (x: MapInfo['titles'][number], m: MapInfo) => boolean): Check => ({
    date,
    what: `${key} ${what}`,
    test: (m, title) =>
    {
        const x = m.titles[title(key)];

        if (!x)
            return 'no such title';

        return test(x, m) || `got: ${JSON.stringify({ ...x, parent: m.titles[x.parent]?.key, liege: x.liege === undefined ? undefined : m.titles[x.liege]?.key, primary: x.primary === undefined ? undefined : m.titles[x.primary]?.key })}`;
    }
});

const checks: Check[] = agot
    ? [
        realmIs('8082.1.1', 'c_kings_landing', 'h_the_iron_throne', { holder: 'Targaryen_35' }),
        realmIs('8282.9.15', 'c_kings_landing', 'h_the_iron_throne'),
        titleIs('8282.9.15', 'h_the_iron_throne', 'held by Aerys II', (x) => /Aerys/.test(x.holder?.name ?? '')),
        // (Robert's Rebellion: history/titles `liege = 0` on 8282.9.15, back under the throne on 8282.12.31)
        realmIs('8282.9.15', 'c_winterfell', 'e_the_north', { holder: 'Stark_3' }),
        realmIs('8283.1.1', 'c_winterfell', 'h_the_iron_throne'),
        realmIs('8282.9.15', 'c_braavos', 'k_braavos'),
        // (Dorne joined the realm in 187 AC)
        realmIs('8082.1.1', 'c_sunspear', 'e_dorne')
    ]
    : [
        realmIs('867.1.1', 'c_ile_de_france', 'k_france', { name: 'West Francia' }),
        realmIs('1066.9.15', 'c_ile_de_france', 'k_france', { name: 'France' }),
        realmIs('1066.9.15', 'c_byzantion', 'e_byzantium'),
        realmIs('1066.9.15', 'c_cologne', 'e_hre'),
        realmIs('1066.9.15', 'c_roma', 'k_papal_state'),
        // (Ludwig holds k_bavaria longer, but history sets k_east_francia as his primary title)
        realmIs('867.1.1', 'c_regensburg', 'k_east_francia', { holder: '90107', name: 'East Francia' }),
        titleIs('867.1.1', 'k_east_francia', 'de jure under e_germany', (x, m) => m.titles[x.parent]?.key === 'e_germany'),
        titleIs('1066.9.15', 'k_east_francia', 'de jure under e_hre, named Germany', (x, m) => m.titles[x.parent]?.key === 'e_hre' && x.name === 'Germany'),
        titleIs('867.1.1', 'd_bavaria', 'held under Ludwig', (x, m) => x.liege !== undefined && m.titles[x.liege]?.key === 'k_east_francia'),
        // (a clan ruler of Arabic heritage: flavorization's empire tier is "Empire" — the files name no "Caliphate" for it)
        titleIs('867.1.1', 'e_arabia', 'named Abbasid Empire (the house and the tier name)', (x) => x.name === 'Abbasid Empire' && x.baseName === 'Arabian Empire'),
        // (Béla III holds k_croatia first, k_hungary's ai_primary_priority prefers a Hungarian)
        realmIs('1178.10.1', 'c_esztergom', 'k_hungary'),
        // (history writes `867.1.1. = {` — a dot after — and `1066.1 = {`: the game reads them as dates)
        titleIs('867.1.1', 'c_ca_mau', 'held (date `867.1.1.`)', (x) => !!x.holder),
        titleIs('1066.9.15', 'c_nf_abo', 'not held (`1066.1 = { holder = 0 }`)', (x) => !x.holder),
        titleIs('657.1.1', 'd_sunni', 'held by Ali (holder_ignore_head_of_faith_requirement)', (x) => x.holder?.id === '33911'),
        // (nomads: the head of the culture's realm is named after the culture, a house head's after house and culture)
        titleIs('867.1.1', 'd_pecheneg', 'named Pechenegs (nomad culture head)', (x) => x.name === 'Pechenegs' && x.baseName === 'Pecheneg'),
        titleIs('1066.9.15', 'c_ladyzyn', 'named after house and culture (nomad house head)', (x) => / Pechenegs$/.test(x.name) && x.name !== 'Pechenegs'),
        titleIs('1066.9.15', 'k_france', 'held by a Capetian aged 14', (x) => /Cap/.test(x.holder?.house ?? '') && x.holder?.age === 14),
        titleIs('1066.9.15', 'k_england', 'held by Harold', (x) => /Harold/.test(x.holder?.name ?? '')),
        titleIs('889.1.1', 'k_funan', 'named Angkor', (x) => /Angkor/i.test(x.name)),
        titleIs('889.1.1', 'k_scotland', 'named Alba (cultural name, Gaelic holder)', (x) => x.name === 'Alba'),
        titleIs('1066.9.15', 'k_scotland', 'named Scotland (Scots holder)', (x) => x.name === 'Scotland'),
        titleIs('1066.9.15', 'h_china', 'named Song (set_title_name in an effect)', (x) => x.name === 'Song'),
        titleIs('1066.9.15', 'k_hungary', 'culture and faith of its holder', (x) => !!x.holder?.culture && !!x.holder?.faith)
    ];

const show = (process.env.SHOW ?? '').split(',').filter(Boolean);
const dates = [...new Set(checks.map((c) => c.date))];
let failed = 0;
t = performance.now();
const stat = md.static(meta);
console.log(`
static part ${Math.round(performance.now() - t)} ms (the first date's map with it), ${(serialize(stat).length / 1e6).toFixed(1)} MB`);

for (const date of dates)
{
    t = performance.now();
    const dated = md.dated(meta, date);
    const ms = Math.round(performance.now() - t);
    t = performance.now();
    const m = composeMapInfo(stat, dated);
    const composed = Math.round(performance.now() - t);
    const byKey = new Map(m.titles.map((x, i) => [x.key, i]));
    const title = (key: string): number => byKey.get(key) ?? -1;
    const county = (key: string): number =>
    {
        let c = title(key);
        const b = m.titles.findIndex((x) => x.parent === c && x.tier === 'b');
        const p = m.province.barony.indexOf(b);

        if (c < 0 || p < 0)
            throw new Error(`no province of ${key}`);

        return p;
    };
    const realms = new Set(m.province.realm.filter((r) => r >= 0)).size;
    console.log(`
${date}: ${ms} ms (composed: ${composed} ms), dated part ${Math.round(serialize(dated).length / 1e3)} kB, ${realms} realms, range ${m.range.from}–${m.range.to}`);

    for (const k of show)
    {
        const x = m.titles[title(k)];

        if (x)
        {
            const holder = x.holder ? `${x.holder.name} ${x.holder.house ?? ''} ${x.holder.age ?? ''} ${x.holder.culture?.name ?? ''} ${x.holder.faith?.name ?? ''}` : '—';
            console.log(`  ${k}: "${x.name}"${x.baseName ? ` (${x.baseName})` : ''} de jure ${m.titles[x.parent]?.key}, holder ${holder}, primary ${m.titles[x.primary ?? -1]?.key}, liege ${m.titles[x.liege ?? -1]?.key}`);
        }
    }

    for (const c of checks.filter((x) => x.date === date))
    {
        let r: string | true;

        try
        {
            r = c.test(m, title, county);
        }
        catch (e)
        {
            r = (e as Error).message;
        }

        if (r !== true)
            failed++;

        console.log(`  ${r === true ? 'ok  ' : 'FAIL'} ${c.what}${r === true ? '' : ': ' + r}`);
    }
}

// scrubbing: a year sweep over the range, twice (the second pass: holders read) — the worker's part per date (the
// last dates are kept: each date is new here)
const { from, to } = stat.range;

for (const pass of [1, 2])
{
    const ms: number[] = [];

    for (let y = from; y <= to; y += Math.max(1, Math.round((to - from) / 40)))
    {
        t = performance.now();
        md.dated(meta, `${y}.1.${pass}`);
        ms.push(performance.now() - t);
    }

    console.log(`sweep ${from}–${to} (${ms.length} dates, pass ${pass}): mean ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms, max ${Math.round(Math.max(...ms))} ms`);
}

console.log(`
${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
