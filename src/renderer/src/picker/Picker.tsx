/**
 * The statement picker's UI (docs/picker.md): cascading menus like OS context menus (each step opens beside its
 * parent, flipping left at the window edge), driven entirely by the keyboard (mnemonic letters, ↑↓ ⏎ →, ← /
 * Backspace back, Esc close, typing filters, `/` searches everything, digits go into number steps) or the mouse.
 * The bottom panel shows the path so far, the script and its readable sentence (api.describeScript). The states
 * and menus come from model.ts; this file keeps the history of steps, positions and the key handling.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Line, PickRequest, PickResult, TooltipInfo } from '../../../shared/api';
import { scopeOf } from '../../../shared/scriptCatalog';
import { api } from '../api';
import { LineList, ReadCtx } from '../components/rich';
import { GameImg } from '../img';
import { docEntry, pickerData } from './data';
import type { DbEntry, DbKind } from '../../../shared/scriptFacts';
import { canFinish, createdNames, initialState, menuOf, plusRow, usedCreates, previewText, resultText, searchState, sentenceOf, startStates, type ChoiceMenu, type Item, type Menu, type State } from './model';
import { firstSelectable, rowsOf, type Row } from './rows';
import '../styles/picker.css';

/** where the panel was dragged to (from its place at the bottom middle), kept while the app runs */
let panelOffset = { x: 0, y: 0 };

import { tr } from '../../../shared/i18n';
interface Entry
{
    id: number;
    state: State;
    crumb?: string;
    sel: number;
    filter: string;
    /** where the menu opens: x right beside its parent (before the cascade slides left to fit), y by the parent's row */
    pos: { x: number; y: number; };
    /** every row shown, not the first MAX_ROWS (Space on a cut list: browsing) */
    all?: boolean;
}

/** keys that only hold a modifier: no text, no command of the picker */
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'];

const MENU_W = 268;
const WIDE_W = 360;
/** menus shown at once (older steps stay in the breadcrumb) */
const MAX_VISIBLE = 4;

let entrySeq = 0;

function rootPos(req: PickRequest): { x: number; y: number; }
{
    const x = req.at ? req.at.x : Math.max(16, window.innerWidth / 2 - 420);
    const y = req.at ? req.at.y : Math.max(16, window.innerHeight * 0.14);
    return { x: Math.min(Math.max(8, x), window.innerWidth - MENU_W - 8), y: Math.min(Math.max(8, y), window.innerHeight - 260) };
}

/** Script with the ‹placeholders› of what is still to be asked marked. */
function ScriptText({ text }: { text: string; }): React.JSX.Element
{
    const parts = text.split(/(‹[^›]*›)/);
    return (
        <>
            {parts.map((p, i) =>
                p.startsWith('‹') ?
                    (
                        <span key={i} className="pk-ph">
                            {p.slice(1, -1).replace(/_/g, ' ')}
                        </span>
                    ) :
                    <span key={i}>{p}</span>
            )}
        </>
    );
}

/** What kind of game key a doc card explains (its small second line). */
function docKindLabel(kind: DbKind): string
{
    switch (kind)
    {
        case 'effect':
            return tr('Effect');
        case 'trigger':
            return tr('Condition');
        case 'list':
            return tr('List');
        case 'link':
            return tr('Link');
        case 'saved_scope':
            return tr('Saved scope');
        case 'scope_type':
            return tr('Scope type');
        case 'modifier':
            return tr('Modifier');
        case 'on_action':
            return tr('Game moment');
        case 'custom_loc':
            return tr('Text code');
        case 'data_type':
            return tr('Data type');
        case 'data_function':
            return tr('Text function');
    }
}

