// The input files for writing the script database's explanations (docs/script-database.md): per batch of entries,
// what is known about each — the game's own text, its scopes, and how vanilla uses it (the key scan's counts, values,
// block fields and examples; link and saved scope counts; an on_action's definition; a modifier's or function's loc
// names) — and the app's own label where it has one. Written to data/script-db/work/input/<kind>-<nnn>.json.
//
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000
//        scripts/script-db-explain-input.ts [version]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { ScriptKeyScanner } from '../src/main/describe/scriptKeys.ts';
import { ITERATORS, LINKS, SCOPE_LABELS, STATEMENTS } from '../src/shared/scriptCatalog.ts';
import type { ScriptKeyInfo } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'data', 'game-docs');
const version = process.argv[2] ?? readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory()).sort().at(-1)!;
const db = new DatabaseSync(join(root, 'data', 'script-db', `ck3-${version}.sqlite`), { readOnly: true });
const outDir = join(root, 'data', 'script-db', 'work', 'input');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const gameDir = resolveGameDir(defaultInstall());

if (!gameDir)
    throw new Error(`no game folder in ${defaultInstall()}`);

const files = new GameFiles(gameDir);
const t0 = performance.now();

// ---------------------------------------------------------------------------------------------------------------------
// vanilla's use
// ---------------------------------------------------------------------------------------------------------------------

const keys = new ScriptKeyScanner().scan(files);
const keyInfo = { effect: new Map(keys.effect.map((k) => [k.key, k])), trigger: new Map(keys.trigger.map((k) => [k.key, k])) };

/** a key scan entry cut to what a writer needs */
function usage(k: ScriptKeyInfo | undefined): object | undefined
{
    if (!k)
        return undefined;

    return {
        count: k.count,
        shapes: k.shapes,
        values: k.values.slice(0, 8),
        fields: k.fields?.slice(0, 12),
        fieldValues: k.fieldValues ? Object.fromEntries(Object.entries(k.fieldValues).slice(0, 8).map(([f, v]) => [f, v.slice(0, 5)])) : undefined,
        examples: k.examples?.slice(0, 3)
    };
}

// links, saved scopes and on_action definitions: one pass over the script folders
const linkUse = new Map<string, number>();
const savedUse = new Map<string, { n: number; at: string[]; }>();
const onActions = new Map<string, { file: string; text: string; }>();
const SCRIPT_DIRS = ['common', 'events'];

