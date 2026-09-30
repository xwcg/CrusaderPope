import { useEffect, useState } from 'react';
import type { IndexStatus, Settings } from '../../../shared/api';
import { api } from '../api';
import { GraphicsDetails, GraphicsPresetChoice } from './FirstRunWizard';

export function SettingsDialog(props: { status: IndexStatus; onClose: () => void; }): React.JSX.Element
{
    const [s, setS] = useState<Settings | null>(null);
    const [langs, setLangs] = useState<string[]>([]);
    const [cores, setCores] = useState(0);
    // the page shown (the list on the left; a row of tabs on narrow windows)
    const [page, setPage] = useState<'folders' | 'language' | 'graphics' | 'performance' | 'editing'>('folders');
    // the user folder in effect (configured or detected), shown when none is configured
    const [detectedUserDir, setDetectedUserDir] = useState('');

    useEffect(() =>
    {
        void api.getSettings().then(setS);
        void api.languages().then(setLangs);
        void api.cpuCount().then(setCores);
        void api
            .modsState()
            .then((m) => setDetectedUserDir(m.userDir))
            .catch(() => undefined);
    }, []);

    if (!s)
        return <div className="modal-backdrop" />;

    return (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
            <div className="modal settings-modal">
                <h2>Settings</h2>
                <div className="settings-body">
                    <nav className="settings-nav">
                        <button className={page === 'folders' ? 'active' : ''} onClick={() => setPage('folders')}>
                            Game and folders
                        </button>
                        <button className={page === 'language' ? 'active' : ''} onClick={() => setPage('language')}>
                            Language
                        </button>
                        <button className={page === 'graphics' ? 'active' : ''} onClick={() => setPage('graphics')}>
                            Graphics
                        </button>
                        <button className={page === 'performance' ? 'active' : ''} onClick={() => setPage('performance')}>
                            Performance
                        </button>
                        <button className={page === 'editing' ? 'active' : ''} onClick={() => setPage('editing')}>
                            Editing
                        </button>
                    </nav>
                    <div className="settings-page">
                        {page === 'folders' && (
                            <>
                                <div className="field">
                                    <label>Crusader Kings III installation folder</label>
                                    <div className="row">
                                        <input value={s.gameDir} onChange={(e) => setS({ ...s, gameDir: e.target.value })} spellCheck={false} />
                                        <button onClick={() => void api.chooseGameDir().then((p) => p && setS({ ...s, gameDir: p }))}>Browse…</button>
                                    </div>
                                    <span className="hint">The folder that contains game/ (e.g. …\steamapps\common\Crusader Kings III). The game folder itself works too.</span>
                                </div>
                                <div className="field">
                                    <label>Crusader Kings III user folder</label>
                                    <div className="row">
                                        <input
                                            value={s.userDir ?? ''}
                                            placeholder={detectedUserDir || 'detected automatically'}
                                            onChange={(e) => setS({ ...s, userDir: e.target.value || undefined })}
                                            spellCheck={false}
                                        />
                                        <button onClick={() => void api.chooseUserDir().then((p) => p && setS({ ...s, userDir: p }))}>Browse…</button>
                                    </div>
                                    <span className="hint">
                                        Where the launcher keeps mods, playsets and dlc_load.json (…\Documents\Paradox Interactive\Crusader Kings III). Leave empty to use the detected folder.
                                    </span>
                                </div>
                            </>
                        )}
                        {page === 'language' && (
                            <>
                                <div className="field">
                                    <label>Localization language</label>
                                    <select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })}>
                                        {(langs.includes(s.language) ? langs : [s.language, ...langs]).map((l) => (
                                            <option key={l} value={l}>
                                                {l}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </>
                        )}
                        {page === 'graphics' && (
                            <>
                                <div className="field">
                                    <label>Graphics</label>
                                    <GraphicsPresetChoice value={s.graphics} onChange={(g) => setS({ ...s, graphics: g })} />
                                    <GraphicsDetails value={s.graphics} onChange={(g) => setS({ ...s, graphics: g })} />
                                </div>
                            </>
                        )}
                        {page === 'performance' && (
                            <>
                                <div className="field">
                                    <label>Texture decoding threads</label>
                                    <select value={s.imageWorkers ?? 0} onChange={(e) => setS({ ...s, imageWorkers: Number(e.target.value) })}>
                                        <option value={0}>Automatic — one per CPU core ({cores})</option>
                                        {Array.from({ length: Math.max(cores, 1) * 2 }, (_, i) => i + 1).map((n) => (
                                            <option key={n} value={n}>
                                                {n}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="hint">Images and 3D model textures decode in parallel on this many worker threads. Changing it restarts only the image workers.</span>
                                </div>
                                <div className="field">
                                    <label className="check">
                                        <input type="checkbox" checked={s.indexCache !== false} onChange={(e) => setS({ ...s, indexCache: e.target.checked })} /> Cache the parsed index and compiled shaders
                                    </label>
                                    <span className="hint">
                                        Startup loads the index and the game&apos;s compiled shaders from disk instead of parsing and compiling again. Both are rebuilt by themselves when game files, the language or the app change; &quot;Re-index now&quot; always starts afresh. Off: every start parses and compiles, and
                                        the cache files are removed.
                                    </span>
                                </div>
                                {props.status.stats && (
                                    <div className="hint">
                                        Current index: {props.status.stats.files.toLocaleString()} files, {props.status.stats.entities.toLocaleString()} entries, {props.status.stats.refs.toLocaleString()} references, {props.status.stats.locKeys.toLocaleString()} loc keys —{' '}
                                        {props.status.stats.cached ? 'loaded from the cache' : 'built'} in {(props.status.stats.ms / 1000).toFixed(1)}s from {props.status.gameDir}
                                    </div>
                                )}
                            </>
                        )}
                        {page === 'editing' && (
                            <>
                                <div className="field">
                                    <label className="check">
                                        <input type="checkbox" checked={s.formatScripts !== false} onChange={(e) => setS({ ...s, formatScripts: e.target.checked })} /> Format the mod&apos;s script files
                                    </label>
                                    <span className="hint">
                                        Every change to a script file of the active mod — made here or saved in another editor — is re-indented with tabs, one statement per line, short blocks kept on one line, at most one blank line in a row. Only whitespace changes; a file the formatter can&apos;t read cleanly
                                        (unbalanced braces) stays as it is. Localization files are left alone.
                                    </span>
                                </div>
                            </>
                        )}
                    </div>
                </div>
                <div className="actions">
                    <button
                        onClick={() =>
                        {
                            void api.rebuild();
                            props.onClose();
                        }}
                    >
                        Re-index now
                    </button>
                    <span style={{ flex: 1 }} />
                    <button onClick={props.onClose}>Cancel</button>
                    <button className="primary" onClick={() => void api.setSettings(s).then(props.onClose)}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}

export function IndexingScreen(props: { status: IndexStatus; onSettings: () => void; }): React.JSX.Element
{
    const { status } = props;
    const pct = status.total ? Math.round(((status.done ?? 0) / status.total) * 100) : 0;
    const overall = Math.round((status.overall ?? 0) * 100);
    return (
        <div className="indexing-screen">
            <h2>Getting ready...</h2>
            {status.state === 'error' ?
                (
                    <>
                        <div className="err">{status.message}</div>
                        <button className="primary" onClick={props.onSettings}>
                            Open settings
                        </button>
                    </>
                ) :
                (
                    <>
                        <div className="progress-row">
                            <span>{`Step ${status.step} of ${status.steps} - ${status.phase ?? 'Starting…'}${status.total ? ` (${status.done ?? 0} / ${status.total})` : ''}`}</span>
                            <span>{pct}%</span>
                        </div>
                        <div className="progress">
                            <div style={{ width: pct + '%' }} />
                        </div>
                        {
                            /* <div className="progress-row">
            <span>Total{status.steps ? ` — ` : ''}</span>
            <span>{overall}%</span>
          </div> */
                        }
                        <div className="progress total">
                            <div style={{ width: overall + '%' }} />
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{status.gameDir}</div>
                    </>
                )}
        </div>
    );
}
