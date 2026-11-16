import { useEffect, useMemo, useRef, useState } from 'react';
import { pickBirth, pickLifeEvent, pickRelative } from '../characterPick';
import type { EntityCard, EntityKey, EntryCreate, Line, LineAct, LineSource, OnActionList, OverridePlan, PickPlace, PickResult, ScriptEditRequest, SectionSource, StatementCheck, StatementKind } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { useActiveMod, useLoadedMods } from '../modStore';
import { pickChoice, pickStatement } from '../picker/pickStatement';
import { pickerData } from '../picker/data';
import { awayAt, inReach, placeOf, prevOf, scopeGuessOf, typedScopeWarning, viewTargets, viewTargetsKnown } from '../picker/targets';
import type { RefEntry } from '../picker/model';
import { canPickEdit } from '../picker/model';
import { createsOf, notKeptText, redoEdit, reportEditError, runScriptEdit, undoEdit } from '../scriptEdits';
import { reportChange } from '../changes';
import { LocEditable } from './LocEdit';
import { EditCtx, anchorKey, sectionSrc, type LineEditing } from './editCtx';
import { Modal, PromptDialog, errorText } from './ModDialogs';
import { MODS_ROUTE } from './ModsView';
import { OverrideButton } from './OverrideMenu';
import { LineList, ReadCtx } from './rich';
import '../styles/edit.css';
import { Select } from './Select';
import { openPictureChooser } from './PictureChooser';
import { gameListNames, kindsLabel, kindsOf, listsRightAway, parseScalar, scalarText, suggestValues, type Scalar, type Suggestion, type ValueKind, type ValueSources } from './valueKinds';
import { commentsOf, keepWritten, replacesStatement, sameScript } from '../../../shared/scriptFormat';

import { tr } from '../../../shared/i18n';
/**
 * Editing in place (docs/mods.md, "Editing in place"): the readable view's lines whose statement is written in the
 * active mod get ✎ edit, ✕ remove and ＋ add (after the line; inside blocks), sections "＋ Add …", by mouse or
 * keyboard (↑ ↓ select, Enter edit, Del remove, A add after, Shift+A add inside, Ctrl+Z undo). Edits go through the
 * main process (src/main/mods/scriptEdit.ts: checked, written, undoable); the index takes the file in and the views
 * reload. Adding and changing effects, conditions, stat modifiers and settings (an opinion modifier's, costs, script
 * value formulas, a character's traits, a trait's opinions) goes through the statement picker: changing opens it at
 * the statement's values ("Keep …"); what it can't read (blocks, wrapped statements) and a new option the script
 * editor (Shift+Enter: always the script editor).
 */

const reportError = reportEditError;

/**
 * A picker result into the file: the new entries it needs (a new opinion modifier, a doctrine parameter, a new trait …)
 * and the statement, in one request (ScriptEditRequest.creates): the main process makes the entries, then writes the
 * statement. One undo step takes both back; a refused statement takes the entries back at once, leaving no step.
 */
async function applyPicked(r: PickResult | null, req: Omit<ScriptEditRequest, 'text'>, verb: 'Added' | 'Changed'): Promise<void>
{
    if (!r?.text.trim())
        return;

    const made = createsOf(r.creates);

    // (written next to the block it was asked for (a tenet with its DLC beside the `tenets` list): after the list, into
    // the definition when there is no list yet, or in place of the list's item)
    if (r.outside)
        req = req.op === 'replace' ? { ...req, outside: true } : req.wrap ? { ...req, wrap: undefined } : req.where === 'inside' ? { ...req, where: 'after' } : req;

    const done = verb === 'Added' ? (r.summary ? tr('Added: {summary}', { summary: r.summary }) : tr('Added')) : (r.summary ? tr('Changed: {summary}', { summary: r.summary }) : tr('Changed'));
    await runScriptEdit({ ...req, text: r.text, ...(made.creates ? { creates: made.creates } : {}) } as ScriptEditRequest, done + made.note).catch(reportError(verb === 'Added' ? tr('Not added') : tr('Not changed')));
}

/**
 * An entry into an on_action's list (its story's "＋ event" / "＋ on_action"): an event or on_action from the picker,
 * written as its id (`weight = id` in the random lists) into the list (made when missing). `before`: the list's entry the
 * new one goes in front of (a `first_valid` list whose last event has no trigger: it always applies, so a new one after
 * it would never be reached).
 */
export async function addListEntry(section: SectionSource, field: 'event' | 'on_action', weighted: boolean, title: string, at?: { x: number; y: number; }, before?: LineSource): Promise<void>
{
    const t = sectionTarget(section, title);
    const r = t && (await pickStatement({ kind: 'field', type: 'on_action_lists', field, once: true, title, at }));
    const id = r && /=\s*([\w.:-]+)\s*$/.exec(r.text.trim())?.[1];

    if (!t || !id)
        return;

    const req = before && section.src ? { op: 'insert', at: before, where: 'before' } : t.req;
    await runScriptEdit({ ...req, text: weighted ? `100 = ${id}` : id } as ScriptEditRequest, tr('Added: {title} {id}', { title, id })).catch(reportError(tr('Not added')));
}

/**
 * The delay or a chance at the start of an on_action's list (its story's "Delay…" / "Chance of no event…"): the time or
 * the percent from the picker, written as `delay = { <time> }` / `chance_of_no_event = N` right before the list's first
 * entry (inside an empty list); the one already there is replaced. `before`: a delay from a later entry on ("Delay from
 * here…", the chip's ✎): written right before that entry, or in place of the delay written there (`before.delay`); the
 * game reads a list in order and a new delay overrides the one before (_on_actions.info).
 */
