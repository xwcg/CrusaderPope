/**
 * Finding mods (docs/mods.md): outer descriptors in `<user>/mod/*.mod`, the Paradox Launcher's mod table (its
 * dirPath/archivePath win when a descriptor points somewhere stale), and Steam Workshop folders
 * (`steamapps/workshop/content/1158310/<id>`) nothing registers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ModInfo } from '../../shared/api.ts';
import { parseDescriptor, type ModDescriptor } from './descriptor.ts';
import type { LauncherMod } from './launcher.ts';
import { ZipArchive } from './zip.ts';

/** Steam app id of Crusader Kings III */
export const CK3_APP_ID = '1158310';

/** The user folder below Documents. */
export function defaultUserDir(documents: string): string
{
    return join(documents, 'Paradox Interactive', 'Crusader Kings III');
}

/** `steamapps/workshop/content/1158310` next to the game's `steamapps/common/<game>/game` folder. */
export function workshopDir(gameDir: string): string | undefined
{
    const steamapps = resolve(gameDir, '..', '..', '..');
    const dir = join(steamapps, 'workshop', 'content', CK3_APP_ID);
    return existsSync(dir) ? dir : undefined;
}

/** The game's version from launcher/launcher-settings.json (`rawVersion`). */
export function gameVersion(gameDir: string): string | undefined
{
    try
    {
        const j = JSON.parse(readFileSync(join(dirname(gameDir), 'launcher', 'launcher-settings.json'), 'utf8')) as { rawVersion?: string; };
        return j.rawVersion;
    }
    catch
    {
        return undefined;
    }
}

const isDir = (p: string | undefined): p is string => !!p && existsSync(p) && statSync(p).isDirectory();
const isFile = (p: string | undefined): p is string => !!p && existsSync(p) && statSync(p).isFile();

function readDescriptorFile(file: string): ModDescriptor | undefined
{
    try
    {
        return parseDescriptor(readFileSync(file, 'utf8'));
    }
    catch
    {
        return undefined;
    }
}

/** The inner descriptor.mod of a folder or zip (fills fields the outer one lacks). */
function innerDescriptor(root?: string, archive?: string): ModDescriptor | undefined
{
    if (root)
    {
        if (isFile(join(root, 'descriptor.mod')))
            return readDescriptorFile(join(root, 'descriptor.mod'));

        // some uploads carry their outer descriptor instead (Dragon Age: Thedas at War: `DA-TAW.mod`)
        let other: string | undefined;

        try
        {
            other = readdirSync(root).find((f) => /\.mod$/i.test(f) && isFile(join(root, f)));
        }
        catch
        {
            /* unreadable folder */
        }

        return other ? readDescriptorFile(join(root, other)) : undefined;
    }

    if (archive)
    {
        try
        {
            const zip = new ZipArchive(archive);

            try
            {
                const buf = zip.readEntry('descriptor.mod');
                return buf ? parseDescriptor(buf.toString('utf8')) : undefined;
            }
            finally
            {
                zip.close();
            }
        }
        catch
        {
            return undefined;
        }
    }

    return undefined;
}

function locate(p: string | undefined, userDir: string): string | undefined
{
    if (!p)
        return undefined;

    const abs = isAbsolute(p) ? p : join(userDir, p);
    return resolve(abs);
}

/**
 * The same place below this user folder's mod folder: descriptors keep absolute paths, which go stale when Documents
 * moves to another drive or profile (`F:/#Documents/…/Crusader Kings III/mod/cheat_menu`).
 */
function relocate(p: string | undefined, userDir: string): string | undefined
{
    const m = p ? /^.*[\\/]mod[\\/](.+)$/i.exec(p) : null;
    return m ? resolve(join(userDir, 'mod', m[1])) : undefined;
}

function modFrom(id: string, d: ModDescriptor, loc: { root?: string; archive?: string; }, extra: Partial<ModInfo>, userDir: string): ModInfo
{
    const root = isDir(loc.root) ? loc.root : undefined;
    const archive = !root && isFile(loc.archive) ? loc.archive : undefined;
    const inner = innerDescriptor(root, archive);
    const pick = <T>(a: T | undefined, b: T | undefined): T | undefined => (a !== undefined && a !== '' ? a : b);
    const picture = pick(d.picture, inner?.picture);
    const thumb = root ? [picture && join(root, picture), join(root, 'thumbnail.png')].find((p) => isFile(p || undefined)) : undefined;
    const modFolder = join(userDir, 'mod');
    const rel = root ? relative(modFolder, root) : '';
    return {
        id,
        name: pick(d.name, inner?.name) || id,
        version: pick(d.version, inner?.version),
        supportedVersion: pick(d.supportedVersion, inner?.supportedVersion),
        tags: d.tags.length ? d.tags : (inner?.tags ?? []),
        root,
        archive,
        remoteId: pick(d.remoteFileId, inner?.remoteFileId),
        source: 'local',
        replacePaths: d.replacePaths.length ? d.replacePaths : (inner?.replacePaths ?? []),
        status: root || archive ? 'ok' : 'missing',
        thumbnail: thumb || undefined,
        editable: !!root && !!rel && !rel.startsWith('..') && !isAbsolute(rel),
        ...extra
    };
}

