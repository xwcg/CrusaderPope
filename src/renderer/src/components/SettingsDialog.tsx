import { useEffect, useState } from 'react';
import { LANGUAGES, locale, tr, trn } from '../../../shared/i18n';
import type { IndexStatus, Settings } from '../../../shared/api';
import { PARSE_THREADS_MAX, PARSE_THREADS_OFF, autoParseThreads } from '../../../shared/parseThreads';
import { changedKeys } from '../../../shared/settingsPatch';
import { INDEX_CACHES_MAX, INDEX_CACHES_MIN, indexCachesKept } from '../../../shared/indexCaches';
import { api } from '../api';
import { errorText } from '../errors';
import { BrowseNote, GraphicsDetails, GraphicsPresetChoice, browseFolder, type Browsing } from './FirstRunWizard';
import { Select } from './Select';
import { CharacterPresetsPage } from './CharacterPresets';
import { ExternalToolsPage } from './ExternalTools';
import type { ScriptDbStatus, ScriptDbUpdateResult } from '../../../shared/scriptFacts';

/** Bytes as MB (GB from 1000 MB on) for the cache's disk line. */
function diskSize(bytes: number): string
{
    const mb = bytes / (1024 * 1024);
    return mb >= 1000 ? tr('{gb} GB', { gb: (mb / 1024).toFixed(1) }) : tr('{mb} MB', { mb: Math.round(mb).toLocaleString() });
}

/** The placeholders of the "Current index" line. */
function indexVars(status: IndexStatus): Record<string, string>
{
    const s = status.stats!;
    return { files: s.files.toLocaleString(), entities: s.entities.toLocaleString(), refs: s.refs.toLocaleString(), locKeys: s.locKeys.toLocaleString(), seconds: (s.ms / 1000).toFixed(1), gameDir: status.gameDir ?? '' };
}

