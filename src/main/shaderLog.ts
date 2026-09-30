/**
 * Shader error log (docs/shaders.md, "Error log"): `userData/logs/shaders.log` —
 *   COMPILE   the worker pipeline (effect → GLSL) failed, with the compiler's message
 *   SUMMARY   after indexing: programs in the store and every failure known (also ones loaded from the cache)
 *   WEBGL     the renderer's WebGL compile/link failed: info log and the source lines it points at
 *   GL-WARN / GL-ERROR   WebGL messages of the renderer console (GL_INVALID_OPERATION …, program info logs)
 *   CHECK     result of window.__shaderCheck() (every stored program compiled in WebGL once)
 * One header per session; an identical entry is written once per session. Above 4 MB the file moves to shaders.1.log.
 */
import { app } from 'electron';
import { appendFile } from 'node:fs/promises';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ShaderLogEntry } from '../shared/api.ts';

let file = '';
let queue: Promise<void> = Promise.resolve();
const seen = new Set<string>();

const pad = (n: number): string => String(n).padStart(2, '0');
const time = (d = new Date()): string => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function write(text: string): void
{
    if (!file)
        return;

    const f = file;
    queue = queue.then(() => appendFile(f, text, 'utf8')).catch(() =>
    {});
}

export function shaderLogPath(): string
{
    return file;
}

export function initShaderLog(): void
{
    file = join(app.getPath('userData'), 'logs', 'shaders.log');

    try
    {
        mkdirSync(dirname(file), { recursive: true });

        if (statSync(file).size > 4e6)
            renameSync(file, file.replace(/\.log$/, '.1.log'));
    }
    catch
    {
        /* new file */
    }

    const d = new Date();
    write(`\n=== ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time(d)} · session · CrusaderPope ${app.getVersion()} · Electron ${process.versions.electron}\n`);
}

export function logShader(e: ShaderLogEntry): void
{
    const key = e.kind + '\n' + e.title + '\n' + (e.detail ?? '');

    if (seen.has(key))
        return;

    seen.add(key);
    const detail = e.detail ? e.detail.replace(/\s+$/, '').replace(/^/gm, '    ') + '\n' : '';
    write(`[${time()}] ${e.kind.padEnd(8)} ${e.title}\n${detail}`);
}

/** WebGL messages of a window's console (the renderer's own GL errors and three.js program info logs). */
export function captureWebglConsole(wc: Electron.WebContents): void
{
    wc.on('console-message', (ev) =>
    {
        const { message, level } = ev as unknown as { message: string; level: string; };

        if (level !== 'warning' && level !== 'error')
            return;

        if (!/GL_[A-Z_]{3,}|\bWebGL:|THREE\.WebGL(Program|Shader)\b/.test(message))
            return;

        const [first, ...rest] = message.split('\n');
        logShader({ kind: level === 'error' ? 'GL-ERROR' : 'GL-WARN', title: first.trim().slice(0, 400), detail: rest.join('\n').trim() || undefined });
    });
}
