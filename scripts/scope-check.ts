// Checks the catalog's scope types (src/shared/scriptCatalog.ts: ScopeType, LINKS, ITERATORS) against how the game's
// own script writes them: walks common/ and events/, follows the scope type through links, lists and typed saved scopes
// (`scope:activity`, `title:k_france`, `root` of an event), and lists every use of a catalog list or link from a scope
// type its `from` does not name: a wrong `from`, or a link / list the catalog has not got yet. Where the walk cannot
// tell the type (a saved scope of an unknown name, a parameter `$X$`, a link the catalog lacks) it goes on unknown and
// says nothing. The `to` types are checked through that walk: the inner scope of a list or link is its `to`, and a
// link or list used inside it from a type the catalog gives it no `from` for is reported (a wrong `to` shows there where
// the script uses a link inside the block). A `to` whose blocks only hold effects and triggers is not reached by it;
// the lists whose `from` no typed use confirms are the reviewed set NAME_ONLY (docs/picker.md, "Scope types").
// Usage: node --experimental-strip-types --no-warnings scripts/scope-check.ts [installDir] [all] [unknown-links | guess]
// `unknown-links` (round 13, E5b / P6): instead of the checks above, lists the candidates for LINKS the catalog and the readable view lack:
// block keys used as scope switches (not an effect, trigger, iterator or link the catalog knows; most of their inner statements are
// statements) and chain parts after the first (`scope:x.some_link.y`), each with the type the walk had and the inner statements.
// A candidate list with noise (a game's parameter block can look like a switch), reviewed by hand; the exit code is 0.
// Exit code 1 when a use is outside `from` that is not in ACCEPTED (uses the walk types wrongly, reviewed one by one).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { ITERATORS, LINKS, SCOPE_TYPES, STATEMENTS, scopeTypeByName } from '../src/shared/scriptCatalog.ts';
import { knownLinks, scopeTypeByUse } from '../src/main/describe/describer.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { ScriptKeyScanner } from '../src/main/describe/scriptKeys.ts';
import { defaultInstall } from './ck3-install.ts';

const gameDir = resolveGameDir(process.argv[2] && process.argv[2] !== 'all' && process.argv[2] !== 'unknown-links' && process.argv[2] !== 'guess' ? process.argv[2] : defaultInstall());
const showAll = process.argv.includes('all');
const unknownMode = process.argv.includes('unknown-links');

if (!gameDir)
    throw new Error('No CK3 game folder');

/** database prefixes that name a scope of a type (`title:k_france = { … }`, `struggle:x`, `situation:x`) */
const PREFIX_TYPES: Record<string, string> = { character: 'character', title: 'landed_title', faith: 'faith', culture: 'culture', dynasty: 'dynasty', house: 'dynasty_house', province: 'province', religion: 'religion', rite: 'rite', tenet: 'tenet', struggle: 'struggle', situation: 'situation', top_participant_group: 'participant_group', doctrine: 'doctrine', culture_tradition: 'tradition', activity_tenet: 'tenet', activity_doctrine: 'doctrine' };
/** events (and the folders below) whose `root` is a character */
const CHARACTER_ROOT = /^(events\/(?!war_events\/)|common\/(decisions|character_interactions|important_actions)\/)/;
/**
 * Uses the walk types wrongly, checked against the script: `list@type`.
 * - saved scopes named after a thing the name says wrongly (`scope:inspection_location` is a county, not a province)
 * - a saved scope of a type's name that holds another (`scope:grand_campaign_war` …), or a root that is not a character
 */
const ACCEPTED = new Set<string>(['neighboring_county@province',
    // (links of the catalog written in a scope the walk types wrongly, reviewed against the script and kept apart from the lists: `challenger_sponsor ?= { holder ?= … }` is a saved
    // scope that holds a title, which the walk calls a character by the name; `scope:birth_location = { title_province = … }` is a title, which it calls a province by the name `location`.
    // Round three added the links the other entries here stood for: `religion` from a character and a province, `scheme_target_title`, `task_contract_target`)
    'link holder@character', 'link title_province@province']);
/**
 * The lists whose `from` rests on the list's name and on what its block holds, not on a typed use in the game's script
 * (every use sits in a scope the walk cannot type). Reviewed by hand; the run fails when a list joins or leaves this set,
 * so a new list is checked against a use or added here knowingly.
 */
