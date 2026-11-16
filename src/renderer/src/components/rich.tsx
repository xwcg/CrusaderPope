import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FollowUp, Line, Rich, TooltipInfo } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { GameImg } from '../img';
import { EditCtx, anchorKey } from './editCtx';

import { tr } from '../../../shared/i18n';
const ICONS: Record<string, string> = {
    event: '✦',
    trait: '◆',
    gold: '●',
    prestige: '♛',
    piety: '✝',
    stress: 'ϟ',
    dread: '☠',
    opinion: '♥',
    modifier: '◈',
    flag: '⚑',
    var: '✎',
    chance: '⚄',
    death: '☠',
    scope: '➤',
    if: '⤷',
    else: '⤷',
    loop: '⟳',
    note: '✉',
    skill: '★',
    // a scripted effect's call (its lines under it)
    call: '⚙'
};

/**
 * How a "Leads to …" line shows the event it leads to, right under itself (StoryView: a collapsible branch, per event
 * card (its depth and the events above it)); none: the line alone.
 */
export const FollowCtx = createContext<((f: FollowUp) => ReactNode) | null>(null);

/** Renderer-wide settings for the readable view. */
export const ReadCtx = createContext<{ navigate: Navigate; showHidden: boolean; }>({
    navigate: () =>
    {},
    showHidden: false
});

export function RichText({ rich }: { rich: Rich; }): React.JSX.Element
{
    const { navigate } = useContext(ReadCtx);
    return (
        <>
            {rich.map((s, i) =>
            {
                if (typeof s === 'string')
                    return <span key={i}>{s}</span>;

                // (a game image: the picture, the value as written after it)
                if (s.kind === 'image')
                    return (
                        <span key={i} className="rt-image" title={s.text}>
                            <GameImg path={s.text} size={40} />
                            {s.tip && <span className="rt-code">{s.tip}</span>}
                        </span>
                    );

                // (a number among the values: a colour of its own; "Diplomacy 8", "Born on 1066.9.15" stay apart)
                const cls = 'rt-' + s.kind + (s.ref ? ' rt-link' : '') + (s.kind === 'value' && /^[+-]?\d+(\.\d+)?%?$/.test(s.text.trim()) ? ' rt-num' : '');
                return (
                    <span
                        key={i}
                        className={cls}
                        title={s.ref ? undefined : s.tip}
                        data-ref-type={s.ref?.type}
                        data-ref-name={s.ref?.name}
                        onClick={s.ref
                            ? (e) =>
                            {
                                e.stopPropagation();
                                navigate(s.ref!);
                            }
                            : undefined}
                    >
                        {s.kind === 'color' && <span className="rt-swatch" style={{ background: s.text }} />}
                        {s.text}
                    </span>
                );
            })}
        </>
    );
}

/**
 * A line's keywords marked as in a code editor (the owner's pick, 2026-11-16): an if-line's leading If / Otherwise, if /
 * Otherwise, the "if" inside a weight's "+10 if you …", and a leading Not if / Not / None (the negations, red). The
 * words are the ones the main process writes (tr), found at the start of the line's text; a first segment that is the
 * keyword alone is marked in place, so an if's condition segments (Line.condSegs) keep their places, and a line with
 * condition segments is not split. `inverse`: a not-if line, barred and tinted red (read.css).
 */
export function keywordText(line: Pick<Line, 'text' | 'icon' | 'condSegs'>): { text: Rich; inverse: boolean; }
{
    const flow = line.icon === 'if' || line.icon === 'else';
    const words: [string, 'kw' | 'kwneg'][] = [
        ...(flow ? [[tr('Not if'), 'kwneg'], [tr('Otherwise, if'), 'kw'], [tr('Otherwise'), 'kw'], [tr('If'), 'kw']] as [string, 'kw' | 'kwneg'][] : []),
        [tr('Not'), 'kwneg'],
        [tr('None'), 'kwneg']
    ];
    const first = line.text[0];

    if (typeof first === 'string')
    {
        for (const [w, kind] of words)
        {
            if (!first.startsWith(w) || !/^($|[\s:,])/.test(first.slice(w.length)))
                continue;

            const inverse = kind === 'kwneg' && w === tr('Not if');

            // (the keyword alone, "If ": marked in place)
            if (!first.slice(w.length).trim() || line.condSegs)
                return { text: [{ text: first, kind }, ...line.text.slice(1)], inverse };

            return { text: [{ text: w, kind }, first.slice(w.length), ...line.text.slice(1)], inverse };
        }
    }

    // (a weight's or an effect's "+10 if you are at war": the first "if" of its first few segments)
    if (flow && !line.condSegs)
    {
        const word = tr('if');

        for (let i = 0; i < Math.min(line.text.length, 4); i++)
        {
            const s = line.text[i];
            const m = typeof s === 'string' ? new RegExp(`(^|\\s)${word}(?=$|[\\s:])`).exec(s) : null;

            if (m && typeof s === 'string')
            {
                const at = m.index + m[1].length;
                return { text: [...line.text.slice(0, i), s.slice(0, at), { text: word, kind: 'kw' }, s.slice(at + word.length), ...line.text.slice(i + 1)], inverse: false };
            }
        }
    }

    return { text: line.text, inverse: false };
}

