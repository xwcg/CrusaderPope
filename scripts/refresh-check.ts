// Checks incremental index updates (GameIndex.refreshFiles, docs/indexer.md "Incremental updates") against full builds:
// the vanilla game plus a temp mod in a TEMP folder (never the real user folder). Each case changes the mod's files,
// takes them in with refreshFiles and compares the index with a fresh full build of the same files — definitions,
// references (with their list order), localization, mod touches, types, lists, searches, details, cards, stories,
// graphs, galleries — and, for a few cases, the rewritten cache (cacheSnapshot) loaded into a fresh scan.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=12000 scripts/refresh-check.ts [keep]
// CASES=12,13 runs only those cases (0-based numbers as printed).
// AGOT=1: the mod layered over A Game of Thrones (Workshop 2962333032, read only) — timings only; COMPARE=1 also the
// full comparisons (a build with AGOT takes ~40 s: the run ~15 min).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex, type Entity, type FileInfo, type RefreshResult } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { parseDescriptor } from '../src/main/mods/descriptor.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { T_FLAG, T_VARIABLE } from '../src/main/indexer/schema.ts';
import { defaultInstall, workshopFolder } from './ck3-install.ts';

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
function build(): GameIndex
{
    const idx = new GameIndex(new GameFiles(gameDir!, mods), 'english');
    idx.scan();
    // (records each file's size and time: an update skips files that did not change)
    idx.fingerprint(code);
    idx.parseAll();
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
    same('image folders', a.fileFolders('images'), b.fileFolders('images'));
    same('model folders', a.fileFolders('models'), b.fileFolders('models'));
    same('mod images', a.filesIn('images', 'gfx/interface/icons/traits'), b.filesIn('images', 'gfx/interface/icons/traits'));
    const sa = new StoryBuilder(a);
    const sb = new StoryBuilder(b);
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
    expect?: (x: GameIndex) => [string, boolean][];
    /** expected: this many shader files named, the index unchanged */
    shaders?: number;
    /** expected: exactly these gfx files taken in (folder events: the unchanged files below stay out) */
    gfx?: string[];
}

/** How the mods touch an entry, as "state" / "state+uses" ('-' untouched). */
const stateOf = (x: GameIndex, type: string, name: string): string =>
{
    const t = x.detail(type, name)?.mod;
    return t ? t.state + (t.uses ? '+uses' : '') + (t.duplicate ? '+dup' : '') : '-';
};

/** files of the chunked case (more than one update takes) and the updates' size */
const CHUNK_FILES = 1200;
const CHUNK = 500;

// the mod before the first case
put('events/rt_events.txt', EVENTS);
put('common/traits/zz_rt_traits.txt', TRAITS);
put('localization/english/rt_l_english.yml', LOC);
put('common/scripted_effects/rt_effects.txt', 'rt_other_effect = {\n\tadd_gold = 5\n}\n');

const traitsGame = readFileSync(game('common/traits/00_traits.txt'), 'utf8');
// (its @constants: a copy of brave is the same as the game only with them — docs/mods.md "Same as the game")
const traitsConsts = [...traitsGame.matchAll(/^@\w+[ \t]*=[^\r\n]*/gm)].map((m) => m[0]).join('\n') + '\n\n';
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
            ['brave, copied as the game has it: same as the game', stateOf(x, 'traits', 'brave') === 'same'],
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
        expect: (x) => [['brave re-spaced with comments: same as the game', stateOf(x, 'traits', 'brave') === 'same']]
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
            [`the game's flag is untouched again (${stateOf(x, 'flag', 'wear_armor')})`, stateOf(x, 'flag', 'wear_armor') === '-']
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
            [`a localization key defined again outside replace/: a duplicate (${stateOf(x, 'localization', 'trait_craven')})`, stateOf(x, 'localization', 'trait_craven') === 'overridden+dup'],
            ['counted as duplicates', (x.types().find((t) => t.id === 'events')?.modStates?.duplicates ?? 0) >= 1]
        ]
    },
    {
        name: 'the duplicates removed again',
        apply: () => [remove('events/zz_rt_dup_events.txt'), remove('localization/english/rt_dup_l_english.yml')],
        focus: [{ type: 'events', name: 'court.8190' }],
        expect: (x) => [[`the event is the game's alone again (${stateOf(x, 'events', 'court.8190')})`, stateOf(x, 'events', 'court.8190') === '-']]
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
        name: 'a shader file (gfx/FX): not the index’s — named for the shader store, the listing takes it',
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
    }
];

