/**
 * IPC of the Mods view (channels `mods:*`, src/preload/index.ts): the manager's operations and editing the active
 * mod (edit.ts), one at a time, and what needs Electron — opening a mod's folder, thumbnails as data URLs.
 */
import { ipcMain, nativeImage, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import type { DuplicateEntryRequest, DuplicateRequest, EntryCreate, FireRequest, LineSource, MapEditRequest, NewEntryRequest, OverrideRequest, ScriptEditRequest } from '../../shared/api.ts';
import { createMod, deleteList, modLocation, modsState, packMod, saveList, selectList, setActive, thumbnailFile, unpackMod, writeList, type ModsHost } from './manager.ts';
import { applyOverride, planOverride } from './edit.ts';
import { editLoc, editScript, fireEvent, statementText, unfireEvent } from './scriptEdit.ts';
import { forgetChange, undoChange } from './undo.ts';
import { createEntries, createEntry, duplicateEntry, duplicateEvent, newEntryPlan } from './create.ts';
import { mapEdit } from '../map/edit.ts';

export function registerModsIpc(host: ModsHost): void
{
    // one operation at a time: each reads the state, may write files and compares what the index loads
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> =>
    {
        const run = queue.then(fn, fn);
        queue = run.catch(() => undefined);
        return run;
    };
    const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => Promise<unknown>): void =>
    {
        ipcMain.handle(channel, (_e, ...args: unknown[]) => serial(() => fn(...(args as A))));
    };
    handle('mods:state', () => modsState(host));
    handle('mods:select', (ref: string) => selectList(host, ref));
    handle('mods:saveList', (list: Parameters<typeof saveList>[1]) => saveList(host, list));
    handle('mods:deleteList', (ref: string) => deleteList(host, ref));
    handle('mods:writeList', (ref: string, target: 'launcher' | 'game', mods: Parameters<typeof writeList>[3], opts?: Parameters<typeof writeList>[4]) => writeList(host, ref, target, mods, opts));
    handle('mods:setActive', (id: string | null) => setActive(host, id));
    handle('mods:create', (req: Parameters<typeof createMod>[1]) => createMod(host, req));
    handle('mods:pack', (id: string, overwrite?: boolean) => packMod(host, id, overwrite));
    handle('mods:unpack', (id: string) => unpackMod(host, id));
    handle('mods:overridePlan', (type: string, name: string) => planOverride(host, type, name));
    handle('mods:override', (req: OverrideRequest) => applyOverride(host, req));
    handle('mods:createEntries', (creates: EntryCreate[]) => createEntries(host, creates));
    handle('mods:editLoc', (key: string, text: string) => editLoc(host, { key, text }));
    handle('mods:fireEvent', (req: FireRequest) => fireEvent(host, req));
    handle('mods:unfireEvent', (event: string, onAction: string) => unfireEvent(host, { event, onAction }));
    handle('mods:newEntryPlan', (type: string) => newEntryPlan(host, type));
    handle('mods:createEntry', (req: NewEntryRequest) => createEntry(host, req));
    handle('mods:duplicateEvent', (req: DuplicateRequest) => duplicateEvent(host, req));
    handle('mods:duplicateEntry', (req: DuplicateEntryRequest) => duplicateEntry(host, req));
    // editing from the map (map/edit.ts)
    handle('mods:mapEdit', (req: MapEditRequest) => mapEdit(host, req));
    // editing in place (scriptEdit.ts)
    handle('mods:scriptText', (at: LineSource) => statementText(host, at));
    handle('mods:editScript', (req: ScriptEditRequest) => editScript(host, req));
    // undo (undo.ts): a change by its step, else the active mod's last one
    handle('mods:undo', (step?: number) => undoChange(host, step !== undefined ? { id: step } : { mod: host.settings().activeMod ?? '' }));
    handle('mods:forgetChange', async (step: number) => forgetChange(host, step));
    handle('mods:openFolder', async (id: string) =>
    {
        const loc = await modLocation(host, id);

        if (loc.folder)
        {
            const err = await shell.openPath(loc.folder);

            if (err)
                throw new Error(err);
        }
        else if (loc.file)
            shell.showItemInFolder(loc.file);
    });
    // thumbnails are absolute files anywhere on disk: only a discovered mod's preview, scaled down
    ipcMain.handle('mods:thumbnail', async (_e, id: string) =>
    {
        const file = await thumbnailFile(host, id);

        if (!file)
            return null;

        const img = nativeImage.createFromPath(file);

        if (!img.isEmpty())
            return (img.getSize().width > 256 ? img.resize({ width: 256, quality: 'good' }) : img).toDataURL();

        // formats nativeImage cannot decode (Workshop "thumbnail.png" files that are WebP): the bytes, for the browser
        try
        {
            const buf = await readFile(file);
            const type = imageType(buf);
            return type && buf.length <= 3 << 20 ? `data:${type};base64,${buf.toString('base64')}` : null;
        }
        catch
        {
            return null;
        }
    });
}

/** Image type by signature (not by the file's extension). */
function imageType(b: Buffer): string | undefined
{
    if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47)
        return 'image/png';

    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return 'image/jpeg';

    if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
        return 'image/webp';

    if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8')
        return 'image/gif';

    if (b.length >= 2 && b.toString('latin1', 0, 2) === 'BM')
        return 'image/bmp';

    return undefined;
}
