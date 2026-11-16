/**
 * The particle and texture rules of the migration (migrations.ts `particles`, `ddsLegacy`, `maskMips`; migrate.ts kinds of
 * the same names) against the mod's files: what each rule finds in the mod (`*Hits`, for the plan), what of it the patch mod
 * still lacks (`*Todo`, for a second run) and the writing (`apply*`). The pure parts are in textureRules.ts. A file is read
 * where the rules see it now: the patch mod's copy when it has one, else the mod's.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModInfo } from '../../shared/api.ts';
import { gameFile, gameFilesBelow } from './gameLayers.ts';
import { writeAtomic } from './manager.ts';
import { withZip } from './zip.ts';
import { applyCompoundEdits, colormaskPaths, compoundEdits, cutMips, legacyOf, longerChain, plainShape, readCompound, toLegacy, type CompoundPins, type MaskShape } from './textureRules.ts';

const lc = (s: string): string => s.toLowerCase();

type Where = { file?: string; entry?: string; };

export interface TextureCtx
{
    mod: ModInfo;
    modFiles: Map<string, Where>;
    gameDir: string;
    patchRoot?: string;
    /** a run's: the folder watcher told of each file before it is written (ModsHost.wrote) */
    wrote?: (files: string[]) => void;
}

/** The bytes a mod's file starts with (`n` of them), from its folder or zip; cached by file, size and time. */
const headCache = new Map<string, Buffer | null>();

function modHeads(c: TextureCtx, rels: string[], n: number): Map<string, Buffer | null>
{
    const out = new Map<string, Buffer | null>();

    for (const rel of rels)
    {
        const where = c.modFiles.get(rel);
        let st: ReturnType<typeof statSync> | undefined;

        try
        {
            st = where?.file ? statSync(where.file) : c.mod.archive ? statSync(c.mod.archive) : undefined;
        }
        catch
        {
            st = undefined;
        }

        const key = `${where?.file ?? `${c.mod.archive}|${where?.entry}`}|${st?.size}|${st?.mtimeMs}|${n}`;

        if (headCache.has(key))
        {
            out.set(rel, headCache.get(key)!);
            continue;
        }

        let buf: Buffer | null = null;

        try
        {
            if (where?.file)
            {
                const fd = openSync(where.file, 'r');

                try
                {
                    const b = Buffer.alloc(n);
                    buf = b.subarray(0, readSync(fd, b, 0, n, 0));
                }
                finally
                {
                    closeSync(fd);
                }
            }
            else if (where?.entry && c.mod.archive)
            {
                // (the head only, a copy: a view of the inflated entry would keep all of it alive in the cache)
                buf = withZip(c.mod.archive, (z) => z.readHead(where.entry!, n)) ?? null;
            }
        }
        catch
        {
            buf = null;
        }

        headCache.set(key, buf);
        out.set(rel, buf);
    }

    return out;
}

/** The patch mod's copy of a file, if there is one. */
function patchCopy(c: TextureCtx, rel: string): string | undefined
{
    const f = c.patchRoot ? join(c.patchRoot, ...rel.split('/')) : undefined;
    return f && existsSync(f) ? f : undefined;
}

/** A file as the rules see it now, whole: the patch mod's copy, else the mod's. */
function currentBytes(c: TextureCtx, rel: string): Buffer | undefined
{
    const p = patchCopy(c, rel);

    if (p)
        return readFileSync(p);

    const where = c.modFiles.get(rel);

    if (where?.file)
        return readFileSync(where.file);

    if (where?.entry && c.mod.archive)
        return withZip(c.mod.archive, (z) => z.readEntry(where.entry!));

    return undefined;
}

/** The first `n` bytes of a file as the rules see it now. */
function currentHead(c: TextureCtx, rel: string, n: number): Buffer | undefined
{
    const p = patchCopy(c, rel);

    if (!p)
        return modHeads(c, [rel], n).get(rel) ?? undefined;

    const fd = openSync(p, 'r');

    try
    {
        const b = Buffer.alloc(n);
        return b.subarray(0, readSync(fd, b, 0, n, 0));
    }
    finally
    {
        closeSync(fd);
    }
}

const textOf = (buf: Buffer | undefined): string | undefined => buf?.toString('utf8').replace(/^﻿/, '');

/** Writes a file of the patch mod (through a temporary file: a killed run leaves no half file, which would count as done); the watcher is told first. */
function writePatch(c: TextureCtx, rel: string, data: Buffer): void
{
    const out = join(c.patchRoot!, ...rel.split('/'));
    c.wrote?.([out, out + '.crusaderpope-tmp']);
    mkdirSync(dirname(out), { recursive: true });
    writeAtomic(out, data);
}

const under = (rel: string, folder: string, ext: string): boolean => lc(rel).startsWith(lc(folder) + '/') && lc(rel).endsWith(ext);

