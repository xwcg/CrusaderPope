import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CastMember, EventPortrait, EventStory, OnActionInfo, PortraitOptions, Rich, ScriptEditRequest, ScriptEditResult, SectionSource, StoryOrigin } from '../../../shared/api';
import { api } from '../api';
import { reportChange } from '../changes';
import { pickStatement } from '../picker/pickStatement';
import { reportEditError, runScriptEdit } from '../scriptEdits';
import { EditCtx } from './editCtx';
import { errorText } from './ModDialogs';
import { LineList, RichText } from './rich';
import '../styles/edit.css';
import { Select } from './Select';

/**
 * Who is who in an event, and what fires it (docs/readable-view.md "Who's who", docs/mods.md "What fires an event"):
 * the card's "Who's who" section — root, the scopes it is given and names, their portraits — and the origins' "＋ When
 * it happens…" (an on_action of the game fires it, always or among its random events).
 */

const POSITIONS: [string, string][] = [
    ['left', 'Left'],
    ['right', 'Right'],
    ['center', 'Center'],
    ['lower_left', 'Lower left'],
    ['lower_center', 'Lower middle'],
    ['lower_right', 'Lower right']
];
const POS_LABEL: Record<string, string> = Object.fromEntries(POSITIONS);

/** Portrait toggles (`= yes`), as the settings line offers them. */
const FLAGS: [string, string, string][] = [
    ['hide_info', 'Hide who it is', 'Only the portrait: no coat of arms, tooltip or click (hide_info)'],
    ['animate_if_dead', 'Animate if dead', 'Animate the portrait even when the character is dead (animate_if_dead)'],
    ['override_imprisonment_visuals', 'No prison look', 'Show them as usual even when imprisoned (override_imprisonment_visuals)'],
    ['remove_default_outfit', 'Only the outfit tags', 'Clothing categories without a matching outfit tag are left out (remove_default_outfit)']
];

