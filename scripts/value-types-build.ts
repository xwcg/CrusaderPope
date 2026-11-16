// Value types (docs/indexer.md "Value types"): what each key's value names, from the game's own use. Every scalar value
// of the game's script files (the files the index reads, the game's alone), under the keys the index resolves it by:
// a definition's own field (`@<type>|<key>`, no parent key), `<parent>.<key>` and `<key>`; for each, the entry types
// its plain names name. A key whose names mostly name nothing takes free text (a saved scope's name, a list's name):
// it links nothing. A key whose names all name one type links that type only. Writes src/main/indexer/valueTypes.ts
// (generated; the index's code, so its cache key follows) and a report of what is weak, shared and contradicts a
// hand-written rule (schema.ts CONTEXT_RULES): the probe run's input (docs/indexer.md).
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=8000 scripts/value-types-build.ts [report.txt]
// GAME=<install dir> (default: the development install). VT_OUT=<file>: the table written there instead.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { CONTEXT_ONLY_TYPES, CONTEXT_RULES, isFlagKey, isVariableKey, paramsIn, prefixedParam } from '../src/main/indexer/schema.ts';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';
import { gameVersion } from '../src/main/mods/discover.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = process.argv[2];
const gameDir = resolveGameDir(process.env.GAME ?? defaultInstall());

if (!gameDir)
    throw new Error('no game install');

const idx = await fastIndex(gameDir, { cache: true });
const version = /\d+(\.\d+)+/.exec(gameVersion(gameDir) ?? '')?.[0] ?? '?';
const NOT_TYPES = new Set(['localization', 'flags', 'variables']);

// (the game's links (data/game-docs, event_targets.log): a bare one as a value is a scope, `character = house_head`)
const docs = join(root, 'data', 'game-docs');
const docsVersion = readdirSync(docs).filter((d) => statSync(join(docs, d)).isDirectory()).sort().at(-1)!;
const LINK_NAMES = new Set([...readFileSync(join(docs, docsVersion, 'script_docs', 'event_targets.log'), 'utf8').matchAll(/^([a-z_]+) - /gm)].map((m) => m[1]));

/** at least this many name-like values for a verdict */
const MIN = 3;

// (the definitions of each file by line: where an owner starts, as the index takes them (a nested one is its own))
const defAt = new Map<number, Map<number, { type: string; name: string; }[]>>();

for (const e of idx.entities)
{
    if (!e || e.dead || NOT_TYPES.has(e.type))
        continue;

    for (const d of e.defs)
    {
        const m = defAt.get(d.file) ?? defAt.set(d.file, new Map()).get(d.file)!;
        (m.get(d.line) ?? m.set(d.line, []).get(d.line)!).push({ type: e.type, name: e.name });
    }
}

interface Stat
{
    /** name-like values: names (of entries or nothing), the loc keys among the nothing */
    names: number;
    /** of the named values, those written in history files (a character's `death = { killer = id }`: data, not a statement) */
    history: number;
    named: number;
    loc: number;
    /** per type: values naming an entry of it, and the distinct values */
    types: Map<string, { n: number; distinct: Set<string>; }>;
    distinct: Set<string>;
    /** where it was seen first (the report) */
    at: string;
}

const stats = new Map<string, Stat>();
const typesOf = new Map<string, string[]>();

// (a trait group's name names its traits where traits are looked for, `has_trait = education_martial`: GameIndex.genericLookup)
const traitGroups = (idx as unknown as { traitGroups(): Map<string, unknown[]>; }).traitGroups();

function namesOf(v: string): string[]
{
    let t = typesOf.get(v);

    if (!t)
    {
        t = [...new Set(idx.named(v).filter((e) => !NOT_TYPES.has(e.type)).map((e) => e.type))];

        if (traitGroups.has(v) && !t.includes('traits'))
            t.push('traits');

        typesOf.set(v, t);
    }

    return t;
}

function record(ctx: string, v: string, types: string[], isLoc: boolean, at: string): void
{
    let s = stats.get(ctx);

    if (!s)
        stats.set(ctx, (s = { names: 0, named: 0, history: 0, loc: 0, types: new Map(), distinct: new Set(), at }));

    s.names++;

    s.distinct.add(v);

    if (types.length)
    {
        s.named++;

        if (at.startsWith('history/'))
            s.history++;
    }
    else if (isLoc)
        s.loc++;

    for (const t of types)
    {
        let x = s.types.get(t);

        if (!x)
            s.types.set(t, (x = { n: 0, distinct: new Set() }));

        x.n++;
        x.distinct.add(v);
    }
}

