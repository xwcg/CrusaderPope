// Editing in place, type by type: does a mod's entry offer the picker where it should? (The gaps found by hand: a
// religion's virtues and a tenet's icon opened the code editor; an icon showed as its name, not the picture.)
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=8000 scripts/edit-coverage-check.ts [--update | --report] [type …]
//
// A TEMP user folder with a temp mod: up to SAMPLE (2) entries of every type are copied into it (the "Override" copy,
// mods/edit.ts), the index is built with the mod once, and each copy's card is read the way the editor reads it
// (renderer InPlaceEdit `opsOf`): a line of the mod's that is not `other` and whose statement the picker reads back
// (`canPickEdit`) is changed with the picker, any other one opens the code editor.
// Lines opening the code editor are kinds "<type> [<kind>:]<key>", each with the definition's top-level block it is in
// (`is_shown`, `cost`, `on_accept` …). They are grouped, as that is what tells a fix: per cause (conditions, effects,
// formulas, texts, looks, by the block and the key), per block shared by several types, per key shared by several
// types (one fix in shared code covers all of them). The kinds in scripts/edit-coverage-baseline.json (accepted:
// script blocks, constructs without a field set yet, each with its block and an example) pass, a new one fails;
// `--update` writes the baseline from this run, `--report` groups the baseline without building anything (seconds).
// The vanilla index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew); the index with
// the mod is a fresh build on parse threads.
// Also failing: a card's icon shown as its name in a line (not the picture), a field set's suggestion source that
// comes back empty. The real user folder is never used. TOP=n rows per group (12).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntityCard, Line, LineSource, ModInfo, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { applyOverride } from '../src/main/mods/edit.ts';
import { modsState, type ModsHost } from '../src/main/mods/manager.ts';
import { statementText } from '../src/main/mods/scriptEdit.ts';
import { canPickEdit } from '../src/renderer/src/picker/model.ts';
import { FIELDS } from '../src/shared/fieldCatalog.ts';
import { defaultInstall } from './ck3-install.ts';
import { buildIndex, fastIndex } from './fast-index.ts';

const SAMPLE = Number(process.env.SAMPLE ?? 2);
const TOP = Number(process.env.TOP ?? 12);
// (no card of their own to edit, or read elsewhere: events and on_actions by script-edit-check, characters by history)
const SKIP = new Set(['localization', 'flag', 'variable', 'images', 'models', 'characters', 'events', 'on_action', 'genes', 'dna_data', 'bookmark_portraits', 'coat_of_arms/coat_of_arms']);
const BASELINE = join(import.meta.dirname, 'edit-coverage-baseline.json');
const args = process.argv.slice(2);
const update = args.includes('--update');
const only = args.filter((a) => !a.startsWith('--'));

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** A kind of line opening the code editor: its type, statement kind and key, the top-level block it is in. */
interface Gap
{
    id: string;
    type: string;
    kind: string;
    key: string;
    block: string;
}

const gapOf = (id: string, block: string): Gap =>
{
    const sp = id.indexOf(' ');
    const rest = id.slice(sp + 1);
    const m = /^(effect|trigger|modifier|field):(.*)$/.exec(rest);
    return { id, type: id.slice(0, sp), kind: m ? m[1] : 'other', key: m ? m[2] : rest, block };
};
const keyLabel = (g: Gap): string => `${g.kind === 'other' ? '' : g.kind + ':'}${g.key}`;

// (blocks the game documents as conditions, effects, values, by their names; `<block>` is the line itself)
const CONDITION_BLOCK = /^(is_shown|is_valid|is_valid_showing_failures_only|can_\w+|potential|allow|trigger|is_\w+_valid|valid\w*|limit|\w+_trigger|visible|is_available|requirements?|prerequisites?|unlock\w*|can_be_\w+|is_shown_\w+|eligible\w*|filter|candidate\w*|is_enabled)$/;
const EFFECT_BLOCK = /^(on_\w+|effect|immediate|after|\w+_effect|on_accept|on_decline|on_send|on_auto_accept|on_start|on_end|on_complete|on_invalidated|on_action|events|option)$/;
const VALUE_BLOCK = /^(cost|ai_will_do|ai_\w+|weight|\w+_weight|\w+_chance|chance|score|\w+_score|\w+_value|value|duration|\w+_cost|base|progress\w*|\w+_mult|\w+_add|monthly_\w+|\w+_modifier|modifier)$/;

/**
 * Why a kind of line opens the code editor: the shared causes (one fix covers every type): conditions / effects /
 * formulas of a block not read as such (by the block, else the key), texts and looks without a field set, plain script
 * blocks; the rest type by type.
 */
