/**
 * Mod rules shared by the main process and the Mods view (docs/mods.md): folder names of new mods, descriptor text
 * values, `supported_version` checks against the game version.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Why a folder name cannot be used for a new mod in the user's mod folder (undefined = fine). */
export function modFolderProblem(folder: string): string | undefined
{
    if (!folder)
        return 'Enter a folder name.';

    if (folder.length > 64)
        return 'The folder name is too long (64 characters at most).';

    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(folder))
        return 'Use letters, digits, "_", "-" and "." only, starting with a letter or digit.';

    if (folder.endsWith('.'))
        return 'The folder name cannot end with a dot.';

    if (/\.mod$/i.test(folder) || /\.zip$/i.test(folder))
        return 'Leave out the extension: the descriptor becomes <folder>.mod.';

    if (RESERVED.test(folder.replace(/\..*$/, '')))
        return `"${folder}" is a reserved name on Windows.`;

    return undefined;
}

/** A folder name for a mod name: `My Cool Mod!` → `my_cool_mod`. */
export function folderFromName(name: string): string
{
    return name
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
}

/** Descriptor values are written quoted on one line: no double quotes or line breaks. */
export function descriptorTextProblem(label: string, value: string): string | undefined
{
    return /["\r\n]/.test(value) ? `${label}: double quotes and line breaks are not allowed.` : undefined;
}

/**
 * Whether a descriptor's `supported_version` fits the game version, component by component: `*` matches anything,
 * components the descriptor leaves out match anything (`1.19` fits 1.19.0.6), a leading `v` is ignored.
 * undefined = nothing to compare.
 */
export function versionMatches(supported: string | undefined, game: string | undefined): boolean | undefined
{
    if (!supported?.trim() || !game?.trim())
        return undefined;

    const want = supported.trim()
        .replace(/^v/i, '')
        .split('.');
    const have = game.trim()
        .replace(/^v/i, '')
        .split('.');

    for (let i = 0; i < want.length; i++)
    {
        const w = want[i].trim();

        if (w === '*')
            continue;

        const h = have[i];

        if (h === undefined)
            return w === '0';

        const same = /^\d+$/.test(w) && /^\d+$/.test(h) ? Number(w) === Number(h) : w.toLowerCase() === h.toLowerCase();

        if (!same)
            return false;
    }

    return true;
}

/** The game's major.minor with a wildcard patch: `1.19.0.6` → `1.19.*` (the usual supported_version of a new mod). */
export function supportedVersionFor(game: string | undefined): string
{
    const m = /^v?(\d+)\.(\d+)/i.exec(game?.trim() ?? '');
    return m ? `${m[1]}.${m[2]}.*` : '';
}
