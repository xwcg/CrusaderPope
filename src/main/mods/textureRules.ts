/**
 * Particle graphs and textures a 1.19 mod ships that 1.20 reads differently (migrations.ts `particles`, `ddsLegacy`,
 * `maskMips`; docs/mods.md). Three pure parts, no file access to the mod:
 *  - compound graphs of `.particle2` files: a node `graph = "Spawn Delay & Duration"` names the compound by its 1.19 display
 *    name, 1.20 finds a compound by its id (`gfx/compound_nodes/*.compound`: `spawn_delay_and_duration`);
 *  - DDS files with a DX10 header in BC1–BC3 (DXGI 70–78): rewritten with the legacy FourCC header, the block data stays;
 *  - colormask textures of the portrait pattern arrays with a longer mip chain than the game's own: cut to its mip count.
 * The causes are inferences from the game's files and a 1.20.0.4 error.log, not read from the engine: none is confirmed by
 * a game run (docs/mods.md, docs/images.md, docs/portraits.md).
 */
import { parseDds, type DdsInfo } from '../images/dds.ts';

/** The pins a compound graph offers (`pins = { pin = { id = … } }` of its GraphInterface nodes). */
export interface CompoundPins
{
    pins: Set<string>;
}

/** Where the blocks of a text open and close (`{` and `}` outside strings and comments), and each block's parent. */
function braces(text: string): { end: Map<number, number>; parent: Map<number, number>; }
{
    const end = new Map<number, number>();
    const parent = new Map<number, number>();
    const stack: number[] = [];

    for (let i = 0; i < text.length; i++)
    {
        const ch = text[i];

        if (ch === '"')
        {
            const q = text.indexOf('"', i + 1);
            i = q < 0 ? text.length : q;
        }
        else if (ch === '#')
        {
            const nl = text.indexOf('\n', i);
            i = nl < 0 ? text.length : nl;
        }
        else if (ch === '{')
        {
            if (stack.length)
                parent.set(i, stack[stack.length - 1]);

            stack.push(i);
        }
        else if (ch === '}' && stack.length)
            end.set(stack.pop()!, i + 1);
    }

    return { end, parent };
}

/** A compound graph file (`compound_node = { id = "x" graph = { … } }`): its id and pins; undefined when it has no id. */
export function readCompound(text: string): { id: string; pins: CompoundPins; } | undefined
{
    const id = /(?:^|\n)\s*id\s*=\s*"([^"]+)"/.exec(text)?.[1];

    if (!id)
        return undefined;

    const pins = new Set<string>();

    for (const m of text.matchAll(/\bpin\s*=\s*\{([^{}]*)\}/g))
    {
        const p = /\bid\s*=\s*"?([\w.-]+)"?/.exec(m[1])?.[1];

        if (p)
            pins.add(p);
    }

    return { id, pins: { pins } };
}