const TEXT = /^(desc|triggered_desc|first_valid|random_valid|text|custom_tooltip|custom_description|name|title|tooltip|loc|\w+_desc|\w+_name|\w+_tooltip|\w+_title)$/;
const LOOK = /^(icon|background|color|illustration|picture|texture|sound|portrait|animation|asset|\w+_icon|\w+_background|\w+_illustration|\w+_texture|\w+_asset)$/;
const CAUSES: { id: string; label: string; test: (g: Gap) => boolean; }[] = [
    // (by the block the line is in (the line itself when it is a top-level statement), then by its own key)
    { id: 'formulas', label: 'Formulas and weights', test: (g) => VALUE_BLOCK.test(g.block) },
    { id: 'conditions', label: 'Conditions', test: (g) => CONDITION_BLOCK.test(g.block) },
    { id: 'effects', label: 'Effects', test: (g) => EFFECT_BLOCK.test(g.block) },
    { id: 'texts', label: 'Texts', test: (g) => TEXT.test(g.block) || TEXT.test(g.key) },
    { id: 'looks', label: 'Pictures and looks', test: (g) => LOOK.test(g.block) || LOOK.test(g.key) },
    { id: 'conditions', label: 'Conditions', test: (g) => g.kind === 'trigger' },
    { id: 'effects', label: 'Effects', test: (g) => g.kind === 'effect' },
    { id: 'formulas', label: 'Formulas and weights', test: (g) => /^(value|add|subtract|multiply|divide|min|max|modifier|opinion_modifier|compare_modifier|base|factor|round|fixed_range|integer_range|ai_value_modifier|weight)$/.test(g.key) || (g.kind === 'field' && /^(if|else_if|else)$/.test(g.key)) },
    { id: 'blocks', label: 'Script blocks (if, scopes …)', test: (g) => /^(if|else_if|else|switch|random_list|random|hidden_effect|NOT|OR|AND|NOR|limit|trigger)$/.test(g.key) || /[:.]/.test(g.key) },
    { id: 'rest', label: 'Other (type by type)', test: () => true }
];
const causeOf = (g: Gap): (typeof CAUSES)[number] => CAUSES.find((c) => c.test(g))!;
/** One row per cause (the same cause tested at two places counts once). */
const CAUSE_LIST = CAUSES.filter((c, i) => CAUSES.findIndex((x) => x.id === c.id) === i);

/** Rows `name ×types` of a map name → types, most types first. */
function shared(by: Map<string, Set<string>>, min: number): [string, Set<string>][]
{
    return [...by].filter(([, t]) => t.size >= min).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
}

function add(by: Map<string, Set<string>>, k: string, type: string): void
{
    (by.get(k) ?? by.set(k, new Set()).get(k)!).add(type);
}

/**
 * The code-editor kinds grouped: per cause (kinds, types, its blocks and keys most types share); the blocks shared by
 * three or more types; the keys shared by three or more types: what one fix covers.
 */
function groupReport(gaps: Gap[]): void
{
    const byKey = new Map<string, Set<string>>();
    const byBlock = new Map<string, Set<string>>();

    for (const g of gaps)
    {
        add(byKey, keyLabel(g), g.type);
        add(byBlock, g.block, g.type);
    }

    // (within a cause: in how many of its types each block / key is)
    const list = (rows: [string, string][], n: number): string =>
    {
        const by = new Map<string, Set<string>>();

        for (const [k, type] of rows)
            add(by, k, type);

        return shared(by, 1)
            .slice(0, n)
            .map(([k, t]) => `${k} ×${t.size}`)
            .join(', ');
    };

    console.log('\nby cause: kinds · types · in the blocks / with the keys most types share:');

    for (const c of CAUSE_LIST)
    {
        const mine = gaps.filter((g) => causeOf(g).id === c.id);

        if (!mine.length)
            continue;

        const types = new Set(mine.map((g) => g.type));
        console.log(`  ${c.label.padEnd(28)} ${String(mine.length).padStart(5)} · ${String(types.size).padStart(3)} types`);
        console.log(`      blocks: ${list(mine.map((g) => [g.block, g.type]), 6)}`);
        console.log(`      keys:   ${list(mine.map((g) => [keyLabel(g), g.type]), 6)}`);
    }

    for (const [what, by] of [['blocks', byBlock], ['keys', byKey]] as const)
    {
        const rows = shared(by, 3);
        const covered = gaps.filter((g) => (by.get(what === 'blocks' ? g.block : keyLabel(g))?.size ?? 0) >= 3).length;
        console.log(`\n${what} shared by 3+ types: ${rows.length}, holding ${covered} of ${gaps.length} kinds (one fix each covers its types):`);

        for (const [k, t] of rows.slice(0, TOP))
            console.log(`  ${String(t.size).padStart(4)} ${k.padEnd(30)} ${[...t].slice(0, 5).join(', ')}${t.size > 5 ? ' …' : ''}`);
    }
}