/** A scalar value under its keys: the plain names only (numbers, scopes, prefixed names, flags, parameters keep their own rules). */
function value(v: string, quoted: boolean, key: string | null, k0: string | null, owner: string, at: string): void
{
    // (a number as the key is a weight or a position, one key for all of them: `random_on_action = { 100 = x }` is
    // `random_on_action.#`, valueTypesOf takes it so)
    const k1 = key !== null && /^\d+(\.\d+)?$/.test(key) ? '#' : key;

    if (!k1 || k1.includes('$') || v.length < 2 || v.includes('$') || v.startsWith('@') || v.includes(':') || v.includes('.') || (quoted && /\s/.test(v)))
        return;

    if (v === 'yes' || v === 'no' || /^-?\d/.test(v) || /^(root|this|prev|from)$/i.test(v) || LINK_NAMES.has(v))
        return;

    if (isFlagKey(k1) || isVariableKey(k1) || ((k1 === 'name' || k1 === 'variable' || k1 === 'flag') && (isFlagKey(k0) || isVariableKey(k0))))
        return;

    const types = namesOf(v);
    const isLoc = !types.length && !!idx.get('localization', v);

    if (k0 === null)
        record(`@${owner}|${k1}`, v, types, isLoc, at);
    else if (k0 !== '')
        record(`${k0}.${k1}`, v, types, isLoc, at);

    record(k1, v, types, isLoc, at);
}

/** A definition's statements and fields, as collectCandidates walks them (path: the keys above, '' for a nameless block). */
function walk(nodes: PNode[], owner: string, path: string[], fileDefs: Map<number, { type: string; name: string; }[]> | undefined, rel: string): void
{
    const k0 = path.length ? path[path.length - 1] : null;

    for (const n of nodes)
    {
        if (Array.isArray(n.v))
        {
            // (a nested definition: its own owner, from its own top)
            const nested = n.k ? fileDefs?.get(n.line)?.find((d) => d.name === n.k) : undefined;

            if (nested)
            {
                walk(n.v, nested.type, [], fileDefs, rel);
                continue;
            }

            path.push(n.k ?? '');
            walk(n.v, owner, path, fileDefs, rel);
            path.pop();
            continue;
        }

        const k1 = n.k ?? k0;
        const kk0 = n.k === null ? (path.length > 1 ? path[path.length - 2] : null) : k0;
        value(n.v, !!n.q, k1, kk0, owner, `${rel}:${n.line}`);
    }
}

let files = 0;

for (let f = 0; f < idx.files.length; f++)
{
    const fi = idx.files[f];
    const defs = defAt.get(f);

    if (!fi || fi.source !== 0 || !defs || fi.area === 'localization' || fi.area === 'savegame')
        continue;

    let nodes: PNode[];

    try
    {
        nodes = parse(readFileSync(fi.abs, 'utf8').replace(/^﻿/, ''));
    }
    catch
    {
        continue;
    }

    files++;

    // (the definitions at the top, and those a top-level block holds (a religion's faiths are their own definitions))
    const top = (list: PNode[]): void =>
    {
        for (const n of list)
        {
            if (!Array.isArray(n.v) || !n.k)
                continue;

            const d = defs.get(n.line)?.find((x) => x.name === n.k);

            if (d)
                walk(n.v, d.type, [], defs, fi.rel);
            else
                top(n.v);
        }
    };
    top(nodes);
}

// ---------------------------------------------------------------------------------------------------------------------
// verdicts
// ---------------------------------------------------------------------------------------------------------------------

const CONTROL = new Set(['if', 'else', 'else_if', 'limit', 'trigger', 'effect', 'AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else', 'trigger_else_if', 'alternative_limit', 'is_shown', 'is_valid', 'potential', 'allow', 'immediate', 'option', 'after', 'hidden_effect', 'show_as_tooltip', 'modifier', 'weight', 'ai_chance', 'ai_will_do', 'random_list', 'switch', 'first_valid', 'random_valid', 'triggered_desc', 'desc']);

// (the game's documented effects and triggers: a statement is the same code wherever it stands)
const STATEMENTS = new Set(['effects.log', 'triggers.log'].flatMap((f) => [...readFileSync(join(docs, docsVersion, 'script_docs', f), 'latin1').matchAll(/^([a-z_][a-z_0-9]*) - /gm)].map((m) => m[1])));

