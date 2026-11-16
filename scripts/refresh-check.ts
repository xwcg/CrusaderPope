// Checks incremental index updates (GameIndex.refreshFiles, docs/indexer.md "Incremental updates") against full builds:
// the vanilla game plus a temp mod in a TEMP folder (never the real user folder). Each case changes the mod's files,
// takes them in with refreshFiles and compares the index with a fresh full build of the same files (definitions,
// references (with their list order), localization, mod touches, types, lists, searches, details, cards, stories,
// graphs, galleries, the picker's modifier list) and, for a few cases, the rewritten cache (cacheSnapshot) loaded into a
// fresh scan. The modifier list is made before each update and timed after it (its per-definition scans are kept).
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=12000 scripts/refresh-check.ts [keep]
// Every index it builds is a fresh build on parse threads (scripts/fast-index.ts buildIndex; THREADS=0: one thread), never from a cache.
// CASES=12,13 runs only those cases (0-based numbers as printed); `relayer` the replace_path changes.
// AGOT=1: the mod layered over A Game of Thrones (Workshop 2962333032, read only): timings only; COMPARE=1 also the
// full comparisons (a build with AGOT takes ~40 s; all cases with COMPARE=1 took ~73 min in round 13's final verification). Expectation lines that assume the game as the only
// layer below the test mod (a copy "same as the game", a flag only the game uses, a key nobody else defines) that do not
// hold are printed as "n/a with AGOT: <why>" when another mod also defines or uses that entry and the observed state is
// the one that layering gives (any other state is a FAIL); a line that passes is printed ok. "identical to a full build"
// and the timings are all kept. A line that shows an app imprecision stays visible as "KNOWN" (counted; only in the one
// state the imprecision gives, any other state is a FAIL).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex, type Def, type Entity, type FileInfo, type RefreshResult } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { parseDescriptor } from '../src/main/mods/descriptor.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { riteHistory } from '../src/main/indexer/layouts.ts';
import { MapData } from '../src/main/map/mapData.ts';
import { T_FLAG, T_VARIABLE } from '../src/main/indexer/schema.ts';
import { defaultInstall, workshopFolder } from './ck3-install.ts';
import { parseIndex } from './fast-index.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const agotDir = join(workshopFolder(), '2962333032');
const withAgot = !!process.env.AGOT;

const tmp = mkdtempSync(join(tmpdir(), 'ckp-refresh-'));
const root = join(tmp, 'mod', 'refresh_test');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Refresh Test"\nsupported_version="1.*"\n');
const mod: ModInfo = { id: 'mod/refresh_test.mod', name: 'Refresh Test', tags: [], root, source: 'local', replacePaths: [], status: 'ok', editable: true };
const mods: ModInfo[] = [mod];

if (withAgot)
{
    const d = parseDescriptor(readFileSync(join(agotDir, 'descriptor.mod'), 'utf8'));
    mods.unshift({ id: 'mod/ugc_2962333032.mod', name: d.name, tags: [], root: agotDir, source: 'steam', replacePaths: d.replacePaths, status: 'ok', editable: false });
}

const game = (rel: string): string => join(gameDir, rel);
const put = (rel: string, text: string): string =>
{
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return abs;
};
const copy = (from: string, rel: string): string =>
{
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(from, abs);
    return abs;
};
const remove = (rel: string): string =>
{
    const abs = join(root, rel);
    rmSync(abs, { recursive: true, force: true });
    return abs;
};

let failures = 0;
/** lines not applicable with another mod below the test mod, and known app imprecisions (both printed in the last line) */
let notApplicable = 0;
let known = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

// ---------------------------------------------------------------------------
// the index's internals, as the comparison needs them
// ---------------------------------------------------------------------------

interface Internals
{
    entities: Entity[];
    deadRefs: number;
    files: FileInfo[];
    rFrom: number[];
    rTo: number[];
    rFile: number[];
    rLine: number[];
    rOff: number[];
    rLen: number[];
    rCtx: number[];
    ctx: { list: string[]; };
    outgoing: Map<number, number[]>;
    incoming: Map<number, number[]>;
    refsByFile: Map<number, number[]>;
    locText: Map<string, string>;
    byName: Map<string, Entity[]>;
}
const I = (x: GameIndex): Internals => x as unknown as Internals;

const code = 'refresh-check';
async function build(): Promise<GameIndex>
{
    const idx = new GameIndex(new GameFiles(gameDir!, mods), 'english');
    idx.scan();
    // (records each file's size and time: an update skips files that did not change)
    idx.fingerprint(code);
    await parseIndex(idx);
    return idx;
}

/** Everything that must match, keyed so that entity ids and file indices don't matter. */
function describe(x: GameIndex): {
    ent: (id: number) => string;
    file: (i: number) => string;
    ref: (r: number) => string;
    live: (e: Entity) => boolean;
}
{
    const X = I(x);
    const file = (i: number): string => `${X.files[i].source}:${X.files[i].rel}`;
    const ent = (id: number): string => X.entities[id].type + '|' + X.entities[id].name;
    const ref = (r: number): string => `${ent(X.rFrom[r])}>${ent(X.rTo[r])}@${file(X.rFile[r])}:${X.rLine[r]}:${X.rOff[r]}:${X.rLen[r]}:${X.ctx.list[X.rCtx[r]]}`;
    // (flags and variables queries created on demand have no references: a build doesn't have them)
    const live = (e: Entity): boolean => !e.dead && !((e.type === T_FLAG || e.type === T_VARIABLE) && !X.incoming.get(e.id)?.length);
    return { ent, file, ref, live };
}

const hash = (s: string): string => createHash('sha1').update(s).digest('base64');

function diffMaps<V>(what: string, a: Map<string, V>, b: Map<string, V>, eq: (x: V, y: V) => boolean, out: string[]): void
{
    let n = 0;

    for (const [k, v] of a)
    {
        if (!b.has(k))
        {
            if (n++ < 6)
                out.push(`${what}: only after the update: ${k}`);
        }
        else if (!eq(v, b.get(k)!))
        {
            if (n++ < 6)
                out.push(`${what}: differs: ${k}`);
        }
    }

    for (const k of b.keys())
        if (!a.has(k) && n++ < 6)
            out.push(`${what}: only in the full build: ${k}`);

    if (n > 6)
        out.push(`${what}: … ${n} differences`);
}

interface Focus
{
    type: string;
    name: string;
}

