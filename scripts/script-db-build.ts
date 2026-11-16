// Builds the script database (docs/script-database.md): the game's own docs (data/game-docs/<version>/, written by the
// console commands `script_docs` and `dump_data_types`) and our explanations (data/script-db/explanations/**.json) into
// one SQLite file, data/script-db/ck3-<version>.sqlite. Runs under Electron's own Node (its SQLite has FTS5; the dev
// Node's has not): `node scripts/script-db-build.mjs [version]`, which starts this file so.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsBase = join(root, 'data', 'game-docs');
const version = process.argv[2] ?? readdirSync(docsBase).filter((d) => statSync(join(docsBase, d)).isDirectory()).sort().at(-1);

if (!version)
    throw new Error('no game docs in data/game-docs');

const docs = join(docsBase, version);
const outDir = join(root, 'data', 'script-db');
const out = join(outDir, `ck3-${version}.sqlite`);

/** A doc file as text: UTF-8, or Windows-1252 when it is not valid UTF-8 (effects.log of 1.20.1.2 has one such byte) */
function text(file: string): string
{
    const bytes = readFileSync(file);

    try
    {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r/g, '');
    }
    catch
    {
        return new TextDecoder('windows-1252').decode(bytes).replace(/\r/g, '');
    }
}

const blocks = (t: string, sep: RegExp): string[] => t.split(sep).map((x) => x.trim()).filter(Boolean);
const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none');
const nameOf = (e: string): string | undefined => /^([\w:.$]+)(?: - |\s*$|\n)/.exec(e)?.[1];

// ---------------------------------------------------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
rmSync(out, { force: true });
const db = new DatabaseSync(out);
db.exec(`
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- one row per documented thing; kind: effect | trigger | list | link | scope_type | modifier | on_action | custom_loc |
-- data_type | data_function. key: the script key (a list without every_/any_, a function as Type.Name, a global one
-- as Name). variant: '' or, for a name the game documents twice, 'data' (a link that takes data: a prefix or a typed
-- link) or a number.
CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    doc TEXT NOT NULL DEFAULT '',
    facts TEXT NOT NULL DEFAULT '{}',
    UNIQUE (kind, key, variant)
);
-- the scope types an entry works with; role: scope (where it runs) | target (what it takes or iterates) |
-- input / output (a link) | area (a modifier's use area) | root (an on_action's expected scope)
CREATE TABLE scopes (entry INTEGER NOT NULL REFERENCES entries(id), role TEXT NOT NULL, scope TEXT NOT NULL);
CREATE INDEX scopes_entry ON scopes (entry);
CREATE INDEX scopes_scope ON scopes (scope, role);
-- our plain-language explanations (data/script-db/explanations)
CREATE TABLE explanations (
    entry INTEGER PRIMARY KEY REFERENCES entries(id),
    label TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    -- 1: the explanation rests on little (no doc, an inference from the name and vanilla's use)
    uncertain INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE search USING fts5 (kind UNINDEXED, entry UNINDEXED, key, label, body);
`);

const insert = db.prepare('INSERT INTO entries (kind, key, variant, doc, facts) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, key, variant) DO UPDATE SET doc = excluded.doc, facts = excluded.facts RETURNING id');
const scope = db.prepare('INSERT INTO scopes (entry, role, scope) VALUES (?, ?, ?)');
const counts: Record<string, number> = {};

function add(kind: string, key: string, doc: string, facts: object, scopes: [string, string[]][] = [], variant = ''): number
{
    const id = Number((insert.get(kind, key, variant, doc, JSON.stringify(facts)) as { id: number; }).id);

    for (const [role, all] of scopes)
        for (const s of all)
            scope.run(id, role, s);

    return id;
}

db.exec('BEGIN');

// ---------------------------------------------------------------------------------------------------------------------
// effects, triggers and lists (effects.log, triggers.log)
// ---------------------------------------------------------------------------------------------------------------------

interface Stmt { key: string; doc: string; scopes: string[]; targets: string[]; traits?: string; }

function statements(file: string): Stmt[]
{
    const outList: Stmt[] = [];

    for (const e of blocks(text(join(docs, 'script_docs', file)), /\n-{20}\n/))
    {
        const key = nameOf(e);

        if (!key || /^\w[\w ]* Documentation:$/.test(e))
            continue;

        outList.push({
            key,
            doc: e.split('\n').filter((l) => !/^Supported (Scopes|Targets): /.test(l)).join('\n'),
            scopes: list(/^Supported Scopes: (.*)$/m.exec(e)?.[1]),
            targets: list(/^Supported Targets: (.*)$/m.exec(e)?.[1]),
            traits: /^Traits: (.*)$/m.exec(e)?.[1]?.trim()
        });
    }

    return outList;
}

const lists = new Map<string, { forms: Record<string, string>; scopes: Set<string>; targets: Set<string>; }>();