export async function addListSetting(section: SectionSource, list: OnActionList, field: 'duration' | 'chance_of_no_event' | 'chance_to_happen', title: string, at?: { x: number; y: number; }, ed?: LineEditing | null, before?: { entry: LineSource; delay?: LineSource; }): Promise<void>
{
    const t = sectionTarget(section, title);
    const have = before ? before.delay : field === 'duration' ? list.delay : list[field];

    if (!t)
        return;

    const was = have ? await api.scriptText(have).catch(() => null) : null;

    // (a statement with a comment inside would lose it when the picked number replaced it whole: its script editor opens
    // instead, at the text as written; a comment after it on its line stays either way)
    if (have && ed && (!was || was.problem || commentsOf(was.text).length))
    {
        ed.editScript(have, tr('“{title}” has a comment inside: the script editor opened so it is not lost', { title: title.replace(/…$/, '') }));
        return;
    }

    // (a written delay: its time is changed, "Keep" first; a range, `months = { 6 12 }`, too)
    const time = field === 'duration' && was && !was.problem ? /^\s*delay\s*=\s*\{\s*([\s\S]*?)\s*\}\s*$/.exec(was.text)?.[1] : undefined;
    const r = await pickStatement({ kind: 'field', type: 'on_action_lists', field, once: true, title, at, ...(time ? { edit: time } : {}) });
    const text = r?.text.trim();

    if (!text)
        return;

    const written = field === 'duration' ? `delay = { ${text} }` : text;

    // (kept as it was: nothing to write)
    if (was && !was.problem && sameScript(written, was.text))
        return;
    const req: Omit<ScriptEditRequest, 'text'> = have ? { op: 'replace', at: have } : before ? { op: 'insert', at: before.entry, where: 'before' } : list.first ? { op: 'insert', at: list.first, where: 'before' } : t.req;
    await runScriptEdit({ ...req, text: written }, tr('Set: {title}', { title: title.replace(/…$/, '') })).catch(reportError(tr('Not set')));
}

/**
 * An on_action's fallback (its story's "If nothing else fires"): an event as `fallback_event = id` or an on_action as
 * `fallback = id`, written into the on_action's own block.
 */
