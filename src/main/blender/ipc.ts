/**
 * The model page's Blender round trip (docs/blender.md), main process side: native file dialogs, the index worker's
 * export plan (what the model is made of), one Blender worker thread per job (conversion off the main process), and
 * writing an import into the active mod (docs/mods.md, "Editing the active mod"). Also an asset's ⋯ menu (textures,
 * meshes): export the file as it is (or a texture as PNG), and replace it in the active mod with a file of the user's —
 * converted to the asset's format and saved under its path and name.
 *
 * Test hook: CRUSADERPOPE_DIALOG_PATHS=<json file> answers the dialogs without opening them — `{ "save": path,
 * "open": path }` (a list is used in order, its last entry repeats; "" or null = cancelled). The file is read at
 * every dialog, so a test can change it between steps.
 */
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { decodeDds } from '../images/dds.ts';
import { encodePng } from '../images/png.ts';
import { basename, dirname, extname, join } from 'node:path';
import type { AssetOverride, ImageSource, ModInfo, ModelExportResult, ModelImportPlan, ModelImportResult, PickedImage } from '../../shared/api.ts';
import type { ModsHost } from '../mods/manager.ts';
import { activeMod, fileTag, modPath, write as writeModFile, type Active } from '../mods/edit.ts';
import { change, recordRemove } from '../mods/undo.ts';
import type { ImportOutcome, ModelExportPlan } from './types.ts';

export interface BlenderHost
{
    mods: ModsHost;
    /** the enabled mods of the loaded list (what the explorer shows) */
    loadedMods(): Promise<ModInfo[]>;
    /** query to the index worker */
    query<T>(method: string, ...params: unknown[]): Promise<T>;
    /** the worker bundle (out/main/blenderWorker.js) */
    workerFile: string;
}

const dialogUses: Record<string, number> = {};

/** The test hook's answer: a path, null (cancelled), undefined (no hook: show the dialog). */
function testDialog(kind: 'save' | 'open'): string | null | undefined
{
    const file = process.env.CRUSADERPOPE_DIALOG_PATHS;

    if (!file)
        return undefined;

    let v: unknown;

    try
    {
        v = JSON.parse(readFileSync(file, 'utf8'))[kind];
    }
    catch
    {
        return null;
    }

    if (Array.isArray(v))
    {
        const i = dialogUses[kind] ?? 0;
        dialogUses[kind] = i + 1;
        v = v[Math.min(i, v.length - 1)];
    }

    return typeof v === 'string' && v ? v : null;
}

/** folders used last (per session): exports go there again, imports start there */
let lastExportDir = '';
let lastImportDir = '';

function runJob<T>(host: BlenderHost, job: Record<string, unknown>): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        const w = new Worker(host.workerFile, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
        let done = false;
        w.once('message', (m: { result?: T; error?: string; }) =>
        {
            done = true;
            void w.terminate();

            if (m.error !== undefined)
                reject(new Error(m.error));
            else
                resolve(m.result as T);
        });
        w.once('error', (err) =>
        {
            done = true;
            reject(err);
        });
        w.once('exit', (code) =>
        {
            if (!done)
                reject(new Error(`The conversion stopped (exit code ${code}).`));
        });
    });
}

async function plan(host: BlenderHost, path: string, pdxmesh?: string): Promise<ModelExportPlan>
{
    const p = await host.query<ModelExportPlan | null>('modelExportPlan', path, pdxmesh);

    if (!p)
        throw new Error(`${path}: no mesh to convert (the index is not ready, or the model has no .mesh file).`);

    return p;
}

const gameDirOf = (host: BlenderHost): string =>
{
    const d = host.mods.gameDir();

    if (!d)
        throw new Error('No Crusader Kings III folder configured.');

    return d;
};

