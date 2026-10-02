import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityKey, EntryCreate, Line, LineAct, LineSource, OverridePlan, PickResult, ScriptEditRequest, SectionSource, StatementCheck, StatementKind } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { useActiveMod } from '../modStore';
import { pickStatement } from '../picker/pickStatement';
import { pickerData } from '../picker/data';
import { viewTargets } from '../picker/targets';
import type { RefEntry } from '../picker/model';
import { canPickEdit } from '../picker/model';
import { reportEditError, runScriptEdit, undoEdit } from '../scriptEdits';
import { reportChange } from '../changes';
import { LocEditable } from './LocEdit';
import { EditCtx, anchorKey, sectionSrc, type LineEditing } from './editCtx';
import { Modal, PromptDialog, errorText } from './ModDialogs';
import { MODS_ROUTE } from './ModsView';
import { OverrideButton } from './OverrideMenu';
import { LineList, ReadCtx } from './rich';
import '../styles/edit.css';
import { Select } from './Select';

/**
 * Editing in place (docs/mods.md, "Editing in place"): the readable view's lines whose statement is written in the
 * active mod get ✎ edit, ✕ remove and ＋ add (after the line; inside blocks), sections "＋ Add …" — by mouse or
 * keyboard (↑ ↓ select, Enter edit, Del remove, A add after, Shift+A add inside, Ctrl+Z undo). Edits go through the
 * main process (src/main/mods/scriptEdit.ts: checked, written, undoable); the index takes the file in and the views
 * reload. Adding and changing effects, conditions, stat modifiers and settings (an opinion modifier's, costs, script
 * value formulas, a character's traits, a trait's opinions) goes through the statement picker — changing opens it at
 * the statement's values ("Keep …"); what it can't read (blocks, wrapped statements) and a new option the script
 * editor (Shift+Enter: always the script editor).
 */

const reportError = reportEditError;

/**
 * A picker result into the file: the new entries it needs (a new opinion modifier, a doctrine parameter, a new trait …)
 * and the statement, in one request (ScriptEditRequest.creates): the main process makes the entries, then writes the
 * statement — one undo step takes both back; a refused statement takes the entries back at once, leaving no step.
 */
async function applyPicked(r: PickResult | null, req: Omit<ScriptEditRequest, 'text'>, verb: 'Added' | 'Changed'): Promise<void>
{
    if (!r?.text.trim())
        return;

    const named = r.creates?.length ? ` (new: ${r.creates.map((c) => c.key).join(', ')})` : '';
    await runScriptEdit({ ...req, text: r.text, ...(r.creates?.length ? { creates: r.creates } : {}) } as ScriptEditRequest, (r.summary ? `${verb}: ${r.summary}` : verb) + named).catch(reportError(verb === 'Added' ? 'Not added' : 'Not changed'));
}

/**
 * An entry into an on_action's list (its story's "＋ event" / "＋ on_action"): an event or on_action from the picker,
 * written as its id — `weight = id` in `random_events` — into the list (made when missing).
 */
export async function addListEntry(section: SectionSource, field: 'event' | 'on_action', weighted: boolean, title: string, at?: { x: number; y: number; }): Promise<void>
{
    const t = sectionTarget(section, title);
    const r = t && (await pickStatement({ kind: 'field', type: 'on_action_lists', field, once: true, title, at }));
    const id = r && /=\s*([\w.:-]+)\s*$/.exec(r.text.trim())?.[1];

    if (!t || !id)
        return;

    await runScriptEdit({ ...t.req, text: weighted ? `100 = ${id}` : id } as ScriptEditRequest, `Added: ${title} ${id}`).catch(reportError('Not added'));
}

/** Plain text of a line (notices). */
const lineText = (l?: Line): string => (l ? l.text.map((s) => (typeof s === 'string' ? s : s.text)).join('') : '');

// ---------------------------------------------------------------------------
// The controller of a view
// ---------------------------------------------------------------------------

/** Where an add goes: the insert request without its text, what it holds, the picker's title. */
interface Target
{
    /** the row (or section) the script editor opens under */
    key: string;
    req: Omit<ScriptEditRequest, 'text'>;
    kind: StatementKind;
    /** kind 'field': the entry type of the fields */
    fields?: string;
    /** the scope type and who "Self" is where it goes (inside an iterator: the item) — else the anchor's */
    scope?: string;
    subject?: string;
    title: string;
    /** the script editor's starting text (a new option): such adds skip the picker */
    template?: string;
    /** a condition block's hint (SectionSource.hint): the picker opens at the conditions the game writes there */
    hint?: SectionSource['hint'];
    /** the scope `root` is there when no character (a law's `can_title_have`: its title) */
    root?: string;
}

/** A row registered while it is shown: what it can do and where it is written. */
interface Row
{
    ops: RowOps;
    src: LineSource;
}

/**
 * A line of a scripted effect / trigger overridden into the mod to be edited (OwnerOffer): once the view shows the
 * mod's copy, the row of the same statement (its checks, whitespace left out) is edited — until `until`.
 */
interface PendingEdit
{
    owner: EntityKey;
    stmt: StatementCheck;
    until: number;
}

interface Open
{
    key: string;
    mode: 'edit' | 'add';
    target: Target;
    line?: Line;
}

/** What a row can do from the keyboard. */
interface RowOps
{
    edit(at?: { x: number; y: number; }): void;
    /** rows the picker changes (modifiers, settings): the script editor instead (Shift+Enter) */
    editScript?(): void;
    remove(): void;
    add(at?: { x: number; y: number; }): void;
    addInside?(at?: { x: number; y: number; }): void;
    /** an if / an iterator: add a condition to its limit */
    addCondition?(at?: { x: number; y: number; }): void;
    /** an if / else_if: add the else of its chain */
    addElse?(): void;
}

/** A section's add target: into its block, or a new block created where it belongs. */
function sectionTarget(s: SectionSource, title: string, template?: string): Target | undefined
{
    const kind = s.kind;
    // (a condition block whose root is no character — documented, SectionSource.hint —: Self at its top is that)
    const root = s.hint && s.scope && s.scope !== 'character' && !s.subject ? s.scope : undefined;
    const who = { scope: s.scope ?? s.src?.innerScope, subject: s.subject ?? s.src?.subject, ...(s.hint ? { hint: s.hint } : {}), ...(root ? { root } : {}) };

    if (s.src)
        return { key: 'sec:' + anchorKey(s.src) + ':' + s.key, req: { op: 'insert', at: s.src, where: 'inside' }, kind, fields: s.src.fields, title, template, ...who };

    const at = s.before ?? s.parent;

    if (!at)
        return undefined;

    return { key: 'sec:' + anchorKey(at) + ':' + s.key, req: { op: 'insert', at, where: s.before ? 'before' : 'inside', wrap: s.key || undefined }, kind, fields: at.fields, title, template, ...who };
}

