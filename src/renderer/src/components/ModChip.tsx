import type { DefOrigin, ModTouch } from '../../../shared/api';
import { CONFLICT_GLYPH, DUPLICATE_GLYPH, STATE_GLYPH, STATE_LABEL, isConflict, leadMod, modColor, modName, modShort, touchHeadline, touchText, useHideRemoved, useLoadedMods, useModFilter, type ModFilterState, type ModState } from '../modStore';
import { formatCount } from './common';
import '../styles/modchips.css';

type ModStyle = React.CSSProperties & { '--mod': string; };

const modStyle = (id: string | undefined): ModStyle => ({ '--mod': id ? modColor(id) : 'var(--text-dim)' });

/**
 * Compact chip for list rows and search results: state glyph + the winning (or removing) mod, short; `+n` more mods
 * (⚔ when they conflict: one replaces the other's change); ⚠ for a duplicate the game keeps no winner for; details on
 * hover.
 */
export function ModChip({ touch }: { touch?: ModTouch; }): React.JSX.Element | null
{
    const mods = useLoadedMods();

    if (!touch)
        return null;

    const lead = leadMod(touch);
    const clash = isConflict(touch) && touch.state !== 'merged';
    return (
        <span className={'mod-chip ' + touch.state + (clash ? ' conflict' : '') + (touch.duplicate ? ' duplicate' : '')} style={modStyle(lead)} title={touchText(touch, mods)}>
            <span className="mod-glyph">{STATE_GLYPH[touch.state]}</span>
            <span className="mod-name">{lead ? modShort(modName(mods, lead)) : 'mod'}</span>
            {touch.mods.length > 1 && (
                <span className="mod-more">
                    {clash ? CONFLICT_GLYPH : '+'}
                    {touch.mods.length - 1}
                </span>
            )}
            {touch.duplicate && <span className="mod-dup">{DUPLICATE_GLYPH}</span>}
        </span>
    );
}

/** Detail header: "Overridden by A Game of Thrones" with a dot per mod involved. */
export function ModBadge({ touch }: { touch?: ModTouch; }): React.JSX.Element | null
{
    const mods = useLoadedMods();

    if (!touch)
        return null;

    return (
        <span className={'mod-badge ' + touch.state + (touch.duplicate ? ' duplicate' : '')} style={modStyle(leadMod(touch))} title={touchText(touch, mods)}>
            <span className="mod-glyph">{STATE_GLYPH[touch.state]}</span>
            {touchHeadline(touch, mods)}
            {touch.duplicate && <span className="mod-dup">{DUPLICATE_GLYPH} duplicate</span>}
            {touch.mods.length > 1 && (
                <span className="mod-dots">
                    {touch.mods.map((id) => <span key={id} className="mod-dot" style={modStyle(id)} />)}
                </span>
            )}
        </span>
    );
}

/** "replaced by A Game of Thrones (same file)" / "removed by … (replace_path)" for a definition in a hidden file. */
export function hiddenByText(origin: DefOrigin): string | undefined
{
    const h = origin.hiddenBy;

    if (!h)
        return undefined;

    return h.how === 'file' ? `replaced by ${h.name} (same file)` : `removed by ${h.name} (replace_path)`;
}

/** Where a definition comes from: Game or the mod's name (only set while mods are loaded). */
export function OriginTag({ origin }: { origin?: DefOrigin; }): React.JSX.Element | null
{
    if (!origin)
        return null;

    return (
        <span className={'origin-tag' + (origin.mod ? ' mod' : '')} style={origin.mod ? modStyle(origin.mod) : undefined} title={origin.mod ? `From the mod ${origin.name}` : 'From the game'}>
            {origin.name}
        </span>
    );
}

/** For a definition in a file a mod hid: which mod, and how. */
export function HiddenNote({ origin }: { origin?: DefOrigin; }): React.JSX.Element | null
{
    const text = origin && hiddenByText(origin);

    if (!text)
        return null;

    return (
        <span className="origin-hidden" style={modStyle(origin!.hiddenBy!.mod)} title="The game with these mods doesn't load this file">
            {text}
        </span>
    );
}

/**
 * Tag on a gallery tile whose file comes from a mod: `+` added / `✎` it replaces the game's file, the mod, `⚔n` when
 * other mods had the file too (the last in load order wins) — or that a mod's replace_path removed (`removed`: "− mod").
 */
