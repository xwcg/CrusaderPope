/**
 * "Fix for <version>…" (docs/mods.md, "Migrating a mod to a newer game version"): a mod written for an older game; the
 * migrations between its version and the game's, what of the mod they concern, and a patch mod made with the fixes
 * (loaded right after the mod; the mod itself stays as it is).
 *
 * Three layers: the top says what this is, what will happen (or happened) and the one thing asked of the reader; below it
 * closed folds per category with a count; inside them the rule labels, file lists and notes (built only when opened).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MigrationPlan, MigrationProgress, MigrationResult, ModInfo } from '../../../shared/api';
import { tr, trn } from '../../../shared/i18n';
import { versionMatches } from '../../../shared/modRules';
import { api } from '../api';
import { Fold } from './Fold';
import { errorText } from './ModDialogs';
import { TaskProgress } from './TaskProgress';

/** "1.20" of "1.20.0.4" */
const majorMinor = (v?: string): string => /^v?(\d+\.\d+)/.exec(v ?? '')?.[1] ?? v ?? '';

/** whether major.minor of `a` is below that of `b`, compared as numbers ("1.9" is below "1.10") */
function olderThan(a?: string, b?: string): boolean
{
    const num = (v?: string): number[] => majorMinor(v).split('.').map((p) => Number(p));
    const [x, y] = [num(a), num(b)];

    if (x.some(Number.isNaN) || y.some(Number.isNaN))
        return false;

    return x[0] !== y[0] ? x[0] < y[0] : (x[1] ?? 0) < (y[1] ?? 0);
}

/** The chip on a mod row: shown for a mod written for an older game version. */
export function MigrateChip(props: { mod: ModInfo; game?: string; disabled?: boolean; }): React.JSX.Element | null
{
    const [open, setOpen] = useState(false);
    const older = versionMatches(props.mod.supportedVersion, props.game) === false && olderThan(props.mod.supportedVersion, props.game);
    // (a wildcard where the version should be: the game loads it, but it says nothing about the game it was written for)
    const unknown = /^v?(\*|\d+\.\*)/i.test(props.mod.supportedVersion?.trim() ?? '');

    if (!(older || unknown) || !props.game)
        return null;

    return (
        <>
            <button className={older ? 'chip accent' : 'chip'} disabled={props.disabled} onClick={() => setOpen(true)} title={older ? tr('Written for {supported}: the changes of the game versions since, fixed in a patch mod', { supported: props.mod.supportedVersion ?? '?' }) : tr('Written for “{supported}”, which names no game version: look for what the game versions changed in it', { supported: props.mod.supportedVersion ?? '?' })}>
                {older ? tr('fix for {version}…', { version: majorMinor(props.game) }) : tr('check for {version}…', { version: majorMinor(props.game) })}
            </button>
            {/* (in the body, not in the mod row: the row is draggable, and a press inside the dialog would start dragging the row) */}
            {open && createPortal(<MigrateDialog mod={props.mod} game={props.game} onClose={() => setOpen(false)} />, document.body)}
        </>
    );
}

type Rule = NonNullable<MigrationPlan['rewrites']>[number];

/** the rule kinds grouped by what a player understands (never by mod) */
type Group = 'layout' | 'interface' | 'assets' | 'added' | 'inert';
const GROUP_OF: Record<Rule['kind'], Group> = {
    rename: 'layout', statements: 'layout', settings: 'layout', rewrite: 'layout', empty: 'layout', gains: 'layout', adds: 'layout', banners: 'layout', restore: 'layout', renamed: 'layout',
    dataCalls: 'interface', guiTypes: 'interface', icons: 'interface',
    mergefx: 'assets', particles: 'assets', ddsLegacy: 'assets', maskMips: 'assets',
    libraries: 'added', merge: 'added', defines: 'added', modelStates: 'added', texts: 'added',
    inert: 'inert'
};

const groupTitle = (g: Group): string =>
    g === 'layout' ? tr('Faiths, religions and other definitions the game laid out differently') :
    g === 'interface' ? tr('Windows and texts') :
    g === 'assets' ? tr('Shaders, particles and textures') :
    g === 'added' ? tr('Definitions the game added that the mod hides') :
    tr('References to things this playset does not have');