const NAME_ONLY = new Set<string>(('desired_tenet undesired_tenet available_rite clerical_region_in_dejure_title clerical_region_in_realm powerful_vassal connected_county former_concubine former_concubinist real_parent real_grandparent real_great_grandparent extended_family_member subject home_court_hostage foreign_court_guest courtier_away pool_guest theocratic_vassal diplomacy_councillor stewardship_councillor intrigue_councillor normal_councillor neighboring_realm_owner neighboring_realm_with_tributaries_owner neighboring_and_across_water_realm_owner neighboring_top_suzerain_realm_owner contact character_to_title_neighboring_duchy character_to_title_neighboring_and_across_water_duchy character_to_title_neighboring_and_across_water_empire realm_de_jure_empire sub_realm_duchy sub_realm_kingdom sub_realm_empire neighboring_and_across_water_top_liege_realm pretender_title election_title alert_creatable_title alert_usurpable_title powerful_family claimed_artifact personal_claimed_artifact character_doctrine character_epidemic tax_slot sponsored_inspiration patroned_holy_order invited_activity open_invite_activity faith_playable_ruler faith_subordinate religious_head_challenger theocratic_ruler neighboring_faith culture_tradition adult_house_member house_claimed_artifact activity_phase_location visited_location secret_participant succession_appointment_invested_candidate succession_appointment_invested_title opposite_sex_spouse_candidate same_sex_spouse_candidate potential_marriage_option').split(' '));

const walkDir = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walkDir(join(d, f)) : f.endsWith('.txt') ? [join(d, f)] : []));
const files = [...walkDir(join(gameDir, 'common')), ...walkDir(join(gameDir, 'events'))].filter((f) => !/\/(trigger_localization|effect_localization)\//.test(f.replace(/\\/g, '/')));
const NOT_LISTS = /^(random_list|random_valid|random_events|random_on_actions?|random_on_action)$/;
const known = knownLinks();
const iterByList = new Map(ITERATORS.map((i) => [i.list, i]));
const linksByKey = new Map<string, typeof LINKS>();

// `guess` mode (round 13 wave 11, the owner's E5r(e) decision): every `scope:x = { … }` block whose name the definition
// it is in does not save (save_scope_as / save_temporary_scope_as anywhere in that top-level definition), counted by how
// the readable view types it: by its name (scopeTypeByName), else by its block's use (describer.ts scopeTypeByUse: a
// guess, marked, when not a character), else unknown (a character, as before). Ten samples of each. This is the
// script's own model, not the app's count: it leaves out every name the definition saves (the app only those of a known
// type), and it does not model the names a card's documentation or callers type (the app leaves those out) or the
// scopes a caller passes into an event (the app does not know them either, so it guesses them too). Exit code 0.
if (process.argv.includes('guess'))
{
    const byName: string[] = [];
    const byUse: string[] = [];
    const unknown: string[] = [];
    const byUseCharacter: string[] = [];
    const types = new Map<string, number>();
    const savedIn = (n: PNode, out: Set<string>): Set<string> =>
    {
        if ((n.k === 'save_scope_as' || n.k === 'save_temporary_scope_as') && typeof n.v === 'string')
            out.add(n.v);

        if (Array.isArray(n.v))
            for (const c of n.v)
                savedIn(c, out);

        return out;
    };

    for (const f of files)
    {
        const rel = f.slice(gameDir.length + 1).replace(/\\/g, '/');

        for (const def of parse(readFileSync(f, 'utf8')))
        {
            const saved = savedIn(def, new Set());
            const visit = (n: PNode): void =>
            {
                const m = n.k && /^scope:(\w+)$/.exec(n.k);

                if (m && Array.isArray(n.v) && !saved.has(m[1]))
                {
                    const site = `${rel}:${n.line} scope:${m[1]}`;
                    const named = scopeTypeByName(m[1]);
                    const used = named === undefined ? scopeTypeByUse(n.v) : undefined;

                    if (named !== undefined)
                        byName.push(`${site} -> ${named ?? 'not a scope type (null)'}`);
                    else if (used && used !== 'character')
                        (byUse.push(`${site} -> ${used}`), types.set(used, (types.get(used) ?? 0) + 1));
                    else if (used)
                        byUseCharacter.push(site);
                    else
                        unknown.push(site);
                }

                if (Array.isArray(n.v))
                    for (const c of n.v)
                        visit(c);
            };
            visit(def);
        }
    }

    const sample = (xs: string[]): string[] => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / 10)) === 0).slice(0, 10);
    console.log(`scope:x blocks whose name their definition does not save: ${byName.length + byUse.length + byUseCharacter.length + unknown.length}`);
    console.log(`  typed by name: ${byName.length}`);
    sample(byName).forEach((x) => console.log('    ' + x));
    console.log(`  typed by use (a guess): ${byUse.length} (${[...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')})`);
    sample(byUse).forEach((x) => console.log('    ' + x));
    console.log(`  by use a character (kept as before, unmarked: not told apart from a documented or passed-in one): ${byUseCharacter.length}`);
    sample(byUseCharacter).forEach((x) => console.log('    ' + x));
    console.log(`  unknown (a character, unmarked, as before): ${unknown.length}`);
    sample(unknown).forEach((x) => console.log('    ' + x));
    process.exit(0);
}

