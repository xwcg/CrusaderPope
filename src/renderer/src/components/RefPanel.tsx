import { useState } from 'react';
import type { RefGroup } from '../../../shared/api';
import type { Navigate } from '../App';
import { TypeDot } from './common';
import { GameImg } from '../img';
import { ModChip } from './ModChip';

export function RefColumns(props: { incoming: RefGroup[]; outgoing: RefGroup[]; navigate: Navigate; ownType: string; }): React.JSX.Element
{
    const inCount = props.incoming.reduce((s, g) => s + g.items.length, 0);
    const outCount = props.outgoing.reduce((s, g) => s + g.items.length, 0);
    return (
        <div className="ref-columns">
            <div className="ref-column">
                <h3>Referenced by · {inCount}</h3>
                {props.incoming.length === 0 && <div className="list-empty" style={{ padding: 0 }}>Nothing references this.</div>}
                {props.incoming.map((g) => <RefGroupView key={g.type} group={g} navigate={props.navigate} initiallyOpen={g.type !== 'localization' || g.items.length <= 8} />)}
            </div>
            <div className="ref-column">
                <h3>References · {outCount}</h3>
                {props.outgoing.length === 0 && <div className="list-empty" style={{ padding: 0 }}>No outgoing references.</div>}
                {props.outgoing.map((g) => <RefGroupView key={g.type} group={g} navigate={props.navigate} initiallyOpen={g.type !== 'localization' || props.ownType !== 'localization'} />)}
            </div>
        </div>
    );
}

const PAGE = 60;

function RefGroupView(props: { group: RefGroup; navigate: Navigate; initiallyOpen: boolean; }): React.JSX.Element
{
    const { group } = props;
    const [open, setOpen] = useState(props.initiallyOpen);
    const [limit, setLimit] = useState(PAGE);
    const isLoc = group.type === 'localization';
    return (
        <div className="ref-group">
            <header onClick={() => setOpen((o) => !o)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
                <TypeDot type={group.type} />
                <span className="label">{group.typeLabel}</span>
                <span className="n">{group.items.length}</span>
            </header>
            {open &&
                group.items.slice(0, limit).map((it) => (
                    <div key={it.name} className="ref-item" title={it.sites.map((s) => `${s.file}:${s.line}`).join('\n')}>
                        <span className="name" onClick={() => props.navigate({ type: it.type, name: it.name })}>
                            {it.icon && <GameImg path={it.icon} size={18} className="ref-icon" />}
                            {it.name}
                        </span>
                        <span className="count">
                            <ModChip touch={it.mod} />
                            {it.count > 1 ? `×${it.count}` : ''}
                        </span>
                        {it.display && it.display !== it.name && <span className={'display' + (isLoc ? ' loc' : '')}>{it.display}</span>}
                        {it.contexts.length > 0 && (
                            <div className="contexts">
                                {it.contexts.slice(0, 3).map((c) => (
                                    <span key={c} className="ctx">
                                        {c}
                                    </span>
                                ))}
                                {it.contexts.length > 3 && <span className="ctx">+{it.contexts.length - 3}</span>}
                            </div>
                        )}
                    </div>
                ))}
            {open && group.items.length > limit && (
                <button className="show-more" onClick={() => setLimit((l) => l + PAGE * 4)}>
                    Show more ({group.items.length - limit} remaining)
                </button>
            )}
        </div>
    );
}
