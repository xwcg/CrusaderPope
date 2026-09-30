/**
 * Compiled game shaders across starts (docs/shaders.md, "Compiled during indexing, cached"). Programs are keyed by
 * their request (JSON) and valid for one fingerprint of the FX files and the compiler code; failures are kept too,
 * so a broken Effect is not retried every start. Indexing compiles every Effect the game's .asset files name (both UV
 * layouts, with each meshsettings' additional_shader_defines); anything else (a .mesh material's own shader) compiles
 * on demand and is added.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, type PNode } from '../indexer/parser.ts';
import { defaultEffectFile, shaderDefinesOf, viewerShaderRequest } from '../../shared/shaders.ts';
import type { ShaderProgram, ShaderRequest } from '../../shared/api.ts';
import { CancelledError } from './pool.ts';
import type { GameFile, GameFiles } from '../mods/gamefiles.ts';

const MAGIC = 'crusaderpope-shaders-1';

type Entry = ShaderProgram | { error: string; };

/**
 * Every FX file the game loads — gfx/FX of the game's engine layers (game, jomini, clausewitz) with the loaded mods'
 * files over them: which file (disk path or `archive › entry`), size, mtime — plus the layering itself and the
 * compiler's code version. Another mod list, or a mod changing a shader, compiles afresh.
 */
export function fxFingerprint(vfs: GameFiles, code: string): string
{
    const h = createHash('sha1');
    h.update(code + '\n' + vfs.identity() + '\n');

    for (const f of vfs.list('gfx/FX', { engine: true }))
    {
        const st = vfs.stat(f);
        h.update(`${vfs.where(f)}|${st.size}|${st.mtime}\n`);
    }

    return h.digest('hex');
}

function assetsFingerprint(assets: GameFile[], vfs: GameFiles): string
{
    const h = createHash('sha1');

    for (const a of assets)
    {
        const st = vfs.stat(a);
        h.update(`${a.source}|${a.rel}|${st.size}|${st.mtime}\n`);
    }

    return h.digest('hex');
}

type MeshEffect = { shader: string; file?: string; defines?: string[]; };

/** `meshsettings = { shader shader_file additional_shader_defines … }` of a parsed .asset file. */
function meshSettingsEffects(list: PNode[], out: MeshEffect[] = []): MeshEffect[]
{
    for (const n of list)
    {
        const kids = n.v;

        if (!Array.isArray(kids))
            continue;

        if (n.k === 'meshsettings')
        {
            const get = (k: string): string | undefined =>
            {
                const v = kids.find((c) => c.k === k)?.v;
                return typeof v === 'string' && v ? v : undefined;
            };
            const shader = get('shader');
            const extra = kids.find((c) => c.k === 'additional_shader_defines')?.v;
            const defines = Array.isArray(extra) ? shaderDefinesOf(extra.map((c) => (typeof c.v === 'string' ? c.v : undefined))) : undefined;

            if (shader)
                out.push({ shader, file: get('shader_file'), defines });
        }
        else
            meshSettingsEffects(kids, out);
    }

    return out;
}

export function deleteShaderCache(file: string): void
{
    rmSync(file, { force: true });
    rmSync(file + '.tmp', { force: true });
}

export class ShaderStore
{
    private entries = new Map<string, Entry>();
    /** fingerprint of the .asset files whose Effects are all in the store */
    private assetsPrint = '';
    /** fingerprint of the .asset files as they are now (covers()) */
    private currentPrint: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private saving: Promise<void> = Promise.resolve();
    /** compiles running now, so a viewer asking for one the precompile is on waits for the same result */
    private inflight = new Map<string, Promise<ShaderProgram>>();
    // plain fields, no parameter properties: scripts load this file with --experimental-strip-types
    private readonly compiler: (req: ShaderRequest) => Promise<ShaderProgram>;
    private file: string | null;
    private readonly fxPrint: string;
    private readonly onFailure?: (req: ShaderRequest, message: string) => void;

    /**
     * @param compiler compiles one request — the thread pool in the app, a ShaderLibrary in scripts
     * @param onFailure a compile failed (logged; not called for cancelled requests or failures from the cache)
     */
    constructor(
        compiler: (req: ShaderRequest) => Promise<ShaderProgram>,
        file: string | null,
        fxPrint: string,
        onFailure?: (req: ShaderRequest, message: string) => void
    )
    {
        this.compiler = compiler;
        this.file = file;
        this.fxPrint = fxPrint;
        this.onFailure = onFailure;
    }