/** A graph's display name as an id: lower case, `&` is "and", runs of anything but letters and digits one `_`. */
export function compoundIdOf(name: string): string
{
    return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface CompoundEdit
{
    /** the quoted name's characters (without the quotes) */
    s: number;
    e: number;
    from: string;
    to: string;
}

/**
 * The compound nodes of a particle file (`pdxns:common:compound = { node = { graph = "x" } inputs = { link = { pin_id = … } } }`,
 * lower-case or Id / Node / Inputs spelling) that name a compound by something else than an id: the name as the id's
 * normalisation (`compoundIdOf`) is the id of a compound, and every pin linked into the node (`pin_id`) and every pin of
 * the node linked out of it (`linked_node` / `linked_pin` of the same graph) is one of that compound's. A name that is a
 * compound's id already, or that no compound has by its normalisation (the engine's own graphs: `Base with Variation` …),
 * stays; a name that matches but does not fit the pins is told in `left`.
 */
export function compoundEdits(text: string, compounds: Map<string, CompoundPins>): { edits: CompoundEdit[]; left: string[]; }
{
    const edits: CompoundEdit[] = [];
    const left: string[] = [];

    if (!/compound/i.test(text))
        return { edits, left };

    const { end, parent } = braces(text);

    for (const m of text.matchAll(/pdxns:common:compound\s*=\s*\{/gi))
    {
        const open = m.index! + m[0].length - 1;
        const close = end.get(open);

        if (close === undefined)
            continue;

        const body = text.slice(open, close);
        const g = /\bgraph\s*=\s*"([^"]*)"/i.exec(body);

        if (!g || compounds.has(g[1]))
            continue;

        const target = compoundIdOf(g[1]);
        const c = compounds.get(target);

        if (!c)
            continue;

        const id = /\bid\s*=\s*(\d+)/i.exec(body)?.[1];
        const used = new Set([...body.matchAll(/\bpin_?id\s*=\s*"([^"]*)"/gi)].map((x) => x[1]));

        // (the pins other nodes of the same graph take from this one)
        const scope = parent.get(open);
        const scopeText = scope === undefined ? text : text.slice(scope, end.get(scope) ?? text.length);

        if (id !== undefined)
            for (const x of scopeText.matchAll(/\blinked_?node\s*=\s*(\d+)\s+linked_?pin\s*=\s*"([^"]*)"/gi))
                if (x[1] === id)
                    used.add(x[2]);

        const bad = [...used].filter((p) => !c.pins.has(p));

        if (bad.length)
        {
            left.push(`${g[1]} → ${target}: ${bad.join(', ')}`);
            continue;
        }

        const at = open + g.index + g[0].indexOf('"') + 1;
        edits.push({ s: at, e: at + g[1].length, from: g[1], to: target });
    }

    return { edits, left };
}

/** A text with the edits made (the offsets are of the text they were made on). */
export function applyCompoundEdits(text: string, edits: CompoundEdit[]): string
{
    let out = text;

    for (const x of [...edits].sort((a, b) => b.s - a.s))
        out = out.slice(0, x.s) + x.to + out.slice(x.e);

    return out;
}

const LEGACY: Record<number, string> = { 70: 'DXT1', 71: 'DXT1', 72: 'DXT1', 73: 'DXT3', 74: 'DXT3', 75: 'DXT3', 76: 'DXT5', 77: 'DXT5', 78: 'DXT5' };
const SRGB = new Set([72, 75, 78]);

/**
 * A DDS file (its first 148 bytes are enough) with a DX10 extension header holding BC1, BC2 or BC3 in one plain 2D texture
 * (not a cube, not an array): the legacy FourCC that holds the same blocks. Anything else (BC7, BC4, uncompressed, legacy
 * already, a file that is no DDS (a PNG named .dds)): undefined.
 */
export function legacyOf(head: Uint8Array): { fourCC: string; dxgi: number; srgb: boolean; } | undefined
{
    if (head.length < 148)
        return undefined;

    let info: DdsInfo;

    try
    {
        info = parseDds(head);
    }
    catch
    {
        return undefined;
    }

    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const dxgi = dv.getUint32(128, true);

    if (info.dataOffset !== 148 || !LEGACY[dxgi] || dv.getUint32(132, true) !== 3 || dv.getUint32(136, true) !== 0 || dv.getUint32(140, true) !== 1)
        return undefined;

    return { fourCC: LEGACY[dxgi], dxgi, srgb: SRGB.has(dxgi) };
}

/** The file with the legacy header: bytes 0–127 with the FourCC at 84 replaced, then the block data from 148 on. */
export function toLegacy(buf: Buffer): Buffer | undefined
{
    const l = legacyOf(buf.subarray(0, 148));

    if (!l)
        return undefined;

    const head = Buffer.from(buf.subarray(0, 128));
    head.write(l.fourCC, 84, 'latin1');
    return Buffer.concat([head, buf.subarray(148)]);
}

/** The paths of the `colormask` textures of the `pattern_textures` blocks of an accessory variations file. */
export function colormaskPaths(source: string): string[]
{
    if (!/pattern_textures/i.test(source))
        return [];

    // (comments go: the game's example.txt documents the blocks with textures it does not use; a path has no #)
    const text = source.replace(/#[^\n]*/g, '');
    const { end } = braces(text);
    const out: string[] = [];

    for (const m of text.matchAll(/\bpattern_textures\s*=\s*\{/gi))
    {
        const open = m.index! + m[0].length - 1;
        const body = text.slice(open, end.get(open) ?? text.length);
        const c = /\bcolormask\s*=\s*"([^"]+)"/i.exec(body);

        if (c)
            out.push(c[1].replace(/\\/g, '/'));
    }

    return out;
}

/** What a texture array wants of a colormask: size, format and mip count, as one key. */
export interface MaskShape
{
    width: number;
    height: number;
    format: string;
    mips: number;
}

/** A plain 2D block-compressed DDS with a legacy header (no DX10 extension, no cube): its shape; else undefined. */
export function plainShape(head: Uint8Array): MaskShape | undefined
{
    let info: DdsInfo;

    try
    {
        info = parseDds(head);
    }
    catch
    {
        return undefined;
    }

    return info.blockBytes > 0 && info.dataOffset === 128 && !info.isCube && info.width > 0 && info.height > 0 ? { width: info.width, height: info.height, format: info.format, mips: info.mips } : undefined;
}

/** The size of the first `n` mip levels of a block-compressed texture, in bytes. */
export function mipBytes(width: number, height: number, blockBytes: number, n: number): number
{
    let total = 0;
    let w = width;
    let h = height;

    for (let i = 0; i < n; i++)
    {
        total += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockBytes;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
    }

    return total;
}

/** The texture with only its first `mips` levels: the mip count of the header set, the file cut after them. */
export function cutMips(buf: Buffer, mips: number): Buffer | undefined
{
    let info: DdsInfo;

    try
    {
        info = parseDds(buf);
    }
    catch
    {
        return undefined;
    }

    const size = 128 + mipBytes(info.width, info.height, info.blockBytes, mips);

    if (info.dataOffset !== 128 || info.blockBytes === 0 || info.mips <= mips || buf.length < size)
        return undefined;

    const out = Buffer.from(buf.subarray(0, size));
    out.writeUInt32LE(mips, 28);
    return out;
}

/** True when the shape of a texture is the expected one with more mip levels. */
export function longerChain(have: MaskShape | undefined, want: MaskShape): boolean
{
    return !!have && have.width === want.width && have.height === want.height && have.format === want.format && have.mips > want.mips;
}