for (const [kind, file] of [['effect', 'effects.log'], ['trigger', 'triggers.log']] as const)
{
    for (const s of statements(file))
    {
        const it = /^(every|random|ordered|any)_(\w+)$/.exec(s.key);

        // (a list: one entry for its every_ / random_ / ordered_ / any_ forms; `any_` only as a trigger, the rest as effects)
        if (it && (kind === 'trigger') === (it[1] === 'any'))
        {
            const l = lists.get(it[2]) ?? { forms: {}, scopes: new Set<string>(), targets: new Set<string>() };
            l.forms[it[1]] = s.doc;
            s.scopes.forEach((x) => l.scopes.add(x));
            s.targets.forEach((x) => l.targets.add(x));
            lists.set(it[2], l);
            continue;
        }

        add(kind, s.key, s.doc, s.traits ? { traits: s.traits } : {}, [['scope', s.scopes], ['target', s.targets]]);
    }
}

for (const [name, l] of [...lists].sort())
{
    const first = l.forms.every ?? l.forms.any ?? Object.values(l.forms)[0];
    add('list', name, first, { forms: l.forms }, [['scope', [...l.scopes]], ['target', [...l.targets]]]);
}

// ---------------------------------------------------------------------------------------------------------------------
// links (event_targets.log)
// ---------------------------------------------------------------------------------------------------------------------

const seenLink = new Map<string, number>();

for (const e of blocks(text(join(docs, 'script_docs', 'event_targets.log')), /\n-{20}\n/))
{
    // (the file ends with the names the game's code saves as scopes: `scope:actor`, `scope:recipient` …)
    const saved = /^Event Targets Saved from Code:\n([\s\S]*)$/.exec(e);

    if (saved)
    {
        for (const name of new Set(saved[1].split('\n').map((x) => x.trim()).filter((x) => /^\w+$/.test(x))))
            add('saved_scope', name, '', {});

        continue;
    }

    const key = nameOf(e);

    if (!key || /^Event Target Documentation:$/.test(e))
        continue;

    const data = /^Requires Data: yes$/m.test(e);
    // (counted apart for links and data links: the plain link of a name is always variant '', its data form 'data')
    const seen = `${data ? 'data' : ''}:${key}`;
    const n = seenLink.get(seen) ?? 0;
    seenLink.set(seen, n + 1);
    const variant = (data ? 'data' : '') + (n ? String(n) : '');
    add('link', key, e, { requiresData: data, global: /^Global Link: yes$/m.test(e), wildCard: /^Wild Card: yes$/m.test(e) }, [
        ['input', list(/^Input Scopes: (.*)$/m.exec(e)?.[1])],
        ['output', list(/^Output Scopes: (.*)$/m.exec(e)?.[1])]
    ], variant);
}

// ---------------------------------------------------------------------------------------------------------------------
// scope types (event_scopes.log)
// ---------------------------------------------------------------------------------------------------------------------

