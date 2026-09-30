/**
 * Worker thread that turns game images (DDS/PNG) into PNGs for the renderer (served via the ck3:// protocol).
 * Keeps decoding off the main process. Thumbnails are cached on disk (userData/imgcache).
 *
 * Game paths resolve through the layering of the loaded mods (docs/mods.md): a mod's file of the same path wins over
 * the game's, the game folder over its DLC folders, jomini and clausewitz; files inside packed mods are read from the
 * zip.
 */
import { parentPort } from 'node:worker_threads';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { IMAGE_EXT } from './images/files.ts';
import { decodeDds, downscale, formatLabel, parseDds } from './images/dds.ts';
import { encodePng } from './images/png.ts';
import { GameFiles, type GameFile } from './mods/gamefiles.ts';
import type { ModInfo } from '../shared/api.ts';

interface Req
{
    id: number;
    op: 'init' | 'img' | 'info' | 'forget';
    gameDir?: string;
    /** forget: lower case game paths of changed files */
    rels?: string[];
    cacheDir?: string;
    /** enabled mods of the loaded list, in load order */
    mods?: ModInfo[];
    rel?: string;
    w?: number;
    /** cubemap face 0..5 */
    face?: number;
    /** one channel as opaque grey ('r' 'g' 'b' 'a'), or 'rgb' without alpha */
    ch?: string;
    /** the picture a mod's replace_path removed (the file the path had before — GameFiles.former) */
    removed?: boolean;
}

let vfs: GameFiles | null = null;
/** resolved game paths (lower case; `!` + path: removed pictures) — the worker restarts with every index build */
const resolved = new Map<string, GameFile | null>();
let cacheDir = '';

/**
 * The file the game loads for an image path: gfx only, mods first, then the game with its engine layers. `removed`: the
 * file a mod's replace_path hid (the galleries show removed pictures as removed).
 */
function resolve(rel: string, removed = false): GameFile | undefined
{
    const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const key = (removed ? '!' : '') + r.toLowerCase();
    let f = resolved.get(key);

    if (f === undefined)
    {
        // (no `..`: the path is joined to the game and mod folders)
        const ok = /^!?gfx\//.test(key) && IMAGE_EXT.test(key) && !/(^|\/)\.\.(\/|$)/.test(key);
        f = vfs && ok ? ((removed ? vfs.former(r, { engine: true }) : vfs.get(r, { engine: true })) ?? null) : null;
        resolved.set(key, f);
    }

    return f ?? undefined;
}

/** Bytes of a game file: disk files asynchronously, zip entries from the archive. */
async function bytesOf(f: GameFile): Promise<Buffer>
{
    const buf = f.abs ? await readFile(f.abs) : vfs?.read(f);

    if (!buf)
        throw new Error('Could not read ' + f.rel);

    return buf;
}

/** Texture inspection: a channel as opaque grey, or the colour without its alpha (packed maps keep data in alpha). */
function isolateChannel(rgba: Uint8Array, ch: string): void
{
    const k = ch.length === 1 ? 'rgba'.indexOf(ch) : -1;

    for (let i = 0; i < rgba.length; i += 4)
    {
        if (k >= 0)
            rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + k];

        rgba[i + 3] = 255;
    }
}

async function image(rel: string, w: number, face = 0, ch = '', removed = false): Promise<Buffer>
{
    const f = resolve(rel, removed);

    if (!f || !vfs)
        throw new Error('Image not found: ' + rel);

    // PNGs are served as they are
    if (/\.png$/i.test(f.rel))
        return bytesOf(f);

    let cacheFile = '';

    if (cacheDir && w > 0 && w <= 512)
    {
        // which file (disk path, or archive › entry of a packed mod) and its version: a mod's image never reuses the
        // game's thumbnail of the same path
        const st = vfs.stat(f);
        // (ctime too: a file overwritten by a copy keeps its old modification time — and often its size)
        const key = createHash('sha1').update(`${vfs.where(f)}|${st.size}|${st.mtime}|${st.ctime ?? ''}|${w}|${face}${ch ? '|' + ch : ''}`).digest('hex');
        cacheFile = join(cacheDir, key.slice(0, 2), key + '.png');

        try
        {
            return await readFile(cacheFile);
        }
        catch
        {
            /* not cached yet */
        }
    }

    if (!/\.dds$/i.test(f.rel))
        throw new Error('Unsupported image type: ' + rel);

    const raw = await decodeDds(await bytesOf(f), w, face);

    // before downscaling: it weights colour by alpha, which blacks out maps whose alpha is data (masks, properties)
    if (ch)
        isolateChannel(raw.rgba, ch);

    const decoded = downscale(raw, w);
    const png = encodePng(decoded.rgba, decoded.width, decoded.height, w > 0 ? 6 : 2);

    if (cacheFile)
    {
        void mkdir(join(cacheFile, '..'), { recursive: true })
            .then(() => writeFile(cacheFile, png))
            .catch(() =>
            {});
    }

    return png;
}

/** The first bytes of a file (DDS header): 148 bytes from disk, or the start of a zip entry. */
async function head(f: GameFile, n: number): Promise<Buffer>
{
    if (!f.abs)
        return (await bytesOf(f)).subarray(0, n);

    const buf = Buffer.alloc(n);
    const fh = await open(f.abs, 'r');

    try
    {
        await fh.read(buf, 0, n, 0);
    }
    finally
    {
        await fh.close();
    }

    return buf;
}

async function info(rel: string): Promise<Record<string, unknown>>
{
    const f = resolve(rel);

    if (!f || !vfs)
        return { found: false };

    const abs = vfs.where(f);
    const bytes = vfs.stat(f).size;

    if (/\.dds$/i.test(f.rel))
    {
        const i = parseDds(await head(f, 148));
        return { found: true, abs, bytes, width: i.width, height: i.height, mips: i.mips, format: formatLabel(i), cube: i.isCube };
    }

    // PNG: width/height from IHDR
    const buf = await head(f, 24);
    const isPng = buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47;
    return { found: true, abs, bytes, width: isPng ? buf.readUInt32BE(16) : undefined, height: isPng ? buf.readUInt32BE(20) : undefined, format: isPng ? 'PNG' : 'TGA' };
}

parentPort!.on('message', async (req: Req) =>
{
    try
    {
        if (req.op === 'init')
        {
            vfs?.close();
            vfs = new GameFiles(req.gameDir!, req.mods ?? []);
            resolved.clear();
            cacheDir = req.cacheDir ?? '';
            parentPort!.postMessage({ id: req.id, result: vfs.sources.length });
        }
        else if (req.op === 'img')
        {
            const png = await image(req.rel!, req.w ?? 0, req.face ?? 0, req.ch ?? '', !!req.removed);
            const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
            parentPort!.postMessage({ id: req.id, result: ab }, [ab]);
        }
        else if (req.op === 'info')
        {
            parentPort!.postMessage({ id: req.id, result: await info(req.rel!) });
        }
        else if (req.op === 'forget')
        {
            // files of a loaded mod changed: where they are is looked up again
            for (const r of req.rels ?? [])
            {
                resolved.delete(r);
                resolved.delete('!' + r);
            }

            parentPort!.postMessage({ id: req.id, result: true });
        }
    }
    catch (err)
    {
        parentPort!.postMessage({ id: req.id, error: String((err as Error)?.message ?? err) });
    }
});