/**
 * The editing controller of a readable view: null while there is no active mod loaded in the explorer (nothing can
 * be edited). `entry`: where the shown entry is written (its texts are edited when it is the active mod's). Ctrl+Z
 * undoes the mod's last change. `onKeyDown` goes on the view's element.
 */
export function useInPlaceEditing(entry: LineSource | undefined): {
    ctx: LineEditing | null;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
    /** the view's element: selecting a row focuses it (the keys go there) */
    ref: React.RefObject<HTMLDivElement | null>;
}
{
    const active = useActiveMod();
    const [selected, setSelected] = useState<string | null>(null);
    const [open, setOpen] = useState<Open | null>(null);
    const rows = useRef(new Map<string, Row>());
    const view = useRef<HTMLDivElement>(null);
    const pending = useRef<PendingEdit | null>(null);
    const claimTimer = useRef<number | undefined>(undefined);
    /** the pending edit's row, when the view shows it (the one with the same text around it first) */
    const claim = (): void =>
    {
        claimTimer.current = undefined;
        const p = pending.current;

        if (!p)
            return;

        if (Date.now() > p.until)
        {
            pending.current = null;
            return;
        }

        const around = (s?: StatementCheck): number => (s?.before === p.stmt.before ? 1 : 0) + (s?.after === p.stmt.after ? 1 : 0);
        const hits = [...rows.current].filter(([, r]) => r.src.owner?.type === p.owner.type && r.src.owner.name === p.owner.name && r.src.stmt?.text === p.stmt.text && !!r.src.mod);

        if (!hits.length)
            return;

        const [key, row] = hits.sort((a, b) => around(b[1].src.stmt) - around(a[1].src.stmt))[0];
        pending.current = null;
        setSelected(key);
        const el = view.current?.querySelector(`[data-anchor="${CSS.escape(key)}"]`);
        el?.scrollIntoView({ block: 'center' });
        const r = el?.getBoundingClientRect();
        row.ops.edit(r ? { x: r.left + 24, y: r.bottom + 4 } : undefined);
    };
    // (rows register in their effects: the claim looks once all of a render's rows are there)
    const shown = (): void =>
    {
        if (pending.current && claimTimer.current === undefined)
            claimTimer.current = window.setTimeout(claim, 0);
    };
    const modId = active.mod && active.loaded ? active.mod.id : undefined;
    const modName = active.mod?.name ?? '';

    const ctx = useMemo<LineEditing | null>(() =>
    {
        if (!modId)
            return null;

        const can = (src: LineSource | undefined): boolean => !!src?.mod && src.mod.toLowerCase() === modId.toLowerCase();
        const add = (t: Target, at?: { x: number; y: number; }): void =>
        {
            if (t.template !== undefined || t.kind === 'other')
            {
                setOpen({ key: t.key, mode: 'add', target: t });
                return;
            }

            void pickStatement({ kind: t.kind, type: t.fields, scope: t.scope ?? t.req.at.scope, subject: t.subject, root: t.root ?? t.req.at.root, at, title: t.title, common: t.hint?.common, about: t.hint?.about, newEntries: true }).then((r) =>
            {
                void applyPicked(r, t.req, 'Added');
            });
        };
        const opsOf = (src: LineSource, line?: Line): RowOps =>
        {
            const key = anchorKey(src);
            const kind = src.kind;
            // (a block row without a line of its own — an option — edits as plain script)
            const script = (): void => setOpen({ key, mode: 'edit', target: { key, req: { op: 'replace', at: src }, kind: line ? kind : 'other', fields: src.fields, title: 'Edit' }, line });
            // a statement the picker may read back — also a block of statements (if, NOT / OR, scope switches, iterators:
            // their head; any other block field by field; not with comments inside)
            const pickable = !!line && kind !== 'other';
            return {
                edit: (pos) =>
                {
                    if (!pickable)
                        return script();

                    void api.scriptText(src).then(
                        (t) =>
                        {
                            if (t.problem || !canPickEdit(kind, t.text, src.fields))
                                return script();

                            void pickStatement({ kind: kind as 'effect' | 'trigger' | 'modifier' | 'field', type: src.fields, scope: src.scope, root: src.root, at: pos, title: 'Change', edit: t.text, elseAfter: t.elseAfter, only: line?.choices, newEntries: true }).then((r) =>
                            {
                                // (kept as it was: nothing to write)
                                const same = (x: string): string => x.replace(/\s+/g, ' ').trim();

                                if (r && !r.creates?.length && same(r.text) === same(t.text))
                                    return;

                                void applyPicked(r, { op: 'replace', at: src }, 'Changed');
                            });
                        },
                        () => script()
                    );
                },
                editScript: pickable ? script : undefined,
                remove: () => void runScriptEdit({ op: 'remove', at: src }, line ? `Removed “${lineText(line).slice(0, 60)}”` : 'Removed').catch(reportError('Not removed')),
                add: (pos) => add({ key, req: { op: 'insert', at: src, where: 'after' }, kind, fields: src.fields, title: 'Add after this line' }, pos),
                addInside: src.inner
                    ? (pos) => add({ key, req: { op: 'insert', at: src, where: 'inside' }, kind, fields: src.fields, scope: src.innerScope ?? src.scope, subject: src.subject, title: src.subject ?? 'inside the block' }, pos)
                    : undefined,
                // (an if / else_if: an empty else after its chain — its statements are added with ⤷＋)
                addElse: src.ifKey
                    ? () =>
                    {
                        const key = src.ifKey!.startsWith('trigger_') ? 'trigger_else' : 'else';
                        void runScriptEdit({ op: 'insert', at: src, where: 'after', text: `${key} = {\n}` }, 'Added: else').catch(reportError('No else added'));
                    }
                    : undefined,
                // (an if / an iterator: a condition into its limit, about the iterator's item)
                addCondition: line?.limitSrc
                    ? (pos) =>
                    {
                        const t = sectionTarget(line.limitSrc!, line.limitSrc!.subject ? `Only if ${line.limitSrc!.subject}…` : 'Only if…');

                        if (t)
                            add(t, pos);
                    }
                    : undefined
            };
        };
        return {
            mod: { id: modId, name: modName },
            can,
            entry: can(entry),
            selected,
            select: (key) =>
            {
                setSelected(key);

                // (unless something inside has the focus already — an editor, a button)
                if (key && !view.current?.contains(document.activeElement))
                    view.current?.focus({ preventScroll: true });
            },
            actions: (src, line) => <RowActions src={src} ops={opsOf(src, line)} rows={rows.current} onShown={shown} />,
            offer: (src) =>
                src.owner ?
                    (
                        <OwnerOffer
                            src={src}
                            modName={modName}
                            onOverridden={() =>
                            {
                                if (src.stmt)
                                    pending.current = { owner: src.owner!, stmt: src.stmt, until: Date.now() + 60_000 };
                            }}
                        />
                    ) :
                    null,
            editor: (key) => (open?.key === key ? <InlineEditor open={open} onClose={() => setOpen(null)} /> : null),
            sectionAdd: (section, title, label, template?: string) =>
            {
                if (!section || !can(sectionSrc(section)))
                    return null;

                const t = sectionTarget(section, title, template);

                if (!t)
                    return null;

                return (
                    <span className="sec-add" onClick={(e) => e.stopPropagation()}>
                        <button
                            className="ghost small"
                            title={`${section.src ? 'Add to' : 'Create'} “${title}” (${section.kind === 'trigger' ? 'a condition' : section.kind === 'effect' ? 'an effect' : section.kind === 'modifier' ? 'a modifier' : section.kind === 'field' ? 'a setting' : 'script'})`}
                            onClick={(e) =>
                            {
                                const r = e.currentTarget.getBoundingClientRect();
                                add(t, { x: r.left, y: r.bottom + 4 });
                            }}
                        >
                            ＋ {label}
                        </button>
                        {open?.key === t.key && <InlineEditor open={open} onClose={() => setOpen(null)} />}
                    </span>
                );
            },
            act: (a, line) => (can(a.src) ? <ActButton act={a} line={line} /> : null),
            locText: (key, children) => (
                <LocEditable locKey={key} editable label="text">
                    {children}
                </LocEditable>
            )
        };
    }, [modId, modName, selected, open, entry]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void =>
    {
        if (!ctx)
            return;

        const t = e.target as HTMLElement;

        if (t.closest('input, textarea, select, .inline-editor'))
            return;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')
        {
            e.preventDefault();
            void undoEdit();
            return;
        }

        const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-anchor]')];

        // (nothing editable shown: the keys scroll as usual)
        if (!list.length)
            return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        {
            e.preventDefault();
            const i = list.findIndex((el) => el.dataset.anchor === selected);
            const next = list[e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1)];

            if (next)
            {
                setSelected(next.dataset.anchor!);
                next.scrollIntoView({ block: 'nearest' });
            }

            return;
        }

        if (e.key === 'Escape')
        {
            setSelected(null);
            return;
        }

        const ops = selected ? rows.current.get(selected)?.ops : undefined;

        if (!ops)
            return;

        const r = list.find((el) => el.dataset.anchor === selected)?.getBoundingClientRect();
        const at = r ? { x: r.left + 24, y: r.bottom + 4 } : undefined;

        if (e.key === 'Enter' && e.shiftKey && ops.editScript)
            ops.editScript();
        else if (e.key === 'Enter' || e.key === 'e' || e.key === 'F2')
            ops.edit(at);
        else if (e.key === 'Delete')
            ops.remove();
        else if (e.key === 'A')
            (ops.addInside ?? ops.add)(at);
        else if ((e.key === 'c' || e.key === 'C') && ops.addCondition)
            ops.addCondition(at);
        else if (e.key === 'E' && ops.addElse)
            ops.addElse();
        else if (e.key === 'a' || e.key === 'Insert')
            ops.add(at);
        else
            return;

        e.preventDefault();
    };
    return { ctx, onKeyDown, ref: view };
}

