import { useEffect, useMemo, useState } from 'react';
import { AssetMenu } from './AssetMenu';
import type { GalleryFile, GalleryFolder, ModelFolderItem } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { GameImg } from '../img';
import { formatCount } from './common';
import { FileModTag, HideRemovedToggle, ModStateFilter, ModToggle, type ModStateCounts } from './ModChip';
import { isConflict, matchesState, useHideRemoved, useModFilter, type ModFilter } from '../modStore';

/** File-based types browsed by folder: game path → entity. */
export const FILE_TYPES: Record<string, string> = { images: 'Images', models: '3D Models' };

interface FolderNode
{
    path: string;
    name: string;
    count: number;
    total: number;
    /** files from mods in the folder and below */
    mods: number;
    /** of those, the ones the state filter shows (all, added, overridden, conflicts) */
    shown: number;
    children: FolderNode[];
}

type Folders = GalleryFolder[];

/**
 * Pictures a mod's replace_path removed that a folder shows: none while removed entries are hidden — unless the state
 * filter asks for the removed ones (as the entry lists do, `shownWith`).
 */
function removedShown(f: GalleryFolder, mf: ModFilter, hideRemoved: boolean): number
{
    return hideRemoved && !(mf.on && mf.state === 'removed') ? 0 : (f.removed ?? 0);
}

/**
 * Files of a folder the mod filter shows: all, those from mods, one kind of change, or the conflicts. Pictures a mod
 * removed count as removed files from mods (`removedShown`).
 */
function folderCount(f: GalleryFolder, mf: ModFilter, hideRemoved: boolean): number
{
    const removed = removedShown(f, mf, hideRemoved);

    if (!mf.on)
        return f.count + removed;

    if (mf.state === 'all')
        return (f.modCount ?? 0) + removed;

    return (f.modStates?.[mf.state] ?? 0) + (mf.state === 'removed' ? removed : 0);
}

/** Files of a gallery list per kind of change and the conflicts (the state filter's counts; removed pictures as removed). */
function stateCounts(items: { touch?: GalleryFile['touch']; removed?: string; }[]): ModStateCounts
{
    const c: ModStateCounts = { added: 0, overridden: 0, same: 0, removed: 0, merged: 0, conflicts: 0, duplicates: 0 };

    for (const i of items)
    {
        if (i.removed)
            c.removed++;

        if (!i.touch)
            continue;

        c[i.touch.state]++;

        if (isConflict(i.touch))
            c.conflicts++;

        if (i.touch.duplicate)
            c.duplicates++;
    }

    return c;
}

/**
 * A file the mod filter lets through (off: all); a picture a mod removed goes with the removed files, and not while
 * removed entries are hidden (unless the filter asks for them).
 */
function passes(i: { touch?: GalleryFile['touch']; removed?: string; }, mf: ModFilter, hideRemoved: boolean): boolean
{
    if (i.removed)
        return !(hideRemoved && !(mf.on && mf.state === 'removed')) && (!mf.on || mf.state === 'all' || mf.state === 'removed');

    return !mf.on || matchesState(i.touch, mf.state);
}
const folderCache = new Map<string, Promise<Folders>>();
let folderCacheKey = '';

function useFolders(type: string, reloadKey: string): Folders | null
{
    const [folders, setFolders] = useState<Folders | null>(null);
    useEffect(() =>
    {
        if (folderCacheKey !== reloadKey)
        {
            folderCache.clear();
            folderCacheKey = reloadKey;
        }

        let p = folderCache.get(type);

        if (!p)
            folderCache.set(type, p = api.fileFolders(type));

        let cancelled = false;
        void p.then((f) =>
        {
            if (!cancelled)
                setFolders(f);
        });
        return () =>
        {
            cancelled = true;
        };
    }, [type, reloadKey]);
    return folders;
}