/** Differences between an updated index and a full build of the same files (empty: identical). */
function compare(a: GameIndex, b: GameIndex, focus: Focus[], full = true): string[]
{
    const out: string[] = [];
    const A = describe(a);
    const B = describe(b);
    const XA = I(a);
    const XB = I(b);
    // entities and their definitions, in order
    const defs = (x: GameIndex, d: ReturnType<typeof describe>): Map<string, string> =>
    {
        const m = new Map<string, string>();

        for (const e of I(x).entities)
        {
            if (!d.live(e))
                continue;

            m.set(e.type + '|' + e.name, JSON.stringify(e.defs.map((f) => [d.file(f.file), f.line, f.start, f.end, !!f.local, f.doc ?? null, f.meta ?? null])));
        }

        return m;
    };
    diffMaps('entity definitions', defs(a, A), defs(b, B), (x, y) => x === y, out);
    // references as a multiset
    const refs = new Map<string, number>();

    for (let r = 0; r < XA.rFrom.length; r++)
        if (XA.rFrom[r] >= 0)
            refs.set(A.ref(r), (refs.get(A.ref(r)) ?? 0) + 1);

    let only = 0;

    for (let r = 0; r < XB.rFrom.length; r++)
    {
        const k = B.ref(r);
        const n = refs.get(k);

        if (!n)
        {
            if (only++ < 6)
                out.push('reference only in the full build: ' + k);
        }
        else if (n === 1)
            refs.delete(k);
        else
            refs.set(k, n - 1);
    }

    let extra = 0;

    for (const k of refs.keys())
        if (extra++ < 6)
            out.push('reference only after the update: ' + k);

    if (only + extra > 12)
        out.push(`… ${only} references only in the full build, ${extra} only after the update`);

    refs.clear();
    // reference lists in order (what details, graphs and link spans iterate)
    const lists = (x: GameIndex, d: ReturnType<typeof describe>): Map<string, string> =>
    {
        const X = I(x);
        const m = new Map<string, string>();

        for (const e of X.entities)
        {
            if (!d.live(e))
                continue;

            const o = X.outgoing.get(e.id) ?? [];
            const i = X.incoming.get(e.id) ?? [];

            if (o.length || i.length)
                m.set(e.type + '|' + e.name, hash(o.map(d.ref).join('\n') + '\n|\n' + i.map(d.ref).join('\n')));
        }

        X.refsByFile.forEach((l, f) => m.set('file ' + d.file(f), hash(l.map(d.ref).join('\n'))));
        return m;
    };
    diffMaps('reference list order', lists(a, A), lists(b, B), (x, y) => x === y, out);
    diffMaps('localization text', XA.locText, XB.locText, (x, y) => x === y, out);
    // several entries of a name: in creation order (named()[0], ambiguous link targets)
    const names = (x: GameIndex): Map<string, string> =>
    {
        const m = new Map<string, string>();
        I(x).byName.forEach((l, n) => l.length > 1 && m.set(n, l.map((e) => e.type).join(',')));
        return m;
    };
    diffMaps('entries of a name', names(a), names(b), (x, y) => x === y, out);
    const touches = (x: GameIndex, d: ReturnType<typeof describe>): Map<string, string> =>
    {
        const m = new Map<string, string>();

        for (const e of I(x).entities)
            if (d.live(e))
                m.set(e.type + '|' + e.name, JSON.stringify(x.modTouch(e) ?? null));

        return m;
    };
    diffMaps('mod touch', touches(a, A), touches(b, B), (x, y) => x === y, out);
    const same = (what: string, x: unknown, y: unknown): void =>
    {
        const sx = JSON.stringify(x);
        const sy = JSON.stringify(y);

        if (sx !== sy)
        {
            let i = 0;

            while (i < sx.length && sx[i] === sy[i])
                i++;

            out.push(`${what}: …${sx.slice(Math.max(0, i - 80), i + 120)}… ≠ …${sy.slice(Math.max(0, i - 80), i + 120)}…`);
        }
    };
    const stats = (x: GameIndex): unknown => ({ files: x.stats.files, entities: x.stats.entities, refs: x.stats.refs, locKeys: x.stats.locKeys });
    same('stats', stats(a), stats(b));
    same('types', a.types(), b.types());

    if (full)
    {
        for (const t of b.types())
            same('list ' + t.id, a.list(t.id), b.list(t.id));
    }

    for (const q of ['rt_', 'brave', 'craven', 'coward'])
        same('search ' + q, a.search(q, { text: true, limit: 400 }), b.search(q, { text: true, limit: 400 }));

    same('search modOnly', a.search('a', { modOnly: true, limit: 2000 }), b.search('a', { modOnly: true, limit: 2000 }));
    // the file layer's listings (an update patches the cached ones: map_data, fonts, data_binding and gui are not the index's files)
    const listing = (x: GameIndex, dir: string): string[] => x.vfs.list(dir, { engine: true }).map((f) => `${f.source}:${f.rel}`);

    for (const dir of ['map_data', 'map_data/geographical_regions', 'fonts', 'data_binding', 'gui'])
        same('listing ' + dir, listing(a, dir), listing(b, dir));

    // what other modules keep per index state: the rites' faiths (history/faiths), the map's regions
    const rites = (x: GameIndex): (string | undefined)[] => b.names('religion/rite_types').map((r) => riteHistory(x).faithOf(r, 14500101));
    same('rite history', rites(a), rites(b));
    same('map regions', new MapData(a).texts('map_data/geographical_regions'), new MapData(b).texts('map_data/geographical_regions'));
    same('image folders', a.fileFolders('images'), b.fileFolders('images'));
    same('model folders', a.fileFolders('models'), b.fileFolders('models'));
    same('mod images', a.filesIn('images', 'gfx/interface/icons/traits'), b.filesIn('images', 'gfx/interface/icons/traits'));
    const sa = new StoryBuilder(a);
    const sb = new StoryBuilder(b);
    // (every caller of a scripted effect / trigger read on both: a time budget could cut the two cards at other places)
    sa.callerBudget = sb.callerBudget = Infinity;
    // (the picker's modifier list: the updated index's builder reads the per-Def scans kept from before the update)
    same('modifier keys', sa.modifierKeys(), sb.modifierKeys());
    const graph = (x: GameIndex, f: Focus): unknown =>
    {
        const g = x.graph(f.type, f.name, 2, ['localization'], null, 400);
        const key = new Map(g.nodes.map((n) => [n.id, `${n.type}|${n.name}`]));
        return {
            nodes: g.nodes.map((n) => `${n.type}|${n.name}|${n.distance}`).sort(),
            edges: g.edges.map((e) => `${key.get(e.source)}>${key.get(e.target)} ${e.ctx} ${e.count}`).sort(),
            truncated: g.truncated
        };
    };

    for (const f of focus)
    {
        same(`detail ${f.type} ${f.name}`, a.detail(f.type, f.name), b.detail(f.type, f.name));
        same(`graph ${f.type} ${f.name}`, graph(a, f), graph(b, f));
        const ea = a.get(f.type, f.name);
        const eb = b.get(f.type, f.name);
        same(`card ${f.type} ${f.name}`, ea && sa.card(ea), eb && sb.card(eb));

        if (f.type === 'events')
            same(`story ${f.name}`, ea && sa.eventStory(ea), eb && sb.eventStory(eb));

        if (f.type === 'on_action')
            same(`story ${f.name}`, ea && sa.onActionStory(ea), eb && sb.onActionStory(eb));
    }

    return out;
}

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

const EVENTS = `namespace = rt

# the first test event
rt.1 = {
\ttype = character_event
\ttitle = rt.1.t
\tdesc = rt.1.desc
\ttheme = default
\timmediate = {
\t\tadd_trait = rt_trait_a
\t\tadd_trait = brave
\t\trt_effect = yes
\t\trt_other_effect = yes
\t\tadd_character_flag = rt_flag_one
\t}
\toption = {
\t\tname = rt.1.a
\t\ttrigger_event = rt.2
\t}
}

rt.2 = {
\ttype = character_event
\ttitle = rt.1.t
\tdesc = rt.1.desc
\toption = {
\t\tname = rt.1.a
\t\tadd_trait = craven
\t\tadd_character_flag = rt_flag_two
\t}
}
`;
const TRAITS = `rt_trait_a = {
\tcategory = personality
\tdiplomacy = 1
\topposites = { brave }
}

rt_trait_b = {
\tcategory = personality
\tstewardship = 2
}
`;
const LOC = `\uFEFFl_english:
 rt.1.t:0 "A test"
 rt.1.desc:0 "Something happens to $rt_name$ — see [trait|E]."
 rt.1.a:0 "Fine."
 rt_name:0 "the tester"
 trait_rt_trait_a:0 "Tester"
`;

/**
 * An expectation that assumes the game as the only layer below the test mod: with AGOT=1 a miss is "n/a" when another
 * mod also defines (or, `uses`: references) the entry `type` `name` and the observed state is one `accept` takes (the
 * state that layering gives); any other state is a FAIL.
 */
interface Layered
{
    type: string;
    name: string;
    /** the mods' use of the entry counts (flags, variables), not their definitions */
    uses?: boolean;
    /** what the updated index says (printed with the n/a) */
    seen: string;
    /** the observed states the layering explains (the others fail), and how to say it */
    accept: (seen: string) => boolean;
    expected: string;
    /** why the other mod changes the expectation */
    why: string;
    /** the line shows an app imprecision, not a different expectation: a miss in an accepted state is reported as KNOWN */
    known?: string;
}
type Line = [what: string, ok: boolean, layered?: Layered];