// ---------------------------------------------------------------------------
// Acts: what a placeholder or section offers itself (the faith cards: choose a doctrine, write a name, ＋ faith …)
// ---------------------------------------------------------------------------

/** Entries made in the active mod (a faith, a text, a group member, a term), reported in the change bar. */
async function makeEntries(creates: EntryCreate[], what: string): Promise<void>
{
    try
    {
        const r = await api.createEntries(creates);
        reportChange({ kind: 'ok', text: what, file: r.files[0], details: r.notes.length ? r.notes : undefined, undo: r.step });
    }
    catch (e)
    {
        reportError('Not made')(e);
    }
}

/** `color = { r g b }` (0–1, two decimals) of a #rrggbb */
const colorScript = (hex: string): string => `color = { ${[1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(2)).join(' ')} }`;
const hexOf = (rgb?: [number, number, number]): string =>
    '#' + (rgb ?? [0.5, 0.5, 0.5]).map((x) =>
        Math.round(Math.max(0, Math.min(1, x)) * 255)
            .toString(16)
            .padStart(2, '0')
    ).join('');

/** The text after "Label: " of a row (a term's current text as the dialog's start). */
const valueText = (line?: Line): string =>
{
    const t = lineText(line);
    const i = t.indexOf(': ');
    const v = (i >= 0 ? t.slice(i + 2) : t).replace(/ · from its religion$/, '');
    return v === 'not written' ? '' : v;
};