/** The baseline: kind → "<block> | <example>". */
const readBaseline = (): Record<string, string> => (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {});
const blockOfEntry = (v: string): string => (v.includes(' | ') ? v.slice(0, v.indexOf(' | ')) : '?');

// (`--report`: the baseline grouped, without building anything)
if (args.includes('--report'))
{
    const gaps = Object.entries(readBaseline())
        .map(([id, v]) => gapOf(id, blockOfEntry(v)))
        .filter((g) => !only.length || only.includes(g.type));
    console.log(`baseline: ${gaps.length} kinds of lines opening the code editor`);
    groupReport(gaps);
    process.exit(0);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const tmp = mkdtempSync(join(tmpdir(), 'ckp-editcov-'));
const root = join(tmp, 'mod', 'cov_test');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Coverage Test"\nsupported_version="1.20.*"\n');
writeFileSync(join(tmp, 'mod', 'cov_test.mod'), `version="1.0"\nname="Coverage Test"\nsupported_version="1.20.*"\npath="${root.replace(/\\/g, '/')}"\n`);

console.log('building the vanilla index …');
const vanilla = await fastIndex(new GameFiles(gameDir), { cache: true });
const settings: Settings = { gameDir: install, language: 'english', userDir: tmp, activeMod: 'mod/cov_test.mod' };
let idx: GameIndex = vanilla;
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    gameDir: () => gameDir,
    documents: () => join(tmp, 'no-documents'),
    reindex: () => undefined,
    query: async <T>(method: string, ...params: unknown[]): Promise<T> => (idx as unknown as Record<string, (...a: unknown[]) => T>)[method](...params),
    wrote: () => undefined,
    refreshFiles: async () => undefined,
    dataDir: () => join(tmp, 'data')
};

const flat = (lines: Line[] | undefined, out: Line[] = []): Line[] =>
{
    for (const l of lines ?? [])
    {
        out.push(l);
        flat(l.children, out);
        flat(l.conditions, out);
    }

    return out;
};
const keyOf = (text: string): string => /^\s*([\w.:@$-]+)/.exec(text)?.[1] ?? '?';

/** The top-level block of its definition a statement is in (`is_shown`, `cost` …; its own key when it is one). */
const parsed = new Map<string, PNode[]>();
function blockOf(src: LineSource): string
{
    let ast = parsed.get(src.file);

    if (!ast)
    {
        ast = parse(readFileSync(src.file, 'utf8').replace(/^﻿/, ''));
        parsed.set(src.file, ast);
    }

    const def = ast.find((n) => n.s <= src.s && src.e <= n.e && Array.isArray(n.v));
    const top = def && (def.v as PNode[]).find((n) => n.s <= src.s && src.e <= n.e);
    return top?.k ?? '?';
}

let failures = 0;

