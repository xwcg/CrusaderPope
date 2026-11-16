/**
 * Edits of the game's interface files from the GUI tab's preview (docs/gui-designer.md, stage 3): one property of one
 * widget statement (set, added or removed) written into the active mod. A `.gui` file is replaced as a whole by a
 * mod's file of the same path, so a file of the game (or of another mod) is copied into the active mod first and the
 * change made in the copy. One undo step; the GUI library is read again after the refresh (gameIndex: GUI_PATH).
 */
import { existsSync, readFileSync } from 'node:fs';
import type { GuiEditRequest, ScriptEditResult } from '../../shared/api.ts';
import { gwalk, parseGui, type GNode } from '../gui/parser.ts';
import { modPath, write } from './edit.ts';
import { decodeText } from './textCodec.ts';
import { active, readScript, refresh } from './scriptEdit.ts';
import { change, describeChange } from './undo.ts';
import type { ModsHost } from './manager.ts';

import { tr } from '../../shared/i18n.ts';
export function editGui(host: ModsHost, req: GuiEditRequest): Promise<ScriptEditResult>
{
    const what = req.set
        ? `${req.set.key} = ${req.set.value}`
        : req.insert
        ? tr('new {value}', { value: /^[\w.@-]+/.exec(req.insert)?.[0] ?? 'statement' })
        : req.delete
        ? 'deleted'
        : req.shift
        ? (req.shift < 0 ? tr('moved up') : tr('moved down'))
        : req.moveInto
        ? tr('moved into the {key} at line {line}', { key: req.moveInto.key, line: req.moveInto.line })
        : tr('removal of {remove}', { remove: req.remove });
    return change(host, req.label ?? tr('{key} in {rel}:{line}: {what}', { key: req.at.key, rel: req.at.rel, line: req.at.line, what }), 'edit', () => edit(host, req));
}

async function edit(host: ModsHost, req: GuiEditRequest): Promise<ScriptEditResult>
{
    const a = await active(host);
    const rel = req.at.rel.replace(/\\/g, '/');

    if (!/^gui\/.+\.gui$/i.test(rel))
        throw new Error(tr('{rel} is not an interface file (gui/….gui).', { rel }));

    const abs = modPath(a, rel);

    if (!abs)
        throw new Error(tr('{rel} is not a path inside the mod folder.', { rel }));

    const notes: string[] = [];
    const own = req.at.mod?.toLowerCase() === a.mod.id.toLowerCase();
    let text: string;
    let bom = false;

    if (own || existsSync(abs))
    {
        // (the mod's own copy: edited in place)
        if (!existsSync(abs))
            throw new Error(tr('{rel} is not in {name} any more.', { rel, name: a.mod.name }));

        if (!own)
            throw new Error(tr('{name} has its own {rel}, but the preview shows another one (the mod is not in the loaded list, or a later mod replaces the file) — load {name} to edit its copy.', { name: a.mod.name, rel }));

        ({ text, bom } = readScript(abs));
    }
    else
    {
        // a file of the game or of another mod: the whole file into the active mod (a .gui file is replaced as a whole)
        if (req.at.where.includes('›'))
            throw new Error(tr('{rel} is inside a packed mod ({where}) — it can\'t be copied from there.', { rel, where: req.at.where }));

        const raw = readFileSync(req.at.where);
        const all = decodeText(raw);
        bom = all.charCodeAt(0) === 0xfeff;
        text = bom ? all.slice(1) : all;
        notes.push(tr('{rel} was copied whole into {name} (a mod replaces an interface file as a whole) — it no longer follows the {value}’s later changes to it.', { rel, name: a.mod.name, value: req.at.mod ? 'other mod' : 'game' }));
    }

    // (one undo step: every change of the request, each on the text the one before left)
    const out = applyGuiEdit(text, req);

    for (const more of req.also ?? [])
        out.text = applyGuiEdit(out.text, { at: req.at, ...more }).text;

    write(host, abs, (bom ? '﻿' : '') + out.text);
    describeChange({ line: out.line });
    await refresh(host, abs);
    return { mod: { id: a.mod.id, name: a.mod.name }, file: abs, rel, line: out.line, undo: 0, notes };
}

/** The widget statement at a line with a key (`button`, `header_pattern` …). */
function widgetAt(nodes: GNode[], line: number, key: string): GNode | undefined
{
    let hit: GNode | undefined;
    gwalk(nodes, (n) =>
    {
        if (!hit && n.line === line && n.key === key && n.children)
            hit = n;
    });
    return hit;
}

/** `100 30` → `{ 100 30 }` is the caller's; a value with spaces or a binding is quoted. */
function written(v: string): string
{
    const t = v.trim();
    return t.startsWith('{') || t.startsWith('"') || /^[\w.%|@:/-]+$/.test(t) ? t : JSON.stringify(t);
}