function ActButton({ act, line }: { act: LineAct; line?: Line; }): React.JSX.Element
{
    const d = act.do;
    const [dialog, setDialog] = useState(false);
    const color = useRef<HTMLInputElement>(null);
    // (the colour dialog's choice is written when it closes: the native change event)
    useEffect(() =>
    {
        const el = color.current;

        if (!el || d.kind !== 'color')
            return;

        const onChange = (): void =>
        {
            const text = colorScript(el.value);

            if (d.replace)
                void runScriptEdit({ op: 'replace', at: d.replace, text }, 'Changed the colour').catch(reportError('Not changed'));
            else if (d.at)
            {
                const t = sectionTarget(d.at, 'Colour');

                if (t)
                    void runScriptEdit({ ...t.req, text } as ScriptEditRequest, 'Set the colour').catch(reportError('Not added'));
            }
        };
        el.addEventListener('change', onChange);
        return () => el.removeEventListener('change', onChange);
    }, [d]);

    if (d.kind === 'loc')
        return (
            <span className="line-act" onClick={(e) => e.stopPropagation()}>
                <LocEditable locKey={d.key} editable multiline={d.multiline}>
                    {null}
                </LocEditable>
            </span>
        );

    const at = (e: React.MouseEvent): { x: number; y: number; } =>
    {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: r.left, y: r.bottom + 4 };
    };
    const run = (e: React.MouseEvent): void =>
    {
        e.stopPropagation();

        if (d.kind === 'pick')
        {
            const t = sectionTarget(d.at, d.title ?? act.label);

            if (!t)
                return;

            void pickStatement({ kind: 'field', type: d.fields, field: d.field, only: d.only, once: true, title: d.title, at: at(e) }).then((r) => void applyPicked(r, t.req, 'Added'));
        }
        else if (d.kind === 'add')
        {
            const t = sectionTarget(d.at, d.title);

            if (!t || t.kind === 'other')
                return;

            void pickStatement({ kind: t.kind, type: t.fields, scope: t.scope ?? t.req.at.scope, subject: t.subject, root: t.root ?? t.req.at.root, at: at(e), title: t.title, common: t.hint?.common, about: t.hint?.about, newEntries: true }).then((r) => void applyPicked(r, t.req, 'Added'));
        }
        else if (d.kind === 'group')
        {
            void pickStatement({ kind: 'field', type: 'doctrine_membership', field: 'group', once: true, title: 'Doctrine group', at: at(e) }).then((r) =>
            {
                const g = r && /group\s*=\s*(\S+)/.exec(r.text)?.[1];

                if (g)
                    void makeEntries([{ what: 'doctrine_group_member', key: d.doctrine, fields: [['group', g]] }], `Put ${d.doctrine} into ${g}`);
            });
        }
        else if (d.kind === 'color')
            color.current?.click();
        else
            setDialog(true);
    };
    return (
        <span className="line-act" onClick={(e) => e.stopPropagation()}>
            <button className="ghost small act-btn" title={act.label} onClick={run}>
                {act.label}
            </button>
            {d.kind === 'color' && <input ref={color} type="color" className="act-color" defaultValue={hexOf(d.now)} tabIndex={-1} />}
            {dialog && d.kind === 'faith' && <NewFaithDialog religion={d.religion} onClose={() => setDialog(false)} />}
            {dialog && d.kind === 'term' && (
                <PromptDialog
                    title={`${lineText(line).split(':')[0] || d.term} of ${d.owner.name}`}
                    label="Its text in game"
                    initial={valueText(line)}
                    confirm="Write"
                    onClose={() => setDialog(false)}
                    onConfirm={(text) => void makeEntries([{ what: 'term', key: d.term, fields: [['type', d.owner.type], ['owner', d.owner.name]], loc: text }], `Wrote ${d.term} of ${d.owner.name}`)}
                />
            )}
        </span>
    );
}