export async function addFallback(def: LineSource, field: 'event' | 'on_action', title: string, at?: { x: number; y: number; }): Promise<void>
{
    const r = await pickStatement({ kind: 'field', type: 'on_action_lists', field, once: true, title, at });
    const id = r && /=\s*([\w.:-]+)\s*$/.exec(r.text.trim())?.[1];

    if (!id)
        return;

    await runScriptEdit({ op: 'insert', at: def, where: 'inside', text: `${field === 'event' ? 'fallback_event' : 'fallback'} = ${id}` }, tr('Added: {title} {id}', { title, id })).catch(reportError(tr('Not added')));
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
    /** the scope type and who "Self" is where it goes (inside an iterator: the item), else the anchor's */
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

/** What OwnerOffer does on a line once its definition is the mod's: the row's ✎, ✕, ＋ or ⤷＋. */
type PendingOp = 'edit' | 'remove' | 'add' | 'addInside';

/**
 * A line of a scripted effect / trigger overridden into the mod to be changed (OwnerOffer): once the view shows the
 * mod's copy, the row of the same statement (its checks, whitespace left out) gets `op`, until `until`.
 */
interface PendingEdit
{
    owner: EntityKey;
    stmt: StatementCheck;
    op: PendingOp;
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

/**
 * The prev stack and the scope's guess for a target's pick request (picker/targets.ts prevOf, scopeGuessOf): the guess
 * only while the request's scope is the anchor's (a section may give its own).
 */
function scopeHintsOf(t: Target): { prev?: (string | null | undefined)[]; scopeGuessed?: boolean; }
{
    const at = t.req.at;
    const anchored = t.req.op === 'insert' && t.req.where === 'inside' && !t.req.wrap ? (at.innerScope ?? at.scope) : at.scope;
    const guessed = scopeGuessOf(t.req) && (t.scope === undefined || t.scope === anchored);
    return { prev: prevOf(t.req), ...(guessed ? { scopeGuessed: true } : {}) };
}

/** A section's add target: into its block, or a new block created where it belongs. */
function sectionTarget(s: SectionSource, title: string, template?: string): Target | undefined
{
    const kind = s.kind;
    // (a condition block whose root is no character (documented, SectionSource.hint): Self at its top is that)
    const root = s.hint && s.scope && s.scope !== 'character' && !s.subject ? s.scope : undefined;
    const who = { scope: s.scope ?? s.src?.innerScope, subject: s.subject ?? s.src?.subject, ...(s.hint ? { hint: s.hint } : {}), ...(root ? { root } : {}) };

    if (s.src)
        return { key: 'sec:' + anchorKey(s.src) + ':' + s.key, req: { op: 'insert', at: s.src, where: 'inside', ...(s.fromTrack ? { fromTrack: s.fromTrack } : {}) }, kind, fields: s.src.fields, title, template, ...who };

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

        hits.sort((a, b) => around(b[1].src.stmt) - around(a[1].src.stmt));
        const [key, row] = hits[0];
        // (the copy has two statements alike that their surroundings don't tell apart (a copy formatted anew): which
        // one is meant is unclear)
        const sure = hits.length === 1 || around(hits[1][1].src.stmt) < around(row.src.stmt);
        pending.current = null;
        setSelected(key);
        const el = view.current?.querySelector(`[data-anchor="${CSS.escape(key)}"]`);
        el?.scrollIntoView({ block: 'center' });
        const r = el?.getBoundingClientRect();
        const at = r ? { x: r.left + 24, y: r.bottom + 4 } : undefined;

        // (a remove was confirmed in OwnerOffer's dialog; undo takes it back, then the override; only when the line is
        // known for sure: a wrong one would be gone at once, so the user removes it from the selected row)
        if (p.op === 'remove')
        {
            if (sure)
                row.ops.remove();
            else
                reportChange({ kind: 'info', text: tr('The copy has this line more than once: the first is selected, press Del (or ✕) on the one to remove'), mod: modName, where: `${row.src.rel}:${row.src.line}`, file: row.src.file, line: row.src.line });
        }
        else if (p.op === 'add')
            row.ops.add(at);
        else if (p.op === 'addInside')
        {
            // (no falling back to "after the line": the dialog said "at the end of this block")
            if (row.ops.addInside)
                row.ops.addInside(at);
            else
                reportChange({ kind: 'info', text: tr('The block was not found in the copy: nothing was added, the copy stays'), mod: modName, where: `${row.src.rel}:${row.src.line}`, file: row.src.file, line: row.src.line });
        }
        else
            row.ops.edit(at);
    };
    // (rows register in their effects: the claim looks once all of a render's rows are there)
    const shown = (): void =>
    {
        if (pending.current && claimTimer.current === undefined)
            claimTimer.current = window.setTimeout(claim, 0);
    };
    const modId = active.mod && active.loaded ? active.mod.id : undefined;
    const modName = active.mod?.name ?? '';
    // (a loaded save's entries are edited too: the save changes, docs/saves.md)
    const saveId = useLoadedMods().find((m) => m.id.startsWith('save:'))?.id;

    const ctx = useMemo<LineEditing | null>(() =>
    {
        if (!modId && !saveId)
            return null;

        const can = (src: LineSource | undefined): boolean => !!src?.mod && ((!!modId && src.mod.toLowerCase() === modId.toLowerCase()) || src.mod === saveId);
        const add = (t: Target, at?: { x: number; y: number; }): void =>
        {
            if (t.template !== undefined || t.kind === 'other')
            {
                setOpen({ key: t.key, mode: 'add', target: t });
                return;
            }

            void pickStatement({ kind: t.kind, type: t.fields, scope: t.scope ?? t.req.at.scope, subject: t.subject, root: t.root ?? t.req.at.root, at, title: t.title, common: t.hint?.common, about: t.hint?.about, newEntries: true, place: placeOf(t.req), ...scopeHintsOf(t) }).then((r) =>
            {
                void applyPicked(r, t.req, 'Added');
            });
        };
        const opsOf = (src: LineSource, line?: Line): RowOps =>
        {
            const key = anchorKey(src);
            const kind = src.kind;
            // (a block row without a line of its own (an option) edits as plain script)
            const script = (): void => setOpen({ key, mode: 'edit', target: { key, req: { op: 'replace', at: src }, kind: line ? kind : 'other', fields: src.fields, title: tr('Edit') }, line });
            // a statement the picker may read back, also a block of statements (if, NOT / OR, scope switches, iterators:
            // their head; any other block field by field; comments inside kept by keepWritten)
            const pickable = !!line && kind !== 'other';
            // (where a change goes: the shown entry's scopes in reach there, picker/targets.ts)
            const place = placeOf({ op: 'replace', at: src });
            return {
                edit: (pos) =>
                {
                    // (a picture: the picture chooser, not the value as text)
                    const pic = line?.act?.do.kind === 'picture' ? line.act.do : undefined;

                    if (pic)
                        return openPictureChooser({ statement: pic.key, now: pic.now, replace: pic.replace, width: pic.width, height: pic.height, entry: shownEntry?.name });

                    if (!pickable)
                        return script();

                    void api.scriptText(src).then(
                        (t) =>
                        {
                            if (t.problem || !canPickEdit(kind, t.text, src.fields))
                                return script();

                            void pickStatement({ kind: kind as 'effect' | 'trigger' | 'modifier' | 'field', type: src.fields, scope: src.scope, root: src.root, at: pos, title: tr('Change'), edit: t.text, elseAfter: t.elseAfter, only: line?.choices, newEntries: true, place, prev: src.prev, scopeGuessed: src.scopeGuessed }).then((r) =>
                            {
                                // (kept as it was, spacing and comments aside: nothing to write)
                                if (r && !r.creates?.length && sameScript(r.text, t.text))
                                    return;

                                if (!r || r.outside)
                                    return void applyPicked(r, { op: 'replace', at: src }, 'Changed');

                                // (what the picker left as it was keeps its written layout (line breaks, spacing,
                                // blocks on one line) and its comments; a comment next to a statement the picker removed
                                // or replaced goes with it (main's note names it); not for a statement written next to
                                // this one, `outside`)
                                const kept = keepWritten(t.text, r.text, t.indent);

                                // (a comment inside a statement the picker replaced: it would be lost, the script
                                // editor opens instead, at the text as written; so it does where the comments could
                                // not be placed)
                                if (kept.text === null)
                                {
                                    reportChange({ kind: 'info', text: notKeptText(kept.why, true), mod: modName, where: `${src.rel}:${src.line}`, file: src.file, line: src.line });
                                    return script();
                                }

                                // (another statement in its place: the comments above the old one and after it on its line
                                // are about it, they go along; main names them. The same statement changed, or kept inside
                                // a wrapper (if, random, NOT, hidden_effect), keeps them)
                                void applyPicked({ ...r, text: kept.text }, { op: 'replace', at: src, ...(replacesStatement(t.text, kept.text) ? { withComments: true } : {}) }, 'Changed');
                            });
                        },
                        () => script()
                    );
                },
                editScript: pickable ? script : undefined,
                remove: () => void runScriptEdit({ op: 'remove', at: src }, line ? tr('Removed “{line}”', { line: lineText(line).slice(0, 60) }) : tr('Removed')).catch(reportError(tr('Not removed'))),
                add: (pos) => add({ key, req: { op: 'insert', at: src, where: 'after' }, kind, fields: src.fields, title: tr('Add after this line') }, pos),
                addInside: src.inner
                    ? (pos) => add({ key, req: { op: 'insert', at: src, where: 'inside' }, kind, fields: src.innerFields ?? src.fields, scope: src.innerScope ?? src.scope, subject: src.subject, title: src.subject ?? tr('inside the block') }, pos)
                    : undefined,
                // (an if / else_if: an empty else after its chain; its statements are added with ⤷＋)
                addElse: src.ifKey
                    ? () =>
                    {
                        const key = src.ifKey!.startsWith('trigger_') ? 'trigger_else' : 'else';
                        void runScriptEdit({ op: 'insert', at: src, where: 'after', text: `${key} = {\n}` }, tr('Added: else')).catch(reportError(tr('No else added')));
                    }
                    : undefined,
                // (an if / an iterator: a condition into its limit, about the iterator's item)
                addCondition: line?.limitSrc
                    ? (pos) =>
                    {
                        const t = sectionTarget(line.limitSrc!, line.limitSrc!.subject ? tr('Only if {subject}…', { subject: line.limitSrc!.subject }) : tr('Only if…'));

                        if (t)
                            add(t, pos);
                    }
                    : undefined
            };
        };
        return {
            mod: { id: modId ?? saveId!, name: modId ? modName : tr('Savegame') },
            can,
            entry: can(entry),
            selected,
            select: (key) =>
            {
                setSelected(key);

                // (unless something inside has the focus already: an editor, a button)
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
                            onOverridden={(op) =>
                            {
                                if (src.stmt)
                                    pending.current = { owner: src.owner!, stmt: src.stmt, op, until: Date.now() + 60_000 };
                            }}
                        />
                    ) :
                    null,
            editor: (key) => (open?.key === key ? <InlineEditor open={open} onClose={() => setOpen(null)} /> : null),
            editScript: (src, why) =>
            {
                const key = anchorKey(src);
                setSelected(key);
                setOpen({ key, mode: 'edit', target: { key, req: { op: 'replace', at: src }, kind: 'other', fields: src.fields, title: tr('Edit') } });

                if (why)
                    reportChange({ kind: 'info', text: why, mod: modName, where: `${src.rel}:${src.line}`, file: src.file, line: src.line });
            },
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
                            title={`${section.src ? tr('Add to') : tr('Create')} “${title}” (${section.kind === 'trigger' ? tr('a condition') : section.kind === 'effect' ? tr('an effect') : section.kind === 'modifier' ? tr('a modifier') : section.kind === 'field' ? tr('a setting') : 'script'})`}
                            onClick={(e) =>
                            {
                                const r = e.currentTarget.getBoundingClientRect();
                                const pos = { x: r.left, y: r.bottom + 4 };
                                const into = section.into;

                                if (!into?.length)
                                    return add(t, pos);

                                // (several blocks and nothing of its own at the top: which block first, then the picker
                                // there with that block's kind, as its ⤷＋; two blocks that read the same (two
                                // county_modifier blocks) are told apart by their line)
                                const twice = (b: { label: string; }): boolean => into.filter((x) => x.label === b.label).length > 1;
                                const hint = (b: (typeof into)[number]): string => (twice(b) && b.at.src ? tr('{key}, line {line}', { key: b.at.key, line: b.at.src.line }) : b.at.key);
                                void pickChoice({ title: tr('Into which block?'), items: into.map((b, i) => ({ label: b.label, hint: hint(b), value: String(i) })) }, { at: pos, title }).then((v) =>
                                {
                                    const b = v === null ? undefined : into[Number(v)];
                                    const bt = b && sectionTarget(b.at, b.label);

                                    if (bt)
                                        add(bt, pos);
                                });
                            }}
                        >
                            ＋ {label}
                        </button>
                        {open?.key === t.key && <InlineEditor open={open} onClose={() => setOpen(null)} />}
                    </span>
                );
            },
            // (a new relative, a birth date need only an active mod: the character is copied into it when it must change)
            act: (a, line) => (can(a.src) || ((a.do.kind === 'relative' || a.do.kind === 'birth' || a.do.kind === 'life') && !!modId) ? <ActButton act={a} line={line} /> : null),
            locText: (key, children) => (
                <LocEditable locKey={key} editable label="text">
                    {children}
                </LocEditable>
            )
        };
    }, [modId, modName, saveId, selected, open, entry]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void =>
    {
        if (!ctx)
            return;

        const t = e.target as HTMLElement;

        if (t.closest('input, textarea, select, .inline-editor'))
            return;

        // (Escape outside an open editor (one opened as script by a notice, the focus left on the button that opened it):
        // the editor closes first, nothing written; then the selection. The picker takes its keys before they get here.)
        if (e.key === 'Escape' && open)
        {
            e.preventDefault();
            setOpen(null);
            return;
        }

        // (Ctrl+Y or Ctrl+Shift+Z: redo)
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z')))
        {
            e.preventDefault();
            void redoEdit();
            return;
        }

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
        reportError(tr('Not made'))(e);
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
                void runScriptEdit({ op: 'replace', at: d.replace, text }, tr('Changed the colour')).catch(reportError(tr('Not changed')));
            else if (d.at)
            {
                const t = sectionTarget(d.at, 'Colour');

                if (t)
                    void runScriptEdit({ ...t.req, text } as ScriptEditRequest, tr('Set the colour')).catch(reportError(tr('Not added')));
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

            void pickStatement({ kind: t.kind, type: t.fields, scope: t.scope ?? t.req.at.scope, subject: t.subject, root: t.root ?? t.req.at.root, at: at(e), title: t.title, common: t.hint?.common, about: t.hint?.about, newEntries: true, place: placeOf(t.req), ...scopeHintsOf(t) }).then((r) => void applyPicked(r, t.req, 'Added'));
        }
        else if (d.kind === 'group')
        {
            void pickStatement({ kind: 'field', type: 'doctrine_membership', field: 'group', once: true, title: tr('Doctrine group'), at: at(e) }).then((r) =>
            {
                const g = r && /group\s*=\s*(\S+)/.exec(r.text)?.[1];

                if (g)
                    void makeEntries([{ what: 'doctrine_group_member', key: d.doctrine, fields: [['group', g]] }], tr('Put {doctrine} into {g}', { doctrine: d.doctrine, g }));
            });
        }
        else if (d.kind === 'modernize')
            void makeEntries([{ what: 'modernize', key: d.name, fields: [['type', d.type], ['fix', d.fix]] }], tr('{name} updated for 1.20', { name: d.name }));
        else if (d.kind === 'birth')
            void pickBirth(d.character, d.birth, at(e));
        else if (d.kind === 'relative')
            void pickRelative(d, at(e));
        else if (d.kind === 'life')
            void pickLifeEvent(d, at(e));
        else if (d.kind === 'bookmarkCharacter')
        {
            // a historical character (the picker's character list), then the block filled from history at the bookmark's date
            void pickStatement({ kind: 'field', type: 'bookmark_character', field: 'history_id', once: true, title: d.under ? tr('A character beside them') : tr('A character of the bookmark'), at: at(e) }).then((r) =>
            {
                const id = r && /history_id\s*=\s*"?([\w.-]+)"?/.exec(r.text)?.[1];

                if (id)
                    void makeEntries([{ what: 'bookmark_character', key: d.bookmark, fields: [['history_id', id], ...(d.under ? [['under', d.under] as [string, string]] : [])] }], tr('Added {id} to {bookmark}', { id, bookmark: d.bookmark }));
            });
        }
        else if (d.kind === 'color')
            color.current?.click();
        else if (d.kind === 'picture')
            openPictureChooser({ statement: d.key, now: d.now, replace: d.replace, width: d.width, height: d.height, entry: shownEntry?.name });
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
                    title={tr('{term} of {name}', { term: lineText(line).split(':')[0] || d.term, name: d.owner.name })}
                    label={tr('Its text in game')}
                    initial={valueText(line)}
                    confirm={tr('Write')}
                    onClose={() => setDialog(false)}
                    onConfirm={(text) => void makeEntries([{ what: 'term', key: d.term, fields: [['type', d.owner.type], ['owner', d.owner.name]], loc: text }], tr('Wrote {term} of {name}', { term: d.term, name: d.owner.name }))}
                />
            )}
        </span>
    );
}

