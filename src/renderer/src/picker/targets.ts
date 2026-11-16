/**
 * The scopes the picker offers as targets besides the links (docs/picker.md, "The event's scopes", "Scopes in reach"):
 * the event shown sets its Who's who here (StoryView), every picker opened meanwhile lists them ("Child is…",
 * "Opinion of: Child"), the ones in reach where the statement goes (PickRequest.place).
 */
import type { EventStory, PickPlace, PickTarget, ScopeReach, ScriptEditRequest } from '../../../shared/api.ts';
import { castTargets } from '../../../shared/castTargets.ts';
import { tr } from '../../../shared/i18n.ts';

/** A definition's own text: its file and offsets as indexed (LineSource's `file`, `s`, `e`). */
export interface DefSpan
{
    file: string;
    s: number;
    e: number;
}

let current: PickTarget[] = [];
let known = false;
let span: DefSpan | undefined;

export const viewTargets = (): PickTarget[] => current;

/**
 * The shown entry's scopes in reach are all known (PickRequest.targetsKnown), not just the ones found, at `place`: only
 * inside the shown entry's own definition (setViewTargets' span). A place outside it (a follow-up event shown nested in
 * the timeline, a line of a called script in another file) is not known: its scopes may come from elsewhere, so a typed
 * one is not warned about there. No place: as the list says.
 */
export const viewTargetsKnown = (place?: PickPlace): boolean => known && !(place as EditPlace | undefined)?.inlined && (!place || !span || inSpan(span, place));

/**
 * A place of the in-place editor (placeOf): `inlined`, the line is an inlined definition's (LineSource.owner) read at
 * its call (LineSource.via): the shown entry's scopes in reach are those at the call, but the definition may save
 * scopes of its own there, so they are not all known (no "not saved or given here").
 */
export type EditPlace = PickPlace & { inlined?: boolean; };

/** The place lies in the span (pure; the file compared without case, the end excluded, as ScopeReach.def). */
export function inSpan(sp: DefSpan, place: PickPlace): boolean
{
    return sp.file.toLowerCase() === place.file.toLowerCase() && place.offset >= sp.s && place.offset < sp.e;
}

/**
 * The shown entry's scopes (StoryView): `isKnown`, they are all of them (PickRequest.targetsKnown) inside `defSpan`,
 * the shown entry's definition (EventStory.src, EntityCard.src).
 */
export function setViewTargets(t: PickTarget[], isKnown = false, defSpan?: DefSpan, type?: string, name?: string): void
{
    current = t;
    known = isKnown;
    span = defSpan && { file: defSpan.file, s: defSpan.s, e: defSpan.e };
    entry = type && name ? { type, name } : undefined;
}

/**
 * The shown entry ('events', 'decisions' … and its key): whose character `root` is, in the picker's words (rootWho);
 * the start of a new text key ("Write a new text…": `<entry>_tooltip`).
 */
let entry: { type: string; name: string; } | undefined;

export const viewEntryType = (): string | undefined => entry?.type;

export const viewEntry = (): { type: string; name: string; } | undefined => entry;

/**
 * An event's scopes as targets: the ones it is given, the ones it names (the temporary ones marked), the ones it uses
 * without either (shared/castTargets.ts).
 */
export const eventTargets = (story: EventStory): PickTarget[] => castTargets(story.cast);

/** A view's scope that is not in reach where the picker is open, and why (chainType's warning). */
export interface AwayTarget
{
    key: string;
    /** 'later': saved only after the place (further down, or in a later part of the event); 'elsewhere': in another option or part */
    why: 'later' | 'elsewhere';
}

/**
 * The target is in reach at the place: no reach (everywhere), another file or another definition of the same file (a
 * line of a called script, a follow-up event shown nested: not known), or a range or key holding it.
 */
function reaches(t: { reach?: ScopeReach; inside?: PickTarget['inside']; }, place: PickPlace): boolean
{
    // (a save of a called definition: only on its own lines read inlined, by its reach at the line's own place)
    if (t.inside)
    {
        const own = place.own;

        if (!own || own.file.toLowerCase() !== t.inside.file.toLowerCase() || own.offset < t.inside.def[0] || own.offset >= t.inside.def[1])
            return false;

        return reaches({ reach: t.reach }, { file: own.file, offset: own.offset });
    }

    const r = t.reach;

    if (!r || r.file.toLowerCase() !== place.file.toLowerCase())
        return true;

    if (place.offset < r.def[0] || place.offset >= r.def[1])
        return true;

    // (a new block of a part that runs before the save: not in reach wherever it is put, ScopeReach.notKeys)
    if (place.section && r.notKeys?.includes(place.section))
        return false;

    if (r.ranges.some(([s, e]) => place.offset >= s && place.offset < e))
        return true;

    return !!place.section && !!r.keys?.includes(place.section);
}

/**
 * The targets in reach at the place (pure; no place: all of them, but a called definition's own saves); also the saved
 * values and lists (EntityCard.values / lists).
 */
export function inReach<T extends { reach?: ScopeReach; inside?: PickTarget['inside']; }>(targets: T[], place: PickPlace | undefined): T[]
{
    return place ? targets.filter((t) => reaches(t, place)) : targets.filter((t) => !t.inside);
}

/**
 * The targets out of reach at the place, each with why (pure): saved only later (the place is before the save in its
 * part, or in a part of the event that runs earlier: ScopeReach.later; a new block of a part that runs earlier:
 * ScopeReach.notKeys), else saved elsewhere (another option …).
 */
