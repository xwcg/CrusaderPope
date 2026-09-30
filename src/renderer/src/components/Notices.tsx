import { dismissNotice, useNotices } from '../notices';
import '../styles/edit.css';

/** The app-wide notices (notices.ts), bottom right, until dismissed. */
export function Notices(): React.JSX.Element | null
{
    const notices = useNotices();

    if (!notices.length)
        return null;

    return (
        <div className="notices">
            {notices.map((n) => (
                <div key={n.id} className={'notice ' + n.kind}>
                    <div className="notice-body">
                        {n.title && <b>{n.title}</b>}
                        <span>{n.text}</span>
                        {n.details?.map((d, i) => <small key={i}>{d}</small>)}
                        {n.actions && n.actions.length > 0 && (
                            <div className="notice-actions">
                                {n.actions.map((a) => (
                                    <button key={a.label} onClick={a.run}>
                                        {a.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <button className="ghost notice-close" onClick={() => dismissNotice(n.id)} title="Dismiss">
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
