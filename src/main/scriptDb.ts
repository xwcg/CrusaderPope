/**
 * The script database (docs/script-database.md): the game's own documentation of its script (effects, triggers,
 * lists, links, saved scopes, scope types, modifiers, on_actions, custom localization, data types and functions) with
 * our plain-language explanations, one SQLite file per game version, built by scripts/script-db-build.ts and shipped
 * with the app (packaged: <resources>/script-db/; development: data/script-db/). Read-only, synchronous (node:sqlite's
 * DatabaseSync: Electron 44's Node has it; the dev Node 22 needs --experimental-sqlite), usable in the main process,
 * its workers and the scripts.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DbEntry, DbKind, DbRole, ScriptFacts } from '../shared/scriptFacts.ts';

export type { DbEntry, DbExplanation, DbKind, DbRole } from '../shared/scriptFacts.ts';

type Stmt = { all(...p: unknown[]): Record<string, unknown>[]; get(...p: unknown[]): Record<string, unknown> | undefined; };
type Db = { prepare(sql: string): Stmt; close(): void; };

/** `1.20.1.2` → [1, 20, 1, 2] */
const parts = (v: string): number[] => v.split('.').map((x) => Number(x) || 0);
const cmp = (a: string, b: string): number =>
{
    const x = parts(a), y = parts(b);

    for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) - (y[i] ?? 0);

    return 0;
};

/**
 * The database file in a folder for a game version: that version's, else the newest one older than it, else the
 * oldest newer one (a database of another patch still knows most keys); undefined: none in the folder.
 */
export function scriptDbFile(dir: string, gameVersion?: string): string | undefined
{
    if (!existsSync(dir))
        return undefined;

    const versions = readdirSync(dir).map((f) => /^ck3-([\d.]+)\.sqlite$/.exec(f)?.[1]).filter((v): v is string => !!v).sort(cmp);

    if (!versions.length)
        return undefined;

    const pick = !gameVersion ? versions.at(-1)! : versions.filter((v) => cmp(v, gameVersion) <= 0).at(-1) ?? versions[0];
    return join(dir, `ck3-${pick}.sqlite`);
}

export class ScriptDb
{
    readonly file: string;
    readonly version: string;
    /** when it was built (ISO; of two databases for one game version the newer wins) */
    readonly built: string;
    private readonly db: Db;
    private readonly byKind = new Map<string, DbEntry[]>();
    private readonly byKey = new Map<string, DbEntry>();
    private readonly fts: boolean;

    private constructor(file: string, db: Db)
    {
        this.file = file;
        this.db = db;
        this.version = String(db.prepare("SELECT value FROM meta WHERE key = 'game_version'").get()?.value ?? '');
        this.built = String(db.prepare("SELECT value FROM meta WHERE key = 'built'").get()?.value ?? '');

        try
        {
            db.prepare('SELECT entry FROM search LIMIT 1').all();
            this.fts = true;
        }
        catch
        {
            // (an SQLite without FTS5: the dev Node 22's; search falls back to LIKE)
            this.fts = false;
        }
    }