for (const dir of SCRIPT_DIRS)
{
    for (const f of files.list(dir, { ext: /\.txt$/i }))
    {
        const t = files.readText(f) ?? '';

        for (const m of t.matchAll(/scope:(\w+)/g))
        {
            const s = savedUse.get(m[1]) ?? { n: 0, at: [] };
            s.n++;

            if (s.at.length < 2 && !s.at.includes(f.rel))
                s.at.push(f.rel);

            savedUse.set(m[1], s);
        }

        // (a chain's links: `liege.primary_title`, `scope:x.faith`; a switch: `liege = {`)
        for (const m of t.matchAll(/[\w:]+(?:\.\w+)+|^\s*(\w+)\s*=\s*\{/gm))
        {
            const parts = m[1] ? [m[1]] : m[0].split('.').filter((p) => !p.includes(':'));

            for (const p of parts)
                linkUse.set(p, (linkUse.get(p) ?? 0) + 1);
        }

        if (f.rel.toLowerCase().startsWith('common/on_action/'))
        {
            // top-level blocks with the comment lines above them
            for (const m of t.matchAll(/((?:^#[^\n]*\n)*)^(\w+)\s*=\s*\{/gm))
            {
                let depth = 0;
                let end = m.index! + m[0].length - 1;

                for (; end < t.length; end++)
                {
                    if (t[end] === '{')
                        depth++;
                    else if (t[end] === '}' && --depth === 0)
                        break;
                }

                const block = t.slice(m.index!, end + 1).split('\n');
                const prev = onActions.get(m[2]);
                const text = (block.length > 80 ? [...block.slice(0, 80), '\t# …'] : block).join('\n');
                onActions.set(m[2], { file: f.rel, text: prev ? `${prev.text}\n# (also in ${f.rel})\n${text}` : text });
            }
        }
    }
}

// the english localization: modifier names (MOD_<KEY>), custom loc entries; data function uses in texts and GUI files
// (a function's count, and up to 3 lines using it: `Type.Name` written out first, else `.Name` after anything)
const loc = new Map<string, string>();
const fnUse = new Map<string, number>();
const fnSeen = new Map<string, string[]>();

// data functions followed through their chains by return type (`[GetPlayer.GetPrimaryTitle.GetName]`: the global
// GetPlayer gives a Character, Character.GetPrimaryTitle a Title, Title.GetName …; a GUI expression may start with a
// type, `[CharacterWindow.GetCharacter.GetName]`; arguments are chains of their own, `GetDataModelSize(X.GetList)`).
// The run's writers found uses through such chains, through global getters and `Var('…')` counted as none.
interface FnFacts { type: string; name: string; returnType: string; }
const fnFacts = new Map<string, FnFacts>();

for (const r of db.prepare("SELECT key, facts FROM entries WHERE kind = 'data_function'").all() as { key: string; facts: string; }[])
    fnFacts.set(r.key, JSON.parse(r.facts) as FnFacts);

const typeNames = new Set((db.prepare("SELECT key FROM entries WHERE kind = 'data_type'").all() as { key: string; }[]).map((r) => r.key));
/** key → up to 3 lines whose chains reach it; and how many uses in all */
const fnChained = new Map<string, string[]>();
const fnChainUses = new Map<string, number>();

/** the chains of one data expression (the text inside `[…]`, its `|format` cut off): each a list of step names */
function chainsOf(expr: string): string[][]
{
    const out: string[][] = [];
    let i = 0;

    const chain = (): void =>
    {
        const steps: string[] = [];

        for (;;)
        {
            const m = /^[A-Za-z_]\w*/.exec(expr.slice(i));

            if (!m)
                break;

            steps.push(m[0]);
            i += m[0].length;

            if (expr[i] === '(')
            {
                // (the arguments: quoted texts skipped, chains read on their own)
                i++;

                while (i < expr.length && expr[i] !== ')')
                {
                    if (expr[i] === '\'' || expr[i] === '"')
                    {
                        const q = expr[i++];

                        while (i < expr.length && expr[i] !== q)
                            i++;

                        i++;
                    }
                    else if (/[A-Za-z_]/.test(expr[i]) && !/\w/.test(expr[i - 1] ?? ''))
                        chain();
                    else
                        i++;
                }

                i++;
            }

            if (expr[i] !== '.')
                break;

            i++;
        }

        if (steps.length)
            out.push(steps);
    };

    while (i < expr.length)
    {
        if (/[A-Za-z_]/.test(expr[i]) && !/\w/.test(expr[i - 1] ?? ''))
            chain();
        else
            i++;
    }

    return out;
}

/** the data function keys a chain uses, step by step by return type (a step the facts do not know ends it) */
function resolveChain(steps: string[]): string[]
{
    const walk = (type: string | undefined, from: number): string[] =>
    {
        const used: string[] = [];

        for (let k = from; k < steps.length; k++)
        {
            const key = type ? `${type}.${steps[k]}` : steps[k];
            const f = fnFacts.get(key);

            if (!f)
                break;

            used.push(key);
            type = typeNames.has(f.returnType) ? f.returnType : undefined;

            if (!type)
                break;
        }

        return used;
    };

    // (a first step that names a type: the steps after it are that type's; else a global function or promote. A global
    // whose result has no type of the data system cannot go on: `[confidant.GetFirstName]` is a saved scope named like
    // the game concept `confidant`, not the concept; the redo run's writers found such lines counted as its uses)
    const asType = typeNames.has(steps[0]) ? walk(steps[0], 1) : [];

    if (asType.length)
        return asType;

    const first = fnFacts.get(steps[0]);
    return first && steps.length > 1 && !typeNames.has(first.returnType) ? [] : walk(undefined, 0);
}

/** the `[…]` expressions of a line with their positions (nested brackets kept inside; the `|format` cut off) */
function expressionsOf(line: string): [string, number][]
{
    const out: [string, number][] = [];

    for (let i = line.indexOf('['); i >= 0; i = line.indexOf('[', i + 1))
    {
        let depth = 0;
        let j = i;

        for (; j < line.length; j++)
        {
            if (line[j] === '[')
                depth++;
            else if (line[j] === ']' && --depth === 0)
                break;
        }

        const inner = line.slice(i + 1, j);
        let cut = inner.length;
        let paren = 0;

        for (let k = 0; k < inner.length; k++)
        {
            if (inner[k] === '(')
                paren++;
            else if (inner[k] === ')')
                paren--;
            else if (inner[k] === '|' && paren === 0)
            {
                cut = k;
                break;
            }
        }

        out.push([inner.slice(0, cut), i]);
        i = j;
    }

    return out;
}

/** a line cut around a position (the use itself, not the line's start) */
const excerpt = (line: string, at: number): string => (at > 70 ? '…' : '') + line.slice(Math.max(0, at - 70), at + 150).trim() + (at + 150 < line.length ? '…' : '');

function seeFunctions(text: string, rel: string): void
{
    for (const line of text.split('\n'))
    {
        if (!line.includes('[') && !/\b[A-Z]\w+\.[A-Z]\w+/.test(line))
            continue;

        // (a call's end: also `)` and `,` after the name, `And(Not(IsScreenshotBeingTaken))`; a writer of the run found
        // such uses counted as none)
        for (const m of line.matchAll(/(?:\b([A-Z]\w*)\.)?\b([A-Z]\w+)\b(?=\s*[(.\]|'"\s),])/g))
        {
            for (const k of m[1] ? [`${m[1]}.${m[2]}`, `.${m[2]}`] : [`.${m[2]}`])
            {
                const all = fnSeen.get(k) ?? [];

                if (all.length < 3)
                    all.push(`${rel}: ${excerpt(line, m.index!)}`);

                fnSeen.set(k, all);
            }

            fnUse.set(m[2], (fnUse.get(m[2]) ?? 0) + 1);
        }

        for (const [expr, at] of expressionsOf(line))
        {
            for (const steps of chainsOf(expr))
            {
                for (const key of new Set(resolveChain(steps)))
                {
                    const all = fnChained.get(key) ?? [];

                    if (all.length < 3)
                        all.push(`${rel}: ${excerpt(line, at)}`);

                    fnChained.set(key, all);
                    fnChainUses.set(key, (fnChainUses.get(key) ?? 0) + 1);
                }
            }
        }
    }
}

for (const f of files.list('localization/english', { ext: /\.yml$/i }))
{
    const t = files.readText(f) ?? '';

    for (const m of t.matchAll(/^\s*([\w.\-]+):\d*\s*"(.*)"\s*$/gm))
        loc.set(m[1], m[2]);

    seeFunctions(t, f.rel);
}

for (const f of files.list('gui', { ext: /\.gui$/i }))
    seeFunctions(files.readText(f) ?? '', f.rel);

// the engine's own folders next to game/ (jomini/gui, jomini/localization): GUI templates and texts of the engine
const installDir = dirname(gameDir);

function walkFiles(dir: string, ext: RegExp): string[]
{
    if (!existsSync(dir))
        return [];

    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkFiles(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []);
}

for (const p of [...walkFiles(join(installDir, 'jomini', 'gui'), /\.gui$/i), ...walkFiles(join(installDir, 'jomini', 'localization', 'english'), /\.yml$/i)])
    seeFunctions(readFileSync(p, 'utf8'), relative(installDir, p).split(sep).join('/'));

// the game's own notes (`.info` files beside the script folders): the scopes its code saves and when, the pulses
// (common/on_action/_on_actions.info) … ; the run read only .txt and found many saved scopes "documented nowhere"
const infoLines: string[][] = [];

for (const p of walkFiles(gameDir, /\.info$/i))
{
    const rel = relative(gameDir, p).split(sep).join('/');
    const lines = readFileSync(p, 'utf8').split('\n');
    infoLines.push(lines.map((l, i) => `${rel}:${i + 1}\u0000${l}`));
}

/** up to 6 notes naming the pattern: the line and the up to 3 lines above it (the heading it stands under) */
function infoNotes(re: RegExp): string[]
{
    const out: string[] = [];

    for (const lines of infoLines)
    {
        for (let i = 0; i < lines.length && out.length < 6; i++)
        {
            const [at, text] = lines[i].split('\u0000');

            if (!re.test(text))
                continue;

            const above = lines.slice(Math.max(0, i - 3), i).map((l) => l.split('\u0000')[1].trim()).filter(Boolean);
            out.push(`${at}: ${[...above, text.trim()].join(' / ').slice(0, 400)}`);
        }
    }

    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// entries and their batches
// ---------------------------------------------------------------------------------------------------------------------

interface Row { id: number; kind: string; key: string; variant: string; doc: string; facts: string; }
const scopesOf = db.prepare('SELECT role, scope FROM scopes WHERE entry = ?');
const rows = (kind: string, order = 'key'): Row[] => db.prepare(`SELECT id, kind, key, variant, doc, facts FROM entries WHERE kind = ? ORDER BY ${order}`).all(kind) as unknown as Row[];

function scopes(id: number): Record<string, string[]>
{
    const out: Record<string, string[]> = {};

    for (const r of scopesOf.all(id) as { role: string; scope: string; }[])
        (out[r.role] ??= []).push(r.scope);

    return out;
}

const appStmt = (kind: string, key: string): object[] =>
    STATEMENTS.filter((s) => s.kind === kind && new RegExp(`(^|[\\s{])${key}\\s*(=|<|>)`).test(s.script)).map((s) => ({ label: s.label, help: s.help, params: s.params.map((p) => p.label) }));

let written = 0;

function write(kind: string, items: object[], size: number): void
{
    for (let i = 0; i * size < items.length; i++)
    {
        writeFileSync(join(outDir, `${kind}-${String(i + 1).padStart(3, '0')}.json`), JSON.stringify(items.slice(i * size, (i + 1) * size), null, 1));
        written++;
    }
}

const base_ = (r: Row): Record<string, unknown> => ({ kind: r.kind, key: r.key, ...(r.variant ? { variant: r.variant } : {}), doc: r.doc, ...scopes(r.id), facts: JSON.parse(r.facts) });

for (const kind of ['effect', 'trigger'] as const)
    write(kind, rows(kind).map((r) => ({ ...base_(r), vanilla: usage(keyInfo[kind].get(r.key)), app: appStmt(kind, r.key) })), 40);

write('list', rows('list').map((r) =>
{
    const f = JSON.parse(r.facts) as { forms: Record<string, string>; };
    const it = ITERATORS.find((i) => i.list === r.key);
    return {
        ...base_(r),
        vanilla: Object.fromEntries(Object.keys(f.forms).map((form) => [`${form}_${r.key}`, usage(keyInfo[form === 'any' ? 'trigger' : 'effect'].get(`${form}_${r.key}`))])),
        ...(it ? { app: { label: it.label, params: it.params?.map((p) => `${p.key}: ${p.label}`) } } : {})
    };
}), 50);

write('link', rows('link').map((r) =>
{
    const app = LINKS.filter((l) => l.key === r.key).map((l) => l.label);
    return { ...base_(r), vanilla: { count: linkUse.get(r.key) ?? 0 }, ...(app.length ? { app } : {}) };
}), 50);

write('saved_scope', rows('saved_scope').map((r) =>
{
    const info = infoNotes(new RegExp(`scope:${r.key}(?!\\w)`));
    return { ...base_(r), vanilla: savedUse.get(r.key) ?? { n: 0, at: [] }, ...(info.length ? { info } : {}) };
}), 60);
write('scope_type', rows('scope_type').map((r) => ({ ...base_(r), app: (SCOPE_LABELS as Record<string, string>)[r.key] })), 80);
write('modifier', rows('modifier').map((r) => ({ ...base_(r), loc: loc.get(`MOD_${r.key.toUpperCase()}`), locDesc: loc.get(`MOD_${r.key.toUpperCase()}_DESC`) })), 80);
write('on_action', rows('on_action').map((r) =>
{
    const info = infoNotes(new RegExp(`(?<![\\w:])${r.key}(?!\\w)`));
    return { ...base_(r), vanilla: onActions.get(r.key), ...(info.length ? { info } : {}) };
}), 40);

write('custom_loc', rows('custom_loc').map((r) =>
{
    const f = JSON.parse(r.facts) as { entries: string[]; };
    return { ...base_(r), facts: { ...f, entries: f.entries.slice(0, 12), more: Math.max(0, f.entries.length - 12) }, entryTexts: f.entries.slice(0, 4).map((e) => [e, loc.get(e)]) };
}), 100);

write('data_type', rows('data_type').map((r) => ({ ...base_(r), functions: (db.prepare("SELECT count(*) n FROM entries WHERE kind = 'data_function' AND key LIKE ?").get(`${r.key}.%`) as { n: number; }).n })), 200);

// the game's concepts (common/game_concepts): each concept and alias is also a global data function, the one a text's
// `[retreat|E]` calls; its name and description texts say what it is (2,652 globals of 1.20.1.2, all left uncertain
// by the first run, which had no such evidence)
const concepts = new Map<string, { concept: string; name?: string; desc?: string; }>();

for (const f of files.list('common/game_concepts', { ext: /\.txt$/i }))
{
    const t = files.readText(f) ?? '';

    for (const m of t.matchAll(/^([A-Za-z_]\w*)\s*=\s*\{/gm))
    {
        const at = m.index! + m[0].length;
        const body = t.slice(at, at + 2000);
        const aliases = /alias\s*=\s*\{([^}]*)\}/.exec(body.slice(0, body.search(/^\}/m) >= 0 ? body.search(/^\}/m) : body.length))?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
        const desc = loc.get(`game_concept_${m[1]}_desc`);
        const info = { concept: m[1], name: loc.get(`game_concept_${m[1]}`), desc: desc && desc.slice(0, 500) };

        for (const k of [m[1], ...aliases])
            concepts.set(k, info);
    }
}

// data functions: by type, globals first; the batch keeps a type's functions together where it can
const fns = rows('data_function', "CASE WHEN key LIKE '%.%' THEN 1 ELSE 0 END, key").map((r) =>
{
    const f = JSON.parse(r.facts) as { type: string; name: string; };
    // (lines naming `Type.Name` itself are evidence for this function; lines with `.Name` after anything else are the
    // same name, which other types may have too: kept apart, and the count is the name's, of every type)
    // (and the lines whose chains reach it by return type: `chainUses` counts them; a global's own key is its name)
    const chained = fnChained.get(r.key) ?? [];
    const literal = f.type ? fnSeen.get(`${f.type}.${f.name}`) ?? [] : [];
    const own = [...new Set([...chained, ...literal])].slice(0, 3);
    const other = !own.length ? fnSeen.get(`.${f.name}`) ?? [] : [];
    const concept = !f.type ? concepts.get(f.name) : undefined;
    return { ...base_(r), vanilla: { linesWithThisFunction: own, chainUses: fnChainUses.get(r.key) ?? 0, linesWithSameNameAnyType: other, usesOfNameAnyType: fnUse.get(f.name) ?? 0 }, ...(concept ? { gameConcept: concept } : {}) };
});
write('data_function', fns, 150);

console.log(`${written} input files in ${outDir} (${Math.round(performance.now() - t0)} ms)`);
