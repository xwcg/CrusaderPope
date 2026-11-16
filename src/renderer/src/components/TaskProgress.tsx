/**
 * The progress of a mods task (mods:progress, "Fix for 1.20…", "Merge into one mod…"): the stage and its count above,
 * the bar below. Without a count (planning, reading) the bar is indeterminate (a moving stripe), so something visibly
 * goes on.
 */
import type { MigrationProgress } from '../../../shared/api';
import { tr } from '../../../shared/i18n';

export function TaskProgress(props: { progress: MigrationProgress | null; }): React.JSX.Element
{
    const p = props.progress;
    const counted = !!p?.total;

    return (
        <div className="migrate-progress">
            <div className="progress-row">
                <span>{p?.stage ?? tr('Starting…')}</span>
                <span>{counted ? `${p.done} / ${p.total}` : ''}</span>
            </div>
            <div className={'progress' + (counted ? '' : ' indeterminate')}>
                <div style={counted ? { width: Math.round((100 * p.done) / p.total) + '%' } : undefined} />
            </div>
        </div>
    );
}