function buildTree(folders: Folders, state: ModFilter['state'], hideRemoved: boolean): FolderNode
{
    const root: FolderNode = { path: '', name: '', count: 0, total: 0, mods: 0, shown: 0, children: [] };
    const byPath = new Map<string, FolderNode>([['', root]]);
    const ensure = (path: string): FolderNode =>
    {
        let n = byPath.get(path);

        if (n)
            return n;

        const slash = path.lastIndexOf('/');
        const parent = ensure(slash >= 0 ? path.slice(0, slash) : '');
        n = { path, name: path.slice(slash + 1), count: 0, total: 0, mods: 0, shown: 0, children: [] };
        parent.children.push(n);
        byPath.set(path, n);
        return n;
    };
    const own = new Map<FolderNode, GalleryFolder>();
    const off: ModFilter = { on: false, state };
    const on: ModFilter = { on: true, state };

    for (const f of folders)
    {
        // (a folder holding only removed pictures, while they are hidden)
        const count = folderCount(f, off, hideRemoved);

        if (!count && !folderCount(f, on, hideRemoved))
            continue;

        const n = ensure(f.folder);
        n.count = count;
        own.set(n, f);
    }

    const sum = (n: FolderNode): number => (n.total = n.count + n.children.reduce((s, c) => s + sum(c), 0));
    sum(root);
    // (files the loaded mods add, replace or remove)
    const sumMods = (n: FolderNode): number =>
    {
        const f = own.get(n);
        return (n.mods = (f ? (f.modCount ?? 0) + removedShown(f, off, hideRemoved) : 0) + n.children.reduce((s, c) => s + sumMods(c), 0));
    };
    sumMods(root);
    const mine = (n: FolderNode): number =>
    {
        const f = own.get(n);
        return f ? folderCount(f, on, hideRemoved) : 0;
    };
    const sumShown = (n: FolderNode): number => (n.shown = mine(n) + n.children.reduce((s, c) => s + sumShown(c), 0));
    sumShown(root);
    const sort = (n: FolderNode): void =>
    {
        n.children.sort((a, b) => a.name.localeCompare(b.name));
        n.children.forEach(sort);
    };
    sort(root);
    return root;
}