export function FileModTag({ mod, touch, removed }: { mod?: string; touch?: ModTouch; removed?: string; }): React.JSX.Element | null
{
    const mods = useLoadedMods();
    const id = removed ?? mod;

    if (!id)
        return null;

    const name = modName(mods, id);
    const clash = !removed && isConflict(touch);
    const title = removed ? `Removed by ${name} (replace_path): the game with the loaded mods doesn't have this file` : touch ? touchText(touch, mods) : `File from the mod ${name}`;
    return (
        <span className={'tile-mod' + (removed ? ' removed' : '') + (clash ? ' conflict' : '')} style={modStyle(id)} title={title}>
            {removed ? '− ' : touch && <span className="mod-glyph">{STATE_GLYPH[touch.state]}</span>}
            {modShort(name)}
            {clash && (
                <span className="mod-more">
                    {CONFLICT_GLYPH}
                    {touch!.mods.length - 1}
                </span>
            )}
        </span>
    );
}

/** The shared "mod content only" toggle; nothing while no mods are loaded. */
export function ModToggle({ label = 'Mods', title }: { label?: string; title?: string; }): React.JSX.Element | null
{
    const mods = useLoadedMods();
    const [filter, setFilter] = useModFilter();

    if (!mods.length)
        return null;

    return (
        <button
            className={'ghost small mod-toggle' + (filter.on ? ' on' : '')}
            title={title ?? `Only what the loaded mods add, change or remove (${mods.map((m) => m.name).join(', ')})`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFilter({ on: !filter.on })}
        >
            {label}
        </button>
    );
}

/**
 * Hides (or shows again) the entries the loaded mods removed — in every list, search and count, remembered. Shown only
 * where there are some (`count`: removed entries of this list).
 */
export function HideRemovedToggle({ count }: { count: number; }): React.JSX.Element | null
{
    const [hide, setHide] = useHideRemoved();

    if (!count)
        return null;

    return (
        <button
            className={'ghost small hide-removed' + (hide ? ' on' : '')}
            title={hide
                ? `${count.toLocaleString()} entries the loaded mods removed are hidden here, in the search and in the counts — click to list them again (struck through)`
                : `Hide the ${count.toLocaleString()} entries the loaded mods removed (a total conversion removes most of the game's) — in every list, the search and the counts; remembered`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setHide(!hide)}
        >
            {hide ? `Show ${formatCount(count)} removed` : `Hide ${formatCount(count)} removed`}
        </button>
    );
}

/** Entries of a list per kind of change, and the conflicts among them (two or more mods touch the entry). */
export type ModStateCounts = Record<ModState | 'conflicts' | 'duplicates', number>;

/** Narrows a list to one kind of change, or to the conflicts, with counts (the sidebar counts the same choice). */
export function ModStateFilter({ counts }: { counts: ModStateCounts; }): React.JSX.Element
{
    const [filter, setFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();
    // ("All" lists what the list shows: without the removed entries while they are hidden)
    const total = counts.added + counts.overridden + counts.same + (hideRemoved ? 0 : counts.removed) + counts.merged;
    // (the chosen one stays visible when this list has none of it)
    const states = (['added', 'overridden', 'same', 'removed', 'merged', 'conflicts', 'duplicates'] as const).filter((s) => counts[s] || filter.state === s);
    const tip = (s: ModFilterState): string =>
        s === 'conflicts'
            ? 'Conflicts: entries two or more of the loaded mods change (the last in load order wins; on_actions merge)'
            : s === 'duplicates'
            ? 'Duplicates: events, history characters or localization keys defined twice in the loaded files — the game takes neither over the other (error.log) and which one it uses is not defined'
            : s === 'same'
            ? 'Same as the game: a mod defines them again, but as the game does (spacing and comments aside) — nothing changes'
            : `${STATE_LABEL[s as ModState]} by the loaded mods`;
    const label = (s: (typeof states)[number]): string => (s === 'conflicts' ? `${CONFLICT_GLYPH} Conflicts` : s === 'duplicates' ? `${DUPLICATE_GLYPH} Duplicates` : STATE_GLYPH[s]);
    return (
        <span className="seg mod-states">
            <button className={filter.state === 'all' ? 'active' : ''} onClick={() => setFilter({ state: 'all' })}>
                All {total.toLocaleString()}
            </button>
            {states.map((s) => (
                <button key={s} className={(filter.state === s ? 'active' : '') + (s === 'conflicts' || s === 'duplicates' ? ' conflicts' : '')} onClick={() => setFilter({ state: s })} title={tip(s)}>
                    {label(s)} {counts[s].toLocaleString()}
                </button>
            ))}
        </span>
    );
}