interface Case
{
    name: string;
    /** changes the mod's files; returns the paths to refresh */
    apply: () => string[];
    focus: Focus[];
    /** expected: a full build is asked for */
    fallback?: boolean;
    /** also check the rewritten cache */
    cache?: boolean;
    /** what the updated index must say besides matching a full build: [what, is it so] */
    expect?: (x: GameIndex) => Line[];
    /** expected: this many shader files named, the index unchanged */
    shaders?: number;
    /** expected: exactly these gfx files taken in (folder events: the unchanged files below stay out) */
    gfx?: string[];
    /** expected: the index unchanged (no revision), nothing taken in (editor leftovers, sources) */
    quiet?: boolean;
    /** expected: exactly these map files (map_data/) named, the index unchanged */
    map?: string[];
    /** expected: exactly these interface files (gui/, fonts/, data_binding/) named, the index unchanged */
    gui?: string[];
    /** expected: the first update leaves exactly these files (paths in the mod) for the next one */
    rest?: string[];
}

/** The names a scripted trigger refers to (its outgoing references). */
const refsOf = (x: GameIndex, trigger: string): string[] =>
{
    const e = x.get('scripted_triggers', trigger);
    return e ? (I(x).outgoing.get(e.id) ?? []).map((r) => I(x).entities[I(x).rTo[r]].name) : [];
};

/** How the mods touch an entry, as "state" / "state+uses" ('-' untouched). */
const stateOf = (x: GameIndex, type: string, name: string): string =>
{
    const t = x.detail(type, name)?.mod;
    return t ? t.state + (t.uses ? '+uses' : '') + (t.duplicate ? '+dup' : '') : '-';
};

/**
 * The mods other than the test mod (and not the game) whose files define the entry (or, `uses`, reference it); a
 * definition the test mod's file replaced does not count. Empty when the game is the only layer below the test mod.
 */
const otherMods = (x: GameIndex, type: string, name: string, uses = false): string[] =>
{
    const e = x.get(type, name);

    if (!e)
        return [];

    const X = I(x);
    const mine = x.vfs.sources.findIndex((s) => s.modId === mod.id);
    const found = new Set<number>();
    const add = (file: number): void =>
    {
        const f = X.files[file];

        if (f && !f.hidden && f.source > 0 && f.source !== mine)
            found.add(f.source);
    };

    if (uses)
        for (const r of X.incoming.get(e.id) ?? [])
            add(X.rFile[r]);
    else
        for (const d of e.defs)
            add(d.file);

    return [...found].sort((a, b) => a - b).map((s) => x.vfs.sources[s].name);
};

/** Prints one expectation: a check, or (AGOT=1, another mod below the test mod) "n/a with AGOT: <why>" / KNOWN. */
function expectation(x: GameIndex, [what, ok, layered]: Line): void
{
    const others = withAgot && layered ? otherMods(x, layered.type, layered.name, layered.uses) : [];

    if (!layered || !others.length)
    {
        check(ok, what);
        return;
    }

    if (ok)
    {
        check(ok, what);
        return;
    }

    if (!layered.accept(layered.seen))
    {
        check(false, `${what}: seen ${layered.seen}, but with ${others.join(', ')} below the test mod ${layered.expected} is expected`);
        return;
    }

    const why = `${others.join(', ')} also ${layered.uses ? 'uses' : 'defines'} ${layered.type} ${layered.name}: ${layered.why}`;

    if (layered.known)
    {
        known++;
        console.log(`KNOWN ${what}: seen ${layered.seen}; ${why}; ${layered.known}`);
    }
    else
    {
        notApplicable++;
        console.log(`n/a with AGOT: ${what}: seen ${layered.seen}; ${why}`);
    }
}

/** the accepted observed states: exactly these */
const onlyStates = (...states: string[]): Pick<Layered, 'accept' | 'expected'> => ({ accept: (seen) => states.includes(seen), expected: states.map((s) => `"${s}"`).join(' or ') });

/** The modifier-list label cases (40, 41): the test mod's text in localization/<lang>/replace/ for MOD_MONTHLY_PRESTIGE. */
const labelLayer = (seen: string | undefined, testText: string): Layered => ({
    type: 'localization',
    name: 'MOD_MONTHLY_PRESTIGE',
    seen: String(seen),
    accept: (s) => !!seen && s !== testText,
    expected: `a label other than the test mod's "${testText}"`,
    why: 'a text in localization/replace/<lang>/ beats the test mod\'s in localization/<lang>/replace/ (docs/mods.md "Which definition wins")'
});

/** files of the chunked case (more than one update takes) and the updates' size */
const CHUNK_FILES = 1200;
const CHUNK = 500;

// the mod before the first case
put('events/rt_events.txt', EVENTS);
put('common/traits/zz_rt_traits.txt', TRAITS);
put('localization/english/rt_l_english.yml', LOC);
put('common/scripted_effects/rt_effects.txt', 'rt_other_effect = {\n\tadd_gold = 5\n}\n');

