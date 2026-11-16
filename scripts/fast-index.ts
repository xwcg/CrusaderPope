// The check scripts' way to a built GameIndex (docs/dev-gotchas.md, "Checks and the index"): the script files parsed on
// threads as the app does (scan(), then parseAllParallel with the app's automatic number of threads,
// src/shared/parseThreads.ts), and, for a script that only reads the index, the index cache: a file under
// %TEMP%/ckp-index-cache/ (never the app's own cache folder) keyed like the app's: the indexer's code hash computed from the
// current source (scripts/index-code-hash.ts, the function electron.vite.config.ts uses), the game folder, the mods, the
// language and every indexed file's size and time; read when it fits, written after a fresh build. A cache that does not fit
// is never used; what could be wrong with it is a different fingerprint, and that means a fresh build.
// A script that builds the game again and again with other mods (the migration checks) can keep the game's parse results
// for its later builds (ParseReuse below): the game's script files are parsed once per run.
// env: FRESH=1  no cache read or written (a fresh threaded build); THREADS=N  parse threads (0 = this thread alone, as
// GameIndex.build()); FAST_INDEX_QUIET=1  no line on stderr about how the index was made.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { GameIndex, type BuildProgress } from '../src/main/indexer/gameIndex.ts';
import { readIndexCache, cacheParts, writeCacheParts } from '../src/main/indexer/cache.ts';
import type { ScriptExtract } from '../src/main/indexer/fileExtract.ts';
import { ParsePool, type ParseJob } from '../src/main/indexer/parsePool.ts';
import type { GameFiles } from '../src/main/mods/gamefiles.ts';
import { parseThreadCount } from '../src/shared/parseThreads.ts';
import { indexCodeHash } from './index-code-hash.ts';

const root = resolve(import.meta.dirname, '..');
/** the cache files stay as long as they are among the newest of this many */
const KEEP_FILES = 8;

export interface FastIndexOptions
{
    /** the localization language (default english) */
    language?: string;
    /** read the index from the cache when it fits, write it after a fresh build; only for a script that reads the index and changes nothing in it */
    cache?: boolean;
    /** parse threads (default: THREADS from the environment, else the app's automatic number; 0: this thread alone) */
    threads?: number;
    /** told the build's phases (scan, localization, scripts, references, or loading the cache) */
    progress?: (p: BuildProgress) => void;
    /** what to call the index in the line on stderr (default: the game folder) */
    label?: string;
}

/** FRESH=1: no cache */
export const fresh = (): boolean => !!process.env.FRESH && process.env.FRESH !== '0';

/** The parse threads a build uses: THREADS from the environment, else the app's automatic number. */
export function parseThreads(): number
{
    const env = process.env.THREADS;

    if (env !== undefined && env !== '' && Number.isFinite(Number(env)))
        return Math.max(0, Math.round(Number(env)));

    return parseThreadCount(undefined, availableParallelism());
}

let codeVersion: string | undefined;

/** The cache key's code part: the indexer's code as it is on disk now (computed once per run). */
export function codeKey(): string
{
    return (codeVersion ??= indexCodeHash(root) + '|scripts');
}

const note = (text: string): void =>
{
    if (!process.env.FAST_INDEX_QUIET)
        process.stderr.write(`[fast-index] ${text}\n`);
};

const WORKER = join(root, 'src/main/parseWorker.ts');
const sha1 = (data: string | Uint8Array): string => createHash('sha1').update(data).digest('base64');

/** A kept parse result: the file's size and times and the sha1 of its bytes when it was parsed, and of the result's typed columns. */
interface Kept
{
    stamp: string;
    bytes: string;
    ex: ScriptExtract;
    columns: string;
}

