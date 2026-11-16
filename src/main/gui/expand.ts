/**
 * A definition of the GUI library expanded as the game builds it (docs/gui-designer.md, stage 2): `using = Template` put in
 * place, a widget made from a type given its type's statements (and its base type's, down to the engine's own kind),
 * `block "x" { }` replaced by a `blockoverride "x" { }` where one applies. Every node keeps where it was written and
 * what brought it in, so a selected box can show its source.
 *
 * Semantics not settled against the game (docs/gui-designer.md, "Open semantics"), chosen here, each in one place:
 * - overrides: the nearest wins: an instance's over its type's, a type's over its base type's, a nested widget's own
 *   over an enclosing one's (settled by the files: `animation_tool_properties` overrides "label" with "Properties" and
 *   the `editor_frame` inside its "content" overrides it again with "Mesh"; outer-wins loops there). An enclosing
 *   widget's overrides still reach blocks of nested widgets that override nothing of that name (not settled);
 * - properties: an instance's scalar or list property (`size = { 100 30 }`) replaces its type's of the same key (the
 *   later one wins, kept at the first one's place, like an entity replaced as a whole, the owner's expectation);
 *   blocks (state, background, widgets) add up;
 * - children: the type's first, then the instance's.
 */
import type { GuiEntry, GuiFile, GuiLibrary } from './library.ts';
import type { GNode } from './parser.ts';

import { tr } from '../../shared/i18n.ts';
export interface XNode
{
    /** the key as written: a property, a widget kind or a type's name */
    key: string;
    /** a widget: the engine's own kind it is in the end (vbox, icon, textbox …) */
    kind?: string;
    /** a widget made from types: their names, the written one first */
    types?: string[];
    value?: string;
    quoted?: boolean;
    children?: XNode[];
    /** where it is written */
    file: GuiFile;
    line: number;
    /** what brought it in, outermost first: `type header_pattern`, `template Window_Background`, `blockoverride "header_text"` */
    via: string[];
    /** a block built only when shown (LATER: a tooltip): its statements as written, not expanded */
    later?: GNode[];
}

interface Item
{
    n: GNode;
    file: GuiFile;
    via: string[];
}

interface Override
{
    id: number;
    items: Item[];
}

const MAX_DEPTH = 60;
/** keys that are blocks of properties, never widgets (even if a type has the name) */
const NOT_WIDGETS = new Set(['state', 'background', 'modify_texture', 'margin', 'size', 'position', 'blockoverride', 'block']);
/** blocks the game builds when they are shown, as a window of their own: kept as written (expanding them in place multiplies the tree) */
const LATER = new Set(['tooltipwidget']);

export class GuiExpander
{
    /** a widget kind of the engine: a type based on itself (`type vbox = vbox { }`) or a base no type defines */
    private prims = new Set<string>(['window']);
    /** things that went unresolved: `template X`, `type X` (recursion), `depth` */
    readonly missing = new Map<string, number>();
    private lib: GuiLibrary;
    private ids = new WeakMap<GNode, number>();
    private nextId = 1;

    constructor(lib: GuiLibrary)
    {
        this.lib = lib;

        for (const t of lib.entries('type'))
            if (t.base === t.name || !lib.defs('type', t.base).length)
                this.prims.add(t.base);
    }

    /** A definition expanded: a window, a root widget, a type (as a widget made from it), or undefined for a template. */
    expand(e: GuiEntry): XNode | undefined
    {
        if (e.kind === 'template')
            return undefined;

        const n: GNode = e.kind === 'type' ? { key: e.name, children: [], line: e.line, s: e.node.s, e: e.node.e } : e.node;
        return this.widget({ n, file: e.file, via: [] }, new Map(), 0, new Set<string>());
    }

    isWidget(key: string, file: GuiFile): boolean
    {
        return !NOT_WIDGETS.has(key) && (this.prims.has(key) || !!this.type(key, file));
    }

    /** The definition of a type seen from a file: the file's own `local_type`, else the last of the name. */
    private type(name: string, file: GuiFile): GuiEntry | undefined
    {
        const defs = this.lib.defs('type', name);
        return defs.findLast((d) => d.local && d.file === file) ?? defs.findLast((d) => !d.local);
    }

