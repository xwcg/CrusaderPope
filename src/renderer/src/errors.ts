/**
 * Error texts for the user. No component imports, so non-component modules (scriptEdits.ts) can use it too.
 */

/** An IPC error without Electron's "Error invoking remote method …" wrapper. */
export function errorText(e: unknown): string
{
    const m = e instanceof Error ? e.message : String(e);
    return m.replace(/^Error invoking remote method '[^']*': /, '').replace(/^Error: /, '');
}