try
{
    // copies of a few entries of every type (definitions the copy can take: a block of their own)
    const copied: [string, string][] = [];

    for (const t of vanilla.types())
    {
        if (only.length ? !only.includes(t.id) : SKIP.has(t.id))
            continue;

        let n = 0;

        for (const name of vanilla.names(t.id))
        {
            if (n >= SAMPLE)
                break;

            const d = vanilla.defNode(vanilla.get(t.id, name)!);

            if (!d || !Array.isArray(d.node.v) || !vanilla.overrideSource(t.id, name, settings.activeMod))
                continue;

            try
            {
                await applyOverride(host, { type: t.id, name, mode: 'copy' });
                copied.push([t.id, name]);
                n++;
            }
            catch
            {
                // (a type the copy can't take: not editable in place anyway)
                break;
            }
        }
    }

    const mod: ModInfo = (await modsState(host)).mods.find((m) => m.id === settings.activeMod)!;
    console.log(`copied ${copied.length} entries of ${new Set(copied.map(([t]) => t)).size} types; building the index with the mod …`);
    idx = await buildIndex(new GameIndex(new GameFiles(gameDir, [mod]), 'english'));
    const sb = new StoryBuilder(idx);
    // (every caller of a scripted effect / trigger read: the cards do not depend on the machine's load)
    sb.callerBudget = Infinity;

    // what the editor does with each of the mod's lines
    const script = new Map<string, { n: number; block: string; example: string; }>();
    const images: string[] = [];
    let picker = 0;

    for (const [type, name] of copied)
    {
        const e = idx.get(type, name);

        if (!e)
            continue;

        let card: EntityCard;

        try
        {
            card = sb.card(e);
        }
        catch (err)
        {
            console.log(`FAIL card ${type}:${name}: ${(err as Error).message}`);
            failures++;
            continue;
        }

        const lines = card.sections.flatMap((s) => flat(s.lines));

        for (const l of lines)
        {
            const src = l.src;

            if (!src || src.mod !== mod.id || src.owner)
                continue;

            const t = await statementText(host, src);

            if (t.problem)
                continue;

            if (src.kind !== 'other' && canPickEdit(src.kind as 'effect' | 'trigger' | 'modifier' | 'field', t.text, src.fields))
            {
                picker++;
                continue;
            }

            // (a bare name in a block: 1.20 writes a doctrine's and a tenet's `parameters = { tenet_dulia_cheaper_saint_costs … }` so: one kind per type AND block, not one per name, or every new parameter
            // fails the check; a bare-name list in another block of the type is a kind of its own. The gap behind these kinds: the picker cannot change a bare name that is already there)
            const blockName = blockOf(src);
            const bare = src.kind === 'field' && /^\s*[\w.:@-]+\s*$/.test(t.text);
            const key = bare ? `<bare name in ${blockName}>` : keyOf(t.text);
            const id = `${type} ${src.kind === 'other' ? '' : src.kind + ':'}${key}`;
            const was = script.get(id);
            const block = was?.block ?? blockName;
            script.set(id, { n: (was?.n ?? 0) + 1, block, example: was?.example ?? `${name}: ${t.text.split('\n')[0].slice(0, 80)}` });
        }

        // (the card's own icon named in a line as text, where the picture could show)
        const icon = card.icon?.split('/')
            .pop()
            ?.replace(/\.\w+$/, '');

        if (icon && lines.some((l) => l.text.some((s) => typeof s !== 'string' && s.kind === 'code' && s.text === icon)))
            images.push(`${type}:${name} (${icon})`);
    }

    // the field sets' suggestion sources: each gives values (the dynamic `values:` / `keys:` ones may be empty)
    const empty: string[] = [];

    for (const [set, defs] of Object.entries(FIELDS))
        for (const f of defs)
            if (f.suggest && !/^(values|keys):/.test(f.suggest) && !sb.fieldSuggestions(f.suggest).length)
                empty.push(`${set}.${f.key} (${f.suggest})`);

    // compare with the baseline; the whole run grouped
    const baseline = readBaseline();
    const fresh = [...script].filter(([id]) => !(id in baseline)).sort(([a], [b]) => a.localeCompare(b));
    const gone = Object.keys(baseline).filter((id) => !script.has(id) && (!only.length || only.includes(id.split(' ')[0])));
    const gaps = [...script].map(([id, x]) => gapOf(id, x.block));

    console.log(`\n${picker} lines change with the picker, ${[...script.values()].reduce((s, x) => s + x.n, 0)} open the code editor (${script.size} kinds, ${script.size - fresh.length} accepted in the baseline)`);
    groupReport(gaps);
    console.log('');

    // (new ones grouped as well: by cause, then type)
    for (const [id, x] of fresh.sort(([a], [b]) => causeOf(gapOf(a, script.get(a)!.block)).label.localeCompare(causeOf(gapOf(b, script.get(b)!.block)).label) || a.localeCompare(b)))
        console.log(`${update ? 'new ' : 'FAIL'} code editor [${causeOf(gapOf(id, x.block)).label} · in ${x.block}]: ${id} ×${x.n}, e.g. ${x.example}`);

    for (const id of gone)
        console.log(`note fixed (no longer opens the code editor): ${id}`);

    for (const i of images)
        console.log(`FAIL icon shown as its name, not the picture: ${i}`);

    for (const s of empty)
        console.log(`FAIL suggestions empty: ${s}`);

    failures += images.length + empty.length + (update ? 0 : fresh.length);

    if (update)
    {
        const next = Object.fromEntries([...script].sort(([a], [b]) => a.localeCompare(b)).map(([id, x]) => [id, `${x.block} | ${x.example}`]));
        writeFileSync(BASELINE, JSON.stringify(next, null, 4) + '\n');
        console.log(`baseline written: ${script.size} accepted kinds (${BASELINE})`);
    }
}
finally
{
    rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} problems` : '\nall ok');
process.exitCode = failures ? 1 : 0;
