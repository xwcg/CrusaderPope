import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FollowUp, Line, Rich, TooltipInfo } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { GameImg } from '../img';
import { EditCtx, anchorKey } from './editCtx';

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
 * card — its depth and the events above it); none: the line alone.
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

                const cls = 'rt-' + s.kind + (s.ref ? ' rt-link' : '');
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

export function LineList({ lines, compact }: { lines: Line[]; compact?: boolean; }): React.JSX.Element | null
{
    const { showHidden } = useContext(ReadCtx);
    const visible = lines.filter((l) => showHidden || !l.hidden);

    if (!visible.length)
        return null;

    return (
        <ul className={'lines' + (compact ? ' compact' : '')}>
            {visible.map((l, i) => <LineItem key={i} line={l} />)}
        </ul>
    );
}

function LineItem({ line }: { line: Line; }): React.JSX.Element
{
    const { showHidden } = useContext(ReadCtx);
    const follow = useContext(FollowCtx);
    // editing in place (InPlaceEdit.tsx): lines written in the active mod get actions, a selection and an editor
    const ed = useContext(EditCtx);
    const key = ed && line.src && ed.can(line.src) ? anchorKey(line.src) : undefined;
    // an if with its one condition in its text: the condition is a row of its own within the line ("If ‹you are an adult›:")
    const cond = line.condSegs && line.ifConds?.length === 1 ? line.ifConds[0] : undefined;
    const condKey = ed && cond?.src && ed.can(cond.src) ? anchorKey(cond.src) : undefined;
    const [open, setOpen] = useState(!line.collapsed);
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
    return (
        <li className={'line' + (line.hidden ? ' hidden-line' : '') + (line.tone ? ' tone-' + line.tone : '') + (line.placeholder ? ' placeholder-line' : '')}>
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
                                <RichText rich={line.text.slice(0, line.condSegs![0])} />
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
                                    <RichText rich={line.text.slice(...line.condSegs!)} />
                                    {ed!.actions(cond!.src!, cond)}
                                </span>
                                <RichText rich={line.text.slice(line.condSegs![1])} />
                            </>
                        ) :
                        // (a localization text: "✎ text" changes it — where the line is the active mod's statement; a follow-up
                        // event's or a game effect's text is theirs)
                        line.locKey && ed && key ?
                        ed.locText(line.locKey, <RichText rich={line.text} />) :
                        <RichText rich={line.text} />}
                    {expandable && <span className="line-toggle">{open ? ' ▾' : ' ▸'}</span>}
                </span>
                {line.act && ed && ed.act(line.act, line)}
                {key && ed!.actions(line.src!, line)}
                {/* (a line of a scripted effect the entry calls, not the active mod's: ✎ overrides it first) */}
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

export function HoverCardLayer(props: { navigate: Navigate; }): React.JSX.Element | null
{
    const [state, setState] = useState<{ info: TooltipInfo; x: number; y: number; } | null>(null);
    // a middle click pins the card shown: it stays, takes the mouse (links, scrolling) until closed
    const [pinned, setPinned] = useState(false);
    const pinnedRef = useRef(false);
    pinnedRef.current = pinned;
    const timer = useRef<number | undefined>(undefined);
    const current = useRef<Element | null>(null);
    const card = useRef<HTMLDivElement | null>(null);
    const close = (): void =>
    {
        setPinned(false);
        setState(null);
        current.current = null;
    };

    useEffect(() =>
    {
        const down = (e: MouseEvent): void =>
        {
            // (middle button while a card shows: pin it — not the browser's auto-scroll)
            if (e.button === 1 && card.current && !pinnedRef.current)
            {
                e.preventDefault();
                setPinned(true);
            }
            // (a click outside a pinned card closes it)
            else if (pinnedRef.current && e.button === 0 && !card.current?.contains(e.target as Node))
                close();
        };
        const key = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape' && pinnedRef.current)
                close();
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
            // (a pinned card stays whatever the mouse passes)
            if (pinnedRef.current)
                return;

            const el = (e.target as Element).closest?.('[data-ref-type]');

            if (el === current.current)
                return;

            current.current = el;
            window.clearTimeout(timer.current);

            if (!el)
            {
                setState(null);
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
                    setState({ info, x: r.left, y: r.bottom });
                });
            }, 320);
        };
        document.addEventListener('mouseover', over);
        return () => document.removeEventListener('mouseover', over);
    }, []);

    if (!state)
        return null;

    const { info } = state;
    const left = Math.min(state.x, window.innerWidth - 380);
    const below = state.y + 8;
    const style: React.CSSProperties = below > window.innerHeight - 260 ? { left, bottom: window.innerHeight - state.y + 30 } : { left, top: below };
    return (
        <div ref={card} className={'hovercard' + (pinned ? ' pinned' : '')} style={style}>
            {pinned && (
                <button className="hc-close" title="Close (Esc)" onClick={close}>
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
                            if (!pinned)
                                return;

                            close();
                            props.navigate(r);
                        },
                        showHidden: false
                    }}>
                    <LineList lines={info.lines.map((l) => ({ ...l, children: undefined, conditions: undefined }))} compact />
                </ReadCtx.Provider>
            )}
            <div className="hc-key">
                {pinned ?
                    (
                        <a
                            onClick={() =>
                            {
                                close();
                                props.navigate({ type: info.key.type, name: info.key.name });
                            }}
                        >
                            {info.key.name}
                        </a>
                    ) :
                    info.key.name}
                {!pinned && <span className="hc-hint">· middle click to pin</span>}
            </div>
        </div>
    );
}
