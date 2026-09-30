/**
 * The Paradox Launcher's database (`launcher-v2.sqlite` in the user folder, docs/mods.md): the mods it knows
 * (`mods`) and the playsets = mod lists with load order (`playsets`, `playsets_mods.position`). Read with node:sqlite;
 * writes back one playset's order/enabled flags, registering local mods the launcher has not seen yet.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

export interface LauncherMod
{
    /** launcher uuid */
    id: string;
    /** the game's registry id = descriptor path relative to the user folder, e.g. `mod/ugc_2962333032.mod` */
    gameRegistryId?: string;
    displayName?: string;
    steamId?: string;
    pdxId?: string;
    dirPath?: string;
    archivePath?: string;
    /** ready_to_play, installation_failed, … */
    status: string;
    /** steam, pdx, local */
    source: string;
    version?: string;
    requiredVersion?: string;
    tags: string[];
    thumbnailPath?: string;
}

export interface LauncherPlayset
{
    id: string;
    name: string;
    active: boolean;
    /** in load order */
    mods: { modId: string; enabled: boolean; position: number; }[];
}

// node:sqlite is loaded on demand: a runtime without it just has no launcher data
type Db = {
    prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): unknown; get(...p: unknown[]): Record<string, unknown> | undefined; };
    exec(sql: string): void;
    close(): void;
};

async function openDb(file: string, readOnly: boolean): Promise<Db | null>
{
    if (!existsSync(file))
        return null;

    try
    {
        const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new(f: string, o?: { readOnly?: boolean; }) => Db; };
        return new DatabaseSync(file, { readOnly });
    }
    catch
    {
        return null;
    }
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export async function readLauncher(dbFile: string): Promise<{ mods: LauncherMod[]; playsets: LauncherPlayset[]; } | null>
{
    const db = await openDb(dbFile, true);

    if (!db)
        return null;

    try
    {
        const mods: LauncherMod[] = db.prepare('select * from mods')
            .all()
            .map((r) =>
            {
                let tags: string[] = [];

                try
                {
                    tags = JSON.parse(String(r.tags ?? '[]'));
                }
                catch
                {
                    /* not JSON */
                }

                return {
                    id: String(r.id),
                    gameRegistryId: s(r.gameRegistryId),
                    displayName: s(r.displayName) ?? s(r.name),
                    steamId: s(r.steamId) ?? s(r.remoteSteamId),
                    pdxId: s(r.pdxId) ?? s(r.remotePdxId),
                    dirPath: s(r.dirPath),
                    archivePath: s(r.archivePath),
                    status: String(r.status ?? ''),
                    source: String(r.source ?? ''),
                    version: s(r.version),
                    requiredVersion: s(r.requiredVersion),
                    tags,
                    thumbnailPath: s(r.thumbnailPath)
                };
            });
        const playsets: LauncherPlayset[] = db
            .prepare('select id, name, isActive from playsets where isRemoved = 0 or isRemoved is null')
            .all()
            .map((p) => ({
                id: String(p.id),
                name: String(p.name ?? ''),
                active: Number(p.isActive) === 1,
                mods: db
                    .prepare('select modId, enabled, position from playsets_mods where playsetId = ? order by position, rowid')
                    .all(p.id)
                    .map((m, i) => ({ modId: String(m.modId), enabled: Number(m.enabled ?? 1) === 1, position: m.position === null ? i : Number(m.position) }))
            }));
        return { mods, playsets };
    }
    finally
    {
        db.close();
    }
}

/**
 * A local mod the launcher has not registered yet (it registers mods of the user's mod folder when it starts): the
 * row the app writes for it, as the launcher fills one — see docs/mods.md, "Registering a new mod".
 */
export interface NewLauncherMod
{
    /** the game's registry id, `mod/<file>.mod` */
    gameRegistryId: string;
    displayName: string;
    version?: string;
    tags: string[];
    /** the descriptor's supported_version */
    requiredVersion?: string;
    /** folder (OS path, as the launcher writes it) — or `archivePath` for a zip */
    dirPath?: string;
    archivePath?: string;
    /** the descriptor's remote_file_id */
    remoteSteamId?: string;
    /** bytes of the mod's files */
    size?: number;
}

/** The `mods` row for a new local mod: only the columns this launcher version's table has. */
function registerMod(db: Db, m: NewLauncherMod): string
{
    // (registered meanwhile — by another write: keep that row)
    const had = db.prepare('select id from mods where lower(gameRegistryId) = lower(?)').get(m.gameRegistryId);

    if (had)
        return String(had.id);

    const id = randomUUID();
    const row: Record<string, unknown> = {
        id,
        gameRegistryId: m.gameRegistryId,
        displayName: m.displayName,
        version: m.version ?? null,
        tags: JSON.stringify(m.tags),
        requiredVersion: m.requiredVersion ?? null,
        dirPath: m.dirPath ?? null,
        archivePath: m.archivePath ?? null,
        status: 'ready_to_play',
        source: 'local',
        cause: null,
        isNew: 0,
        // (seconds, as in the launcher's own local rows)
        createdDate: Math.floor(Date.now() / 1000),
        size: m.size ?? null,
        remoteSteamId: m.remoteSteamId ?? null
    };
    const columns = new Set(
        db.prepare('pragma table_info(mods)')
            .all()
            .map((c) => String(c.name))
    );

    for (const need of ['id', 'gameRegistryId', 'displayName', 'status', 'source'])
        if (!columns.has(need))
            throw new Error(`The launcher database has no mods.${need} column — a launcher version this app does not know. Start the launcher once so it registers the mod itself.`);

    const keys = Object.keys(row).filter((k) => columns.has(k));
    db.prepare(`insert into mods (${keys.map((k) => '"' + k + '"').join(', ')}) values (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
    return id;
}

/**
 * Replaces a playset's mod rows (order = array order, positions 0..n-1) in one transaction. Mods the launcher does not
 * know yet (`register`, keyed by their game registry id in `mods`: `{ register: 'mod/x.mod' }`) get a `mods` row
 * first. The caller backs the database up and makes sure the launcher is closed. Returns the uuids given to new mods.
 */
export async function writeLauncherPlayset(dbFile: string, playsetId: string, mods: ({ modId: string; enabled: boolean; } | { register: NewLauncherMod; enabled: boolean; })[]): Promise<Map<string, string>>
{
    const db = await openDb(dbFile, false);
    const registered = new Map<string, string>();

    if (!db)
        throw new Error('Cannot open the launcher database ' + dbFile);

    try
    {
        db.exec('begin');

        try
        {
            if (!db.prepare('select id from playsets where id = ?').get(playsetId))
                throw new Error('The launcher no longer has this playset.');

            const rows = mods.map((m) =>
            {
                if ('modId' in m)
                    return { modId: m.modId, enabled: m.enabled };

                const id = registerMod(db, m.register);
                registered.set(m.register.gameRegistryId, id);
                return { modId: id, enabled: m.enabled };
            });
            db.prepare('delete from playsets_mods where playsetId = ?').run(playsetId);
            const ins = db.prepare('insert into playsets_mods (playsetId, modId, enabled, position) values (?, ?, ?, ?)');
            rows.forEach((m, i) => ins.run(playsetId, m.modId, m.enabled ? 1 : 0, i));
            db.prepare('update playsets set updatedOn = ? where id = ?').run(Date.now(), playsetId);
            db.exec('commit');
        }
        catch (e)
        {
            db.exec('rollback');
            throw e;
        }
    }
    finally
    {
        db.close();
    }

    return registered;
}
