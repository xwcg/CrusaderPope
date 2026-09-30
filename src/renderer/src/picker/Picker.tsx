/**
 * The statement picker's UI (docs/picker.md): cascading menus like OS context menus — each step opens beside its
 * parent, flipping left at the window edge — driven entirely by the keyboard (mnemonic letters, ↑↓ ⏎ →, ← /
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
import { pickerData } from './data';
import { canFinish, menuOf, usedCreates, previewText, resultText, searchState, sentenceOf, startStates, type Item, type Menu, type State } from './model';
import { firstSelectable, rowsOf, type Row } from './rows';
import '../styles/picker.css';

interface Entry
{
    id: number;
    state: State;
    crumb?: string;
    sel: number;
    filter: string;
    /** where the menu opens: x right beside its parent (before the cascade slides left to fit), y by the parent's row */
    pos: { x: number; y: number; };
}

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
            state: req.targets?.length ? { ...s.state, targets: req.targets } : s.state,
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
    const found = useRef(new Map<number, { q: string; items: Item[]; }>());
    const waited = useRef(new WeakSet<Promise<unknown>>());
    const keyAt = useRef(0);
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
        return rowsOf(menuFor(e.state), e.filter, f && f.q === e.filter.trim() ? f.items : undefined);
    };
    const topRows = rowsFor(top);

    // menus waiting for data (a list being loaded, the key scan): built again when it arrives
    for (const e of hist)
    {
        const w = menuFor(e.state).wait;

        if (w && !waited.current.has(w))
        {
            waited.current.add(w);
            void w.then(() => setTick((t) => t + 1));
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
            });
        }, 90);
        return () => clearTimeout(t);
    }, [top.id, top.filter, topMenu]);

    // the preview: script and readable sentence — in a parameter step, as the highlighted choice would make it
    let previewState = top.state;
    const selRow = topRows[top.sel];

    if (topMenu.preview && selRow?.item.go && !selRow.item.role)
    {
        const n = selRow.item.go();

        // (a row that finishes with a state of its own — a text code — shows that)
        if (!('finish' in n))
            previewState = n.state;
        else if (n.state)
            previewState = n.state;
    }

    const describeText = previewText(previewState, true);
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
    const card = entry && entryCard?.key === entryKey ? entryCard.info : null;
    useEffect(() =>
    {
        if (!describeText || warm || kind === 'loc')
        {
            setPreview({ text: '', lines: [] });
            return;
        }

        let live = true;
        // (moving through a long list asks once it rests)
        const t = setTimeout(() =>
        {
            void api
                .describeScript(describeText, kind, req.type)
                .then((lines) => live && setPreview({ text: describeText, lines }))
                .catch(() => undefined);
        }, 30);
        return () =>
        {
            live = false;
            clearTimeout(t);
        };
    }, [describeText, kind, req.type, warm]);

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

    // keep menus above the panel and inside the window
    useLayoutEffect(() =>
    {
        const limit = window.innerHeight - (panelRef.current?.offsetHeight ?? 180) - 16;

        for (const e of visible)
        {
            const el = menuEls.current.get(e.id);

            if (!el)
                continue;

            el.style.maxHeight = `${Math.max(160, limit - 8)}px`;
            const r = el.getBoundingClientRect();
            el.style.top = `${r.height > 0 && e.pos.y + r.height > limit ? Math.max(8, limit - r.height) : e.pos.y}px`;
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

        if (kind === 'loc')
        {
            close({ text, caret: s.caret });
            return;
        }

        const lines = preview.text === text ? preview.lines : await api.describeScript(text, kind, req.type).catch(() => [] as Line[]);
        // (a scripted effect read inline says everything it does: the notice gets the start)
        const sentence = sentenceOf(lines);
        close({ text, summary: (sentence.length > 240 ? sentence.slice(0, 239) + '…' : sentence) || undefined, creates: usedCreates(s) });
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

        // the chosen menu itself changes (a toggle) / a menu further up takes the result (a block's field, a new entry) —
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

    // keyboard: everything goes to the picker while it is open
    const handler = useRef<(e: KeyboardEvent) => void>(() =>
    {});
    handler.current = (ev: KeyboardEvent): void =>
    {
        const k = ev.key;

        if (k === 'Tab')
        {
            ev.preventDefault();
            return;
        }

        if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(k))
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
                const filter = top.filter.slice(0, -1);
                setTop({ filter, sel: firstSelectable(rowsOf(topMenu, filter, undefined), !!filter.trim()) });
            }
            else
                back();
        }
        else if (k === '/' && !top.filter && top.state.view.v !== 'search' && !topMenu.typeahead)
        {
            const s = searchState({ ...top.state, pending: undefined });
            setHist([...hist, { id: ++entrySeq, state: s, crumb: 'Search', sel: 0, filter: '', pos: hist[0].pos }]);
        }
        else if (k.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey)
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

            // (Space first in a menu whose letters pick rows: the letters that follow are typed — a saved scope, a chain)
            if (k === ' ' && !top.filter)
            {
                if (!topMenu.typeahead)
                    setTop({ filter: ' ' });

                return;
            }

            const filter = top.filter + k;
            const f = found.current.get(top.id);
            setTop({ filter, sel: firstSelectable(rowsOf(topMenu, filter, f && f.q === filter.trim() ? f.items : undefined), !!filter.trim()) });
        }
    };
    useEffect(() =>
    {
        if (warm)
            return;

        const onKey = (e: KeyboardEvent): void => handler.current(e);
        window.addEventListener('keydown', onKey, true);
        (document.activeElement as HTMLElement | null)?.blur?.();
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
                        onMouseDown={(ev) => ev.stopPropagation()}
                    >
                        <div className="pk-title">{menu.title}</div>
                        {e.filter && (
                            <div className="pk-filter">
                                <span className="pk-filter-icon">⌕</span>
                                {e.filter}
                                <span className="pk-caret" />
                            </div>
                        )}
                        <div className="pk-rows">
                            {rows.length === 0 && (
                                <div className="pk-empty">
                                    {menu.wait ? 'Loading…' : menu.search ? (e.filter ? (found.current.get(e.id)?.q === e.filter.trim() ? 'Nothing found' : 'Searching…') : 'Type to search') : e.filter ? 'Nothing matches' : 'Nothing here'}
                                </div>
                            )}
                            {rows.map((r, ri) => (
                                <div
                                    key={ri}
                                    data-row={ri}
                                    className={'pk-row' + (ri === e.sel ? ' sel' : '') + (r.item.role ? ' ' + r.item.role : '')}
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
                                    <span className="pk-label">{r.item.label}</span>
                                    {r.item.hint && <span className="pk-hint">{r.item.hint}</span>}
                                    <span className="pk-arrow">{r.item.sub ? '▸' : ''}</span>
                                </div>
                            ))}
                        </div>
                        {isTop && menu.note && <div className="pk-note">{menu.note}</div>}
                    </div>
                );
            })}
            <div className="pk-panel" ref={panelRef} onMouseDown={(ev) => ev.stopPropagation()}>
                <div className="pk-crumbs">
                    <span className="pk-what">
                        {kind === 'loc'
                            ? `Insert a code${req.title ? ' into ' + req.title : ''}`
                            : req.edit
                            ? `Change: ${req.edit}`
                            : req.title
                            ? `Add to: ${req.title}`
                            : kind === 'effect'
                            ? 'New effect'
                            : kind === 'trigger'
                            ? 'New condition'
                            : kind === 'modifier'
                            ? 'New modifier'
                            : 'New setting'}
                    </span>
                    {crumbs.map((c, i) => (
                        <span key={i} className={'pk-crumb' + (i === crumbs.length - 1 ? ' last' : '')}>
                            {c}
                        </span>
                    ))}
                </div>
                <div className="pk-preview">
                    <pre className="pk-script">{shownText ? <ScriptText text={shownText} /> : <span className="pk-empty">The script appears here as you choose.</span>}</pre>
                    <div className="pk-read">
                        {selRow?.item.warn && !selRow.item.role && <div className="pk-warn">⚠ {selRow.item.warn}</div>}
                        {kind === 'loc' && selRow && !selRow.item.role && (selRow.item.icon || selRow.item.title) ?
                            (
                                // (a text code: what it shows — the icon, or what it prints for William of Normandy in 1066)
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
                                // (an entry: its card — icon, name, description, what it does)
                                <div className="pk-card">
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
                            <span className="pk-empty">{shownText ? '…' : 'Letters pick, ⏎ opens, ← goes back, / searches everything, Esc closes.'}</span>}
                    </div>
                </div>
                <div className="pk-keys">
                    <span>
                        <kbd>A–Z</kbd> pick
                    </span>
                    <span>
                        <kbd>↑↓</kbd> <kbd>⏎</kbd>/<kbd>→</kbd> open
                    </span>
                    <span>
                        <kbd>←</kbd>/<kbd>⌫</kbd> back
                    </span>
                    <span>
                        type to filter · <kbd>Space</kbd> then a name · <kbd>/</kbd> search all · digits for numbers
                    </span>
                    <span>
                        <kbd>Ctrl</kbd>+<kbd>⏎</kbd> done
                    </span>
                    <span>
                        <kbd>Esc</kbd> close
                    </span>
                    {canFinish(top.state) && (
                        <button className="primary pk-done" onClick={() => void finish(top.state)}>
                            Done
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