/** Line ends and indentation of a widget's children (the file's own: tabs or spaces). */
function styleOf(text: string, w: GNode): { eol: string; indent: string; unit: string; }
{
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lineIndent = (off: number): string => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', off - 1) + 1))![0];
    const base = lineIndent(w.s);
    const kids = w.children ?? [];
    const ref = kids[0] ? lineIndent(kids[0].s) : '';
    const unit = base.includes(' ') && !base.includes('\t') ? '    ' : ref.length > base.length ? ref.slice(base.length) : '\t';
    return { eol, indent: ref.length > base.length ? ref : base + unit, unit };
}

/** A new statement as the widget's last child (after its last statement, else right after its brace), indented as its children. */
function insertInto(text: string, w: GNode, stmt: string, asWritten = false): { text: string; line: number; }
{
    if (!/^[\w.@-]+\s*=\s*[\w.@-]*\s*\{[\s\S]*\}\s*$/.test(stmt.trim()) && !asWritten)
        throw new Error('A new widget is written `kind = { … }`.');

    const { eol, indent, unit } = styleOf(text, w);
    const kids = w.children ?? [];
    const at = kids.length ? kids[kids.length - 1].e : w.inner![0];
    // (a snippet's own nesting is written with tabs: each becomes the file's indentation unit; a moved statement keeps its own)
    const body = stmt.trim()
        .split(/\r?\n/)
        .map((l, i) => (i ? indent + (asWritten ? l : l.replace(/^\t+/, (t) => unit.repeat(t.length))) : indent + l))
        .join(eol);
    const lineOf = (off: number): number => text.slice(0, off).split('\n').length;
    // (an empty `x = {}` on one line: its closing brace goes on a line of its own)
    const close = !kids.length && !text.slice(w.inner![0], w.inner![1]).includes('\n') ? eol + /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', w.s - 1) + 1))![0] : '';
    return { text: text.slice(0, at) + eol + (kids.length ? eol : '') + body + close + text.slice(kids.length ? at : w.inner![1]), line: lineOf(at) + (kids.length ? 2 : 1) };
}

const lineAtOff = (text: string, off: number): number => text.slice(0, off).split('\n').length;

