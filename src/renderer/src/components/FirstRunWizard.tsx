import { useEffect, useState } from 'react';
import type { GraphicsSettings, Settings } from '../../../shared/api';
import { api } from '../api';
import { GRAPHICS_PRESETS, resolveGraphics } from '../graphics';
import { Select } from './Select';

/**
 * The first start (Settings.setupDone false): the Crusader Kings III folders found on this machine (Steam's libraries,
 * the registry, Documents — main detect.ts) to confirm or choose, the language and the graphics quality. Nothing is
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

    useEffect(() =>
    {
        void Promise.all([api.getSettings(), api.detectFolders()]).then(([settings, f]) =>
        {
            setFound(f);
            setS({ ...settings, gameDir: settings.gameDir || f.installs[0] || '', userDir: settings.userDir || f.userDirs[0], graphics: settings.graphics ?? { preset: 'high' } });
        });
        void api.languages().then(setLangs);
    }, []);

    // (whether the chosen folders are the right kind — checked as they change)
    useEffect(() =>
    {
        if (s)
            void api.checkDir('game', s.gameDir).then(setGameOk);
    }, [s?.gameDir]);
    useEffect(() =>
    {
        if (s?.userDir)
            void api.checkDir('user', s.userDir).then(setUserOk);
        else
            setUserOk(null);
    }, [s?.userDir]);

    if (!s || !found)
        return (
            <div className="wizard">
                <div className="wizard-box">Looking for Crusader Kings III…</div>
            </div>
        );

    const start = (): void =>
    {
        setBusy(true);
        void api.setSettings({ gameDir: s.gameDir, userDir: s.userDir, language: s.language, graphics: s.graphics, setupDone: true }).then(props.onDone);
    };

    return (
        <div className="wizard">
            <div className="wizard-box">
                <h1>Welcome to CrusaderPope</h1>
                <p className="wizard-lead">
                    An explorer and mod editor for Crusader Kings III. It reads the game's files — it never changes them — and writes only into the mod you choose to edit.
                </p>

                <section>
                    <h3>1. The game</h3>
                    <p className="hint">
                        The folder Crusader Kings III is installed in: the one that holds the <code>game</code> folder, e.g. <code>…\steamapps\common\Crusader Kings III</code>. In Steam: right-click the game → Manage → Browse local files.
                    </p>
                    {found.installs.map((d) => (
                        <label key={d} className="wizard-choice">
                            <input type="radio" checked={s.gameDir === d} onChange={() => setS({ ...s, gameDir: d })} /> {d} <span className="found">found</span>
                        </label>
                    ))}
                    {!found.installs.length && <p className="wizard-warn">No installation was found automatically — please choose the folder.</p>}
                    <div className="row">
                        <input value={s.gameDir} onChange={(e) => setS({ ...s, gameDir: e.target.value })} spellCheck={false} placeholder="…\steamapps\common\Crusader Kings III" />
                        <button onClick={() => void api.chooseGameDir().then((p) => p && setS({ ...s, gameDir: p }))}>Browse…</button>
                    </div>
                    {gameOk === false && s.gameDir && (
                        <p className="wizard-warn">
                            This folder has no Crusader Kings III game files (no <code>game</code> folder in it).
                        </p>
                    )}
                    {gameOk && <p className="wizard-ok">✓ Crusader Kings III found.</p>}
                </section>

                <section>
                    <h3>2. Your mods and playsets</h3>
                    <p className="hint">
                        The game's user folder, where the launcher keeps mods, playsets and saves: usually <code>…\Documents\Paradox Interactive\Crusader Kings III</code>. It exists once the game has been started once.
                    </p>
                    {found.userDirs.map((d) => (
                        <label key={d} className="wizard-choice">
                            <input type="radio" checked={s.userDir === d} onChange={() => setS({ ...s, userDir: d })} /> {d} <span className="found">found</span>
                        </label>
                    ))}
                    <div className="row">
                        <input value={s.userDir ?? ''} onChange={(e) => setS({ ...s, userDir: e.target.value || undefined })} spellCheck={false} placeholder="…\Documents\Paradox Interactive\Crusader Kings III" />
                        <button onClick={() => void api.chooseUserDir().then((p) => p && setS({ ...s, userDir: p }))}>Browse…</button>
                    </div>
                    {userOk === false && <p className="wizard-warn">No mods, playsets or dlc_load.json in this folder — mods won't be found here. You can change it later in Settings.</p>}
                </section>

                <section>
                    <h3>3. Language and graphics</h3>
                    <div className="row">
                        <label>
                            Content language (the game's texts){' '}
                            <Select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })}>
                                {(langs.length ? langs : [s.language]).map((l) => (
                                    <option key={l} value={l}>
                                        {l.replace(/^l_/, '')}
                                    </option>
                                ))}
                            </Select>
                        </label>
                    </div>
                    <GraphicsPresetChoice value={s.graphics} onChange={(g) => setS({ ...s, graphics: g })} />
                </section>

                <div className="actions">
                    <span className="hint">Everything can be changed later in Settings (⚙ at the top right).</span>
                    <span style={{ flex: 1 }} />
                    <button className="primary" disabled={!gameOk || busy} onClick={start}>
                        Start
                    </button>
                </div>
            </div>
        </div>
    );
}

const PRESET_TEXT: Record<'low' | 'medium' | 'high', string> = {
    low: 'For older or integrated graphics: lower resolution, no edge smoothing, no shadows, no trees and objects on the 3D map.',
    medium: 'Normal resolution with edge smoothing; no shadows.',
    high: 'Full quality: supersampled portraits and models, shadows, all map objects. Needs a strong graphics card.'
};

/** Low / Medium / High (overrides of single values dropped when a preset is chosen). */
export function GraphicsPresetChoice(props: { value: GraphicsSettings | undefined; onChange: (g: GraphicsSettings) => void; }): React.JSX.Element
{
    const preset = props.value?.preset ?? 'high';
    return (
        <div className="graphics-presets">
            {(Object.keys(GRAPHICS_PRESETS) as ('low' | 'medium' | 'high')[]).map((p) => (
                <label key={p} className="wizard-choice">
                    <input type="radio" checked={preset === p} onChange={() => props.onChange({ preset: p })} /> <b>{p[0].toUpperCase() + p.slice(1)}</b> — {PRESET_TEXT[p]}
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
                Render resolution{' '}
                <Select value={g.renderScale} onChange={(e) => set({ renderScale: Number(e.target.value) })}>
                    <option value={0.5}>50%</option>
                    <option value={0.75}>75%</option>
                    <option value={1}>100%</option>
                    <option value={1.5}>150% (supersampled)</option>
                    <option value={2}>200% (supersampled)</option>
                </Select>
            </label>
            <label>
                Texture filtering{' '}
                <Select value={g.anisotropy} onChange={(e) => set({ anisotropy: Number(e.target.value) })}>
                    {[1, 2, 4, 8, 16].map((n) => (
                        <option key={n} value={n}>
                            {n === 1 ? 'basic' : `${n}× anisotropic`}
                        </option>
                    ))}
                </Select>
            </label>
            <label className="check">
                <input type="checkbox" checked={g.antialias} onChange={(e) => set({ antialias: e.target.checked })} /> Edge smoothing (MSAA)
            </label>
            <label className="check">
                <input type="checkbox" checked={g.shadows} onChange={(e) => set({ shadows: e.target.checked })} /> Shadows in portraits and models
            </label>
            <label className="check">
                <input type="checkbox" checked={g.mapObjects} onChange={(e) => set({ mapObjects: e.target.checked })} /> Trees, cliffs and buildings on the 3D map
            </label>
            <span className="hint">Applies to portraits, models and the map opened after saving.</span>
        </div>
    );
}
