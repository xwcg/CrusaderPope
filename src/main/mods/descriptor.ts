/**
 * Mod descriptors (docs/mods.md): the `.mod` files in the user's mod folder (outer: with `path=` or `archive=`) and
 * `descriptor.mod` inside a mod (inner: the same keys without the location). Paradox script, parsed with the
 * indexer's parser; unknown keys are kept so a rewrite does not lose them.
 */
import { parse, type PNode } from '../indexer/parser.ts';

export interface ModDescriptor
{
    name: string;
    version?: string;
    supportedVersion?: string;
    tags: string[];
    /** folder of the mod's files (outer descriptors): absolute, or relative to the user folder (`mod/my_mod`) */
    path?: string;
    /** zip of a packed mod (outer descriptors) */
    archive?: string;
    /** Steam Workshop id */
    remoteFileId?: string;
    /** folders whose files from the game and earlier mods are ignored */
    replacePaths: string[];
    picture?: string;
    /** names of mods this one needs */
    dependencies: string[];
    /** other keys, kept as written (`key = value` source lines) */
    extra: string[];
}

const KNOWN = new Set(['name', 'version', 'supported_version', 'tags', 'path', 'archive', 'remote_file_id', 'replace_path', 'picture', 'dependencies']);

function str(n: PNode | undefined): string | undefined
{
    return n && typeof n.v === 'string' ? n.v : undefined;
}

function list(n: PNode | undefined): string[]
{
    return n && Array.isArray(n.v) ? n.v.map((c) => (typeof c.v === 'string' ? c.v : '')).filter(Boolean) : [];
}

export function parseDescriptor(text: string): ModDescriptor
{
    const src = text.replace(/^﻿/, '');
    const nodes = parse(src);
    const get = (k: string): PNode | undefined => nodes.find((n) => n.k === k);
    return {
        name: str(get('name')) ?? '',
        version: str(get('version')),
        supportedVersion: str(get('supported_version')),
        tags: list(get('tags')),
        path: str(get('path')),
        archive: str(get('archive')),
        remoteFileId: str(get('remote_file_id')),
        replacePaths: nodes.filter((n) => n.k === 'replace_path')
            .map((n) => str(n) ?? '')
            .filter(Boolean)
            .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')),
        picture: str(get('picture')),
        dependencies: list(get('dependencies')),
        extra: nodes.filter((n) => n.k && !KNOWN.has(n.k)).map((n) => src.slice(n.s, n.e))
    };
}

const q = (s: string): string => '"' + s.replace(/\\/g, '/').replace(/"/g, '\\"') + '"';

/** Descriptor text in the launcher's layout (tabs, quoted values). `location` false leaves out path/archive (inner). */
export function writeDescriptor(d: ModDescriptor, location = true): string
{
    const lines: string[] = [];

    if (d.version)
        lines.push(`version=${q(d.version)}`);

    if (d.tags.length)
        lines.push('tags={', ...d.tags.map((t) => `\t${q(t)}`), '}');

    lines.push(`name=${q(d.name)}`);

    for (const p of d.replacePaths)
        lines.push(`replace_path=${q(p)}`);

    if (d.picture)
        lines.push(`picture=${q(d.picture)}`);

    if (d.dependencies.length)
        lines.push('dependencies={', ...d.dependencies.map((t) => `\t${q(t)}`), '}');

    if (d.supportedVersion)
        lines.push(`supported_version=${q(d.supportedVersion)}`);

    lines.push(...d.extra);

    if (location && d.path)
        lines.push(`path=${q(d.path)}`);

    if (location && d.archive)
        lines.push(`archive=${q(d.archive)}`);

    if (d.remoteFileId)
        lines.push(`remote_file_id=${q(d.remoteFileId)}`);

    return lines.join('\n') + '\n';
}
