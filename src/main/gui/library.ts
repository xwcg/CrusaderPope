/**
 * The game's interface files as a library of their own (docs/gui-designer.md): the `.gui` files under gui/ parsed once (the files
 * as the game loads them with mods (GameFiles)), the windows, types and templates they define, and what each uses
 * (templates, types, textures, texts, scripted GUIs, data functions). Not part of the script index (GameIndex): its cache,
 * fingerprints and incremental updates stay out of it.
 */
import type { GameFile, GameFiles } from '../mods/gamefiles.ts';
import type { GuiKind, GuiUse } from '../../shared/api.ts';
import { gvalue, gwalk, parseGui, type GNode } from './parser.ts';

export type { GuiKind };

export interface GuiFile
{
    rel: string;
    /** 0 = the game, 1.. = the mods in load order */
    source: number;
    /** the path as the app shows and opens it (GameFiles.where) */
    where: string;
    /** ModInfo id of the mod the file is from */
    mod?: string;
    text: string;
    nodes: GNode[];
}

export interface GuiEntry
{
    kind: GuiKind;
    name: string;
    /** a window / root: its widget kind or the type it is made from; a type: what it is based on */
    base: string;
    /** the `types` group of a type */
    group?: string;
    /** `local_type` / `local_template`: only the file's own */
    local?: boolean;
    file: GuiFile;
    node: GNode;
    line: number;
}

/** What a definition uses. `text`: a property that holds a text key (or a data function). */
export interface GuiRef
{
    kind: GuiUse['kind'];
    name: string;
    /** the property it is written in */
    key: string;
    line: number;
}

/** properties whose value is a text key, or a data function that makes a text */
const TEXT_KEYS = new Set(['text', 'tooltip', 'raw_tooltip', 'raw_text']);
const TEXTURE = /\.(dds|png|tga|jpg)$/i;
/** top-level statements that are not windows or widgets */
const NOT_ROOTS = new Set(['types', 'Types', 'template', 'local_template', 'type', 'local_type', 'layer', 'texticon', 'textformatting', '']);

export class GuiLibrary
{
    readonly files: GuiFile[] = [];
    private all: GuiEntry[] = [];
    private byKey = new Map<string, GuiEntry[]>();
    private reverse: Map<string, GuiEntry[]> | undefined;
    private cache = new Map<GuiEntry, GuiRef[]>();

    constructor(vfs: GameFiles)
    {
        for (const f of vfs.list('gui', { engine: true, ext: /\.gui$/i }))
            this.read(vfs, f);
    }

    private read(vfs: GameFiles, f: GameFile): void
    {
        const text = vfs.readText(f);

        if (text === undefined)
            return;

        const file: GuiFile = { rel: f.rel, source: f.source, where: vfs.where(f), mod: vfs.sources[f.source]?.modId, text, nodes: parseGui(text) };
        this.files.push(file);

        for (const n of file.nodes)
        {
            if (n.key === 'types' || n.key === 'Types')
            {
                for (const t of n.children ?? [])
                    if ((t.key === 'type' || t.key === 'local_type') && t.name)
                        this.add({ kind: 'type', name: t.name, base: t.base ?? '', group: n.name, local: t.key === 'local_type', file, node: t, line: t.line });
            }
            else if (n.key === 'type' || n.key === 'local_type')
            {
                if (n.name)
                    this.add({ kind: 'type', name: n.name, base: n.base ?? '', local: n.key === 'local_type', file, node: n, line: n.line });
            }
            else if (n.key === 'template' || n.key === 'local_template')
            {
                if (n.name)
                    this.add({ kind: 'template', name: n.name, base: '', local: n.key === 'local_template', file, node: n, line: n.line });
            }
            else if (!NOT_ROOTS.has(n.key) && !n.key.startsWith('@') && n.children)
            {
                const name = gvalue(n.children, 'name');

                if (name)
                    this.add({ kind: n.key === 'window' ? 'window' : 'root', name, base: n.key === 'window' ? (n.base ?? '') : (n.base ?? n.key), file, node: n, line: n.line });
            }
        }
    }

    private add(e: GuiEntry): void
    {
        this.all.push(e);
        const k = e.kind + ':' + e.name;
        const l = this.byKey.get(k);

        if (l)
            l.push(e);
        else
            this.byKey.set(k, [e]);
    }

    entries(kind?: GuiKind): GuiEntry[]
    {
        return kind ? this.all.filter((e) => e.kind === kind) : this.all;
    }

    /** Every definition of a name, in file order (the same name may be defined more than once). */
    defs(kind: GuiKind, name: string): GuiEntry[]
    {
        return this.byKey.get(kind + ':' + name) ?? [];
    }

    /** The text of a definition as written. */
    source(e: GuiEntry): string
    {
        return e.file.text.slice(e.node.s, e.node.e);
    }

    /** What a definition uses (cached). */
    refsOf(e: GuiEntry): GuiRef[]
    {
        let r = this.cache.get(e);

        if (!r)
        {
            r = [];
            this.collect(e, r);
            this.cache.set(e, r);
        }

        return r;
    }

    private collect(e: GuiEntry, out: GuiRef[]): void
    {
        if (e.base && this.byKey.has('type:' + e.base))
            out.push({ kind: 'type', name: e.base, key: 'type', line: e.line });

        // (the definition's own statement: a window's key is its kind, an instance of a type is a block of that name)
        gwalk([e.node], (n) =>
        {
            if (n.children && n.key && n !== e.node && this.byKey.has('type:' + n.key))
                out.push({ kind: 'type', name: n.key, key: n.key, line: n.line });

            if (n.value === undefined || !n.key)
                return;

            if (n.key === 'using')
            {
                out.push({ kind: 'template', name: n.value, key: n.key, line: n.line });
                return;
            }

            if (TEXTURE.test(n.value))
            {
                out.push({ kind: 'texture', name: n.value, key: n.key, line: n.line });
                return;
            }

            if (n.value.includes('['))
            {
                for (const m of n.value.matchAll(/GetScriptedGui\(\s*'([^']+)'/g))
                    out.push({ kind: 'scriptedGui', name: m[1], key: n.key, line: n.line });

                for (const m of n.value.matchAll(/\b([A-Z]\w*(?:\.[A-Z]\w*)+)/g))
                    out.push({ kind: 'function', name: m[1], key: n.key, line: n.line });
            }
            else if (TEXT_KEYS.has(n.key) && n.value && !/^[-\d.%]+$/.test(n.value))
                out.push({ kind: 'text', name: n.value, key: n.key, line: n.line });
        });
    }

    /** The definitions that use a template, a type, a texture, a scripted GUI … (one pass over everything, then cached). */
    usedBy(kind: GuiRef['kind'], name: string): GuiEntry[]
    {
        if (!this.reverse)
        {
            this.reverse = new Map();

            for (const e of this.all)
            {
                const seen = new Set<string>();

                for (const r of this.refsOf(e))
                {
                    const k = r.kind + ':' + r.name;

                    if (seen.has(k))
                        continue;

                    seen.add(k);
                    const l = this.reverse.get(k);

                    if (l)
                        l.push(e);
                    else
                        this.reverse.set(k, [e]);
                }
            }
        }

        return this.reverse.get(kind + ':' + name) ?? [];
    }
}