/** An explanation's text with its `quoted keys` shown as code. */
function Ticks({ text }: { text: string; }): React.JSX.Element
{
    return (
        <>
            {text.split(/(`[^`]+`)/).map((p, i) => (p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}
        </>
    );
}

/**
 * A game key explained (the script database, docs/script-database.md): its label and summary, the details, its fields
 * (what each means, its values, required or its default), a note when the explanation rests on little, and the game's own
 * text folded away. An entry not explained yet shows the game's text open: it is all there is.
 */
function DocCard(props: { entry: DbEntry; stale: boolean; open: boolean; onToggle: () => void; example?: string; }): React.JSX.Element
{
    const { entry, stale, open, onToggle, example } = props;
    const x = entry.explanation;
    const raw = entry.doc.trim();
    return (
        <div className={'pk-card pk-doc' + (stale ? ' stale' : '')}>
            <div className="pk-card-head">
                <span>
                    <b>{x?.label || entry.key}</b>
                    <small>
                        {docKindLabel(entry.kind)} · <code>{entry.key}</code>
                    </small>
                </span>
            </div>
            {example && <div className="pk-doc-example">{example}</div>}
            {x?.summary && (
                <div className="pk-doc-summary">
                    <Ticks text={x.summary} />
                </div>
            )}
            {x?.details && (
                <div className="pk-doc-details">
                    <Ticks text={x.details} />
                </div>
            )}
            {!!x?.fields.length && (
                <dl className="pk-doc-fields">
                    {x.fields.map((f, i) => (
                        <div key={i} className="pk-doc-field">
                            <dt>
                                <code>{f.name}</code>
                                {f.required ? <span className="pk-doc-tag">{tr('required')}</span> : f.default ? <span className="pk-doc-tag">{tr('default: {fallback}', { fallback: f.default })}</span> : null}
                            </dt>
                            <dd>
                                <Ticks text={f.text} />
                                {f.values && (
                                    <span className="pk-doc-values">
                                        {tr('Values:')} <Ticks text={f.values} />
                                    </span>
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {x?.uncertain && <div className="pk-doc-uncertain">{tr('The game documents little about this; the explanation is worked out from the name and how the game’s own script uses it.')}</div>}
            {raw && x && (
                <button
                    className="pk-doc-toggle"
                    // (the keyboard stays with the picker: the press takes no focus)
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={onToggle}
                >
                    {open ? '▾' : '▸'} {tr('Game’s own text')}
                </button>
            )}
            {raw && (open || !x) && <pre className="pk-doc-raw">{raw}</pre>}
        </div>
    );
}

declare global
{
    interface Window
    {
        /** open → first paint, and the slowest key → next paint (ms): read by drivers */
        __pickerTimings?: { open: number[]; steps: number[]; };
    }
}

function timing(kind: 'open' | 'steps', ms: number): void
{
    const t = (window.__pickerTimings ??= { open: [], steps: [] });
    t[kind].push(Math.round(ms * 10) / 10);

    if (t[kind].length > 200)
        t[kind].shift();
}

/**
 * x of the visible menus: each beside its parent; when the cascade runs past the right edge it slides left (older
 * menus partly off to the left), and when the window is too narrow even so the newest flips to its parent's left.
 */
function layoutX(xs: number[], widths: number[]): number[]
{
    const w = window.innerWidth;
    const right = Math.max(...xs.map((x, i) => x + widths[i]));
    const left = Math.min(...xs);
    const shift = Math.min(Math.max(0, right - (w - 8)), Math.max(0, left - 8));
    const out = xs.map((x) => x - shift);
    const last = out.length - 1;

    if (last > 0 && out[last] + widths[last] > w - 8)
        out[last] = Math.max(8, out[last - 1] - widths[last] + 3);

    return out;
}

export function Picker(props: { req: PickRequest; t0: number; onDone: (r: PickResult | null) => void; warm?: boolean; }): React.JSX.Element
{
    const { req, onDone, warm } = props;
    const kind = req.kind;
    const [hist, setHist] = useState<Entry[]>(() =>
    {
        // (changing a written modifier or field: its value step opens beside the root menu)
        const root = rootPos(req);

        // (plain menus: pickChoice)
        if (kind === 'choice')
            return [{ id: ++entrySeq, state: { ...initialState('choice', scopeOf('character'), req.title), view: { v: 'choice' as const }, choice: req.choice as ChoiceMenu }, sel: 0, filter: '', pos: root }];

        return startStates(kind, scopeOf(req.scope), req.title, req.type, req.edit, req.subject, req.scopes, req.goal, req.event, {
            field: req.field,
            only: req.only,
            once: req.once,
            root: req.root ? scopeOf(req.root) : undefined,
            common: req.common,
            about: req.about,
            modScope: req.kind === 'modifier' && req.scope ? scopeOf(req.scope) : undefined,
            newEntries: req.newEntries,
            elseAfter: req.elseAfter
        }).map((s, i) => ({
            id: ++entrySeq,
            state: req.targets?.length || req.targetsKnown ? { ...s.state, targets: req.targets ?? [], targetsKnown: req.targetsKnown } : s.state,
            crumb: s.crumb,
            sel: 0,
            filter: '',
            pos: i ? { x: root.x + MENU_W - 3, y: root.y } : root
        }));
    });
    const [tick, setTick] = useState(0);
    const [preview, setPreview] = useState<{ text: string; lines: Line[]; }>({ text: '', lines: [] });
    const menuEls = useRef(new Map<number, HTMLDivElement>());
    const panelRef = useRef<HTMLDivElement>(null);
    /** text of the panel (the script, the reading, the crumbs) is selected: the owner copies it with Ctrl+C */
    const selectedInPanel = (): boolean =>
    {
        const s = window.getSelection();
        const panel = panelRef.current;
        return !!s && !!panel && !s.isCollapsed && [s.anchorNode, s.focusNode].some((n) => !!n && panel.contains(n)) && !!s.toString();
    };
    // where each menu was placed when it opened: kept (the preview growing or shrinking moves nothing)
    const placed = useRef(new Map<number, { top: number; limit: number; }>());
    // the panel dragged by its header (kept for the next picker of the session; a double click puts it back)
    const [panelAt, setPanelAt] = useState(panelOffset);
    // (a drag still going when the picker closes: its window listeners removed)
    const dragEnd = useRef<(() => void) | null>(null);
    useEffect(() => () => dragEnd.current?.(), []);
    const found = useRef(new Map<number, { q: string; items: Item[]; }>());
    const waited = useRef(new WeakSet<Promise<unknown>>());
    const keyAt = useRef(0);
    // text the keys don't give (an IME's composition, the emoji panel, a dead key): a focused input of no size takes it
    // (the picker has no text field otherwise); `preedit` is the composition so far, shown after the filter
    const ime = useRef<HTMLInputElement>(null);
    const composing = useRef(false);
    // (a press inside the panel, e.g. a text selection being dragged: the input takes the focus back at the release, not at once)
    const panelDown = useRef(false);
    const [preedit, setPreedit] = useState('');
    // where the mouse last was: a menu opening (or changing) under a resting cursor must not take the selection
    const pointer = useRef<{ x: number; y: number; } | null>(null);
    const closed = useRef(false);

    const menuCache = useRef(new WeakMap<State, { tick: number; menu: Menu; }>());
    const menuFor = (s: State): Menu =>
    {
        const c = menuCache.current.get(s);

        if (c && c.tick === tick)
            return c.menu;

        const menu = menuOf(s, pickerData);
        menuCache.current.set(s, { tick, menu });
        return menu;
    };

    const top = hist[hist.length - 1];
    const topMenu = menuFor(top.state);
    const rowsFor = (e: Entry): Row[] =>
    {
        const f = found.current.get(e.id);
        return rowsOf(menuFor(e.state), e.filter, f && f.q === e.filter.trim() ? f.items : undefined, e.all);
    };
    const topRows = rowsFor(top);

    // menus waiting for data (a list being loaded, the key scan): built again when it arrives
    for (const e of hist)
    {
        const w = menuFor(e.state).wait;

        if (w && !waited.current.has(w))
        {
            waited.current.add(w);
            const id = e.id;
            void w.then(() =>
            {
                setTick((t) => t + 1);
                // (while it waited nothing could be selected ("Looking up…"): the first row of the menu built again is,
                // so Enter takes it, as after a search; a row the person moved to stays)
                setHist((h) =>
                {
                    const i = h.findIndex((x) => x.id === id);
                    const x = h[i];

                    if (!x)
                        return h;

                    const rows = rowsOf(menuOf(x.state, pickerData), x.filter, found.current.get(x.id)?.items, x.all);
                    const now = rows[x.sel];

                    if (now && now.item.role !== 'info' && now.item.go)
                        return h;

                    const sel = firstSelectable(rows, !!x.filter.trim());
                    return sel < 0 || sel === x.sel ? h : [...h.slice(0, i), { ...x, sel }, ...h.slice(i + 1)];
                });
            });
        }
    }

    // big types: the index searches as one types
    useEffect(() =>
    {
        const q = top.filter.trim();

        if (!topMenu.search || !q)
            return;

        const t = setTimeout(() =>
        {
            void topMenu.search!(q).then((items) =>
            {
                found.current.set(top.id, { q, items });
                setTick((x) => x + 1);
                // (nothing highlighted while it searched: the first result is, so Enter takes it)
                setHist((h) =>
                {
                    const e = h[h.length - 1];

                    if (e.id !== top.id || e.filter.trim() !== q || e.sel >= 0)
                        return h;

                    return [...h.slice(0, -1), { ...e, sel: firstSelectable(rowsOf(menuFor(e.state), e.filter, items, e.all), true) }];
                });
            });
        }, 90);
        return () => clearTimeout(t);
    }, [top.id, top.filter, topMenu]);

    // the preview: script and readable sentence (in a parameter step, as the highlighted choice would make it)
    let previewState = top.state;
    const selRow = topRows[top.sel];

    if (topMenu.preview && selRow?.item.go && !selRow.item.role)
    {
        const n = selRow.item.go();

        // (a row that finishes with a state of its own, a text code, shows that)
        if (!('finish' in n))
            previewState = n.state;
        else if (n.state)
            previewState = n.state;
    }

    const describeText = previewText(previewState, true);
    // (the entries made on the way, read by the name given: key → name, as a string the effect can compare)
    const namesJson = JSON.stringify(createdNames(previewState) ?? null);
    // the highlighted entry's card (a doctrine: its description and what it does), asked once the selection rests
    const entry = selRow?.item.entry;
    const entryKey = entry ? entry.type + '\u0000' + entry.name : '';
    const [entryCard, setEntryCard] = useState<{ key: string; info: TooltipInfo | null; } | null>(null);
    useEffect(() =>
    {
        if (!entry || warm)
            return;

        let live = true;
        const t = setTimeout(() =>
        {
            void api
                .tooltip(entry.type, entry.name)
                .then((info) => live && setEntryCard({ key: entryKey, info }))
                .catch(() => undefined);
        }, 60);
        return () =>
        {
            live = false;
            clearTimeout(t);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entryKey, warm]);
    // (while the next one loads the last card stays, dimmed: the panel keeps its height and the menus, placed above it,
    // don't jump)
    const card = entry ? (entryCard?.info ?? null) : null;
    const cardStale = !!card && entryCard?.key !== entryKey;
    // the highlighted row's game key explained (the script database: what it is, its fields, the game's own text), asked
    // like the entry card once the selection rests; a row of an entry shows the entry's card instead
    const doc = entry ? undefined : selRow?.item.doc;
    const docKey = doc ? `${doc.kind}\u0000${doc.key}\u0000${doc.variant ?? ''}` : '';
    const [docCard, setDocCard] = useState<{ key: string; entry: DbEntry | null; } | null>(null);
    const [docOpen, setDocOpen] = useState(false);
    useEffect(() =>
    {
        if (!doc || warm)
            return;

        let live = true;
        const t = setTimeout(() =>
        {
            void docEntry(doc.kind, doc.key, doc.variant).then((e) => live && setDocCard({ key: docKey, entry: e }));
        }, 60);
        return () =>
        {
            live = false;
            clearTimeout(t);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docKey, warm]);
    // (an entry with neither an explanation nor a text of the game's says nothing: the row's own help shows instead; the
    // last card stays dimmed while the next loads, as the entry card does)
    const docShown = doc && docCard?.entry && (docCard.entry.explanation || docCard.entry.doc.trim()) ? docCard.entry : null;
    const docStale = !!docShown && docCard?.key !== docKey;
    useEffect(() =>
    {
        if (!describeText || warm || kind === 'loc' || kind === 'choice')
        {
            setPreview({ text: '', lines: [] });
            return;
        }

        let live = true;
        // (moving through a long list asks once it rests)
        const t = setTimeout(() =>
        {
            void api
                .describeScript(describeText, kind, req.type, (JSON.parse(namesJson) as Record<string, string> | null) ?? undefined)
                .then((lines) => live && setPreview({ text: describeText, lines }))
                .catch(() => undefined);
        }, 30);
        return () =>
        {
            live = false;
            clearTimeout(t);
        };
    }, [describeText, namesJson, kind, req.type, warm]);

    // timings: first paint after opening, paint after each key
    useEffect(() =>
    {
        if (warm)
            onDone(null);
        else
            requestAnimationFrame(() => timing('open', performance.now() - props.t0));
    }, [props.t0]);
    useEffect(() =>
    {
        if (!keyAt.current)
            return;

        const at = keyAt.current;
        keyAt.current = 0;
        requestAnimationFrame(() => timing('steps', performance.now() - at));
    });

    // the visible cascade: from the last "what next?" menu, at most MAX_VISIBLE
    let from = 0;
    hist.forEach((e, i) =>
    {
        if (i > 0 && menuFor(e.state).restart)
            from = i;
    });
    from = Math.max(from, hist.length - MAX_VISIBLE);
    const visible = hist.slice(from);

    // a menu is placed when it opens (above the panel as it is then, inside the window) and keeps that place; it only
    // moves up when its own list grows past the bottom (rows loaded, Space for all), never for the preview's size
    useLayoutEffect(() =>
    {
        for (const e of visible)
        {
            const el = menuEls.current.get(e.id);

            if (!el)
                continue;

            let p = placed.current.get(e.id);

            if (!p)
            {
                const panel = panelRef.current?.getBoundingClientRect();
                // (above the panel; the panel dragged to the top of the window: down to the window's bottom)
                const limit = panel && panel.top > 200 ? panel.top - 8 : window.innerHeight - 8;
                p = { top: e.pos.y, limit };
                placed.current.set(e.id, p);
            }

            el.style.maxHeight = `${Math.max(160, p.limit - 8)}px`;
            const h = el.getBoundingClientRect().height;

            if (h > 0 && p.top + h > p.limit)
                p.top = Math.max(8, p.limit - h);

            el.style.top = `${p.top}px`;
        }

        const sel = menuEls.current.get(top.id)?.querySelector('.pk-row.sel');
        sel?.scrollIntoView({ block: 'nearest' });
    });

    const close = (r: PickResult | null): void =>
    {
        if (closed.current)
            return;

        closed.current = true;
        onDone(r);
    };

    const finish = async (s: State): Promise<void> =>
    {
        if (!canFinish(s))
            return;

        const text = resultText(s);

        if (kind === 'loc' || kind === 'choice')
        {
            close({ text, caret: s.caret });
            return;
        }

        const lines = preview.text === text ? preview.lines : await api.describeScript(text, kind, req.type, createdNames(s)).catch(() => [] as Line[]);
        // (a scripted effect read inline says everything it does: the notice gets the start)
        const sentence = sentenceOf(lines);
        close({ text, summary: (sentence.length > 240 ? sentence.slice(0, 239) + '…' : sentence) || undefined, creates: usedCreates(s), ...(s.outside ? { outside: true } : {}) });
    };

    const setTop = (patch: Partial<Entry>): void => setHist((h) => [...h.slice(0, -1), { ...h[h.length - 1], ...patch }]);

    const back = (): void =>
    {
        if (hist.length > 1)
            setHist((h) => h.slice(0, -1));
    };

    /** Chooses a row of the menu of entry `ei` (a click into an older menu takes that branch instead). */
    const activate = (ei: number, ri: number): void =>
    {
        const e = hist[ei];
        const row = rowsFor(e)[ri];

        if (!row || row.item.role === 'info' || !row.item.go)
            return;

        const next = row.item.go();

        if ('finish' in next)
        {
            void finish(next.state ?? e.state);
            return;
        }

        // the chosen menu itself changes (a toggle) / a menu further up takes the result (a block's field, a new entry):
        // with its first row selected again (Done: ⏎ finishes)
        const first = firstSelectable(rowsOf(menuOf(next.state, pickerData), '', undefined));

        if (next.back !== undefined && ei - next.back >= 0)
        {
            const ti = ei - next.back;
            setHist([...hist.slice(0, ti), { ...hist[ti], state: next.state, sel: first, filter: '' }]);
            return;
        }

        const nextMenu = menuOf(next.state, pickerData);
        let pos = hist[0].pos;

        if (!nextMenu.restart)
        {
            const el = menuEls.current.get(e.id);
            const rr = (el?.querySelector(`[data-row="${ri}"]`) as HTMLElement | null)?.getBoundingClientRect() ?? el?.getBoundingClientRect();
            pos = { x: e.pos.x + (menuFor(e.state).wide ? WIDE_W : MENU_W) - 3, y: Math.max(8, (rr?.top ?? e.pos.y) - 31) };
        }

        const nh = [...hist.slice(0, ei), { ...e, sel: ri }, { id: ++entrySeq, state: next.state, crumb: next.crumb, sel: 0, filter: '', pos }];
        const added = nh[nh.length - 1];
        added.sel = firstSelectable(rowsOf(nextMenu, '', undefined));
        setHist(nh);
    };

    /** Text typed into the top menu's filter: a key, or what an IME / the emoji panel inserted. */
    const typeText = (text: string): void =>
    {
        const typed = text.replace(/[\r\n\t]+/g, ' ');

        if (!typed)
            return;

        setHist((h) =>
        {
            const e = h[h.length - 1];
            const filter = e.filter + typed;
            const f = found.current.get(e.id);
            return [...h.slice(0, -1), { ...e, filter, sel: firstSelectable(rowsOf(menuFor(e.state), filter, f && f.q === filter.trim() ? f.items : undefined), !!filter.trim()) }];
        });
    };

    // keyboard: everything goes to the picker while it is open
    const handler = useRef<(e: KeyboardEvent) => void>(() =>
    {});
    handler.current = (ev: KeyboardEvent): void =>
    {
        const k = ev.key;

        // (Ctrl/Cmd+C with text selected in the panel copies it: the browser's own copy, not a key of the picker)
        if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && k.toLowerCase() === 'c' && selectedInPanel())
            return;

        // (the input lost the focus to a press in the panel and takes it back at the first key, which ends the selection
        // that was kept for copying; a key that only holds a modifier leaves it, Ctrl+C comes next)
        if (!MODIFIER_KEYS.includes(k) && ime.current && document.activeElement !== ime.current)
            ime.current.focus();

        // (a composition runs in the input below: while the input has one open, and for the keys the event marks as one's, the keys are the IME's, not ours)
        if (composing.current || ev.isComposing || ev.keyCode === 229 || k === 'Process' || k === 'Dead')
            return;

        if (k === 'Tab')
        {
            ev.preventDefault();

            // (a list of entries: grouped by DLC, or one list again)
            if (topMenu.groupable && pickerData.setGrouped)
            {
                pickerData.setGrouped(!pickerData.grouped?.());
                setTick((t) => t + 1);
            }

            return;
        }

        if (MODIFIER_KEYS.includes(k))
            return;

        ev.preventDefault();
        ev.stopPropagation();
        keyAt.current = performance.now();
        const rows = topRows;
        const move = (d: number): void =>
        {
            if (!rows.length)
                return;

            let i = top.sel < 0 ? (d > 0 ? -1 : 0) : top.sel;

            for (let n = 0; n < rows.length; n++)
            {
                i = (i + d + rows.length) % rows.length;

                if (rows[i].item.role !== 'info')
                    break;
            }

            setTop({ sel: i });
        };

        if (k === 'Escape')
        {
            if (top.filter)
                setTop({ filter: '', sel: firstSelectable(rowsOf(topMenu, '', undefined)) });
            else
                close(null);
        }
        else if (k === 'Enter' && (ev.ctrlKey || ev.metaKey))
            void finish(top.state);
        else if (k === 'Enter' || k === 'ArrowRight')
        {
            if (k === 'ArrowRight' && !rows[top.sel]?.item.sub)
                return;

            activate(hist.length - 1, top.sel);
        }
        else if (k === 'ArrowDown')
            move(1);
        else if (k === 'ArrowUp')
            move(-1);
        else if (k === 'PageDown')
            setTop({ sel: Math.min(rows.length - 1, top.sel + 10) });
        else if (k === 'PageUp')
            setTop({ sel: Math.max(0, top.sel - 10) });
        else if (k === 'Home')
            setTop({ sel: Math.max(0, rows.findIndex((r) => r.item.role !== 'info' && !!r.item.go)) });
        else if (k === 'End')
            setTop({ sel: Math.max(0, rows.length - 1) });
        else if (k === 'ArrowLeft')
            back();
        else if (k === 'Backspace')
        {
            if (top.filter)
            {
                // (one character, not one UTF-16 unit: an emoji is two)
                const filter = [...top.filter].slice(0, -1).join('');
                setTop({ filter, sel: firstSelectable(rowsOf(topMenu, filter, undefined), !!filter.trim()) });
            }
            else
                back();
        }
        else if (k === '/' && !top.filter && top.state.view.v !== 'search' && !topMenu.typeahead)
        {
            const s = searchState({ ...top.state, pending: undefined });
            setHist([...hist, { id: ++entrySeq, state: s, crumb: tr('Search'), sel: 0, filter: '', pos: hist[0].pos }]);
        }
        // (AltGr, which Windows reports as Ctrl+Alt, types characters: ą ę ł @ { } …)
        else if ([...k].length === 1 && (ev.getModifierState('AltGraph') || (!ev.ctrlKey && !ev.altKey)) && !ev.metaKey)
        {
            if (!topMenu.typeahead && !top.filter)
            {
                const ri = rows.findIndex((r) => r.key === k.toLowerCase());

                if (ri >= 0)
                {
                    activate(hist.length - 1, ri);
                    return;
                }
            }

            // (`+` first: the "＋ New …" row, selected, not typed into the filter where labels hold `+`)
            if (k === '+')
            {
                const pi = plusRow(rows, top.filter);

                if (pi >= 0)
                {
                    setTop({ sel: pi });
                    return;
                }
            }

            // (Space on a list cut at MAX_ROWS, nothing typed: every row, to browse)
            if (k === ' ' && !top.filter && !top.all && rows.some((r) => r.item.more))
            {
                setTop({ all: true });
                return;
            }

            // (Space first in a menu whose letters pick rows: the letters that follow are typed (a saved scope, a chain))
            if (k === ' ' && !top.filter)
            {
                if (!topMenu.typeahead)
                    setTop({ filter: ' ' });

                return;
            }

            typeText(k);
        }
    };
    useEffect(() =>
    {
        if (warm)
            return;

        const onKey = (e: KeyboardEvent): void => handler.current(e);
        window.addEventListener('keydown', onKey, true);
        (document.activeElement as HTMLElement | null)?.blur?.();
        ime.current?.focus();
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    const crumbs = hist
        .slice(1)
        .map((e) => e.crumb)
        .filter((c): c is string => !!c);
    const shownText = previewText(previewState);
    const xs = layoutX(
        visible.map((e) => e.pos.x),
        visible.map((e) => (menuFor(e.state).wide ? WIDE_W : MENU_W))
    );

    return (
        <div className="pk-layer" style={warm ? { visibility: 'hidden' } : undefined} onMouseDown={() => close(null)}>
            {visible.map((e) =>
            {
                const ei = hist.indexOf(e);
                const isTop = e === top;
                const menu = menuFor(e.state);
                const rows = isTop ? topRows : rowsFor(e);
                return (
                    <div
                        key={e.id}
                        className={'pk-menu' + (isTop ? ' top' : '') + (menu.wide ? ' wide' : '')}
                        style={{ left: xs[visible.indexOf(e)], top: e.pos.y }}
                        ref={(el) =>
                        {
                            if (el)
                                menuEls.current.set(e.id, el);
                            else
                                menuEls.current.delete(e.id);
                        }}
                        onMouseDown={(ev) =>
                        {
                            // (a click keeps the keyboard where it is: the input stays focused)
                            ev.preventDefault();
                            ev.stopPropagation();
                        }}
                    >
                        <div className="pk-title">{menu.title}</div>
                        {(e.filter || (isTop && preedit)) && (
                            <div className="pk-filter">
                                <span className="pk-filter-icon">⌕</span>
                                {e.filter}
                                {isTop && preedit && <u className="pk-preedit">{preedit}</u>}
                                <span className="pk-caret" />
                            </div>
                        )}
                        <div className="pk-rows" role="listbox">
                            {rows.length === 0 && (
                                <div className="pk-empty">
                                    {menu.wait ? tr('Loading…') : menu.search ? (e.filter ? (found.current.get(e.id)?.q === e.filter.trim() ? tr('Nothing found') : tr('Searching…')) : tr('Type to search')) : e.filter ? tr('Nothing matches') : tr('Nothing here')}
                                </div>
                            )}
                            {rows.map((r, ri) => (
                                <div
                                    key={ri}
                                    data-row={ri}
                                    role={r.item.role === 'info' ? 'presentation' : 'option'}
                                    aria-selected={r.item.role === 'info' ? undefined : ri === e.sel}
                                    className={'pk-row' + (ri === e.sel ? ' sel' : '') + (r.item.role ? ' ' + r.item.role : '')}
                                    data-entity={r.item.entry ? `${r.item.entry.type}:${r.item.entry.name}` : undefined}
                                    title={r.item.title}
                                    onMouseMove={isTop && r.item.role !== 'info'
                                        ? (ev) =>
                                        {
                                            const last = pointer.current;
                                            pointer.current = { x: ev.screenX, y: ev.screenY };

                                            if (last && (last.x !== ev.screenX || last.y !== ev.screenY) && e.sel !== ri)
                                                setTop({ sel: ri });
                                        }
                                        : undefined}
                                    onClick={() => activate(ei, ri)}
                                >
                                    <span className="pk-key">{r.key ? r.key.toUpperCase() : r.item.role === 'done' ? '⏎' : ''}</span>
                                    {r.item.icon && <GameImg path={r.item.icon} size={18} className="pk-icon" />}
                                    {r.item.color && <span className="pk-swatch" style={{ background: r.item.color }} />}
                                    <span className="pk-label">{r.item.label}</span>
                                    {r.item.hint && <span className="pk-hint">{r.item.hint}</span>}
                                    {r.item.state && <span className="pk-state">{r.item.state}</span>}
                                    <span className="pk-arrow">{r.item.sub ? '▸' : ''}</span>
                                </div>
                            ))}
                        </div>
                        {isTop && menu.note && <div className="pk-note">{menu.note}</div>}
                    </div>
                );
            })}
            {!warm && (
                <input
                    ref={ime}
                    className="pk-ime"
                    aria-hidden="true"
                    tabIndex={-1}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ position: 'absolute', left: (xs[visible.indexOf(top)] ?? 0) + 24, top: top.pos.y + 30, width: 2, height: 14, opacity: 0, padding: 0, border: 0, pointerEvents: 'none' }}
                    onCompositionStart={() => (composing.current = true)}
                    onCompositionUpdate={(ev) => setPreedit(ev.data)}
                    onCompositionEnd={(ev) =>
                    {
                        composing.current = false;
                        setPreedit('');
                        ev.currentTarget.value = '';
                        typeText(ev.data);
                    }}
                    onInput={(ev) =>
                    {
                        if (composing.current || (ev.nativeEvent as InputEvent).isComposing)
                            return;

                        const text = ev.currentTarget.value;
                        ev.currentTarget.value = '';
                        typeText(text);
                    }}
                    onBlur={() =>
                    {
                        // (the keyboard stays with the picker while it is open; a composition cut off by the blur must not keep the keys from us)
                        composing.current = false;

                        if (closed.current)
                            return;

                        // (a press in the panel: at the release the input takes the keyboard back, unless text of the panel is
                        // selected: that stays selected, to copy with Ctrl+C, until the next key)
                        if (panelDown.current)
                        {
                            window.addEventListener('mouseup', () => requestAnimationFrame(() => !closed.current && !selectedInPanel() && ime.current?.focus()), { once: true });
                            return;
                        }

                        requestAnimationFrame(() => ime.current?.focus());
                    }}
                />
            )}
            <div className="pk-panel" ref={panelRef} onMouseDown={(ev) =>
                {
                    ev.stopPropagation();
                    panelDown.current = true;
                    window.addEventListener('mouseup', () => (panelDown.current = false), { once: true });
                }} style={{ transform: `translate(calc(-50% + ${panelAt.x}px), ${panelAt.y}px)` }}>
                <div
                    className="pk-crumbs"
                    title={tr('Drag to move — double-click: back to the bottom')}
                    onPointerDown={(ev) =>
                    {
                        if (ev.button !== 0)
                            return;

                        ev.currentTarget.setPointerCapture(ev.pointerId);
                        const from = { x: ev.clientX - panelAt.x, y: ev.clientY - panelAt.y };
                        const move = (m: PointerEvent): void => setPanelAt(panelOffset = { x: m.clientX - from.x, y: Math.min(0, m.clientY - from.y) });
                        const up = (): void =>
                        {
                            window.removeEventListener('pointermove', move);
                            window.removeEventListener('pointerup', up);
                            dragEnd.current = null;
                        };
                        window.addEventListener('pointermove', move);
                        window.addEventListener('pointerup', up);
                        dragEnd.current = up;
                    }}
                    onDoubleClick={() => setPanelAt(panelOffset = { x: 0, y: 0 })}
                >
                    <span className="pk-what">
                        {kind === 'choice'
                            ? (req.title ?? tr('Choose'))
                            : kind === 'loc'
                            ? tr('Insert a code{into}', { into: req.title ? ' into ' + req.title : '' })
                            : req.edit
                            ? tr('Change: {edit}', { edit: req.edit })
                            : req.title
                            ? tr('Add to: {title}', { title: req.title })
                            : kind === 'effect'
                            ? tr('New effect')
                            : kind === 'trigger'
                            ? tr('New condition')
                            : kind === 'modifier'
                            ? tr('New modifier')
                            : tr('New setting')}
                    </span>
                    {crumbs.map((c, i) => (
                        <span key={i} className={'pk-crumb' + (i === crumbs.length - 1 ? ' last' : '')}>
                            {c}
                        </span>
                    ))}
                </div>
                <div className={'pk-preview' + (kind === 'choice' ? ' choice' : '')}>
                    {kind !== 'choice' && <pre className="pk-script">{shownText ? <ScriptText text={shownText} /> : <span className="pk-empty">{tr('The script appears here as you choose.')}</span>}</pre>}
                    <div className="pk-read" aria-live="polite">
                        {selRow?.item.warn && !selRow.item.role && <div className="pk-warn">⚠ {selRow.item.warn}</div>}
                        {kind === 'loc' && selRow && !selRow.item.role && !docShown && (selRow.item.icon || selRow.item.title) ?
                            (
                                // (a text code: what it shows, the icon or what it prints for William of Normandy in 1066)
                                <span className="pk-example">
                                    {selRow.item.icon && <GameImg path={selRow.item.icon} size={28} className="pk-icon" />}
                                    {selRow.item.icon ? selRow.item.label : selRow.item.title}
                                </span>
                            ) :
                            selRow?.item.image && !selRow.item.role ?
                            (
                                // (an icon: large)
                                <span className="pk-image">
                                    <GameImg path={selRow.item.image} size={128} className="pk-image-img" />
                                    <span>
                                        <b>{selRow.item.label}</b>
                                        <small>{selRow.item.image}</small>
                                    </span>
                                </span>
                            ) :
                            card ?
                            (
                                // (an entry: its card (icon, name, description, what it does))
                                <div className={'pk-card' + (cardStale ? ' stale' : '')}>
                                    <div className="pk-card-head">
                                        {card.icon && <GameImg path={card.icon} size={40} className="pk-card-icon" />}
                                        <span>
                                            <b>{card.title}</b>
                                            <small>{card.typeLabel}</small>
                                        </span>
                                    </div>
                                    {card.description && <div className="pk-card-desc">{card.description}</div>}
                                    {card.lines.length > 0 && (
                                        <ReadCtx.Provider
                                            value={{
                                                navigate: () =>
                                                {},
                                                showHidden: true
                                            }}>
                                            <LineList lines={card.lines} compact />
                                        </ReadCtx.Provider>
                                    )}
                                </div>
                            ) :
                            docShown ?
                            (
                                // (a game key: its explanation; a text code's example stays on top)
                                <DocCard entry={docShown} stale={docStale} open={docOpen} onToggle={() => setDocOpen((o) => !o)} example={kind === 'loc' ? selRow?.item.title : undefined} />
                            ) :
                            selRow?.item.explain ?
                            <span className="pk-example">{selRow.item.explain}</span> :
                            preview.lines.length > 0 && preview.text === describeText ?
                            (
                                <ReadCtx.Provider
                                    value={{
                                        navigate: () =>
                                        {},
                                        showHidden: true
                                    }}>
                                    <LineList lines={preview.lines} compact />
                                </ReadCtx.Provider>
                            ) :
                            <span className="pk-empty">{shownText ? '…' : tr('Letters pick, ⏎ opens, ← goes back, / searches everything, Esc closes.')}</span>}
                    </div>
                </div>
                <div className="pk-keys">
                    <span>
                        <kbd>A–Z</kbd> {' '}{tr('pick')}</span>
                    <span>
                        <kbd>↑↓</kbd> <kbd>⏎</kbd>/<kbd>→</kbd> {' '}{tr('open')}</span>
                    <span>
                        <kbd>←</kbd>/<kbd>⌫</kbd> {' '}{tr('back')}</span>
                    <span>
                        {tr('type to filter ·')}{' '}<kbd>Space</kbd> {' '}{tr('then a name ·')}{' '}<kbd>/</kbd> {' '}{tr('search all · digits for numbers')}</span>
                    <span>
                        <kbd>Ctrl</kbd>+<kbd>⏎</kbd> {' '}{tr('done')}</span>
                    <span>
                        <kbd>Esc</kbd> {' '}{tr('close')}</span>
                    {canFinish(top.state) && (
                        <button className="primary pk-done" onClick={() => void finish(top.state)}>
                            {tr('Done')}</button>
                    )}
                </div>
            </div>
        </div>
    );
}
