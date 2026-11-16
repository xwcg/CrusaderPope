import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LineSource, OverrideOption, OverridePlan, OverrideResult } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { modShort, useActiveMod } from '../modStore';
import { type NoticeAction } from '../notices';
import { reportChange } from '../changes';
import { reportEditError, runScriptEdit } from '../scriptEdits';
import { ConfirmDialog, errorText } from './ModDialogs';
import { MODS_ROUTE } from './ModsView';
import { DuplicateEventDialog } from './NewEntry';
import '../styles/edit.css';

import { tr } from '../../../shared/i18n';
/**
 * "Override in the active mod" (docs/mods.md, "Editing the active mod"): a button opening a menu with the two ways to
 * override the entry (copy its winning definition into the mod's overrides file, or replace the whole file holding
 * it), as the main process plans them (the file written, what goes along, why not). Results show as app notices:
 * the explorer re-indexes meanwhile when the mod is loaded.
 */
export function OverrideButton(props: {
    type: string;
    name: string;
    navigate: Navigate;
    compact?: boolean;
    /** the entry's winning definition: when the active mod's own, the menu offers to remove it from the mod */
    own?: LineSource;
    /** that definition's file replaces the game's file of the same path (removing it removes the entry from the game) */
    replacesFile?: boolean;
}): React.JSX.Element
{
    const { type, name, navigate } = props;
    const active = useActiveMod();
    const [menu, setMenu] = useState<{ right: number; top: number; } | null>(null);
    const [dialog, setDialog] = useState<ReactNode>(null);
    const button = useRef<HTMLButtonElement>(null);
    // (the name as it is while it fits the tab row)
    const modLabel = active.mod ? (active.mod.name.length <= 22 ? active.mod.name : modShort(active.mod.name)) : tr('active mod');
    // the definition is the active mod's (loaded) script: it can be removed from the mod again
    const own = props.own && active.mod && active.loaded && props.own.mod?.toLowerCase() === active.mod.id.toLowerCase() && /\.(txt|yml)$/i.test(props.own.rel) ? props.own : undefined;
    const remove = (): void =>
    {
        setMenu(null);

        if (!own || !active.mod)
            return;

        const modName = active.mod.name;
        setDialog(
            <ConfirmDialog
                title={tr('Remove {name} from “{modName}”?', { name, modName })}
                confirm={tr('Remove from the mod')}
                danger
                onClose={() => setDialog(null)}
                onConfirm={() => void runScriptEdit({ op: 'removeDef', at: own }, tr('Removed {name}', { name })).catch(reportEditError(tr('Not removed')))}
            >
                <p>
                    {/.yml$/i.test(own.rel)
                        ? (
                            <>
                                {tr('Removes its line from')}{' '}<code>{own.rel}</code>.{' '}{tr('Undo is in the change bar.')}</>
                        )
                        : (
                            <>
                                {tr('Removes the definition from')}{' '}<code>{own.rel}</code> {' '}{tr('(with the comment lines directly above it and, in an overrides file, its “copied from” note). If it is nested (a faith in its religion), the whole top-level definition holding it goes. Undo is in the change bar.')}</>
                        )}
                </p>
                {props.replacesFile ?
                    (
                        <p className="warn">
                            {tr('This file replaces the game’s file of the same path: without the definition, {name} is gone from the game. To get the game’s version back, delete the mod’s file instead.', { name })}</p>
                    ) :
                    <p>{tr('Afterwards the game’s (or an earlier mod’s) definition applies again.')}</p>}
            </ConfirmDialog>
        );
    };

    const run = async (mode: 'copy' | 'file', overwrite = false): Promise<void> =>
    {
        setMenu(null);

        try
        {
            const r = await api.overrideEntry({ type, name, mode, overwrite });

            if (r.action === 'exists')
            {
                setDialog(
                    <ConfirmDialog title={tr('Replace {rel} in “{name}”?', { rel: r.rel, name: r.mod.name })} confirm={tr('Replace file')} danger onClose={() => setDialog(null)} onConfirm={() => void run('file', true)}>
                        <p>
                            {tr('{name} has', { name: r.mod.name })}{' '}<code>{r.rel}</code> {' '}{tr('already. Replacing it copies the file as the game loads it now over the mod\'s version — changes made there are lost.')}</p>
                    </ConfirmDialog>
                );
                return;
            }

            // (no editor is opened: the change bar says where it went, its location opens it on request)
            report(r, name, navigate);
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: tr('Nothing written'), details: [errorText(e)] });
        }
    };

    return (
        <>
            <button
                ref={button}
                className={'override-btn' + (props.compact ? ' compact' : '') + (active.mod ? '' : ' no-mod')}
                title={active.mod ? tr('Override this entry in the active mod {name}', { name: active.mod.name }) : tr('No active mod — set one on the Mods page (Mods tab)')}
                onClick={(e) =>
                {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu(menu ? null : { right: r.right, top: r.bottom + 4 });
                }}
            >
                ✎ {props.compact ? tr('Override') : tr('Override in {modLabel}', { modLabel })} ▾
            </button>
            {menu &&
                createPortal(
                    <OverrideMenu
                        type={type}
                        name={name}
                        at={menu}
                        anchor={button}
                        run={run}
                        navigate={navigate}
                        onClose={() => setMenu(null)}
                        remove={own ? remove : undefined}
                        duplicate={type === 'events' && active.mod
                            ? () =>
                            {
                                setMenu(null);
                                setDialog(<DuplicateEventDialog source={name} onClose={() => setDialog(null)} onOpen={(t, n) => navigate({ type: t, name: n })} />);
                            }
                            : undefined}
                    />,
                    document.body
                )}
            {dialog}
        </>
    );
}