/** "＋ faith": its key and name in game — an empty faith in the religion, whose card then shows what it needs. */
function NewFaithDialog({ religion, onClose }: { religion: string; onClose: () => void; }): React.JSX.Element
{
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [edited, setEdited] = useState(false);
    const auto = name.trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const k = edited ? key : auto;
    const ok = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
    const create = (): void =>
    {
        if (!ok)
            return;

        onClose();
        void makeEntries([{ what: 'faith', key: k, fields: [['religion', religion]], loc: name.trim() || undefined }], `New faith ${k}`);
    };
    return (
        <Modal title={`New faith of ${religion}`} onClose={onClose}>
            <div className="field">
                <label>Name in game</label>
                <input autoFocus value={name} placeholder="e.g. Old Consanguinism" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            </div>
            <div className="field">
                <label>Key</label>
                <input value={k} spellCheck={false} onChange={(e) => (setEdited(true), setKey(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && create()} />
            </div>
            <p className="hint">Written empty into the religion’s faiths — its card then shows what it still needs (colour, icon, tenets, doctrines, holy sites, names).</p>
            <div className="actions">
                <button onClick={onClose}>Cancel</button>
                <button className="primary" disabled={!ok} onClick={create}>
                    Create
                </button>
            </div>
        </Modal>
    );
}

/** The hover actions of a row (and its keyboard operations, registered while it is shown). */
function RowActions({ src, ops, rows, onShown }: { src: LineSource; ops: RowOps; rows: Map<string, Row>; onShown: () => void; }): React.JSX.Element
{
    const key = anchorKey(src);
    useEffect(() =>
    {
        const row = { ops, src };
        rows.set(key, row);
        onShown();
        return () =>
        {
            if (rows.get(key) === row)
                rows.delete(key);
        };
    }, [rows, key, ops, src, onShown]);
    const pos = (e: React.MouseEvent): { x: number; y: number; } =>
    {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: r.left, y: r.bottom + 4 };
    };
    const click = (fn: (e: React.MouseEvent) => void) => (e: React.MouseEvent) =>
    {
        e.stopPropagation();
        fn(e);
    };
    return (
        <span className="row-actions">
            <button className="ghost" title={ops.editScript ? 'Change (Enter) — as script: Shift+Enter' : 'Edit (Enter)'} onClick={click((e) => ops.edit(pos(e)))}>
                ✎
            </button>
            <button className="ghost" title="Remove (Del) — undo with Ctrl+Z" onClick={click(() => ops.remove())}>
                ✕
            </button>
            <button className="ghost" title="Add after this line (A)" onClick={click((e) => ops.add(pos(e)))}>
                ＋
            </button>
            {ops.addInside && (
                <button className="ghost" title={`Add inside, at the end${src.subject ? ` — about ${src.subject}` : ''} (Shift+A)`} onClick={click((e) => ops.addInside!(pos(e)))}>
                    ⤷＋
                </button>
            )}
            {ops.addCondition && (
                <button className="ghost" title="Add a condition to its limit (C)" onClick={click((e) => ops.addCondition!(pos(e)))}>
                    ＋if
                </button>
            )}
            {ops.addElse && (
                <button className="ghost" title="Add an else: what happens when the conditions don't hold (Shift+E)" onClick={click(() => ops.addElse!())}>
                    ＋else
                </button>
            )}
        </span>
    );
}

/**
 * ✎ on a line of a scripted effect / trigger the entry calls that is not the active mod's (LineSource.owner): the
 * lines are that definition's own text — it is overridden into the mod first (asks, with the plan: where the copy goes,
 * why it can't), then this line opens for editing there (the controller finds it again once the index has the copy).
 */
function OwnerOffer({ src, modName, onOverridden }: { src: LineSource; modName: string; onOverridden: () => void; }): React.JSX.Element
{
    const owner = src.owner!;
    const [plan, setPlan] = useState<OverridePlan | 'loading' | null>(null);
    const [busy, setBusy] = useState(false);
    const what = owner.type === 'scripted_triggers' ? 'scripted trigger' : 'scripted effect';
    const whose = src.mod ? 'another mod’s' : 'the game’s';
    const open = (e: React.MouseEvent): void =>
    {
        e.stopPropagation();
        setPlan('loading');
        api.overridePlan(owner.type, owner.name).then(setPlan, (err: unknown) => setPlan({ problem: errorText(err), merging: false, loc: false, copy: { disabled: errorText(err), notes: [] }, file: { disabled: errorText(err), notes: [] } }));
    };
    const override = async (): Promise<void> =>
    {
        setBusy(true);

        try
        {
            const r = await api.overrideEntry({ type: owner.type, name: owner.name, mode: 'copy' });

            if (r.action === 'copied')
            {
                reportChange({ kind: 'ok', text: `Copied ${owner.name} to ${r.mod.name} — edit the line there`, mod: r.mod.name, where: `${r.rel}${r.line ? ':' + r.line : ''}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
                onOverridden();
            }
            else
                reportChange({ kind: 'info', text: `${owner.name} is in ${r.mod.name} already`, mod: r.mod.name, where: `${r.rel}${r.line ? ':' + r.line : ''}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined });

            setPlan(null);
        }
        catch (err)
        {
            reportEditError('Not overridden')(err);
            setBusy(false);
        }
    };
    const p = plan && plan !== 'loading' ? plan : undefined;
    const copy = p?.copy;
    return (
        <span className="row-actions owner-offer" onClick={(e) => e.stopPropagation()}>
            <button className="ghost" title={`Part of ${whose} ${what} ${owner.name} (${src.rel}) — override it in ${modName} to edit this line`} onClick={open}>
                ✎
            </button>
            {plan && (
                <Modal title={`Edit ${owner.name}?`} onClose={() => setPlan(null)}>
                    <div className="mods-confirm">
                        <p>
                            This line is part of {whose} {what} <code>{owner.name}</code> (<code>{src.rel}:{src.line}</code>), read where it is called: its lines are its own text, so a change applies wherever it is used.
                        </p>
                        {plan === 'loading' && <p>Checking…</p>}
                        {copy?.disabled && <p className="warn">{copy.disabled}</p>}
                        {copy?.open && (
                            <p>
                                {modName} has it already (<code>{copy.open.rel}:{copy.open.line}</code>) — wait until the index has taken it in, then edit the line here.
                            </p>
                        )}
                        {copy?.target && (
                            <p>
                                Override it in {modName}: a copy goes to <code>{copy.target}</code> and replaces {whose} for every call. Then this line opens for editing.
                            </p>
                        )}
                        {copy?.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
                    </div>
                    <div className="actions">
                        <button onClick={() => setPlan(null)}>{copy?.target ? 'Cancel' : 'Close'}</button>
                        {copy?.target && (
                            <button className="primary" autoFocus disabled={busy} onClick={() => void override()}>
                                {busy ? 'Copying…' : `Override in ${modName} and edit`}
                            </button>
                        )}
                    </div>
                </Modal>
            )}
        </span>
    );
}

// ---------------------------------------------------------------------------
// The inline editor
// ---------------------------------------------------------------------------

const SCALAR = /^([A-Za-z0-9_:.@$'-]+)\s*(=|==|!=|<=|>=|<|>|\?=)\s*(?:"([^"\n]*)"|([^\s{}"#]+))\s*$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const COMPARE = ['=', '!=', '<', '<=', '>', '>='];

interface Scalar
{
    key: string;
    op: string;
    value: string;
    quoted: boolean;
}

function parseScalar(text: string): Scalar | null
{
    const m = SCALAR.exec(text.trim());
    return m ? { key: m[1], op: m[2], value: m[3] ?? m[4], quoted: m[3] !== undefined } : null;
}

const scalarText = (s: Scalar): string => `${s.key} ${s.op} ${s.quoted ? `"${s.value}"` : s.value}`;

/** The database type a value names, from the line's links ("Has the trait ‹Brave›" → traits). */
function typeOfValue(value: string, line?: Line): string | undefined
{
    const name = value.replace(/^\w+:/, '');

    for (const s of line?.text ?? [])
        if (typeof s !== 'string' && s.ref && (s.ref.name === name || s.ref.name === value))
            return s.ref.type;

    return undefined;
}

/**
 * What a simple statement's value is — its field offers the like: a number or a script value (a number written, or a
 * script value's name), a scope (`root`, `scope:x`, a chain `liege.father`), a flag (a `…_flag` statement or
 * `flag:x`), an entry of a type (the line's link), else plain text.
 */
type ValueKind = { kind: 'number'; } | { kind: 'scope'; } | { kind: 'flag'; } | { kind: 'entry'; type: string; } | { kind: 'text'; };

const SCOPE_VALUE = /^(root|this|prev|from|scope:|[\w-]+\.)/;

function valueKindOf(s: Scalar, line?: Line): ValueKind
{
    const type = typeOfValue(s.value, line);

    if (NUMBER.test(s.value) || type === 'script_values')
        return { kind: 'number' };

    if (s.value.startsWith('flag:') || /(^|_)flag$/.test(s.key) || type === 'flag')
        return { kind: 'flag' };

    if (SCOPE_VALUE.test(s.value))
        return { kind: 'scope' };

    return type ? { kind: 'entry', type } : { kind: 'text' };
}

/** A value offered for a field: what is written, how it reads, a hint (where it is from). */
interface Suggestion
{
    value: string;
    label?: string;
    hint?: string;
}

/** Scopes every script can name (besides the shown event's own — picker/targets.ts). */
const COMMON_SCOPES: [string, string][] = [
    ['root', 'the one the script is about'],
    ['this', 'the current scope'],
    ['prev', 'the scope before this one'],
    ['scope:actor', 'an interaction’s actor'],
    ['scope:recipient', 'an interaction’s recipient'],
    ['scope:secondary_actor', 'an interaction’s secondary actor'],
    ['scope:secondary_recipient', 'an interaction’s secondary recipient'],
    ['liege', 'their liege'],
    ['top_liege', 'their top liege'],
    ['father', 'their father'],
    ['mother', 'their mother'],
    ['primary_spouse', 'their primary spouse'],
    ['primary_heir', 'their primary heir'],
    ['employer', 'who employs them'],
    ['host', 'whose court they are in'],
    ['primary_title', 'their primary title'],
    ['capital_county', 'their capital county'],
    ['faith', 'their faith'],
    ['culture', 'their culture'],
    ['dynasty', 'their dynasty'],
    ['house', 'their house']
];

const matches = (q: string, ...parts: (string | undefined)[]): boolean => !q || parts.some((p) => p?.toLowerCase().includes(q.toLowerCase()));

/** The active mod's entries first (their ModTouch), then the rest as listed (most used first). */
function mineFirst(list: RefEntry[]): RefEntry[]
{
    const active = pickerData.activeMod()?.toLowerCase();
    const mine = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    return [...list.filter(mine), ...list.filter((e) => !mine(e))];
}

/**
 * What a value field offers for what is typed (`q`, a `prefix:` left out): script values (the game's and the mods',
 * the active mod's first), scopes (the shown event's, the common ones), flags (those the game writes with this
 * statement — the key scan —, then any flag), entries of a type.
 */
async function suggestValues(kind: ValueKind, key: string, trigger: boolean, q: string): Promise<Suggestion[]>
{
    if (kind.kind === 'number')
    {
        if (!q || /^-?[\d.]+$/.test(q))
            return [];

        await pickerData.loaded('script_values');
        const active = pickerData.activeMod()?.toLowerCase();
        return mineFirst(pickerData.list('script_values') ?? [])
            .filter((e) => matches(q, e.name, e.display))
            .slice(0, 12)
            .map((e) => ({ value: e.name, label: e.display && e.display !== e.name ? e.display : undefined, hint: e.mod?.mods.some((m) => m.toLowerCase() === active) ? 'script value · your mod' : 'script value' }));
    }

    if (kind.kind === 'scope')
    {
        const own = viewTargets().map((x): Suggestion => ({ value: x.key, label: x.label, hint: x.about }));
        const common = COMMON_SCOPES.filter(([v]) => !own.some((o) => o.value === v)).map(([value, hint]): Suggestion => ({ value, hint }));
        return [...own, ...common].filter((s) => matches(q, s.value, s.label)).slice(0, 14);
    }

    if (kind.kind === 'flag')
    {
        await pickerData.keysLoaded();
        const info = pickerData.keys(trigger ? 'trigger' : 'effect')?.find((k) => k.key === key);
        const used = (info?.values ?? [])
            .map(([v, n]) => ({ v: v.replace(/^flag:/, ''), n }))
            .filter((x) => /^[\w.-]+$/.test(x.v) && matches(q, x.v))
            .map((x): Suggestion => ({ value: x.v, hint: `used ${x.n}× with ${key}` }));
        const more = q ? (await pickerData.search('flag', q)).filter((e) => !used.some((u) => u.value === e.name)).map((e): Suggestion => ({ value: e.name, hint: 'flag' })) : [];
        return [...used, ...more].slice(0, 14);
    }

    if (kind.kind === 'entry' && q)
        return (await api.search(q, { types: [kind.type], limit: 12 })).map((r) => ({ value: r.name, label: r.display && r.display !== r.name ? r.display : undefined }));

    return [];
}

function InlineEditor({ open, onClose }: { open: Open; onClose: () => void; }): React.JSX.Element
{
    const { target, mode, line } = open;
    const at = target.req.at;
    const [text, setText] = useState<string | null>(mode === 'add' ? (target.template ?? '') : null);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<Line[] | null>(null);
    const [script, setScript] = useState(mode === 'add');
    // what the statement's value was: a number or script value, a scope, a flag, an entry of a type (the field stays that
    // kind while typing)
    const [value, setValue] = useState<ValueKind>({ kind: 'text' });
    const area = useRef<HTMLTextAreaElement>(null);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() =>
    {
        if (mode !== 'edit')
            return;

        let alive = true;
        void api.scriptText(at).then((t) =>
        {
            if (!alive)
                return;

            if (t.problem)
                setProblem(t.problem);
            else
            {
                setText(t.text);
                const s = parseScalar(t.text);

                if (s)
                    setValue(valueKindOf(s, line));
            }
        });
        return () =>
        {
            alive = false;
        };
    }, [mode, at, line]);
    // the statement as it would read (live)
    useEffect(() =>
    {
        if (text === null || target.kind === 'other' || !text.trim())
        {
            setPreview(null);
            return;
        }

        const id = window.setTimeout(() =>
        {
            api.describeScript(text, target.kind as 'effect' | 'trigger' | 'modifier' | 'field', target.fields).then(setPreview, () => setPreview(null));
        }, 250);
        return () => window.clearTimeout(id);
    }, [text, target.kind]);
    useEffect(() =>
    {
        box.current?.scrollIntoView({ block: 'nearest' });

        if (script)
            area.current?.focus();
    }, [script, text === null]);

    const scalar = text !== null ? parseScalar(text) : null;
    const save = async (): Promise<void> =>
    {
        if (text === null || busy)
            return;

        setBusy(true);
        setProblem(null);

        try
        {
            await runScriptEdit({ ...target.req, text }, mode === 'edit' ? (text.trim() ? 'Edited' : 'Removed') : 'Added');
            onClose();
        }
        catch (e)
        {
            setProblem(errorText(e));
            setBusy(false);
        }
    };
    const keys = (e: React.KeyboardEvent): void =>
    {
        e.stopPropagation();

        if (e.key === 'Escape')
            onClose();
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
        {
            e.preventDefault();
            void save();
        }
    };
    const lines = text?.split('\n').length ?? 1;

    return (
        <div className="inline-editor" ref={box} onKeyDown={keys} onClick={(e) => e.stopPropagation()}>
            <div className="ie-head">
                <b>{mode === 'edit' ? 'Edit' : target.title}</b>
                <small title={at.file}>
                    {at.rel}:{at.line}
                </small>
                {scalar && mode === 'edit' && (
                    <span className="ie-modes">
                        <button className={'ghost small' + (!script ? ' on' : '')} onClick={() => setScript(false)}>
                            Value
                        </button>
                        <button className={'ghost small' + (script ? ' on' : '')} onClick={() => setScript(true)}>
                            Script
                        </button>
                    </span>
                )}
            </div>
            {problem && <div className="ie-problem">{problem}</div>}
            {text === null ?
                (
                    !problem && <div className="ie-wait">Reading the script…</div>
                ) :
                scalar && !script ?
                <ScalarForm scalar={scalar} trigger={target.kind === 'trigger'} value={value} onChange={(s) => setText(scalarText(s))} onSave={() => void save()} /> :
                (
                    <textarea
                        ref={area}
                        className="ie-script"
                        spellCheck={false}
                        value={text}
                        rows={Math.min(22, Math.max(3, lines + 1))}
                        placeholder={target.kind === 'trigger' ? 'e.g. is_adult = yes' : target.kind === 'effect' ? 'e.g. add_gold = 100' : 'script'}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) =>
                        {
                            if (e.key === 'Tab' && !e.shiftKey)
                            {
                                // a tab character, like the game's files
                                e.preventDefault();
                                const t = e.currentTarget;
                                const s = t.selectionStart;
                                t.setRangeText('\t', s, t.selectionEnd, 'end');
                                setText(t.value);
                            }
                        }}
                    />
                )}
            {preview && preview.length > 0 && (
                <div className="ie-preview">
                    <div className="ie-label">Reads as</div>
                    <ReadCtx.Provider
                        value={{
                            navigate: () =>
                            {},
                            showHidden: true
                        }}>
                        <EditCtx.Provider value={null}>
                            <LineList lines={preview} compact />
                        </EditCtx.Provider>
                    </ReadCtx.Provider>
                </div>
            )}
            <div className="ie-actions">
                <button className="primary" disabled={busy || text === null} onClick={() => void save()}>
                    {busy ? 'Saving…' : mode === 'edit' && text !== null && !text.trim() ? 'Remove' : 'Save'}
                </button>
                <button onClick={onClose}>Cancel</button>
                <small>Ctrl+Enter save · Esc cancel{mode === 'edit' ? ' · empty = remove' : ''}</small>
            </div>
        </div>
    );
}

/**
 * A simple statement (`add_gold = 100`, `age >= 16`, `has_trait = brave`, `is_child_of = scope:x`,
 * `has_character_flag = x`): the operator and value as fields — the value's field offers what the statement takes
 * (ValueKind, what it was when the editor opened: it stays that kind while typing).
 */
function ScalarForm(props: { scalar: Scalar; trigger: boolean; value: ValueKind; onChange: (s: Scalar) => void; onSave: () => void; }): React.JSX.Element
{
    const { scalar, onChange, value } = props;
    const ops = props.trigger ? (COMPARE.includes(scalar.op) ? COMPARE : [scalar.op, ...COMPARE]) : [scalar.op];
    const set = (patch: Partial<Scalar>): void => onChange({ ...scalar, ...patch });
    const what = value.kind === 'number' ? 'number or script value' : value.kind === 'scope' ? 'scope' : value.kind === 'flag' ? 'flag' : value.kind === 'entry' ? value.type : undefined;
    return (
        <div className="ie-scalar">
            <code className="ie-key">{scalar.key}</code>
            {ops.length > 1 ?
                (
                    <Select value={scalar.op} onChange={(e) => set({ op: e.target.value })}>
                        {ops.map((o) => (
                            <option key={o} value={o}>
                                {o}
                            </option>
                        ))}
                    </Select>
                ) :
                <code className="ie-op">{scalar.op}</code>}
            <ValueInput value={scalar.value} kind={value} statement={scalar.key} trigger={props.trigger} onChange={(v) => set({ value: v })} onSave={props.onSave} />
            {what && <small className="ie-type">{what}</small>}
        </div>
    );
}

/**
 * A value field with what the statement takes offered as you type (suggestValues): entries of a type keep a `prefix:`
 * (`trait:brave`), flags `flag:`; scopes and flags are listed right away. ↑ ↓ choose, Enter takes one (without a
 * list: saves), Esc closes the list.
 */
function ValueInput(props: { value: string; kind: ValueKind; statement: string; trigger: boolean; onChange: (v: string) => void; onSave: () => void; }): React.JSX.Element
{
    const { value, kind } = props;
    const [q, setQ] = useState<string | null>(kind.kind === 'scope' || kind.kind === 'flag' ? '' : null);
    const [hits, setHits] = useState<Suggestion[]>([]);
    const [hi, setHi] = useState(0);
    const [focused, setFocused] = useState(true);
    const prefix = kind.kind === 'scope' ? '' : (/^\w+:/.exec(value)?.[0] ?? '');
    useEffect(() =>
    {
        if (q === null || !focused)
        {
            setHits([]);
            return;
        }

        let alive = true;
        const id = window.setTimeout(() =>
        {
            void suggestValues(kind, props.statement, props.trigger, q).then((r) =>
            {
                if (!alive)
                    return;

                setHits(r.filter((s) => prefix + s.value !== value || r.length > 1));
                setHi(0);
            });
        }, 150);
        return () =>
        {
            alive = false;
            window.clearTimeout(id);
        };
    }, [q, kind, focused]);
    const pick = (s: Suggestion): void =>
    {
        props.onChange(prefix + s.value);
        setQ(null);
        setHits([]);
    };
    return (
        <span className="ie-entity">
            <input
                autoFocus
                value={value}
                spellCheck={false}
                inputMode={kind.kind === 'number' ? 'decimal' : undefined}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) =>
                {
                    props.onChange(e.target.value);
                    setQ(kind.kind === 'scope' ? e.target.value : e.target.value.replace(/^\w+:/, ''));
                }}
                onKeyDown={(e) =>
                {
                    if (hits.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
                    {
                        e.preventDefault();
                        setHi((h) => (e.key === 'ArrowDown' ? Math.min(hits.length - 1, h + 1) : Math.max(0, h - 1)));
                    }
                    else if (e.key === 'Enter' && !e.ctrlKey)
                    {
                        e.preventDefault();

                        if (hits.length)
                            pick(hits[hi]);
                        else
                            props.onSave();
                    }
                    else if (e.key === 'Escape' && hits.length)
                    {
                        e.stopPropagation();
                        setHits([]);
                        setQ(null);
                    }
                }}
            />
            {hits.length > 0 && (
                <span className="ie-hits">
                    {hits.map((s, i) => (
                        <span key={s.value} className={'ie-hit' + (i === hi ? ' on' : '')} title={s.hint} onMouseDown={(e) => (e.preventDefault(), pick(s))}>
                            {s.label ?? s.value}
                            {(s.label || s.hint) && <small>{s.label ? s.value : s.hint}</small>}
                        </span>
                    ))}
                </span>
            )}
        </span>
    );
}

// ---------------------------------------------------------------------------
// The hint bar of the readable view
// ---------------------------------------------------------------------------

/**
 * What editing this entry takes: set an active mod, load it, override the entry in it — or, when the entry is written
 * in the active mod, how to edit it here.
 */
export function EditBar(props: { src?: LineSource; type: string; name: string; navigate: Navigate; }): React.JSX.Element | null
{
    const { src, navigate } = props;
    const active = useActiveMod();
    // (a localization key: its text is changed in place also when it is the game's — an override in the replace folder)
    const loc = !!src && /\.yml$/i.test(src.rel);

    if (!src || !(/\.txt$/i.test(src.rel) || loc))
        return null;

    const mods = (
        <button className="ghost small" onClick={() => navigate({ type: MODS_ROUTE })}>
            Mods page
        </button>
    );

    if (!active.mod)
        return (
            <div className="edit-bar none">
                <span>✎ To edit this in your own mod, set an active mod (Mods page: “New mod…”, or a mod’s ⋯ → Set as active mod).</span>
                {mods}
            </div>
        );

    if (!active.loaded)
        return (
            <div className="edit-bar none">
                <span>✎ The active mod {active.mod.name} is not in the mod list loaded in the explorer — load a list with it to edit here.</span>
                {mods}
            </div>
        );

    if (loc)
        return (
            <div className="edit-bar mine" title="Hover the text for ✎ — Enter saves, Ctrl+Z undoes">
                <span>
                    ✎ {src.mod?.toLowerCase() === active.mod.id.toLowerCase()
                        ? (
                            <>
                                Editing <b>{active.mod.name}</b> · {src.rel}
                            </>
                        )
                        : (
                            <>
                                Written in {src.mod ? 'another mod' : 'the game'} ({src.rel}) — ✎ on the text writes it into <b>{active.mod.name}</b>’s replace folder, which wins
                            </>
                        )}
                </span>
                <small>✎ on the text · Ctrl+Z undo</small>
            </div>
        );

    if (src.mod?.toLowerCase() !== active.mod.id.toLowerCase())
        return (
            <div className="edit-bar other">
                <span>✎ Written in {src.mod ? 'another mod' : 'the game'} ({src.rel}) — override it in {active.mod.name} to edit it here:</span>
                <OverrideButton type={props.type} name={props.name} navigate={navigate} compact />
            </div>
        );

    return (
        <div className="edit-bar mine" title="Hover a line for ✎ edit, ✕ remove, ＋ add — or select lines with ↑ ↓ and press Enter / Del / A (Shift+A: inside) · Ctrl+Z undoes">
            <span>
                ✎ Editing <b>{active.mod.name}</b> · {src.rel}
            </span>
            <small>↑↓ select · Enter edit · Del remove · A add · Ctrl+Z undo</small>
        </div>
    );
}

// ---------------------------------------------------------------------------
// The Source tab's editor (the fallback for everything else)
// ---------------------------------------------------------------------------

/**
 * A definition of the active mod as plain script, saved through the same checks — or a localization key's line
 * (` key:0 "text"`: one line of the same key; the file's byte order mark and header stay).
 */
export function SourceEditor({ src, onClose }: { src: LineSource; onClose: () => void; }): React.JSX.Element
{
    // (a localization key: its line ` key:0 "text"`)
    const loc = /\.yml$/i.test(src.rel);
    const [text, setText] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() =>
    {
        let alive = true;
        void api.scriptText(src).then((t) =>
        {
            if (!alive)
                return;

            if (t.problem)
                setProblem(t.problem);
            else
                setText(t.text);
        });
        return () =>
        {
            alive = false;
        };
    }, [src]);
    const save = async (): Promise<void> =>
    {
        if (text === null || busy)
            return;

        if (!text.trim())
        {
            setProblem('Empty — to remove the definition use “Remove from …” in the Override menu.');
            return;
        }

        setBusy(true);
        setProblem(null);

        try
        {
            await runScriptEdit({ op: 'replace', at: src, text }, loc ? 'Saved the text' : 'Saved the definition');
            onClose();
        }
        catch (e)
        {
            setProblem(errorText(e));
            setBusy(false);
        }
    };
    return (
        <div
            className="source-editor"
            onKeyDown={(e) =>
            {
                if (e.key === 'Escape')
                    onClose();
                else if ((e.key === 'Enter' || e.key.toLowerCase() === 's') && (e.ctrlKey || e.metaKey))
                {
                    e.preventDefault();
                    void save();
                }
            }}
        >
            {problem && <div className="ie-problem">{problem}</div>}
            {text === null ?
                (
                    !problem && <div className="ie-wait">Reading the script…</div>
                ) :
                (
                    <textarea
                        className="ie-script"
                        autoFocus
                        spellCheck={false}
                        value={text}
                        rows={Math.min(40, text.split('\n').length + 2)}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) =>
                        {
                            if (e.key === 'Tab' && !e.shiftKey)
                            {
                                e.preventDefault();
                                const t = e.currentTarget;
                                t.setRangeText('\t', t.selectionStart, t.selectionEnd, 'end');
                                setText(t.value);
                            }
                        }}
                    />
                )}
            <div className="ie-actions">
                <button className="primary" disabled={busy || text === null} onClick={() => void save()}>
                    {busy ? 'Saving…' : 'Save'}
                </button>
                <button onClick={onClose}>Cancel</button>
                <small>{loc ? 'Ctrl+S save · Esc cancel · one line: key:0 "text" (the same key); undo in the change bar' : 'Ctrl+S save · Esc cancel · checked before writing (parses, braces balance); undo in the change bar'}</small>
            </div>
        </div>
    );
}
