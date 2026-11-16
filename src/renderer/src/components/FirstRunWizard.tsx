import { useEffect, useState } from 'react';
import type { BrowsedFolder, GraphicsSettings, Settings } from '../../../shared/api';
import { api } from '../api';
import { errorText } from '../errors';
import { GRAPHICS_PRESETS, resolveGraphics } from '../graphics';
import { Select } from './Select';
import { pickFolder } from './FolderPicker';

import { tr } from '../../../shared/i18n';
/**
 * The first start (Settings.setupDone false): the Crusader Kings III folders found on this machine (Steam's libraries,
 * the registry, Documents; main detect.ts) to confirm or choose, the language and the graphics quality. Nothing is
 * indexed before "Start".
 */
export function FirstRunWizard(props: { onDone: () => void; }): React.JSX.Element
{
    const [s, setS] = useState<Settings | null>(null);
    const [found, setFound] = useState<{ installs: string[]; userDirs: string[]; documents: string; } | null>(null);
    const [gameOk, setGameOk] = useState<boolean | null>(null);
    const [userOk, setUserOk] = useState<boolean | null>(null);
    const [langs, setLangs] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    // why Start failed
    const [problem, setProblem] = useState('');
    // Browse… answers that moved from the folder picked (shown while that folder is still the one set)
    const [gameBrowsed, setGameBrowsed] = useState<Browsing | null>(null);
    const [userBrowsed, setUserBrowsed] = useState<Browsing | null>(null);

    useEffect(() =>
    {
        void Promise.all([api.getSettings(), api.detectFolders()]).then(([settings, f]) =>
        {
            setFound(f);
            setS({ ...settings, gameDir: settings.gameDir || f.installs[0] || '', userDir: settings.userDir || f.userDirs[0], graphics: settings.graphics ?? { preset: 'high' } });
        });
        void api.languages().then(setLangs);
    }, []);

    // (whether the chosen folders are the right kind, checked as they change)
    useEffect(() =>
    {
        // (answers of an older folder are dropped: the folder typed last decides)
        let live = true;

        if (s)
            void api.checkDir('game', s.gameDir).then((ok) => live && setGameOk(ok));

        return () =>
        {
            live = false;
        };
    }, [s?.gameDir]);
    useEffect(() =>
    {
        let live = true;

        if (s?.userDir)
            void api.checkDir('user', s.userDir).then((ok) => live && setUserOk(ok));
        else
            setUserOk(null);

        return () =>
        {
            live = false;
        };
    }, [s?.userDir]);

    if (!s || !found)
        return (
            <div className="wizard">
                <div className="wizard-box">{tr('Looking for Crusader Kings III…')}</div>
            </div>
        );

    const start = (): void =>
    {
        setBusy(true);
        setProblem('');
        void api.setSettings({ gameDir: s.gameDir, userDir: s.userDir, language: s.language, graphics: s.graphics, updateCheck: s.updateCheck !== false, setupDone: true })
            .then(props.onDone)
            .catch((e: unknown) =>
            {
                setBusy(false);
                setProblem(errorText(e));
            });
    };

    return (
        <div className="wizard">
            <div className="wizard-box">
                <h1>{tr('Welcome to CrusaderPope')}</h1>
                <p className="wizard-lead">
                    {tr('An explorer and mod editor for Crusader Kings III. It reads the game\'s files — it never changes them — and writes only into the mod you choose to edit.')}</p>

                <section className="wizard-step">
                    <StepHead n={1} title={tr('The game')} />
                    <p className="hint">
                        {tr('The folder Crusader Kings III is installed in: the one that holds the')}{' '}<code>game</code> {' '}{tr('folder, e.g.')}{' '}<code>…\steamapps\common\Crusader Kings III</code>.{' '}{tr('In Steam: right-click the game → Manage → Browse local files.')}</p>
                    {found.installs.map((d) => (
                        <label key={d} className="wizard-choice">
                            <input type="radio" checked={s.gameDir === d} onChange={() => setS({ ...s, gameDir: d })} /> {d} <span className="found">{tr('found')}</span>
                        </label>
                    ))}
                    {!found.installs.length && <p className="wizard-warn">{tr('No installation was found automatically — please choose the folder.')}</p>}
                    <div className="row">
                        <input value={s.gameDir} onChange={(e) => setS({ ...s, gameDir: e.target.value })} spellCheck={false} placeholder="…\steamapps\common\Crusader Kings III" />
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
                    {gameOk === false && s.gameDir && (
                        <p className="wizard-warn">
                            {tr('This folder has no Crusader Kings III game files (no')}{' '}<code>game</code> {' '}{tr('folder in it).')}</p>
                    )}
                    {gameOk && <p className="wizard-ok">{tr('✓ Crusader Kings III found.')}</p>}
                </section>

                <section className="wizard-step">
                    <StepHead n={2} title={tr('Your mods and playsets')} />
                    <p className="hint">
                        {tr('The game\'s user folder, where the launcher keeps mods, playsets and saves: usually')}{' '}<code>…\Documents\Paradox Interactive\Crusader Kings III</code>.{' '}{tr('It exists once the game has been started once.')}</p>
                    {found.userDirs.map((d) => (
                        <label key={d} className="wizard-choice">
                            <input type="radio" checked={s.userDir === d} onChange={() => setS({ ...s, userDir: d })} /> {d} <span className="found">{tr('found')}</span>
                        </label>
                    ))}
                    <div className="row">
                        <input value={s.userDir ?? ''} onChange={(e) => setS({ ...s, userDir: e.target.value || undefined })} spellCheck={false} placeholder="…\Documents\Paradox Interactive\Crusader Kings III" />
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
                    {userOk === false && <p className="wizard-warn">{tr('No mods, playsets or dlc_load.json in this folder — mods won\'t be found here. You can change it later in Settings.')}</p>}
                </section>

                <section className="wizard-step">
                    <StepHead n={3} title={tr('Language')} />
                    <p className="hint">{tr('The language the game\'s own texts are shown in: names, descriptions, events.')}</p>
                    <div className="row">
                        <Select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })} label={tr('Content language')}>
                            {(langs.length ? langs : [s.language]).map((l) => (
                                <option key={l} value={l}>
                                    {l.replace(/^l_/, '')}
                                </option>
                            ))}
                        </Select>
                    </div>
                </section>

                <section className="wizard-step">
                    <StepHead n={4} title={tr('Graphics')} />
                    <p className="hint">{tr('For the 3D portraits, models and the map. Single values can be fine-tuned later in Settings.')}</p>
                    <GraphicsPresetChoice value={s.graphics} onChange={(g) => setS({ ...s, graphics: g })} />
                </section>

                <section className="wizard-step">
                    <StepHead n={5} title={tr('Updates')} />
                    <label className="wizard-choice wizard-check">
                        <input type="checkbox" checked={s.updateCheck !== false} onChange={(e) => setS({ ...s, updateCheck: e.target.checked })} />
                        <span>
                            {tr('Check for a new version at every start')}<span className="hint">{tr('Asks GitHub for the newest release; a banner says when there is one. Nothing is downloaded by itself.')}</span>
                        </span>
                    </label>
                </section>

                <div className="actions">
                    <span className="hint">{tr('Everything can be changed later in Settings (⚙ at the top right).')}</span>
                    {problem && <span className="err">{problem}</span>}
                    <span style={{ flex: 1 }} />
                    <button className="primary" disabled={!gameOk || busy} onClick={start}>
                        {tr('Start')}</button>
                </div>
            </div>
        </div>
    );
}