export function awayAt(targets: PickTarget[], place: PickPlace | undefined): AwayTarget[]
{
    if (!place)
        return [];

    // (a called definition's own saves are not the entry's: never "saved only later / elsewhere" for it)
    return targets
        .filter((t) => !t.inside && !reaches(t, place))
        .map((t): AwayTarget => ({ key: t.key, why: (!!place.section && !!t.reach!.notKeys?.includes(place.section)) || t.reach!.later?.some(([s, e]) => place.offset >= s && place.offset < e) ? 'later' : 'elsewhere' }));
}

let away: AwayTarget[] = [];

/**
 * The view's scopes the open picker leaves out (pickStatement sets them for each request; one picker is open at a
 * time): a typed `scope:x` among them gets "saved only later / elsewhere" (picker/model.ts chainType).
 */
export const awayTargets = (): AwayTarget[] => away;

export function setAwayTargets(a: AwayTarget[]): void
{
    away = a;
}

/**
 * What the open picker's request says about the scopes where the statement goes (pickStatement sets it for each
 * request, as the away targets): the prev stack there (PickRequest.prev), the scope type as given (PickRequest.scope;
 * undefined: not known) and whether it is a guess (PickRequest.scopeGuessed). picker/model.ts prevStack and chainType
 * read it.
 */
export interface PlaceScopes
{
    prev?: (string | null | undefined)[];
    scope?: string;
    guessed?: boolean;
}

let placeScopesNow: PlaceScopes = {};

export const placeScopes = (): PlaceScopes => placeScopesNow;

export function setPlaceScopes(p: PlaceScopes): void
{
    placeScopesNow = p;
}

/**
 * Where a statement the in-place editor adds or changes goes, as a picker place (pure): a change at the statement, an
 * add after a line right after it, one into a block at the block's end, one before a statement at it; a new block
 * (`wrap`: a section the definition does not have yet) names its key. A line of an inlined definition read where the
 * shown entry calls it (LineSource.owner + via): the call's place, marked `inlined` (EditPlace).
 */
export function placeOf(req: Pick<ScriptEditRequest, 'op' | 'at' | 'where' | 'wrap'>): EditPlace
{
    const at = req.at;
    const section = req.wrap ? { section: req.wrap } : {};

    // (the line's own place too: the called definition's own saves before it there, PickTarget.inside)
    if (at.owner && at.via)
        return { file: at.via.file, offset: at.via.offset, inlined: true, own: { file: at.file, offset: req.op === 'insert' && req.where !== 'before' ? (req.where === 'inside' && at.inner ? at.inner[1] : at.e) : at.s } };

    if (req.op !== 'insert')
        return { file: at.file, offset: at.s };

    if (req.where === 'inside')
        return { file: at.file, offset: at.inner ? at.inner[1] : at.e, ...section };

    if (req.where === 'before')
        return { file: at.file, offset: at.s, ...section };

    return { file: at.file, offset: at.e, ...section };
}

/**
 * The prev stack where a statement the in-place editor adds or changes goes (pure; PickRequest.prev): into a block,
 * the one inside it (LineSource.prevInside: an iterator or a scope switch pushed the scope it left), else the line's.
 */
export function prevOf(req: Pick<ScriptEditRequest, 'op' | 'at' | 'where' | 'wrap'>): (string | null | undefined)[] | undefined
{
    const at = req.at;
    return req.op === 'insert' && req.where === 'inside' && !req.wrap ? (at.prevInside ?? at.prev) : at.prev;
}

/** The scope where the statement goes is a guess from its block's use (pure; PickRequest.scopeGuessed). */
export function scopeGuessOf(req: Pick<ScriptEditRequest, 'op' | 'at' | 'where' | 'wrap'>): boolean
{
    const at = req.at;
    return req.op === 'insert' && req.where === 'inside' && !req.wrap ? !!(at.innerScope ? at.innerGuessed : at.scopeGuessed) : !!at.scopeGuessed;
}

/**
 * The warning for a typed saved scope (pure; `value` `scope:x` or a chain from it, `scope:x.liege`) that is not in
 * reach where it goes: saved only later, or only in another part (`away`: awayAt there); else, the scopes in reach
 * being all known (`known`), none of `inReach` (the scopes in reach there); else undefined (in reach, not a saved
 * scope, or nothing known). The picker's chainType and the value editor (InPlaceEdit's ValueInput) both say it so.
 */
export function typedScopeWarning(value: string, inReach: { key: string; }[], away: AwayTarget[], known: boolean): string | undefined
{
    // (the chain's first part, as chainType splits it)
    const first = /^(scope:[^.\s]+)/.exec(value.trim())?.[1];

    if (!first || inReach.some((t) => t.key === first))
        return undefined;

    // (saved by the entry, but not in reach where the statement goes: awayAt)
    const a = away.find((x) => x.key === first);

    if (a)
        return a.why === 'later' ? tr('{first} is saved only later, not yet here (as far as the index sees)', { first }) : tr('{first} is saved only in another part (another option …), not in reach here (as far as the index sees)', { first });

    // (the scopes in reach are all known and this is none of them: a warning, as far as the index sees)
    if (known)
        return tr('{first} is not saved or given here (as far as the index sees)', { first });

    return undefined;
}