/**
 * A parent that does not change what the key takes: control flow, a scope switch, a link, a date, a parameter; and for
 * a statement, a statement or iterator around it (`random_relation = { save_scope_as = ward }`, `give_noble_family_title
 * = { save_scope_as = new_title }` save a scope as anywhere). Under a block of data a statement's name is a field of its
 * own (a gene's `setting = { age = age_preset_child_features }`), and so is a definition's own field (`@<type>|…`).
 */
function LOOSE_PARENT(p: string, k?: string): boolean
{
    if (CONTROL.has(p) || p.includes(':') || p.includes('.') || p.includes('$') || /^(root|this|prev|from)$/i.test(p) || /^\d/.test(p) || LINK_NAMES.has(p))
        return true;

    return !!k && STATEMENTS.has(k) && (STATEMENTS.has(p) || /^(every|any|random|ordered)_/.test(p));
}

const DESCRIBING = new Set(['game_concepts', 'trigger_localization', 'effect_localization', 'modifier_definition_formats', 'flavorization']);

/** The types a hand-written rule links a key to, alone or under any parent. */
function rulesOfKey(k: string): Set<string>
{
    const out = new Set<string>();

    for (const [rk, types] of Object.entries(CONTEXT_RULES))
        if (rk === k || rk.endsWith('.' + k))
            for (const t of types)
                out.add(t);

    return out;
}

type Verdict = { types: string[]; strength: 'strong' | 'weak'; why: string; };

/** The hand-written rule the index has for a context (as resolveToken takes it). */
function handRule(ctx: string): string[] | undefined
{
    if (ctx.startsWith('@'))
        return CONTEXT_RULES[ctx.slice(ctx.indexOf('|') + 1)];

    // (as resolveToken: the parent's and key's rule, else the key's)
    return CONTEXT_RULES[ctx] ?? (ctx.includes('.') ? CONTEXT_RULES[ctx.slice(ctx.lastIndexOf('.') + 1)] : undefined);
}

/** The key a context is about, and its parent (`great_project_type`, `create_epidemic_outbreak` of `.type`). */
function keysOf(ctx: string): string[]
{
    const own = ctx.startsWith('@') ? ctx.slice(ctx.indexOf('|') + 1) : ctx;
    return own.split('.').reverse();
}

/**
 * Of types sharing their names (buildings and great projects, traits and epidemics), the ones the key's own words name:
 * a type's name less its plural and its `types` folder, shortened word by word (`game_rule_options` → `game_rule`),
 * found in the key or its parent (`great_project_type`, `has_game_rule`, `create_epidemic_outbreak.type`).
 */
function namedByKey(ctx: string, types: string[]): string[]
{
    const keys = keysOf(ctx);
    const hit = (t: string): boolean =>
    {
        const segs = t.split('/');
        const words = (segs.at(-1) === 'types' && segs.length > 1 ? segs.at(-2)! : segs.at(-1)!).replace(/s$/, '').split('_');

        for (let n = words.length; n > 0; n--)
        {
            const w = words.slice(0, n).join('_');

            if (w.length >= 4 && keys.some((k) => k.toLowerCase().includes(w)))
                return true;
        }

        return false;
    };
    const named = types.filter(hit);
    return named.length === 1 ? named : [];
}