const GROUPS: Group[] = ['layout', 'interface', 'assets', 'added', 'inert'];

function ruleSummary(r: Rule, name: string): string
{
    return r.kind === 'restore' ?
        trn('{label} — the game’s own in the patch mod: {n} file (what {name} changed in it is lost until it is updated)', '{label} — the game’s own in the patch mod: {n} files (what {name} changed in them is lost until it is updated)', r.todo.length, { label: r.label, name }) :
        r.kind === 'mergefx' ?
        trn('{label} — the game’s own in the patch mod with {name}’s own effects added: {n} file (what {name} changed in the game’s own code is lost until it is updated)', '{label} — the game’s own in the patch mod with {name}’s own effects added: {n} files (what {name} changed in the game’s own code is lost until it is updated)', r.todo.length, { label: r.label, name }) :
        r.kind === 'empty' ?
        trn('{label} — emptied in the patch mod: {n} file', '{label} — emptied in the patch mod: {n} files', r.todo.length, { label: r.label }) :
        trn('{label} — {n} file', '{label} — {n} files', r.todo.length, { label: r.label });
}

/** the files of some rules, each counted once */
const distinctFiles = (rules: Rule[], of: 'todo' | 'files' = 'todo'): number => new Set(rules.flatMap((r) => r[of])).size;