/** A statement's whole lines (from its line's start to after its line end) when nothing else is on them, else its text. */
function statementLines(text: string, n: GNode): [number, number]
{
    const ls = text.lastIndexOf('\n', n.s - 1) + 1;
    let le = text.indexOf('\n', n.e);
    le = le < 0 ? text.length : le + 1;
    const alone = !text.slice(ls, n.s).trim() && !text.slice(n.e, le)
        .replace(/#.*$/, '')
        .trim();
    return alone ? [ls, le] : [n.s, n.e];
}

/** blocks of a widget that are not widgets (the tree's ↑ / ↓ steps over them) */
const NOT_WIDGET_BLOCKS = new Set(['state', 'background', 'modify_texture', 'tooltipwidget', 'block', 'blockoverride', 'size', 'position', 'margin', 'minimumsize', 'maximumsize', 'framesize', 'spriteborder', 'color', 'tintcolor', 'fontcolor']);

/** The statement list a node is in (its parent's children, or the file's top level) and its parent. */
function siblingsOf(nodes: GNode[], w: GNode): { list: GNode[]; parent?: GNode; }
{
    let found: { list: GNode[]; parent?: GNode; } | undefined;
    gwalk(nodes, (n, parents) =>
    {
        // (by where it starts: `w` may come from another parse of the same text)
        if (!found && n.s === w.s && n.key === w.key)
        {
            const parent = parents[parents.length - 1];
            found = { list: parent ? parent.children! : nodes, parent };
        }
    });
    return found ?? { list: nodes };
}

/** ↑ / ↓: the widget swapped with the widget statement before / after it (properties between stay where they are). */
function shift(text: string, w: GNode, dir: -1 | 1): { text: string; line: number; }
{
    const { list } = siblingsOf(parseGui(text), w);
    const isWidget = (c: GNode): boolean => !!c.children && !NOT_WIDGET_BLOCKS.has(c.key) && (!c.children.length || c.children.some((x) => !!x.key)) && !!c.key;
    const i = list.findIndex((c) => c.s === w.s);
    let j = i + dir;

    while (j >= 0 && j < list.length && !isWidget(list[j]))
        j += dir;

    if (i < 0 || j < 0 || j >= list.length)
        throw new Error(tr('{key} is already the {value} widget there.', { key: w.key, value: dir < 0 ? 'first' : 'last' }));

    const [a, b] = dir < 0 ? [list[j], w] : [w, list[j]];
    const ta = text.slice(a.s, a.e);
    const tb = text.slice(b.s, b.e);
    const out = text.slice(0, a.s) + tb + text.slice(a.e, b.s) + ta + text.slice(b.e);
    // (where the moved widget is now: in the first place when it went up, else after the other one)
    const at = dir < 0 ? a.s : a.s + tb.length + (b.s - a.e);
    return { text: out, line: lineAtOff(out, at) };
}

/** The widget cut out and put into another widget of the same file as its last child. */
function moveInto(text: string, w: GNode, to: { line: number; key: string; }): { text: string; line: number; }
{
    const t = widgetAt(parseGui(text), to.line, to.key);

    if (!t || !t.inner)
        throw new Error(tr('No {key} at line {line} of the file to move into.', { key: to.key, line: to.line }));

    if (t.s >= w.s && t.e <= w.e)
        throw new Error(tr('{key} can\'t go into itself or one of its own widgets.', { key: w.key }));

    // its text without its line's indentation (each line's indentation relative to its first)
    const [s, e] = statementLines(text, w);
    const lines = text.slice(w.s, w.e).split(/\r?\n/);
    const base = /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', w.s - 1) + 1))![0];
    const stmt = [lines[0], ...lines.slice(1).map((l) => (l.startsWith(base) ? l.slice(base.length) : l.trimStart()))].join('\n');
    const cut = text.slice(0, s) + text.slice(e);
    // (the target where it is after the cut: by its offset)
    const ts = t.s > w.s ? t.s - (e - s) : t.s;
    let target: GNode | undefined;
    gwalk(parseGui(cut), (n) =>
    {
        if (!target && n.s === ts && n.key === t.key && n.children)
            target = n;
    });

    if (!target)
        throw new Error(tr('{key} could not be found again after taking {key2} out.', { key: to.key, key2: w.key }));

    return insertInto(cut, target, stmt, true);
}

/** The edit on the text: the property set where it is written, added before the widget's children, or removed. */
export function applyGuiEdit(text: string, req: GuiEditRequest): { text: string; line: number; }
{
    const w = widgetAt(parseGui(text), req.at.line, req.at.key);

    if (!w || !w.inner)
        throw new Error(tr('No {key} at {rel}:{line} any more — the file changed; look at it again.', { key: req.at.key, rel: req.at.rel, line: req.at.line }));

    if (req.insert !== undefined)
        return insertInto(text, w, req.insert);

    if (req.delete)
    {
        const [s, e] = statementLines(text, w);
        return { text: text.slice(0, s) + text.slice(e), line: lineAtOff(text, s) };
    }

    if (req.shift)
        return shift(text, w, req.shift);

    if (req.moveInto)
        return moveInto(text, w, req.moveInto);

    const key = req.set?.key ?? req.remove!;

    if (!/^[\w.@-]+$/.test(key))
        throw new Error(tr('“{key}” is not a property name.', { key }));

    // the property as the widget itself writes it (the last one counts): a scalar or a list (`size = { 100 30 }`)
    const props = (w.children ?? []).filter((c) => c.key === key && (c.value !== undefined || (!!c.children?.length && c.children.every((x) => !x.key))));
    const cur = props[props.length - 1];
    const lineOf = (off: number): number => text.slice(0, off).split('\n').length;

    if (req.remove)
    {
        if (!cur)
            throw new Error(tr('{key} has no {key2} of its own (it comes from a type or template).', { key: req.at.key, key2: key }));

        // (its whole line when nothing else is on it)
        const ls = text.lastIndexOf('\n', cur.s - 1) + 1;
        let le = text.indexOf('\n', cur.e);
        le = le < 0 ? text.length : le + 1;
        const alone = !text.slice(ls, cur.s).trim() && !text.slice(cur.e, le)
            .replace(/#.*$/, '')
            .trim();
        const [s, e] = alone ? [ls, le] : [cur.s, cur.e];
        return { text: text.slice(0, s) + text.slice(e), line: lineOf(s) };
    }

    const stmt = `${key} = ${written(req.set!.value)}`;

    if (cur)
        return { text: text.slice(0, cur.s) + stmt + text.slice(cur.e), line: lineOf(cur.s) };

    // added: after the widget's last property (before its child widgets and blocks), else right after its brace
    const kids = w.children ?? [];
    let after: GNode | undefined;

    for (const c of kids)
    {
        // (a list, `size = { 100 30 }`, is a property; a block with statements, or an empty one, a child)
        if (c.children && (!c.children.length || c.children.some((x) => x.key)))
            break;

        after = c;
    }

    const at = after ? after.e : w.inner[0];
    const ls = text.lastIndexOf('\n', w.s - 1) + 1;
    const base = /^[ \t]*/.exec(text.slice(ls))![0];
    const ref = kids[0] ? /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', kids[0].s - 1) + 1))![0] : '';
    const indent = ref.length > base.length ? ref : base + (base.includes(' ') && !base.includes('\t') ? '    ' : '\t');
    // (the file's own line ends: the game's .gui files are mostly CRLF)
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return { text: text.slice(0, at) + eol + indent + stmt + text.slice(at), line: lineOf(at) + 1 };
}