/**
 * "You picked X, the game is in the folder below / above it": a Browse… whose folder was not the right one and the one
 * near it is used (main/findNear.ts); shown while that folder is still the one set.
 */
/** A Browse… while the folder near the one picked is looked for (`pending`), then its answer. */
export type Browsing = BrowsedFolder & { pending?: boolean; };

export function BrowseNote(props: { browsed: Browsing | null; now: string | undefined; what: string; }): React.JSX.Element | null
{
    const b = props.browsed;

    if (b?.pending && b.path === props.now)
        return <p className="wizard-note">{tr('Looking for {what} near the folder picked…', { what: props.what })}</p>;

    if (!b?.picked || b.path !== props.now)
        return null;

    const where = b.path.toLowerCase().startsWith(b.picked.toLowerCase()) ? tr('inside it') : tr('above it');
    return (
        <p className="wizard-note">
            {tr('You picked')}{' '}<code>{b.picked}</code> {' '}{tr('— {what} is {where}, so that folder is used.', { what: props.what, where })}</p>
    );
}

/**
 * Browse… for the game or user folder: the in-app picker (FolderPicker.tsx), then the right folder near the one picked
 * (main/findNear.ts).
 */
export async function browseFolder(kind: 'game' | 'user', start: string | undefined, onPicked?: (picked: string) => void): Promise<BrowsedFolder | null>
{
    const picked = await pickFolder(start, kind === 'game' ? tr('The Crusader Kings III installation folder') : tr('The Crusader Kings III user folder'));

    if (!picked)
        return null;

    // (the folder picked shows at once; the search near it takes up to 1.5 s in a folder with huge subfolders)
    onPicked?.(picked);
    return api.nearFolder(kind, picked);
}