    /** Every stored program and failure (failures by request key). */
    list(): { programs: ShaderProgram[]; failures: { key: string; error: string; }[]; }
    {
        const programs: ShaderProgram[] = [];
        const failures: { key: string; error: string; }[] = [];

        for (const [key, e] of this.entries)
        {
            if ('error' in e)
                failures.push({ key, error: e.error });
            else
                programs.push(e);
        }

        return { programs, failures };
    }

    get size(): number
    {
        return this.entries.size;
    }

    /** Programs of an earlier run with the same FX fingerprint (else nothing). */
    load(): void
    {
        if (!this.file || !existsSync(this.file))
            return;

        try
        {
            const j = JSON.parse(readFileSync(this.file, 'utf8')) as { magic?: string; fx?: string; assets?: string; entries?: [string, Entry][]; };

            if (j.magic !== MAGIC || j.fx !== this.fxPrint || !Array.isArray(j.entries))
                return;

            for (const [k, v] of j.entries)
                this.entries.set(k, v);

            this.assetsPrint = j.assets ?? '';
        }
        catch
        {
            /* unreadable: compile afresh */
        }
    }

    compile(req: ShaderRequest): Promise<ShaderProgram>
    {
        const key = JSON.stringify(req);
        const hit = this.entries.get(key);

        if (hit)
            return 'error' in hit ? Promise.reject(new Error(hit.error)) : Promise.resolve(hit);

        const running = this.inflight.get(key);

        if (running)
            return running;

        const p = this.compiler(req)
            .then(
                (prog) =>
                {
                    this.entries.set(key, prog);
                    this.scheduleSave();
                    return prog;
                },
                (e: Error) =>
                {
                    // a cancelled request (pool terminated for a newer build) is no verdict on the Effect
                    if (!(e instanceof CancelledError))
                    {
                        this.entries.set(key, { error: String(e?.message ?? e) });
                        this.scheduleSave();
                        this.onFailure?.(req, String(e?.message ?? e));
                    }

                    throw e;
                }
            )
            .finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        return p;
    }

    /**
     * Compiles every Effect the .asset files name, in both UV layouts and in parallel on the compiler threads, unless
     * the store already holds them for these files. `planned` gets the number still to compile before any work.
     */
    /** Whether the loaded programs already cover every Effect of these .asset files (nothing to precompile). */
    covers(assets: GameFile[], vfs: GameFiles): boolean
    {
        this.currentPrint = assetsFingerprint(assets, vfs);
        return this.currentPrint === this.assetsPrint;
    }

    async precompile(
        assets: GameFile[],
        vfs: GameFiles,
        hooks: { planned(missing: number): void; progress(done: number, total: number): void; alive(): boolean; }
    ): Promise<void>
    {
        const print = this.currentPrint ?? assetsFingerprint(assets, vfs);

        if (print === this.assetsPrint)
        {
            hooks.planned(0);
            return;
        }

        // each meshsettings' Effect with its additional_shader_defines, in both UV layouts
        const todo = new Map<string, ShaderRequest>();

        for (const a of assets)
        {
            const text = vfs.readText(a);

            if (text === undefined)
                continue;

            for (const { shader, file, defines } of meshSettingsEffects(parse(text)))
            {
                const f = file ?? defaultEffectFile(shader);

                for (const uv1 of [false, true])
                {
                    const r = viewerShaderRequest(f, shader, uv1, defines);
                    const key = JSON.stringify(r);

                    if (!this.entries.has(key))
                        todo.set(key, r);
                }
            }
        }

        const reqs = [...todo.values()];
        hooks.planned(reqs.length);
        let done = 0;
        hooks.progress(0, reqs.length);
        await Promise.all(
            reqs.map((r) =>
                this.compile(r)
                    .catch(() =>
                    {})
                    .then(() => hooks.alive() && hooks.progress(++done, reqs.length))
            )
        );

        if (!hooks.alive())
            return;

        this.assetsPrint = print;
        await this.save();
    }

    /** Cache on (file) or off (null): on writes what the store holds now. */
    setFile(file: string | null): void
    {
        this.file = file;

        if (file)
            void this.save();
    }

    private scheduleSave(): void
    {
        if (!this.file || this.timer)
            return;

        this.timer = setTimeout(() =>
        {
            this.timer = null;
            void this.save();
        }, 3000);
    }

    /** Writes through a temporary file; saves run one after another. */
    save(): Promise<void>
    {
        this.saving = this.saving
            .then(async () =>
            {
                const file = this.file;

                if (!file)
                    return;

                const body = JSON.stringify({ magic: MAGIC, fx: this.fxPrint, assets: this.assetsPrint, entries: [...this.entries] });
                mkdirSync(dirname(file), { recursive: true });
                await writeFile(file + '.tmp', body);
                await rename(file + '.tmp', file);
            })
            .catch(() =>
            {});
        return this.saving;
    }
}
