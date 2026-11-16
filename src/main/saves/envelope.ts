/**
 * The container of a game save (`.ck3`, docs/saves.md "The file"): a header line, the metadata (the gamestate's
 * `meta_data` block, for the load screen) and the gamestate, in a zip after the metadata, or inline. Text saves are
 * read and written; binary ones (autosaves, ironman) are recognised but not decoded (their token names are not public).
 *
 * Header: `SAV` + 2 hex digits version + 2 hex digits kind + 8 bytes (random, kept) + 8 hex digits metadata length
 * (+ 8 more bytes in some versions) + `\n` (or `\r\n`). Kinds: 0 text, 1 binary, 2 text with a zip, 3 binary with a zip,
 * 4/5 text/binary split. The zip's offsets count from where it starts (after the metadata).
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../shared/i18n.ts';
import { writeZip, ZipArchive } from '../mods/zip.ts';

export interface SaveHeader
{
    version: number;
    kind: number;
    /** the 8 bytes after the kind, kept as they are */
    random: Buffer;
    metaLen: number;
    /** the optional 8 bytes before the line end */
    extra: Buffer;
    crlf: boolean;
    /** bytes of the header line */
    length: number;
}

export interface SaveFile
{
    file: string;
    header: SaveHeader;
    /** the metadata after the header (the load screen's) */
    meta: Buffer;
    /** the gamestate (decompressed) */
    gamestate: Buffer;
    /** binary (not decoded): autosaves, ironman */
    binary: boolean;
    /** the gamestate is in a zip (written back the same way), with these other entries kept as they are */
    zipped: boolean;
    others: { name: string; data: Buffer; }[];
}

const isBinaryKind = (kind: number): boolean => kind === 1 || kind === 3 || kind === 5;

export function readHeader(d: Buffer): SaveHeader
{
    if (d.length < 24 || d.subarray(0, 3).toString('latin1') !== 'SAV')
        throw new Error(tr('Not a game save (no SAV header)'));

    const hex = (a: number, b: number): number =>
    {
        const s = d.subarray(a, b).toString('latin1');

        if (!/^[0-9a-fA-F]+$/.test(s))
            throw new Error(tr('Not a game save (a damaged header)'));

        return parseInt(s, 16);
    };
    const nl = d.subarray(0, 40).indexOf(10);
    const crlf = nl > 0 && d[nl - 1] === 13;
    const end = nl - (crlf ? 1 : 0);

    if (nl < 0 || (end !== 23 && end !== 31))
        throw new Error(tr('Not a game save (a damaged header)'));

    return {
        version: hex(3, 5),
        kind: hex(5, 7),
        random: Buffer.from(d.subarray(7, 15)),
        metaLen: hex(15, 23),
        extra: Buffer.from(d.subarray(23, end)),
        crlf,
        length: nl + 1
    };
}

export function writeHeader(h: SaveHeader, metaLen: number): Buffer
{
    const hex = (v: number, n: number): string => v.toString(16).padStart(n, '0');
    return Buffer.concat([
        Buffer.from('SAV' + hex(h.version, 2) + hex(h.kind, 2), 'latin1'),
        h.random,
        Buffer.from(hex(metaLen, 8), 'latin1'),
        h.extra,
        Buffer.from(h.crlf ? '\r\n' : '\n', 'latin1')
    ]);
}

const ZIP_MAGIC = 0x04034b50;

/** Reads a save: header, metadata and the gamestate (decompressed). */
export function readSave(file: string): SaveFile
{
    const d = readFileSync(file);
    const header = readHeader(d);
    const metaEnd = header.length + header.metaLen;
    const meta = Buffer.from(d.subarray(header.length, metaEnd));
    const zipped = metaEnd + 4 <= d.length && d.readUInt32LE(metaEnd) === ZIP_MAGIC;
    let gamestate: Buffer;
    const others: { name: string; data: Buffer; }[] = [];

    if (zipped)
    {
        const z = new ZipArchive(file, metaEnd);

        try
        {
            const g = z.get('gamestate');
            const data = g && z.readEntry(g);

            if (!data)
                throw new Error(tr('The save has no gamestate'));

            gamestate = data;

            for (const e of z.files())
            {
                if (e.dir || e.name.toLowerCase() === 'gamestate')
                    continue;

                const b = z.readEntry(e);

                if (b)
                    others.push({ name: e.name, data: b });
            }
        }
        finally
        {
            z.close();
        }
    }
    else
        gamestate = Buffer.from(d.subarray(metaEnd));

    // (the kind says binary; a text kind whose gamestate starts with binary tokens is binary too)
    const binary = isBinaryKind(header.kind) || (gamestate.length > 1 && gamestate[1] < 32 && gamestate[1] !== 9 && gamestate[1] !== 10 && gamestate[1] !== 13);
    return { file, header, meta, gamestate, binary, zipped, others };
}

/**
 * Writes a save: the header (its random bytes kept, the metadata's length new), the metadata and the gamestate, zipped
 * (deflate) when the save was. Written to a temp file first, then moved into place.
 */
export async function writeSave(out: string, save: SaveFile, gamestate: Buffer, meta = save.meta): Promise<void>
{
    const head = Buffer.concat([writeHeader(save.header, meta.length), meta]);
    const tmp = out + '.crusaderpope-tmp';

    if (save.zipped)
    {
        const zipFile = join(tmpdir(), `crusaderpope-save-${process.pid}-${Date.now()}.zip`);

        try
        {
            await writeZip(zipFile, [{ name: 'gamestate', data: gamestate }, ...save.others.map((o) => ({ name: o.name, data: o.data }))]);
            writeFileSync(tmp, Buffer.concat([head, readFileSync(zipFile)]));
        }
        finally
        {
            rmSync(zipFile, { force: true });
        }
    }
    else
        writeFileSync(tmp, Buffer.concat([head, gamestate]));

    renameSync(tmp, out);
}