function decide(ctx: string, s: Stat): Verdict | null
{
    if (s.names < MIN)
        return null;

    const unnamed = (s.names - s.named) / s.names;
    // (the types all its named values name; a context-only type only where a rule names it, or alone and with enough
    // different values: names shared by chance (`skill = diplomacy`, a trigger text named so) are not links)
    const full = s.named ? [...s.types].filter(([, x]) => x.n >= 0.95 * s.named).map(([t]) => t) : [];
    const rule = handRule(ctx);
    const ruled = rule ? full.filter((t) => rule.includes(t)) : [];
    const open = full.filter((t) => !CONTEXT_ONLY_TYPES.has(t));
    // (types named after other things (concepts, trigger and effect texts, modifier formats): only where a hand-written
    // rule links the key to them somewhere, `custom_description.text` → effect texts for `custom_description_no_bullet`)
    const describing = full.length === 1 && DESCRIBING.has(full[0]) && !rulesOfKey(keysOf(ctx)[0]).has(full[0]);
    let types = (ruled.length ? ruled : open.length ? open : full.length === 1 && !describing && s.types.get(full[0])!.distinct.size >= 5 ? full : []).sort();
    const byKey = types.length > 1 ? namedByKey(ctx, types) : [];

    const tie = byKey.length ? ` (of ${types.join(' + ')}, by the key's words)` : '';

    if (byKey.length)
        types = byKey;

    const distinct = types.length ? Math.min(...types.map((t) => s.types.get(t)!.distinct.size)) : 0;
    const share = `${Math.round((100 * s.named) / s.names)}% named`;

    // (a hand-written rule some values bear out (`animation = <scripted animation>` among portrait animations' names):
    // kept as it is, the probe's to settle)
    const borne = rule ? rule.filter((t) => s.types.has(t)) : [];

    if (borne.length && !types.some((t) => rule!.includes(t)))
        return { types: borne, strength: 'weak', why: `${share}; the rule's ${borne.join(', ')} named by some, the rest other or nothing` };

    // (names that mostly name nothing: free text (a saved scope's or list's name), unless the few that name something
    // all name one type: then the key takes that type or a name of its own (`animation = <scripted animation>` or a
    // portrait animation's name, which the index does not hold))
    if (unnamed >= 0.8)
    {
        // (unless the few named are a real part of it: as many different names of one type linked today as a twentieth of
        // all (`title = k_makran` among the texts' keys), not names that happen to match (`save_scope_as = friend`))
        // (or, for a type of few entries, a tenth of the values: `target = <court amenity>`, four of them)
        const opens = [...s.types].filter(([t]) => !CONTEXT_ONLY_TYPES.has(t)).map(([, x]) => x);

        if (opens.some((x) => (x.distinct.size >= 5 && x.distinct.size >= 0.05 * s.distinct.size) || (x.n >= 10 && x.n >= 0.1 * s.names)))
            return null;

        // (mostly localization keys: a text's key, whatever the few others name)
        if (s.loc >= 0.5 * s.names)
            return { types: [], strength: s.names >= 10 ? 'strong' : 'weak', why: `${Math.round((100 * s.loc) / s.names)}% localization keys` };

        if (types.length === 1 && distinct >= 3)
            return { types, strength: s.named >= 5 ? 'strong' : 'weak', why: `${share}, all of them ${types[0]} (${distinct} different)` };

        return { types: [], strength: s.distinct.size >= 5 && s.names >= 10 ? 'strong' : 'weak', why: `${Math.round(100 * unnamed)}% name nothing` };
    }

    if (s.named / s.names < 0.5 || !full.length)
        return null;

    if (!types.length)
        return { types: [], strength: 'weak', why: `names only types linked by a rule (${full.join(', ')})` };

    const strong = types.length === 1 && distinct >= 3 && s.named >= 5;
    return { types, strength: strong ? 'strong' : 'weak', why: `${share}, ${types.length > 1 ? 'names shared by ' + types.join(' + ') : distinct + ' different'}${tie}` };
}

const verdicts = new Map<string, Verdict>();

// (VT_DEBUG=<context>: its numbers and verdict)
if (process.env.VT_DEBUG)
{
    const d = stats.get(process.env.VT_DEBUG);
    console.log(process.env.VT_DEBUG, d && { names: d.names, named: d.named, loc: d.loc, types: [...d.types].map(([t, x]) => [t, x.n, x.distinct.size]) }, d && decide(process.env.VT_DEBUG, d), handRule(process.env.VT_DEBUG));
}

for (const [ctx, s] of stats)
{
    const v = decide(ctx, s);

    if (v)
        verdicts.set(ctx, v);
}

// (what the game's own documentation says where the names alone cannot: icon names that are also faiths' names)
const DOCUMENTED: [string, string[], string][] = [
    ['@religion/religion_types|custom_faith_icons', [], '_religion_types.info: icon names, gfx/interface/icons/faith/<name>.dds'],
    ['has_icon', [], 'triggers.log: "Does the faith have the given icon"'],
    ['faith_details.icon', [], 'a faith\'s icon name, as custom_faith_icons'],
    ['@character_interactions|icon', [], '_character_interactions.info: "icon = key", an icon\'s name'],
    ['character.religion', [], '_bookmarks.info: "Localization key for the religion shown"'],
    ['@character_memory_types|participants', [], '_character_memory_types.info: participants saved with their key'],
    ['@defines|PIETY_GROUPS', [], '00_graphics.txt: the piety icon groups\' names'],
    ['@religion/religion_family_types|piety_icon_group', [], '_religion_family_types.info: "( string )", a piety icon group'],
    ['has_triggered_legend_seed', ['legends/legend_seeds'], 'triggers.log: "the specified triggered legend seed", king_arthur'],
    ['send_option.flag', [], '_character_interactions.info: "scope:flag_name will be set to yes", a saved scope\'s name']
];

