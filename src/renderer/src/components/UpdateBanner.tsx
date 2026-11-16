import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../../../shared/api';
import { api } from '../api';

import { tr } from '../../../shared/i18n';
/**
 * A newer release (main/updates.ts, checked once per start): a bar under the top bar with a link to its page. × hides it
 * for this session; with "Don't remind me about this version again" ticked it stays hidden for this version
 * (Settings.updateSkip); a later one shows again. Turned off in Settings → Updates and in the first-run setup.
 */
export function UpdateBanner(props: { onShown: (shown: boolean) => void; }): React.JSX.Element | null
{
    const [info, setInfo] = useState<{ current: string; update: UpdateInfo; } | null>(null);
    const [skip, setSkip] = useState(false);

    useEffect(() =>
    {
        void Promise.all([api.updateInfo(), api.getSettings()]).then(([u, s]) =>
        {
            if (u.update && u.update.version !== s.updateSkip)
                setInfo({ current: u.current, update: u.update });
        });
    }, []);

    useEffect(() => props.onShown(!!info), [info]);

    if (!info)
        return null;

    const close = (): void =>
    {
        if (skip)
            void api.setSettings({ updateSkip: info.update.version });

        setInfo(null);
    };

    return (
        <div className="update-banner" role="status">
            <span className="update-mark" aria-hidden="true">
                ✦
            </span>
            <span className="update-text">
                <b>{tr('CrusaderPope {version}', { version: info.update.version })}</b> {' '}{tr('is out — you have {current}.', { current: info.current })}{' '}
                <a href={info.update.url} target="_blank" rel="noreferrer">
                    {tr('What\'s new and download')}</a>
            </span>
            <span style={{ flex: 1 }} />
            <label className="check">
                <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> {' '}{tr('Don\'t remind me about this version again')}</label>
            <button className="update-close" title={tr('Close')} onClick={close}>
                ×
            </button>
        </div>
    );
}