console.log(`building the index (vanilla${withAgot ? ' + AGOT' : ''} + the test mod) …`);
let t = performance.now();
const idx = build();
console.log(`  ${((performance.now() - t) / 1000).toFixed(1)} s, ${idx.stats.files} files, ${idx.stats.entities} entries, ${idx.stats.refs} references`);
// warm the caches views keep (touches, mod counts, lists)
idx.types();
// every update compacts the reference columns (in the app: once tombstones are a tenth of them) — the comparisons
// then cover the renumbered references
idx.compactShare = 0;
/** display names computed so far (the top bar search matches those): an update keeps them — recomputing what changed */
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
    check(!desc.changed && !desc.fallback, 'descriptor.mod: not the index’s file — nothing to do');
    // more changed files than half the index's: a full build is faster
    const many = Math.ceil(idx.files.length * 0.5) + 10;
    const manyPaths: string[] = [];

    for (let i = 0; i < many; i++)
        manyPaths.push(put(`common/scripted_effects/rt_many/rt_many_${i}.txt`, `rt_many_${i} = { add_gold = 1 }\n`));

    const big = idx.refreshFiles(manyPaths);
    check(!big.changed && !!big.fallback && !big.rest, `${many} files: a full build — ${big.fallback} (${big.ms} ms)`);
    remove('common/scripted_effects/rt_many');

    const times: number[] = [];
    // CASES=12,13: only those (0-based; later cases may build on what earlier ones wrote)
    const only = process.env.CASES ? new Set(process.env.CASES.split(',').map(Number)) : null;

    for (const [i, c] of cases.entries())
    {
        if (only && !only.has(i))
            continue;

        console.log(`\n— ${i}. ${c.name}`);
        const paths = c.apply();
        const namesBefore = computed(idx);
        t = performance.now();
        let r: RefreshResult = idx.refreshFiles(paths, CHUNK);
        let updates = 1;
        const shaders = [...(r.shaders ?? [])];
        const files = [...r.files];

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
            check(!r.changed && !r.fallback && shaders.length === c.shaders, `shader files: ${shaders.join(', ')} — the index unchanged (${ms.toFixed(0)} ms)`);
            const fresh = new GameFiles(gameDir!, mods);
            const listed = (v: GameFiles): string =>
                v.list('gfx/FX', { engine: true })
                    .map((f) => `${f.source}:${f.rel}`)
                    .join('\n');
            check(listed(idx.vfs) === listed(fresh), 'the gfx/FX listing (the shader store’s fingerprint) is the fresh one');
        }
        else
        {
            times.push(ms);
            check(r.changed && !r.fallback, `refreshed in ${ms.toFixed(0)} ms (${updates} ${updates === 1 ? 'update' : 'updates'}): ${files.length} files, ${r.parsed} parsed, ${r.resolved} resolved again${r.fallback ? ' — FALLBACK ' + r.fallback : ''}`);

            if (c.gfx)
                check(JSON.stringify(r.gfx) === JSON.stringify(c.gfx), `gfx files taken in: ${r.gfx.join(', ') || 'none'}`);

            const namesAfter = computed(idx);
            // (a big change drops them instead: computed on use, like after a build)
            check(!namesBefore || namesAfter >= namesBefore * 0.95 || !!r.namesDropped, `display names kept: ${namesAfter} of ${namesBefore} computed before, ${r.names ?? 0} of them computed again${r.namesDropped ? `, ${r.namesDropped} dropped (a big change)` : ''} (the comparison below checks them all)`);
            check(I(idx).rFrom.every((x) => x >= 0), 'no removed references left in the columns (compacted)');
        }

        for (const [what, ok] of c.expect?.(idx) ?? [])
            check(ok, what);

        if (withAgot && !process.env.COMPARE)
            continue;

        t = performance.now();
        const fresh = build();
        const buildMs = performance.now() - t;
        const diffs = compare(idx, fresh, c.focus);
        check(!diffs.length, `identical to a full build (${(buildMs / 1000).toFixed(1)} s)${diffs.length ? ':\n     ' + diffs.slice(0, 30).join('\n     ') : ''}`);
        // every display name the updated index holds — kept through the updates or computed again — is the one a full
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

        check(!wrong, `${held} display names as a full build computes them${wrong ? `: ${wrong} differ — ${samples.join('; ')}` : ''}`);

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

    console.log(`\nrefresh times (ms): ${times.map((x) => x.toFixed(0)).join(' ')}; max ${Math.max(...times).toFixed(0)}`);
}
finally
{
    console.log(failures ? `\n${failures} FAILED` : '\nall ok', '— temp folder', tmp);

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