for (const [ctx, types, why] of DOCUMENTED)
    verdicts.set(ctx, { types, strength: 'strong', why });

// (a key's verdict holds only where its parents' own evidence does not say otherwise: `name` is a text's key in most
// places and a bookmark portrait in bookmarks; then the key keeps today's links, the parents their own entries)
const subs = new Map<string, string[]>();

for (const ctx of verdicts.keys())
{
    if (!ctx.startsWith('@') && !ctx.includes('.'))
        continue;

    if (!ctx.startsWith('@') && LOOSE_PARENT(ctx.slice(0, ctx.lastIndexOf('.')), ctx.slice(ctx.lastIndexOf('.') + 1)))
        continue;

    const key = ctx.startsWith('@') ? ctx.slice(ctx.indexOf('|') + 1) : ctx.slice(ctx.lastIndexOf('.') + 1);
    (subs.get(key) ?? subs.set(key, []).get(key)!).push(ctx);
}

for (const [ctx, v] of verdicts)
{
    if (ctx.startsWith('@') || ctx.includes('.') || v.strength !== 'strong')
        continue;

    // (a parent's strong verdict is an entry of its own; a weak one holds the key back when it rests on 3 different
    // names or more, not on one that happens to match (`give_noble_family_title = { save_scope_as = new_title }`))
    const other = (subs.get(ctx) ?? []).filter((c) =>
    {
        const o = verdicts.get(c)!;

        if (o.types.join() === v.types.join() || o.strength === 'strong')
            return false;

        const st = stats.get(c)!;

        if (!o.types.length)
            return st.distinct.size >= 3;

        return o.types.some((t) => (st.types.get(t)?.distinct.size ?? 0) >= 3 || (st.types.get(t)?.n ?? 0) >= 10);
    });

    if (other.length)
        verdicts.set(ctx, { ...v, strength: 'weak', why: `${v.why}; but ${other.slice(0, 3).join(', ')}${other.length > 3 ? ' …' : ''} say otherwise` });
}

// (the parameters of the game's scripted effects and triggers, by how `$PARAM$` is used inside: `contract_disease_effect
// = { DISEASE = smallpox }` names what goes where `$DISEASE$` stands; one type wherever it is used, else nothing said;
// a call's own values do not decide it (they often share their names: epidemics and their traits))
// (a verdict from a parameter's `flag:` / `scope:` / `var:` uses alone: never handed on to a caller passing it through)
const weakVerdicts = new Set<string>();
const typedAt = (k1: string, k0: string | null, owner: string): string[] | undefined =>
{
    const ownKey = k0 === null ? `@${owner}|${k1}` : !LOOSE_PARENT(k0, k1) ? `${k0}.${k1}` : undefined;
    const own = ownKey !== undefined && !weakVerdicts.has(ownKey) ? verdicts.get(ownKey) : undefined;
    const key = verdicts.get(k1);
    const v = own?.strength === 'strong' ? own : key?.strength === 'strong' ? key : undefined;

    if (v)
        return v.types;

    const rule = (k0 !== null ? CONTEXT_RULES[`${k0}.${k1}`] : undefined) ?? CONTEXT_RULES[k1];
    return rule ? [...rule].sort() : undefined;
};
let paramCount = 0;