const traitsGame = readFileSync(game('common/traits/00_traits.txt'), 'utf8');
// (its @constants: a copy of brave is the same as the game only with them, docs/mods.md "Same as the game")
const traitsConsts = [...traitsGame.matchAll(/^@\w+[ \t]*=[^\r\n]*/gm)].map((m) => m[0]).join('\n') + '\n\n';
/** the mod modifier's definition after the case that writes it (the next case checks it survives) */
let rtModDef: Def | undefined;
const cases: Case[] = [
    {
        name: 'edit inside a definition (offsets below it shift)',
        apply: () => [put('events/rt_events.txt', EVENTS.replace('\t\trt_effect = yes\n', '\t\trt_effect = yes\n\t\tadd_prestige = 100\n\t\tadd_gold = 50\n\t\tadd_trait = calm\n'))],
        focus: [
            { type: 'events', name: 'rt.1' },
            { type: 'events', name: 'rt.2' },
            { type: 'traits', name: 'calm' }
        ]
    },
    {
        name: 'add a definition another (unchanged) file already calls',
        apply: () => [put('common/scripted_effects/rt_effects.txt', 'rt_other_effect = {\n\tadd_gold = 5\n}\n\nrt_effect = {\n\tadd_gold = 10\n\trt_other_effect = yes\n}\n')],
        focus: [
            { type: 'scripted_effects', name: 'rt_effect' },
            { type: 'events', name: 'rt.1' }
        ]
    },
    {
        name: 'remove a definition (its users in other files lose the link)',
        apply: () => [put('common/traits/zz_rt_traits.txt', TRAITS.slice(TRAITS.indexOf('rt_trait_b')))],
        focus: [
            { type: 'events', name: 'rt.1' },
            { type: 'localization', name: 'trait_rt_trait_a' },
            { type: 'traits', name: 'rt_trait_b' }
        ]
    },
    {
        name: 'a new zz_ overrides file (overrides a game scripted effect and a trait)',
        apply: () =>
        {
            const brave = traitsGame.slice(traitsGame.indexOf('\nbrave = {') + 1);
            const end = brave.indexOf('\n}\n') + 3;
            return [put('common/scripted_effects/zz_rt_overrides.txt', 'add_achievement_flag_effect = {\n\tadd_prestige = 1\n}\n'), put('common/traits/zz_rt_brave.txt', traitsConsts + brave.slice(0, end))];
        },
        focus: [
            { type: 'traits', name: 'brave' },
            { type: 'scripted_effects', name: 'add_achievement_flag_effect' }
        ],
        cache: true,
        expect: (x) => [
            ['brave, copied as the game has it: same as the game', stateOf(x, 'traits', 'brave') === 'same', { type: 'traits', name: 'brave', seen: stateOf(x, 'traits', 'brave'), ...onlyStates('overridden'), why: 'the other mod\'s brave (its 00_traits.txt replaces the game file) differs from the game\'s, and every mod definition must match the game\'s for "same"' }],
            ['the changed scripted effect: overridden', stateOf(x, 'scripted_effects', 'add_achievement_flag_effect') === 'overridden']
        ]
    },
    {
        name: 'the copy of brave re-spaced, with comments: still the same; then one value changed: overridden',
        apply: () =>
        {
            const brave = traitsGame.slice(traitsGame.indexOf('\nbrave = {') + 1);
            const text = brave.slice(0, brave.indexOf('\n}\n') + 3);
            return [put(
                'common/traits/zz_rt_brave.txt',
                '# brave as the game has it\n' + traitsConsts + text.replace(/\t/g, '    ')
                    .replace(/ = /g, '=')
                    .replace('{', '{ # opening')
            )];
        },
        focus: [{ type: 'traits', name: 'brave' }],
        expect: (x) => [['brave re-spaced with comments: same as the game', stateOf(x, 'traits', 'brave') === 'same', { type: 'traits', name: 'brave', seen: stateOf(x, 'traits', 'brave'), ...onlyStates('overridden'), why: 'the other mod\'s brave (its 00_traits.txt replaces the game file) differs from the game\'s, and every mod definition must match the game\'s for "same"' }]]
    },
    {
        name: "the copy of brave with the game's text, but one @constant it uses of another value in its file",
        apply: () =>
        {
            const brave = traitsGame.slice(traitsGame.indexOf('\nbrave = {') + 1);
            const text = brave.slice(0, brave.indexOf('\n}\n') + 3);
            const used = /@(\w+)/.exec(text)![1];
            return [put('common/traits/zz_rt_brave.txt', traitsConsts.replace(new RegExp(`^(@${used}[ \\t]*=[ \\t]*)\\S+`, 'm'), '$1 12345') + text)];
        },
        focus: [{ type: 'traits', name: 'brave' }],
        expect: (x) => [['brave with a changed constant: overridden', stateOf(x, 'traits', 'brave') === 'overridden']]
    },
    {
        name: 'brave changed in the copy',
        apply: () =>
        {
            const brave = traitsGame.slice(traitsGame.indexOf('\nbrave = {') + 1);
            const text = brave.slice(0, brave.indexOf('\n}\n') + 3);
            return [put('common/traits/zz_rt_brave.txt', traitsConsts + text.replace(/prowess = \d+/, 'prowess = 99'))];
        },
        focus: [{ type: 'traits', name: 'brave' }],
        expect: (x) => [['brave with another value: overridden', stateOf(x, 'traits', 'brave') === 'overridden']]
    },
    {
        name: 'flags: one the game uses and a new one, used by the mod',
        apply: () => [put('common/scripted_effects/rt_flags.txt', 'rt_flag_effect = {\n\tadd_character_flag = rt_new_flag\n\tadd_character_flag = wear_armor\n\tset_variable = { name = rt_var value = 1 }\n}\n')],
        focus: [{ type: 'scripted_effects', name: 'rt_flag_effect' }],
        expect: (x) => [
            [`a flag only the mod uses: added (${stateOf(x, 'flag', 'rt_new_flag')})`, stateOf(x, 'flag', 'rt_new_flag') === 'added+uses'],
            [`a flag the game uses too: merged (${stateOf(x, 'flag', 'wear_armor')})`, stateOf(x, 'flag', 'wear_armor') === 'merged+uses'],
            [`a variable only the mod uses: added (${stateOf(x, 'variable', 'rt_var')})`, stateOf(x, 'variable', 'rt_var') === 'added+uses'],
            ['flags count in the type summary', (x.types().find((t) => t.id === 'flag')?.modStates?.added ?? 0) >= 1]
        ]
    },
    {
        name: 'the flags file deleted (the new flag goes, the game one is the game’s again)',
        apply: () => [remove('common/scripted_effects/rt_flags.txt')],
        focus: [],
        expect: (x) => [
            ['the mod’s own flag is gone', !x.detail('flag', 'rt_new_flag')],
            [`the game's flag is untouched again (${stateOf(x, 'flag', 'wear_armor')})`, stateOf(x, 'flag', 'wear_armor') === '-', { type: 'flag', name: 'wear_armor', uses: true, seen: stateOf(x, 'flag', 'wear_armor'), ...onlyStates('merged+uses'), why: 'a flag is touched by every mod whose files use it, not by the test mod alone' }]
        ]
    },
    {
        name: 'delete a file (the game definition wins again)',
        apply: () => [remove('common/scripted_effects/zz_rt_overrides.txt')],
        focus: [{ type: 'scripted_effects', name: 'add_achievement_flag_effect' }]
    },
    {
        name: 'localization: a replace/ file overrides a game text, then its text changes',
        apply: () => [put('localization/english/replace/rt_replace_l_english.yml', '\uFEFFl_english:\n trait_brave:0 "Bold as $rt_name$"\n rt_new_key:0 "New [GetTrait(\'craven\').GetName]"\n')],
        focus: [
            { type: 'traits', name: 'brave' },
            { type: 'localization', name: 'trait_brave' },
            { type: 'localization', name: 'rt_name' }
        ],
        expect: (x) => [[`a replace/ text overrides the game's: no duplicate (${stateOf(x, 'localization', 'trait_brave')})`, stateOf(x, 'localization', 'trait_brave') === 'overridden']]
    },
    {
        name: 'duplicates the game keeps no winner for: an event and a localization key defined again in other files',
        apply: () => [
            put('events/zz_rt_dup_events.txt', 'namespace = court\n\ncourt.8190 = {\n\ttype = character_event\n\ttitle = court.8190.t\n}\n'),
            put('localization/english/rt_dup_l_english.yml', '﻿l_english:\n trait_craven:0 "Coward"\n')
        ],
        focus: [
            { type: 'events', name: 'court.8190' },
            { type: 'localization', name: 'trait_craven' }
        ],
        expect: (x) => [
            [`an event defined again in another file: a duplicate (${stateOf(x, 'events', 'court.8190')})`, stateOf(x, 'events', 'court.8190') === 'overridden+dup'],
            // (also with AGOT, whose replace/ text of it wins: the game and the test mod still define it twice outside replace/)
            [`a localization key defined again outside replace/: a duplicate (${stateOf(x, 'localization', 'trait_craven')})`, stateOf(x, 'localization', 'trait_craven') === 'overridden+dup'],
            ['counted as duplicates', (x.types().find((t) => t.id === 'events')?.modStates?.duplicates ?? 0) >= 1]
        ]
    },
    {
        name: 'the duplicates removed again',
        apply: () => [remove('events/zz_rt_dup_events.txt'), remove('localization/english/rt_dup_l_english.yml')],
        focus: [{ type: 'events', name: 'court.8190' }],
        expect: (x) => [[`the event is the game's alone again (${stateOf(x, 'events', 'court.8190')})`, stateOf(x, 'events', 'court.8190') === '-', { type: 'events', name: 'court.8190', seen: stateOf(x, 'events', 'court.8190'), ...onlyStates('same'), why: 'the other mod ships a court.8190 too (its file replaces the game file of the same path), so the entry stays touched' }]]
    },
    {
        name: 'localization: the replace text edited, a key removed from the other file',
        apply: () => [
            put('localization/english/replace/rt_replace_l_english.yml', '\uFEFFl_english:\n trait_brave:0 "Brave, very"\n'),
            put('localization/english/rt_l_english.yml', LOC.replace(' rt_name:0 "the tester"\n', ''))
        ],
        focus: [
            { type: 'traits', name: 'brave' },
            { type: 'localization', name: 'rt.1.desc' },
            { type: 'events', name: 'rt.1' }
        ]
    },
    {
        name: 'new .dds and .mesh files, and a .dds replacing a game texture',
        apply: () => [
            copy(game('gfx/interface/icons/traits/_frame_commander.dds'), 'gfx/interface/icons/traits/rt_trait_b.dds'),
            copy(game('gfx/models/artifacts/banners/ep1_western_banner_02.mesh'), 'gfx/models/rt/rt_banner.mesh'),
            copy(game('gfx/interface/icons/traits/_frame_education.dds'), 'gfx/interface/icons/traits/_frame_commander.dds')
        ],
        focus: [
            { type: 'traits', name: 'rt_trait_b' },
            { type: 'images', name: 'gfx/interface/icons/traits/rt_trait_b.dds' },
            { type: 'models', name: 'gfx/models/rt/rt_banner.mesh' }
        ],
        cache: true
    },
    {
        name: 'a file replacing a game file of the same path (a trait removed: its entry only in the hidden file)',
        apply: () =>
        {
            const i = traitsGame.indexOf('\ncraven = {');
            const j = traitsGame.indexOf('\n}\n', i) + 3;
            return [put('common/traits/00_traits.txt', traitsGame.slice(0, i + 1) + traitsGame.slice(j))];
        },
        focus: [
            { type: 'traits', name: 'craven' },
            { type: 'traits', name: 'brave' },
            { type: 'events', name: 'rt.2' }
        ],
        cache: true
    },
    {
        name: 'delete the replacing file (the game file comes back)',
        apply: () => [remove('common/traits/00_traits.txt')],
        focus: [
            { type: 'traits', name: 'craven' },
            { type: 'events', name: 'rt.2' }
        ]
    },
    {
        name: 'a history characters file',
        apply: () => [put('history/characters/rt_characters.txt', 'rt_char_1 = {\n\tname = "Tester"\n\tdynasty = 1\n\treligion = catholic\n\tculture = norman\n\ttrait = brave\n\t1040.1.1 = { birth = yes }\n}\n')],
        focus: [{ type: 'characters', name: 'rt_char_1' }]
    },
    {
        name: 'a whole folder deleted (reported as the folder only)',
        apply: () => [remove('events')],
        focus: [
            { type: 'events', name: 'rt.1' },
            { type: 'scripted_effects', name: 'rt_effect' },
            { type: 'localization', name: 'rt.1.t' }
        ]
    },
    {
        name: 'a file directly in common/culture: every file there is of type culture now (parsed again as that)',
        apply: () => [put('common/culture/rt_direct.txt', 'rt_x = { }\n')],
        focus: [
            { type: 'culture', name: 'norman' },
            { type: 'culture/cultures', name: 'norman' },
            { type: 'traits', name: 'brave' }
        ],
        cache: true
    },
    {
        name: 'the direct file removed: the subfolder types come back',
        apply: () => [remove('common/culture/rt_direct.txt')],
        focus: [
            { type: 'culture/cultures', name: 'norman' },
            { type: 'culture/traditions', name: 'tradition_warriors_by_merit' }
        ]
    },
    {
        name: 'a shader file (gfx/FX): not the index’s; named for the shader store, the listing takes it',
        apply: () => [put('gfx/FX/rt_test.fxh', '# a shader include\n'), put('gfx/FX/jomini/rt_other.fxh', '# another\n')],
        focus: [],
        shaders: 2
    },
    {
        name: `${CHUNK_FILES} new files (effects calling the next file's, their loc, events): taken in ${CHUNK} at a time`,
        apply: () =>
        {
            const out: string[] = [];

            for (let i = 0; i < CHUNK_FILES; i++)
            {
                const n = String(i).padStart(4, '0');
                // (the next one of its kind: often in a later update)
                const next = String((i + 3) % CHUNK_FILES).padStart(4, '0');
                const kind = i % 3;

                if (kind === 0)
                    out.push(put(`common/scripted_effects/rt_gen_${n}.txt`, `rt_gen_${n} = {\n\tadd_gold = ${i}\n\trt_gen_${next} = yes\n\tadd_trait = brave\n}\n`));
                else if (kind === 1)
                    out.push(put(`localization/english/rt_gen/rt_gen_${n}_l_english.yml`, `﻿l_english:\n rt_gen_${n}:0 "Generated $rt_gen_${next}$ [trait|E]"\n`));
                else
                    out.push(put(`events/rt_gen/rt_gen_${n}.txt`, `namespace = rtg${n}\nrtg${n}.1 = {\n\ttype = character_event\n\ttitle = rt_gen_${n}\n\timmediate = { rt_gen_${String(i - 2).padStart(4, '0')} = yes }\n}\n`));
            }

            return out;
        },
        focus: [
            { type: 'scripted_effects', name: 'rt_gen_0000' },
            { type: 'scripted_effects', name: 'rt_gen_0999' },
            { type: 'events', name: 'rtg0005.1' },
            { type: 'localization', name: 'rt_gen_0001' }
        ],
        cache: true
    },
    {
        name: 'a new folder with an image in the mod’s gfx (Windows reports the folders too): only the new file goes in',
        apply: () => [
            copy(game('gfx/interface/icons/traits/_frame_education.dds'), 'gfx/interface/icons/rt_new/rt_new_icon.dds'),
            join(root, 'gfx/interface/icons/rt_new'),
            join(root, 'gfx/interface/icons'),
            join(root, 'gfx')
        ],
        focus: [{ type: 'images', name: 'gfx/interface/icons/rt_new/rt_new_icon.dds' }],
        gfx: ['gfx/interface/icons/rt_new/rt_new_icon.dds']
    },
    {
        name: 'that folder deleted (reported as folders only): its file goes, the others stay',
        apply: () =>
        {
            remove('gfx/interface/icons/rt_new');
            return [join(root, 'gfx/interface/icons/rt_new'), join(root, 'gfx/interface/icons')];
        },
        focus: [{ type: 'images', name: 'gfx/interface/icons/traits/rt_trait_b.dds' }],
        gfx: ['gfx/interface/icons/rt_new/rt_new_icon.dds']
    },
    {
        name: 'a trigger names a trait group nobody is in (no member yet)',
        apply: () => [put('common/scripted_triggers/rt_group.txt', 'rt_has_group = {\n\thas_trait = rt_test_group\n}\n')],
        focus: [{ type: 'scripted_triggers', name: 'rt_has_group' }]
    },
    {
        name: 'two traits join the group (the trigger file is unchanged: its reference follows the group)',
        apply: () => [put('common/traits/zz_rt_group.txt', 'rt_g1 = {\n\tcategory = personality\n\tgroup = rt_test_group\n}\n\nrt_g2 = {\n\tcategory = personality\n\tgroup_equivalence = rt_test_group\n}\n')],
        focus: [
            { type: 'scripted_triggers', name: 'rt_has_group' },
            { type: 'traits', name: 'rt_g1' }
        ],
        expect: (x) => [[`the trigger refers to both traits of the group (${refsOf(x, 'rt_has_group')})`, ['rt_g1', 'rt_g2'].every((t) => refsOf(x, 'rt_has_group').includes(t))]]
    },
    {
        name: 'one trait leaves the group (a group = edit alone: no entry is born or dies)',
        apply: () => [put('common/traits/zz_rt_group.txt', 'rt_g1 = {\n\tcategory = personality\n\tgroup = rt_other_group\n}\n\nrt_g2 = {\n\tcategory = personality\n\tgroup_equivalence = rt_test_group\n}\n')],
        focus: [
            { type: 'scripted_triggers', name: 'rt_has_group' },
            { type: 'traits', name: 'rt_g1' }
        ],
        expect: (x) => [[`the trigger no longer refers to the trait that left (${refsOf(x, 'rt_has_group')})`, refsOf(x, 'rt_has_group').join() === 'rt_g2']]
    },
    {
        name: 'the traits file deleted (the group is empty again)',
        apply: () => [remove('common/traits/zz_rt_group.txt')],
        focus: [{ type: 'scripted_triggers', name: 'rt_has_group' }]
    },
    {
        name: 'a later mod file adds a trait (at its start) to a game group: the group lists it last, as a full build does (ids, not file offsets)',
        apply: () => [
            put('common/scripted_triggers/rt_group_vanilla.txt', 'rt_has_vanilla_group = {\n\thas_trait = education_intrigue\n}\n'),
            put('common/traits/zz_aa_rt_group.txt', 'rt_first_of_group = {\n\tcategory = education\n\tgroup = education_intrigue\n}\n')
        ],
        focus: [
            { type: 'scripted_triggers', name: 'rt_has_vanilla_group' },
            { type: 'traits', name: 'rt_first_of_group' }
        ],
        expect: (x) => [[`the new trait comes after the game’s (${refsOf(x, 'rt_has_vanilla_group')})`, refsOf(x, 'rt_has_vanilla_group').at(-1) === 'rt_first_of_group']]
    },
    {
        name: 'those two files deleted',
        apply: () => [remove('common/scripted_triggers/rt_group_vanilla.txt'), remove('common/traits/zz_aa_rt_group.txt')],
        focus: [{ type: 'scripted_triggers', name: 'rt_has_group' }]
    },
    {
        name: 'a faith history file (history/faiths): the rites’ faiths follow it, not the first reading',
        apply: () => [put('history/faiths/zz_rt_faiths.txt', 'rt_faith = {\n\t1400.1.1 = {\n\t\tmain_rite = roman_rite\n\t}\n}\n')],
        focus: [],
        expect: (x) => [[`roman_rite belongs to rt_faith in 1450 (${riteHistory(x).faithOf('roman_rite', 14500101)})`, riteHistory(x).faithOf('roman_rite', 14500101) === 'rt_faith']]
    },
    {
        name: 'that file deleted (the rite is the faith type’s again)',
        apply: () => [remove('history/faiths/zz_rt_faiths.txt')],
        focus: [],
        expect: (x) => [[`roman_rite is not rt_faith’s any more (${riteHistory(x).faithOf('roman_rite', 14500101)})`, riteHistory(x).faithOf('roman_rite', 14500101) !== 'rt_faith']]
    },
    {
        name: 'a geographical region and a province definition file of the mod (map_data): not the index’s; named, the listing and MapData follow',
        apply: () => [put('map_data/geographical_regions/rt_regions.txt', 'rt_zz_marker_region = {\n\tcounties = { c_rt }\n}\n')],
        focus: [],
        map: ['map_data/geographical_regions/rt_regions.txt'],
        expect: (x) => [['the map’s region texts hold the file', new MapData(x).texts('map_data/geographical_regions').some((t) => t.includes('rt_zz_marker_region'))]]
    },
    {
        name: 'a font and a data binding file (fonts/, data_binding/): the listings follow, the GUI library is read again',
        apply: () => [put('fonts/rt_test.font', '# a font\n'), put('data_binding/rt_binding.txt', '# a binding\n')],
        focus: [],
        gui: ['fonts/rt_test.font', 'data_binding/rt_binding.txt'],
        expect: (x) => [
            ['the font is listed', x.vfs.list('fonts', { engine: true }).some((f) => f.rel === 'fonts/rt_test.font')],
            ['the data binding is listed', x.vfs.list('data_binding', { engine: true }).some((f) => f.rel === 'data_binding/rt_binding.txt')]
        ]
    },
    {
        name: 'the map files deleted again (the listing loses them)',
        apply: () => [remove('map_data'), remove('fonts'), remove('data_binding')],
        focus: [],
        map: ['map_data/geographical_regions/rt_regions.txt'],
        expect: (x) => [['the region file is gone from the map’s texts', !new MapData(x).texts('map_data/geographical_regions').some((t) => t.includes('rt_zz_marker_region'))]]
    },
    {
        name: 'file B calls a scripted effect nobody defines yet (taken in: B has a stamp now)',
        apply: () => [put('common/scripted_effects/rt_stale_b.txt', 'rt_stale_b = {\n\trt_stale_new = yes\n}\n')],
        focus: [{ type: 'scripted_effects', name: 'rt_stale_b' }]
    },
    {
        name: 'B changed on disk without an event, A defines the effect B calls: B is not resolved from its new text but goes to `rest`, the next update takes it in',
        apply: () =>
        {
            put('common/scripted_effects/rt_stale_b.txt', 'rt_stale_b = {\n\tadd_prestige = 7\n\trt_stale_new = yes\n\tadd_trait = brave\n}\n');
            return [put('common/scripted_effects/rt_stale_a.txt', 'rt_stale_new = {\n\tadd_gold = 1\n}\n')];
        },
        focus: [
            { type: 'scripted_effects', name: 'rt_stale_b' },
            { type: 'scripted_effects', name: 'rt_stale_new' },
            { type: 'traits', name: 'brave' }
        ],
        rest: ['common/scripted_effects/rt_stale_b.txt'],
        expect: (x) => [['nothing stale left after the chain', x.staleFiles().length === 0]]
    },
    {
        name: 'a mod effect whose parameter stands where a trait goes, and a call passing a name: the call links the trait only',
        apply: () => [
            put('common/scripted_effects/rt_param_effect.txt', 'rt_param_effect = {\n\tadd_trait = $WHO$\n}\n'),
            put('common/scripted_effects/rt_param_call.txt', 'rt_param_call = {\n\trt_param_effect = { WHO = brave }\n}\n')
        ],
        focus: [{ type: 'scripted_effects', name: 'rt_param_call' }, { type: 'traits', name: 'brave' }],
        expect: (x) => [['the call links the trait brave (the parameter stands where a trait goes)', x.resolveToken('brave', 'WHO', 'rt_param_effect', false, false, 'scripted_effects').map((e) => e.type).join() === 'traits']]
    },
    {
        name: 'the effect changed (the parameter now an amount): its caller in the unchanged file is resolved again',
        apply: () => [put('common/scripted_effects/rt_param_effect.txt', 'rt_param_effect = {\n\tadd_gold = $WHO$\n}\n')],
        focus: [{ type: 'scripted_effects', name: 'rt_param_call' }, { type: 'traits', name: 'brave' }],
        expect: (x) => [['the call no longer links the trait (the parameter an amount: script values only)', !x.resolveToken('brave', 'WHO', 'rt_param_effect', false, false, 'scripted_effects').some((e) => e.type === 'traits')]]
    },
    {
        name: 'a .txt directly in common/ (no type: the scan skips it, the picker’s key scan lists it): a change',
        apply: () => [put('common/rt_direct_top.txt', 'rt_top_x = { }\n')],
        focus: []
    },
    {
        name: 'sources, notes and backups beside the game files (.psd, .blend, .md, .bak, dot files): no change of the index',
        apply: () => [
            put('events/rt_readme.md', '# notes\n'),
            put('common/traits/zz_rt_traits.txt.bak', 'rt_trait_a = { }\n'),
            put('gfx/interface/icons/traits/rt_source.psd', 'not a picture'),
            put('gfx/models/rt/rt_banner.blend', 'not a model'),
            put('localization/english/.gitkeep', ''),
            // (other kinds nothing reads: stray data files)
            put('events/rt_data.json', '{}'),
            put('history/rt_stray/notes.csv', 'nothing'),
            // (.txt / .yml no scan and no listing reader takes: a history folder nobody reads, texts beside the
            // localization, a .yml in events/, another language's localization)
            put('history/rt_stray/notes.txt', 'nothing'),
            put('localization/rt_notes.txt', 'nothing'),
            put('events/rt_notes.yml', 'nothing'),
            put('localization/german/rt_x_l_german.yml', '﻿l_german:\n rt_name:0 "der Tester"\n')
        ],
        focus: [],
        quiet: true
    },
    {
        // (the picker's modifier list, StoryBuilder.modifierKeys: its per-Def scans are kept from the list made before
        // the update; `compare` checks it against the fresh build's)
        name: 'a mod modifier given by add_county_modifier, with a stat label of its own (MOD_ text in replace/)',
        apply: () => [
            put('common/modifiers/rt_modifiers.txt', 'rt_county_mod = {\n\tmonthly_prestige = 1\n\tdevelopment_growth_factor = 0.1\n}\n'),
            put('events/rt_mod_events.txt', 'namespace = rt_mod\n\nrt_mod.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tcapital_county = {\n\t\t\tadd_county_modifier = { modifier = rt_county_mod years = 5 }\n\t\t}\n\t}\n}\n'),
            put('localization/english/replace/rt_mod_l_english.yml', '﻿l_english:\n MOD_MONTHLY_PRESTIGE:0 "RT prestige"\n')
        ],
        focus: [
            { type: 'modifiers', name: 'rt_county_mod' },
            { type: 'events', name: 'rt_mod.1' }
        ],
        expect: (x) =>
        {
            const keys = new StoryBuilder(x).modifierKeys();
            const mp = keys.find((k) => k.key === 'monthly_prestige');
            rtModDef = x.get('modifiers', 'rt_county_mod')?.defs[0];
            return [[`modifier list: monthly_prestige reads the mod's label (${mp?.label})`, mp?.label === 'RT prestige', labelLayer(mp?.label, 'RT prestige')]];
        }
    },
    {
        name: 'that modifier now given by add_character_modifier, its label changed (the modifiers file unchanged)',
        apply: () => [
            put('events/rt_mod_events.txt', 'namespace = rt_mod\n\nrt_mod.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tadd_character_modifier = { modifier = rt_county_mod years = 5 }\n\t}\n}\n'),
            put('localization/english/replace/rt_mod_l_english.yml', '﻿l_english:\n MOD_MONTHLY_PRESTIGE:0 "RT prestige, again"\n')
        ],
        focus: [
            { type: 'modifiers', name: 'rt_county_mod' },
            { type: 'events', name: 'rt_mod.1' }
        ],
        expect: (x) =>
        {
            const keys = new StoryBuilder(x).modifierKeys();
            const mp = keys.find((k) => k.key === 'monthly_prestige');
            const def = x.get('modifiers', 'rt_county_mod')?.defs[0];
            return [
                [`modifier list: the new label (${mp?.label})`, mp?.label === 'RT prestige, again', labelLayer(mp?.label, 'RT prestige, again')],
                ['the modifier entry kept its Def object through the update (its scan is a kept one)', !!def && def === rtModDef]
            ];
        }
    },
    {
        name: 'a mod effect using its parameter only after `flag:`: the call links the flag of that name, not the trait',
        apply: () => [
            put('common/scripted_effects/rt_param_effect.txt', 'rt_param_effect = {\n\tset_variable = {\n\t\tname = rt_kind\n\t\tvalue = flag:$WHO$\n\t}\n}\n'),
            put('common/scripted_effects/rt_param_call.txt', 'rt_param_call = {\n\trt_param_effect = { WHO = brave }\n}\n')
        ],
        focus: [{ type: 'scripted_effects', name: 'rt_param_call' }, { type: 'traits', name: 'brave' }],
        expect: (x) => [['the call links the flag brave only (the parameter is used only as flag:$WHO$)', x.resolveToken('brave', 'WHO', 'rt_param_effect', false, false, 'scripted_effects').map((e) => `${e.type}:${e.name}`).join() === 'flag:brave']]
    },
    {
        name: 'a text naming a variable nothing uses yet (`[ROOT.Var(\'rt_born_var\').GetValue]`)',
        apply: () => [put('localization/english/rt_var_l_english.yml', '﻿l_english:\n rt_var_text:0 "Value: [ROOT.Var(\'rt_born_var\').GetValue]"\n')],
        focus: [{ type: 'localization', name: 'rt_var_text' }],
        expect: (x) => [['no variable of that name yet', !x.get('variable', 'rt_born_var')]]
    },
    {
        name: 'a script uses the variable first: the text that names it links it (as a build reads every text after the script)',
        apply: () => [put('common/scripted_effects/rt_var_effect.txt', 'rt_var_effect = {\n\tset_variable = { name = rt_born_var value = 1 }\n}\n')],
        focus: [{ type: 'localization', name: 'rt_var_text' }, { type: 'scripted_effects', name: 'rt_var_effect' }],
        expect: (x) =>
        {
            const v = x.get('variable', 'rt_born_var');
            const t = x.get('localization', 'rt_var_text');
            const from = v ? x.incomingSources(v).map((s) => `${s.entity.type}:${s.entity.name}`).sort().join(' ') : 'no variable';
            return [[`the variable is linked from the text and the effect (${from})`, !!t && from === 'localization:rt_var_text scripted_effects:rt_var_effect']];
        }
    }
];