// unknown-links mode: what counts as a statement (so a block of them is a scope switch)
/** control flow and blocks that hold statements without switching scope */
const CONTROL = new Set(['if', 'else_if', 'else', 'limit', 'alternative_limit', 'AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else_if', 'trigger_else', 'hidden_effect', 'show_as_tooltip', 'random', 'random_list', 'switch', 'custom_tooltip', 'custom_description', 'custom_description_no_bullet', 'weight', 'modifier', 'order_by', 'trigger', 'effect', 'immediate', 'option', 'after', 'ai_chance', 'desc', 'first_valid', 'triggered_desc', 'fallback', 'calc_true_if', 'save_scope_as', 'save_temporary_scope_as']);
const statementKeys = new Set<string>();
const scalarKeys = new Set<string>();
const catalogKeys = new Set<string>();
const paramUse = new Map<string, number>();
const paramNames = new Set<string>();
const scriptedNames = new Set<string>();

if (unknownMode)
{
    const scan = new ScriptKeyScanner().scan(new GameFiles(gameDir));

    for (const k of [...scan.effect, ...scan.trigger])
    {
        statementKeys.add(k.key);

        // (a key written with a plain value is a statement, never a switch)
        if (Object.keys(k.shapes).some((s) => s !== 'block'))
            scalarKeys.add(k.key);

        if (k.scripted)
            scriptedNames.add(k.key);

        // (the fields of block statements are parameters (target, value, type …): a block of those is an effect with settings, no scope switch)
        for (const [f] of k.fields ?? [])
            paramUse.set(f, (paramUse.get(f) ?? 0) + 1);
    }

    for (const [f, n] of paramUse)
        if (n >= 5)
            paramNames.add(f);

    for (const d of STATEMENTS)
        catalogKeys.add(/^[\w$]+/.exec(d.script)?.[0] ?? d.id);
}

interface Cand
{
    count: number;
    types: Map<string, number>;
    inner: Map<string, number>;
    stmts: number;
    total: number;
    samples: string[];
}

const cands = new Map<string, Cand>();
const chainParts = new Map<string, Cand>();
const isStatementLike = (k: string): boolean => (!paramNames.has(k) && (catalogKeys.has(k) || linksByKey.has(k) || known.has(k))) || scriptedNames.has(k) || /^(any|every|random|ordered)_/.test(k) || k.includes(':') || k.includes('.');

/** A block key that is no link, effect, trigger or list the catalog knows: tallied with its walk type and the inner keys. */
function candidate(n: PNode, type: string | undefined, file: string): void
{
    const c = cands.get(n.k!) ?? cands.set(n.k!, { count: 0, types: new Map(), inner: new Map(), stmts: 0, total: 0, samples: [] }).get(n.k!)!;
    c.count++;
    c.types.set(type ?? '?', (c.types.get(type ?? '?') ?? 0) + 1);

    for (const x of n.v as PNode[])
    {
        // (control flow says nothing: every block holds some)
        if (!x.k || CONTROL.has(x.k))
            continue;

        c.total++;
        c.inner.set(x.k, (c.inner.get(x.k) ?? 0) + 1);

        if (isStatementLike(x.k))
            c.stmts++;
    }

    if (c.samples.length < 2)
        c.samples.push(`${file}:${n.line}`);
}

for (const l of LINKS)
    linksByKey.set(l.key, [...(linksByKey.get(l.key) ?? []), l]);

interface Miss
{
    what: string;
    count: number;
    samples: string[];
}

const misses = new Map<string, Miss>();
let lists = 0;
const verified = new Map<string, number>();
const used = new Map<string, number>();
let links = 0;
const miss = (what: string, at: string): void =>
{
    const m = misses.get(what) ?? misses.set(what, { what, count: 0, samples: [] }).get(what)!;
    m.count++;

    if (m.samples.length < 3)
        m.samples.push(at);
};