for (const e of idx.entities)
{
    if (!e || e.dead || (e.type !== 'scripted_effects' && e.type !== 'scripted_triggers'))
        continue;

    const def = idx.defNode(e);

    if (!def || !Array.isArray(def.node.v))
        continue;

    const uses = new Map<string, Set<string>>();
    // (`flag:$X$`, `scope:$X$`, `var:$X$`: what they say counts only for a parameter used no other way: `other`)
    const weak = new Map<string, Set<string>>();
    const other = new Set<string>();
    const walkParams = (nodes: PNode[], path: string[]): void =>
    {
        const k0 = path.length ? path[path.length - 1] : null;

        for (const n of nodes)
        {
            for (const p of n.k ? paramsIn(n.k) : [])
                other.add(p);

            if (Array.isArray(n.v))
            {
                path.push(n.k ?? '');
                walkParams(n.v, path);
                path.pop();
                continue;
            }

            // (after a prefix, `trait:$T$`, the prefix says what it takes, wherever it stands)
            const pre = prefixedParam(n.v);

            if (pre)
            {
                const into = pre.strong ? uses : weak;
                (into.get(pre.param) ?? into.set(pre.param, new Set()).get(pre.param)!).add(pre.types.join(','));
                continue;
            }

            const m = /^\$([^$\s]+)\$$/.exec(n.v);
            const k1 = n.k ?? k0;

            if (!m)
            {
                for (const p of paramsIn(n.v))
                    other.add(p);

                continue;
            }

            if (!k1)
                continue;

            const types = typedAt(k1, n.k === null ? (path.length > 1 ? path[path.length - 2] : null) : k0, e.type);
            (uses.get(m[1]) ?? uses.set(m[1], new Set()).get(m[1])!).add(types ? types.join(',') : '?');
        }
    };
    walkParams(def.node.v, []);

    const weakOnly = new Set<string>();

    for (const [p, seen] of weak)
    {
        if (!uses.has(p) && !other.has(p))
        {
            uses.set(p, seen);
            weakOnly.add(p);
        }
    }

    for (const [p, seen] of uses)
    {
        if (seen.size !== 1 || seen.has('?'))
            continue;

        const vk = `${e.name}.${p}`;

        // (what the calls pass, when their names all name one type, says more than a flag named after it)
        if (weakOnly.has(p) && verdicts.get(vk)?.strength === 'strong')
            continue;

        const types = [...seen][0].split(',').filter(Boolean);
        verdicts.set(vk, { types, strength: 'strong', why: `$${p}$ stands where ${types.join(', ') || 'free text'} goes` });
        paramCount++;

        if (weakOnly.has(p))
            weakVerdicts.add(vk);
    }
}

// (a more specific context that says what its key says anyway is left out)
const same = (a: Verdict, b: Verdict | undefined): boolean => !!b && a.types.join() === b.types.join();
const table: [string, string[]][] = [];
const kept = new Map<string, Verdict>();

for (const [ctx, v] of verdicts)
{
    const key = ctx.startsWith('@') ? ctx.slice(ctx.indexOf('|') + 1) : ctx.includes('.') ? ctx.slice(ctx.lastIndexOf('.') + 1) : null;

    if (key !== null && same(v, verdicts.get(key)))
        continue;

    // (a parent that does not change what the key takes: a scope switch, a link, a date, a parameter, control flow;
    // the key alone answers there)
    if (!ctx.startsWith('@') && ctx.includes('.') && LOOSE_PARENT(ctx.slice(0, ctx.lastIndexOf('.')), ctx.slice(ctx.lastIndexOf('.') + 1)))
        continue;

    // (only strong verdicts link differently from today; the weak ones are the probe's to settle)
    if (v.strength !== 'strong')
        continue;

    kept.set(ctx, v);
    table.push([ctx, v.types]);
}

// ---------------------------------------------------------------------------------------------------------------------
// the probe run (data/value-types/probe-<version>.json, scripts/value-types-probe.ts): what the game itself expected of
// each statement's value and each field of a statement's block, from its error log
// ---------------------------------------------------------------------------------------------------------------------

/** the game's names of the databases it looked in → the index's types */
const DB_TYPES: Record<string, string[]> = {
    'modifier': ['modifiers'], 'static modifier': ['modifiers'], 'event': ['events'], 'opinion modifier': ['opinion_modifiers'],
    'relation': ['scripted_relations'], 'scripted relation': ['scripted_relations'], 'trait': ['traits'], 'trait group': ['traits'],
    'story': ['story_cycles'], 'artifact template': ['artifacts/templates'], 'artifact visual type': ['artifacts/visuals'],
    'scheme type': ['schemes/scheme_types'], 'important action type': ['important_actions'], 'field important_action_type': ['important_actions'],
    'building': ['buildings'], 'nickname': ['nicknames'], 'death reason': ['deathreasons'], 'council position type': ['council_positions'],
    'council task type type': ['council_tasks'], 'holding type': ['holdings'], 'holding': ['holdings'], 'field holding type': ['holdings'],
    'law': ['laws'], 'faction type': ['factions'], 'menatarmstype': ['men_at_arms_types'], 'secret type': ['secret_types'],
    'field aspiration type': ['house_aspirations'], 'field chronicle': ['legends/chronicles'],
    'field government type for create landless title effect': ['governments'], 'field give_noble_family_title - government type': ['governments']
};
/** kinds of names the game looked for that the index does not hold (flags of definitions, views, skills, its own words): none */
const NO_ENTRY = /flag$|^(view token|ingame view|character skill|truce reason|prison type|sexuality|contribution type|category|target type|winner|loc key|year)$/;
const probeFile = join(root, 'data', 'value-types', `probe-${version}.json`);
const probeReport: string[] = [];
const tableMap = new Map(table);
let probeApplied = 0;