console.log(`building the index (vanilla${withAgot ? ' + AGOT' : ''} + the test mod) …`);
let t = performance.now();
const idx = await build();
console.log(`  ${((performance.now() - t) / 1000).toFixed(1)} s, ${idx.stats.files} files, ${idx.stats.entities} entries, ${idx.stats.refs} references`);
// warm the caches views keep (touches, mod counts, lists)
idx.types();
// every update compacts the reference columns (in the app: once tombstones are a tenth of them); the comparisons
// then cover the renumbered references
idx.compactShare = 0;
/** display names computed so far (the top bar search matches those): an update keeps them, recomputing what changed */
const computed = (x: GameIndex): number => I(x).entities.filter((e) => !e.dead && e.display !== undefined).length;

try
{
    // nothing changed: nothing to do
    const same = idx.refreshFiles([join(root, 'events/rt_events.txt')]);
    check(!same.changed && !same.fallback, `unchanged file: nothing to do (${same.ms} ms)`);
    const outside = idx.refreshFiles([game('common/traits/00_traits.txt')]);
    check(!outside.changed && !outside.fallback, 'a game file: not a mod file, ignored');
    // (main compares the layering of the mods: a descriptor that changes it re-indexes, docs/mods.md)
    const desc = idx.refreshFiles([join(root, 'descriptor.mod')]);
    check(!desc.changed && !desc.fallback, 'descriptor.mod: not the index’s file, nothing to do');
    // more changed files than half the index's: a full build is faster
    const many = Math.ceil(idx.files.length * 0.5) + 10;
    const manyPaths: string[] = [];

    for (let i = 0; i < many; i++)
        manyPaths.push(put(`common/scripted_effects/rt_many/rt_many_${i}.txt`, `rt_many_${i} = { add_gold = 1 }\n`));

    const big = idx.refreshFiles(manyPaths);
    check(!big.changed && !!big.fallback && !big.rest, `${many} files: a full build, ${big.fallback} (${big.ms} ms)`);
    remove('common/scripted_effects/rt_many');

    const times: number[] = [];
    // CASES=12,13: only those (0-based; later cases may build on what earlier ones wrote)
    const only = process.env.CASES ? new Set(process.env.CASES.split(',').map(Number)) : null;

    for (const [i, c] of cases.entries())
    {
        if (only && !only.has(i))
            continue;

        console.log(`\n-- ${i}. ${c.name}`);
        // (the modifier list made before the update, as the app's picker does: its per-Def scans are kept)
        new StoryBuilder(idx).modifierKeys();
        const paths = c.apply();
        const namesBefore = computed(idx);
        t = performance.now();
        let r: RefreshResult = idx.refreshFiles(paths, CHUNK);
        let updates = 1;
        const shaders = [...(r.shaders ?? [])];
        const mapFiles = [...(r.map ?? [])];
        const guiFiles = [...(r.gui ?? [])];
        const files = [...r.files];
        const firstRest = (r.rest ?? []).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));

        if (c.rest)
            check(JSON.stringify(firstRest) === JSON.stringify(c.rest), `the first update leaves for the next: ${firstRest.join(', ') || 'nothing'}`);

        // (the rest of a big change: one update after another, like the worker)
        while (r.rest && !r.fallback)
        {
            const next = idx.refreshFiles(r.rest, CHUNK);
            r = { ...next, changed: r.changed || next.changed, parsed: r.parsed + next.parsed, resolved: r.resolved + next.resolved, names: (r.names ?? 0) + (next.names ?? 0), namesDropped: (r.namesDropped ?? 0) + (next.namesDropped ?? 0) };
            files.push(...next.files);
            updates++;
        }

        const ms = performance.now() - t;

        if (c.fallback)
        {
            check(!!r.fallback, `falls back to a full build: ${r.fallback}`);
            continue;
        }

        if (c.shaders !== undefined)
        {
            check(!r.changed && !r.fallback && shaders.length === c.shaders, `shader files: ${shaders.join(', ')}; the index unchanged (${ms.toFixed(0)} ms)`);
            const fresh = new GameFiles(gameDir!, mods);
            const listed = (v: GameFiles): string =>
                v.list('gfx/FX', { engine: true })
                    .map((f) => `${f.source}:${f.rel}`)
                    .join('\n');
            check(listed(idx.vfs) === listed(fresh), 'the gfx/FX listing (the shader store’s fingerprint) is the fresh one');
        }
        else if (c.quiet || c.map || c.gui)
        {
            // (not the index's files: nothing is taken in, no revision from the index; the worker acts on `map` and `gui`)
            check(!r.changed && !r.fallback && !r.files.length === !(c.map || c.gui), `${c.quiet ? 'nothing' : 'only listed files'} taken in, the index unchanged (${ms.toFixed(0)} ms)`);

            if (c.map)
                check(JSON.stringify(mapFiles) === JSON.stringify(c.map), `map files named: ${mapFiles.join(', ') || 'none'}`);

            if (c.gui)
                check(JSON.stringify(guiFiles) === JSON.stringify(c.gui), `interface files named: ${guiFiles.join(', ') || 'none'}`);
        }
        else
        {
            times.push(ms);
            check(r.changed && !r.fallback, `refreshed in ${ms.toFixed(0)} ms (${updates} ${updates === 1 ? 'update' : 'updates'}): ${files.length} files, ${r.parsed} parsed, ${r.resolved} resolved again${r.fallback ? ', FALLBACK ' + r.fallback : ''}`);

            if (c.gfx)
                check(JSON.stringify(r.gfx) === JSON.stringify(c.gfx), `gfx files taken in: ${r.gfx.join(', ') || 'none'}`);

            const namesAfter = computed(idx);
            // (a big change drops them instead: computed on use, like after a build)
            check(!namesBefore || namesAfter >= namesBefore * 0.95 || !!r.namesDropped, `display names kept: ${namesAfter} of ${namesBefore} computed before, ${r.names ?? 0} of them computed again${r.namesDropped ? `, ${r.namesDropped} dropped (a big change)` : ''} (the comparison below checks them all)`);
            check(I(idx).rFrom.every((x) => x >= 0), 'no removed references left in the columns (compacted)');
        }

        if (!c.quiet && !c.map && !c.gui && c.shaders === undefined)
        {
            // (a new builder after the update: only the changed files' definitions are scanned again)
            t = performance.now();
            const n = new StoryBuilder(idx).modifierKeys().length;
            check(n > 0, `the modifier list after the update, warm: ${(performance.now() - t).toFixed(0)} ms (${n} keys)`);
        }

        for (const line of c.expect?.(idx) ?? [])
            expectation(idx, line);

        if (withAgot && !process.env.COMPARE)
            continue;

        t = performance.now();
        const fresh = await build();
        const buildMs = performance.now() - t;
        const diffs = compare(idx, fresh, c.focus);
        check(!diffs.length, `identical to a full build (${(buildMs / 1000).toFixed(1)} s)${diffs.length ? ':\n     ' + diffs.slice(0, 30).join('\n     ') : ''}`);
        // every display name the updated index holds (kept through the updates or computed again) is the one a full
        // build computes (the top bar search matches them)
        let wrong = 0;
        let held = 0;
        const samples: string[] = [];

        for (const e of I(idx).entities)
        {
            if (e.dead || e.display === undefined)
                continue;

            held++;
            const f = fresh.get(e.type, e.name);
            const want = f ? fresh.displayName(f) : undefined;

            if ((e.display ?? undefined) === want)
                continue;

            wrong++;

            if (samples.length < 5)
                samples.push(`${e.type}|${e.name}: “${e.display}” ≠ “${want}”`);
        }

        check(!wrong, `${held} display names as a full build computes them${wrong ? `: ${wrong} differ (${samples.join('; ')})` : ''}`);

        if (c.cache)
        {
            const snap = idx.cacheSnapshot(code);
            check(!!snap, 'cache snapshot');

            if (snap)
            {
                const loaded = new GameIndex(new GameFiles(gameDir, mods), 'english');
                loaded.scan();
                check(loaded.fingerprint(code) === snap.fingerprint, 'the snapshot’s fingerprint is the one the next start computes');
                loaded.importState(snap.state);
                const d2 = compare(loaded, fresh, c.focus, false);
                check(!d2.length, `the rewritten cache loads as the full build${d2.length ? ':\n     ' + d2.slice(0, 20).join('\n     ') : ''}`);
            }
        }
    }

    // the files read are kept least recently used first: a file read again stays, the one not read for longest goes
    {
        const X = idx as unknown as { fileCache: Map<number, string>; };
        const small = I(idx).files.map((f, i) => ({ f, i })).filter((x) => !x.f.gone && !x.f.hidden && x.f.area === 'common' && idx.vfs.stat(x.f.gf).size < 50000).slice(0, 45).map((x) => x.i);
        X.fileCache.clear();

        for (const i of small.slice(0, 40))
            idx.readFile(i);

        idx.readFile(small[0]);
        idx.readFile(small[40]);
        check(small.length === 45 && X.fileCache.size === 40 && X.fileCache.has(small[0]) && !X.fileCache.has(small[1]), 'the file cache drops the least recently used file, not the first read');
    }

    // the test mod's replace_path changes (its descriptor; main sees only the replace paths differ): the index takes the
    // new layering as an update (GameIndex.relayer), game files hidden, then uncovered again, like a full build
    // (CASES=relayer: only these)
    if (!only || process.env.CASES!.split(',').includes('relayer'))
    {
        for (const paths of [['common/traits', 'gfx/models/pets/elephants'], []])
        {
            console.log(`\n-- replace_path ${paths.length ? paths.join(', ') : 'removed again'}`);
            mod.replacePaths = paths;
            t = performance.now();
            const r = idx.relayer([{ id: mod.id, replacePaths: paths }]);
            const ms = performance.now() - t;
            check(r.changed && !r.fallback, `taken in as an update in ${ms.toFixed(0)} ms: ${r.parsed} parsed, ${r.resolved} resolved again${r.fallback ? ', FALLBACK ' + r.fallback : ''}`);
            // (the views and the image workers hear of it: the folders and the pictures whose file is another, the script files hidden or uncovered)
            check(r.gfx.includes('gfx/models/pets/elephants') && r.gfx.every((f) => r.files.includes(f)), `the relayered gfx folder is reported (${r.gfx.length} gfx paths)`);
            check(r.files.some((f) => /^common\/traits\//i.test(f)), `the trait files the replace_path hid or uncovered are reported (${r.files.filter((f) => /^common\/traits\//i.test(f)).length})`);
            const fresh = await build();
            const diffs = compare(idx, fresh, []);
            check(!diffs.length, `identical to a full build${diffs.length ? ':\n     ' + diffs.slice(0, 30).join('\n     ') : ''}`);
        }
    }

    console.log(`\nrefresh times (ms): ${times.map((x) => x.toFixed(0)).join(' ')}; max ${Math.max(...times).toFixed(0)}`);
}
finally
{
    const notes = [notApplicable ? `${notApplicable} expectation(s) n/a with AGOT` : '', known ? `${known} KNOWN app imprecision(s), see the KNOWN lines` : ''].filter(Boolean).join(', ');
    console.log(failures ? `\n${failures} FAILED` : '\nall ok', ...(notes ? [`(${notes})`] : []), `(temp folder ${tmp})`);

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
