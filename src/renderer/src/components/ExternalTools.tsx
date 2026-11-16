/**
 * External tools (the settings' page, docs/saves.md "Binary saves"): programs the app can use but doesn't ship: rakaly,
 * which turns binary saves (autosaves, ironman) into text saves. Downloaded from its GitHub releases only when asked
 * for (here, or when a binary save is loaded); the update check asks GitHub for its latest release.
 */
import { useEffect, useState } from 'react';
import { tr } from '../../../shared/i18n';
import { api } from '../api';
import { errorText } from './ModDialogs';
import '../styles/saves.css';

/** rakaly: installed or not, its version, download / update. `compact`: the Save tab's prompt (no update check). */
export function RakalyTool(props: { onInstalled?: () => void; }): React.JSX.Element
{
    const [state, setState] = useState<{ installed: boolean; version?: string; } | null>(null);
    const [latest, setLatest] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() =>
    {
        void api.rakaly().then(setState);
    }, []);

    const run = async (what: string, fn: () => Promise<void>): Promise<void> =>
    {
        setBusy(what);
        setError(null);

        try
        {
            await fn();
        }
        catch (e)
        {
            setError(errorText(e));
        }
        finally
        {
            setBusy(null);
        }
    };
    const install = (): Promise<void> =>
        run(tr('Downloading…'), async () =>
        {
            const r = await api.installRakaly();
            setState({ installed: true, version: r.version });
            setLatest(r.version);
            props.onInstalled?.();
        });
    const check = (): Promise<void> => run(tr('Checking…'), async () => setLatest((await api.rakalyLatest()).version));
    const newer = !!latest && !!state?.version && latest !== state.version;

    return (
        <div className="field">
            <label>rakaly</label>
            <span className="hint">
                {tr('Turns binary saves (autosaves, ironman) into text saves, so they can be loaded and edited. An open-source program by Nick Babcock (MIT license, github.com/rakaly/cli) — not part of this app: downloaded from its GitHub releases when you ask for it.')}
            </span>
            <div className="row">
                <span className="tool-state">
                    {!state ? '…' : state.installed ? tr('Installed: version {version}', { version: state.version ?? '?' }) : tr('Not installed')}
                    {latest && !newer && state?.installed && <span className="dim"> · {tr('the latest')}</span>}
                    {newer && <span className="tool-newer"> · {tr('{version} is out', { version: latest })}</span>}
                </span>
                <span style={{ flex: 1 }} />
                {(!state?.installed || newer) && (
                    <button disabled={!!busy} onClick={() => void install()}>
                        {busy ?? (state?.installed ? tr('Update') : tr('Download'))}</button>
                )}
                {state?.installed && <button className="ghost" disabled={!!busy} onClick={() => void check()}>{busy === tr('Checking…') ? busy : tr('Check for an update')}</button>}
            </div>
            {error && <span className="hint error">{error}</span>}
        </div>
    );
}

/** The settings' page. */
export function ExternalToolsPage(): React.JSX.Element
{
    return (
        <>
            <p className="hint">{tr('Programs the app can use but doesn’t include. Nothing is downloaded unless you ask.')}</p>
            <RakalyTool />
        </>
    );
}