export function LineList({ lines, compact }: { lines: Line[]; compact?: boolean; }): React.JSX.Element | null
{
    const { showHidden } = useContext(ReadCtx);
    const visible = lines.filter((l) => showHidden || !l.hidden);

    if (!visible.length)
        return null;

    // if / else if / else chains: their rows are bracketed together (the bracket runs through each member's block)
    const chainOf = (i: number): string =>
    {
        const l = visible[i];
        const cont = (x: Line | undefined): boolean => !!x && (x.icon === 'else' || (x.icon === 'if' && String(x.text[0]).startsWith(tr('Otherwise'))));

        if (l.icon !== 'if' && l.icon !== 'else')
            return '';

        const first = !cont(l);
        const last = !cont(visible[i + 1]);
        return first && last ? tr(' chain chain-solo') : first ? tr(' chain chain-start') : last ? tr(' chain chain-end') : tr(' chain chain-mid');
    };
    return (
        <ul className={'lines' + (compact ? ' compact' : '')}>
            {visible.map((l, i) => <LineItem key={i} line={l} chain={chainOf(i)} />)}
        </ul>
    );
}

function LineItem({ line, chain = '' }: { line: Line; chain?: string; }): React.JSX.Element
{
    const { showHidden } = useContext(ReadCtx);
    const follow = useContext(FollowCtx);
    // editing in place (InPlaceEdit.tsx): lines written in the active mod get actions, a selection and an editor
    const ed = useContext(EditCtx);
    const key = ed && line.src && ed.can(line.src) ? anchorKey(line.src) : undefined;
    // its text (Line.locKey): "✎ text" where the line is the active mod's statement, or where the text's owner is
    // (Line.locAt: a line that is no statement, a bookmark character's name, a `NOT_` text); the line itself gets no
    // row actions from locAt
    const locOwn = !!line.locKey && !!ed && (!!key || (!!line.locAt && ed.can(line.locAt)));
    // (a line of a scripted effect / trigger the mod's entry calls that is the game's or another mod's (src.owner): its
    // text is changed as an override of just that key in the mod's replace folder, which changes it everywhere the key
    // is used; the effect itself is not overridden)
    const locForeign = !locOwn && !key && !!line.locKey && !!ed?.entry && !!line.src?.owner;
    // an if with its one condition in its text: the condition is a row of its own within the line ("If ‹you are an adult›:")
    const cond = line.condSegs && line.ifConds?.length === 1 ? line.ifConds[0] : undefined;
    const condKey = ed && cond?.src && ed.can(cond.src) ? anchorKey(cond.src) : undefined;
    const [open, setOpen] = useState(!line.collapsed);
    // (its keywords marked: If / Otherwise / Not if …, keywordText)
    const shown = keywordText(line);
    // (a note for lines left out for the card's size: "Show them here" loads them, with the call's own values)
    const [more, setMore] = useState<Line[] | 'gone' | 'loading' | null>(null);
    const kids = (line.children ?? []).filter((c) => showHidden || !c.hidden);
    const expandable = line.collapsed && kids.length > 0;
    const onClick = expandable || key ?
        () =>
        {
            if (key)
                ed!.select(key);

            if (expandable)
                setOpen((o) => !o);
        } :
        undefined;
    if (Array.isArray(more))
        return (
            <li className="line more-lines">
                <LineList lines={more} />
            </li>
        );

    return (
        <li className={'line' + chain + (shown.inverse ? ' inverse' : '') + (line.hidden ? ' hidden-line' : '') + (line.tone ? ' tone-' + line.tone : '') + (line.placeholder ? ' placeholder-line' : '')}>
            <div
                className={'line-row' + (key ? ' editable' : '') + (key && ed!.selected === key ? ' selected' : '')}
                data-anchor={key}
                title={line.tip}
                onClick={onClick}
                style={expandable ? { cursor: 'pointer' } : undefined}
            >
                <span className={'line-icon icon-' + (line.icon ?? 'dot')}>{ICONS[line.icon ?? ''] ?? '•'}</span>
                <span className="line-text">
                    {condKey ?
                        (
                            <>
                                <RichText rich={shown.text.slice(0, line.condSegs![0])} />
                                <span
                                    className={'if-cond' + (ed!.selected === condKey ? ' selected' : '')}
                                    data-anchor={condKey}
                                    title={cond!.tip}
                                    onClick={(e) =>
                                    {
                                        e.stopPropagation();
                                        ed!.select(condKey);
                                    }}
                                >
                                    <RichText rich={shown.text.slice(...line.condSegs!)} />
                                    {ed!.actions(cond!.src!, cond)}
                                </span>
                                <RichText rich={shown.text.slice(line.condSegs![1])} />
                            </>
                        ) :
                        // (a localization text: "✎ text" changes it (locOwn, locForeign above); a follow-up event's text is
                        // its own)
                        locOwn ?
                        ed!.locText(line.locKey!, <RichText rich={shown.text} />) :
                        locForeign ?
                        (
                            <span className="loc-foreign">
                                {ed!.locText(line.locKey!, <RichText rich={shown.text} />)}
                                {/* (shown while its editor is open: edit.css) */}
                                <small className="loc-foreign-hint">
                                    {tr('{key} is a text of {whose} script: saving writes it into {mod} (an override of just this key in its replace folder, unless {mod} has the key already), and the text changes everywhere the game uses the key', { key: line.locKey!, whose: line.src!.mod ? tr('another mod’s') : tr('the game’s'), mod: ed!.mod.name })}
                                </small>
                            </span>
                        ) :
                        <RichText rich={shown.text} />}
                    {expandable && <span className="line-toggle">{open ? ' ▾' : ' ▸'}</span>}
                    {line.more !== undefined && more !== 'gone' && (
                        <button
                            className="ghost small"
                            disabled={more === 'loading'}
                            onClick={(e) =>
                            {
                                e.stopPropagation();
                                setMore('loading');
                                void api.moreLines(line.more!).then(
                                    (l) => setMore(l ?? 'gone'),
                                    () => setMore('gone')
                                );
                            }}
                        >
                            {more === 'loading' ? tr('Loading…') : tr('Show them here')}
                        </button>
                    )}
                    {more === 'gone' && <small className="sec-empty">{' '}{tr('(no longer kept: open the card again)')}</small>}
                </span>
                {line.act && ed && ed.act(line.act, line)}
                {key && ed!.actions(line.src!, line)}
                {/* (a line of a scripted effect the entry calls, not the active mod's: ✎ ✕ ＋ ⤷＋ override it first) */}
                {!key && ed?.entry && line.src?.owner && ed.offer(line.src, line)}
            </div>
            {key && ed!.editor(key)}
            {condKey && ed!.editor(condKey)}
            {line.conditions && line.conditions.length > 0 && (
                <div className="line-conditions">
                    <LineList lines={line.conditions} compact />
                </div>
            )}
            {open && kids.length > 0 && <LineList lines={kids} />}
            {line.followUp && follow && <div className="line-follow">{follow(line.followUp)}</div>}
        </li>
    );
}

