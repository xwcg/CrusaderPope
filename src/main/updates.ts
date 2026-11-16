/**
 * The update check (docs/app-architecture.md, "Update check"): once per start, unless Settings.updateCheck is false,
 * the newest release on GitHub (pre-releases too; every release so far is one) against the running version. Nothing
 * is downloaded or installed: the renderer shows a banner with a link to the release page.
 * CRUSADERPOPE_UPDATE_FEED: `off` (no check; scripts/drive.mjs sets it), a .json file in the shape of the GitHub API's
 * release list (tests), or another URL.
 */
import { readFile } from 'node:fs/promises';
import type { UpdateInfo } from '../shared/api.ts';

import { tr } from '../shared/i18n.ts';
const FEED = 'https://api.github.com/repos/xwcg/CrusaderPope/releases?per_page=20';

const RELEASES_PAGE = 'https://github.com/xwcg/CrusaderPope/releases';

/** The link of a feed entry if it is a web link (the banner opens it in the browser), else undefined. */
function webUrl(url: unknown): string | undefined
{
    try
    {
        return typeof url === 'string' && /^https?:$/.test(new URL(url).protocol) ? url : undefined;
    }
    catch
    {
        return undefined;
    }
}

/** `v0.2.0` / `0.2.0` → [0, 2, 0]; undefined when it is no version. */
function parts(v: string): number[] | undefined
{
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** a < b (both versions) */
export function older(a: string, b: string): boolean
{
    const x = parts(a);
    const y = parts(b);

    if (!x || !y)
        return false;

    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] < y[i];

    return false;
}

interface Release
{
    tag_name: string;
    name?: string;
    html_url: string;
    published_at?: string;
    draft?: boolean;
}

async function releases(feed: string): Promise<Release[]>
{
    if (!/^https?:/i.test(feed))
        return JSON.parse(await readFile(feed, 'utf8')) as Release[];

    const res = await fetch(feed, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CrusaderPope' }, signal: AbortSignal.timeout(10_000) });

    if (!res.ok)
        throw new Error(tr('{feed}: HTTP {status}', { feed, status: res.status }));

    return (await res.json()) as Release[];
}

/** The newest release when it is newer than `current`, else null (also when offline or the feed fails). */
export async function checkForUpdate(current: string): Promise<UpdateInfo | null>
{
    const feed = process.env.CRUSADERPOPE_UPDATE_FEED || FEED;

    if (feed === 'off')
        return null;

    try
    {
        let best: Release | undefined;

        for (const r of await releases(feed))
            if (!r.draft && parts(r.tag_name) && (!best || older(best.tag_name, r.tag_name)))
                best = r;

        if (!best || !older(current, best.tag_name))
            return null;

        return { version: best.tag_name.replace(/^v/, ''), name: best.name || best.tag_name, url: webUrl(best.html_url) ?? RELEASES_PAGE, date: best.published_at };
    }
    catch (e)
    {
        console.warn('update check failed:', (e as Error).message);
        return null;
    }
}
