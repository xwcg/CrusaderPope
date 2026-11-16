import { useContext, useEffect, useRef, useState } from 'react';
import { PreviewDateBar } from './PreviewDateBar';
import type { CardSection, EntityCard, EntityKey, EventStory, FollowUp, Line, LineSource, OnActionList, OnActionListKey, OnActionStory, Rich, DescNode, SectionSource, StoryOption, StoryOrigin, UsageSummary } from '../../../shared/api';
import { api } from '../api';
import { useRevision } from '../revision';
import type { Navigate } from '../App';
import { FollowCtx, keywordText, LineList, ReadCtx, RichText } from './rich';
import { EditCtx, anchorKey } from './editCtx';
import { EditBar, addFallback, addListEntry, addListSetting, useInPlaceEditing } from './InPlaceEdit';
import { reportEditError, runScriptEdit } from '../scriptEdits';
import { TypeDot } from './common';
import { GameImg } from '../img';
import { PORTRAIT_TYPES, PortraitViewer } from './PortraitViewer';
import { FamilyTreeView } from './FamilyTreeView';
import { AddSceneButton, SceneButton, SceneList } from './SceneChooser';
import { WhenButton, WhosWho, unfire } from './EventCast';
import { eventTargets, setViewTargets } from '../picker/targets';
import { LocEditable } from './LocEdit';
import { addDescItem, addTextPart, addTextVariant, moveText, removeText } from '../textVariants';
import { TexturePicture, TextureUsers } from './TexturePicture';
import { singular } from './NewEntry';

import { tr, trn } from '../../../shared/i18n';
/** How many levels of follow-up events are expanded automatically. */
const AUTO_DEPTH = 2;

function loadStory(type: string, name: string): Promise<EventStory | OnActionStory | null>
{
    return api.story(type, name);
}

function isEventStory(s: EventStory | OnActionStory): s is EventStory
{
    return 'options' in s;
}

/** The readable view for any entity: event timeline, on_action overview, or tooltip card. */
export function ReadableView(props: { type: string; name: string; navigate: Navigate; }): React.JSX.Element
{
    const [card, setCard] = useState<EntityCard | null | undefined>(undefined);
    const [showHidden, setShowHidden] = useState(() =>
    {
        try
        {
            return localStorage.getItem('showHidden') === '1';
        }
        catch
        {
            return false;
        }
    });
    // an index update: read again (the old card stays until the new one is there)
    const revision = useRevision();
    useEffect(() =>
    {
        let cancelled = false;
        void api.card(props.type, props.name).then((c) =>
        {
            if (!cancelled)
                setCard((old) => (old && c && JSON.stringify(old) === JSON.stringify(c) ? old : c));
        });
        return () =>
        {
            cancelled = true;
        };
    }, [props.type, props.name, revision]);
    const entrySrc = card?.event?.src ?? card?.onAction?.src ?? card?.src;
    const edit = useInPlaceEditing(entrySrc);

    const toggleHidden = (v: boolean): void =>
    {
        setShowHidden(v);

        try
        {
            localStorage.setItem('showHidden', v ? '1' : '0');
        }
        catch
        {
            /* ignore */
        }
    };

    // (the event shown: its scopes are targets in every picker opened on it ("Child is…"); another entry: the saved
    // scopes in reach of its script (an interaction's actor and recipient …))
    useEffect(() =>
    {
        // (known = the list is all the index sees: an event with a cast; another entry when the main process says so
        // (card.targetsKnown: its type's .info names the scopes, or the type is known to come with none; a scripted
        // effect / trigger whose callers were all read within the time budget); known only inside its own definition: a
        // follow-up shown nested has scopes of its own; the saves of the scripted effects it calls, on their lines read
        // inlined only: card.calledSaves, PickTarget.inside)
        setViewTargets([...(card?.event ? eventTargets(card.event) : (card?.targets ?? [])), ...(card?.calledSaves ?? [])], card?.event ? !!card.event.cast : !!card?.targetsKnown, card?.event ? card.event.src : card?.src, card?.event ? 'events' : card?.key.type, card?.event ? card.event.key.name : card?.key.name);
        return () => setViewTargets([]);
    }, [card]);

    if (card === undefined)
        return <div className="read-loading">{tr('Reading the chronicles…')}</div>;

    if (card === null)
        return <div className="read-loading">{tr('Nothing to show.')}</div>;

    return (
        <ReadCtx.Provider value={{ navigate: props.navigate, showHidden }}>
            <EditCtx.Provider value={edit.ctx}>
                {/* (focusable: the keyboard of editing in place, ↑ ↓ Enter Del A Ctrl+Z) */}
                <div className="read-view" ref={edit.ref} tabIndex={edit.ctx ? 0 : undefined} onKeyDown={edit.onKeyDown}>
                    <div className="read-toolbar" style={card.picture ? { display: 'none' } : undefined}>
                        <EditBar src={entrySrc} type={props.type} name={props.name} navigate={props.navigate} />
                        <label title={tr('Flags, variables and effects the player never sees')}>
                            <input type="checkbox" checked={showHidden} onChange={(e) => toggleHidden(e.target.checked)} />
                            {tr('Show behind-the-scenes effects')}</label>
                    </div>
                    {card.event ?
                        (
                            <div className="timeline">
                                <Origins origins={card.event.origins} event={card.event} />
                                <EventNode story={card.event} depth={0} ancestors={[]} />
                            </div>
                        ) :
                        card.onAction ?
                        (
                            <div className="timeline">
                                <Origins origins={card.onAction.origins} />
                                <OnActionNode story={card.onAction} depth={0} ancestors={[]} />
                            </div>
                        ) :
                        <CardView card={card} />}
                </div>
            </EditCtx.Provider>
        </ReadCtx.Provider>
    );
}

// ---------------------------------------------------------------------------
// Origins ("how does this happen?")
// ---------------------------------------------------------------------------