async function importPlan(host: BlenderHost, path: string, pdxmesh?: string): Promise<{ plan: ModelImportPlan; active?: Active; model?: ModelExportPlan; }>
{
    const a = await activeMod(host.mods);

    if (typeof a === 'string')
        return { plan: { problem: a } };

    const mod = { id: a.mod.id, name: a.mod.name, loaded: a.loaded };
    let model: ModelExportPlan;

    try
    {
        model = await plan(host, path, pdxmesh);
    }
    catch (e)
    {
        return { plan: { mod, problem: (e as Error).message } };
    }

    if (!modPath(a, model.mesh))
        return { plan: { mod, problem: `${model.mesh} is not a path inside the mod folder.` } };

    return { plan: { mod, mesh: model.mesh }, active: a, model };
}

export function registerBlenderIpc(host: BlenderHost): void
{
    /** "Export for Blender": the glTF of a mesh (or an asset's pdxmesh) into a folder the user picks. */
    const exportGltf = async (e: Electron.IpcMainInvokeEvent, path: string, pdxmesh?: string): Promise<ModelExportResult | null> =>
    {
        const model = await plan(host, path, pdxmesh);
        const name = basename(model.mesh).replace(/\.mesh$/i, '');
        let file = testDialog('save');

        if (file === undefined)
        {
            const win = BrowserWindow.fromWebContents(e.sender)!;
            const r = await dialog.showSaveDialog(win, {
                title: 'Export for Blender — the .gltf, its .bin, the textures as PNG and a manifest go into this folder',
                defaultPath: join(lastExportDir || app.getPath('documents'), name + '.gltf'),
                filters: [{ name: 'glTF 2.0 (separate files)', extensions: ['gltf'] }],
                properties: ['createDirectory', 'showOverwriteConfirmation']
            });
            file = r.canceled || !r.filePath ? null : r.filePath;
        }

        if (!file)
            return null;

        if (!/\.gltf$/i.test(file))
            file = file.replace(/\.glb$/i, '') + '.gltf';

        lastExportDir = dirname(file);
        return runJob<ModelExportResult>(host, { op: 'export', gameDir: gameDirOf(host), mods: await host.loadedMods(), plan: model, file });
    };

    /** Writes a job's files into the active mod (every path checked before the first write) and hands them to the index. */
    const writeIntoMod = async (a: Active, source: string, out: ImportOutcome): Promise<ModelImportResult> =>
    {
        const files: ModelImportResult['files'] = [];

        for (const w of out.writes)
        {
            const abs = modPath(a, w.rel);

            if (!abs)
                throw new Error(`${w.rel} is not a path inside the mod folder.`);

            files.push({ rel: w.rel, abs, what: w.what });
        }

        out.writes.forEach((w, i) => writeModFile(host.mods, files[i].abs, w.data));

        if (a.loaded)
            await host.mods.refreshFiles?.(files.map((f) => f.abs));

        return {
            mod: { id: a.mod.id, name: a.mod.name, loaded: a.loaded },
            source,
            files,
            shapes: out.shapes,
            removed: out.removed,
            notes: out.notes,
            warnings: out.warnings,
            reindex: a.loaded
        };
    };

    /** "Import from Blender": a glTF / GLB (chosen now, or `file`) converted into the mesh and textures of the model. */
    const importGltf = async (e: Electron.IpcMainInvokeEvent, path: string, pdxmesh?: string, given?: string): Promise<ModelImportResult | null> =>
    {
        const { plan: p, active: a, model } = await importPlan(host, path, pdxmesh);

        if (p.problem || !a || !model)
            throw new Error(p.problem ?? 'Nothing to import into.');

        let file = given ?? testDialog('open');

        if (file === undefined)
        {
            const win = BrowserWindow.fromWebContents(e.sender)!;
            const r = await dialog.showOpenDialog(win, {
                title: `Import from Blender into ${a.mod.name} — ${model.mesh}`,
                defaultPath: lastImportDir || lastExportDir || app.getPath('documents'),
                filters: [{ name: 'glTF 2.0', extensions: ['glb', 'gltf'] }],
                properties: ['openFile']
            });
            file = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
        }

        if (!file)
            return null;

        lastImportDir = dirname(file);
        const out = await runJob<ImportOutcome>(host, { op: 'import', gameDir: gameDirOf(host), mods: await host.loadedMods(), plan: model, file, activeMod: a.mod.id });
        return writeIntoMod(a, file, out);
    };

    ipcMain.handle('model:export', (e, path: string, pdxmesh?: string) => exportGltf(e, path, pdxmesh));
    ipcMain.handle('model:importPlan', async (_e, path: string, pdxmesh?: string) => (await importPlan(host, path, pdxmesh)).plan);
    // (what an import writes is one undo step — mods/undo.ts)
    ipcMain.handle('model:import', (e, path: string, pdxmesh?: string) => change(host.mods, `Import into ${basename(path)}`, 'import', () => importGltf(e, path, pdxmesh)));

    // ---------------------------------------------------------------------------
    // an asset's ⋯ menu (textures, meshes): export it, replace it with a file
    // ---------------------------------------------------------------------------

    /** The file an asset stands for: an image or a .mesh as it is, an .asset's pdxmesh's .mesh. */
    const fileOf = async (path: string, pdxmesh?: string): Promise<string> => (/\.asset$/i.test(path) ? (await plan(host, path, pdxmesh)).mesh : path);

    ipcMain.handle('asset:export', async (e, path: string, as: 'original' | 'png' | 'gltf', pdxmesh?: string): Promise<{ file: string; gltf?: ModelExportResult; } | null> =>
    {
        if (as === 'gltf')
        {
            const r = await exportGltf(e, path, pdxmesh);
            return r && { file: r.gltf, gltf: r };
        }

        const rel = await fileOf(path, pdxmesh);
        const name = basename(rel).replace(as === 'png' ? /\.\w+$/ : /$^/, as === 'png' ? '.png' : '');
        let file = testDialog('save');

        if (file === undefined)
        {
            const win = BrowserWindow.fromWebContents(e.sender)!;
            const ext = as === 'png' ? 'png' : (extname(rel).slice(1) || '*');
            const r = await dialog.showSaveDialog(win, {
                title: as === 'png' ? `Export ${basename(rel)} as PNG` : `Export ${basename(rel)}`,
                defaultPath: join(lastExportDir || app.getPath('documents'), name),
                filters: [{ name: as === 'png' ? 'PNG image' : ext.toUpperCase() + ' file', extensions: [ext] }],
                properties: ['createDirectory', 'showOverwriteConfirmation']
            });
            file = r.canceled || !r.filePath ? null : r.filePath;
        }

        if (!file)
            return null;

        lastExportDir = dirname(file);
        await runJob(host, { op: 'exportFile', gameDir: gameDirOf(host), mods: await host.loadedMods(), rel, as, file });
        return { file };
    });

    /** The active mod's own file for the asset (its override), if it has one. */
    ipcMain.handle('asset:override', async (_e, path: string, pdxmesh?: string): Promise<AssetOverride | null> =>
    {
        const a = await activeMod(host.mods);

        if (typeof a === 'string')
            return null;

        const rel = await fileOf(path, pdxmesh);
        const abs = modPath(a, rel);
        return { rel, mod: a.mod.name, file: abs && existsSync(abs) ? abs : undefined };
    });

    /** Removes the active mod's file for the asset (to the recycle bin): the game's — or an earlier mod's — file counts again. */
    ipcMain.handle('asset:removeOverride', (_e, path: string, pdxmesh?: string): Promise<AssetOverride & { loaded: boolean; step?: number; }> =>
        change(host.mods, `Removed ${basename(path)}`, 'asset', async () =>
        {
            const a = await activeMod(host.mods);

            if (typeof a === 'string')
                throw new Error(a);

            const rel = await fileOf(path, pdxmesh);
            const abs = modPath(a, rel);

            if (!abs || !existsSync(abs))
                throw new Error(`${a.mod.name} has no file ${rel}.`);

            // (the folder watcher: the app's own change; the undo step brings it back)
            host.mods.wrote?.([abs]);
            await recordRemove(host.mods, abs, async () =>
            {
                try
                {
                    await shell.trashItem(abs);
                }
                catch
                {
                    unlinkSync(abs);
                }
            });

            if (a.loaded)
                await host.mods.refreshFiles?.([abs]);

            return { rel, mod: a.mod.name, file: abs, loaded: a.loaded };
        }));

    /**
     * An image of the user's for the crop & rotate dialog (a new event scene, a replaced texture — docs/mods.md "Crop
     * and rotate"): chosen in an open dialog, a DDS decoded to PNG (the renderer shows it), PNG / JPEG / WebP as they are.
     */
    ipcMain.handle('asset:pickImage', async (e, title?: string): Promise<PickedImage | null> =>
    {
        let file = testDialog('open');

        if (file === undefined)
        {
            const win = BrowserWindow.fromWebContents(e.sender)!;
            const r = await dialog.showOpenDialog(win, {
                title: title ?? 'An image',
                defaultPath: lastImportDir || app.getPath('pictures'),
                filters: [{ name: 'Images (PNG, DDS, JPEG, WebP)', extensions: ['png', 'dds', 'jpg', 'jpeg', 'webp'] }],
                properties: ['openFile']
            });
            file = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
        }

        if (!file)
            return null;

        lastImportDir = dirname(file);
        const bytes = new Uint8Array(readFileSync(file));
        const name = basename(file);

        if (bytes[0] === 0x44 && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x20)
        {
            const d = await decodeDds(bytes);
            return { file, name, mime: 'image/png', data: new Uint8Array(encodePng(d.rgba, d.width, d.height)) };
        }

        const mime = /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png';
        return { file, name, mime, data: bytes };
    });

    /** A cropped image (PNG bytes from the crop dialog) as a file the jobs read: the temp folder, under the picked name. */
    const croppedFile = (source: ImageSource): string =>
    {
        const dir = join(app.getPath('temp'), 'crusaderpope-crops');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${(source.name ?? 'image').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_')}.png`);
        writeFileSync(file, source.png!);
        return file;
    };

    ipcMain.handle('asset:replace', (e, path: string, pdxmesh?: string, source?: ImageSource): Promise<ModelImportResult | null> => change(host.mods, `Replaced ${basename(path)}`, 'asset', () => replaceAsset(e, path, pdxmesh, source)));

    /** An asset replaced by a file of the user's (asset:replace). */
    const replaceAsset = async (e: Electron.IpcMainInvokeEvent, path: string, pdxmesh?: string, source?: ImageSource): Promise<ModelImportResult | null> =>
    {
        const a = await activeMod(host.mods);

        if (typeof a === 'string')
            throw new Error(a);

        const rel = await fileOf(path, pdxmesh);

        if (!modPath(a, rel))
            throw new Error(`${rel} is not a path inside the mod folder.`);

        const mesh = /\.mesh$/i.test(rel);
        // (from the crop dialog: its PNG, or the picked file as it is)
        let file = source?.png ? croppedFile(source) : (source?.file ?? testDialog('open'));

        if (file === undefined)
        {
            const win = BrowserWindow.fromWebContents(e.sender)!;
            const r = await dialog.showOpenDialog(win, {
                title: `Replace ${rel} in ${a.mod.name} — saved under that name, converted where needed`,
                defaultPath: lastImportDir || lastExportDir || app.getPath('documents'),
                filters: mesh ? [{ name: 'Meshes (.mesh, glTF 2.0)', extensions: ['mesh', 'gltf', 'glb'] }] : [{ name: 'Images (PNG, DDS)', extensions: ['png', 'dds'] }],
                properties: ['openFile']
            });
            file = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
        }

        if (!file)
            return null;

        lastImportDir = dirname(file);

        // a glTF / GLB: the Blender import (the model's mesh and its textures)
        if (mesh && /\.(gltf|glb)$/i.test(file))
            return importGltf(e, /\.asset$/i.test(path) ? path : rel, pdxmesh, file);

        const out = await runJob<ImportOutcome>(host, { op: 'replaceFile', gameDir: gameDirOf(host), mods: await host.loadedMods(), rel, file });
        return writeIntoMod(a, file, out);
    };
    /**
     * An event's scene from an image file of the user's (the event card's "Change scene…" → "From an image file…"):
     * encoded like the game's scenes (DDS BC1 without mips; a DDS as it is) into
     * `gfx/interface/illustrations/event_scenes/<mod>_<event>.dds` of the active mod, registered as an event background
     * `<mod>_<event>` in `common/event_backgrounds/<mod>_event_backgrounds.txt` (the event's current background's
     * environment — the portraits' lighting — else a courtyard's). The caller points the event at it.
     */
    ipcMain.handle('asset:eventScene', (e, eventType: string, eventName: string, source?: ImageSource): Promise<{ reference: string; files: string[]; notes: string[]; } | null> => change(host.mods, `New scene for ${eventName}`, 'asset', () => eventScene(e, eventType, eventName, source)));

    /** asset:eventScene */
    const eventScene = async (e: Electron.IpcMainInvokeEvent, eventType: string, eventName: string, source?: ImageSource): Promise<{ reference: string; files: string[]; notes: string[]; } | null> =>
    {
        const a = await activeMod(host.mods);

        if (typeof a === 'string')
            throw new Error(a);

        // (from the crop dialog: its PNG, or the picked file as it is)
        let file = source?.png ? croppedFile(source) : (source?.file ?? testDialog('open'));

        if (file === undefined)
        {
            const win = BrowserWindow.fromWebContents(e.sender)!;
            const r = await dialog.showOpenDialog(win, {
                title: `A scene image for ${eventName} (the game's are 1592×848)`,
                defaultPath: lastImportDir || app.getPath('pictures'),
                filters: [{ name: 'Images (PNG, DDS)', extensions: ['png', 'dds'] }],
                properties: ['openFile']
            });
            file = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
        }

        if (!file)
            return null;

        lastImportDir = dirname(file);
        const tag = fileTag(a);
        // (an event named after the mod already: not twice)
        const base = eventName.replace(/[^A-Za-z0-9_]+/g, '_').toLowerCase();
        const reference = base.startsWith(tag.toLowerCase() + '_') ? base : `${tag}_${base}`.toLowerCase();
        const rel = `gfx/interface/illustrations/event_scenes/${reference}.dds`;
        const out = await runJob<ImportOutcome>(host, { op: 'encodeScene', gameDir: gameDirOf(host), mods: [], rel, file });
        const res = await writeIntoMod(a, file, out);
        const current = await host.query<{ environment?: string; } | null>('eventBackground', eventType, eventName);
        const env = current?.environment ?? 'environment_event_courtyard';
        const bgRel = `common/event_backgrounds/${tag}_event_backgrounds.txt`;
        const bgFile = modPath(a, bgRel)!;
        const cur = existsSync(bgFile) ? readFileSync(bgFile, 'utf8').replace(/^\uFEFF/, '') : '';

        // (made again for the same event: its entry is there)
        if (!new RegExp(`^${reference} = \\{`, 'm').test(cur))
        {
            const head = cur ? cur.replace(/\s*$/, '') + '\n\n' : `# ${a.mod.name}: event scenes (written by CrusaderPope)\n\n`;
            writeModFile(host.mods, bgFile, '\uFEFF' + head + `${reference} = {\n\tbackground = {\n\t\treference = "${rel}"\n\t\tenvironment = "${env}"\n\t}\n}\n`);

            if (a.loaded)
                await host.mods.refreshFiles?.([bgFile]);
        }

        return { reference, files: [...res.files.map((f) => f.abs), bgFile], notes: [...res.notes, `Registered as the event background “${reference}” (${bgRel}).`] };
    };
}
