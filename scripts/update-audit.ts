// After a game update: checks the game's script files changed since a date against the indexer's rules
// (docs/game-structure.md, "Layouts that changed"). Per changed file: braces balanced (the parser is tolerant and says
// nothing); every `prefix:name` value (a prefix PREFIX_TYPES knows must name an entry, an unknown prefix is listed)
// and every value under a key CONTEXT_RULES links (also the words of `tenets = { … }`-style lists) resolves; per type
// with changed definitions, entries without a name or description in game where most of their type have one; scope
// types the game's .info documentation names, iterators and chain links the app's catalog / readable view lack.
// Usage: SINCE=2026-09-30 node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/update-audit.ts [top]
// The index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew).
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { Lexer, parse, TK_EOF, TK_LBRACE, TK_RBRACE, type PNode } from '../src/main/indexer/parser.ts';
import { CONTEXT_ONLY_TYPES, CONTEXT_RULES, PREFIX_TYPES } from '../src/main/indexer/schema.ts';
import { ITERATORS, SCOPE_ORDER } from '../src/shared/scriptCatalog.ts';
import { knownLinks } from '../src/main/describe/describer.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const since = Date.parse(process.env.SINCE ?? '1970-01-01');
const TOP = Number(process.argv[2] ?? 25);
const idx = await fastIndex(new GameFiles(resolveGameDir(defaultInstall())!), { cache: true });

/** prefixes that are no database entries (scopes, variables, lists, values) */
const NOT_ENTRIES = new Set(['scope', 'var', 'local_var', 'global_var', 'dead_var', 'flag', 'list', 'value', 'script_value', 'event_id', 'ordered', 'every', 'random', 'any',
    // (prefixes of values that name no database entry: a list's size, a legend's property, an activity's tenet / doctrine, a memory's participant, a special guest)
    'list_size', 'legend_property', 'activity_tenet', 'activity_doctrine', 'memory_participant', 'special_guest',
    // (game-rule settings written `player:yes` / `ai:no` / `all:…`)
    'player', 'ai', 'all']);
// (a template, `admin_eunuch_$TYPE$_1_modifier`, names nothing before the game fills it in)
const SKIP_VALUE = /^(yes|no|none|root|this|prev|from|always|never|-?[\d.]+|@.*|.*\$.*|scope:.*|var:.*|local_var:.*|global_var:.*|flag:.*)$/i;
/** words a linked key takes instead of an entry (`dynasty = generate`, `faith = same_faith`, `culture = character`): the game's own keywords */
const KEYWORD_VALUES = new Set(['generate', 'inherit', 'same_faith', 'same_rite', 'government_type', 'clergy', 'character', 'province', 'primary_partner', 'capital_province']);
/** keys whose values are no database entries: the game's engine animation names */
const NOT_LINKED_KEYS = new Set(['animation']);

interface Tally
{
    count: number;
    samples: string[];
}

const tally = (m: Map<string, Tally>, key: string, sample: string): void =>
{
    const t = m.get(key) ?? m.set(key, { count: 0, samples: [] }).get(key)!;
    t.count++;

    if (t.samples.length < 4 && !t.samples.includes(sample))
        t.samples.push(sample);
};

// scopes: iterators (`any_x` / `every_x` …) and links used inside a chain (`a.b.c`: a and b lead somewhere) the app's
// catalog / readable view does not know
const iterUse = new Map<string, Tally>();
const linkUse = new Map<string, Tally>();
const knownIter = new Set(ITERATORS.map((i) => i.list));
const known = knownLinks();

const resolves = (name: string, types: string[]): boolean => types.some((t) => !!idx.get(t, name));
// (the app's own resolution (also a trait group, `has_trait = wounded`), told apart from a name found only as an entry of another type: the app links
// that too, the game does not necessarily accept it)
const resolvesAs = (name: string, key: string, types: string[]): 'rule' | 'other' | 'none' =>
{
    const found = idx.resolveToken(name, key, null, false, false);
    return found.some((e) => types.includes(e.type)) ? 'rule' : found.length ? 'other' : 'none';
};
const braces: string[] = [];
const unknownPrefix = new Map<string, Tally>();
const unresolvedPrefix = new Map<string, Tally>();
const unresolvedKey = new Map<string, Tally>();
const otherTypeKey = new Map<string, Tally>();
// (a value that is a scope link too, `faith = faith`, `liege = top_liege`: a scope is meant, so it is not looked up as an entry. Listed, not hidden: a value that is
// both a link and an entry's name, found by no rule, would otherwise pass unseen)
const linkValue = new Map<string, Tally>();
const ctxUse = new Map<string, { all: number; hit: number; types: Set<string>; samples: string[]; }>();
let files = 0;