// ---------------------------------------------------------------------------
// Hover cards: RPG-style tooltip for any linked entity
// ---------------------------------------------------------------------------

const tooltipCache = new Map<string, Promise<TooltipInfo | null>>();

function fetchTooltip(type: string, name: string): Promise<TooltipInfo | null>
{
    const key = type + '\u0000' + name;
    let p = tooltipCache.get(key);

    if (!p)
    {
        p = api.tooltip(type, name);
        tooltipCache.set(key, p);
    }

    return p;
}

export function clearTooltipCache(): void
{
    tooltipCache.clear();
}

/** A card shown: pinned ones stay (a stack: each one's links preview the next), the last one may follow the mouse. */
type ShownCard = { info: TooltipInfo; x: number; y: number; pinned: boolean; };

/** Which card of the stack an element is in (-1: none). */
function cardLevel(el: Element | null): number
{
    const c = el?.closest?.('.hovercard');
    return c ? Number(c.getAttribute('data-level')) : -1;
}

export function HoverCardLayer(props: { navigate: Navigate; }): React.JSX.Element | null
{
    // a middle click pins the card shown: it stays and takes the mouse (links, scrolling) until closed; its links show
    // cards of their own, which can be pinned again, and so on
    const [stack, setStack] = useState<ShownCard[]>([]);
    const stackRef = useRef<ShownCard[]>([]);
    stackRef.current = stack;
    const timer = useRef<number | undefined>(undefined);
    const current = useRef<Element | null>(null);
    const pinnedCount = (s: ShownCard[]): number => s.filter((c) => c.pinned).length;
    /** keeps the first `n` cards (0: closes all) */
    const keep = (n: number): void =>
    {
        window.clearTimeout(timer.current);
        current.current = null;
        setStack((s) => (s.length > n ? s.slice(0, n) : s));
    };

    useEffect(() =>
    {
        const down = (e: MouseEvent): void =>
        {
            const s = stackRef.current;
            const top = s[s.length - 1];

            // (middle button while a card follows the mouse: pin it, not the browser's auto-scroll)
            if (e.button === 1 && top && !top.pinned)
            {
                e.preventDefault();
                current.current = null;
                setStack((st) => st.map((c, i) => (i === st.length - 1 ? { ...c, pinned: true } : c)));
            }
            // (a click outside the pinned cards closes them; on a lower one, the ones above it)
            else if (pinnedCount(s) && e.button === 0)
                keep(cardLevel(e.target as Element) + 1);
        };
        const key = (e: KeyboardEvent): void =>
        {
            const n = pinnedCount(stackRef.current);

            // (the topmost pinned card, and the one it shows)
            if (e.key === 'Escape' && n)
                keep(n - 1);
        };
        document.addEventListener('mousedown', down, true);
        document.addEventListener('keydown', key);
        return () =>
        {
            document.removeEventListener('mousedown', down, true);
            document.removeEventListener('keydown', key);
        };
    }, []);

    useEffect(() =>
    {
        const over = (e: MouseEvent): void =>
        {
            const pins = pinnedCount(stackRef.current);
            const target = e.target as Element;
            const level = cardLevel(target);

            // (on the card that follows the mouse; over a pinned one: it stays)
            if (pins && level === pins)
                return;

            // (while cards are pinned only the topmost one's links show cards; the rest of the page is still)
            const el = !pins || level === pins - 1 ? target.closest?.('[data-ref-type]') ?? null : null;

            if (el === current.current)
                return;

            current.current = el;
            window.clearTimeout(timer.current);

            if (!el)
            {
                setStack((s) => (s.length > pins ? s.slice(0, pins) : s));
                return;
            }

            const type = el.getAttribute('data-ref-type')!;
            const name = el.getAttribute('data-ref-name')!;
            timer.current = window.setTimeout(() =>
            {
                void fetchTooltip(type, name).then((info) =>
                {
                    if (!info || current.current !== el)
                        return;

                    const r = el.getBoundingClientRect();
                    setStack((s) =>
                    {
                        const p = pinnedCount(s);
                        return [...s.slice(0, p), { info, x: r.left, y: r.bottom, pinned: false }];
                    });
                });
            }, 320);
        };
        document.addEventListener('mouseover', over);
        return () => document.removeEventListener('mouseover', over);
    }, []);

    if (!stack.length)
        return null;

    return (
        <>
            {stack.map((c, i) => (
                <HoverCard
                    key={i}
                    card={c}
                    level={i}
                    onClose={() => keep(i)}
                    navigate={(r) =>
                    {
                        keep(0);
                        props.navigate(r);
                    }}
                />
            ))}
        </>
    );
}