/** A step's number and title. */
function StepHead(props: { n: number; title: string; }): React.JSX.Element
{
    return (
        <header className="wizard-step-head">
            <span className="wizard-num">{props.n}</span>
            <h3>{props.title}</h3>
        </header>
    );
}

const PRESET_TEXT: Record<'low' | 'medium' | 'high', string> = {
    low: tr('For older or integrated graphics: lower resolution, no edge smoothing, no shadows, no trees and objects on the 3D map.'),
    medium: tr('Normal resolution with edge smoothing; no shadows.'),
    high: tr('Full quality: supersampled portraits and models, shadows, all map objects. Needs a strong graphics card.')
};

/** Low / Medium / High (overrides of single values dropped when a preset is chosen). */
export function GraphicsPresetChoice(props: { value: GraphicsSettings | undefined; onChange: (g: GraphicsSettings) => void; }): React.JSX.Element
{
    const preset = props.value?.preset ?? 'high';
    return (
        <div className="graphics-presets">
            {(Object.keys(GRAPHICS_PRESETS) as ('low' | 'medium' | 'high')[]).map((p) => (
                <label key={p} className="wizard-choice">
                    <input type="radio" checked={preset === p} onChange={() => props.onChange({ preset: p })} /> <b>{p[0].toUpperCase() + p.slice(1)}</b>: {PRESET_TEXT[p]}
                </label>
            ))}
        </div>
    );
}

/** The single values under the preset (Settings dialog): each overrides the preset's. */
export function GraphicsDetails(props: { value: GraphicsSettings | undefined; onChange: (g: GraphicsSettings) => void; }): React.JSX.Element
{
    const g = resolveGraphics(props.value);
    const set = (patch: GraphicsSettings): void => props.onChange({ ...props.value, ...patch });
    return (
        <div className="graphics-details">
            <label>
                {tr('Render resolution')}{' '}
                <Select value={g.renderScale} onChange={(e) => set({ renderScale: Number(e.target.value) })}>
                    <option value={0.5}>50%</option>
                    <option value={0.75}>75%</option>
                    <option value={1}>100%</option>
                    <option value={1.5}>{tr('150% (supersampled)')}</option>
                    <option value={2}>{tr('200% (supersampled)')}</option>
                </Select>
            </label>
            <label>
                {tr('Texture filtering')}{' '}
                <Select value={g.anisotropy} onChange={(e) => set({ anisotropy: Number(e.target.value) })}>
                    {[1, 2, 4, 8, 16].map((n) => (
                        <option key={n} value={n}>
                            {n === 1 ? 'basic' : tr('{n}× anisotropic', { n })}
                        </option>
                    ))}
                </Select>
            </label>
            <label className="check">
                <input type="checkbox" checked={g.antialias} onChange={(e) => set({ antialias: e.target.checked })} /> {' '}{tr('Edge smoothing (MSAA)')}</label>
            <label className="check">
                <input type="checkbox" checked={g.shadows} onChange={(e) => set({ shadows: e.target.checked })} /> {' '}{tr('Shadows in portraits and models')}</label>
            <label className="check">
                <input type="checkbox" checked={g.mapObjects} onChange={(e) => set({ mapObjects: e.target.checked })} /> {' '}{tr('Trees, cliffs and buildings on the 3D map')}</label>
            <span className="hint">{tr('Applies to portraits, models and the map opened after saving.')}</span>
        </div>
    );
}