function OverrideMenu(props: {
    type: string;
    name: string;
    at: { right: number; top: number; };
    /** the button that opened it (a click there toggles the menu) */
    anchor: React.RefObject<HTMLButtonElement | null>;
    run: (mode: 'copy' | 'file') => void;
    navigate: Navigate;
    onClose: () => void;
    /** the definition is the active mod's: remove it from the mod */
    remove?: () => void;
    /** an event: "Duplicate as a new event…" */
    duplicate?: () => void;
}): React.JSX.Element
{
    const { onClose, anchor } = props;
    const [plan, setPlan] = useState<OverridePlan | null>(null);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() =>
    {
        let alive = true;
        api.overridePlan(props.type, props.name).then(
            (p) => alive && setPlan(p),
            (e) => alive && setError(errorText(e))
        );
        return () =>
        {
            alive = false;
        };
    }, [props.type, props.name]);

    useEffect(() =>
    {
        const onDown = (e: MouseEvent): void =>
        {
            const t = e.target as Node;

            if (ref.current && !ref.current.contains(t) && !anchor.current?.contains(t))
                onClose();
        };
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                onClose();
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose, anchor]);

    const width = 420;
    const left = Math.max(8, Math.min(props.at.right - width, window.innerWidth - width - 8));
    const mod = plan?.mod;
    const openMods = (): void =>
    {
        onClose();
        props.navigate({ type: MODS_ROUTE });
    };
    const copyLabel = plan?.copy.open ? tr('Open {name}’s definition', { name: mod?.name }) : plan?.loc ? tr('Copy to {mod}’s replace file', { mod: mod?.name ?? tr('the active mod') }) : plan?.noWinner ? tr('Copy only this one to {mod} — unreliable', { mod: mod?.name ?? tr('the active mod') }) : tr('Copy definition to {mod}', { mod: mod?.name ?? tr('the active mod') });
    const fileLabel = plan?.file.open ? tr('Open {name}’s file', { name: mod?.name }) : tr('Replace the whole file in {mod}', { mod: mod?.name ?? tr('the active mod') });

    return (
        <div className="popover override-menu" ref={ref} style={{ left, top: props.at.top, width }} onMouseDown={(e) => e.stopPropagation()}>
            {error ? <div className="om-head bad">{error}</div> : !plan ? <div className="om-head">{tr('Checking…')}</div> : (
                <>
                    <div className="om-head">
                        {mod ?
                            (
                                <>
                                    {tr('Active mod')}{' '}<b>{mod.name}</b>
                                    {!mod.loaded && <span className="om-warn">{tr('· not in the loaded list')}</span>}
                                </>
                            ) :
                            <span className="om-warn">{tr('No active mod')}</span>}
                    </div>
                    {/* without an active mod: both disabled, and how to set one */}
                    {/* (events, history characters: the reliable ways first (the whole file, a new id), the single copy last) */}
                    {!plan.noWinner && <OptionItem label={copyLabel} option={plan.copy} warn={plan.merging} quiet={!mod} onRun={() => props.run('copy')} />}
                    <OptionItem label={fileLabel} option={plan.file} quiet={!mod} onRun={() => props.run('file')} />
                    {props.duplicate && (
                        <div className="item" onClick={props.duplicate}>
                            <span className="om-label">{tr('Duplicate as a new event…')}</span>
                            <small className="om-note">{tr('A copy under a new id in {mod}, its texts copied too — a template to change freely.', { mod: mod?.name ?? tr('the active mod') })}</small>
                        </div>
                    )}
                    {plan.noWinner && <OptionItem label={copyLabel} option={plan.copy} warn quiet={!mod} onRun={() => props.run('copy')} />}
                    {props.remove && (
                        <div className="item danger" onClick={props.remove}>
                            <span className="om-label">{tr('Remove {name} from {mod}', { name: props.name, mod: mod?.name ?? tr('the active mod') })}</span>
                            <small className="om-note">{tr('The override is not wanted any more: its definition goes from the mod’s file (asks first; undo in the notice).')}</small>
                        </div>
                    )}
                    {!mod ?
                        (
                            <div className="om-foot">
                                <span>{plan.problem}</span>
                                <button onClick={openMods}>{tr('Open the Mods page')}</button>
                            </div>
                        ) :
                        (
                            !mod.loaded && (
                                <div className="om-foot">
                                    <span>{tr('{name} is not in the mod list loaded in the explorer: the file is written, but the explorer does not show the change.', { name: mod.name })}</span>
                                    <button onClick={openMods}>{tr('Open the Mods page')}</button>
                                </div>
                            )
                        )}
                </>
            )}
        </div>
    );
}