    /** Opens a database file; null when the runtime has no node:sqlite or the file is missing or unreadable. */
    static open(file: string | undefined): ScriptDb | null
    {
        if (!file || !existsSync(file))
            return null;

        try
        {
            const sqlite = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new(f: string, o?: { readOnly?: boolean; }) => Db; } | undefined;
            return sqlite ? new ScriptDb(file, new sqlite.DatabaseSync(file, { readOnly: true })) : null;
        }
        catch
        {
            return null;
        }
    }

    close(): void
    {
        this.db.close();
    }

    /** how many entries have an explanation */
    explainedCount(): number
    {
        return Number(this.db.prepare('SELECT count(*) AS n FROM explanations').get()?.n ?? 0);
    }

    /** Every entry of a kind (with scopes and explanations), in key order; cached. */
    all(kind: DbKind): DbEntry[]
    {
        let list = this.byKind.get(kind);

        if (list)
            return list;

        const scopes = new Map<number, Partial<Record<DbRole, string[]>>>();

        for (const r of this.db.prepare('SELECT s.entry, s.role, s.scope FROM scopes s JOIN entries e ON e.id = s.entry WHERE e.kind = ?').all(kind))
        {
            const s = scopes.get(Number(r.entry)) ?? {};
            (s[r.role as DbRole] ??= []).push(String(r.scope));
            scopes.set(Number(r.entry), s);
        }

        list = this.db.prepare(`SELECT e.id, e.key, e.variant, e.doc, e.facts, x.label, x.summary, x.details, x.fields, x.sources, x.uncertain
            FROM entries e LEFT JOIN explanations x ON x.entry = e.id WHERE e.kind = ? ORDER BY e.key, e.variant`).all(kind).map((r) => ({
            id: Number(r.id),
            kind,
            key: String(r.key),
            variant: String(r.variant),
            doc: String(r.doc),
            facts: JSON.parse(String(r.facts)) as Record<string, unknown>,
            scopes: scopes.get(Number(r.id)) ?? {},
            ...(r.summary != null ? { explanation: { label: String(r.label), summary: String(r.summary), details: String(r.details), fields: JSON.parse(String(r.fields)), sources: JSON.parse(String(r.sources)), uncertain: !!r.uncertain } } : {})
        }));

        this.byKind.set(kind, list);

        for (const e of list)
            this.byKey.set(`${kind}\u0000${e.key}\u0000${e.variant}`, e);

        return list;
    }

    /** One entry by kind and key ('' variant: a link's plain form; 'data': its `name:key` form). */
    entry(kind: DbKind, key: string, variant = ''): DbEntry | undefined
    {
        this.all(kind);
        return this.byKey.get(`${kind}\u0000${key}\u0000${variant}`);
    }

    /** The facts the picker's and the describer's tables take from the database (src/shared/scriptFacts.ts). */
    facts(): ScriptFacts
    {
        const label = (e: DbEntry): { label?: string; summary?: string; } => (e.explanation ? { label: e.explanation.label || undefined, summary: e.explanation.summary || undefined } : {});
        const links = this.all('link');
        const link = (e: DbEntry): ScriptFacts['links'][number] => ({ key: e.key, input: e.scopes.input ?? [], output: e.scopes.output ?? [], global: !!e.facts.global, ...label(e) });

        return {
            version: this.version,
            links: links.filter((e) => !e.facts.requiresData && !e.facts.wildCard).map(link),
            dataLinks: links.filter((e) => e.facts.requiresData && !e.facts.wildCard).map(link),
            lists: this.all('list').map((e) => ({ name: e.key, forms: Object.keys((e.facts.forms ?? {}) as object), scope: e.scopes.scope ?? [], target: e.scopes.target ?? [], ...label(e) })),
            statements: [...this.all('effect'), ...this.all('trigger')].filter((e) => e.scopes.scope?.length).map((e) => ({ key: e.key, kind: e.kind as 'effect' | 'trigger', scope: e.scopes.scope! })),
            savedScopes: this.all('saved_scope').map((e) => ({ name: e.key, ...label(e) })),
            scopeTypes: this.all('scope_type').map((e) => ({ name: e.key, ...label(e) })),
            onActions: this.all('on_action').map((e) => ({ name: e.key, fromCode: !!e.facts.fromCode, root: e.scopes.root ?? [] }))
        };
    }

    /** Entries whose key, label or explanation match a text, best first (FTS5 where the runtime has it). */
    search(text: string, kinds?: DbKind[], limit = 50): DbEntry[]
    {
        const q = text.trim();

        if (!q)
            return [];

        // (the kinds as one parameter, `,effect,trigger,`; empty: every kind)
        const only = kinds?.length ? `,${kinds.join(',')},` : '';
        const rows = this.fts
            ? this.db.prepare("SELECT kind, entry FROM search WHERE search MATCH ? AND (? = '' OR instr(?, ',' || kind || ',') > 0) ORDER BY rank LIMIT ?")
                .all(q.split(/\s+/).map((w) => `"${w.replace(/"/g, '""')}"*`).join(' '), only, only, limit)
            : this.db.prepare(`SELECT e.kind, e.id AS entry FROM entries e LEFT JOIN explanations x ON x.entry = e.id
                WHERE (e.key LIKE ? OR x.label LIKE ? OR x.summary LIKE ?) AND (? = '' OR instr(?, ',' || e.kind || ',') > 0) LIMIT ?`)
                .all(`%${q}%`, `%${q}%`, `%${q}%`, only, only, limit);

        return rows.map((r) => this.all(String(r.kind) as DbKind).find((e) => e.id === Number(r.entry))).filter((e): e is DbEntry => !!e);
    }
}