// -- particles --------------------------------------------------------------------------------------------------------------

/** The compound graphs the particle files can name: the game's (`gfx/compound_nodes/*.compound`) and the mod's own. */
export function compoundTable(c: TextureCtx, folder: string): Map<string, CompoundPins>
{
    const out = new Map<string, CompoundPins>();
    const add = (text: string | undefined): void =>
    {
        const r = text ? readCompound(text) : undefined;

        if (r)
            out.set(r.id, r.pins);
    };

    if (c.gameDir)
        for (const f of gameFilesBelow(c.gameDir, folder, /\.compound$/i))
            add(readFileSync(f.abs, 'utf8'));

    for (const rel of c.modFiles.keys())
        if (under(rel, folder, '.compound'))
            add(textOf(currentBytes(c, rel)));

    return out;
}

/** The mod's particle files that name a compound by its 1.19 display name, and the names that match one but cannot be mapped. */
export function particleHits(c: TextureCtx, folder: string, compounds: string): { files: string[]; left: string[]; }
{
    const table = compoundTable(c, compounds);
    const files: string[] = [];
    const left = new Set<string>();

    for (const rel of c.modFiles.keys())
    {
        if (!under(rel, folder, '.particle2'))
            continue;

        const text = textOf(currentBytes({ ...c, patchRoot: undefined }, rel));
        const r = text ? compoundEdits(text, table) : undefined;

        if (r?.edits.length || r?.left.length)
            files.push(rel);

        r?.left.forEach((x) => left.add(x));
    }

    return { files, left: [...left] };
}

/** The particle files (of `files`) that still name a compound by its display name in the patch mod's copy, else the mod's. */
export function particleTodo(c: TextureCtx, files: string[], compounds: string): string[]
{
    const table = compoundTable(c, compounds);
    return files.filter((rel) =>
    {
        const text = textOf(currentBytes(c, rel));
        return !!text && compoundEdits(text, table).edits.length > 0;
    });
}

/** The renames made in the patch mod's copy of each file (the mod's file where it has none): the files written, and the count of names changed. */
export function applyParticles(c: TextureCtx, rels: string[], compounds: string): { written: string[]; names: number; }
{
    const table = compoundTable(c, compounds);
    const written: string[] = [];
    let names = 0;

    for (const rel of rels)
    {
        const buf = currentBytes(c, rel);

        if (!buf)
            continue;

        // (the bytes as they are: latin1 maps one byte to one character, so the offsets are byte offsets and bytes that are no
        // UTF-8 (a Windows-1252 comment) survive; the byte order mark and the line ends stay)
        const raw = buf.toString('latin1');
        const bom = raw.startsWith('\xEF\xBB\xBF');
        const text = bom ? raw.slice(3) : raw;
        const edits = compoundEdits(text, table).edits;

        if (!edits.length)
            continue;

        names += edits.length;
        writePatch(c, rel, Buffer.from((bom ? '\xEF\xBB\xBF' : '') + applyCompoundEdits(text, edits), 'latin1'));
        written.push(rel);
    }

    return { written, names };
}

// -- DX10 BC1-3 textures ----------------------------------------------------------------------------------------------------

/** The mod's DDS files under a folder with a DX10 header around BC1–BC3, and those of them with an sRGB format. */
export function ddsHits(c: TextureCtx, folder: string): { files: string[]; srgb: string[]; }
{
    const rels = [...c.modFiles.keys()].filter((rel) => under(rel, folder, '.dds'));
    const heads = modHeads(c, rels, 148);
    const files: string[] = [];
    const srgb: string[] = [];

    for (const rel of rels)
    {
        const l = heads.get(rel) ? legacyOf(heads.get(rel)!) : undefined;

        if (l)
        {
            files.push(rel);

            if (l.srgb)
                srgb.push(rel);
        }
    }

    return { files, srgb };
}

/**
 * The DDS files under `folder` the patch mod holds that are no path of the mod's: the copies other rules made at another
 * path (the tenet banners and icons of the old folder carried into the new one; the engine reads those, not the old
 * path). `ddsHits` sees only the mod's own paths.
 */