for (let i = 0; i < idx.files.length; i++)
{
    const f = idx.files[i];

    if (f.source !== 0 || !/\.txt$/.test(f.rel) || !/^(common|events|history)\//.test(f.rel))
        continue;

    const st = idx.vfs.stat(f.gf);

    if (!(st.mtime >= since))
        continue;

    files++;
    const text = idx.readFile(i);

    // braces
    const lx = new Lexer(text);
    let depth = 0;

    for (let t = lx.next(); t.t !== TK_EOF; t = lx.next())
    {
        if (t.t === TK_LBRACE)
            depth++;
        else if (t.t === TK_RBRACE && --depth < 0)
        {
            braces.push(`${f.rel}:${t.line}: a } too many`);
            depth = 0;
        }
    }

    if (depth > 0)
        braces.push(`${f.rel}: ${depth} { not closed`);

    // scopes (not the localization files that name every trigger and effect, not `scope:random_x = { … }`)
    if (!/^common\/(trigger|effect)_localization\//.test(f.rel))
        for (const m of text.replace(/#[^\n]*/g, '').matchAll(/(?<![\w.:$])(any|every|random|ordered)_(\w+)\s*=\s*\{/g))
        {
            const key = `${m[1]}_${m[2]}`;

            // (a scripted trigger or effect named any_x / every_x (`any_valid_title_to_grant_trigger`) is a call, no iterator; nor a script value or an on_action named so, nor a character template's weighted `random_traits_list` / `random_culture`)
            if (
                !knownIter.has(m[2]) && !/^(list|valid|events|on_actions?|in_list|in_global_list|in_local_list|traits_list|culture)$/i.test(m[2]) && !idx.get('scripted_triggers', key) && !idx.get('scripted_effects', key) && !idx.get('script_values', key) && !idx.get('on_action', key)
            )
                tally(iterUse, m[2], `${key}  (${f.rel})`);
        }

    for (const m of text.replace(/#[^\n]*/g, '').matchAll(/(?<![\w$@.:])((?:[a-z_]+:)?[\w-]+(?:\.[a-z_]+)+)/g))
    {
        const segs = m[1].split('.');

        // (a scope chain only (it starts at a scope: root, scope:x, title:y, a known link; not a loc key `x.tt.y` or a
        // coat of arms' pattern); all but its last part lead somewhere: links)
        if (!/^(root|this|prev|from|[a-z_]+:[\w-]+)$/.test(segs[0]) && !known.has(segs[0]))
            continue;

        for (const seg of segs.slice(1, -1))
            if (/^[a-z_]+$/.test(seg) && !known.has(seg))
                tally(linkUse, seg, `${m[1]}  (${f.rel})`);
    }

    // values
    const at = (n: PNode): string => `${f.rel}:${n.line}`;
    const walk = (nodes: PNode[], parentKey: string | null): void =>
    {
        for (const n of nodes)
        {
            if (Array.isArray(n.v))
            {
                walk(n.v, n.k);
                continue;
            }

            const v = typeof n.v === 'string' ? n.v.replace(/^"|"$/g, '') : undefined;

            if (!v)
                continue;

            const pm = /^(\w+):([\w.-]+)$/.exec(v);

            if (pm && !NOT_ENTRIES.has(pm[1]))
            {
                const types = PREFIX_TYPES[pm[1]];
                const name = pm[2].split('.')[0];

                if (!types)
                    tally(unknownPrefix, pm[1], `${v}  (${at(n)})`);
                else if (!resolves(name, types))
                    tally(unresolvedPrefix, pm[1], `${v}  (${at(n)})`);

                continue;
            }

            // a value under a linked key (`religion = x`), or a word of a linked list (`tenets = { x }`)
            const key = n.k ?? parentKey;
            const types = key ? CONTEXT_RULES[key] : undefined;

            // the reverse: a key no rule links whose values mostly name entries of a context-only type (nothing else links those; they are never found by name)
            if (key && !types && !SKIP_VALUE.test(v) && !v.includes('.') && !v.includes(':'))
            {
                const t = ctxUse.get(key) ?? ctxUse.set(key, { all: 0, hit: 0, types: new Set(), samples: [] }).get(key)!;
                t.all++;
                // (a culture's history is named for the culture: its names are the cultures'; a game concept is a plain word: it would meet half of the values)
                const hit = [...CONTEXT_ONLY_TYPES].filter((ct) => ct !== 'history/cultures' && ct !== 'game_concepts' && !!idx.get(ct, v));

                if (hit.length)
                {
                    t.hit++;
                    hit.forEach((h) => t.types.add(h));

                    if (t.samples.length < 3 && !t.samples.includes(v))
                        t.samples.push(`${v}  (${at(n)})`);
                }
            }

            if (!types || NOT_LINKED_KEYS.has(key!) || SKIP_VALUE.test(v) || v.includes('.') || v.includes(':') || KEYWORD_VALUES.has(v))
                continue;

            const how = resolves(v, types) ? 'rule' : resolvesAs(v, key!, types);

            if (how !== 'rule' && known.has(v))
            {
                // (only when some entry has the name; otherwise it is a scope link and nothing else)
                if (how === 'other' || idx.named(v).length)
                    tally(linkValue, `${key}${n.k ? '' : ' (list)'} → ${types.join('|')}`, `${v}  (${at(n)})`);

                continue;
            }

            if (how !== 'rule')
                tally(how === 'other' ? otherTypeKey : unresolvedKey, `${key}${n.k ? '' : ' (list)'} → ${types.join('|')}`, `${v}  (${at(n)})`);
        }
    };
    walk(parse(text), null);
}

// names and descriptions: per type with changed definitions, the entries without a name or description in game while
// most of their type have one (a new way of writing them the readers don't know yet, like 1.20 tenets' `desc = { … }`)
const changedTypes = new Map<string, Set<string>>();

for (let i = 0; i < idx.files.length; i++)
{
    const f = idx.files[i];

    if (f.source === 0 && f.type && idx.vfs.stat(f.gf).mtime >= since)
        changedTypes.set(f.type, new Set());
}

const texts: string[] = [];

for (const type of changedTypes.keys())
{
    const names = idx.names(type);

    if (names.length < 3)
        continue;

    const noName = names.filter((n) => !idx.displayName(idx.get(type, n)!));
    const noDesc = names.filter((n) => idx.descriptionKey(idx.get(type, n)!) === undefined);

    // (only where most of the type have one: types without names or descriptions in game are no finding)
    if (noName.length && noName.length < names.length / 2)
        texts.push(`${type}: ${noName.length}/${names.length} without a name: ${noName.slice(0, 5).join(', ')}`);

    if (noDesc.length && noDesc.length < names.length / 2)
        texts.push(`${type}: ${noDesc.length}/${names.length} without a description: ${noDesc.slice(0, 5).join(', ')}`);
}

const show = (title: string, m: Map<string, Tally>): void =>
{
    const rows = [...m].sort((a, b) => b[1].count - a[1].count);
    console.log(`\n== ${title}: ${rows.length}`);

    for (const [k, t] of rows.slice(0, TOP))
        console.log(`  ${String(t.count).padStart(5)}  ${k}\n         ${t.samples.join('\n         ')}`);
};

console.log(`${files} script files changed since ${new Date(since).toISOString().slice(0, 10)}`);
console.log(`\n== braces: ${braces.length}`);
braces.slice(0, TOP).forEach((b) => console.log('  ' + b));
show('unknown prefixes (not in PREFIX_TYPES)', unknownPrefix);
show('prefixed names that do not resolve', unresolvedPrefix);
show('values under linked keys that do not resolve', unresolvedKey);
show('values under linked keys found only as an entry of another type (the app links them)', otherTypeKey);
show('values under linked keys that are scope links and also name an entry of another type (taken as the scope)', linkValue);
// keys without a CONTEXT_RULES entry whose values mostly (over half, at least three uses) name entries of one or two context-only types: such an entry is linked by
// no name lookup, so the key needs a rule. (A key whose words are entries of many of them (`skill`, `group`, `reference`) only meets generic names, and a mixed
// key may stay unlisted on purpose: add its words only where the parent decides. `color1 → named_colors` and the coat of arms' `dynasty_house` are known gaps.)
const ctxGaps = new Map<string, Tally>();

for (const [key, t] of ctxUse)
    if (t.hit >= 3 && t.hit / t.all > 0.5 && t.types.size <= 2)
        ctxGaps.set(`${key} → ${[...t.types].join('|')}  (${t.hit} of ${t.all} values)`, { count: t.hit, samples: t.samples });

show('keys no CONTEXT_RULES entry links whose values are mostly entries of a context-only type', ctxGaps);
// scope types the game's own documentation names (`root ( Rite )`, `scope:actor (Character)`) that the catalog lacks
const docTypes = new Map<string, Tally>();
const ALIAS: Record<string, string> = { title: 'landed_title', landed_title: 'landed_title', landedtitle: 'landed_title', house: 'dynasty_house', dynasty_house: 'dynasty_house' };
const infos = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? infos(join(dir, f)) : f.endsWith('.info') ? [join(dir, f)] : []));

for (const file of infos(join(idx.gameDir, 'common')))
    for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:root|scope:\w+)\s*:?\s*\(\s*([A-Z][A-Za-z ]*?)\s*\)/g))
    {
        const t = m[1].toLowerCase().replace(/ /g, '_');
        const type = ALIAS[t] ?? t;

        if (!(SCOPE_ORDER as string[]).includes(type))
            tally(docTypes, type, file.slice(idx.gameDir.length + 1));
    }

show('scope types the game documents that the catalog lacks (scriptCatalog.ts ScopeType)', docTypes);
show('iterators the catalog lacks (ITERATORS)', iterUse);
show('links inside chains the readable view and catalog lack (LINKS, describer SCOPE_LINKS)', linkUse);
console.log(`
== names and descriptions missing where most of their type have one: ${texts.length}`);
texts.forEach((t) => console.log('  ' + t));
