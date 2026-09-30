// Checks the zip writer and reader (src/main/mods/zip.ts) against independent readers: .NET's ZipFile (PowerShell) and
// Windows' bsdtar (System32\tar.exe). Every entry's bytes are compared by SHA-1.
// Usage: node --experimental-strip-types --no-warnings scripts/zip-check.ts [big] [keep]
//   big: also a 70,000-entry zip (ZIP64 count) and a 8.6 GB one (4.3 GB of zeros deflated — ZIP64 sizes —, 4.3 GB of
//   noise stored — the entry after it starts past 4 GB); ~5 min, ~9 GB of temp disk, removed afterwards.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packFolder, unpackZip, writeZip, ZipArchive, type ZipSource } from '../src/main/mods/zip.ts';

const big = process.argv.includes('big');
const tmp = mkdtempSync(join(tmpdir(), 'ckp-zip-check-'));
let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};
const sha = (b: Buffer | Uint8Array): string => createHash('sha1').update(b).digest('hex');
const ms = (t: number): string => `${((Date.now() - t) / 1000).toFixed(1)} s`;

/** Noise that does not compress (xorshift), `size` bytes in 1 MB chunks, the same every time it is opened. */
function* noise(size: number, seed = 0x9e3779b9): Generator<Buffer>
{
    let x = seed >>> 0;

    for (let done = 0; done < size;)
    {
        const n = Math.min(1 << 20, size - done);
        const words = new Uint32Array(Math.ceil(n / 4));

        for (let i = 0; i < words.length; i++)
        {
            x ^= x << 13;
            x >>>= 0;
            x ^= x >>> 17;
            x ^= x << 5;
            x >>>= 0;
            words[i] = x;
        }

        done += n;
        yield Buffer.from(words.buffer, 0, n);
    }
}

function* zeros(size: number): Generator<Buffer>
{
    const chunk = Buffer.alloc(1 << 20);

    for (let done = 0; done < size; done += chunk.length)
        yield size - done >= chunk.length ? chunk : chunk.subarray(0, size - done);
}

function hashOf(chunks: Iterable<Buffer>): string
{
    const h = createHash('sha1');

    for (const c of chunks)
        h.update(c);

    return h.digest('hex');
}

/** .NET's view of a zip: entry count, and name → [size, sha1] for the entries asked for (all when none are named). */
function dotnet(zip: string, names?: string[]): { count: number; entries: Map<string, [number, string]>; }
{
    const ps = [
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$z = [IO.Compression.ZipFile]::OpenRead('${zip.replace(/'/g, "''")}')`,
        '"COUNT " + $z.Entries.Count',
        names ? `$want = @(${names.map((n) => `'${n}'`).join(',')})` : '$want = $null',
        'foreach ($e in $z.Entries) { if (($null -eq $want) -or ($want -contains $e.FullName)) { $s = $e.Open(); $h = [Security.Cryptography.SHA1]::Create().ComputeHash($s); $s.Close(); "E " + $e.FullName + " " + $e.Length + " " + (($h | ForEach-Object { $_.ToString("x2") }) -join "") } }',
        '$z.Dispose()'
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const entries = new Map<string, [number, string]>();
    let count = -1;

    for (const line of out.split(/\r?\n/))
    {
        if (line.startsWith('COUNT '))
            count = Number(line.slice(6));

        const m = /^E (.+) (\d+) ([0-9a-f]{40})$/.exec(line);

        if (m)
            entries.set(m[1], [Number(m[2]), m[3]]);
    }

    return { count, entries };
}

const TAR = 'C:\\Windows\\System32\\tar.exe';