/** Direct subfolders of `folder` with their total file counts ("mod files only": those with mod files, their count). */
function useSubfolders(type: string, folder: string, reloadKey: string): [string, number][]
{
    const folders = useFolders(type, reloadKey);
    const [modFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();
    return useMemo(() =>
    {
        if (!folders)
            return [];

        const prefix = folder ? folder + '/' : '';
        const m = new Map<string, number>();

        for (const f of folders)
        {
            if (!f.folder.startsWith(prefix) || f.folder === folder)
                continue;

            const n = folderCount(f, modFilter, hideRemoved);

            if (!n)
                continue;

            const next = f.folder.slice(prefix.length).split('/')[0];
            m.set(next, (m.get(next) ?? 0) + n);
        }

        return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }, [folders, folder, modFilter, hideRemoved]);
}

/** A folder with nothing the mod filter shows. */
function emptyText(mf: ModFilter): string
{
    if (mf.state === 'conflicts')
        return 'No conflicts here: no file is changed by two or more of the loaded mods.';

    return mf.state === 'all' ? 'No files from the loaded mods here.' : `No ${mf.state} files here.`;
}

const DEFAULT_OPEN: Record<string, string[]> = { images: ['gfx', 'gfx/interface', 'gfx/interface/icons'], models: ['gfx', 'gfx/models'] };

/** Left column of a file-based type (Images, 3D Models): the gfx folder tree. */
export function FolderList(props: { type: string; selected?: string; reloadKey: string; navigate: Navigate; }): React.JSX.Element
{
    const { type } = props;
    const folders = useFolders(type, props.reloadKey);
    const [modFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();
    const tree = useMemo(() => (folders ? buildTree(folders, modFilter.state, hideRemoved) : null), [folders, modFilter.state, hideRemoved]);
    const current = props.selected ? (props.selected.endsWith('/') ? props.selected.slice(0, -1) : props.selected.slice(0, props.selected.lastIndexOf('/'))) : '';
    const [open, setOpen] = useState<Set<string>>(() => new Set(DEFAULT_OPEN[type] ?? ['gfx']));
    useEffect(() =>
    {
        // unfold the path to the current folder
        if (!current)
            return;

        setOpen((o) =>
        {
            const n = new Set(o);
            const parts = current.split('/');

            for (let i = 1; i <= parts.length; i++)
                n.add(parts.slice(0, i).join('/'));

            return n;
        });
    }, [current]);

    const rows: React.JSX.Element[] = [];
    const render = (n: FolderNode, depth: number): void =>
    {
        for (const c of n.children)
        {
            // "mod files only": folders holding files from mods (of the chosen kind, the conflicts), counted by those
            if (modFilter.on && !c.shown)
                continue;

            const isOpen = open.has(c.path);
            rows.push(
                <div
                    key={c.path}
                    className={'folder-row' + (c.path === current ? ' active' : '')}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    onClick={() => props.navigate({ type, name: c.path + '/' })}
                >
                    <span
                        className="folder-caret"
                        onClick={(e) =>
                        {
                            e.stopPropagation();
                            setOpen((o) =>
                            {
                                const s = new Set(o);

                                if (s.has(c.path))
                                    s.delete(c.path);
                                else
                                    s.add(c.path);

                                return s;
                            });
                        }}
                    >
                        {c.children.some((x) => !modFilter.on || x.shown) ? (isOpen ? '▾' : '▸') : ' '}
                    </span>
                    <span className="folder-name">{c.name}</span>
                    {!modFilter.on && c.mods > 0 && (
                        <span className="mod-count" title={`${c.mods.toLocaleString()} files the loaded mods add, replace or remove`}>
                            {formatCount(c.mods)}
                        </span>
                    )}
                    <span className="count">{formatCount(modFilter.on ? c.shown : c.total)}</span>
                </div>
            );

            if (isOpen)
                render(c, depth + 1);
        }
    };

    if (tree)
        render(tree, 0);

    return (
        <div className="entity-list">
            <div className="head">
                <div className="title">
                    <h2>{FILE_TYPES[type] ?? type}</h2>
                    <span className="count" title={tree?.mods ? `${tree.mods.toLocaleString()} files the loaded mods add, replace or remove` : undefined}>
                        {tree ? (modFilter.on ? `${formatCount(tree.shown)} / ${formatCount(tree.total)}` : formatCount(tree.total)) : '…'}
                    </span>
                </div>
            </div>
            <div className="vlist folder-list">{tree ? rows : <div className="list-empty">Loading…</div>}</div>
        </div>
    );
}

function Crumbs(props: { type: string; folder: string; navigate: Navigate; }): React.JSX.Element
{
    const crumbs = props.folder ? props.folder.split('/') : [];
    return (
        <div className="crumbs">
            <span className="crumb" onClick={() => props.navigate({ type: props.type })}>
                {FILE_TYPES[props.type]}
            </span>
            {crumbs.map((c, i) => (
                <span key={i}>
                    <span className="crumb-sep">/</span>
                    <span className="crumb" onClick={() => props.navigate({ type: props.type, name: crumbs.slice(0, i + 1).join('/') + '/' })}>
                        {c}
                    </span>
                </span>
            ))}
        </div>
    );
}

function Subfolders(props: { type: string; folder: string; list: [string, number][]; navigate: Navigate; }): React.JSX.Element | null
{
    // (with "mod files only" the list and counts are those of mod files)
    if (!props.list.length)
        return null;

    return (
        <div className="subfolders">
            {props.list.map(([name, count]) => (
                <div key={name} className="subfolder" onClick={() => props.navigate({ type: props.type, name: (props.folder ? props.folder + '/' : '') + name + '/' })}>
                    <span className="subfolder-icon">▤</span>
                    <span className="subfolder-name">{name}</span>
                    <span className="count">{formatCount(count)}</span>
                </div>
            ))}
        </div>
    );
}

/**
 * Image tiles (thumbnails linking to the image); files from mods carry the mod's tag. Pictures a mod's replace_path
 * removed show their former picture, struck through, with "− <mod>" — no page of their own (the game with the mods has
 * no such file).
 */
function ImageTiles(props: { items: GalleryFile[]; size: number; navigate: Navigate; }): React.JSX.Element
{
    const [limit, setLimit] = useState(400);
    return (
        <>
            <div className="gallery-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${props.size + 16}px, 1fr))` }}>
                {props.items.slice(0, limit).map((i) =>
                    i.removed ?
                        (
                            <div key={i.name} className="tile removed" title={`${i.name}\nRemoved by a mod's replace_path: the game with the loaded mods doesn't load it (the picture is the file it had before).`}>
                                <FileModTag removed={i.removed} />
                                <div className="tile-img checker" style={{ height: props.size }}>
                                    <GameImg path={i.name} size={props.size} removed />
                                </div>
                                <div className="tile-name">{i.file.replace(/\.(dds|png|tga)$/i, '')}</div>
                            </div>
                        ) :
                        (
                            <div key={i.name} className="tile" title={i.name} onClick={() => props.navigate({ type: 'images', name: i.name })}>
                                <FileModTag mod={i.mod} touch={i.touch} />
                                <AssetMenu path={i.name} navigate={props.navigate} className="tile-menu" />
                                <div className="tile-img checker" style={{ height: props.size }}>
                                    <GameImg path={i.name} size={props.size} />
                                </div>
                                <div className="tile-name">{i.file.replace(/\.(dds|png|tga)$/i, '')}</div>
                            </div>
                        )
                )}
            </div>
            {props.items.length > limit && (
                <button className="show-more" onClick={() => setLimit((l) => l + 800)}>
                    Show more ({props.items.length - limit} remaining)
                </button>
            )}
        </>
    );
}

function GalleryHead(props: { type: string; folder: string; navigate: Navigate; filter: string; setFilter: (s: string) => void; size: number; setSize: (n: number) => void; counts: ModStateCounts; }): React.JSX.Element
{
    const [modFilter] = useModFilter();
    return (
        <div className="gallery-head">
            <Crumbs type={props.type} folder={props.folder} navigate={props.navigate} />
            <div className="gallery-tools">
                <input placeholder="Filter file names…" value={props.filter} onChange={(e) => props.setFilter(e.target.value)} />
                <ModToggle label="Mod files only" title="Only files the loaded mods add, replace or remove" />
                <HideRemovedToggle count={props.counts.removed} />
                <label>
                    Size
                    <input type="range" min={64} max={320} step={16} value={props.size} onChange={(e) => props.setSize(Number(e.target.value))} />
                </label>
            </div>
            {modFilter.on && <ModStateFilter counts={props.counts} />}
        </div>
    );
}

/** Thumbnail grid of one image folder. */
export function GalleryGrid(props: { folder: string; navigate: Navigate; reloadKey: string; }): React.JSX.Element
{
    const folder = props.folder.replace(/\/+$/, '');
    const [items, setItems] = useState<GalleryFile[] | null>(null);
    const [filter, setFilter] = useState('');
    const [size, setSize] = useState(128);
    const subfolders = useSubfolders('images', folder, props.reloadKey);
    const [modFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();

    useEffect(() => setItems(null), [folder]);
    // (again after an index update — the tiles stay until the new list is there)
    useEffect(() =>
    {
        let cancelled = false;
        void api.filesIn('images', folder).then((l) =>
        {
            if (!cancelled)
                setItems(l);
        });
        return () =>
        {
            cancelled = true;
        };
    }, [folder, props.reloadKey]);

    const shown = useMemo(() =>
    {
        const f = filter.trim().toLowerCase();
        return (items ?? []).filter((i) => (!f || i.file.toLowerCase().includes(f)) && passes(i, modFilter, hideRemoved));
    }, [items, filter, modFilter, hideRemoved]);
    const counts = useMemo(() => stateCounts(items ?? []), [items]);
    const removed = counts.removed;

    return (
        <div className="detail">
            <GalleryHead type="images" folder={folder} navigate={props.navigate} filter={filter} setFilter={setFilter} size={size} setSize={setSize} counts={counts} />
            <div className="detail-body gallery-body">
                <Subfolders type="images" folder={folder} list={subfolders} navigate={props.navigate} />
                {items === null ? <div className="read-loading">Loading…</div> : (
                    <>
                        <ImageTiles key={folder} items={shown} size={size} navigate={props.navigate} />
                        {items.length === 0 && subfolders.length === 0 && <div className="list-empty">No images here.</div>}
                        {hideRemoved && removed > 0 && removed === items.length && shown.length === 0 && subfolders.length === 0 && <div className="list-empty">The loaded mods removed every picture here (hidden — “Show {removed} removed” above).</div>}
                        {modFilter.on && items.length > 0 && shown.length === 0 && !(hideRemoved && removed === items.length) && subfolders.length === 0 && <div className="list-empty">{emptyText(modFilter)}</div>}
                    </>
                )}
            </div>
        </div>
    );
}

/** One folder of 3D models: asset and mesh files as tiles (thumbnail = their diffuse texture), then the folder's textures. */
export function ModelGrid(props: { folder: string; navigate: Navigate; reloadKey: string; }): React.JSX.Element
{
    const folder = props.folder.replace(/\/+$/, '');
    const [items, setItems] = useState<ModelFolderItem[] | null>(null);
    const [textures, setTextures] = useState<GalleryFile[]>([]);
    const [filter, setFilter] = useState('');
    const [size, setSize] = useState(128);
    const [kinds, setKinds] = useState<'all' | 'asset' | 'mesh'>('all');
    const subfolders = useSubfolders('models', folder, props.reloadKey);
    const [modFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();

    useEffect(() =>
    {
        setItems(null);
        setTextures([]);
    }, [folder]);
    // (again after an index update — the tiles stay until the new list is there)
    useEffect(() =>
    {
        let cancelled = false;
        void api.modelFolder(folder).then((l) => !cancelled && setItems(l));

        if (folder)
            void api.filesIn('images', folder).then((l) => !cancelled && setTextures(l));

        return () =>
        {
            cancelled = true;
        };
    }, [folder, props.reloadKey]);

    const f = filter.trim().toLowerCase();
    const shown = (items ?? []).filter((i) => (!f || i.file.toLowerCase().includes(f)) && (kinds === 'all' || i.kind === kinds) && passes(i, modFilter, hideRemoved));
    const shownTex = textures.filter((i) => (!f || i.file.toLowerCase().includes(f)) && passes(i, modFilter, hideRemoved));
    const assets = items?.filter((i) => i.kind === 'asset').length ?? 0;
    const counts = useMemo(() => stateCounts([...(items ?? []), ...textures]), [items, textures]);

    return (
        <div className="detail">
            <GalleryHead type="models" folder={folder} navigate={props.navigate} filter={filter} setFilter={setFilter} size={size} setSize={setSize} counts={counts} />
            <div className="detail-body gallery-body">
                <Subfolders type="models" folder={folder} list={subfolders} navigate={props.navigate} />
                {items === null ? <div className="read-loading">Loading…</div> : (
                    <>
                        {items.length > 0 && (
                            <div className="gallery-section-head">
                                <span>Model files</span>
                                <span className="seg">
                                    {(['all', 'asset', 'mesh'] as const).map((k) => (
                                        <button key={k} className={kinds === k ? 'active' : ''} onClick={() => setKinds(k)}>
                                            {k === 'all' ? `All ${items.length}` : k === 'asset' ? `Assets ${assets}` : `Meshes ${items.length - assets}`}
                                        </button>
                                    ))}
                                </span>
                            </div>
                        )}
                        <div className="gallery-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 16}px, 1fr))` }}>
                            {shown.map((i) => (
                                <div key={i.name} className={'tile model-tile ' + i.kind} title={i.name} onClick={() => props.navigate({ type: 'models', name: i.name })}>
                                    <FileModTag mod={i.mod} touch={i.touch} />
                                    <AssetMenu path={i.name} navigate={props.navigate} className="tile-menu" />
                                    <div className="tile-img" style={{ height: size }}>
                                        {i.thumb ? <GameImg path={i.thumb} size={size} /> : <span className="model-glyph">{i.kind === 'asset' ? '◆' : '△'}</span>}
                                        <span className={'model-kind ' + i.kind}>{i.kind === 'asset' ? 'asset' : 'mesh'}</span>
                                    </div>
                                    <div className="tile-name">{i.file.replace(/\.(asset|mesh)$/i, '')}</div>
                                    {i.summary && <div className="tile-sub">{i.summary}</div>}
                                </div>
                            ))}
                        </div>
                        {shownTex.length > 0 && (
                            <>
                                <div className="gallery-section-head">
                                    <span>Textures in this folder</span>
                                    <span className="count">{shownTex.length}</span>
                                </div>
                                <ImageTiles key={folder} items={shownTex} size={size} navigate={props.navigate} />
                            </>
                        )}
                        {items.length === 0 && textures.length === 0 && subfolders.length === 0 && <div className="list-empty">No model files here.</div>}
                        {modFilter.on && items.length + textures.length > 0 && shown.length + shownTex.length === 0 && subfolders.length === 0 && <div className="list-empty">{emptyText(modFilter)}</div>}
                    </>
                )}
            </div>
        </div>
    );
}