for (const m of text(join(docs, 'script_docs', 'event_scopes.log')).matchAll(/^(\w+):\n((?:[A-Z][^\n]*\n?)+)/gm))
{
    const yes = (label: string): boolean => new RegExp(`^${label}: yes$`, 'm').test(m[2]);
    add('scope_type', m[1], m[0].trim(), {
        evaluateTriggers: yes('Evaluate Triggers'),
        executeEffects: yes('Execute Effects'),
        changeScopes: yes('Change Scopes'),
        saveToken: /^Save Token: (\w+)$/m.exec(m[2])?.[1] ?? '',
        storesVariables: yes('Stores Variables')
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// modifiers (modifiers.log): "Tag: x" and "Use areas: character, province, and county"
// ---------------------------------------------------------------------------------------------------------------------

// (a tag can have an "Extra info:" line before its areas: prowess_no_portrait)
for (const m of text(join(docs, 'script_docs', 'modifiers.log')).matchAll(/^Tag: (\S+)\n((?:Extra info: .*\n)*)Use areas: (.*)$/gm))
{
    const areas = m[3].replace(/\band\b/g, ',').split(',').map((x) => x.trim()).filter(Boolean);
    const templates = [...m[1].matchAll(/\$(\w+)\$/g)].map((x) => x[1]);
    const extra = m[2].split('\n').map((x) => x.replace(/^Extra info: /, '').trim()).filter(Boolean).join(' ');
    add('modifier', m[1], m[0], { ...(templates.length ? { templates } : {}), ...(extra ? { extra } : {}) }, [['area', areas]]);
}

// ---------------------------------------------------------------------------------------------------------------------
// on_actions (on_actions.log)
// ---------------------------------------------------------------------------------------------------------------------

for (const m of text(join(docs, 'script_docs', 'on_actions.log')).matchAll(/^(\w+):\nFrom Code: (Yes|No)\nExpected Scope: (\w+)$/gm))
    add('on_action', m[1], m[0], { fromCode: m[2] === 'Yes' }, [['root', list(m[3])]]);

// ---------------------------------------------------------------------------------------------------------------------
// custom localization (custom_localization.log)
// ---------------------------------------------------------------------------------------------------------------------

for (const e of blocks(text(join(docs, 'script_docs', 'custom_localization.log')), /\n-{20}\n/))
{
    const m = /^(\w+):\n\nScope: (\w+)\nRandom Valid: (yes|no)(?:\n\nEntries:\n([\s\S]*))?$/.exec(e);

    if (!m)
        continue;

    add('custom_loc', m[1], e, { randomValid: m[3] === 'yes', entries: (m[4] ?? '').split('\n').map((x) => x.trim()).filter(Boolean) }, [['scope', list(m[2] === 'all' ? '' : m[2])]]);
}

// ---------------------------------------------------------------------------------------------------------------------
// data types and functions (data_types/*.txt)
// ---------------------------------------------------------------------------------------------------------------------

for (const file of readdirSync(join(docs, 'data_types')).filter((f) => f.endsWith('.txt')).sort())
{
    const category = basename(file, '.txt').replace(/^data_types_/, '');

    for (const e of blocks(text(join(docs, 'data_types', file)), /\n-{10,}\n/))
    {
        const head = e.split('\n')[0].trim();
        const def = /^Definition type: (.*)$/m.exec(e)?.[1]?.trim() ?? '';
        const description = /^Description: (.*)$/m.exec(e)?.[1]?.trim();
        const returns = /^Return type: (.*)$/m.exec(e)?.[1]?.trim();

        if (def === 'Type')
        {
            add('data_type', head, e, { category });
            continue;
        }

        const m = /^(?:(\w+)\.)?(\w+)(?:\(\s*([^)]*)\))?$/.exec(head);

        if (!m)
            continue;

        const args = m[3] ? m[3].split(',').map((x) => x.trim()).filter(Boolean).length : 0;
        add('data_function', m[1] ? `${m[1]}.${m[2]}` : m[2], e, { type: m[1] ?? '', name: m[2], args, definitionType: def, returnType: returns, description, category });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// our explanations (data/script-db/explanations/**/*.json: [{ kind, key, variant?, label, summary, details, fields, sources }])
// ---------------------------------------------------------------------------------------------------------------------

const explDir = join(outDir, 'explanations');
const findEntry = db.prepare('SELECT id FROM entries WHERE kind = ? AND key = ? AND variant = ?');
const explain = db.prepare('INSERT OR REPLACE INTO explanations (entry, label, summary, details, fields, sources, uncertain) VALUES (?, ?, ?, ?, ?, ?, ?)');
const missing: string[] = [];
let explained = 0;

function* jsonFiles(dir: string): Generator<string>
{
    if (!existsSync(dir))
        return;

    for (const f of readdirSync(dir, { withFileTypes: true }))
    {
        if (f.isDirectory())
            yield* jsonFiles(join(dir, f.name));
        else if (f.name.endsWith('.json'))
            yield join(dir, f.name);
    }
}

for (const file of jsonFiles(explDir))
{
    for (const x of JSON.parse(readFileSync(file, 'utf8')) as { kind: string; key: string; variant?: string; label?: string; summary?: string; details?: string; fields?: unknown[]; sources?: unknown[]; uncertain?: boolean; }[])
    {
        const row = findEntry.get(x.kind, x.key, x.variant ?? '') as { id: number; } | undefined;

        if (!row)
        {
            missing.push(`${file}: ${x.kind} ${x.key}`);
            continue;
        }

        explain.run(row.id, x.label ?? '', x.summary ?? '', x.details ?? '', JSON.stringify(x.fields ?? []), JSON.stringify(x.sources ?? []), x.uncertain ? 1 : 0);
        explained++;
    }
}

// the search index: key, label and summary / the game's description
db.exec(`INSERT INTO search (kind, entry, key, label, body)
    SELECT e.kind, e.id, e.key, coalesce(x.label, ''), coalesce(nullif(x.summary, ''), e.doc) FROM entries e LEFT JOIN explanations x ON x.entry = e.id`);

const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
meta.run('game_version', version);
// (schema: what an app can read; built: of two databases for one game version the newer wins, bundled or downloaded)
meta.run('schema', '1');
meta.run('built', new Date().toISOString());
// (counted from the table: a data type or function the game documents in two files is one row)
for (const r of db.prepare('SELECT kind, count(*) AS n FROM entries GROUP BY kind').all() as { kind: string; n: number; }[])
    counts[r.kind] = Number(r.n);

meta.run('counts', JSON.stringify(counts));
meta.run('explained', String(explained));
db.exec('COMMIT');
db.exec('VACUUM');
db.close();

console.log(`${out}: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}; explained ${explained}${missing.length ? `; ${missing.length} explanations without an entry:\n  ${missing.slice(0, 20).join('\n  ')}` : ''}`);
