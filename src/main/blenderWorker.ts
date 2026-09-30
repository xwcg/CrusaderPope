/**
 * Worker thread for one Blender export or import (src/main/blender, docs/blender.md): decoding and encoding
 * textures, converting meshes and writing the export's files happen here, off the main process. Started per job by
 * src/main/blender/ipc.ts with the job as workerData; posts one message ({ result } or { error }) and ends.
 *
 * Game files come through the same layering as everywhere (docs/mods.md): the loaded mods' files first, then the
 * game with its engine layers.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeTexture } from './blender/textures.ts';
import { formatLabel, parseDds } from './images/dds.ts';
import { ddsTargetFor, encodeDds } from './images/ddsEncode.ts';
import { decodePng, encodePng, isPng } from './images/png.ts';
import { basename, dirname, join } from 'node:path';
import { GameFiles } from './mods/gamefiles.ts';
import { exportMesh } from './blender/exportMesh.ts';
import { importMesh } from './blender/importMesh.ts';
import type { ModInfo } from '../shared/api.ts';
import type { ModelExportPlan } from './blender/types.ts';

interface Job
{
    /** exportFile / replaceFile: an asset's ⋯ menu (one file) */
    op: 'export' | 'import' | 'exportFile' | 'replaceFile' | 'encodeScene';
    /** resolved game folder (…/game) */
    gameDir: string;
    mods: ModInfo[];
    plan: ModelExportPlan;
    /** export: the .gltf to write; import: the .gltf/.glb to read; exportFile: where to write; replaceFile: the user's file */
    file: string;
    /** import: ModInfo id of the mod written into */
    activeMod?: string;
    /** exportFile / replaceFile: the asset's game path */
    rel?: string;
    /** exportFile: as it is, or (textures) as PNG */
    as?: 'original' | 'png';
}

/** An asset's file: written out as it is (a texture as PNG on request). */
async function exportFile(vfs: GameFiles, job: Job): Promise<unknown>
{
    const f = vfs.get(job.rel!, { engine: true });
    const bytes = f && vfs.read(f);

    if (!bytes)
        throw new Error(`${job.rel} could not be read.`);

    let data: Uint8Array = bytes;

    if (job.as === 'png' && !isPng(bytes))
    {
        const { img } = await decodeTexture(bytes);
        data = encodePng(img.rgba, img.width, img.height);
    }

    mkdirSync(dirname(job.file), { recursive: true });
    writeFileSync(job.file, data);
    return { file: job.file, bytes: data.length };
}

/**
 * The user's file as the asset (`rel`): a texture converted to the asset's format (a PNG into the DDS's own format —
 * BC1 / BC3 with mips, else BGRA8 —, a DDS as it is; a DDS into a PNG asset decoded), a .mesh as it is (checked to be
 * one); saved under the asset's path and name, whatever the file was called.
 */
async function replaceFile(vfs: GameFiles, job: Job): Promise<unknown>
{
    const rel = job.rel!;
    const src = new Uint8Array(readFileSync(job.file));
    const f = vfs.get(rel, { engine: true });
    const orig = f && vfs.read(f);
    const given = basename(job.file);
    const notes: string[] = [];

    if (basename(rel).toLowerCase() !== given.toLowerCase())
        notes.push(`Saved as ${basename(rel)} (the file was ${given}).`);

    let data: Uint8Array;
    let what: string;

    if (/\.mesh$/i.test(rel))
    {
        if (!(src[0] === 0x40 && src[1] === 0x40 && src[2] === 0x62 && src[3] === 0x40))
            throw new Error(`${given} is no .mesh file (Paradox binary).`);

        data = src;
        what = 'mesh (as given)';
    }
    else if (/\.dds$/i.test(rel))
    {
        const isDds = src[0] === 0x44 && src[1] === 0x44 && src[2] === 0x53 && src[3] === 0x20;

        if (isDds)
        {
            data = src;
            const info = parseDds(src);
            what = `texture (DDS as given: ${formatLabel(info)}, ${info.width}×${info.height})`;
        }
        else if (isPng(src))
        {
            const img = decodePng(src);
            const info = orig ? parseDds(orig) : undefined;
            const target = ddsTargetFor(info, orig, img);
            data = encodeDds(img, target);
            what = `texture (PNG → DDS ${target.format}${target.mips ? ' with mips' : ''}, ${img.width}×${img.height})`;

            if (info && (info.width !== img.width || info.height !== img.height))
                notes.push(`The image is ${img.width}×${img.height}; the game's was ${info.width}×${info.height}.`);
        }
        else
            throw new Error(`${given} is neither a PNG nor a DDS image.`);
    }
    else if (/\.png$/i.test(rel))
    {
        if (isPng(src))
            data = src;
        else
        {
            const { img } = await decodeTexture(src);
            data = encodePng(img.rgba, img.width, img.height);
        }

        what = 'image (PNG)';
    }
    else
        throw new Error(`${rel}: this kind of file can't be replaced here (textures: .dds / .png, meshes: .mesh).`);

    return { writes: [{ rel, data, what }], shapes: [], removed: [], notes, warnings: [] };
}