/** Every mod the user has: registered descriptors, launcher entries, Workshop folders. */
export function discoverMods(userDir: string, gameDir: string, launcher: { mods: LauncherMod[]; } | null): ModInfo[]
{
    const out: ModInfo[] = [];
    const byRegistry = new Map((launcher?.mods ?? []).filter((m) => m.gameRegistryId).map((m) => [m.gameRegistryId!.replace(/\\/g, '/').toLowerCase(), m]));
    const usedLauncher = new Set<string>();
    const usedWorkshop = new Set<string>();
    const workshop = workshopDir(gameDir);
    const sourceOf = (lm: LauncherMod | undefined, file: string, root?: string): ModInfo['source'] =>
    {
        if (lm?.source === 'steam' || lm?.source === 'pdx')
            return lm.source;

        if (workshop && root && resolve(root).toLowerCase().startsWith(resolve(workshop).toLowerCase()))
            return 'steam';

        if (/^ugc_/i.test(file))
            return 'steam';

        if (/^pdx_/i.test(file))
            return 'pdx';

        return 'local';
    };

    // 1. registered descriptors
    const modDir = join(userDir, 'mod');
    const files = existsSync(modDir) ? readdirSync(modDir).filter((f) => /\.mod$/i.test(f)) : [];

    for (const f of files.sort())
    {
        const d = readDescriptorFile(join(modDir, f));

        if (!d)
            continue;

        const id = 'mod/' + f;
        const lm = byRegistry.get(id.toLowerCase());

        if (lm)
            usedLauncher.add(lm.id);

        // the descriptor's location, else the launcher's (mods moved by the launcher keep a stale descriptor)
        let root = locate(d.path, userDir);
        let archive = locate(d.archive, userDir);
        const stale = !isDir(root) && !isFile(archive);

        if (!isDir(root) && !isFile(archive) && lm)
        {
            root = lm.dirPath && isDir(lm.dirPath) ? lm.dirPath : root;
            archive = lm.archivePath && isFile(lm.archivePath) ? lm.archivePath : archive;

            // a launcher "archivePath" can also name a folder
            if (!isDir(root) && isDir(lm.archivePath))
                root = lm.archivePath;
        }

        if (!isDir(root) && !isFile(archive))
        {
            const r = relocate(d.path, userDir) ?? relocate(lm?.dirPath, userDir);
            const a = relocate(d.archive, userDir) ?? relocate(lm?.archivePath, userDir);

            if (isDir(r))
                root = r;
            else if (isFile(a))
                archive = a;
            else if (isDir(a))
                root = a;
        }

        const info = modFrom(id, d, { root, archive }, { descriptorFile: join(modDir, f), launcherId: lm?.id }, userDir);
        info.source = sourceOf(lm, f, info.root);

        if (stale && info.status === 'ok')
            info.staleLocation = d.path ?? d.archive ?? '(none)';

        if (lm?.thumbnailPath && !info.thumbnail && isFile(lm.thumbnailPath))
            info.thumbnail = lm.thumbnailPath;

        if (info.root && workshop)
            usedWorkshop.add(resolve(info.root).toLowerCase());

        out.push(info);
    }

    // 2. launcher entries without a descriptor file
    for (const lm of launcher?.mods ?? [])
    {
        if (usedLauncher.has(lm.id))
            continue;

        const root = lm.dirPath && isDir(lm.dirPath) ? lm.dirPath : undefined;
        const archive = !root && lm.archivePath && isFile(lm.archivePath) ? lm.archivePath : undefined;
        const d = innerDescriptor(root, archive) ?? { name: lm.displayName ?? lm.id, tags: lm.tags, replacePaths: [], dependencies: [], extra: [], version: lm.version, supportedVersion: lm.requiredVersion };
        const info = modFrom(lm.gameRegistryId ?? 'launcher/' + lm.id, { ...d, name: lm.displayName ?? d.name }, { root, archive }, { launcherId: lm.id }, userDir);
        info.source = lm.source === 'steam' || lm.source === 'pdx' ? lm.source : 'local';

        if (lm.thumbnailPath && !info.thumbnail && isFile(lm.thumbnailPath))
            info.thumbnail = lm.thumbnailPath;

        if (info.root)
            usedWorkshop.add(resolve(info.root).toLowerCase());

        out.push(info);
    }

    // 3. Workshop folders nothing points to (subscribed, launcher not run since)
    if (workshop)
    {
        for (const idDir of readdirSync(workshop))
        {
            const root = join(workshop, idDir);

            if (!isDir(root) || usedWorkshop.has(resolve(root).toLowerCase()))
                continue;

            const d = innerDescriptor(root);

            if (!d)
                continue;

            const info = modFrom('workshop/' + idDir, d, { root }, { remoteId: d.remoteFileId ?? idDir }, userDir);
            info.source = 'steam';
            out.push(info);
        }
    }

    return out;
}