/** One way to override: what it does (label), the file it writes or opens, why not, notes. `quiet`: no reason line. */
function OptionItem(props: { label: string; option: OverrideOption; warn?: boolean; quiet?: boolean; onRun: () => void; }): React.JSX.Element
{
    const { option } = props;
    const disabled = !!option.disabled;
    const target = option.open ? `${option.open.rel}${option.open.line ? ':' + option.open.line : ''}` : option.target;
    return (
        <div className={'item' + (disabled ? ' disabled' : '')} onClick={() => !disabled && props.onRun()} title={option.disabled}>
            <span className="om-label">{props.label}</span>
            {target && (
                <small className="om-target">
                    {target}
                    {option.exists && !option.open ? tr(' — the mod has this file (asks before replacing)') : ''}
                </small>
            )}
            {option.disabled && !props.quiet && <small className="om-why">{option.disabled}</small>}
            {option.notes.map((n, i) => (
                <small key={i} className={'om-note' + (props.warn && /merge/i.test(n) ? ' warn' : '')}>
                    {n}
                </small>
            ))}
        </div>
    );
}

/** The change bar after an override: what was written where, what else to know, the Mods page when the mod isn't loaded. */
function report(r: OverrideResult, name: string, navigate: Navigate): void
{
    const where = `${r.rel}${r.line ? ':' + r.line : ''}`;

    if (r.action === 'opened')
    {
        reportChange({ kind: 'info', text: tr('{name} is in {name2} already — edit it here', { name, name2: r.mod.name }), mod: r.mod.name, where, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined });
        return;
    }

    const loaded = r.reindex ? tr('The index takes the file in.') : tr('{name} is not in the loaded mod list: the explorer does not show the change.', { name: r.mod.name });
    reportChange({
        kind: 'ok',
        text: r.action === 'copied' ? tr('Copied {name} to {name2}', { name, name2: r.mod.name }) : tr('Replaced a file in {name}', { name: r.mod.name }),
        mod: r.mod.name,
        where,
        file: r.file,
        line: r.line,
        details: [...r.notes, loaded],
        undo: r.step,
        actions: r.reindex ? undefined : [{ label: tr('Open the Mods page'), run: () => navigate({ type: MODS_ROUTE }) }]
    });
}