/** An event scene from the user's image: a PNG as BC1 without mips (like the game's scenes), a DDS as it is. */
async function encodeScene(job: Job): Promise<unknown>
{
    const src = new Uint8Array(readFileSync(job.file));
    const notes: string[] = [];
    let data: Uint8Array;
    let what: string;

    if (src[0] === 0x44 && src[1] === 0x44 && src[2] === 0x53 && src[3] === 0x20)
    {
        data = src;
        const info = parseDds(src);
        what = `event scene (DDS as given: ${formatLabel(info)}, ${info.width}×${info.height})`;
    }
    else if (isPng(src))
    {
        const img = decodePng(src);
        data = encodeDds(img, { format: 'BC1', mips: false });
        what = `event scene (PNG → DDS BC1, ${img.width}×${img.height})`;

        if (img.width !== 1592 || img.height !== 848)
            notes.push(`The image is ${img.width}×${img.height}; the game's scenes are 1592×848.`);
    }
    else
        throw new Error(`${basename(job.file)} is neither a PNG nor a DDS image.`);

    return { writes: [{ rel: job.rel!, data, what }], shapes: [], removed: [], notes, warnings: [] };
}

async function run(job: Job): Promise<unknown>
{
    if (job.op === 'encodeScene')
        return encodeScene(job);

    const vfs = new GameFiles(job.gameDir, job.mods);

    try
    {
        if (job.op === 'exportFile')
            return await exportFile(vfs, job);

        if (job.op === 'replaceFile')
            return await replaceFile(vfs, job);

        const read = (path: string): Uint8Array | undefined => vfs.read(path, { engine: true });
        const meshFile = vfs.get(job.plan.mesh, { engine: true });
        const meshBytes = meshFile && vfs.read(meshFile);

        if (!meshFile || !meshBytes)
            throw new Error(`${job.plan.mesh} could not be read.`);

        if (job.op === 'export')
        {
            const dir = dirname(job.file);
            const name = basename(job.file).replace(/\.(gltf|glb)$/i, '');
            const r = await exportMesh({ plan: job.plan, meshBytes, meshWhere: vfs.where(meshFile), read, name });
            mkdirSync(dir, { recursive: true });
            const files: string[] = [];

            for (const f of r.files)
            {
                writeFileSync(join(dir, f.name), f.data);
                files.push(join(dir, f.name));
            }

            return { gltf: join(dir, name + '.gltf'), files, counts: r.counts, warnings: r.warnings };
        }

        const out = await importMesh({ plan: job.plan, meshBytes, gltfPath: job.file, read });
        // a later mod of the loaded list with the same file keeps winning over the active mod's
        const active = vfs.sources.findIndex((s) => s.modId && s.modId.toLowerCase() === job.activeMod?.toLowerCase());

        if (active > 0)
        {
            for (const w of out.writes)
            {
                const f = vfs.get(w.rel, { engine: true });

                if (f && f.source > active)
                    out.notes.push(`${vfs.sources[f.source].name} loads after ${vfs.sources[active].name} and has ${w.rel} too, so its version keeps winning — move ${vfs.sources[active].name} below it in the load order.`);
            }
        }

        return out;
    }
    finally
    {
        vfs.close();
    }
}

run(workerData as Job).then(
    (result) =>
    {
        // (the written files' bytes move to the main process instead of being copied)
        const transfer = ((result as { writes?: { data: Uint8Array; }[]; }).writes ?? []).map((w) => w.data.buffer as ArrayBuffer);
        parentPort!.postMessage({ result }, [...new Set(transfer)]);
    },
    (err) => parentPort!.postMessage({ error: String((err as Error)?.message ?? err) })
);