/** A file's size, modification and change time (FileInfo.stamp's three: a write changes the change time even when the modification time is set back). */
function stampOf(abs: string): string | undefined
{
    try
    {
        const st = statSync(abs);
        return `${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
    }
    catch
    {
        return undefined;
    }
}

function bytesOf(abs: string): string | undefined
{
    try
    {
        return sha1(readFileSync(abs));
    }
    catch
    {
        return undefined;
    }
}

/** The sha1 of an extract's candidate columns (the typed arrays a build reads and freezing cannot guard). */
function columnsHash(ex: ScriptExtract): string
{
    const h = createHash('sha1');
    const c = ex.cands;

    for (const a of [c.tok, c.k1, c.k0, c.flags, c.from, c.line, c.off, c.len, c.ctx])
        h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

    return h.digest('base64');
}

/** Freezes what of an extract can be frozen (its objects, arrays of strings and numbers, the definitions' meta): a write throws. */
function freezeExtract(ex: ScriptExtract): void
{
    const d = ex.defs;

    for (const m of d.meta)
        if (m)
            Object.freeze(m);

    for (const a of [d.type, d.name, d.line, d.start, d.end, d.doc, d.local, d.meta, ex.strs])
        Object.freeze(a);

    Object.freeze(d);
    Object.freeze(ex.cands);
    Object.freeze(ex);
}

/**
 * The game folder's parse results, kept for the later builds of a run: a check that builds the game with one test mod
 * after another (scripts/migrate-check.ts, migrate-check-libraries.ts) parses the game's script files once. A build
 * applies each file's result on its own thread in file order (GameIndex.parseAllParallel: entities, definitions and
 * candidates numbered there), so a kept result in place of a parse thread's makes the same index, number for number; a
 * thread's result is data about one file alone (indexer/fileExtract.ts: its text, area, type, hidden or not and path; not
 * its place in the index, nor the other files). Only files below the game folder are kept: the mods' files (and zipped
 * ones) are parsed by every build as before.
 * Against a stale reuse: a result is reused only for the same file (path, area, type, hidden or not) with the same size,
 * modification and change time: every build looks at the game's files again (a stat each, ~0.1 s for the 1.20 game's
 * 3,600 script files); a file that differs is parsed again (`reparsed`). A result is kept only when the file's stamp and
 * bytes (sha1) are the same before and after its parse, and audit() reads every kept file again at the end of the run:
 * its stamp and bytes must still be the ones parsed. Against one build's changes reaching another: the results are shared
 * read only, their objects and arrays frozen (a write throws); the typed columns, which cannot be frozen, are hashed when
 * kept and again by audit().
 * A build on one thread (THREADS=0: GameIndex.parseAll) parses everything itself and keeps nothing.
 */
export class ParseReuse
{
    private readonly gameRoot: string;
    private readonly kept = new Map<string, Kept>();
    /** builds that asked for parse results */
    builds = 0;
    /** game files parsed (the first time, or changed) and kept */
    parsed = 0;
    /** of those, files parsed again because their stamp was not the kept one */
    reparsed = 0;
    /** game files of a build given a kept result */
    reused = 0;
    /** files parsed and not kept (the mods', zip entries, unreadable ones) */
    passed = 0;
    /** ms spent looking at the game's files (stamps, and hashes of the ones parsed) */
    checkMs = 0;

    constructor(gameDir: string)
    {
        this.gameRoot = resolve(gameDir).toLowerCase() + sep;
    }

    /** The key of a job of a game file (path, area, type, hidden, path in the game), undefined for every other file. */
    private keyOf(j: ParseJob): string | undefined
    {
        if (!j.abs || !resolve(j.abs).toLowerCase().startsWith(this.gameRoot))
            return undefined;

        return `${j.abs}\n${j.area}\n${j.type}\n${j.hidden ? 1 : 0}\n${j.rel}`;
    }

    /**
     * One build's jobs: each game file whose kept result fits goes to `onResult` at once; the rest are returned for the
     * parse threads, with `onFresh` to call for each of their results (keeps a game file's).
     */
    split(jobs: ParseJob[], onResult: (i: number, ex: ScriptExtract | null) => void): { fresh: ParseJob[]; onFresh: (i: number, ex: ScriptExtract | null) => void; }
    {
        const t = performance.now();
        this.builds++;
        const fresh: ParseJob[] = [];
        const wanted = new Map<number, { key: string; abs: string; stamp: string; bytes: string; }>();

        for (const j of jobs)
        {
            const key = this.keyOf(j);
            const stamp = key === undefined ? undefined : stampOf(j.abs!);
            const k = key === undefined ? undefined : this.kept.get(key);

            if (k && k.stamp === stamp)
            {
                this.reused++;
                onResult(j.i, k.ex);
                continue;
            }

            const bytes = key === undefined || stamp === undefined ? undefined : bytesOf(j.abs!);

            if (key === undefined || stamp === undefined || bytes === undefined)
                this.passed++;
            else
            {
                if (k)
                    this.reparsed++;

                wanted.set(j.i, { key, abs: j.abs!, stamp, bytes });
            }

            fresh.push(j);
        }

        this.checkMs += performance.now() - t;
        const onFresh = (i: number, ex: ScriptExtract | null): void =>
        {
            const w = wanted.get(i);

            // (kept only when the file has the stamp and bytes it had before it went out: the result is of those bytes)
            if (w && ex)
            {
                const t2 = performance.now();

                if (stampOf(w.abs) === w.stamp && bytesOf(w.abs) === w.bytes)
                {
                    freezeExtract(ex);
                    this.kept.set(w.key, { stamp: w.stamp, bytes: w.bytes, ex, columns: columnsHash(ex) });
                    this.parsed++;
                }

                this.checkMs += performance.now() - t2;
            }

            onResult(i, ex);
        };
        return { fresh, onFresh };
    }

    /** A parse pool for one build that takes the kept results and parses the rest on `threads` threads. */
    pool(threads: number): ParsePool
    {
        return new ReusePool(WORKER, threads, this);
    }

    /**
     * The kept results that are not what they were when kept, as `<file>: <what>`: the file's stamp or bytes changed
     * (a reuse since could have been stale), or the typed columns (a build wrote into them). Empty: all as parsed.
     */
    audit(): string[]
    {
        const out: string[] = [];

        for (const [key, k] of this.kept)
        {
            const abs = key.split('\n')[0];

            if (stampOf(abs) !== k.stamp)
                out.push(`${abs}: size or time changed`);
            else if (bytesOf(abs) !== k.bytes)
                out.push(`${abs}: bytes changed`);
            else if (columnsHash(k.ex) !== k.columns)
                out.push(`${abs}: the kept result was written to`);
        }

        return out;
    }

    /** One line about the run: how often the game's files were parsed and reused. */
    summary(): string
    {
        return `the game's script files parsed once: ${this.kept.size} kept, ${this.parsed} parsed (${this.reparsed} of them again: changed), ${this.reused} reused in ${this.builds} builds, ${this.passed} other files parsed; ${(this.checkMs / 1000).toFixed(1)} s looking at the game's files`;
    }
}

/** A ParsePool that answers the game's files from a ParseReuse and parses the rest on its threads. */
class ReusePool extends ParsePool
{
    private readonly reuse: ParseReuse;

    constructor(script: string, size: number, reuse: ParseReuse)
    {
        super(script, size);
        this.reuse = reuse;
    }

    override run(jobs: ParseJob[], onResult: (i: number, ex: ScriptExtract | null) => void, alive?: () => boolean): Promise<void>
    {
        const { fresh, onFresh } = this.reuse.split(jobs, onResult);
        return super.run(fresh, onFresh, alive);
    }
}

/**
 * Scans and parses an index made with `new GameIndex(files, language)` that has not been scanned yet: on `threads` parse
 * threads (the same index as GameIndex.build(), proved by scripts/parallel-check.ts), or on this thread when there are none.
 * `reuse`: the game's files from the parse results kept by earlier builds of the run (ParseReuse).
 */
export async function buildIndex(idx: GameIndex, threads = parseThreads(), reuse?: ParseReuse): Promise<GameIndex>
{
    idx.scan();
    await parseIndex(idx, threads, undefined, reuse);
    return idx;
}

/** The parsing half of buildIndex, for an index that has been scanned (a script that fingerprints between the two). */
export async function parseIndex(idx: GameIndex, threads = parseThreads(), progress?: (p: BuildProgress) => void, reuse?: ParseReuse): Promise<void>
{
    if (threads <= 0)
        idx.parseAll(progress);
    else
        await idx.parseAllParallel(reuse ? reuse.pool(threads) : new ParsePool(WORKER, threads), progress);
}

/** Where this game folder, mod layering and language keep their cache. */
function cacheFile(idx: GameIndex): string
{
    const key = createHash('sha1').update(`${idx.gameDir}\n${idx.language}\n${idx.vfs.identity()}`).digest('hex').slice(0, 16);
    return join(tmpdir(), 'ckp-index-cache', `index-${key}.bin`);
}

/** The oldest cache files go once there are more than KEEP_FILES (and the leftovers of writes that died). */
function prune(dir: string): void
{
    try
    {
        const files = readdirSync(dir)
            .map((f) => ({ f, p: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);

        for (const [i, x] of files.entries())
        {
            const leftover = /\.w(\.tmp)?$/.test(x.f) && Date.now() - x.t > 3600_000;

            if (leftover || (/\.bin$/.test(x.f) && i >= KEEP_FILES))
                rmSync(x.p, { force: true });
        }
    }
    catch
    {
        // (a cache folder that cannot be tidied is still a cache)
    }
}

/**
 * A built index of the files: from the cache when `cache` is set and a file there fits (same fingerprint), else a fresh
 * threaded build (written to the cache afterwards when `cache` is set). FRESH=1 skips the cache.
 */
export async function fastIndex(files: string | GameFiles, opts: FastIndexOptions = {}): Promise<GameIndex>
{
    const language = opts.language ?? 'english';
    const threads = opts.threads ?? parseThreads();
    const t0 = performance.now();
    let idx = new GameIndex(files, language);
    const label = opts.label ?? idx.gameDir;
    idx.scan(opts.progress);
    const useCache = !!opts.cache && !fresh();
    const file = useCache ? cacheFile(idx) : '';
    const fingerprint = useCache ? idx.fingerprint(codeKey()) : '';

    if (useCache)
    {
        const state = readIndexCache(file, fingerprint);

        if (state)
        {
            try
            {
                idx.importState(state, opts.progress);
                note(`${label}: loaded from the cache in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
                return idx;
            }
            catch (e)
            {
                note(`${label}: the cache did not load (${e instanceof Error ? e.message : e}), building`);
                idx = new GameIndex(files, language);
                idx.scan(opts.progress);
            }
        }
    }

    await parseIndex(idx, threads, opts.progress);
    const built = performance.now() - t0;

    if (useCache)
    {
        // (written under a name of its own and renamed: two scripts building the same index at once never mix their bytes)
        const tmp = `${file}.${process.pid}.w`;

        try
        {
            mkdirSync(join(tmpdir(), 'ckp-index-cache'), { recursive: true });
            await writeCacheParts(tmp, fingerprint, cacheParts(idx.exportState()).parts);
            renameSync(tmp, file);
            prune(join(tmpdir(), 'ckp-index-cache'));
        }
        catch (e)
        {
            rmSync(tmp, { force: true });
            note(`${label}: the cache could not be written (${e instanceof Error ? e.message : e})`);
        }
    }

    note(`${label}: built on ${threads ? threads + ' parse threads' : 'one thread'} in ${(built / 1000).toFixed(1)} s${useCache ? ', cache written' : ''}`);
    return idx;
}