    private template(name: string, file: GuiFile): GuiEntry | undefined
    {
        const defs = this.lib.defs('template', name);
        return defs.findLast((d) => d.local && d.file === file) ?? defs.findLast((d) => !d.local);
    }

    private nodeId(n: GNode): number
    {
        let id = this.ids.get(n);

        if (id === undefined)
            this.ids.set(n, id = this.nextId++);

        return id;
    }

    private miss(what: string): void
    {
        this.missing.set(what, (this.missing.get(what) ?? 0) + 1);
    }

    /** A widget: its types' statements (the base's first), then its own; overrides collected, then everything flattened. */
    private widget(it: Item, outer: Map<string, Override>, depth: number, above: Set<string>): XNode
    {
        const out: XNode = { key: it.n.key, file: it.file, line: it.n.line, via: it.via };

        if (depth > MAX_DEPTH)
        {
            this.miss('depth');
            out.kind = it.n.key;
            return out;
        }

        // the type chain: written key → its base → … → the engine's kind (`foo = bar { }` is made from bar)
        const chain: GuiEntry[] = [];
        let key = it.n.base ?? it.n.key;
        // (a type naming itself further down its chain is a loop; nesting the same type is not: the depth limit catches that)
        const local = new Set<string>();

        for (;;)
        {
            const t = this.type(key, it.file);

            if (!t || local.has(t.name))
            {
                if (t)
                    this.miss('type ' + t.name);

                break;
            }

            local.add(t.name);
            chain.push(t);

            if (t.base === t.name)
                break;

            key = t.base;
        }

        out.kind = chain.length ? chain[chain.length - 1].base : key;

        // a loop: the same written widget among its own ancestors with the same overrides in reach (it would expand the same
        // way forever); the same type nested in itself with other overrides (editor_frame in an editor_frame's
        // "content") is ordinary nesting
        const at = this.nodeId(it.n) + ':' + [...outer.values()]
            .map((o) => o.id)
            .sort((a, b) => a - b)
            .join(',');

        if (above.has(at))
        {
            this.miss('type ' + (chain[0]?.name ?? it.n.key) + tr(' inside itself'));
            out.types = chain.map((t) => t.name);
            return out;
        }

        const inner = new Set(above).add(at);

        if (chain.length)
            out.types = chain.map((t) => t.name);

        // statements: the innermost base's first, the instance's own last
        const items: Item[] = [];

        for (let i = chain.length - 1; i >= 0; i--)
        {
            const t = chain[i];

            for (const c of t.node.children ?? [])
                items.push({ n: c, file: t.file, via: [...it.via, 'type ' + t.name] });
        }

        for (const c of it.n.children ?? [])
            items.push({ n: c, file: it.file, via: it.via });

        // the enclosing widgets' overrides, then this level's on top (later ones win: the instance's over its types')
        const mine = new Map<string, Override>(outer);
        this.overrides(items, mine, depth, new Set());

        out.children = this.flatten(items, mine, depth, inner);
        return out;
    }

    /** The `blockoverride`s among a level's statements and the templates it uses (not inside blocks). */
    private overrides(items: Item[], into: Map<string, Override>, depth: number, templates: Set<string>): void
    {
        for (const it of items)
        {
            if (it.n.key === 'blockoverride' && it.n.name)
                into.set(it.n.name, { id: this.nodeId(it.n), items: (it.n.children ?? []).map((c) => ({ n: c, file: it.file, via: [...it.via, tr('blockoverride "{name}"', { name: it.n.name })] })) });
            else if (it.n.key === 'using' && it.n.value && !templates.has(it.n.value) && depth < MAX_DEPTH)
            {
                const t = this.template(it.n.value, it.file);

                if (t)
                {
                    templates.add(t.name);
                    this.overrides((t.node.children ?? []).map((c) => ({ n: c, file: t.file, via: [...it.via, 'template ' + t.name] })), into, depth + 1, templates);
                }
            }
        }
    }