/** A hover card's line without script tooltips, its nested lines too. */
function noTips(l: Line): Line
{
    return { ...l, tip: undefined, children: l.children?.map(noTips), conditions: l.conditions?.map(noTips) };
}

function HoverCard(props: { card: ShownCard; level: number; onClose: () => void; navigate: Navigate; }): React.JSX.Element
{
    const { info, pinned } = props.card;
    const left = Math.min(props.card.x, window.innerWidth - 380);
    const below = props.card.y + 8;
    const style: React.CSSProperties = {
        ...(below > window.innerHeight - 260 ? { left, bottom: window.innerHeight - props.card.y + 30 } : { left, top: below }),
        // (each one over the card it came from)
        zIndex: 300 + props.level
    };
    return (
        <div className={'hovercard' + (pinned ? ' pinned' : '')} style={style} data-level={props.level}>
            {pinned && (
                <button className="hc-close" title={tr('Close (Esc)')} onClick={props.onClose}>
                    ×
                </button>
            )}
            {info.illustration && <GameImg path={info.illustration} size={360} className="hc-banner" />}
            <div className="hc-head">
                {info.icon && <GameImg path={info.icon} size={44} className="hc-icon" />}
                <div>
                    <div className="hc-type">{info.typeLabel}</div>
                    <div className="hc-title">{info.title}</div>
                </div>
            </div>
            {info.description && <div className="hc-desc">{info.description}</div>}
            {info.lines.length > 0 && (
                <ReadCtx.Provider
                    value={{
                        navigate: (r) =>
                        {
                            if (pinned)
                                props.navigate(r);
                        },
                        showHidden: false
                    }}>
                    {/* (no script tooltips here: hovering a link shows its card; the nested lines the main process kept stay) */}
                    <LineList lines={info.lines.map(noTips)} compact />
                </ReadCtx.Provider>
            )}
            <div className="hc-key">
                {pinned ? <a onClick={() => props.navigate({ type: info.key.type, name: info.key.name })}>{info.key.name}</a> : info.key.name}
                {!pinned && <span className="hc-hint">{tr('· middle click to pin')}</span>}
            </div>
        </div>
    );
}
