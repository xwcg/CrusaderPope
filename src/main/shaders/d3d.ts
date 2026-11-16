/**
 * The Direct3D shader compiler as a verdict: does the HLSL text of hlsl.ts compile, and with which errors. The game
 * compiles every Effect stage with d3dcompiler_47 (profile vs_5_0 / ps_5_0, entry `main`); a stage it cannot compile
 * is a material that does not draw. Windows only, no native npm dependency:
 *
 * - `d3dcompiler`: a Windows PowerShell 5.1 helper that P/Invokes `D3DCompile` from d3dcompiler_47.dll (part of Windows).
 *   One process compiles a whole batch on several threads (about 0.7 s to start, then 15 ms per vertex stage and 200 to
 *   600 ms per large pixel stage).
 * - `fxc`: fxc.exe of the Windows SDK when it is installed (`FXC` in the environment, the newest Windows Kits folder, or
 *   on the PATH), one process per source, a few at a time. The verdicts are the same as the first one's (135 of 135 cached
 *   sources of a game run).
 *
 * Elsewhere (CK3 on Linux and macOS does not use the D3D path) a verdict is `unchecked` (`ok: null`).
 *
 * Verdicts are cached on disk by the hash of the source, the profile, the flags and the compiler (`cacheDir`): a rerun with
 * unchanged files costs nothing. Flags: `D3DCOMPILE_SKIP_OPTIMIZATION` (4) gives the same verdicts as the default flags on
 * all cached sources of the game and is 3 times quicker on large pixel stages; errors that only the optimizer finds
 * (forced loop unrolling, gradient in flow control) are missed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../shared/i18n.ts';
import type { Stage } from './effect.ts';

export interface D3dError
{
    /** 1-based line of the source, 0 when the message names none */
    line: number;
    /** column range as the compiler prints it (`9-29`) */
    col: string;
    /** `X3003` */
    code: string;
    msg: string;
}

export interface D3dVerdict
{
    /** true: compiles; false: does not; null: not checked (no compiler here) */
    ok: boolean | null;
    errors: D3dError[];
    /** the compiler's time for this source (0 from the cache) */
    ms: number;
    cached?: boolean;
}

export type D3dBackend = 'd3dcompiler' | 'fxc';

export interface D3dOptions
{
    /** D3DCOMPILE flags; default 4 (skip optimization) */
    flags?: number;
    /** sources compiled at the same time */
    jobs?: number;
    /** a folder for the verdict cache (d3d-verdicts.json in it); none: no cache */
    cacheDir?: string;
    /** use one backend only (default: the first available) */
    backend?: D3dBackend;
}

export interface D3dSource
{
    source: string;
    stage: Stage;
}

const DEFAULT_FLAGS = 4;
const isWin = process.platform === 'win32';
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const dllPath = join(systemRoot, 'System32', 'd3dcompiler_47.dll');
const powershellPath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** fxc.exe of the Windows SDK: `FXC` in the environment, the newest `Windows Kits/10/bin/<version>/x64`, or the PATH */
export function findFxc(): string | undefined
{
    if (!isWin)
        return undefined;

    if (process.env.FXC && existsSync(process.env.FXC))
        return process.env.FXC;

    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)'])
    {
        if (!base)
            continue;

        const bin = join(base, 'Windows Kits', '10', 'bin');

        try
        {
            const versions = readdirSync(bin).filter((v) => /^10\./.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

            for (const v of versions)
            {
                const p = join(bin, v, 'x64', 'fxc.exe');

                if (existsSync(p))
                    return p;
            }
        }
        catch
        {
            // no SDK in this folder
        }
    }

    for (const dir of (process.env.PATH ?? '').split(';'))
        if (dir && existsSync(join(dir, 'fxc.exe')))
            return join(dir, 'fxc.exe');

    return undefined;
}