const nameLabel = (n: string): string =>
{
    const t = n.replace(/_/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
};

/** "personality_rational" → "Rational", "throne_room_bow_1" → "Throne room bow 1", "camera_event_very_left" → "Very left" */
const animLabel = (n: string): string => nameLabel(n.replace(/^personality_/, '').replace(/^camera_(event_)?/, ''));

/** Into a section (its block, or a new one made where it belongs) — like the sections' "＋ Add". */
function sectionInsert(s: SectionSource, text: string): ScriptEditRequest | undefined
{
    if (s.src)
        return { op: 'insert', at: s.src, where: 'inside', text };

    const at = s.before ?? s.parent;
    return at && { op: 'insert', at, where: s.before ? 'before' : 'inside', wrap: s.key, text };
}

type Kid = EventPortrait['kids'][number];

/** A portrait statement from its settings (as written): `scope` alone stays the short form. */
function portraitBlock(pos: string, kids: Kid[]): string
{
    if (kids.length === 1 && kids[0].key === 'character')
        return `${pos}_portrait = ${kids[0].text.replace(/^character\s*=\s*/, '')}`;

    return `${pos}_portrait = {\n${kids.map((k) => k.text.split('\n').map((l) => '\t' + l).join('\n')).join('\n')}\n}`;
}

/** The settings with `key` set to `text` (its first statement replaced, else added) or, with null, left out. */
function withKid(kids: Kid[], key: string, text: string | null): Kid[]
{
    const i = kids.findIndex((k) => k.key === key);

    if (text === null)
        return kids.filter((k) => k.key !== key);

    if (i >= 0)
        return kids.map((k, j) => (j === i ? { key, text } : k));

    return [...kids, { key, text }];
}

/**
 * Shows `scope` at `pos` (null: no portrait): its statement changed (its settings kept), or a new one after the other
 * portraits. A place someone else has is taken over (their statement becomes this one; the old place of this one goes).
 */
async function setPortrait(story: EventStory, scope: string, pos: string | null): Promise<void>
{
    const cast = story.cast!;
    const mine = cast.portraits.find((p) => p.scope === scope);
    const taken = pos ? cast.portraits.find((p) => p.pos === pos && p !== mine) : undefined;
    const who = scope === 'root' ? 'you' : nameLabel(scope.replace(/^scope:/, ''));

    try
    {
        if (!pos)
        {
            if (mine?.src)
                await runScriptEdit({ op: 'remove', at: mine.src }, `No portrait of ${who}`);

            return;
        }

        const text = portraitBlock(pos, mine?.kids ?? [{ key: 'character', text: `character = ${scope}` }]);
        const what = `${POS_LABEL[pos]} portrait: ${who}`;

        if (taken?.src)
        {
            await runScriptEdit({ op: 'replace', at: taken.src, text }, what);

            if (mine)
            {
                // (the file changed: its anchors are read again)
                const fresh = await api.story(story.key.type, story.key.name);
                const old = fresh && 'cast' in fresh ? fresh.cast?.portraits.find((p) => p.scope === scope && p.pos === mine.pos) : undefined;

                if (old?.src)
                    await runScriptEdit({ op: 'remove', at: old.src }, `${who}: moved to the ${POS_LABEL[pos].toLowerCase()} portrait`);
            }
        }
        else if (mine?.src)
            await runScriptEdit({ op: 'replace', at: mine.src, text }, what);
        else if (cast.portraitAt)
            await runScriptEdit({ op: 'insert', at: cast.portraitAt, text }, what);
        else if (story.src)
            await runScriptEdit({ op: 'insert', at: story.src, where: 'inside', text }, what);
    }
    catch (e)
    {
        reportEditError('Portrait not changed')(e);
    }
}

/** A portrait's statement rewritten with changed settings. */
async function writePortrait(p: EventPortrait, kids: Kid[], what: string): Promise<void>
{
    if (!p.src)
        return;

    await runScriptEdit({ op: 'replace', at: p.src, text: portraitBlock(p.pos, kids) }, what).catch(reportEditError('Portrait not changed'));
}

// (the options, loaded once: the index scans the game's events for them)
let optionsLoad: Promise<PortraitOptions> | null = null;
function usePortraitOptions(): PortraitOptions | null
{
    const [o, setO] = useState<PortraitOptions | null>(null);
    useEffect(() =>
    {
        let alive = true;
        optionsLoad ??= api.portraitOptions();
        void optionsLoad.then((x) => alive && setO(x));
        return () =>
        {
            alive = false;
        };
    }, []);
    return o;
}

const GROUP_ORDER = ['Mood', 'Personality', 'Court & roles', 'Ceremony & feast', 'Weapons & war', 'Horse & hunt', 'Other'];

/** A mood / pose select: the game's animations by group, most used first; scripted animations as `scripted:<key>`. */
function MoodSelect(props: { value: string; options: PortraitOptions; onChange: (v: string) => void; none?: string; title?: string; }): React.JSX.Element
{
    const { options: o } = props;
    const known = props.value && !props.value.startsWith('scripted:') && !o.animations.some((a) => a.name === props.value);
    return (
        <Select className="ww-select" value={props.value} title={props.title} onChange={(e) => props.onChange(e.target.value)}>
            {props.none && <option value="">{props.none}</option>}
            {known && <option value={props.value}>{animLabel(props.value)}</option>}
            {GROUP_ORDER.map((g) => (
                <optgroup key={g} label={g}>
                    {o.animations
                        .filter((a) => a.group === g)
                        .map((a) => (
                            <option key={a.name} value={a.name}>
                                {animLabel(a.name)}
                            </option>
                        ))}
                </optgroup>
            ))}
            {o.scripted.length > 0 && (
                <optgroup label="Scripted (picks by situation)">
                    {o.scripted.map((s) => (
                        <option key={s.name} value={'scripted:' + s.name}>
                            {animLabel(s.name)}
                        </option>
                    ))}
                </optgroup>
            )}
        </Select>
    );
}

/**
 * A shown person's portrait settings (the game's events/_events.info): mood (animation / scripted_animation), camera,
 * outfit tags, the toggles, and "mood when …" (triggered_animation: the first whose condition holds is used).
 */
function PortraitSettings({ p, who, editable }: { p: EventPortrait; who: string; editable: boolean; }): React.JSX.Element | null
{
    const o = usePortraitOptions();
    const [whenMood, setWhenMood] = useState('anger');
    const mood = p.scripted ? 'scripted:' + p.scripted : (p.animation ?? '');

    if (!editable)
    {
        const parts = [mood && `mood: ${animLabel(mood.replace(/^scripted:/, ''))}`, p.camera && `camera: ${animLabel(p.camera)}`, p.outfitTags.length > 0 && `outfit: ${p.outfitTags.join(', ')}`].filter(Boolean);
        return parts.length || p.triggered.length ?
            (
                <div className="ww-note">
                    {parts.join(' · ')}
                    {p.triggered.map((t, i) => (
                        <div key={i}>
                            mood <b>{t.animation ? animLabel(t.animation) : '…'}</b> when <RichText rich={t.when} />
                        </div>
                    ))}
                </div>
            ) :
            null;
    }

    if (!o)
        return <div className="ww-note">…</div>;

    const setMood = (v: string): void =>
    {
        let kids = withKid(withKid(p.kids, 'animation', null), 'scripted_animation', null);

        if (v.startsWith('scripted:'))
            kids = withKid(kids, 'scripted_animation', `scripted_animation = ${v.slice(9)}`);
        else if (v)
            kids = withKid(kids, 'animation', `animation = ${v}`);

        void writePortrait(p, kids, `${who}: ${v ? animLabel(v.replace(/^scripted:/, '')).toLowerCase() : 'no mood'}`);
    };
    const setOutfit = (tags: string[]): void => void writePortrait(p, withKid(p.kids, 'outfit_tags', tags.length ? `outfit_tags = { ${tags.join(' ')} }` : null), `${who}: outfit ${tags.join(', ') || 'as usual'}`);
    const addWhen = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> =>
    {
        const r0 = e.currentTarget.getBoundingClientRect();
        const r = await pickStatement({ kind: 'trigger', scope: 'character', subject: who === 'You' ? undefined : who, title: `${who}: ${animLabel(whenMood).toLowerCase()} when…`, at: { x: r0.left, y: r0.bottom + 4 } });

        if (!r?.text.trim())
            return;

        const cond = r.text.trim()
            .split('\n')
            .map((l) => '\t\t' + l)
            .join('\n');
        const anim = whenMood.startsWith('scripted:') ? `scripted_animation = ${whenMood.slice(9)}` : `animation = ${whenMood}`;
        const text = `triggered_animation = {\n\ttrigger = {\n${cond}\n\t}\n\t${anim}\n}`;
        // (after the other ones: the first whose condition holds is used)
        const last = p.kids.map((k) => k.key).lastIndexOf('triggered_animation');
        const kids = last >= 0 ? [...p.kids.slice(0, last + 1), { key: 'triggered_animation', text }, ...p.kids.slice(last + 1)] : [...p.kids, { key: 'triggered_animation', text }];
        await writePortrait(p, kids, `${who}: ${animLabel(whenMood).toLowerCase()} when ${r.summary ? r.summary.charAt(0).toLowerCase() + r.summary.slice(1) : '…'}`);
    };
    const removeWhen = (i: number): void =>
    {
        let n = -1;
        void writePortrait(p, p.kids.filter((k) => k.key !== 'triggered_animation' || ++n !== i), `${who}: one mood less`);
    };
    return (
        <div className="ww-pset" onClick={(e) => e.stopPropagation()}>
            <div className="ww-pline">
                <label>
                    Mood <MoodSelect value={mood} options={o} none="(the game chooses)" title="Their animation in the portrait (animation / scripted_animation)" onChange={setMood} />
                </label>
                <label>
                    Camera{' '}
                    <Select
                        className="ww-select"
                        value={p.camera ?? ''}
                        title="How the portrait is framed (camera)"
                        onChange={(e) => void writePortrait(p, withKid(p.kids, 'camera', e.target.value ? `camera = ${e.target.value}` : null), `${who}: camera ${e.target.value ? animLabel(e.target.value).toLowerCase() : 'as usual'}`)}>
                        <option value="">As usual</option>
                        {p.camera && !o.cameras.some((c) => c.name === p.camera) && <option value={p.camera}>{animLabel(p.camera)}</option>}
                        {o.cameras.map((c) => (
                            <option key={c.name} value={c.name}>
                                {animLabel(c.name)}
                            </option>
                        ))}
                    </Select>
                </label>
                <label>
                    Outfit {p.outfitTags.map((t) => (
                        <span key={t} className="ww-chip">
                            {nameLabel(t)}
                            <button title="Take this outfit tag off" onClick={() => setOutfit(p.outfitTags.filter((x) => x !== t))}>
                                ✕
                            </button>
                        </span>
                    ))}
                    <Select className="ww-select" value="" title="Clothes for the portrait (outfit_tags): later tags win" onChange={(e) => e.target.value && setOutfit([...p.outfitTags, e.target.value])}>
                        <option value="">{p.outfitTags.length ? '＋' : 'As usual'}</option>
                        {o.outfits
                            .filter((x) => !p.outfitTags.includes(x.name))
                            .map((x) => (
                                <option key={x.name} value={x.name}>
                                    {nameLabel(x.name)}
                                </option>
                            ))}
                    </Select>
                </label>
            </div>
            <div className="ww-pline">
                {FLAGS.map(([key, label, title]) => (
                    <label key={key} title={title} className="ww-flag">
                        <input type="checkbox" checked={p.flags.includes(key)} onChange={(e) => void writePortrait(p, withKid(p.kids, key, e.target.checked ? `${key} = yes` : null), `${who}: ${label.toLowerCase()} ${e.target.checked ? 'on' : 'off'}`)} />
                        {label}
                    </label>
                ))}
            </div>
            {p.shownIf && (
                <div className="ww-note">
                    Shown only if <RichText rich={p.shownIf} />
                </div>
            )}
            {p.triggered.map((t, i) => (
                <div key={i} className="ww-when">
                    Mood <b>{t.animation ? animLabel(t.animation) : '…'}</b> when <RichText rich={t.when} />
                    <button className="ghost small ww-remove" title="Take this mood away" onClick={() => removeWhen(i)}>
                        ✕
                    </button>
                </div>
            ))}
            <div className="ww-pline">
                <MoodSelect value={whenMood} options={o} title="The mood for the condition chosen next" onChange={setWhenMood} />
                <button className="ghost small" title="This mood instead when a condition holds (triggered_animation; the first that holds is used)" onClick={(e) => void addWhen(e)}>
                    ＋ mood when…
                </button>
            </div>
        </div>
    );
}

function CastRow(props: {
    name: string;
    code: string;
    who: Rich;
    tag?: string;
    notes?: string[];
    conditions?: CastMember['conditions'];
    story: EventStory;
    editable: boolean;
    onRemove?: () => void;
}): React.JSX.Element
{
    const { story, editable, code } = props;
    const portrait = story.cast!.portraits.find((p) => p.scope === code);
    const pos = portrait?.pos ?? '';
    return (
        <div className="ww-row">
            <div className="ww-name">
                <span>{props.name}</span>
                <code>{code}</code>
            </div>
            <div className="ww-who">
                <RichText rich={props.who} />
                {props.tag && <span className="ww-tag">{props.tag}</span>}
                {props.notes?.map((n, i) => (
                    <div key={i} className="ww-note">
                        {n}
                    </div>
                ))}
                {props.conditions && (
                    <div className="ww-conds">
                        <span className="ww-note">who fits:</span>
                        <LineList lines={props.conditions} compact />
                    </div>
                )}
                {portrait && <PortraitSettings p={portrait} who={code === 'root' ? 'You' : props.name} editable={editable && !!portrait.src} />}
            </div>
            <div className="ww-side">
                {editable ?
                    (
                        <Select className="ww-portrait" value={pos} title="Where they are shown in the event window" onChange={(e) => void setPortrait(story, code, e.target.value || null)}>
                            <option value="">No portrait</option>
                            {POSITIONS.map(([p, l]) => (
                                <option key={p} value={p}>
                                    {l} portrait
                                </option>
                            ))}
                        </Select>
                    ) :
                    (
                        pos && <span className="ww-note">{POS_LABEL[pos]} portrait</span>
                    )}
                {props.onRemove && (
                    <button className="ghost small ww-remove" title="Forget the name (the statement that gives it goes)" onClick={props.onRemove}>
                        ✕
                    </button>
                )}
            </div>
        </div>
    );
}

/** The event card's "Who's who": root, the scopes it is given, the ones it names ("＋ name someone"), portraits. */
export function WhosWho({ story, editable }: { story: EventStory; editable: boolean; }): React.JSX.Element | null
{
    const ed = useContext(EditCtx);
    const [open, setOpen] = useState(editable);
    const cast = story.cast;

    if (!cast)
        return null;

    const members = cast.given.length + cast.named.length;

    if (!editable && !members && !cast.unknown.length && !cast.rootNotes.length)
        return null;

    const nameSomeone = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> =>
    {
        const r0 = e.currentTarget.getBoundingClientRect();
        const r = await pickStatement({ kind: 'effect', goal: 'name', scope: 'character', title: 'Who’s who', at: { x: r0.left, y: r0.bottom + 4 } });

        if (!r?.text.trim() || !story.sections)
            return;

        const name = /save_(?:temporary_)?scope_as\s*=\s*([\w.]+)/.exec(r.text)?.[1];
        const req = sectionInsert(story.sections.immediate, r.text);

        if (!req)
            return;

        setOpen(true);
        await runScriptEdit(req, `Named: ${name ? `scope:${name}` : 'someone'} (right away)`).catch(reportEditError('Nobody named'));
    };

    return (
        <div className="ev-section whoswho">
            <div className="ev-section-title clickable" onClick={() => setOpen((v) => !v)}>
                {open ? '▾' : '▸'} Who’s who
                {!open && members > 0 && <span className="ww-count">· {members + 1}</span>}
                {editable && story.sections && (
                    <span className="sec-add" onClick={(e) => e.stopPropagation()}>
                        <button className="ghost small" title="Pick someone (your liege, a random courtier who …) and give them a name the event's texts, portraits and effects can use" onClick={(e) => void nameSomeone(e)}>
                            ＋ name someone
                        </button>
                    </span>
                )}
            </div>
            {open && (
                <div className="ww-list">
                    <CastRow
                        name="You"
                        code="root"
                        who={[cast.rootNotes.find((n) => n.of)?.who ?? 'The character who gets the event']}
                        notes={cast.rootNotes.map((n) => (n.of ? `sent by ${n.from} — “they”: ${n.of}` : `${n.from}: ${n.who}`))}
                        conditions={cast.rootNotes.find((n) => n.of && n.conditions)?.conditions}
                        story={story}
                        editable={editable}
                    />
                    {cast.given.map((m) => <CastRow key={'g' + m.name} name={nameLabel(m.name)} code={`scope:${m.name}`} who={m.who} tag={m.from ? `given by ${m.from}` : undefined} conditions={m.conditions} story={story} editable={editable} />)}
                    {cast.named.map((m) => (
                        <CastRow
                            key={'n' + m.name}
                            name={nameLabel(m.name)}
                            code={`scope:${m.name}`}
                            who={m.who}
                            tag={m.temporary ? 'named here, only while it is checked' : 'named here'}
                            conditions={m.conditions}
                            story={story}
                            editable={editable}
                            onRemove={editable && m.src && ed?.can(m.src) ? () => void runScriptEdit({ op: 'remove', at: m.src! }, `Forgot scope:${m.name}`).catch(reportEditError('Not removed')) : undefined}
                        />
                    ))}
                    {cast.unknown.length > 0 && (
                        <div className="ww-unknown">
                            Also used: {cast.unknown.map((u) => <code key={u}>scope:{u}</code>)} — not named here: they must come with what fires the event.
                        </div>
                    )}
                    {editable && !members && <div className="sec-empty">Only you so far. “＋ name someone” picks another character and names them for the texts, portraits and effects.</div>}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// What fires it
// ---------------------------------------------------------------------------

function reportFire(r: ScriptEditResult, text: string): void
{
    reportChange({ kind: 'ok', text, mod: r.mod.name, where: `${r.rel}:${r.line}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
}

/** ✕ on an origin: the active mod stops firing the event from that on_action. */
export async function unfire(story: EventStory, o: StoryOrigin): Promise<void>
{
    try
    {
        reportFire(await api.unfireEvent(story.key.name, o.ref.name), `No longer fired by ${o.label}`);
    }
    catch (e)
    {
        reportEditError('Not changed')(e);
    }
}

/** The origins' "＋ When it happens…": opens the chooser. */
export function WhenButton({ story, label }: { story: EventStory; label?: string; }): React.JSX.Element
{
    const [open, setOpen] = useState(false);
    return (
        <>
            <button className="ghost small origin-add" title="Choose a moment of the game that fires the event (an on_action): every year, when a child is born, at a death …" onClick={() => setOpen(true)}>
                ＋ {label ?? 'When it happens…'}
            </button>
            {open && <WhenChooser story={story} onClose={() => setOpen(false)} />}
        </>
    );
}

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** A scope name for the one an on_action is about, from its documentation ("the newborn child" → child). */
function guessName(o: OnActionInfo): string
{
    const t = `${o.root ?? ''} ${o.summary ?? ''} ${o.label}`.toLowerCase();
    const m = /\b(child(?:hood)?|newborn|baby|heir|ruler|spouse|mother|father|host|owner|vassal|liege|courtier|guest|victim|target|attacker|defender|winner|loser|character)\b/.exec(t);

    if (!m)
        return 'subject';

    return /^(childhood|newborn|baby)$/.test(m[1]) ? 'child' : m[1];
}

/**
 * The on_actions: filter, the ones firing the event first, then the most used; the chosen one's documentation (who
 * root is, the scopes it gives) and "Always" / "Sometimes (weight)".
 */
function WhenChooser({ story, onClose }: { story: EventStory; onClose: () => void; }): React.JSX.Element
{
    const [all, setAll] = useState<OnActionInfo[] | null>(null);
    const [q, setQ] = useState('');
    const [sel, setSel] = useState<OnActionInfo | null>(null);
    const [weight, setWeight] = useState('100');
    // someone of theirs gets it (the picker's script), and the name the one it is about keeps
    const [send, setSend] = useState<{ text: string; summary: string; } | null>(null);
    const [keepAs, setKeepAs] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() =>
    {
        let alive = true;
        void api.onActions(story.key.name).then(
            (l) => alive && setAll(l),
            (e) => alive && setProblem(errorText(e))
        );
        return () =>
        {
            alive = false;
        };
    }, [story.key.name]);

    const shown = useMemo(() =>
    {
        const words = q.toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
        const text = (o: OnActionInfo): string => `${o.name} ${o.label} ${o.summary ?? ''} ${o.root ?? ''}`.toLowerCase();
        return (all ?? [])
            .filter((o) => words.every((w) => text(o).includes(w)))
            .sort((a, b) => Number(!!b.fires) - Number(!!a.fires) || Number(!!b.mod) - Number(!!a.mod) || b.events + b.randomEvents - (a.events + a.randomEvents) || a.label.localeCompare(b.label))
            .slice(0, 300);
    }, [all, q]);

    /** "Someone of theirs…": the picker from the one it is about ("Their father", "A random child" …, "Only those who…"). */
    const chooseWho = async (e: React.MouseEvent<HTMLElement>): Promise<void> =>
    {
        if (!sel)
            return;

        const r0 = e.currentTarget.getBoundingClientRect();
        const r = await pickStatement({ kind: 'effect', goal: 'send', event: story.key.name, scope: 'character', subject: 'them', title: `${sel.label}: who gets the event`, at: { x: r0.left, y: r0.bottom + 4 } });

        if (!r?.text.trim())
            return;

        setSend({ text: r.text, summary: r.summary || r.text });

        if (!keepAs)
            setKeepAs(guessName(sel));
    };

    const fire = async (how: 'always' | 'sometimes'): Promise<void> =>
    {
        if (!sel || busy)
            return;

        setBusy(true);
        setProblem(null);

        try
        {
            const keep = keepAs.trim().replace(/^scope:/, '');
            const r = await api.fireEvent({
                event: story.key.name,
                onAction: sel.name,
                how,
                weight: Number(weight) || 100,
                ...(send ? { send: send.text, keepAs: keep || undefined, about: sel.root ?? `the one ${sel.label} is about` } : {})
            });
            reportFire(r, how === 'always' ? `Fired by ${sel.label}, always` : `Fired by ${sel.label}, sometimes (weight ${Number(weight) || 100})`);
            onClose();
        }
        catch (e)
        {
            setProblem(errorText(e));
        }
        finally
        {
            setBusy(false);
        }
    };

    return (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div
                className="when-chooser"
                onKeyDown={(e) =>
                {
                    if (e.key === 'Escape')
                        onClose();

                    if (e.key === 'Enter' && document.activeElement === input.current && shown[0])
                        setSel(shown[0]);
                }}
            >
                <div className="sc-head">
                    <h3>When does {story.key.name} happen?</h3>
                    <input ref={input} autoFocus value={q} placeholder="Filter: birth, death, yearly, war, marriage…" onChange={(e) => setQ(e.target.value)} />
                    <button onClick={onClose}>Cancel</button>
                </div>
                <div className="wc-body">
                    <div className="wc-list">
                        {!all && !problem && <div className="ne-note">…</div>}
                        {shown.map((o) => (
                            <button key={o.name} className={'wc-item' + (sel?.name === o.name ? ' selected' : '') + (o.fires ? ' fires' : '')} onClick={() => setSel(o)}>
                                <span className="wc-label">
                                    {o.label}
                                    {o.fires && <em>· fires it {o.fires}</em>}
                                    {o.byGame && <span className="wc-game" title="Nothing in script fires it: the game does">· game</span>}
                                </span>
                                <span className="wc-sum">{o.summary ?? o.name}</span>
                                <span className="wc-count">{o.events + o.randomEvents || ''}</span>
                            </button>
                        ))}
                    </div>
                    <div className="wc-detail">
                        {!sel ? <div className="ne-note">Choose a moment on the left. The event then fires whenever the game reaches it — if the event’s own conditions (“Only happens if”) hold.</div> : (
                            <>
                                <h4>
                                    {sel.label} <code>{sel.name}</code>
                                </h4>
                                {sel.summary && <p>{sel.summary}</p>}
                                <div className="wc-field">
                                    <span>You (root) are</span> {sel.root ?? 'not described — usually the character it happens to'}
                                </div>
                                {sel.scopes.length > 0 && (
                                    <div className="wc-field">
                                        <span>It names</span>
                                        <ul>
                                            {sel.scopes.map((s) => (
                                                <li key={s.name}>
                                                    <code>scope:{s.name}</code> {s.who}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                <div className="wc-field">
                                    <span>Now</span> {sel.byGame ? 'fired by the game' : 'fired from script'} · {count(sel.events, 'event')} always, {count(sel.randomEvents, 'random event')}
                                </div>
                                {sel.fires && <div className="ne-problem">It fires this event already ({sel.fires}).</div>}
                                <div className="wc-field wc-who">
                                    <span>Who gets it (becomes “you”)</span>
                                    <label>
                                        <input type="radio" checked={!send} onChange={() => setSend(null)} /> {sel.root ? cap(sel.root) : 'The one it is about'}
                                    </label>
                                    <label>
                                        <input type="radio" checked={!!send} onChange={(e) => void chooseWho(e as unknown as React.MouseEvent<HTMLElement>)} /> Someone of theirs: {send ? <b>{send.summary}</b> : <i>their father, liege, a random child …</i>}{' '}
                                        <button className="ghost small" onClick={(e) => void chooseWho(e)}>
                                            {send ? 'Change…' : 'Choose…'}
                                        </button>
                                    </label>
                                    {send && (
                                        <label className="wc-keep" title="The one the on_action is about, saved for the event: its texts, portraits and conditions can use them">
                                            and keep the one it is about as <code>scope:</code>
                                            <input value={keepAs} placeholder="child" onChange={(e) => setKeepAs(e.target.value.replace(/[^\w]/g, ''))} />
                                        </label>
                                    )}
                                </div>
                                <div className="wc-actions">
                                    <button className="primary" disabled={busy} title="events = { … }: every time, when the event's conditions hold" onClick={() => void fire('always')}>
                                        Always, when it happens
                                    </button>
                                    <span className="wc-or">or</span>
                                    <button disabled={busy} title="random_events = { weight = … }: each time one of its random events is picked, by weight" onClick={() => void fire('sometimes')}>
                                        Sometimes — one of its random events
                                    </button>
                                    <label className="wc-weight" title="How likely among its random events (others use 100 and more)">
                                        weight <input value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d]/g, ''))} />
                                    </label>
                                </div>
                            </>
                        )}
                        {problem && <div className="ne-problem">{problem}</div>}
                    </div>
                </div>
            </div>
        </div>
    );
}