export function SettingsDialog(props: { status: IndexStatus; onClose: () => void; }): React.JSX.Element
{
    const [s, setS] = useState<Settings | null>(null);
    // the settings as loaded: Save sends only what the dialog changed (the rest may have changed elsewhere meanwhile)
    const [orig, setOrig] = useState<Settings | null>(null);
    // why loading or saving failed
    const [problem, setProblem] = useState('');
    const [langs, setLangs] = useState<string[]>([]);
    const [cores, setCores] = useState(0);
    // what the index caches take on disk now (Performance page), null until known
    const [cacheDisk, setCacheDisk] = useState<{ bytes: number; caches: number; } | null>(null);
    // the page shown (the list on the left; a row of tabs on narrow windows)
    const [page, setPage] = useState<'folders' | 'language' | 'graphics' | 'performance' | 'editing' | 'characters' | 'tools' | 'updates'>('folders');
    // the running version (Updates page)
    const [version, setVersion] = useState('');
    // the user folder in effect (configured or detected), shown when none is configured
    const [detectedUserDir, setDetectedUserDir] = useState('');
    // Browse… answers that moved from the folder picked
    const [gameBrowsed, setGameBrowsed] = useState<Browsing | null>(null);
    const [userBrowsed, setUserBrowsed] = useState<Browsing | null>(null);

    useEffect(() =>
    {
        void api.getSettings().then((x) =>
        {
            setS(x);
            setOrig(x);
        }, (e: unknown) => setProblem(errorText(e)));
        void api.languages().then(setLangs);
        void api.cpuCount().then(setCores);
        void api
            .indexCacheDisk()
            .then(setCacheDisk)
            .catch(() => undefined);
        void api.updateInfo().then((u) => setVersion(u.current));
        void api
            .modsState()
            .then((m) => setDetectedUserDir(m.userDir))
            .catch(() => undefined);
        const onKey = (e: KeyboardEvent): void =>
        {
            // (an Escape another overlay took (the folder picker, a dropdown) does not close the settings too; the
            // folder picker's own root is outside the dialog, so its target is not inside it either)
            if (e.key !== 'Escape' || e.defaultPrevented)
                return;

            const t = e.target instanceof Element ? e.target : null;

            if (t && t !== document.body && !t.closest('.settings-modal') && !t.closest('.modal-backdrop'))
                return;

            props.onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // (not loaded yet, or never: the backdrop closes like the dialog)
    if (!s || !orig)
    {
        return (
            <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
                {problem && (
                    <div className="modal settings-modal">
                        <div className="err">{problem}</div>
                        <div className="actions"><button onClick={props.onClose}>{tr('Close')}</button></div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
            <div className="modal settings-modal">
                <h2>{tr('Settings')}</h2>
                <div className="settings-body">
                    <nav className="settings-nav">
                        <button className={page === 'folders' ? 'active' : ''} onClick={() => setPage('folders')}>
                            {tr('Game and folders')}</button>
                        <button className={page === 'language' ? 'active' : ''} onClick={() => setPage('language')}>
                            {tr('Language')}</button>
                        <button className={page === 'graphics' ? 'active' : ''} onClick={() => setPage('graphics')}>
                            {tr('Graphics')}</button>
                        <button className={page === 'performance' ? 'active' : ''} onClick={() => setPage('performance')}>
                            {tr('Performance')}</button>
                        <button className={page === 'editing' ? 'active' : ''} onClick={() => setPage('editing')}>
                            {tr('Editing')}</button>
                        <button className={page === 'characters' ? 'active' : ''} onClick={() => setPage('characters')}>
                            {tr('Characters')}</button>
                        <button className={page === 'tools' ? 'active' : ''} onClick={() => setPage('tools')}>
                            {tr('External tools')}</button>
                        <button className={page === 'updates' ? 'active' : ''} onClick={() => setPage('updates')}>
                            {tr('Updates')}</button>
                    </nav>
                    <div className="settings-page">
                        {page === 'folders' && (
                            <>
                                <div className="field">
                                    <label>{tr('Crusader Kings III installation folder')}</label>
                                    <div className="row">
                                        <input value={s.gameDir} onChange={(e) => setS({ ...s, gameDir: e.target.value })} spellCheck={false} />
                                        <button
                                            onClick={() =>
                                                void browseFolder('game', s.gameDir || undefined, (p) =>
                                                {
                                                    setS({ ...s, gameDir: p });
                                                    setGameBrowsed({ path: p, pending: true });
                                                }).then((b) =>
                                                {
                                                    if (b)
                                                    {
                                                        setS({ ...s, gameDir: b.path });
                                                        setGameBrowsed(b);
                                                    }
                                                })}
                                        >
                                            {tr('Browse…')}</button>
                                    </div>
                                    <BrowseNote browsed={gameBrowsed} now={s.gameDir} what="Crusader Kings III" />
                                    <span className="hint">{tr('The folder that contains game/ (e.g. …\\steamapps\\common\\Crusader Kings III). The game folder itself works too.')}</span>
                                </div>
                                <div className="field">
                                    <label>{tr('Crusader Kings III user folder')}</label>
                                    <div className="row">
                                        <input
                                            value={s.userDir ?? ''}
                                            placeholder={detectedUserDir || tr('detected automatically')}
                                            onChange={(e) => setS({ ...s, userDir: e.target.value || undefined })}
                                            spellCheck={false}
                                        />
                                        <button
                                            onClick={() =>
                                                void browseFolder('user', s.userDir || undefined, (p) =>
                                                {
                                                    setS({ ...s, userDir: p });
                                                    setUserBrowsed({ path: p, pending: true });
                                                }).then((b) =>
                                                {
                                                    if (b)
                                                    {
                                                        setS({ ...s, userDir: b.path });
                                                        setUserBrowsed(b);
                                                    }
                                                })}
                                        >
                                            {tr('Browse…')}</button>
                                    </div>
                                    <BrowseNote browsed={userBrowsed} now={s.userDir} what={tr('the user folder')} />
                                    <span className="hint">
                                        {tr('Where the launcher keeps mods, playsets and dlc_load.json (…\\Documents\\Paradox Interactive\\Crusader Kings III). Leave empty to use the detected folder.')}</span>
                                </div>
                            </>
                        )}
                        {page === 'language' && (
                            <>
                                <div className="field">
                                    <label>{tr('App language')}</label>
                                    <Select value={s.appLanguage ?? 'en'} onChange={(e) => setS({ ...s, appLanguage: e.target.value })} label={tr('App language')}>
                                        {Object.entries(LANGUAGES).map(([code, name]) => (
                                            <option key={code} value={code}>
                                                {name}
                                            </option>
                                        ))}
                                    </Select>
                                    <span className="hint">{tr('The app\'s own menus, buttons and texts — another one restarts the app.')}{Object.keys(LANGUAGES).length < 2 ? tr(' Only English so far.') : ''}</span>
                                </div>
                                <div className="field">
                                    <label>{tr('Content language')}</label>
                                    <Select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })}>
                                        {(langs.includes(s.language) ? langs : [s.language, ...langs]).map((l) => (
                                            <option key={l} value={l}>
                                                {l}
                                            </option>
                                        ))}
                                    </Select>
                                    <span className="hint">{tr('The game\'s texts: names, descriptions, events - as the game shows them in this language.')}</span>
                                </div>
                            </>
                        )}
                        {page === 'graphics' && (
                            <>
                                <div className="field">
                                    <label>{tr('Graphics')}</label>
                                    <GraphicsPresetChoice value={s.graphics} onChange={(g) => setS({ ...s, graphics: g })} />
                                    <GraphicsDetails value={s.graphics} onChange={(g) => setS({ ...s, graphics: g })} />
                                </div>
                            </>
                        )}
                        {page === 'performance' && (
                            <>
                                <div className="field">
                                    <label>{tr('Texture decoding threads')}</label>
                                    <Select value={s.imageWorkers ?? 0} onChange={(e) => setS({ ...s, imageWorkers: Number(e.target.value) })}>
                                        <option value={0}>{tr('Automatic — one per CPU core ({cores})', { cores })}</option>
                                        {Array.from({ length: Math.max(cores, 1) * 2 }, (_, i) => i + 1).map((n) => (
                                            <option key={n} value={n}>
                                                {n}
                                            </option>
                                        ))}
                                    </Select>
                                    <span className="hint">{tr('Images and 3D model textures decode in parallel on this many worker threads. Changing it restarts only the image workers.')}</span>
                                </div>
                                <div className="field">
                                    <label>{tr('Script parsing threads')}</label>
                                    <Select value={s.parseThreads ?? 0} onChange={(e) => setS({ ...s, parseThreads: Number(e.target.value) })}>
                                        <option value={0}>{cores > 0 ? tr('Automatic ({threads})', { threads: autoParseThreads(cores) }) : tr('Automatic')}</option>
                                        <option value={PARSE_THREADS_OFF}>{tr('Off — parse on a single thread')}</option>
                                        {Array.from({ length: PARSE_THREADS_MAX }, (_, i) => i + 1).map((n) => (
                                            <option key={n} value={n}>
                                                {n}
                                            </option>
                                        ))}
                                    </Select>
                                    <span className="hint">{tr('Building the index parses the game\'s script files on this many threads: more threads parse faster, up to about 4 (after that the rest of the build bounds it), and each takes some memory (about 100 MB). Off parses on one thread, slowest and lightest. Takes effect at the next index build.')}</span>
                                </div>
                                <div className="field">
                                    <label className="check">
                                        <input type="checkbox" checked={s.indexCache !== false} onChange={(e) => setS({ ...s, indexCache: e.target.checked })} /> {' '}{tr('Cache the parsed index and compiled shaders')}</label>
                                    <span className="hint">
                                        {tr('Startup loads the index and the game\'s compiled shaders from disk instead of parsing and compiling again. Both are rebuilt by themselves when game files, the language or the app change; "Re-index now" always starts afresh. Off: every start parses and compiles, and the cache files are removed.')}</span>
                                </div>
                                <div className="field">
                                    <label>{tr('Index caches kept')}</label>
                                    <Select
                                        value={indexCachesKept(s.indexCachesKept)}
                                        disabled={s.indexCache === false}
                                        onChange={(e) => setS({ ...s, indexCachesKept: Number(e.target.value) })}
                                        label={tr('Index caches kept')}
                                    >
                                        {Array.from({ length: INDEX_CACHES_MAX - INDEX_CACHES_MIN + 1 }, (_, i) => i + INDEX_CACHES_MIN).map((n) => (
                                            <option key={n} value={n}>
                                                {trn('{n} mod list', '{n} mod lists', n)}
                                            </option>
                                        ))}
                                    </Select>
                                    {cacheDisk && (
                                        <span className="hint" data-testid="index-cache-disk">
                                            {cacheDisk.caches ? trn('The caches use {size} now ({n} mod list).', 'The caches use {size} now ({n} mod lists).', cacheDisk.caches, { size: diskSize(cacheDisk.bytes) }) : tr('No index cache on disk now.')}
                                        </span>
                                    )}
                                    <span className="hint">
                                        {tr('Each mod list (and each place its mods are loaded from) gets a cache of its own, so switching back to a list seen before loads it instead of building again. About 100 to 200 MB each; the least recently used goes first, and caches of another app version or app language are removed at once.')}</span>
                                </div>
                                {props.status.stats && (
                                    <div className="hint">
                                        {(props.status.stats.cached ? tr('Current index: {files} files, {entities} entries, {refs} references, {locKeys} loc keys — loaded from the cache in {seconds}s from {gameDir}', indexVars(props.status)) : tr('Current index: {files} files, {entities} entries, {refs} references, {locKeys} loc keys — built in {seconds}s from {gameDir}', indexVars(props.status)))}
                                    </div>
                                )}
                            </>
                        )}
                        {page === 'editing' && (
                            <>
                                <div className="field">
                                    <label className="check">
                                        <input type="checkbox" checked={s.formatScripts !== false} onChange={(e) => setS({ ...s, formatScripts: e.target.checked })} /> {' '}{tr('Format the mod\'s script files')}</label>
                                    <span className="hint">
                                        {tr('Every change to a script file of the active mod — made here or saved in another editor — is re-indented with tabs, one statement per line, short blocks kept on one line, at most one blank line in a row. Only whitespace changes; a file the formatter can\'t read cleanly (unbalanced braces) stays as it is. Localization files are left alone.')}</span>
                                </div>
                            </>
                        )}
                        {page === 'characters' && <CharacterPresetsPage s={s} setS={setS} />}
                        {page === 'tools' && <ExternalToolsPage />}
                        {page === 'updates' && (
                            <>
                                <div className="field">
                                    <label className="check">
                                        <input type="checkbox" checked={s.updateCheck !== false} onChange={(e) => setS({ ...s, updateCheck: e.target.checked })} /> {' '}{tr('Check for a new version at every start')}</label>
                                    <span className="hint">
                                        {tr('At start the app asks GitHub for the newest release of CrusaderPope')}{version ? tr(' (this is {version})', { version }) : ''}.{' '}{tr('When there is a newer one, a banner under the top bar links to its page - nothing is downloaded or installed by itself.')}</span>
                                </div>
                                {s.updateSkip && (
                                    <div className="field">
                                        <span className="hint">
                                            {tr('Not reminded about version {updateSkip}.', { updateSkip: s.updateSkip })}{' '}<button onClick={() => setS({ ...s, updateSkip: undefined })}>{tr('Remind me again')}</button>
                                        </span>
                                    </div>
                                )}
                                <ScriptDbUpdates on={s.scriptDbUpdates !== false} setOn={(on) => setS({ ...s, scriptDbUpdates: on })} />
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
                        {tr('Re-index now')}</button>
                    {problem && <span className="err">{problem}</span>}
                    <span style={{ flex: 1 }} />
                    <button onClick={props.onClose}>{tr('Cancel')}</button>
                    <button
                        className="primary"
                        onClick={() =>
                            void api
                                .setSettings(changedKeys(s, orig))
                                .then((saved) =>
                                    // (another app language applies at start)
                                    (saved.appLanguage ?? 'en') !== locale() ? api.restartApp() : props.onClose()
                                )
                                .catch((e: unknown) => setProblem(errorText(e)))}
                    >
                        {tr('Save')}</button>
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
            <h2>{tr('Getting ready...')}</h2>
            {status.state === 'error' ?
                (
                    <>
                        <div className="err">{status.message}</div>
                        <button className="primary" onClick={props.onSettings}>
                            {tr('Open settings')}</button>
                    </>
                ) :
                (
                    <>
                        <div className="progress-row">
                            <span>{tr('Step {step} of {steps} - {phase}{progress}', { step: status.step, steps: status.steps, phase: status.phase ?? tr('Starting…'), progress: status.total ? ` (${status.done ?? 0} / ${status.total})` : '' })}</span>
                            <span>{pct}%</span>
                        </div>
                        <div className="progress">
                            <div style={{ width: pct + '%' }} />
                        </div>
                        {
                            /* <div className="progress-row">
            <span>Total{status.steps ? `: ` : ''}</span>
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

/**
 * The script database's updates (docs/script-database.md): the switch, the database in use and "Check now". The
 * explanations and the game's facts the picker and the readable view use come from it.
 */
function ScriptDbUpdates(props: { on: boolean; setOn: (on: boolean) => void; }): React.JSX.Element
{
    const [status, setStatus] = useState<ScriptDbStatus | null>(null);
    const [checking, setChecking] = useState(false);
    const [answer, setAnswer] = useState<ScriptDbUpdateResult | null>(null);

    useEffect(() =>
    {
        void api.scriptDbStatus().then(setStatus).catch(() =>
        {});
    }, []);

    const check = (): void =>
    {
        setChecking(true);
        void api.scriptDbCheckUpdate()
            .then((r) =>
            {
                setAnswer(r);
                return api.scriptDbStatus().then(setStatus);
            })
            .catch((e) => setAnswer({ state: 'error', message: errorText(e) }))
            .finally(() => setChecking(false));
    };

    const built = status?.built ? new Date(status.built).toLocaleDateString(locale()) : '';

    return (
        <div className="field">
            <label className="check">
                <input type="checkbox" checked={props.on} onChange={(e) => props.setOn(e.target.checked)} /> {' '}{tr('Keep the script database up to date')}</label>
            <span className="hint">
                {tr('The explanations of effects, conditions and the rest, and what the game says about where each works, come from a database built from the game’s own documentation. At most once a day the app asks GitHub whether a newer one was published for your game version and, if so, downloads it (a few MB); the database that came with the app stays as the fallback.')}
            </span>
            <span className="hint">
                {status?.game
                    ? tr('In use: game version {game}, built {built}, {source}, {explained} entries explained.', {
                        game: status.game,
                        built,
                        source: status.source === 'downloaded' ? tr('downloaded') : tr('came with the app'),
                        explained: String(status.explained ?? 0)
                    })
                    : tr('No script database in use: the app works with its own tables.')}{' '}
                <button disabled={checking} onClick={check}>{checking ? tr('Checking…') : tr('Check now')}</button>
            </span>
            {(answer ?? status?.last) && <span className="hint">{(answer ?? status?.last)!.message}</span>}
        </div>
    );
}