/** The type one part of a chain leads to, from `type` (undefined: not known). */
function step(type: string | undefined, part: string, root: string | undefined): string | undefined
{
    if (part === 'root')
        return root;

    if (part === 'this')
        return type;

    const m = /^([a-z_]+):(.+)$/.exec(part);

    if (m)
    {
        if (m[1] === 'scope')
        {
            const t = scopeTypeByName(m[2]);
            return typeof t === 'string' ? t : undefined;
        }

        return PREFIX_TYPES[m[1]];
    }

    if (!type)
        return undefined;

    return linksByKey.get(part)?.find((l) => l.from.length === 0 || l.from.includes(type as never))?.to;
}

function walk(nodes: PNode[], type: string | undefined, root: string | undefined, file: string, parent?: string): void
{
    for (const n of nodes)
    {
        if (!n.k || !Array.isArray(n.v))
            continue;

        let inner: string | undefined = type;
        const it = !NOT_LISTS.test(n.k) && /^(any|every|random|ordered)_(\w+)$/.exec(n.k);
        const def = it ? iterByList.get(it[2]) : undefined;

        // (a switch's cases are values, `doctrine:x = { … }`, `scope:artifact ?= { … }`, no scope switches)
        if (parent === 'switch')
            inner = type;
        else if (it && def)
        {
            lists++;
            used.set(it[2], (used.get(it[2]) ?? 0) + 1);

            if (type && (def.global || def.from.includes(type as never)))
                verified.set(it[2], (verified.get(it[2]) ?? 0) + 1);

            if (type && !def.global && !def.from.includes(type as never) && (showAll || !ACCEPTED.has(`${it[2]}@${type}`)))
                miss(`${it[2]}@${type} (catalog from ${def.from.join('|')})`, `${file}:${n.line}`);

            inner = def.to;
        }
        else if (it)
            inner = undefined;
        else if (n.k.includes('.') || n.k.includes(':'))
        {
            let at: string | undefined = type;

            for (const part of n.k.split('.'))
            {
                at = step(at, part, root);

                if (!at)
                    break;
            }

            inner = at;
        }
        else if (n.k === 'root')
            inner = root;
        else if (n.k.startsWith('$') || n.k === 'prev' || n.k === 'from')
            inner = undefined;
        else if (linksByKey.has(n.k))
        {
            // (a key that is a link in the catalog and a statement of the game too: only a block with no scope of this type is a switch)
            const l = type ? linksByKey.get(n.k)!.find((x) => x.from.length === 0 || x.from.includes(type as never)) : undefined;
            links++;
            inner = l?.to;

            // (a link of the catalog used from a scope type it has no entry for: the list or link that led here has a wrong `to`, or the link lacks a `from`; this is the check of the `to` types)
            if (type && !l && (showAll || !ACCEPTED.has(`link ${n.k}@${type}`)))
                miss(`link ${n.k}@${type} (catalog from ${linksByKey.get(n.k)!.map((x) => x.from.join('|') || '*').join(' ; ')})`, `${file}:${n.line}`);
        }
        else if (known.has(n.k))
            inner = undefined;
        else if (unknownMode && parent !== undefined && !CONTROL.has(n.k) && !scalarKeys.has(n.k) && !scriptedNames.has(n.k) && /^[a-z][a-z_0-9]*$/.test(n.k))
            candidate(n, type, file);

        walk(n.v, inner, root, file, n.k);
    }
}

