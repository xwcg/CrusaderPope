/**
 * Is the Paradox Launcher running? It keeps its playsets in memory and writes them back, so the app does not write the
 * launcher database while it runs (docs/mods.md, "Writing lists back").
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';

/** Launcher v2 executables: `Paradox Launcher.exe` (current), `dowser.exe` (older builds). */
const LAUNCHER = /^(paradox launcher|dowser)(\.exe)?$/i;

/** Image names of the running processes; null when the process list cannot be read. */
function processNames(): Promise<string[] | null>
{
    const [cmd, args] = process.platform === 'win32' ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-A', '-o', 'comm=']];
    return new Promise((resolve) =>
    {
        execFile(cmd, args, { windowsHide: true, timeout: 15_000, maxBuffer: 16 << 20 }, (err, stdout) =>
        {
            if (err)
                return resolve(null);

            const names = stdout
                .split(/\r?\n/)
                .map((line) => (process.platform === 'win32' ? (/^"([^"]*)"/.exec(line)?.[1] ?? '') : basename(line.trim())))
                .filter(Boolean);
            // (a system always runs processes: an empty list is output the parser did not understand)
            resolve(names.length ? names : null);
        });
    });
}

/**
 * The running launcher's process name; undefined when none runs; null when the process list cannot be read (then
 * nobody knows — writing the launcher database is refused unless the user says the launcher is closed).
 */
export async function runningLauncher(): Promise<string | null | undefined>
{
    const names = await processNames();
    return names ? names.find((n) => LAUNCHER.test(n)) : null;
}
