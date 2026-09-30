import { Fragment } from 'react';
import type { BracketLink, EventPreview } from '../../../shared/api';
import type { Navigate } from '../App';
import { TypeDot } from './common';

/**
 * Renders localization text: [data functions] and $keys$ are highlighted, \n are line breaks (via pre-wrap); brackets
 * naming an entity (EntityDetail.textRefs) are links with hover cards.
 */
export function LocText({ text, refs, navigate }: { text: string; refs?: Record<string, BracketLink>; navigate?: Navigate; }): React.JSX.Element
{
    const parts = text.split(/(\[[^\]]*\]|\$[^$\s]+\$)/g);
    return (
        <>
            {parts.map((p, i) =>
                p.length > 2 && p.startsWith('[') && p.endsWith(']') ?
                    (
                        refs?.[p.slice(1, -1)] && navigate ?
                            (
                                <span
                                    className="loc-bracket link"
                                    key={i}
                                    data-ref-type={refs[p.slice(1, -1)].type}
                                    data-ref-name={refs[p.slice(1, -1)].name}
                                    onClick={() => navigate(refs[p.slice(1, -1)])}
                                >
                                    {refs[p.slice(1, -1)].text ?? p.slice(1, -1)}
                                </span>
                            ) :
                            (
                                <span className="loc-bracket" key={i}>
                                    {p.slice(1, -1)}
                                </span>
                            )
                    ) :
                    p.length > 2 && p.startsWith('$') && p.endsWith('$') ?
                    (
                        <span className="loc-dollar" key={i}>
                            {p}
                        </span>
                    ) :
                    <Fragment key={i}>{p}</Fragment>
            )}
        </>
    );
}

export function EventCard({ ev, navigate, refs }: { ev: EventPreview; navigate: Navigate; refs?: Record<string, BracketLink>; }): React.JSX.Element
{
    const [title, ...altTitles] = ev.titles;
    return (
        <div className="event-card">
            <div className="ev-head">
                <div className="ev-title">{title ? <LocText text={title.text ?? title.key} refs={refs} navigate={navigate} /> : <i>(no title)</i>}</div>
                {altTitles.map((t) => (
                    <div key={t.key} className="ev-title alt" title={t.key}>
                        or: <LocText text={t.text ?? t.key} refs={refs} navigate={navigate} />
                    </div>
                ))}
                <div className="ev-meta">
                    {ev.eventType && <span className="chip accent">{ev.eventType}</span>}
                    {ev.theme && (
                        <span className="chip link" onClick={() => navigate({ type: 'event_themes', name: ev.theme! })}>
                            theme: {ev.theme}
                        </span>
                    )}
                    {ev.hidden && <span className="chip">hidden</span>}
                    {ev.cooldown && <span className="chip">cooldown {ev.cooldown}</span>}
                    {ev.hasTrigger && <span className="chip">trigger</span>}
                    {ev.hasImmediate && <span className="chip">immediate</span>}
                    {ev.hasAfter && <span className="chip">after</span>}
                </div>
            </div>
            {ev.portraits.length > 0 && (
                <div className="ev-portraits" style={{ paddingTop: 10 }}>
                    {ev.portraits.map((p, i) => (
                        <span key={i} className="chip">
                            {p.position.replace(/_portrait$/, '')}: {p.character}
                            {p.animation ? ` (${p.animation})` : ''}
                        </span>
                    ))}
                </div>
            )}
            {ev.descs.length > 0 && (
                <div className="ev-body">
                    {ev.descs.map((d) => (
                        <div key={d.key} className="ev-desc" style={{ whiteSpace: 'pre-wrap' }}>
                            {ev.descs.length > 1 && <span className="ev-key">{d.key}</span>}
                            <LocText text={d.text ?? d.key} refs={refs} navigate={navigate} />
                        </div>
                    ))}
                </div>
            )}
            {ev.options.length > 0 && (
                <div className="ev-options">
                    {ev.options.map((o, i) => (
                        <div key={i} className="event-option">
                            <div className="opt-text">
                                {o.names.length ? <LocText text={o.names[0].text ?? o.names[0].key} refs={refs} navigate={navigate} /> : <i>(unnamed option)</i>}
                            </div>
                            {o.names.slice(1).map((n) => (
                                <div key={n.key} className="opt-text" style={{ fontSize: 12, color: '#bca97c' }}>
                                    or: <LocText text={n.text ?? n.key} refs={refs} navigate={navigate} />
                                </div>
                            ))}
                            <div className="opt-meta">
                                {o.conditional && <span className="chip">conditional</span>}
                                {o.fallback && <span className="chip">fallback</span>}
                                {o.references.map((r) => (
                                    <span key={r.type + r.name} className="chip link" title={r.type} onClick={() => navigate(r)}>
                                        <TypeDot type={r.type} /> {r.name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