function RuleList(props: { rules: Rule[]; name: string; }): React.JSX.Element
{
    return (
        <>
            {props.rules.map((r) => (
                <Fold key={r.label} className="fold-rule" title={ruleSummary(r, props.name)}>
                    {() => (
                        <>
                            <ul>{r.todo.map((f) => <li key={f}>{f}</li>)}</ul>
                            {(r.notes?.length ?? 0) > 0 && <ul className="dim">{r.notes!.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                        </>
                    )}
                </Fold>
            ))}
        </>
    );
}

/** the lines about the patch mod and the folders it hides; `urgent`: one of them asks the reader to look */
function patchLines(plan: MigrationPlan, name: string): { lines: React.ReactNode[]; urgent: boolean; }
{
    const lines: React.ReactNode[] = [];
    const found = (key: string, text: React.ReactNode, title?: string): number => lines.push(<div key={key} className="migrate-found" title={title}>{text}</div>);
    const dim = (key: string, text: React.ReactNode, title?: string): number => lines.push(<div key={key} className="dim" title={title}>{text}</div>);
    const game = plan.game ?? '?';
    let urgent = false;

    if (plan.patchMod?.placed === 'before')
        found('before', tr('The patch mod {patch} is loaded before {name}, so it overrides nothing of it. A run moves it right after {name}.', { patch: plan.patchMod.name, name }));

    if ((plan.replacePathsTodo?.length ?? 0) > 0)
        found('rptodo', tr('The patch mod also hides the game’s and earlier mods’ files in {list}: {name} replaces the folders whose content moved there.', { list: plan.replacePathsTodo!.join(', '), name }));
    else if ((plan.replacePaths?.length ?? 0) > 0)
        dim('rp', '✓ ' + tr('The patch mod hides the game’s and earlier mods’ files in {list} already.', { list: plan.replacePaths!.join(', ') }));

    for (const h of plan.replacePathHides ?? [])
        found('hide' + h.folder + h.mod, trn('{n} file of {mod} in {folder} is hidden by it too — load {mod} after the patch mod to keep it.', '{n} files of {mod} in {folder} are hidden by it too — load {mod} after the patch mod to keep them.', h.files, { mod: h.mod, folder: h.folder }));

    if ((plan.replacePathsOwn?.length ?? 0) > 0)
        dim('rpown', trn('The patch mod does not hide {list}: {name} has files of its own directly in it.', 'The patch mod does not hide {list}: {name} has files of its own directly in them.', plan.replacePathsOwn!.length, { list: plan.replacePathsOwn!.join(', '), name }));

    if ((plan.replacePathsShadowed?.length ?? 0) > 0)
        found('rpsh', tr('The patch mod hides {list} although {name} has files of its own directly in them: its religions still hold their faiths, which the fixes write there, and the game’s must not load against them — the files of its own there are hidden too.', { list: plan.replacePathsShadowed!.join(', '), name }));

    if ((plan.replacePathsStale?.length ?? 0) > 0)
    {
        urgent = true;
        found('rpstale', tr('The patch mod hides {list}, which holds files of {name}. Take the replace_path line out of its descriptor.mod and .mod file.', { list: plan.replacePathsStale!.join(', '), name }));
    }

    if (plan.patchMod?.outdated)
    {
        urgent = true;
        found('outdated', plan.patchMod.builtFor ?
            tr('The patch mod {patch} was made for the game {built}; the game is {game} now. Running it again brings the game’s files it carries up to {game} (a file you changed by hand stays).', { patch: plan.patchMod.name, built: plan.patchMod.builtFor, game }) :
            tr('The patch mod {patch} was made before it recorded the game version, and a game file it carries differs from the game’s ({game}). Running it again copies the game’s file again (a file you changed by hand cannot be told from an older game file).', { patch: plan.patchMod.name, game }));
    }

    if (plan.patchMod?.stale)
    {
        const st = plan.patchMod.stale;
        urgent = true;
        found('stale', st.legacy ?
            trn('{name} has {n} file newer than the patch mod’s copy of it (the patch mod was made before it recorded the mod’s files). The mod was updated since, and the copy shadows the update: running it again makes the patch mod’s {all} files again from the mod as it is now (the game’s own files it carries stay, and so does a file changed after its last run).', '{name} has {n} files newer than the patch mod’s copies of them (the patch mod was made before it recorded the mod’s files). The mod was updated since, and the copies shadow the update: running it again makes the patch mod’s {all} files again from the mod as it is now (the game’s own files it carries stay, and so does a file changed after its last run).', st.files.length, { name, n: st.files.length, all: st.reset }) :
            trn('{name} changed {n} file (or dropped it) that the patch mod holds a copy of: the copy shadows the update. Running it again makes the patch mod’s {all} files again from the mod as it is now (a file you changed by hand stays; the game’s own files it carries stay).', '{name} changed {n} files (or dropped them) that the patch mod holds copies of: the copies shadow the update. Running it again makes the patch mod’s {all} files again from the mod as it is now (a file you changed by hand stays; the game’s own files it carries stay).', st.files.length, { name, n: st.files.length, all: st.reset }), st.files.join('\n'));
    }

    const kept = plan.patchMod?.keptStale ?? [];

    if (kept.length > 0)
        dim('kept', trn('{name} changed {n} file you also changed in the patch mod: the patch mod’s copy stays, the update does not reach it.', '{name} changed {n} files you also changed in the patch mod: the patch mod’s copies stay, the update does not reach them.', kept.length, { name }), kept.join('\n'));

    const orphans = plan.patchMod?.orphans ?? [];

    if (orphans.length > 0)
        found('orph', trn('{n} file in the patch mod is not needed any more (no rule asks for it: {name} stopped overriding it, or the game dropped it) — a run deletes it.', '{n} files in the patch mod are not needed any more (no rule asks for them: {name} stopped overriding them, or the game dropped them) — a run deletes them.', orphans.length, { name }), orphans.join('\n'));

    const edited = plan.patchMod?.orphansEdited ?? [];

    if (edited.length > 0)
        dim('orphed', trn('{n} file in the patch mod is not needed any more but was changed by hand — it stays.', '{n} files in the patch mod are not needed any more but were changed by hand — they stay.', edited.length), edited.join('\n'));

    if ((plan.replacePathsGone?.length ?? 0) > 0)
        found('gone', tr('{name} does not replace what {list} belongs to any more: a run takes the folders out of the patch mod’s descriptor.', { name, list: plan.replacePathsGone!.join(', ') }));

    return { lines, urgent: urgent || orphans.length > 0 };
}

/** The plan: the summary and the ask on top, the category folds below. Memoized: progress and status events do not rebuild it. */
const PlanBody = memo(function PlanBody(props: { plan: MigrationPlan; name: string; supported?: string; chosen: string[]; hasResult: boolean; onChoose: (rel: string, on: boolean) => void; }): React.JSX.Element
{
    const { plan, name, chosen } = props;
    const fixes = useMemo(() => plan.findings.filter((f) => f.fix), [plan]);
    const rules = plan.rewrites ?? [];
    const todoRules = useMemo(() => rules.filter((r) => r.todo.length > 0), [rules]);
    const doneRules = useMemo(() => rules.filter((r) => r.todo.length === 0), [rules]);
    const patch = useMemo(() => patchLines(plan, name), [plan, name]);
    const optional = plan.optional ?? [];
    const work = workOf(plan, chosen.length);
    const files = distinctFiles(todoRules);
    const unmapped = plan.unmapped ?? [];
    const leftAlone = (plan.leftAlone?.same.length ?? 0) + (plan.leftAlone?.current.length ?? 0);
    const byKind = new Map<string, number>();
    const typeNames = new Map<string, string>();

    for (const f of fixes)
    {
        byKind.set(f.type, (byKind.get(f.type) ?? 0) + 1);
        typeNames.set(f.type, f.typeLabel ?? f.type.split('/').pop()!);
    }

    if (plan.problem)
        return <div className="save-error">{plan.problem}</div>;

    const nothingElse = !work && optional.length === 0;

    return (
        <>
            {plan.versionUnknown && <div className="migrate-found">{tr('{name} does not say which game it is for (“{supported}”). All the version changes are looked for in it; what the mod does not use is left alone.', { name, supported: props.supported ?? '?' })}</div>}
            {(work || plan.patchMod?.placed) && (
                <div className="migrate-summary">
                    <div className="migrate-heading">{props.hasResult ? tr('Still to do') : tr('What will happen')}</div>
                    <ul>
                        {files > 0 && <li>{trn('{n} file goes into the patch mod', '{n} files go into the patch mod', files)}</li>}
                        {fixes.length > 0 && <li>{trn('{n} entry of {name} is rewritten for the new game version', '{n} entries of {name} are rewritten for the new game version', fixes.length, { name })}</li>}
                        {plan.patchMod?.placed === 'missing' && <li>{tr('The patch mod {patch} is put into the loaded list right after {name} (a list of the app’s own; a launcher playset or the game’s list is copied into one).', { patch: plan.patchMod.name, name })}</li>}
                        {files === 0 && fixes.length === 0 && plan.patchMod?.placed !== 'missing' && <li>{tr('The patch mod is brought up to date.')}</li>}
                    </ul>
                </div>
            )}
            {nothingElse && <div className="migrate-found">{plan.patchMod ? tr('The patch mod has everything done: there is nothing to run again.') : tr('Nothing of the mod is written the old way (for what these migrations know).')}</div>}
            {optional.length > 0 && (
                <div className="migrate-ask">
                    <div className="migrate-heading">{props.hasResult ? tr('Still open: your choice') : tr('Your choice')}</div>
                    <p>{trn('{n} file of {name} may not work in the new game version. You can take the game’s own file instead of it; nothing is taken unless you tick it.', '{n} files of {name} may not work in the new game version. You can take the game’s own file of each instead; nothing is taken unless you tick it.', optional.length, { name })}</p>
                    <p className="dim">{tr('They call things the game removed, or rely on a type or hook the patch mod no longer gives. Taking the game’s file loses the changes the mod made in that file. Hover a row for the details.')}</p>
                    {optional.map((o) => (
                        <label key={o.rel} className="migrate-opt" title={[...o.names, ...o.reasons, ...o.takes.map((t) => tr('{list} would be missing (the copy defines it, other files use it)', { list: t })), ...o.orphans.map((t) => tr('{list} would be used by nothing', { list: t }))].join('\n')}>
                            <input type="checkbox" checked={chosen.includes(o.rel)} onChange={(e) => props.onChoose(o.rel, e.target.checked)} />{' '}
                            {o.rel}
                            {o.custom > 0 && <span className="dim"> · {trn('{n} changed line would be lost', '{n} changed lines would be lost', o.custom)}</span>}
                        </label>
                    ))}
                </div>
            )}
            <div className="migrate-folds">
                {GROUPS.map((g) =>
                {
                    const rs = todoRules.filter((r) => GROUP_OF[r.kind] === g);
                    if (!rs.length)
                        return null;

                    return <Fold key={g} title={groupTitle(g)} count={distinctFiles(rs)}>{() => <RuleList rules={rs} name={name} />}</Fold>;
                })}
                {fixes.length > 0 && (
                    <Fold title={tr('Entries of the mod that get fixed')} count={fixes.length}>
                        {() => (
                            <>
                                <div className="dim">{[...byKind].map(([t, n]) => `${n} ${typeNames.get(t) ?? t.split('/').pop()}`).join(', ')}</div>
                                <ul>{fixes.map((f) => <li key={f.type + f.name} title={f.what.join('\n')}>{f.display} <span className="dim">· {f.rel}</span></li>)}</ul>
                            </>
                        )}
                    </Fold>
                )}
                {patch.lines.length > 0 && <Fold title={tr('The patch mod and the folders it hides')} tone={patch.urgent ? 'warn' : undefined} defaultOpen={patch.urgent}>{() => <>{patch.lines}</>}</Fold>}
                {(plan.notes?.length ?? 0) > 0 && (
                    <Fold title={tr('Notes on definitions the game version moved or split')} count={plan.notes!.length}>
                        {() => <ul className="dim">{plan.notes!.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                    </Fold>
                )}
                {unmapped.length + leftAlone > 0 && (
                    <Fold title={tr('What stays as written')} count={unmapped.length + leftAlone} defaultOpen={!work && unmapped.length > 0}>
                        {() => (
                            <>
                                {unmapped.length > 0 && (
                                    <>
                                        <div>{trn('{n} statement the game version changed cannot be mapped — it stays as written', '{n} statements the game version changed cannot be mapped — they stay as written', unmapped.length)}</div>
                                        <ul className="dim">{unmapped.map((u, i) => <li key={i}>{u}</li>)}</ul>
                                    </>
                                )}
                                {(plan.leftAlone?.same.length ?? 0) > 0 && <div className="dim" title={plan.leftAlone!.same.join('\n')}>{trn('{n} file of {name} is the game’s own file, byte for byte — there is nothing to copy.', '{n} files of {name} are the game’s own files, byte for byte — there is nothing to copy.', plan.leftAlone!.same.length, { name })}</div>}
                                {(plan.leftAlone?.current.length ?? 0) > 0 && <div className="dim" title={plan.leftAlone!.current.join('\n')}>{trn('{n} file of {name} holds the lines of the game’s new file, bar a few it changed, and adds its own — the patch mod leaves it as {name} has it.', '{n} files of {name} hold the lines of the game’s new files, bar a few they changed, and add their own — the patch mod leaves them as {name} has them.', plan.leftAlone!.current.length, { name })}</div>}
                            </>
                        )}
                    </Fold>
                )}
                {doneRules.length > 0 && (
                    <Fold className="migrate-done" title={'✓ ' + tr('Done already in the patch mod')} count={doneRules.length}>
                        {() => <ul>{doneRules.map((r) => <li key={r.label}>✓ {r.label} <span className="dim">· {trn('{n} file', '{n} files', r.files.length)}</span></li>)}</ul>}
                    </Fold>
                )}
                <Fold title={tr('What the game versions changed, and what is not fixed')}>
                    {() => (
                        <>
                            {plan.steps.map((s) => (
                                <div key={s.from + s.to} className="migrate-step">
                                    <div className="migrate-step-title">{s.from} → {s.to} · {s.label}</div>
                                    <ul>{s.changes.map((c) => <li key={c}>{c}</li>)}</ul>
                                </div>
                            ))}
                            {!plan.steps.length && <div className="dim">{tr('No migration is known between these versions yet.')}</div>}
                            <p className="hint">{tr('These migrations cover what the game version changed in a known way: the layout of entries, renamed keys, effects and triggers, the game’s files an older copy breaks, the calls and types of interface and text, effects of shaders, particles and textures. Not fixed: the statements listed above whose values cannot be mapped, a scripted trigger or effect that passes a faith on to a changed statement, interface windows the game rebuilt beyond those calls (the game’s own file can be taken instead), game definitions the mod’s files hide that no loaded file names (on_actions, governments, laws: told in the notes), events of the game’s files the mod replaces that other files still fire, calls of scripted effects and triggers whose arguments do not fit the definition (both told in the notes), and the mod’s own content that depends on them.')}</p>
                        </>
                    )}
                </Fold>
            </div>
        </>
    );
});

/** whether a run has anything to do (the chosen interface files count) */
function workOf(plan: MigrationPlan, chosen: number): boolean
{
    const fixes = plan.findings.some((f) => f.fix);
    const todo = (plan.rewrites ?? []).some((r) => r.todo.length > 0);

    return fixes || !!plan.patchMod?.placed || (plan.replacePathsTodo?.length ?? 0) > 0 || todo || chosen > 0 || !!plan.patchMod?.stale || (plan.patchMod?.orphans?.length ?? 0) > 0 || (plan.replacePathsGone?.length ?? 0) > 0;
}

/** What the run did: the patch mod, the counts, where to look afterwards. */
const ResultBox = memo(function ResultBox(props: { result: MigrationResult; modName: string; userDir?: string; }): React.JSX.Element
{
    const { result } = props;
    const path = props.userDir ? props.userDir.replace(/[\\/]+$/, '') + (props.userDir.includes('/') ? '/logs/' : '\\logs\\') + 'error.log' : tr('error.log in the logs folder of the game’s user folder');

    return (
        <div className="migrate-result">
            <div className="migrate-heading">{result.failed.length ? tr('Done, with failures') : tr('Done')}</div>
            <div>{tr('The patch mod “{name}” ({folder}) is loaded after {mod} in the list “{list}”.', { name: result.patch.name, folder: result.patch.folder, mod: props.modName, list: result.list })}</div>
            <div>
                {result.rewritten.length + result.copied.length + result.fixed.length + result.failed.length === 0
                    ? tr('Nothing needed writing: the patch mod was already up to date.')
                    : <>
                        {trn('{n} file written or taken from the game', '{n} files written or taken from the game', result.rewritten.length + result.copied.length)} · {trn('{n} entry fixed', '{n} entries fixed', result.fixed.length)}
                        {result.failed.length > 0 && ' · ' + trn('{n} failed', '{n} failed', result.failed.length)}
                    </>}
            </div>
            {result.hidden.length > 0 && <div className="dim">{tr('It also hides the game’s files in: {list}', { list: result.hidden.join(', ') })}</div>}
            {result.failed.length > 0 && <ul className="save-error">{result.failed.map((f) => <li key={f.name}>{f.name}: {f.why}</li>)}</ul>}
            <div className="migrate-next">{tr('Next: load that list, start the game and look at its error.log.')}</div>
            <Fold title={tr('What to search for in error.log')}>
                {() => <div className="migrate-next">{tr('Open {path}. Search it for “Unexpected token”, “Failed getting Effect”, “Unknown modifier type”, “does not exist” and “Failed to find”: a line naming a file of {mod} or of the patch mod is a leftover. The shader, particle and texture rules are inferred from the game’s files and not confirmed in a game run.', { path, mod: props.modName })}</div>}
            </Fold>
            {result.notes.length > 0 && (
                <Fold title={tr('Notes from this run')} count={result.notes.length}>
                    {() => <ul className="dim">{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                </Fold>
            )}
        </div>
    );
});

export function MigrateDialog(props: { mod: ModInfo; game?: string; onClose: () => void; }): React.JSX.Element
{
    const [plan, setPlan] = useState<MigrationPlan | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<MigrationResult | null>(null);
    const [progress, setProgress] = useState<MigrationProgress | null>(null);
    const [cancelling, setCancelling] = useState(false);
    // (the interface files the owner takes whole from the game: the plan's optional ones, none by default)
    const [chosen, setChosen] = useState<string[]>([]);
    const game = plan?.game ?? props.game;

    useEffect(() => api.onModsProgress(setProgress), []);

    // (the plan is read again after a run: what the dialog shows as left to do is what the patch mod does not hold now)
    const [refreshing, setRefreshing] = useState(false);
    const [userDir, setUserDir] = useState<string | undefined>(undefined);
    const bodyRef = useRef<HTMLDivElement>(null);

    // (progress, error and result sit at the top of the body: a user who scrolled down in a long plan is taken there when they appear)
    useEffect(() =>
    {
        if (busy || result || error)
            bodyRef.current?.scrollTo({ top: 0 });
    }, [busy, result, error]);

    // (a plan being read: closing the dialog meanwhile stops it (the mods' other tasks wait behind it), mods:cancelTask)
    const reading = useRef(false);

    useEffect(() =>
    {
        let live = true;
        reading.current = true;
        void api.migrationPlan(props.mod.id)
            .then((p) => live && setPlan(p), (e) => live && setError(errorText(e)))
            .finally(() =>
            {
                if (live)
                    reading.current = false;
            });
        return () =>
        {
            live = false;

            if (reading.current)
            {
                reading.current = false;
                void api.cancelModsTask();
            }
        };
    }, [props.mod.id]);

    const onChoose = useCallback((rel: string, on: boolean) => setChosen((c) => on ? (c.includes(rel) ? c : [...c, rel]) : c.filter((x) => x !== rel)), []);

    const run = async (): Promise<void> =>
    {
        setBusy(true);
        setError(null);
        setCancelling(false);
        setProgress(null);

        try
        {
            setResult(await api.migrateMod(props.mod.id, chosen.length ? { restore: chosen } : undefined));
            void api.modsState().then((s) => setUserDir(s.userDirFound ? s.userDir : undefined), () => undefined);
        }
        catch (e)
        {
            setError(errorText(e));
        }
        finally
        {
            setBusy(false);
            setProgress(null);
        }

        // (after an error or a cancel the plan has the counts of what is left; after a run it says what the patch mod holds now)
        setRefreshing(true);
        setChosen([]);
        reading.current = true;

        try
        {
            setPlan(await api.migrationPlan(props.mod.id));
        }
        catch (e)
        {
            // (the result stays; the old plan would be wrong)
            setPlan(null);
            setError((prev) => prev ?? errorText(e));
        }
        finally
        {
            reading.current = false;
            setRefreshing(false);
        }
    };

    const work = !!plan && !plan.problem && workOf(plan, chosen.length);
    const justPut = !!plan?.patchMod?.placed && !plan.findings.some((f) => f.fix) && !(plan.rewrites ?? []).some((r) => r.todo.length > 0);

    return (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && props.onClose()} onDragStart={(e) => e.preventDefault()}>
            <div className="modal migrate-modal">
                <div className="migrate-body" ref={bodyRef}>
                    <h2>{tr('Fix {name} for {version}', { name: props.mod.name, version: majorMinor(game) })}</h2>
                    <p className="hint">{tr('{name} is written for {supported}; the game is {game}. The fixes go into a patch mod loaded right after it — {name} itself stays as its author wrote it.', { name: props.mod.name, supported: props.mod.supportedVersion ?? '?', game: game ?? '?' })}</p>
                    <p className="hint migrate-caveat">{tr('The fix is no guarantee that everything works afterwards — but it gets you a big part of the way there. Check the game’s error.log after loading.')}</p>
                    {busy && <TaskProgress progress={progress} />}
                    {error && <div className="save-error">{error}</div>}
                    {result && <ResultBox result={result} modName={props.mod.name} userDir={userDir} />}
                    {refreshing && result && <div className="dim migrate-refresh">{tr('Checking what is left…')}</div>}
                    {(!plan && !error || refreshing && !result) && <TaskProgress progress={{ stage: refreshing ? tr('Checking what is left…') : tr('Reading the mod…'), done: 0, total: 0 }} />}
                    {plan && !(refreshing && !result) && (
                        <div className={refreshing ? 'migrate-stale' : undefined}>
                            <PlanBody plan={plan} name={props.mod.name} supported={props.mod.supportedVersion} chosen={chosen} hasResult={!!result} onChoose={onChoose} />
                        </div>
                    )}
                </div>
                <div className="actions">
                    <span style={{ flex: 1 }} />
                    {busy ?
                        (
                            <button disabled={cancelling} onClick={() => { setCancelling(true); void api.cancelModsTask(); }}>
                                {cancelling ? tr('Stopping…') : tr('Cancel')}</button>
                        ) :
                        <button onClick={props.onClose}>{result ? tr('Close') : tr('Cancel')}</button>}
                    {(!result || work) && (
                        <button className="primary" disabled={busy || refreshing || !plan || !work} onClick={() => void run()}>
                            {busy ? tr('Fixing…') : justPut ? tr('Put the patch mod into the list') : tr('Make the patch mod')}</button>
                    )}
                </div>
            </div>
        </div>
    );
}