function carriedDds(c: TextureCtx, folder: string): string[]
{
    const own = new Set([...c.modFiles.keys()].map(lc));
    const out: string[] = [];
    const walk = (dir: string, rel: string): void =>
    {
        let entries: Dirent[];

        try
        {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch
        {
            return;
        }

        for (const e of entries)
        {
            const r = `${rel}/${e.name}`;

            if (e.isDirectory())
                walk(join(dir, e.name), r);
            else if (e.isFile() && /\.dds$/i.test(e.name) && !own.has(lc(r)))
                out.push(r);
        }
    };

    if (c.patchRoot)
        walk(join(c.patchRoot, ...folder.split('/')), folder);

    return out;
}

/**
 * The files (of `files`, and the patch mod's carried copies under `folder`) the current copy (the patch mod's, else the
 * mod's) still has with the DX10 header.
 */
export function ddsTodo(c: TextureCtx, files: string[], folder: string): string[]
{
    return [...new Set([...files, ...carriedDds(c, folder)])].filter((rel) =>
    {
        const head = currentHead(c, rel, 148);
        return !!head && !!legacyOf(head);
    });
}

/** The legacy header written into the patch mod's copies: the files written, and those among them that were sRGB. */
export function applyDds(c: TextureCtx, rels: string[]): { written: string[]; srgb: string[]; }
{
    const written: string[] = [];
    const srgb: string[] = [];

    for (const rel of rels)
    {
        const buf = currentBytes(c, rel);
        const l = buf ? legacyOf(buf.subarray(0, 148)) : undefined;
        const out = buf ? toLegacy(buf) : undefined;

        if (!out)
            continue;

        writePatch(c, rel, out);
        written.push(rel);

        if (l?.srgb)
            srgb.push(rel);
    }

    return { written, srgb };
}

// -- portrait pattern masks -------------------------------------------------------------------------------------------------

const shapeCache = new Map<string, MaskShape | null>();

/**
 * The shape every colormask texture of the game's own `pattern_textures` blocks has (size, format, mip count): what the
 * pattern texture array is built from. Undefined when there are none or they differ; the rule then does nothing.
 */
export function gameMaskShape(gameDir: string, folder: string): MaskShape | undefined
{
    const key = lc(gameDir + '|' + folder);

    if (!shapeCache.has(key))
    {
        const shapes = new Set<string>();
        let one: MaskShape | undefined;

        for (const f of gameFilesBelow(gameDir, folder, /\.txt$/i))
        {
            for (const p of colormaskPaths(readFileSync(f.abs, 'utf8')))
            {
                const file = gameFile(gameDir, p);
                let head: Buffer | undefined;

                if (!file)
                    continue;

                const fd = openSync(file, 'r');

                try
                {
                    head = Buffer.alloc(152);
                    head = head.subarray(0, readSync(fd, head, 0, 152, 0));
                }
                finally
                {
                    closeSync(fd);
                }

                const s = plainShape(head);

                if (s)
                {
                    shapes.add(`${s.width}x${s.height} ${s.format} ${s.mips}`);
                    one = s;
                }
            }
        }

        shapeCache.set(key, shapes.size === 1 ? one! : null);
    }

    return shapeCache.get(key) ?? undefined;
}

/** The mod's accessory variations files (and the patch mod's own copies) and the colormask textures they name that the mod ships. */
function maskRefs(c: TextureCtx, folder: string): string[]
{
    const lcFiles = new Map([...c.modFiles.keys()].map((r) => [lc(r), r]));
    const txt = new Set([...c.modFiles.keys()].filter((r) => under(r, folder, '.txt')));
    const out = new Set<string>();

    for (const rel of txt)
    {
        for (const p of colormaskPaths(textOf(currentBytes(c, rel)) ?? ''))
        {
            const have = lcFiles.get(lc(p));

            if (have)
                out.add(have);
        }
    }

    return [...out];
}

/** The mod's colormask textures that have more mip levels than the game's pattern array takes (nothing when the mod hides the folder). */
export function maskHits(c: TextureCtx, folder: string): { files: string[]; shape?: MaskShape; }
{
    const hidden = c.mod.replacePaths.map((p) => lc(p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))).some((p) => lc(folder) === p || lc(folder).startsWith(p + '/'));
    const shape = hidden ? undefined : gameMaskShape(c.gameDir, folder);

    if (!shape)
        return { files: [] };

    const refs = maskRefs(c, folder);
    const heads = modHeads(c, refs, 152);
    return { files: refs.filter((rel) => heads.get(rel) && longerChain(plainShape(heads.get(rel)!), shape)), shape };
}

/** The textures (of `files`) whose current copy still has the longer chain. */
export function maskTodo(c: TextureCtx, folder: string, files: string[]): string[]
{
    const shape = gameMaskShape(c.gameDir, folder);

    return !shape ? [] : files.filter((rel) =>
    {
        const head = currentHead(c, rel, 152);
        return !!head && longerChain(plainShape(head), shape);
    });
}

/** The textures cut to the game's mip count in the patch mod's copies. */
export function applyMasks(c: TextureCtx, folder: string, rels: string[]): { written: string[]; shape?: MaskShape; }
{
    const shape = gameMaskShape(c.gameDir, folder);
    const written: string[] = [];

    for (const rel of shape ? rels : [])
    {
        const buf = currentBytes(c, rel);
        const out = buf ? cutMips(buf, shape!.mips) : undefined;

        if (!out)
            continue;

        writePatch(c, rel, out);
        written.push(rel);
    }

    return { written, shape };
}