/** Chain parts after the first that lead somewhere (`scope:x.some_link.y`: `some_link`) and no table knows, in the text of one file. */
function chainScan(text: string, rel: string): void
{
    for (const m of text.replace(/#[^\n]*/g, '').matchAll(/(?<![\w$@.:])((?:[a-z_]+:)?[\w-]+(?:\.[a-z_]+)+)/g))
    {
        const segs = m[1].split('.');

        // (a scope chain only: it starts at a scope; not a loc key `x.tt.y` or a coat of arms' pattern)
        if (!/^(root|this|prev|from|[a-z_]+:[\w-]+)$/.test(segs[0]) && !known.has(segs[0]))
            continue;

        for (const seg of segs.slice(1, -1))
            if (/^[a-z_]+$/.test(seg) && !known.has(seg) && !linksByKey.has(seg))
            {
                const c = chainParts.get(seg) ?? chainParts.set(seg, { count: 0, types: new Map(), inner: new Map(), stmts: 0, total: 0, samples: [] }).get(seg)!;
                c.count++;

                if (c.samples.length < 2)
                    c.samples.push(`${m[1]}  (${rel})`);
            }
    }
}

for (const f of files)
{
    const rel = f.slice(gameDir.length + 1).replace(/\\/g, '/').replace(/^game\//, '');

    if (unknownMode)
        chainScan(readFileSync(f, 'utf8'), rel);

    walk(parse(readFileSync(f, 'utf8')), undefined, CHARACTER_ROOT.test(rel) ? 'character' : undefined, rel);
}

// every scope type named by a list or link is a ScopeType (the type checker holds that too) and has a way in
const types = new Set<string>(SCOPE_TYPES);
const reach = new Map<string, number>();

for (const l of LINKS)
    reach.set(l.to, (reach.get(l.to) ?? 0) + 1);

for (const i of ITERATORS)
    reach.set(i.to, (reach.get(i.to) ?? 0) + 1);

const unreached = [...types].filter((t) => !reach.get(t) && t !== 'character');

// a link key that leads to two types from the same type (the readable view keeps one answer per key: describer.ts CATALOG_LINKS)
const ambiguous: string[] = [];

for (const [key, ls] of linksByKey)
    for (let a = 0; a < ls.length; a++)
        for (let b = a + 1; b < ls.length; b++)
            if (ls[a].to !== ls[b].to && (!ls[a].from.length || !ls[b].from.length || ls[a].from.some((f) => ls[b].from.includes(f))))
                ambiguous.push(`${key}: ${ls[a].to} / ${ls[b].to}`);

if (unknownMode)
{
    // (the candidates: half or more of the inner keys are statements, used at least 3 times; sorted by use)
    const rank = (m: Map<string, Cand>): [string, Cand][] => [...m].sort((a, b) => b[1].count - a[1].count);
    const top = (m: Map<string, number>, n: number): string => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k}(${c})`).join(' ');
    const typed = (c: Cand): number => c.count - (c.types.get('?') ?? 0);
    const sw = rank(cands).filter(([, c]) => typed(c) >= 1 && c.count >= 3 && c.total > 0 && c.stmts / c.total >= 0.5);
    console.log(`BLOCK KEYS USED AS SCOPE SWITCHES that no table knows (${sw.length}; >= 3 uses, one in a scope the walk could type, half or more of the inner keys statements of the catalog, scripted ones, lists or links):`);

    for (const [k, c] of sw)
        console.log(`${String(c.count).padStart(5)}  ${k}  walk types: ${top(c.types, 4)}\n         inner: ${top(c.inner, 6)}\n         ${c.samples.join('  ')}`);

    const ch = rank(chainParts);
    console.log(`CHAIN PARTS no table knows (${ch.length} distinct, ${ch.reduce((a, [, c]) => a + c.count, 0)} uses; includes value triggers and noise):`);

    for (const [k, c] of ch.slice(0, 80))
        console.log(`${String(c.count).padStart(5)}  ${k}  ${c.samples.join('  ')}`);

    process.exit(0);
}

const rows = [...misses.values()].sort((a, b) => b.count - a.count);
const unverified = ITERATORS.filter((i) => used.get(i.list) && !verified.get(i.list) && !i.global).map((i) => i.list);
// (a list in NAME_ONLY that a use now confirms, or that is no longer used, also fails: the set stays the truth)
const setDrift = [
    ...unverified.filter((l) => !NAME_ONLY.has(l)).map((l) => `UNCONFIRMED FROM ${l}: no typed use confirms it; check by hand and add to NAME_ONLY`),
    ...[...NAME_ONLY].filter((l) => !unverified.includes(l)).map((l) => `NAME_ONLY ${l}: now confirmed by a use, gone, or global; remove from NAME_ONLY`)
];
const bad = rows.length + ambiguous.length + setDrift.length;

for (const m of rows)
    console.log(`${String(m.count).padStart(5)}  ${m.what}\n         ${m.samples.join('\n         ')}`);

for (const a of ambiguous)
    console.log(`AMBIGUOUS LINK ${a}`);

console.log(`${lists} uses of the catalog's lists and ${links} link blocks followed through ${files.length} files: ${rows.length ? rows.length + ' kinds outside the catalog’s from' : 'all inside the catalog’s from'}`);
// lists whose `from` no use of the game could confirm (every use was in a scope the walk could not type): to check by hand
for (const d of setDrift)
    console.log(d);

console.log(`lists used in the game whose from no use confirmed (reviewed by hand, NAME_ONLY): ${unverified.length}`);
console.log(`${SCOPE_TYPES.length} scope types, ${LINKS.length} links, ${ITERATORS.length} lists${unreached.length ? '; no link or list leads to: ' + unreached.join(', ') : ''}`);
process.exit(bad ? 1 : 0);