/** the backends this machine has, best first */
export function d3dBackends(): D3dBackend[]
{
    const out: D3dBackend[] = [];

    if (isWin && existsSync(dllPath) && existsSync(powershellPath))
        out.push('d3dcompiler');

    if (findFxc())
        out.push('fxc');

    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The PowerShell helper (String.raw: the C# keeps its backslashes). Input: a manifest of `<file>|<target>|<flags>` lines;
// output on stdout, one line per source: `<index>|OK or ERR|<ms>|<base64 of the messages>`.
// ---------------------------------------------------------------------------------------------------------------------
const PS_SCRIPT = String.raw`param([string]$Manifest, [int]$Threads)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class D3DBatch
{
    [DllImport("d3dcompiler_47.dll", CallingConvention = CallingConvention.StdCall)]
    static extern int D3DCompile(byte[] src, UIntPtr srcLen, string srcName, IntPtr defines, IntPtr include,
        string entry, string target, uint flags1, uint flags2, out IntPtr code, out IntPtr errors);

    // ID3DBlob: IUnknown(3) + GetBufferPointer(3) + GetBufferSize(4)
    delegate IntPtr GetPtr(IntPtr self);
    delegate UIntPtr GetSize(IntPtr self);
    delegate uint Release(IntPtr self);

    static IntPtr Slot(IntPtr blob, int i) { return Marshal.ReadIntPtr(Marshal.ReadIntPtr(blob), i * IntPtr.Size); }

    static string Text(IntPtr blob)
    {
        if (blob == IntPtr.Zero) return "";
        IntPtr p = ((GetPtr)Marshal.GetDelegateForFunctionPointer(Slot(blob, 3), typeof(GetPtr)))(blob);
        int n = (int)(ulong)((GetSize)Marshal.GetDelegateForFunctionPointer(Slot(blob, 4), typeof(GetSize)))(blob);
        return Marshal.PtrToStringAnsi(p, n);
    }

    static void Free(IntPtr blob)
    {
        if (blob != IntPtr.Zero) ((Release)Marshal.GetDelegateForFunctionPointer(Slot(blob, 2), typeof(Release)))(blob);
    }

    public static void Run(string manifest, int threads)
    {
        string[] lines = File.ReadAllLines(manifest);
        int next = -1;
        object gate = new object();
        List<Thread> pool = new List<Thread>();

        for (int t = 0; t < threads; t++)
        {
            Thread th = new Thread(delegate ()
            {
                for (;;)
                {
                    int i = Interlocked.Increment(ref next);
                    if (i >= lines.Length) return;
                    string[] f = lines[i].Split('|');
                    Stopwatch sw = Stopwatch.StartNew();
                    string msg;
                    bool ok;
                    try
                    {
                        byte[] src = File.ReadAllBytes(f[0]);
                        IntPtr code, err;
                        int hr = D3DCompile(src, (UIntPtr)src.Length, "shader.hlsl", IntPtr.Zero, IntPtr.Zero, "main", f[1], Convert.ToUInt32(f[2]), 0, out code, out err);
                        msg = Text(err);
                        Free(code); Free(err);
                        ok = hr >= 0;
                    }
                    catch (Exception e)
                    {
                        msg = "helper: " + e.Message;
                        ok = false;
                    }
                    sw.Stop();
                    string line = i + "|" + (ok ? "OK" : "ERR") + "|" + sw.ElapsedMilliseconds + "|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(msg));
                    lock (gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
                }
            });
            th.IsBackground = true;
            th.Start();
            pool.Add(th);
        }

        foreach (Thread th in pool) th.Join();
    }
}
'@
[D3DBatch]::Run($Manifest, $Threads)
`;

/** `file(line,col): error X3003: message` and the lines without a position */
export function parseErrors(raw: string): D3dError[]
{
    const out: D3dError[] = [];

    // (`file(line,col): error X3003: …`, or `file: error X3501: …` for a fault without a position)
    for (const m of raw.matchAll(/^(?:[^\n(]*\((\d+),([\d-]+)\): |[^\n(]*?: )?error (X\d+): ([^\n]*)/gm))
        out.push({ line: Number(m[1] ?? 0), col: m[2] ?? '', code: m[3], msg: m[4].trim() });

    return out;
}

/** a batch that takes longer than this is abandoned: its sources stay unchecked (a hung helper must not hang the migration) */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** what a refusal without a parseable message says, so a failed source never counts as a pass */
function refusal(raw: string): D3dError[]
{
    return [{ line: 0, col: '', code: 'X0000', msg: raw.replace(/\s+/g, ' ').trim().slice(0, 300) || tr('the compiler refused the source') }];
}

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<{ code: number | null; out: string; }>
{
    return new Promise((resolve) =>
    {
        const p = spawn(cmd, args, { windowsHide: true });
        const timer = setTimeout(() => p.kill(), RUN_TIMEOUT_MS);
        let out = '';
        let pending = '';
        const feed = (d: Buffer): void =>
        {
            const s = d.toString('utf8');
            out += s;

            if (onLine)
            {
                pending += s;
                const parts = pending.split('\n');
                pending = parts.pop() ?? '';

                for (const l of parts)
                    onLine(l.replace(/\r$/, ''));
            }
        };
        p.stdout.on('data', feed);
        p.stderr.on('data', feed);
        p.on('error', () =>
        {
            clearTimeout(timer);
            resolve({ code: -1, out });
        });
        p.on('close', (code) =>
        {
            clearTimeout(timer);

            if (onLine && pending)
                onLine(pending.replace(/\r$/, ''));

            resolve({ code, out });
        });
    });
}

async function viaD3dcompiler(items: D3dSource[], flags: number, jobs: number, dir: string): Promise<(D3dVerdict | undefined)[]>
{
    const script = join(dir, 'd3dcompile.ps1');
    const manifest = join(dir, 'manifest.txt');
    writeFileSync(script, '\ufeff' + PS_SCRIPT);
    const lines = items.map((it, i) =>
    {
        const f = join(dir, `${i}.hlsl`);
        writeFileSync(f, it.source);
        return `${f}|${it.stage}_5_0|${flags}`;
    });
    writeFileSync(manifest, lines.join('\n'));
    const results: (D3dVerdict | undefined)[] = new Array(items.length).fill(undefined);
    await run(powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, manifest, String(jobs)], (line) =>
    {
        const m = /^(\d+)\|(OK|ERR)\|(\d+)\|([A-Za-z0-9+/=]*)$/.exec(line);

        if (!m)
            return;

        const raw = Buffer.from(m[4], 'base64').toString('utf8');
        const errors = parseErrors(raw);

        // (the compiler said no and the message has no error line we read: still a no)
        if (m[2] === 'ERR' && !errors.length && !/^helper: /m.test(raw))
            errors.push(...refusal(raw));
        const helperError = /^helper: (.*)$/m.exec(raw);

        // (a failure of the helper itself is no verdict on the source)
        if (helperError)
            return;

        results[Number(m[1])] = { ok: m[2] === 'OK' && !errors.length, errors, ms: Number(m[3]) };
    });
    return results;
}

async function viaFxc(fxc: string, items: D3dSource[], flags: number, jobs: number, dir: string): Promise<(D3dVerdict | undefined)[]>
{
    const results: (D3dVerdict | undefined)[] = new Array(items.length).fill(undefined);
    let next = 0;
    const worker = async (): Promise<void> =>
    {
        for (;;)
        {
            const i = next++;

            if (i >= items.length)
                return;

            const f = join(dir, `${i}.hlsl`);
            writeFileSync(f, items[i].source);
            const t = performance.now();
            const r = await run(fxc, ['-nologo', ...(flags & 4 ? ['-Od'] : []), '-T', `${items[i].stage}_5_0`, '-E', 'main', '-Fo', 'NUL', f]);

            // (not run, or killed after the timeout: no verdict)
            if (r.code === -1 || r.code === null)
                continue;

            const errors = parseErrors(r.out);

            if (r.code !== 0 && !errors.length)
                errors.push(...refusal(r.out));

            results[i] = { ok: r.code === 0 && !errors.length, errors, ms: performance.now() - t };
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
    return results;
}

interface CacheFile
{
    tag: string;
    verdicts: Record<string, { ok: boolean; errors: D3dError[]; }>;
}

function loadCache(dir: string | undefined): { path: string; data: Map<string, { ok: boolean; errors: D3dError[]; }>; } | undefined
{
    if (!dir)
        return undefined;

    const path = join(dir, 'd3d-verdicts.json');
    const data = new Map<string, { ok: boolean; errors: D3dError[]; }>();

    try
    {
        const j = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;

        for (const [k, v] of Object.entries(j.verdicts ?? {}))
            data.set(k, v);
    }
    catch
    {
        // none yet, or unreadable: start again
    }

    return { path, data };
}

const tags = new Map<D3dBackend, string>();

/** names the compiler build: a new Windows or SDK changes what the cached verdicts mean */
function compilerTag(backend: D3dBackend): string
{
    const known = tags.get(backend);

    if (known)
        return known;

    let tag: string = backend;

    try
    {
        const p = backend === 'fxc' ? findFxc()! : dllPath;
        const st = statSync(p);
        tag = `${backend}:${st.size}:${Math.round(st.mtimeMs)}`;
    }
    catch
    {
        // (the plain name)
    }

    tags.set(backend, tag);
    return tag;
}

/**
 * Compiles HLSL sources the way the game does (`main`, vs_5_0 / ps_5_0) and returns one verdict per source, in order.
 * `ok: null` for all of them when this machine has no Direct3D compiler (not Windows, or the helper cannot run).
 */
export async function compileHlsl(items: D3dSource[], opts: D3dOptions = {}): Promise<D3dVerdict[]>
{
    const flags = opts.flags ?? DEFAULT_FLAGS;
    const backends = d3dBackends().filter((b) => !opts.backend || b === opts.backend);
    const unchecked = (): D3dVerdict => ({ ok: null, errors: [], ms: 0 });
    const out: D3dVerdict[] = items.map(unchecked);

    if (!items.length || !backends.length)
        return out;

    const cache = loadCache(opts.cacheDir);
    const jobs = Math.max(1, opts.jobs ?? Math.min(8, Math.max(1, cpus().length - 1)));
    const keys: string[] = [];
    const todo: number[] = [];
    const seen = new Map<string, number>();
    const same: [number, number][] = [];

    for (let i = 0; i < items.length; i++)
    {
        const key = createHash('sha1').update(`${items[i].stage}\0${flags}\0${items[i].source}`).digest('hex');
        keys.push(key);
        const hit = cache?.data.get(`${compilerTag(backends[0])}:${key}`);

        if (hit)
        {
            out[i] = { ok: hit.ok, errors: hit.errors, ms: 0, cached: true };
            continue;
        }

        // (equal sources are compiled once)
        const first = seen.get(key);

        if (first !== undefined)
            same.push([i, first]);
        else
        {
            seen.set(key, i);
            todo.push(i);
        }
    }

    if (todo.length)
    {
        const dir = mkdtempSync(join(tmpdir(), 'ckp-d3d-'));

        try
        {
            let backend: D3dBackend | undefined;
            let res: (D3dVerdict | undefined)[] = [];
            const batch = todo.map((i) => items[i]);

            for (const b of backends)
            {
                res = b === 'fxc' ? await viaFxc(findFxc()!, batch, flags, jobs, dir) : await viaD3dcompiler(batch, flags, jobs, dir);

                // (a helper that did not run at all: try the next backend)
                if (res.some((r) => r))
                {
                    backend = b;
                    break;
                }
            }

            if (backend)
                for (let k = 0; k < todo.length; k++)
                {
                    const v = res[k];

                    if (!v)
                        continue;

                    out[todo[k]] = v;
                    cache?.data.set(`${compilerTag(backend)}:${keys[todo[k]]}`, { ok: !!v.ok, errors: v.errors });
                }
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }

        for (const [i, first] of same)
            out[i] = { ...out[first], ms: 0, cached: true };

        if (cache)
        {
            try
            {
                mkdirSync(opts.cacheDir!, { recursive: true });
                const tmp = cache.path + '.tmp';
                writeFileSync(tmp, JSON.stringify({ tag: compilerTag(backends[0]), verdicts: Object.fromEntries(cache.data) } satisfies CacheFile));
                renameSync(tmp, cache.path);
            }
            catch
            {
                // a cache that cannot be written costs only time
            }
        }
    }
    else
        for (const [i, first] of same)
            out[i] = { ...out[first], ms: 0, cached: true };

    return out;
}