/** "＋ faith": its key and name in game; an empty faith in the religion, whose card then shows what it needs. */
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
        void makeEntries([{ what: 'faith', key: k, fields: [['religion', religion]], loc: name.trim() || undefined }], tr('New faith {k}', { k }));
    };
    return (
        <Modal title={tr('New faith of {religion}', { religion })} onClose={onClose}>
            <div className="field">
                <label>{tr('Name in game')}</label>
                <input autoFocus value={name} placeholder={tr('e.g. Old Consanguinism')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            </div>
            <div className="field">
                <label>{tr('Key')}</label>
                <input value={k} spellCheck={false} onChange={(e) => (setEdited(true), setKey(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && create()} />
            </div>
            <p className="hint">{tr('Written empty into the religion’s faiths — its card then shows what it still needs (colour, icon, tenets, doctrines, holy sites, names).')}</p>
            <div className="actions">
                <button onClick={onClose}>{tr('Cancel')}</button>
                <button className="primary" disabled={!ok} onClick={create}>
                    {tr('Create')}</button>
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
            <button className="ghost" title={ops.editScript ? tr('Change (Enter) — as script: Shift+Enter') : tr('Edit (Enter)')} onClick={click((e) => ops.edit(pos(e)))}>
                ✎
            </button>
            <button className="ghost" title={tr('Remove (Del) — undo with Ctrl+Z')} onClick={click(() => ops.remove())}>
                ✕
            </button>
            <button className="ghost" title={tr('Add after this line (A)')} onClick={click((e) => ops.add(pos(e)))}>
                ＋
            </button>
            {ops.addInside && (
                <button className="ghost" title={tr('Add inside, at the end{about} (Shift+A)', { about: src.subject ? tr(' — about {subject}', { subject: src.subject }) : '' })} onClick={click((e) => ops.addInside!(pos(e)))}>
                    ⤷＋
                </button>
            )}
            {ops.addCondition && (
                <button className="ghost" title={tr('Add a condition to its limit (C)')} onClick={click((e) => ops.addCondition!(pos(e)))}>
                    {tr('＋if')}</button>
            )}
            {ops.addElse && (
                <button className="ghost" title={tr('Add an else: what happens when the conditions don\'t hold (Shift+E)')} onClick={click(() => ops.addElse!())}>
                    {tr('＋else')}</button>
            )}
        </span>
    );
}

/**
 * ✎ ✕ ＋ ⤷＋ on a line of a scripted effect / trigger the entry calls that is not the active mod's (LineSource.owner):
 * the lines are that definition's own text; it is overridden into the mod first (asks, with the plan: where the copy
 * goes, why it can't), then the chosen operation runs on this line there (the controller finds it again once the index
 * has the copy). Undo is two steps: the operation, then the override.
 */
function OwnerOffer({ src, modName, onOverridden }: { src: LineSource; modName: string; onOverridden: (op: PendingOp) => void; }): React.JSX.Element
{
    const owner = src.owner!;
    const [plan, setPlan] = useState<OverridePlan | 'loading' | null>(null);
    const [op, setOp] = useState<PendingOp>('edit');
    const [busy, setBusy] = useState(false);
    const what = owner.type === 'scripted_triggers' ? tr('scripted trigger') : tr('scripted effect');
    const whose = src.mod ? tr('another mod’s') : tr('the game’s');
    const open = (e: React.MouseEvent, o: PendingOp): void =>
    {
        e.stopPropagation();
        setOp(o);
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
                reportChange({ kind: 'ok', text: op === 'edit' ? tr('Copied {name} to {name2} — edit the line there', { name: owner.name, name2: r.mod.name }) : tr('Copied {name} to {name2}', { name: owner.name, name2: r.mod.name }), mod: r.mod.name, where: `${r.rel}${r.line ? ':' + r.line : ''}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
                onOverridden(op);
            }
            else
                reportChange({ kind: 'info', text: tr('{name} is in {name2} already', { name: owner.name, name2: r.mod.name }), mod: r.mod.name, where: `${r.rel}${r.line ? ':' + r.line : ''}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined });

            setPlan(null);
        }
        catch (err)
        {
            reportEditError(tr('Not overridden'))(err);
            setBusy(false);
        }
    };
    const p = plan && plan !== 'loading' ? plan : undefined;
    const copy = p?.copy;
    const part = { whose, what, name: owner.name, rel: src.rel, modName };
    // (what follows the override, as the dialog says it, and its button)
    const then = op === 'remove' ?
        tr('and replaces {whose} for every call. Then this line is removed there (Ctrl+Z puts it back, a second Ctrl+Z takes the copy away).', { whose }) :
        op === 'add' ?
        tr('and replaces {whose} for every call. Then the picker opens to add a line after this one there.', { whose }) :
        op === 'addInside' ?
        tr('and replaces {whose} for every call. Then the picker opens to add a line at the end of this block there.', { whose }) :
        tr('and replaces {whose} for every call. Then this line opens for editing.', { whose });
    const go = op === 'remove' ?
        tr('Override in {modName} and remove', { modName }) :
        op === 'add' || op === 'addInside' ?
        tr('Override in {modName} and add', { modName }) :
        tr('Override in {modName} and edit', { modName });
    return (
        <span className="row-actions owner-offer" onClick={(e) => e.stopPropagation()}>
            <button className="ghost" title={tr('Part of {whose} {what} {name} ({rel}) — override it in {modName} to edit this line', part)} onClick={(e) => open(e, 'edit')}>
                ✎
            </button>
            <button className="ghost" title={tr('Part of {whose} {what} {name} ({rel}) — override it in {modName} to remove this line', part)} onClick={(e) => open(e, 'remove')}>
                ✕
            </button>
            <button className="ghost" title={tr('Part of {whose} {what} {name} ({rel}) — override it in {modName} to add a line after this one', part)} onClick={(e) => open(e, 'add')}>
                ＋
            </button>
            {src.inner && (
                <button className="ghost" title={tr('Part of {whose} {what} {name} ({rel}) — override it in {modName} to add a line inside this block', part)} onClick={(e) => open(e, 'addInside')}>
                    ⤷＋
                </button>
            )}
            {plan && (
                <Modal title={op === 'remove' ? tr('Remove a line of {name}?', { name: owner.name }) : op === 'edit' ? tr('Edit {name}?', { name: owner.name }) : tr('Add to {name}?', { name: owner.name })} onClose={() => setPlan(null)}>
                    <div className="mods-confirm">
                        <p>
                            {tr('This line is part of {whose} {what}', { whose, what })} <code>{owner.name}</code> (<code>{src.rel}:{src.line}</code>{tr('), read where it is called: its lines are its own text, so a change applies wherever it is used.')}</p>
                        {plan === 'loading' && <p>{tr('Checking…')}</p>}
                        {copy?.disabled && <p className="warn">{copy.disabled}</p>}
                        {copy?.open && (
                            <p>
                                {tr('{modName} has it already (', { modName })}<code>{copy.open.rel}:{copy.open.line}</code>{tr(') — wait until the index has taken it in, then edit the line here.')}</p>
                        )}
                        {copy?.target && (
                            <p>
                                {tr('Override it in {modName}: a copy goes to', { modName })}{' '}<code>{copy.target}</code> {' '}{then}</p>
                        )}
                        {copy?.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
                    </div>
                    <div className="actions">
                        <button onClick={() => setPlan(null)}>{copy?.target ? tr('Cancel') : tr('Close')}</button>
                        {copy?.target && (
                            <button className="primary" autoFocus disabled={busy} onClick={() => void override()}>
                                {busy ? tr('Copying…') : go}
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

const COMPARE = ['=', '!=', '<', '<=', '>', '>='];

/** The active mod's entries first (their ModTouch), then the rest as listed (most used first). */
function mineFirst(list: RefEntry[]): RefEntry[]
{
    const active = pickerData.activeMod()?.toLowerCase();
    const mine = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    return [...list.filter(mine), ...list.filter((e) => !mine(e))];
}

/**
 * The entry the readable view shows (EditBar sets it): its saved values and lists (EntityCard.values / lists) are
 * offered by the value editor, read when an editor opens.
 */
let shownEntry: EntityKey | null = null;

/**
 * The value editor's data (valueKinds.ts ValueSources): the picker's index lists, the view's scopes (offered where they
 * are in reach at `place`, the edited statement), the shown entry's saved values.
 */
function valueSources(place?: PickPlace): ValueSources
{
    const key = shownEntry;
    let card: Promise<EntityCard | null> | undefined;
    const shown = (): Promise<EntityCard | null> => (card ??= key ? api.card(key.type, key.name).catch(() => null) : Promise.resolve(null));
    return {
        scriptValues: async () =>
        {
            await pickerData.loaded('script_values');
            const active = pickerData.activeMod()?.toLowerCase();
            return mineFirst(pickerData.list('script_values') ?? []).map((e) => ({ name: e.name, display: e.display, mine: !!e.mod?.mods.some((m) => m.toLowerCase() === active) }));
        },
        targets: viewTargets,
        // (known only inside the shown entry's own definition: picker/targets.ts viewTargetsKnown)
        targetsKnown: () => viewTargetsKnown(place),
        place,
        values: async () => (await shown())?.values ?? [],
        lists: async () => (await shown())?.lists ?? [],
        // (every list name the key scan saw the game's script use, after the ones in reach: the owner's E6 decision; not
        // waited for: while the scan is not there the ones in reach show alone, ValueInput asks again once it is)
        gameLists: async () => gameListNames(pickerData.keys('effect'), pickerData.keys('trigger')),
        keyValues: async (k, trigger) =>
        {
            await pickerData.keysLoaded();
            return pickerData.keys(trigger ? 'trigger' : 'effect')?.find((x) => x.key === k)?.values ?? [];
        },
        search: async (type, q) => (type === 'flag' || type === 'variable' ? await pickerData.search(type, q) : (await api.search(q, { types: [type], limit: 12 })).map((r) => ({ name: r.name, display: r.display })))
    };
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
    // what the statement's value takes (valueKinds.ts kindsOf): what was written first, then the catalog's statement and
    // the key scan's shapes (once loaded); the field offers all of them while typing
    const [value, setValue] = useState<ValueKind[]>([{ kind: 'text' }]);
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
                const trigger = target.kind === 'trigger';

                if (s)
                {
                    setValue(kindsOf(s, trigger, line));
                    // (the key scan's shapes, once it is there: `add_gold` written with a number, also used with a scope)
                    void pickerData.keysLoaded().then(() =>
                    {
                        const info = pickerData.keys(trigger ? 'trigger' : 'effect')?.find((k) => k.key === s.key);

                        if (alive && info)
                            setValue(kindsOf(s, trigger, line, info));
                    });
                }
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

        // (a block opened as script (mode 'edit', its text loaded, no single value: only the text area shows) takes the
        // focus too, so its Escape and Ctrl+Enter work right away)
        if (script || (mode === 'edit' && text !== null && !parseScalar(text)))
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
            await runScriptEdit({ ...target.req, text }, mode === 'edit' ? (text.trim() ? tr('Edited') : tr('Removed')) : tr('Added'));
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
                <b>{mode === 'edit' ? tr('Edit') : target.title}</b>
                <small title={at.file}>
                    {at.rel}:{at.line}
                </small>
                {scalar && mode === 'edit' && (
                    <span className="ie-modes">
                        <button className={'ghost small' + (!script ? ' on' : '')} onClick={() => setScript(false)}>
                            {tr('Value')}</button>
                        <button className={'ghost small' + (script ? ' on' : '')} onClick={() => setScript(true)}>
                            {tr('Script')}</button>
                    </span>
                )}
            </div>
            {problem && <div className="ie-problem">{problem}</div>}
            {text === null ?
                (
                    !problem && <div className="ie-wait">{tr('Reading the script…')}</div>
                ) :
                scalar && !script ?
                <ScalarForm scalar={scalar} trigger={target.kind === 'trigger'} value={value} place={placeOf({ op: 'replace', at })} onChange={(s) => setText(scalarText(s))} onSave={() => void save()} /> :
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
                    <div className="ie-label">{tr('Reads as')}</div>
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
                    {busy ? tr('Saving…') : mode === 'edit' && text !== null && !text.trim() ? tr('Remove') : tr('Save')}
                </button>
                <button onClick={onClose}>{tr('Cancel')}</button>
                <small>{tr('Ctrl+Enter save · Esc cancel')}{mode === 'edit' ? ' · empty = remove' : ''}</small>
            </div>
        </div>
    );
}

/**
 * A simple statement (`add_gold = 100`, `age >= 16`, `has_trait = brave`, `is_child_of = scope:x`,
 * `has_character_flag = x`): the operator and value as fields; the value's field offers what the statement takes
 * (valueKinds.ts kindsOf: what was written, the catalog's statement, the key scan's shapes; named after the field).
 */
function ScalarForm(props: { scalar: Scalar; trigger: boolean; value: ValueKind[]; place?: PickPlace; onChange: (s: Scalar) => void; onSave: () => void; }): React.JSX.Element
{
    const { scalar, onChange, value } = props;
    const ops = props.trigger ? (COMPARE.includes(scalar.op) ? COMPARE : [scalar.op, ...COMPARE]) : [scalar.op];
    const set = (patch: Partial<Scalar>): void => onChange({ ...scalar, ...patch });
    const what = kindsLabel(value);
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
            <ValueInput value={scalar.value} kind={value} statement={scalar.key} trigger={props.trigger} place={props.place} onChange={(v) => set({ value: v })} onSave={props.onSave} />
            {what && <small className="ie-type">{what}</small>}
        </div>
    );
}

/**
 * A value field with what the statement takes offered as you type (valueKinds.ts suggestValues, every kind it takes):
 * entries of a type keep a `prefix:` (`trait:brave`), flags `flag:`, variables `var:`; a field whose value was a scope,
 * flag, list or set lists them right away. ↑ ↓ choose, Enter takes one (without a list: saves), Esc closes the list.
 */
function ValueInput(props: { value: string; kind: ValueKind[]; statement: string; trigger: boolean; place?: PickPlace; onChange: (v: string) => void; onSave: () => void; }): React.JSX.Element
{
    const { value, kind } = props;
    // (what is typed, as written: each kind takes its own prefix off)
    const [q, setQ] = useState<string | null>(listsRightAway(kind) ? '' : null);
    const [hits, setHits] = useState<Suggestion[]>([]);
    const [hi, setHi] = useState(0);
    const [focused, setFocused] = useState(true);
    // (the data of this editor: the shown entry's saved values are read once)
    const sources = useMemo(() => valueSources(props.place), []);
    // (the key scan's rows (the game's list names) come once it is loaded: the suggestions are asked again then)
    const [keysIn, setKeysIn] = useState(() => !!pickerData.keys('effect'));
    useEffect(() =>
    {
        if (keysIn)
            return;

        let alive = true;
        void pickerData.keysLoaded().then(() =>
        {
            if (alive && pickerData.keys('effect'))
                setKeysIn(true);
        });
        return () =>
        {
            alive = false;
        };
    }, []);
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
            void suggestValues(kind, props.statement, props.trigger, q, sources).then((r) =>
            {
                if (!alive)
                    return;

                setHits(r.filter((s) => s.value !== value || r.length > 1));
                setHi(0);
            });
        }, 150);
        return () =>
        {
            alive = false;
            window.clearTimeout(id);
        };
    }, [q, kind, focused, keysIn]);
    const pick = (s: Suggestion): void =>
    {
        props.onChange(s.value);
        setQ(null);
        setHits([]);
    };
    // (a typed saved scope out of reach here: warned about as the picker does (picker/targets.ts typedScopeWarning),
    // saving stays allowed)
    const warn = useMemo(() =>
    {
        const all = viewTargets();
        return typedScopeWarning(value, inReach(all, props.place), awayAt(all, props.place), viewTargetsKnown(props.place));
    }, [value]);
    return (
        <span className="ie-entity">
            <input
                autoFocus
                value={value}
                spellCheck={false}
                inputMode={kind.length === 1 && kind[0].kind === 'number' ? 'decimal' : undefined}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) =>
                {
                    props.onChange(e.target.value);
                    setQ(e.target.value);
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
            {warn && <span className="ie-warn">⚠ {warn}</span>}
        </span>
    );
}

// ---------------------------------------------------------------------------
// The hint bar of the readable view
// ---------------------------------------------------------------------------

/**
 * What editing this entry takes: set an active mod, load it, override the entry in it, or, when the entry is written
 * in the active mod, how to edit it here.
 */
export function EditBar(props: { src?: LineSource; type: string; name: string; navigate: Navigate; }): React.JSX.Element | null
{
    const { src, navigate } = props;
    const active = useActiveMod();
    // (the entry shown: the value editor reads its saved values; every readable view has its bar)
    useEffect(() =>
    {
        const key = { type: props.type, name: props.name };
        shownEntry = key;
        return () =>
        {
            if (shownEntry === key)
                shownEntry = null;
        };
    }, [props.type, props.name]);
    // (a localization key: its text is changed in place also when it is the game's, as an override in the replace folder)
    const loc = !!src && /\.yml$/i.test(src.rel);

    if (!src || !(/\.txt$/i.test(src.rel) || loc))
        return null;

    // (a loaded save's entry: edited in the save, no mod)
    if (src.mod?.startsWith('save:'))
        return (
            <div className="edit-bar">
                <span>{tr('✎ on a row changes it in the loaded save — “Write save as…” on the Save tab writes the changes')}</span>
            </div>
        );

    const mods = (
        <button className="ghost small" onClick={() => navigate({ type: MODS_ROUTE })}>
            {tr('Mods page')}</button>
    );

    if (!active.mod)
        return (
            <div className="edit-bar none">
                <span>{tr('✎ To edit this in your own mod, set an active mod (Mods page: “New mod…”, or a mod’s ⋯ → Set as active mod).')}</span>
                {mods}
            </div>
        );

    if (!active.loaded)
        return (
            <div className="edit-bar none">
                <span>{tr('✎ The active mod {name} is not in the mod list loaded in the explorer — load a list with it to edit here.', { name: active.mod.name })}</span>
                {mods}
            </div>
        );

    if (loc)
        return (
            <div className="edit-bar mine" title={tr('Hover the text for ✎ — Enter saves, Ctrl+Z undoes')}>
                <span>
                    ✎ {src.mod?.toLowerCase() === active.mod.id.toLowerCase()
                        ? (
                            <>
                                {tr('Editing')}{' '}<b>{active.mod.name}</b> · {src.rel}
                            </>
                        )
                        : (
                            <>
                                {tr('Written in')}{' '}{src.mod ? tr('another mod') : tr('the game')} {' '}{tr('({rel}) — ✎ on the text writes it into', { rel: src.rel })}{' '}<b>{active.mod.name}</b>{tr('’s replace folder, which wins')}</>
                        )}
                </span>
                <small>{tr('✎ on the text · Ctrl+Z undo')}</small>
            </div>
        );

    if (src.mod?.toLowerCase() !== active.mod.id.toLowerCase())
        return (
            <div className="edit-bar other">
                <span>{tr('✎ Written in')}{' '}{src.mod ? tr('another mod') : tr('the game')} {' '}{tr('({rel}) — override it in {name} to edit it here:', { rel: src.rel, name: active.mod.name })}</span>
                <OverrideButton type={props.type} name={props.name} navigate={navigate} compact />
            </div>
        );

    return (
        <div className="edit-bar mine" title={tr('Hover a line for ✎ edit, ✕ remove, ＋ add — or select lines with ↑ ↓ and press Enter / Del / A (Shift+A: inside) · Ctrl+Z undoes')}>
            <span>
                {tr('✎ Editing')}{' '}<b>{active.mod.name}</b> · {src.rel}
            </span>
            <small>{tr('↑↓ select · Enter edit · Del remove · A add · Ctrl+Z undo')}</small>
        </div>
    );
}

// ---------------------------------------------------------------------------
// The Source tab's editor (the fallback for everything else)
// ---------------------------------------------------------------------------

/**
 * A definition of the active mod as plain script, saved through the same checks, or a localization key's line
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
            setProblem(tr('Empty — to remove the definition use “Remove from …” in the Override menu.'));
            return;
        }

        setBusy(true);
        setProblem(null);

        try
        {
            await runScriptEdit({ op: 'replace', at: src, text }, loc ? tr('Saved the text') : tr('Saved the definition'));
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
                    !problem && <div className="ie-wait">{tr('Reading the script…')}</div>
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
                    {busy ? tr('Saving…') : tr('Save')}
                </button>
                <button onClick={onClose}>{tr('Cancel')}</button>
                <small>{loc ? tr('Ctrl+S save · Esc cancel · one line: key:0 "text" (the same key); undo in the change bar') : tr('Ctrl+S save · Esc cancel · checked before writing (parses, braces balance); undo in the change bar')}</small>
            </div>
        </div>
    );
}