    /** A level's statements with templates and blocks put in place, widgets expanded, scalar properties made unique. */
    private flatten(items: Item[], overrides: Map<string, Override>, depth: number, above: Set<string>): XNode[]
    {
        const out: XNode[] = [];
        const scalar = new Map<string, number>();

        const add = (x: XNode): void =>
        {
            // (a list value, `size = { 100 30 }`, is one value too)
            if (x.key && (x.value !== undefined || (x.children?.length && x.children.every((c) => c.value !== undefined && !c.key))))
            {
                const at = scalar.get(x.key);

                if (at !== undefined)
                {
                    out[at] = x;
                    return;
                }

                scalar.set(x.key, out.length);
            }

            out.push(x);
        };

        // tpl: the templates being put in place; ov: the overrides that apply; an override's own content (and the widgets
        // in it) is not given that override again: its blocks of the name keep their default (else editor_frame in an
        // editor_frame's "content" holds itself)
        const walk = (list: Item[], tpl: Set<string>, ov: Map<string, Override>, d: number): void =>
        {
            for (const it of list)
            {
                const n = it.n;

                if (n.key === 'blockoverride')
                    continue;

                if (n.key === 'using' && n.value)
                {
                    const t = this.template(n.value, it.file);

                    if (!t)
                    {
                        this.miss('template ' + n.value);
                        continue;
                    }

                    if (tpl.has(t.name) || d > MAX_DEPTH)
                    {
                        this.miss('template ' + t.name + ' (recursion)');
                        continue;
                    }

                    walk((t.node.children ?? []).map((c) => ({ n: c, file: t.file, via: [...it.via, 'template ' + t.name] })), new Set([...tpl, t.name]), ov, d + 1);
                    continue;
                }

                if (n.key === 'block' && n.name)
                {
                    const o = ov.get(n.name);

                    if (o)
                    {
                        const rest = new Map(ov);
                        rest.delete(n.name);
                        walk(o.items, tpl, rest, d + 1);
                    }
                    else
                        walk((n.children ?? []).map((c) => ({ n: c, file: it.file, via: it.via })), tpl, ov, d + 1);

                    continue;
                }

                if (n.children && n.key && this.isWidget(n.base ?? n.key, it.file) && !NOT_WIDGETS.has(n.key))
                {
                    out.push(this.widget(it, ov, depth + 1, above));
                    continue;
                }

                const x: XNode = { key: n.key, file: it.file, line: n.line, via: it.via };

                if (n.children && LATER.has(n.key))
                    x.later = n.children;
                else if (n.children)
                    x.children = this.flatten(n.children.map((c) => ({ n: c, file: it.file, via: it.via })), ov, depth + 1, above);
                else
                {
                    x.value = n.value;
                    x.quoted = n.quoted;
                }

                add(x);
            }
        };

        walk(items, new Set(), overrides, depth);
        return out;
    }
}

/** A tree as text: widgets with their kind and types, properties as `key = value`, for checks and the CLI. */
export function xtext(n: XNode, props = true, indent = ''): string[]
{
    const lines: string[] = [];
    const where = `${n.file.rel.replace(/^gui\//, '')}:${n.line}`;

    if (n.kind)
    {
        const name = n.children?.find((c) => c.key === 'name')?.value;
        lines.push(`${indent}${n.key}${n.types && n.types[0] !== n.kind ? ' (' + [...n.types, n.kind].filter((t, i, a) => a.indexOf(t) === i).join(' → ') + ')' : ''}${name ? ' "' + name + '"' : ''}   ${where}${n.via.length ? '  via ' + n.via.join(' / ') : ''}`);
    }
    else if (n.value !== undefined)
        lines.push(`${indent}${n.key || '·'} = ${n.value}`);
    else
        lines.push(`${indent}${n.key || '·'} = {${n.children?.every((c) => c.value !== undefined && !c.key) ? ' ' + n.children.map((c) => c.value).join(' ') + ' }' : ''}`);

    if (n.children && !(n.value === undefined && !n.kind && n.children.every((c) => c.value !== undefined && !c.key)))
    {
        for (const c of n.children)
            if (props || c.kind)
                lines.push(...xtext(c, props, indent + '  '));
    }

    return lines;
}