function Origins({ origins, event }: { origins: StoryOrigin[]; event?: EventStory; }): React.JSX.Element
{
    const { navigate } = useContext(ReadCtx);
    const ed = useContext(EditCtx);
    // (an event of the active mod: "＋ When it happens…", ✕ on what the mod's own files fire it from)
    const editable = !!event && !!ed && ed.can(event.src);
    const own = (o: StoryOrigin): boolean => editable && o.ref.type === 'on_action' && !!o.mods?.some((m) => m.toLowerCase() === ed!.mod.id.toLowerCase());
    const [all, setAll] = useState(false);

    if (!origins.length)
        return (
            <div className="origins">
                <span className="origins-label">{editable ? tr('Nothing fires it yet') : tr('Started by the game itself (not fired from script)')}</span>
                {editable && <WhenButton story={event!} />}
            </div>
        );

    const shown = all ? origins : origins.slice(0, 8);
    return (
        <div className="origins">
            <span className="origins-label">{tr('Comes from')}</span>
            {shown.map((o) => (
                <span key={o.ref.type + o.ref.name} className="origin" data-ref-type={o.ref.type} data-ref-name={o.ref.name} onClick={() => navigate(o.ref)}>
                    <TypeDot type={o.ref.type} />
                    {o.label}
                    {o.when && <span className="origin-when">· {o.when}</span>}
                    {own(o) && (
                        <button
                            className="origin-x"
                            title={tr('Stop firing it from {label} ({name}\'s on_action file)', { label: o.label, name: ed!.mod.name })}
                            onClick={(e) =>
                            {
                                e.stopPropagation();
                                void unfire(event!, o);
                            }}
                        >
                            ✕
                        </button>
                    )}
                </span>
            ))}
            {origins.length > 8 && !all && (
                <button className="ghost small" onClick={() => setAll(true)}>
                    {tr('+{more} more', { more: origins.length - 8 })}</button>
            )}
            {editable && <WhenButton story={event!} label={tr('also when…')} />}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Event node
// ---------------------------------------------------------------------------

function Section({ title, children, className, add }: { title: string; children: React.ReactNode; className?: string; add?: React.ReactNode; }): React.JSX.Element | null
{
    if (!children && !add)
        return null;

    return (
        <div className={'ev-section ' + (className ?? '')}>
            <div className="ev-section-title">
                {title}
                {add}
            </div>
            {children}
        </div>
    );
}

/** The first text of a description (a nested event's preview). */
function firstText(n: DescNode | undefined): DescNode | undefined
{
    return !n || n.kind === 'text' ? n : firstText(n.kids?.[0]);
}

/** Editing context of a description: its statement and the event (new keys follow its id), undefined when read only. */
interface DescEdit
{
    story: EventStory;
    at?: EventStory['descSrc'];
}

/**
 * A description as written (DescNode): a text, parts one after another, or versions (the first shown, the others on
 * request), nested as deep as the script nests them. Written in the active mod, every part and version has tools at
 * its right (always there: an empty text is a small target): ↑ ↓ swap it with its neighbour, ✕ removes it (not the
 * only one); containers end with "＋ part" / "＋ part when…" or "＋ version when…" / "＋ version".
 */
function DescView({ node, ed, openAll }: { node: DescNode; ed: DescEdit; openAll?: boolean; }): React.JSX.Element
{
    const edit = useContext(EditCtx);
    // (a version just added from the buttons under the text opens all: `openAll`)
    const [open, setOpen] = useState(!!openAll);
    const { story, at } = ed;

    if (node.kind === 'text')
        return (
            <LocEditable of={story.key} locKey={node.key} editable={!!at} multiline empty={isEmpty(node.text!)}>
                <Prose rich={node.text!} />
            </LocEditable>
        );

    const kids = node.kids!;
    const choice = node.kind !== 'seq';
    const shown = choice && !open ? kids.slice(0, 1) : kids;
    const item = (k: DescNode, i: number): React.ReactNode =>
    {
        const last = (p?: number[]): number | undefined => p?.[p.length - 1];
        const self = last(k.path);
        const prev = last(kids[i - 1]?.path);
        const next = last(kids[i + 1]?.path);
        const parent = node.at;
        const tool = (label: string, glyph: string, run: (() => Promise<void>) | false | undefined): React.ReactNode =>
            run && (
                <button className="ghost small" title={label} onClick={() => void run()}>
                    {glyph}
                </button>
            );
        const tools = at && parent && self !== undefined && (
            <span className="ev2-tools">
                {tool(tr('Up: this {kind} before the one above', { kind: choice ? 'version' : 'part' }), '↑', prev !== undefined && (() => moveText(at, parent, self, prev)))}
                {tool(tr('Down: this {kind} after the one below', { kind: choice ? 'version' : 'part' }), '↓', next !== undefined && (() => moveText(at, parent, self, next)))}
                {tool(tr('Remove this {kind}{allTexts}', { kind: choice ? 'version' : 'part', allTexts: k.kind !== 'text' ? tr(' (all the texts in it)') : '' }), '✕', kids.length > 1 && (() => removeText(at, parent, self)))}
            </span>
        );
        return (
            <div key={i} className={'ev2-item' + (tools ? ' with-tools' : '') + (choice && i > 0 ? ' ev2-variant' : '')}>
                <div className="ev2-item-body">
                    {(k.when || k.otherwise) && (
                        <div className="ev2-when">
                            {/* (its If / Otherwise marked as keywords, as the lines' are) */}
                            <RichText rich={keywordText({ text: k.when ?? [tr('Otherwise:')], icon: 'if' }).text} />
                            {at && edit?.sectionAdd(k.triggerSrc, tr('Text: shown when'), 'condition')}
                        </div>
                    )}
                    <DescView node={k} ed={ed} openAll={openAll} />
                </div>
                {tools}
            </div>
        );
    };
    const add = (label: string, conditional: boolean, title: string): React.ReactNode =>
        at && node.at && (
            <button
                className="ghost small"
                title={title}
                onClick={(e) =>
                {
                    const r = e.currentTarget.getBoundingClientRect();
                    setOpen(true);
                    void addDescItem(at, story.key.name, node.at!, conditional, node.kind === 'first', { x: r.left, y: r.bottom + 4 });
                }}
            >
                {label}
            </button>
        );
    // (the description's own block has the buttons under the text; nested blocks their own)
    const adds = at && node.at && node.at.length > 0 && (
        <div className="ev2-adds">
            {choice ?
                (
                    <>
                        {add(tr('＋ version when…'), true, tr('Another version, chosen when its condition holds (triggered_desc)'))}
                        {node.kind === 'random' && add(tr('＋ version'), false, tr('Another version, always among the random choices'))}
                    </>
                ) :
                (
                    <>
                        {add(tr('＋ part'), false, tr('One more text after these, always shown'))}
                        {add(tr('＋ part when…'), true, tr('One more text after these, shown when its condition holds (triggered_desc)'))}
                    </>
                )}
        </div>
    );

    return (
        <div className={'ev2-' + node.kind}>
            {shown.map(item)}
            {choice && kids.length > 1 && (
                <button className="ghost small" onClick={() => setOpen((v) => !v)}>
                    {open ? tr('Hide other versions') : (node.kind === 'random' ? trn('{n} more random version', '{n} more random versions', kids.length - 1) : trn('{n} more version', '{n} more versions', kids.length - 1))}
                </button>
            )}
            {adds}
        </div>
    );
}

/** "Nothing yet" in an empty section of an entry being edited. */
function Empty({ text }: { text: string; }): React.JSX.Element
{
    return <div className="sec-empty">{text}</div>;
}

function hasVisible(lines: { hidden?: boolean; }[], showHidden: boolean): boolean
{
    return lines.some((l) => showHidden || !l.hidden);
}

function EventNode({ story, depth, ancestors }: { story: EventStory; depth: number; ancestors: string[]; }): React.JSX.Element
{
    const { showHidden, navigate } = useContext(ReadCtx);
    const [showVariants, setShowVariants] = useState(false);
    const [showConds, setShowConds] = useState(depth === 0);
    const path = [...ancestors, story.key.type + ':' + story.key.name];
    const nested = depth > 0;
    // written in the active mod: sections show also when empty, with "＋ Add …"
    const ed = useContext(EditCtx);
    const editable = !!ed && ed.can(story.src);
    const sec = story.sections;
    // (a new option: its name key follows the event's id; the text is the script editor's start)
    const newOption = `option = {\n\tname = ${story.key.name}.${String.fromCharCode(97 + Math.min(25, story.options.length))}\n\t\n}`;

    // (its "Leads to …" lines show their events right under them)
    const follow = (f: FollowUp): React.ReactNode => <FollowUpBranch f={f} depth={depth + 1} ancestors={path} inline />;

    return (
        <FollowCtx.Provider value={follow}>
            <div className={'ev-node' + (nested ? ' nested' : '') + (story.hidden ? ' hidden-event' : '')}>
                <div className="ev-card2">
                    {story.illustration ?
                        (
                            <div className={'ev2-scene' + (nested ? ' small' : '')}>
                                <GameImg path={story.illustration} size={nested ? 640 : 1000} />
                                {editable && !nested && <SceneButton story={story} />}
                            </div>
                        ) :
                        (
                            editable && !nested && (
                                <div className="ev2-scene none">
                                    <SceneButton story={story} />
                                </div>
                            )
                        )}
                    <div className="ev2-head">
                        <div className="ev2-kind">
                            {story.icon && <GameImg path={story.icon} size={22} className="ev2-kind-icon" />}
                            {story.kindLabel}
                            {story.theme && <>· {story.theme}</>}
                            {story.window && (
                                <>
                                    {tr('· window')}{' '}<RichText rich={story.window} />
                                </>
                            )}
                            {story.cooldown && <>{tr('· happens at most once every {cooldown}', { cooldown: story.cooldown })}</>}
                        </div>
                        <div className="ev2-title" title={story.key.name}>
                            {nested ?
                                (
                                    <span className="rt-link" onClick={() => navigate(story.key)}>
                                        <RichText rich={story.title} />
                                    </span>
                                ) :
                                (
                                    <LocEditable of={story.key} locKey={story.titleKey} editable={editable} empty={isEmpty(story.title)}>
                                        <RichText rich={story.title} />
                                    </LocEditable>
                                )}
                        </div>
                        {story.portraits.length > 0 && (
                            <div className="ev2-portraits">
                                {story.portraits.map((p, i) => (
                                    <span key={i} className="portrait-chip">
                                        <RichText rich={p} />
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {!nested && <SceneList story={story} editable={editable} />}
                    {story.desc && (
                        <div className="ev2-desc">
                            {nested ?
                                <Prose rich={firstText(story.desc)?.text ?? []} clamp /> :
                                <DescView key={showVariants ? 1 : 0} node={story.desc} ed={{ story, at: editable ? story.descSrc : undefined }} openAll={showVariants} />}
                        </div>
                    )}
                    {editable && !nested && (
                        <div className="ev2-text-add">
                            {
                                /* a single text (desc = x): another version of it; a text of parts: one more part at its end; the
                                versions of a first_valid / random_valid in it are added with that one's own buttons */
                            }
                            {story.descSrc && (
                                <button
                                    className="ghost small"
                                    title={story.desc?.kind === 'seq' ? tr('One more part at the end of the description, shown when a condition holds (triggered_desc)') : tr('Another version of the description, shown when a condition holds (first_valid / triggered_desc)')}
                                    onClick={(e) =>
                                    {
                                        const r = e.currentTarget.getBoundingClientRect();
                                        const pos = { x: r.left, y: r.bottom + 4 };
                                        setShowVariants(true);

                                        if (story.desc?.kind === 'seq')
                                            void addDescItem(story.descSrc!, story.key.name, [], true, false, pos);
                                        else
                                            void addTextVariant(story.descSrc!, story.key.name, 'desc', pos);
                                    }}
                                >
                                    {story.desc?.kind === 'seq' ? tr('＋ text part when…') : tr('＋ text version when…')}
                                </button>
                            )}
                            {story.descSrc && (
                                <button
                                    className="ghost small"
                                    title="One more part at the end of the description, always shown after the others (desc = { desc = … desc = … })"
                                    onClick={() => void addTextPart(story.descSrc!, story.key.name)}
                                >
                                    {tr('＋ text part')}</button>
                            )}
                            {story.titleSrc && (
                                <button
                                    className="ghost small"
                                    title={tr('Another version of the title, shown when a condition holds')}
                                    onClick={(e) =>
                                    {
                                        const r = e.currentTarget.getBoundingClientRect();
                                        void addTextVariant(story.titleSrc!, story.key.name, 't', { x: r.left, y: r.bottom + 4 });
                                    }}
                                >
                                    {tr('＋ title version when…')}</button>
                            )}
                            <AddSceneButton story={story} />
                        </div>
                    )}

                    {!nested && <WhosWho story={story} editable={editable} />}

                    {(story.conditions.length > 0 || editable) && (
                        <div className="ev-section conditions">
                            <div className="ev-section-title clickable" onClick={() => setShowConds((v) => !v)}>
                                {showConds ? '▾' : '▸'} {' '}{tr('Only happens if')}{editable && ed.sectionAdd(sec?.trigger, tr('Only happens if'), 'condition')}
                            </div>
                            {showConds && (story.conditions.length ? <LineList lines={story.conditions} /> : <Empty text={tr('No conditions: it can always happen.')} />)}
                        </div>
                    )}

                    {/* (its own weight_multiplier: when an on_action's random_events picks one, this changes its weight) */}
                    {story.weight && story.weight.length > 0 && (
                        <Section title={tr('Weight when picked at random')}>
                            <LineList lines={story.weight} />
                        </Section>
                    )}

                    {(hasVisible(story.immediate, showHidden) || editable) && (
                        <Section title={tr('Right away')} add={editable && ed.sectionAdd(sec?.immediate, tr('Right away'), 'effect')}>
                            {/* (only behind-the-scenes lines, a scope saved for the texts: said so, not "nothing happens") */}
                            {hasVisible(story.immediate, showHidden) ? <LineList lines={story.immediate} /> : <Empty text={story.immediate.length ? tr('Nothing the player sees right away; the rest happens behind the scenes (Show behind-the-scenes effects).') : tr('Nothing happens right away.')} />}
                        </Section>
                    )}

                    {(story.options.length > 0 || editable) && (
                        <div className="ev2-options">
                            {story.options.map((o, i) => <OptionView key={i} o={o} depth={depth} path={path} editable={editable} />)}
                            {editable && story.src && <div className="ev2-add-option">{ed.sectionAdd({ src: story.src, key: 'option', kind: 'other' }, tr('New option'), 'option', newOption)}</div>}
                        </div>
                    )}

                    {(hasVisible(story.after, showHidden) || editable) && (
                        <Section title={tr('Afterwards')} add={editable && ed.sectionAdd(sec?.after, 'Afterwards', 'effect')}>
                            {hasVisible(story.after, showHidden) ? <LineList lines={story.after} /> : <Empty text={tr('Nothing afterwards.')} />}
                        </Section>
                    )}
                </div>
                <FollowUps items={story.immediateFollowUps} lines={story.immediate} depth={depth} ancestors={path} label={tr('Right away this also leads to')} />
                <FollowUps items={story.afterFollowUps} lines={story.after} depth={depth} ancestors={path} label={tr('Afterwards')} />
            </div>
        </FollowCtx.Provider>
    );
}

/** One option: its text (a row of its own when edited: ✎ the whole option, ✕, ＋ inside), conditions, effects, branches. */
function OptionView({ o, depth, path, editable }: { o: StoryOption; depth: number; path: string[]; editable: boolean; }): React.JSX.Element
{
    const ed = useContext(EditCtx);
    const key = editable && ed && o.src && ed.can(o.src) ? anchorKey(o.src) : undefined;
    const title = o.text.map((s) => (typeof s === 'string' ? s : s.text)).join('');
    return (
        <div className="ev2-option">
            <div
                className={'ev2-option-text' + (key ? ' editable' : '') + (key && ed!.selected === key ? ' selected' : '')}
                data-anchor={key}
                onClick={key ? () => ed!.select(key) : undefined}
            >
                <LocEditable of={path.length ? toKey(path[path.length - 1]) : undefined} locKey={o.nameKey} editable={!!key} empty={isEmpty(o.text)}>
                    <RichText rich={o.text} />
                </LocEditable>
                {key && ed!.actions(o.src!)}
            </div>
            {key && ed!.editor(key)}
            {(o.conditions.length > 0 || key) && (
                <div className="ev2-option-req">
                    <span className="req-label">{tr('Only if')}</span>
                    <div className="req-body">
                        {o.conditions.length ? <LineList lines={o.conditions} compact /> : <span className="sec-empty inline">{tr('always available')}</span>}
                        {key && ed!.sectionAdd(o.trigger, tr('Only if ({title})', { title }), 'condition')}
                    </div>
                </div>
            )}
            <LineList lines={o.effects} />
            {key && <div className="ev2-option-add">{ed!.sectionAdd({ src: o.src, key: 'option', kind: 'effect' }, tr('Option: {title}', { title }), 'effect')}</div>}
            <FollowUps items={o.followUps} lines={o.effects} depth={depth} ancestors={path} />
        </div>
    );
}

/** "events:court.8190" (a path entry) → its key */
function toKey(p: string): EntityKey
{
    const i = p.indexOf(':');
    return { type: p.slice(0, i), name: p.slice(i + 1) };
}

/** A text with nothing to read (an empty localization). */
function isEmpty(r: Rich): boolean
{
    return !r.some((s) => (typeof s === 'string' ? s : s.text).trim());
}

function Prose({ rich, clamp }: { rich: Rich; clamp?: boolean; }): React.JSX.Element
{
    const [open, setOpen] = useState(!clamp);
    const text = rich.map((s) => (typeof s === 'string' ? s : s.text)).join('');
    const long = text.length > 320;
    return (
        <div className={'prose' + (!open && long ? ' clamped' : '')} onClick={!open && long ? () => setOpen(true) : undefined}>
            <RichText rich={rich} />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Follow-ups (the branching timeline)
// ---------------------------------------------------------------------------

/**
 * Merges follow-ups to the same target (e.g. the same event fired from several if-branches, or a scripted effect
 * used several times): identical paths once, different ones joined with "or"; any unconditional path wins.
 */
function mergeFollowUps(items: FollowUp[]): FollowUp[]
{
    const m = new Map<string, { f: FollowUp; alts: Rich[]; seen: Set<string>; always: boolean; }>();

    for (const f of items)
    {
        const k = f.target.type + ':' + f.target.name + ':' + (f.who ?? '');
        let e = m.get(k);

        if (!e)
            m.set(k, e = { f, alts: [], seen: new Set(), always: false });

        if (!f.when.length)
        {
            e.always = true;
            continue;
        }

        const alt = joinAlternatives(f.when);
        const text = alt.map((s) => (typeof s === 'string' ? s : s.text)).join('');

        if (!e.seen.has(text))
        {
            e.seen.add(text);
            e.alts.push(alt);
        }
    }

    return [...m.values()].map(({ f, alts, always }) => ({
        ...f,
        when: always || !alts.length ? [] : [alts.flatMap((a, i) => (i ? [' or ', ...a] : a))]
    }));
}

function joinAlternatives(w: Rich[]): Rich
{
    const out: Rich = [];
    w.forEach((r, i) =>
    {
        if (i)
            out.push(', ');

        out.push(...r);
    });
    return out;
}

/** A follow-up's identity (one per event and whose it is). */
const followKey = (f: FollowUp): string => f.target.type + ':' + f.target.name + ':' + (f.who ?? '');

/** The follow-ups the lines show themselves (under their "Leads to …" line): those of lines one can see. */
function inlineFollowUps(lines: Line[], showHidden: boolean): Set<string>
{
    const out = new Set<string>();
    const walk = (ls: Line[]): void =>
    {
        for (const l of ls)
        {
            if (!showHidden && l.hidden)
                continue;

            if (l.followUp)
                out.add(followKey(l.followUp));

            if (l.children)
                walk(l.children);
        }
    };
    walk(lines);
    return out;
}

/**
 * Follow-ups not shown under a line (`lines`: the lines that show theirs): a "Leads to …" among the behind-the-scenes
 * effects while those are hidden …
 */
function FollowUps({ items, lines, depth, ancestors, label }: { items: FollowUp[]; lines?: Line[]; depth: number; ancestors: string[]; label?: string; }): React.JSX.Element | null
{
    const { showHidden } = useContext(ReadCtx);
    const inline = lines ? inlineFollowUps(lines, showHidden) : null;
    const merged = mergeFollowUps(inline ? items.filter((f) => !inline.has(followKey(f))) : items);

    if (!merged.length)
        return null;

    return (
        <div className="followups">
            {label && <div className="followups-label">{label}</div>}
            {merged.map((f, i) => <FollowUpBranch key={i} f={f} depth={depth + 1} ancestors={ancestors} />)}
        </div>
    );
}

/**
 * The event a trigger_event leads to: its card, loaded when opened; ▾ / ▸ folds it. `inline`: right under its
 * "Leads to …" line, which says already when, for whom and under which conditions.
 */
function FollowUpBranch({ f, depth, ancestors, inline }: { f: FollowUp; depth: number; ancestors: string[]; inline?: boolean; }): React.JSX.Element
{
    const { navigate } = useContext(ReadCtx);
    const key = f.target.type + ':' + f.target.name;
    const loop = ancestors.includes(key);
    const isOnAction = f.target.type === 'on_action';
    const [open, setOpen] = useState(!loop && !isOnAction && depth <= AUTO_DEPTH);
    const [story, setStory] = useState<EventStory | OnActionStory | null | undefined>(undefined);
    // loaded on opening, again after an index update while open
    const revision = useRevision();
    const loadedAt = useRef(-1);

    useEffect(() =>
    {
        if (!open || (story !== undefined && loadedAt.current === revision))
            return;

        let cancelled = false;
        void loadStory(f.target.type, f.target.name).then((s) =>
        {
            if (cancelled)
                return;

            loadedAt.current = revision;
            setStory((old) => (old && s && JSON.stringify(old) === JSON.stringify(s) ? old : s));
        });
        return () =>
        {
            cancelled = true;
        };
    }, [open, story, revision, f.target.type, f.target.name]);

    return (
        <div className={'branch' + (f.hidden ? ' behind' : '') + (inline ? ' inline' : '')}>
            {!loop && (open || !inline) && (
                <div className="branch-connector clickable" title={open ? tr('Fold the event') : tr('Show the event')} onClick={() => setOpen((o) => !o)}>
                    <span className="branch-arrow">{open ? '▾' : '▸'}</span>
                    <span className="branch-meta">
                        {!inline && f.delay && <span className="branch-chip">{f.delay}</span>}
                        {!inline && f.who && <span className="branch-chip who">{tr('for {who}', { who: f.who })}</span>}
                        {open && <span className="branch-fold">{f.label}</span>}
                    </span>
                </div>
            )}
            {loop ?
                (
                    <div className="branch-loop" onClick={() => navigate(f.target)} data-ref-type={f.target.type} data-ref-name={f.target.name}>
                        {tr('↺ Loops back to')}{' '}<b>{f.label}</b>
                    </div>
                ) :
                !open ?
                (
                    <div className="branch-collapsed" onClick={() => setOpen(true)} data-ref-type={f.target.type} data-ref-name={f.target.name}>
                        {inline ? <span className="branch-arrow">▸</span> : <TypeDot type={f.target.type} />}
                        <span className="branch-title">{isOnAction ? tr('Something from “{label}”', { label: f.label }) : f.label}</span>
                        <span className="branch-expand">{tr('show what happens')}</span>
                    </div>
                ) :
                story === undefined ?
                <div className="branch-collapsed">{tr('Loading…')}</div> :
                story === null ?
                <div className="branch-collapsed">{tr('{label} (not found)', { label: f.label })}</div> :
                isEventStory(story) ?
                <EventNode story={story} depth={depth} ancestors={ancestors} /> :
                <OnActionNode story={story} depth={depth} ancestors={ancestors} />}
        </div>
    );
}

// ---------------------------------------------------------------------------
// on_action node
// ---------------------------------------------------------------------------

function OnActionNode({ story, depth, ancestors }: { story: OnActionStory; depth: number; ancestors: string[]; }): React.JSX.Element
{
    const { navigate } = useContext(ReadCtx);
    const path = [...ancestors, story.key.type + ':' + story.key.name];
    const nested = depth > 0;
    // written in the active mod (the shown one, not a follow-up): every section shows, with "＋ …"
    const ed = useContext(EditCtx);
    const editable = !nested && !!ed && ed.can(story.src);
    const sec = editable ? story.sections : undefined;
    const below = (e: React.MouseEvent<HTMLElement>): { x: number; y: number; } =>
    {
        const r = e.currentTarget.getBoundingClientRect();
        return { x: r.left, y: r.bottom + 4 };
    };
    const addEntry = (s: SectionSource | undefined, field: 'event' | 'on_action', weighted: boolean, title: string, label: string, before?: LineSource): React.ReactNode =>
        s && (
            <button
                className="ghost small pool-add"
                title={`${title} (${s.key}${weighted ? ': 100 = ‹id›' : ''})`}
                onClick={(e) => void addListEntry(s, field, weighted, title, below(e), before)}
            >
                ＋ {label}
            </button>
        );
    // (a list's own delay and chances, at its start; only for a list that is written: a missing one is made by its first entry)
    const setting = (s: SectionSource | undefined, list: OnActionList | undefined, field: 'duration' | 'chance_of_no_event' | 'chance_to_happen', label: string, title: string): React.ReactNode =>
        s?.src && list && (
            <button className="ghost small pool-add" title={title} onClick={(e) => void addListSetting(s, list, field, label, below(e), ed)}>
                {label}
            </button>
        );
    const delayBtn = (s: SectionSource | undefined, key: OnActionListKey): React.ReactNode => setting(s, story.lists?.[key], 'duration', tr('Delay…'), tr('The entries after the delay fire only once this time has passed (delay = { … } at the start of {key})', { key }));
    const chanceBtns = (s: SectionSource | undefined, key: OnActionListKey): React.ReactNode => (
        <>
            {setting(s, story.lists?.[key], 'chance_of_no_event', tr('Chance of no event…'), tr('The chance that nothing from {key} fires (chance_of_no_event)', { key }))}
            {setting(s, story.lists?.[key], 'chance_to_happen', tr('Chance to happen…'), tr('The chance that {key} is looked at at all (chance_to_happen)', { key }))}
        </>
    );
    // (the fallback is a statement of the on_action itself; one event and one on_action at most)
    const fallbackBtn = (field: 'event' | 'on_action'): React.ReactNode =>
        story.src
        && !story.fallbacks.some((f) => f.target.type === (field === 'event' ? 'events' : 'on_action'))
        && (
            <button
                className="ghost small pool-add"
                title={`${tr('If nothing else fires')} (${field === 'event' ? 'fallback_event' : 'fallback'})`}
                onClick={(e) => void addFallback(story.src!, field, tr('If nothing else fires'), below(e))}
            >
                ＋ {field === 'event' ? 'event' : 'on_action'}
            </button>
        );
    // (a pool with its list's entry button, delay and chances)
    const pool = (title: string, items: FollowUp[], key: OnActionListKey, field: 'event' | 'on_action', weighted: boolean, chances: boolean, before?: LineSource): React.JSX.Element =>
    {
        const s = sec?.[key];
        const list = story.lists?.[key];
        // ("Delay from here…" on a later entry, the chip's ✎: a delay right before that entry, or the one written there)
        const delayFrom = s?.src && list
            ? (f: FollowUp, at: { x: number; y: number; }): void =>
                void addListSetting(s, list, 'duration', tr('Delay from here…'), at, ed, { entry: f.src!, delay: f.delayAt })
            : undefined;
        return (
            <PoolList
                title={title}
                items={items}
                depth={depth}
                ancestors={path}
                lines={list?.lines}
                plural={list?.plural}
                delayFrom={delayFrom}
                add={(
                    <>
                        {addEntry(s, field, weighted, title, field, before)}
                        {delayBtn(s, key)}
                        {chances && chanceBtns(s, key)}
                    </>
                )}
            />
        );
    };

    // (what no list row shows: a random list's `0 = …` weight; the chances and a start delay are rows of their list)
    const note = story.notes?.join(' · ');
    // (the read-only view's pools: the same rows, no buttons)
    const shown = (title: string, items: FollowUp[], key: OnActionListKey): React.JSX.Element => <PoolList title={title} items={items} depth={depth} ancestors={path} lines={story.lists?.[key]?.lines} plural={story.lists?.[key]?.plural} />;

    if (sec)
    {
        return (
            <div className="ev-node">
                <div className="ev-card2 oa-card">
                    <div className="ev2-head">
                        <div className="ev2-kind">{tr('Game moment (on_action)')}</div>
                        <div className="ev2-title" title={story.key.name}>
                            {story.label}
                        </div>
                    </div>
                    {story.doc && <div className="oa-doc">{story.doc}</div>}
                    <Section title={tr('Only if')} add={ed!.sectionAdd(sec.trigger, tr('Only if'), 'condition')}>
                        {story.conditions.length ? <LineList lines={story.conditions} /> : <Empty text={tr('No conditions.')} />}
                    </Section>
                    <Section title={tr('Effects')} add={ed!.sectionAdd(sec.effect, 'Effects', 'effect')}>
                        {story.effects.length ? <LineList lines={story.effects} /> : <Empty text={tr('No effects.')} />}
                    </Section>
                    {note && <div className="oa-note">{note}</div>}
                </div>
                {pool(tr('Always fires'), story.events, 'events', 'event', false, false)}
                {pool(tr('Picks one at random'), story.randomEvents, 'random_events', 'event', true, true)}
                {pool(tr('First one that applies'), story.firstValid, 'first_valid', 'event', false, false, story.firstValidLast)}
                {pool(tr('Also triggers'), story.onActions, 'on_actions', 'on_action', false, false)}
                {pool(tr('Picks an on_action at random'), story.randomOnActions, 'random_on_action', 'on_action', true, true)}
                {pool(tr('First on_action that applies'), story.firstValidOnActions, 'first_valid_on_action', 'on_action', false, false)}
                <PoolList title={tr('If nothing else fires')} items={story.fallbacks} depth={depth} ancestors={path} add={<>{fallbackBtn('event')}{fallbackBtn('on_action')}</>} />
                <FollowUps items={story.effectFollowUps} depth={depth} ancestors={path} label={tr('Effects lead to')} />
            </div>
        );
    }

    return (
        <div className={'ev-node' + (nested ? ' nested' : '')}>
            <div className="ev-card2 oa-card">
                <div className="ev2-head">
                    <div className="ev2-kind">{tr('Game moment (on_action)')}</div>
                    <div className="ev2-title" title={story.key.name}>
                        {nested ?
                            (
                                <span className="rt-link" onClick={() => navigate(story.key)}>
                                    {story.label}
                                </span>
                            ) :
                            (
                                story.label
                            )}
                    </div>
                </div>
                {story.doc && <div className="oa-doc">{story.doc}</div>}
                {story.conditions.length > 0 && (
                    <Section title={tr('Only if')}>
                        <LineList lines={story.conditions} />
                    </Section>
                )}
                {story.effects.length > 0 && (
                    <Section title={tr('Effects')}>
                        <LineList lines={story.effects} />
                    </Section>
                )}
                {note && <div className="oa-note">{note}</div>}
            </div>
            {shown(tr('Always fires'), story.events, 'events')}
            {shown(tr('Picks one at random'), story.randomEvents, 'random_events')}
            {shown(tr('First one that applies'), story.firstValid, 'first_valid')}
            {shown(tr('Also triggers'), story.onActions, 'on_actions')}
            {shown(tr('Picks an on_action at random'), story.randomOnActions, 'random_on_action')}
            {shown(tr('First on_action that applies'), story.firstValidOnActions, 'first_valid_on_action')}
            <PoolList title={tr('If nothing else fires')} items={story.fallbacks} depth={depth} ancestors={path} />
            <FollowUps items={story.effectFollowUps} depth={depth} ancestors={path} label={tr('Effects lead to')} />
        </div>
    );
}

/**
 * Big pools (on_action random events) are listed compactly; each can be unfolded into its story. `add`: the pool's
 * "＋ event" of an on_action being edited (shown also when empty).
 */
function PoolList({ title, items, depth, ancestors, add, lines, plural, delayFrom }: { title: string; items: FollowUp[]; depth: number; ancestors: string[]; add?: React.ReactNode; lines?: Line[]; plural?: string[]; delayFrom?: (f: FollowUp, at: { x: number; y: number; }) => void; }): React.JSX.Element | null
{
    const [limit, setLimit] = useState(25);

    if (!items.length && !add && !lines?.length)
        return null;

    return (
        <div className="followups pool">
            <div className="followups-label">
                {title} <span className="pool-count">({items.length})</span>
                {add}
            </div>
            {/* (a list written `random_on_actions`: the app reads it as the list, the game does not; round 13's second
                in-game test) */}
            {!!plural?.length && (
                <div className="pool-hint" title={plural.join('\n')}>
                    {tr('Written random_on_actions ({files}): the game does not read this spelling (error.log: “Unexpected token”) and never fires these; it spells the list random_on_action.', { files: plural.join(', ') })}
                </div>
            )}
            {/* (the list's delay and chances, written at its start: ✎ ✕ on each) */}
            {!!lines?.length && <LineList lines={lines} compact />}
            {items.slice(0, limit).map((f, i) => <PoolItem key={i} f={f} depth={depth + 1} ancestors={ancestors} delayFrom={delayFrom} />)}
            {items.length > limit && (
                <button className="ghost small" onClick={() => setLimit((l) => l + 100)}>
                    {tr('Show {more} more', { more: items.length - limit })}</button>
            )}
        </div>
    );
}

function PoolItem({ f, depth, ancestors, delayFrom }: { f: FollowUp; depth: number; ancestors: string[]; delayFrom?: (f: FollowUp, at: { x: number; y: number; }) => void; }): React.JSX.Element
{
    const [open, setOpen] = useState(false);
    // (an entry of the active mod's list: ✕ takes it out)
    const ed = useContext(EditCtx);
    const below = (e: React.MouseEvent<HTMLElement>): { x: number; y: number; } =>
    {
        const r = e.currentTarget.getBoundingClientRect();
        return { x: r.left, y: r.bottom + 4 };
    };
    // (an entry after the list's first: a delay written right before it holds it and the ones after it back; the first
    // entry's delay is the list's own, "Delay…" in the header)
    const delayEdit = !!delayFrom && !!ed && f.afterFirst && f.src && ed.can(f.src) ? delayFrom : undefined;
    const delayOwn = delayEdit && f.delayAt && ed!.can(f.delayAt) ? f.delayAt : undefined;
    const remove = ed && f.src && ed.can(f.src) && (
        <button
            className="ghost small pool-x"
            title={tr('Take {label} out of this list ({rel}:{line})', { label: f.label, rel: f.src.rel, line: f.src.line })}
            onClick={(e) =>
            {
                e.stopPropagation();
                void runScriptEdit({ op: 'remove', at: f.src! }, tr('Removed {label}', { label: f.label })).catch(reportEditError(tr('Not removed')));
            }}
        >
            ✕
        </button>
    );

    if (open)
        return <FollowUpBranch f={f} depth={Math.min(depth, AUTO_DEPTH)} ancestors={ancestors} />;

    const row = (
        <div className="pool-item" onClick={() => setOpen(true)} data-ref-type={f.target.type} data-ref-name={f.target.name}>
            <TypeDot type={f.target.type} />
            <span className="pool-title">{f.label}</span>
            {f.when.map((w, i) => (
                <span key={i} className="branch-chip when">
                    <RichText rich={w} />
                </span>
            ))}
            {f.delay && !delayOwn && <span className="branch-chip">{f.delay}</span>}
            {delayOwn && (
                <span className="branch-chip delay-own">
                    <button
                        className="ghost small chip-act"
                        title={tr('Change this delay: this entry and the ones after it fire after it ({rel}:{line})', { rel: delayOwn.rel, line: delayOwn.line })}
                        onClick={(e) =>
                        {
                            e.stopPropagation();
                            delayEdit!(f, below(e));
                        }}
                    >
                        {f.delay ?? tr('Delay')} ✎
                    </button>
                    <button
                        className="ghost small chip-act"
                        title={tr('Take this delay out ({rel}:{line})', { rel: delayOwn.rel, line: delayOwn.line })}
                        onClick={(e) =>
                        {
                            e.stopPropagation();
                            void runScriptEdit({ op: 'remove', at: delayOwn }, tr('Removed the delay before {label}', { label: f.label })).catch(reportEditError(tr('Not removed')));
                        }}
                    >
                        ✕
                    </button>
                </span>
            )}
            {delayEdit && !delayOwn && (
                <button
                    className="ghost small pool-delay"
                    title={tr('Delay from here…: this entry and the ones after it fire only once this time has passed (a delay = { … } written right before it)')}
                    onClick={(e) =>
                    {
                        e.stopPropagation();
                        delayEdit(f, below(e));
                    }}
                >
                    ⏱
                </button>
            )}
            <span className="branch-expand">▸</span>
            {remove}
        </div>
    );
    // (the chip's delay opened as script (a comment inside it): its editor under the entry, outside the clickable row)
    const editor = delayOwn && ed!.editor(anchorKey(delayOwn));
    return editor ? <>{row}{editor}</> : row;
}

// ---------------------------------------------------------------------------
// Card (traits, decisions, modifiers …)
// ---------------------------------------------------------------------------

/** What "＋ Add" adds to a card section. */
function addLabel(s: CardSection): string
{
    if (s.addLabel)
        return s.addLabel;

    const k = s.src?.kind;
    return k === 'trigger' ? 'condition' : k === 'effect' ? 'effect' : k === 'modifier' ? 'modifier' : k === 'field' ? 'setting' : 'line';
}

/**
 * A type's name after a count: "1 law", "3 bookmarks" (a folder's type named once: "Bookmarks: Bookmarks", "Struggle:
 * Struggles"), else as the type list names it ("2 puppets: types").
 */
function usageLabel(label: string, n: number): string
{
    // (a word whose "s" is no plural stays: "coat of arms", "casus belli")
    const one = (w: string): string => (/(arms|news|belli)$/i.test(w) ? w.toLowerCase() : singular(w));
    const parts = label.split(': ');

    if (parts.length !== 2)
        return n === 1 ? one(label) : label.toLowerCase();

    // (a folder's type: named once when both say the same ("3 bookmarks", "2 struggles"), else as one phrase with the
    // folder as its first word: "1 activity intent", "12 artifact templates")
    if (parts[0] === parts[1] || singular(parts[1]) === parts[0].toLowerCase())
        return n === 1 ? one(parts[1]) : parts[1].toLowerCase();

    return `${one(parts[0])} ${n === 1 ? one(parts[1]) : parts[1].toLowerCase()}`;
}

/** How many of a revealed "Used by" row show at once (then "… N more" again). */
const USAGE_PAGE = 500;

/** One "Used by" row: the count and the most referencing entries; "… N more" reveals them all (in pages). */
function UsageRow(props: { u: UsageSummary; of: EntityKey; navigate: Navigate; }): React.JSX.Element
{
    const { u, navigate } = props;
    const [all, setAll] = useState<UsageSummary['examples'] | null>(null);
    const [shown, setShown] = useState(USAGE_PAGE);
    const [loading, setLoading] = useState(false);
    const list = all ?? u.examples;
    const visible = all ? list.slice(0, shown) : list;
    const hidden = (all ? list.length : u.count) - visible.length;
    const more = (): void =>
    {
        if (all)
        {
            setShown((n) => n + USAGE_PAGE * 2);
            return;
        }

        setLoading(true);
        void api
            .usageAll(props.of.type, props.of.name, u.type)
            .then((l) => setAll(l))
            .finally(() => setLoading(false));
    };
    return (
        <div className="usage-row">
            <span className="usage-count">
                <TypeDot type={u.type} /> {u.count} {usageLabel(u.typeLabel, u.count)}
            </span>
            <span className="usage-examples">
                {visible.map((x, i) => (
                    <span key={i}>
                        {i > 0 && ', '}
                        <span className="rt-entity rt-link" data-ref-type={x.ref.type} data-ref-name={x.ref.name} onClick={() => navigate(x.ref)}>
                            {x.label}
                        </span>
                    </span>
                ))}
                {hidden > 0 && (
                    <button className="usage-more" title={tr('Show the other {hidden}', { hidden })} disabled={loading} onClick={more}>
                        {loading ? ' …' : tr(' … {hidden} more', { hidden })}
                    </button>
                )}
                {all && hidden <= 0 && list.length > u.examples.length && (
                    <button className="usage-more" title={tr('Back to the first few')} onClick={() => (setAll(null), setShown(USAGE_PAGE))}>
                        {' '}
                        {tr('show fewer')}</button>
                )}
            </span>
        </div>
    );
}

function CardView({ card }: { card: EntityCard; }): React.JSX.Element
{
    const { navigate } = useContext(ReadCtx);
    // written in the active mod: empty sections show too, with "＋ Add …"
    const ed = useContext(EditCtx);
    const editable = !!ed && ed.can(card.src);
    const sections = card.sections.filter((s) => s.lines.length || (editable && (s.src || s.acts?.length)));
    return (
        <div className={'card-view' + (card.picture ? ' wide' : '')}>
            <div className="rpg-card">
                {card.illustration && !card.picture && <GameImg path={card.illustration} size={760} className="rpg-banner" />}
                {card.picture && <TexturePicture path={card.picture.path} size={Math.min(1400, Math.max(card.picture.width ?? 256, card.picture.height ?? 256))} />}
                {card.key.type === 'characters' && <PreviewDateBar id={card.key.name} />}
                {PORTRAIT_TYPES.has(card.key.type) && <PortraitViewer type={card.key.type} name={card.key.name} />}
                <div className="rpg-head">
                    {card.icon && <GameImg path={card.icon} size={72} className="rpg-icon" />}
                    <div>
                        <div className="rpg-kind">{card.typeLabel}</div>
                        <div className="rpg-title">
                            {/* (its name and description: ✎ in a mod's entry; the text keys the game reads) */}
                            <LocEditable of={card.key} locKey={card.titleKey} editable={editable && !!card.titleKey}>
                                {card.title}
                            </LocEditable>
                        </div>
                    </div>
                </div>
                {card.description && (
                    <div className="rpg-desc">
                        <LocEditable of={card.key} locKey={card.descriptionKey} editable={(editable || (card.key.type === 'localization' && !!ed)) && !!card.descriptionKey} multiline>
                            <RichText rich={card.description} />
                        </LocEditable>
                    </div>
                )}
                {card.facts.length > 0 && (
                    <div className="rpg-facts">
                        {card.facts.map((f, i) => (
                            <span key={i} className="rpg-fact">
                                <RichText rich={f} />
                            </span>
                        ))}
                    </div>
                )}
                {sections.map((s, i) => (
                    <div key={i} className="rpg-section">
                        <div className="rpg-section-title">
                            {s.title}
                            {editable && !s.noAdd && ed.sectionAdd(s.src, s.title, addLabel(s))}
                            {editable && s.acts?.map((a, j) => <span key={j}>{ed.act(a)}</span>)}
                        </div>
                        <FollowCtx.Provider value={(f) => <FollowUpBranch f={f} depth={1} ancestors={[card.key.type + ':' + card.key.name]} inline />}>
                            {s.lines.length ? <LineList lines={s.lines} /> : <Empty text={tr('Nothing yet.')} />}
                        </FollowCtx.Provider>
                        {s.followUps && s.followUps.length > 0 && <FollowUps items={s.followUps} lines={s.lines} depth={0} ancestors={[card.key.type + ':' + card.key.name]} label={tr('Leads to')} />}
                    </div>
                ))}
                {sections.length === 0 && !card.description && card.facts.length === 0 && <div className="rpg-empty">{tr('No readable details — see Expert for the raw script.')}</div>}
            </div>
            {(card.key.type === 'characters' || card.key.type === 'savegame/characters') && <FamilyTreeView id={card.key.name} type={card.key.type} navigate={navigate} />}
            {card.key.type === 'images' && <TextureUsers path={card.key.name} navigate={navigate} />}
            {card.usage.length > 0 && (
                <div className="usage">
                    <div className="usage-title">{tr('Used by')}</div>
                    {card.usage.map((u) => <UsageRow key={u.type} u={u} of={card.key} navigate={navigate} />)}
                </div>
            )}
        </div>
    );
}
