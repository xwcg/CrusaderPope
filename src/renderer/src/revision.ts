/**
 * The index's revision (IndexStatus.revision): bumped by every build and every incremental update (files of a loaded
 * mod written by the app or changed on disk — docs/indexer.md, "Incremental updates"). Views showing index data
 * reload on it and keep what they show until the new data is there. `gfx`: only builds and updates that changed
 * files below gfx/ (3D models, textures). Image URLs of files an update changed carry that revision (`fileVersion`),
 * so they load again instead of coming from the renderer's cache.
 */
import { useSyncExternalStore } from 'react';
import type { IndexStatus } from '../../shared/api';
import { api } from './api';

let current = { all: 0, gfx: 0, shaders: 0 };
const listeners = new Set<() => void>();
/** lower case game path → the revision that last changed the file */
const changedAt = new Map<string, number>();

function onStatus(s: IndexStatus): void
{
    if (s.state !== 'ready' || s.revision === undefined || s.revision === current.all)
        return;

    // (a build without a file list: everything may be new)
    const files = s.changedFiles;

    for (const f of files ?? [])
        changedAt.set(f.toLowerCase(), s.revision);

    current = {
        all: s.revision,
        gfx: !files || files.some((f) => /^gfx\//i.test(f)) ? s.revision : current.gfx,
        // (shader files of a loaded mod: the compiled programs are new — docs/shaders.md)
        shaders: !files || files.some((f) => /^gfx\/fx\//i.test(f)) ? s.revision : current.shaders
    };

    for (const l of listeners)
        l();
}
void api.status().then(onStatus);
api.onStatus(onStatus);

function subscribe(l: () => void): () => void
{
    listeners.add(l);
    return () => listeners.delete(l);
}

/** The index revision: a dependency of every effect that loads index data. */
export function useRevision(): number
{
    return useSyncExternalStore(subscribe, () => current.all);
}

/** The revision of the last build or update that changed gfx files (models, textures, portrait data). */
export function useGfxRevision(): number
{
    return useSyncExternalStore(subscribe, () => current.gfx);
}

/** The revision of the last build or update that changed shader files (gfx/FX): compiled programs are dropped on it. */
export function useShaderRevision(): number
{
    return useSyncExternalStore(subscribe, () => current.shaders);
}

/** The revision that last changed a game file (undefined: none since the app started). */
export function fileVersion(path: string): number | undefined
{
    return changedAt.get(path.toLowerCase());
}

/**
 * A digest of loaded data — typed arrays (geometry, textures) hashed by content, paths of files an update changed
 * with that revision (a texture the data names), the shader revision (the same data draws with other programs): a view
 * reloaded after an index update keeps what it shows (and its 3D scene) when the new data is the same.
 */
export function digest(data: unknown): string
{
    return current.shaders + ':' + JSON.stringify(data, (_k, v: unknown) =>
    {
        if (typeof v === 'string')
        {
            const at = changedAt.size ? changedAt.get(v.toLowerCase()) : undefined;
            return at ? `${v}#${at}` : v;
        }

        if (!ArrayBuffer.isView(v))
            return v;

        const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        let h = 0x811c9dc5;

        for (let i = 0; i < b.length; i++)
            h = Math.imul(h ^ b[i], 16777619);

        return `${v.constructor.name}:${b.length}:${h >>> 0}`;
    });
}