/** bsdtar's listing: name → size. */
function bsdtarList(zip: string): Map<string, number>
{
    const out = execFileSync(TAR, ['-tvf', zip], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const m = new Map<string, number>();

    for (const line of out.split(/\r?\n/))
    {
        // -rw-rw-r--  0 0      0      12 Sep 29 18:40 name
        const x = /^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+[\d:]+\s+(.+)$/.exec(line);

        if (x)
            m.set(x[2], Number(x[1]));
    }

    return m;
}

/** bsdtar extracting one entry to stdout: its SHA-1. */
function bsdtarHash(zip: string, name: string): string
{
    return sha(execFileSync(TAR, ['-xOf', zip, name], { maxBuffer: 1 << 30 }));
}

try
{
    // 1. a mod folder: small and larger files (streamed), compressible and not, stored formats, empty, UTF-8 names
    const src = join(tmp, 'mod');
    const files: Record<string, Buffer> = {
        'descriptor.mod': Buffer.from('name="Zip check"\nversion="1"\n'),
        'common/traits/zz_check.txt': Buffer.from('check_trait = { }\n'.repeat(500)),
        'localization/english/übersetzung_l_english.yml': Buffer.from('\ufeffl_english:\n key:0 "Grüße"\n'),
        'gfx/empty.txt': Buffer.alloc(0),
        'gfx/icon.png': Buffer.concat([...noise(3000, 7)]),
        'gfx/big_text.txt': Buffer.from('a line of text that compresses well\n'.repeat(200_000)),
        'gfx/big_noise.dds': Buffer.concat([...noise(6 << 20, 11)])
    };

    for (const [rel, data] of Object.entries(files))
    {
        mkdirSync(join(src, rel, '..'), { recursive: true });
        writeFileSync(join(src, rel), data);
    }

    const zip1 = join(tmp, 'mod.zip');
    let t = Date.now();
    const packed = await packFolder(src, zip1);
    console.log(`packed ${packed.files} files, ${packed.bytes} bytes → ${statSync(zip1).size} bytes (${ms(t)})`);
    const z = new ZipArchive(zip1);
    const ours = new Map(z.files().map((e) => [e.name, e]));
    check(Object.entries(files).every(([rel, data]) => sha(z.readEntry(rel)!) === sha(data)), 'our reader: every entry’s bytes');
    check(ours.get('gfx/icon.png')?.method === 0 && ours.get('gfx/big_noise.dds')?.method === 0 && ours.get('gfx/big_text.txt')?.method === 8 && ours.get('common/traits/zz_check.txt')?.method === 8, 'png stored, noise stored after trying, text deflated');
    z.close();
    const net = dotnet(zip1);
    check(net.count === 7 && Object.entries(files).every(([rel, data]) => net.entries.get(rel)?.[0] === data.length && net.entries.get(rel)?.[1] === sha(data)), `.NET ZipFile reads the same ${net.count} entries`);
    const tl = bsdtarList(zip1);
    // (bsdtar prints names in the console's code page: non-ASCII names are compared by their size only)
    const sizes = (l: number[]): string => l.sort((a, b) => a - b).join();
    check(tl.size === 7 && Object.entries(files).every(([rel, data]) => /[^\x20-\x7e]/.test(rel) || tl.get(rel) === data.length) && sizes([...tl.values()]) === sizes(Object.values(files).map((d) => d.length)), 'bsdtar lists the same entries and sizes');
    check(bsdtarHash(zip1, 'gfx/big_text.txt') === sha(files['gfx/big_text.txt']) && bsdtarHash(zip1, 'gfx/big_noise.dds') === sha(files['gfx/big_noise.dds']), 'bsdtar extracts the streamed entries');
    const out1 = join(tmp, 'out');
    await unpackZip(zip1, out1);
    check(Object.entries(files).every(([rel, data]) => sha(readFileSync(join(out1, rel))) === sha(data)), 'unpackZip gives the files back');
    // a damaged zip: one byte of a stored entry flipped → the checksum refuses it
    const bad = readFileSync(zip1);
    const i = bad.indexOf(files['gfx/icon.png'].subarray(0, 64));
    bad[i + 10] ^= 0xff;
    writeFileSync(join(tmp, 'bad.zip'), bad);

    try
    {
        await unpackZip(join(tmp, 'bad.zip'), join(tmp, 'bad'));
        check(false, 'damaged zip refused (no error)');
    }
    catch (e)
    {
        check(/damaged/.test(String(e)), 'damaged zip refused: ' + (e as Error).message);
    }

    // 2. all or nothing: an entry the unpacker can't read or write fails the whole unpack (it used to be left out)
    let n = 0;
    const refused = async (file: string, pattern: RegExp, what: string): Promise<void> =>
    {
        const out = join(tmp, 'refused' + n++);

        try
        {
            const r = await unpackZip(file, out);
            check(false, `${what}: no error (${r.files} files)`);
        }
        catch (e)
        {
            check(pattern.test((e as Error).message), `${what}: ${(e as Error).message}`);
        }
    };
    const text = (s: string, k = 1): Buffer => Buffer.from(s.repeat(k));
    const three = join(tmp, 'three.zip');
    await writeZip(three, [{ name: 'a.txt', data: text('first\n', 50) }, { name: 'common/traits/b.txt', data: text('b = { }\n', 50) }, { name: 'descriptor.mod', data: text('name="x"\n') }]);
    const zb = new ZipArchive(three);
    const bAt = zb.get('common/traits/b.txt')!.offset;
    zb.close();
    const threeBytes = readFileSync(three);
    // the central record of an entry: its name follows the 46 bytes of the record
    const cenOf = (buf: Buffer, name: string): number => buf.lastIndexOf(Buffer.from(name)) - 46;
    const patched = (name: string, edit: (buf: Buffer) => void): string =>
    {
        const buf = Buffer.from(threeBytes);
        edit(buf);
        const f = join(tmp, name);
        writeFileSync(f, buf);
        return f;
    };
    await refused(patched('header.zip', (b) => (b[bAt] ^= 0xff)), /no file header/, 'a damaged local header');
    await refused(
        patched('method9.zip', (b) =>
        {
            b.writeUInt16LE(9, cenOf(b, 'common/traits/b.txt') + 10);
            b.writeUInt16LE(9, bAt + 8);
        }),
        /Deflate64/,
        'an entry compressed with Deflate64'
    );
    await refused(patched('encrypted.zip', (b) => b.writeUInt16LE(b.readUInt16LE(cenOf(b, 'a.txt') + 8) | 1, cenOf(b, 'a.txt') + 8)), /encrypted/, 'an encrypted entry');
    await refused(patched('count.zip', (b) => b.writeUInt16LE(4, b.length - 22 + 10)), /incomplete/, 'a directory listing fewer entries than its end record says');
    // a deflated entry declaring fewer bytes than it inflates to (read whole: inflating stops at the declared size)
    await refused(
        patched('grows.zip', (b) =>
        {
            b.writeUInt32LE(100, cenOf(b, 'a.txt') + 24);
            b.writeUInt32LE(100, 22);
        }),
        /more bytes than its size/,
        'an entry inflating past its declared size'
    );
    // …and a streamed one (declared over 4 MB): more bytes than declared, then fewer
    const bigText = text('a line of text that compresses well\n', 190_000);
    const streamed = join(tmp, 'streamed.zip');
    await writeZip(streamed, [{ name: 'big.txt', data: bigText }, { name: 'descriptor.mod', data: text('name="x"\n') }]);
    const sb = readFileSync(streamed);
    const sizeTo = (name: string, size: number): string =>
    {
        const buf = Buffer.from(sb);
        buf.writeUInt32LE(size, cenOf(buf, 'big.txt') + 24);
        buf.writeUInt32LE(size, 22);
        writeFileSync(join(tmp, name), buf);
        return join(tmp, name);
    };
    check(bigText.length > 5 << 20, `streamed entry: ${bigText.length} bytes`);
    await refused(sizeTo('streamed-less.zip', 5 << 20), /more bytes than its size/, 'a streamed entry inflating past its declared size');
    await refused(sizeTo('streamed-more.zip', 7 << 20), /bytes instead of/, 'a streamed entry shorter than its declared size');

    // names: a `..` segment, absolute paths, drive letters, colons, names Windows can't hold
    for (const [name, pattern] of [['../evil.txt', /leads out/], ['common/../../evil.txt', /leads out/], ['/evil.txt', /absolute/], ['C:evil.txt', /absolute/], ['c:/evil.txt', /absolute/], ['common/a:b.txt', /colon/], ['common/nul.txt', /Windows does not allow/], ['common/x?.txt', /characters Windows/]] as const)
    {
        const f = join(tmp, 'name.zip');
        await writeZip(f, [{ name: 'descriptor.mod', data: text('name="x"\n') }, { name, data: text('x\n') }]);
        await refused(f, pattern, `the name ${name}`);
    }

    check(!existsSync(join(tmp, 'evil.txt')) && !existsSync(join(tmp, 'refused0', '..', 'evil.txt')), 'nothing written outside the folder');
    // a name that merely starts with .. is a name like any other
    const dots = join(tmp, 'dots.zip');
    await writeZip(dots, [{ name: '..foo/x.txt', data: text('x\n') }, { name: '...txt', data: text('y\n') }]);
    const dotsOut = join(tmp, 'dots');
    const du = await unpackZip(dots, dotsOut);
    check(du.files === 2 && readFileSync(join(dotsOut, '..foo', 'x.txt'), 'utf8') === 'x\n' && readFileSync(join(dotsOut, '...txt'), 'utf8') === 'y\n', 'a name starting with .. (..foo/x.txt) is unpacked');
    // two entries of one name, letter case aside: one would overwrite the other
    const twice = join(tmp, 'twice.zip');
    await writeZip(twice, [{ name: 'common/A.txt', data: text('a\n') }, { name: 'common/a.txt', data: text('b\n') }]);
    await refused(twice, /twice/, 'a name listed twice');
    // LZMA and BZIP2 entries (Python's zipfile writes them), next to a deflated one
    const py = (() =>
    {
        try
        {
            return execFileSync('python', ['--version'], { encoding: 'utf8' }).trim();
        }
        catch
        {
            return '';
        }
    })();

    if (py)
    {
        for (const [method, label] of [['ZIP_LZMA', /LZMA/], ['ZIP_BZIP2', /BZIP2/]] as const)
        {
            const f = join(tmp, method + '.zip');
            execFileSync('python', ['-c', `import zipfile, sys\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n    z.writestr('descriptor.mod', 'name="x"\\n', compress_type=zipfile.ZIP_DEFLATED)\n    z.writestr('common/traits/b.txt', 'b = { }\\n' * 100, compress_type=zipfile.${method})\n`, f]);
            await refused(f, label, `${py}: an entry compressed with ${method.slice(4)}`);
        }
    }
    else
        console.log('skipped: LZMA / BZIP2 entries (no Python)');

    if (big)
    {
        // 3. more entries than the classic count holds
        const many: ZipSource[] = Array.from({ length: 70_000 }, (_, k) => ({ name: `common/many/f${String(k).padStart(5, '0')}.txt`, data: Buffer.from(`k${k} = { }\n`) }));
        const zip2 = join(tmp, 'many.zip');
        t = Date.now();
        await writeZip(zip2, many);
        console.log(`70,000 entries: ${statSync(zip2).size} bytes (${ms(t)})`);
        const z2 = new ZipArchive(zip2);
        check(z2.files().length === 70_000 && z2.readEntry('common/many/f69999.txt')?.toString() === 'k69999 = { }\n', 'our reader: 70,000 entries (ZIP64 end record)');
        z2.close();
        const net2 = dotnet(zip2, ['common/many/f00000.txt', 'common/many/f69999.txt']);
        check(net2.count === 70_000 && net2.entries.get('common/many/f69999.txt')?.[1] === sha(Buffer.from('k69999 = { }\n')), `.NET: ${net2.count} entries`);
        check(bsdtarList(zip2).size === 70_000, 'bsdtar: 70,000 entries');
        rmSync(zip2);

        // 4. entries of 4 GB and more, and an entry past 4 GB
        const G = 4.3 * 2 ** 30;
        const size = Math.floor(G);
        const zip3 = join(tmp, 'big.zip');
        const tail = Buffer.from('after the big ones\n');
        t = Date.now();
        await writeZip(zip3, [
            { name: 'zeros.bin', size, open: () => zeros(size) },
            { name: 'noise.bin', size, open: () => noise(size, 3), store: true },
            { name: 'tail.txt', data: tail }
        ]);
        console.log(`8.6 GB of entries: ${statSync(zip3).size} bytes (${ms(t)})`);
        t = Date.now();
        const zSha = hashOf(zeros(size));
        const nSha = hashOf(noise(size, 3));
        console.log(`expected hashes (${ms(t)})`);
        const z3 = new ZipArchive(zip3);
        const e3 = new Map(z3.files().map((e) => [e.name, e]));
        check(e3.get('zeros.bin')?.size === size && e3.get('zeros.bin')!.compressedSize < size && e3.get('noise.bin')?.size === size && e3.get('tail.txt')!.offset > 2 ** 32, 'our reader: ZIP64 sizes and an offset past 4 GB');
        const streamHash = async (e: import('../src/main/mods/zip.ts').ZipEntry): Promise<string> =>
        {
            const h = createHash('sha1');

            for await (const c of z3.stream(e)!)
                h.update(c as Buffer);

            return h.digest('hex');
        };
        t = Date.now();
        check((await streamHash(e3.get('zeros.bin')!)) === zSha && (await streamHash(e3.get('noise.bin')!)) === nSha && z3.readEntry('tail.txt')?.equals(tail), `our reader streams both big entries back (${ms(t)})`);
        z3.close();
        t = Date.now();
        const net3 = dotnet(zip3);
        check(net3.count === 3 && net3.entries.get('zeros.bin')?.[1] === zSha && net3.entries.get('noise.bin')?.[1] === nSha && net3.entries.get('tail.txt')?.[1] === sha(tail), `.NET reads all three, bytes equal (${ms(t)})`);
        const tl3 = bsdtarList(zip3);
        check(tl3.get('zeros.bin') === size && tl3.get('noise.bin') === size && bsdtarHash(zip3, 'tail.txt') === sha(tail), 'bsdtar lists the sizes and extracts the entry past 4 GB');
        rmSync(zip3);
    }
}
finally
{
    if (process.argv.includes('keep'))
        console.log('kept', tmp);
    else
        rmSync(tmp, { recursive: true, force: true });

    console.log(failures ? `${failures} FAILED` : 'all ok');
    process.exitCode = failures ? 1 : 0;
}
