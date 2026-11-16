/**
 * A closed fold with a count chip: the summary row is the title, the content is built only when the fold is opened
 * (a long list inside a closed <details> would still be created and diffed on every render).
 */
import { memo, useState } from 'react';

export const Fold = memo(function Fold(props: { title: React.ReactNode; count?: number; tone?: 'warn' | 'ok'; defaultOpen?: boolean; className?: string; children: () => React.ReactNode; }): React.JSX.Element
{
    const [open, setOpen] = useState(!!props.defaultOpen);

    return (
        <details className={'fold' + (props.className ? ' ' + props.className : '')} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary>
                <span className={'fold-title' + (props.tone && props.count === undefined ? ' ' + props.tone : '')}>{props.title}</span>
                {props.count !== undefined && <span className={'chip' + (props.tone ? ' ' + props.tone : '')}>{props.count}</span>}
            </summary>
            {open && <div className="fold-body">{props.children()}</div>}
        </details>
    );
});
