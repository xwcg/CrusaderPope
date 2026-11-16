/**
 * Binary saves (autosaves, ironman; docs/saves.md "Binary saves"): turned into text saves with rakaly's command-line
 * tool (github.com/rakaly/cli, MIT, Nick Babcock), whose release builds know the game's token names. The app ships
 * nothing of it: when a binary save is to be loaded and rakaly is not there yet, the user is asked, and the latest
 * release for this platform is downloaded from GitHub into the app's data folder. `melt` writes the text save into the
 * app's data folder (the original is only read).
 */
import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { tr } from '../../shared/i18n.ts';
import { ZipArchive } from '../mods/zip.ts';

const RELEASES = 'https://api.github.com/repos/rakaly/cli/releases/latest';
const EXE = process.platform === 'win32' ? 'rakaly.exe' : 'rakaly';

/** The release asset for this platform. */
function assetPattern(): RegExp | undefined
{
    if (process.platform === 'win32' && process.arch === 'x64')
        return /x86_64-pc-windows-msvc\.zip$/;

    if (process.platform === 'linux' && process.arch === 'x64')
        return /x86_64-unknown-linux-musl\.tar\.gz$/;

    if (process.platform === 'darwin')
        return process.arch === 'arm64' ? /aarch64-apple-darwin\.tar\.gz$/ : /x86_64-apple-darwin\.tar\.gz$/;

    return undefined;
}

/** Where rakaly is kept: `<data>/tools/rakaly/<version>/rakaly(.exe)`. */
export function rakalyInstalled(dataDir: string): { path: string; version: string; } | null
{
    const root = join(dataDir, 'tools', 'rakaly');

    if (!existsSync(root))
        return null;

    // (the newest version folder that has the program)
    const versions = readdirSync(root).filter((v) => existsSync(join(root, v, EXE))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.length ? { path: join(root, versions[0], EXE), version: versions[0] } : null;
}

/** A file of a .tar.gz (the release's single program). */
export function fromTarGz(data: Buffer, name: string): Buffer | undefined
{
    const tar = gunzipSync(data);

    for (let at = 0; at + 512 <= tar.length;)
    {
        const head = tar.subarray(at, at + 512);

        if (head.every((b) => b === 0))
            break;

        const str = (s: number, e: number): string => head.subarray(s, e).toString('latin1').replace(/\0.*$/s, '');
        const path = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
        const size = parseInt(str(124, 136).trim() || '0', 8);
        const body = tar.subarray(at + 512, at + 512 + size);

        if (basename(path) === name && (head[156] === 0 || head[156] === 48))
            return Buffer.from(body);

        at += 512 + Math.ceil(size / 512) * 512;
    }

    return undefined;
}

/** The latest rakaly release (its version), asked of GitHub for the settings' update check. */
export async function latestRakaly(): Promise<string>
{
    const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CrusaderPope' } });

    if (!res.ok)
        throw new Error(tr('rakaly\'s releases could not be read (GitHub answered {status})', { status: res.status }));

    return ((await res.json()) as { tag_name: string; }).tag_name.replace(/^v/, '');
}

/** Downloads the latest rakaly release for this platform into the app's data folder (older versions removed). */
export async function installRakaly(dataDir: string): Promise<{ path: string; version: string; }>
{
    const pattern = assetPattern();

    if (!pattern)
        throw new Error(tr('rakaly has no build for this system ({platform} {arch})', { platform: process.platform, arch: process.arch }));

    const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CrusaderPope' } });

    if (!res.ok)
        throw new Error(tr('rakaly\'s releases could not be read (GitHub answered {status})', { status: res.status }));

    const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string; }[]; };
    const asset = release.assets.find((a) => pattern.test(a.name));

    if (!asset)
        throw new Error(tr('rakaly {version} has no build for this system', { version: release.tag_name }));

    const got = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'CrusaderPope' } });

    if (!got.ok)
        throw new Error(tr('rakaly could not be downloaded (GitHub answered {status})', { status: got.status }));

    const data = Buffer.from(await got.arrayBuffer());
    const version = release.tag_name.replace(/^v/, '');
    const dir = join(dataDir, 'tools', 'rakaly', version);
    mkdirSync(dir, { recursive: true });
    let exe: Buffer | undefined;

    if (/\.zip$/i.test(asset.name))
    {
        const zipFile = join(dir, asset.name);
        writeFileSync(zipFile, data);
        const z = new ZipArchive(zipFile);

        try
        {
            const e = z.files().find((f) => basename(f.name) === EXE);
            exe = e && z.readEntry(e);
        }
        finally
        {
            z.close();
            rmSync(zipFile, { force: true });
        }
    }
    else
        exe = fromTarGz(data, EXE);

    if (!exe)
        throw new Error(tr('The rakaly download holds no {exe}', { exe: EXE }));

    const path = join(dir, EXE);
    writeFileSync(path, exe);

    if (process.platform !== 'win32')
        chmodSync(path, 0o755);

    // (the versions before it go)
    const root = join(dataDir, 'tools', 'rakaly');

    for (const v of readdirSync(root))
        if (v !== version)
            rmSync(join(root, v), { recursive: true, force: true });

    return { path, version };
}

/**
 * A binary save made a text save (`rakaly melt`): `<data>/melted/<name>.<size>-<mtime>.ck3`, again only when the
 * save changed. `unknown`: tokens this rakaly doesn't know yet (a newer game patch), kept as hex names.
 */
export async function meltSave(dataDir: string, file: string): Promise<{ file: string; unknown: boolean; }>
{
    const rakaly = rakalyInstalled(dataDir);

    if (!rakaly)
        throw new Error(tr('rakaly is not installed'));

    const st = statSync(file);
    const dir = join(dataDir, 'melted');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${basename(file, extname(file))}.${st.size}-${Math.round(st.mtimeMs)}.ck3`);

    if (existsSync(out))
        return { file: out, unknown: false };

    // (the older text copies of saves go: only the last few are kept)
    const kept = readdirSync(dir).map((n) => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    for (const old of kept.slice(3))
        rmSync(old, { force: true });

    const tmp = out + '.part';
    const code = await new Promise<number>((resolve, reject) =>
    {
        const w = createWriteStream(tmp);
        // (streamed into the file: a big save is hundreds of MB of text)
        const p = spawn(rakaly.path, ['melt', '--unknown-key', 'stringify', '--to-stdout', file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        p.stdout.pipe(w);
        p.on('error', reject);
        p.on('close', (c) => w.close(() => resolve(c ?? 1)));
    });

    // (0: done; 1: done, some tokens unknown)
    if (code !== 0 && code !== 1)
    {
        rmSync(tmp, { force: true });
        throw new Error(tr('rakaly could not convert the save (exit code {code})', { code }));
    }

    renameSync(tmp, out);
    return { file: out, unknown: code === 1 };
}