try
{
    const probe = JSON.parse(readFileSync(probeFile, 'utf8')) as { probes: { s: string; f?: string; k: string[]; silent?: true; m?: string; }[]; };
    const known = new Set(idx.entities.filter((e) => e && !e.dead).map((e) => e.type));

    for (const p of probe.probes)
    {
        const dbs = p.k.filter((k) => k.startsWith('db:')).map((k) => k.slice(3).replace(/ \(\w+\)$/, ''));
        let want: string[] | undefined;
        let why = '';

        if (dbs.length)
        {
            const mapped = [...new Set(dbs.flatMap((d) => DB_TYPES[d] ?? []))].filter((t) => known.has(t));

            if (mapped.length)
                [want, why] = [mapped.sort(), `the game looked in ${dbs.join(', ')}`];
            else if (dbs.every((d) => NO_ENTRY.test(d)))
                [want, why] = [[], `the game read a ${dbs.join(', ')}, which the index does not hold`];
        }
        else if (p.k.includes('value'))
            [want, why] = [['script_values'], 'the game read a script value'];
        else if (p.k.some((k) => k === 'scope' || k === 'loc' || k === 'date'))
            [want, why] = [[], `the game read a ${p.k.filter((k) => k === 'scope' || k === 'loc' || k === 'date').join(' or ')}`];

        if (!want)
            continue;

        const key = p.f ? `${p.s}.${p.f}` : p.s;
        const now = tableMap.get(key);

        // (a statement's own key is also a data field elsewhere (`faith = catholic` in a character's history): where a
        // definition's own field or a dated history block of that key has vanilla naming entries of other types, the key
        // keeps what it has; the statement's own uses that happen to match a name (`change_prison_type = dungeon`, a
        // static modifier so named) do not hold the game's reading back)
        if (!p.f)
        {
            const other = [...verdicts].filter(([c, v]) => (c.endsWith('|' + key) || new RegExp(`^\\d+\\.\\d+\\.\\d+\\.${key}$`).test(c)) && v.types.length && v.types.join() !== want!.join() && !v.types.includes('script_values'));

            if (other.length)
            {
                probeReport.push(`  kept     ${key.padEnd(48)} ${why} → ${want.join(', ') || 'nothing'}; but ${other.slice(0, 2).map(([c, v]) => `${c} → ${v.types.join(', ')}`).join('; ')}`);
                continue;
            }
        }

        // (and where vanilla's own use says more than the message: a scope-or-value whose values are script values (the
        // message names only what the game tried last: `set_variable = { value = my_value }`), or names that history
        // files write (a character's `death = { killer = id }` is data, the effect's `killer` a scope))
        const use = verdicts.get(key);
        const st = stats.get(key);
        const valued = !want.length && (!!use?.types.includes('script_values') || (!!st && (st.types.get('script_values')?.n ?? 0) >= Math.max(5, 0.5 * st.named)));
        const history = !!use?.types.length && use.types.join() !== want.join() && !!st && st.history >= 3 && st.history >= 0.5 * st.named;

        if (valued || history)
        {
            probeReport.push(`  kept     ${key.padEnd(48)} ${why} → ${want.join(', ') || 'nothing'}; but vanilla's ${valued ? 'values are script values' : `names are written in history files (${st!.history} of ${st!.named})`}: ${use?.types.join(', ') ?? 'script_values'}`);
            continue;
        }

        if (now && now.join() === want.join())
            continue;

        probeReport.push(`  ${now ? 'changed' : 'added  '}  ${key.padEnd(48)} ${now ? now.join(', ') || 'nothing' : '(none)'} → ${want.join(', ') || 'nothing'} (${why})`);
        tableMap.set(key, want);
        probeApplied++;
    }
}
catch (e)
{
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw e;
}

// (what the docs say goes in as it is, past the pruning: `character` is also a link's name, but a bookmark's
// `character = { religion = … }` is its own block)
for (const [ctx, types] of DOCUMENTED)
    tableMap.set(ctx, types);

