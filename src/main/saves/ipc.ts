/**
 * IPC of the Save tab (channels `saves:*`, docs/saves.md): the user folder's save files, loading one into the index as
 * the top layer (a build), its pending changes (made through the usual editors; the index worker keeps them), undoing
 * them, writing the save with them to a new file. The dialogs start in the user folder's `save games`; test runs answer
 * them with CRUSADERPOPE_DIALOG_PATHS (`open`, `save`).
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { LoadedSave } from '../../shared/api.ts';
import { tr } from '../../shared/i18n.ts';
import { testDialog } from '../blender/ipc.ts';
import { listSaves, saveItem } from './list.ts';
import { installRakaly, latestRakaly, meltSave, rakalyInstalled } from './rakaly.ts';

/** `<name>_edited.ck3` next to it (`_edited_2` … when taken). */
function editedName(file: string): string
{
    const ext = extname(file);
    const stem = basename(file, ext).replace(/_edited(_\d+)?$/, '');

    for (let i = 1; ; i++)
    {
        const out = join(dirname(file), `${stem}_edited${i > 1 ? '_' + i : ''}${ext}`);

        if (!existsSync(out))
            return out;
    }
}

export interface SavesHost
{
    userDir: () => string | undefined;
    /** the loaded save's file (the setting) and, for a converted binary save, the save as chosen */
    loaded: () => string | undefined;
    loadedSource: () => string | undefined;
    /** loads a save into the index (null: unloads), a build; `source`: the binary save `file` was made from */
    setLoaded: (file: string | null, source?: string) => void;
    query: <T>(method: string, ...params: unknown[]) => Promise<T>;
    /** the app's data folder (rakaly, converted saves) */
    dataDir: () => string;
}

export function registerSavesIpc(host: SavesHost): void
{
    const saveDir = (): string | undefined => (host.userDir() ? join(host.userDir()!, 'save games') : undefined);
    const loadedNow = async (): Promise<LoadedSave> =>
    {
        const file = host.loaded();

        if (!file)
            return { loaded: false };

        const info = await host.query<{ file: string | null; date: string | null; players: number[]; problem: string | null; note?: string | null; }>('saveInfo').catch(() => null);
        const pending = info?.file ? await host.query<{ pending: number; edits: string[]; }>('savePending').catch(() => null) : null;
        return { file, ...(host.loadedSource() ? { source: host.loadedSource() } : {}), loaded: !!info?.file, date: info?.date ?? undefined, players: info?.players ?? [], problem: info?.problem ?? undefined, note: info?.note ?? undefined, pending: pending?.pending ?? 0, edits: pending?.edits ?? [] };
    };

    ipcMain.handle('saves:list', () =>
    {
        const dir = saveDir() ?? '';
        const saves = dir ? listSaves(dir, host.dataDir()) : [];
        // (a save loaded from elsewhere is listed too)
        const other = host.loadedSource() ?? host.loaded();

        if (other && existsSync(other) && !saves.some((s) => s.file.toLowerCase() === other.toLowerCase()) && !other.startsWith(join(host.dataDir(), 'melted')))
            saves.unshift(saveItem(other, host.dataDir()));

        return { dir, saves };
    });
    ipcMain.handle('saves:loaded', () => loadedNow());
    ipcMain.handle('saves:load', async (e, file?: string | null) =>
    {
        let path = file;

        // (undefined: asked for with the system dialog; null: unload)
        if (path === undefined)
        {
            const test = testDialog('open');

            if (test !== undefined)
                path = test ?? undefined;
            else
            {
                const dir = saveDir();
                const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
                    title: tr('Load a game save'),
                    defaultPath: dir && existsSync(dir) ? dir : undefined,
                    filters: [{ name: tr('Game saves'), extensions: ['ck3'] }],
                    properties: ['openFile']
                });
                path = r.canceled ? undefined : r.filePaths[0];
            }

            if (!path)
                return null;
        }

        if (path === null)
        {
            host.setLoaded(null);
            return { loaded: false, pending: 0, edits: [] };
        }

        // a binary save (autosave, ironman): its text copy, made with rakaly (asked for and downloaded by the Save tab)
        if (saveItem(path).binary)
        {
            const m = await meltSave(host.dataDir(), path);
            host.setLoaded(m.file, path);
            return { file: m.file, source: path, loaded: false, pending: 0, edits: [], ...(m.unknown ? { problem: tr('rakaly did not know every name in this save (a newer game patch): some show as hex codes') } : {}) };
        }

        host.setLoaded(path);
        return { file: path, loaded: false, pending: 0, edits: [] };
    });
    ipcMain.handle('saves:rakaly', () =>
    {
        const r = rakalyInstalled(host.dataDir());
        return r ? { installed: true, version: r.version } : { installed: false };
    });
    ipcMain.handle('saves:installRakaly', async () => ({ version: (await installRakaly(host.dataDir())).version }));
    ipcMain.handle('saves:rakalyLatest', async () => ({ version: await latestRakaly() }));
    // the last change of the loaded save taken back
    ipcMain.handle('saves:undoEdit', () => host.query('saveUndo'));
    // the loaded save with its changes written to a new file (no file: asks, next to the original)
    ipcMain.handle('saves:writeAs', async (e, file?: string) =>
    {
        // (next to the save as chosen: a binary save's, not its text copy's)
        const from = host.loadedSource() ?? host.loaded();

        if (!from)
            throw new Error(tr('No save is loaded'));

        let out = file;

        if (!out)
        {
            const test = testDialog('save');

            if (test !== undefined)
                out = test ?? undefined;
            else
            {
                const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender)!, {
                    title: tr('Write the save as'),
                    defaultPath: editedName(from),
                    filters: [{ name: tr('Game saves'), extensions: ['ck3'] }]
                });
                out = r.canceled ? undefined : r.filePath;
            }
        }

        return out ? host.query<{ file: string; bytes: number; }>('saveWrite', out) : null;
    });
}