table.length = 0;
table.push(...tableMap);
table.sort((a, b) => (a[0] < b[0] ? -1 : 1));

const lines = [
    '// Generated by scripts/value-types-build.ts from the game\'s own use; do not edit (docs/indexer.md "Value types").',
    `// Game ${version}: ${files} files. Keys: \`@<type>|<key>\` a definition's own field, \`<parent>.<key>\`, \`<key>\`.`,
    '// A value under a key named here names an entry of these types only; [] names nothing (free text).',
    '',
    `export const VALUE_TYPES_GAME = '${version}';`,
    '',
    'export const VALUE_TYPES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([',
    ...table.map(([k, t], i) => `    [${JSON.stringify(k)}, [${t.map((x) => JSON.stringify(x)).join(', ')}]]${i < table.length - 1 ? ',' : ''}`),
    ']);',
    ''
];
// (VT_OUT=<file>: written there instead (value-types-check compares it with the one in the code))
const tableFile = process.env.VT_OUT ?? join(root, 'src/main/indexer/valueTypes.ts');
writeFileSync(tableFile, lines.join('\n'));

// ---------------------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------------------

const report: string[] = [];
const count = (f: (v: Verdict, ctx: string) => boolean): number => [...verdicts].filter(([c, v]) => f(v, c)).length;
report.push(`game ${version}: ${files} files, ${stats.size} contexts, ${verdicts.size} with a verdict, ${kept.size} in the table`);
report.push(`  strong: ${count((v) => v.strength === 'strong')} (links nothing ${count((v) => v.strength === 'strong' && !v.types.length)}), weak: ${count((v) => v.strength === 'weak')}; scripted effects' and triggers' parameters typed by their use: ${paramCount}`);
report.push(`  the probe run (${probeFile.slice(root.length + 1)}): ${probeApplied} entries added or changed, ${probeReport.filter((l) => l.startsWith('  kept')).length} statements kept as they are`);
report.push('');
report.push('== the probe run');
report.push(...probeReport);
report.push('');
report.push('== contradicting a hand-written rule (rule → the game\'s use)');

for (const [ctx, v] of [...verdicts].sort((a, b) => (stats.get(b[0])?.names ?? 0) - (stats.get(a[0])?.names ?? 0)))
{
    const rule = handRule(ctx);

    if (rule && !v.types.some((t) => rule.includes(t)))
        report.push(`  ${String(stats.get(ctx)?.names ?? 0).padStart(6)}  ${ctx.padEnd(48)} rule ${rule.join(', ')} → ${v.types.join(', ') || 'nothing'} (${v.strength}; ${v.why}) e.g. ${[...(stats.get(ctx)?.distinct ?? [])].slice(0, 5).join(' ')}`);
}

for (const [title, f] of [['weak (for the probe)', (v: Verdict) => v.strength === 'weak'], ['shared names', (v: Verdict) => v.types.length > 1]] as const)
{
    report.push('');
    report.push(`== ${title}`);

    for (const [ctx, v] of [...verdicts].filter(([, v]) => f(v)).sort((a, b) => (stats.get(b[0])?.names ?? 0) - (stats.get(a[0])?.names ?? 0)))
        report.push(`  ${String(stats.get(ctx)?.names ?? 0).padStart(6)}  ${ctx.padEnd(48)} → ${v.types.join(', ') || 'nothing'} (${v.why}) e.g. ${[...(stats.get(ctx)?.distinct ?? [])].slice(0, 5).join(' ')} at ${stats.get(ctx)?.at ?? '(a parameter)'}`);
}

report.push('');
report.push('== no verdict (mixed), by size');

for (const [ctx, s] of [...stats].filter(([c, s]) => !verdicts.has(c) && s.names >= MIN).sort((a, b) => b[1].names - a[1].names).slice(0, 300))
    report.push(`  ${String(s.names).padStart(6)}  ${ctx.padEnd(48)} ${Math.round((100 * s.named) / s.names)}% named: ${[...s.types].sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([t, x]) => `${t} ${Math.round((100 * x.n) / Math.max(1, s.named))}%`).join(', ')} e.g. ${[...s.distinct].slice(0, 5).join(' ')}`);

if (reportFile)
    writeFileSync(reportFile, report.join('\n') + '\n');

console.log(report.slice(0, 2).join('\n'));
console.log(`${tableFile}: ${table.length} entries`);
