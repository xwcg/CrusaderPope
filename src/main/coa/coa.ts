/**
 * Coats of arms (common/coat_of_arms): what a title's, dynasty's or house's arms are drawn from, with the frame the
 * game's interface puts around them (docs/map.md, "Coats of arms"). A title's arms are those a game started at the
 * date shows: set by a game start effect (start.ts: AGOT gives titles their holder's house arms), else the first item
 * of its dynamic definition that fits, else its own entry, else random arms rolled for its holder. Without a date: the
 * first bookmark's. Resolved once per key (and date, when the arms depend on it) and index state.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { PNode } from '../indexer/parser.ts';
import type { CoaDesign, CoaFrame, CoaInfo, CoaKind, IndexStats } from '../../shared/api.ts';
import { DATE_KEY, dateNum } from '../map/history.ts';
import { CoaBook, type CoaTest } from './book.ts';
import { CoaFacts, tierOf, type PersonAt } from './facts.ts';
import { readStart, type RenownStep, type StartRule } from './start.ts';
import { CoaTriggers, type Scope } from './triggers.ts';

import { tr } from '../../shared/i18n.ts';
const UI = 'gfx/interface/coat_of_arms/';
/**
 * Titles (gui/shared/coat_of_arms.gui, coa_title_*): the arms in title_mask.dds, title_86.dds around them (96 px
 * around 86); data_binding/tgp_data_bindings.txt: DefaultCoATitleMaskOffset 0,0.04 and …Scale 0.9,0.9.
 */
const TITLE_FRAME: CoaFrame = { mask: UI + 'title_mask.dds', frame: UI + 'title_86.dds', index: 0, ratio: 96 / 86, offset: [0, 0.04], scale: [0.9, 0.9] };
/** an unheld title (coa_title_* `visible = "[Not(Title.HasHolder)]"`): title_no_holder_86.dds behind, a red glow, 104 px around the 86 */
const UNHELD_FRAME: CoaFrame = { ...TITLE_FRAME, under: UI + 'title_no_holder_86.dds', underRatio: 104 / 96 };
const REALMS = 'gfx/interface/icons/realm_frames/';
/** results kept per index state */
const KEEP = 5000;

interface State
{
    stats: IndexStats;
    book: CoaBook;
    facts: CoaFacts;
    triggers: CoaTriggers;
    /** what the game start's script sets (start.ts), read on first use */
    script?: { arms: StartRule[]; renown: RenownStep[]; };
    /** the first bookmark's date: arms asked without a date are shown then */
    first?: number;
    /** `kind:key` (the same at every date) or `kind:key@date` */
    infos: Map<string, CoaInfo | null>;
}

/** A state per index state: every build and incremental update replaces `idx.stats` (a mod's arms may have changed). */
const states = new WeakMap<GameIndex, State>();

/** @param date y.m.d: the history date (the map's); none: the first bookmark's */
export function coatOfArms(idx: GameIndex, kind: CoaKind, key: string, date?: string): CoaInfo | null
{
    let s = states.get(idx);

    if (!s || s.stats !== idx.stats)
    {
        const facts = new CoaFacts(idx);
        states.set(idx, s = { stats: idx.stats, book: new CoaBook(idx), facts, triggers: new CoaTriggers(idx, facts), infos: new Map() });
    }

    const id = kind + ':' + key;
    const same = s.infos.get(id);

    if (same !== undefined)
        return same;

    const when = date && DATE_KEY.test(date) ? dateNum(date) : (s.first ??= s.facts.firstBookmark() ?? 0);
    let info = s.infos.get(id + '@' + when);

    if (info === undefined)
    {
        info = resolve(idx, s, kind, key, when);
        // (resolving is quick, well under a millisecond: the designs of whole lists need not stay)
        s.infos.set(info?.dated ? id + '@' + when : id, info);

        if (s.infos.size > KEEP)
            s.infos.delete(s.infos.keys().next().value!);
    }

    return info;
}

const dateText = (when: number): string => `${Math.floor(when / 10000)}.${Math.floor(when / 100) % 100}.${when % 100}`;

type Arms = { key: string; design: CoaDesign; };

/** An entry's arms, following `98 = c_perigord` (`alias`: they are another entry's). */
function entryArms(book: CoaBook, key: string, seed: string): (Arms & { alias: boolean; }) | undefined
{
    const e = book.entry(key);
    return e && { key: e.to, design: book.design(e.list, e.file, seed), alias: e.to !== key };
}

/**
 * Random arms as the game rolls them for entries without any, new every game: a template of
 * coat_of_arms_template_lists `all` (else the entry `default`), here picked by the seed, with the special selections
 * `test` passes (the character they are rolled for: culture, faith).
 */
function randomArms(book: CoaBook, seed: string, test?: CoaTest): Arms | undefined
{
    const name = book.pick('coat_of_arms_template_lists', 'all', seed, test);
    const t = name ? book.template(name) : undefined;

    if (t)
        return { key: name!, design: book.design(t.list, t.file, seed, test) };

    const d = book.entry('default');
    return d && { key: 'default', design: book.design(d.list, d.file, seed, test) };
}

/**
 * The special selections' test for arms rolled for a character (template_lists: root is the character, scope:culture
 * and scope:faith theirs, scope:title the title), or for a culture alone (a dynasty's).
 */
function tester(s: State, when: number, who: PersonAt | null, culture: string | undefined, title?: string): CoaTest
{
    const root: Scope = who ? { t: 'char', id: who.id } : { t: 'none' };
    const saved: [string, Scope][] = [];

    if (culture)
        saved.push(['culture', { t: 'culture', key: culture }]);

    if (who?.faith)
        saved.push(['faith', { t: 'faith', key: who.faith }]);

    if (title)
        saved.push(['title', { t: 'title', key: title }]);

    const ctx = s.triggers.ctx(when, root, saved);
    const seen = new Map<PNode[], boolean>();
    return (trigger) =>
    {
        let r = seen.get(trigger);

        if (r === undefined)
            seen.set(trigger, r = s.triggers.holds(trigger, root, ctx));

        return r;
    };
}

/**
 * A house's arms: its entry, else its dynasty's (a character without a house is in their dynasty's own house; a house
 * without arms of its own is shown with its dynasty's), else random ones for the dynasty's culture.
 */
function familyArms(s: State, house: string | undefined, dynasty: string | undefined, when: number): (Arms & { how: CoaInfo['how']; note: string; }) | undefined
{
    const { book, facts } = s;
    const name = (type: string, key: string): string => facts.displayName(type, key);

    if (house)
    {
        const own = entryArms(book, house, house);

        if (own)
            return { ...own, how: own.alias ? 'alias' : 'own', note: own.alias ? tr('Arms of {key}', { key: own.key }) : tr('Coat of arms {house}', { house }) };
    }

    dynasty ??= house ? facts.houseDynasty(house) : undefined;
    const arms = dynasty ? entryArms(book, dynasty, dynasty) : undefined;

    if (arms && house)
        return { ...arms, how: 'alias', note: tr('No arms of its own: its dynasty\'s ({name}, {key})', { name: name('dynasties', dynasty!), key: arms.key }) };

    if (arms)
        return { ...arms, how: arms.alias ? 'alias' : 'own', note: arms.alias ? tr('Arms of {key}', { key: arms.key }) : tr('Coat of arms {dynasty}', { dynasty }) };

    const seed = house ?? dynasty;
    const culture = dynasty ? facts.dynastyCulture(dynasty) : undefined;
    const rolled = seed ? randomArms(book, seed, tester(s, when, null, culture)) : undefined;
    return rolled && { ...rolled, how: 'random', note: tr('No arms of its own: the game rolls random ones every game (these: template {key}, picked by the key{value})', { key: rolled.key, value: culture ? ` for the ${name('culture/cultures', culture)} culture` : '' }) };
}

function resolve(idx: GameIndex, s: State, kind: CoaKind, key: string, when: number): CoaInfo | null
{
    let info: CoaInfo | undefined;

    if (kind === 'title')
        info = titleArms(idx, s, key, when, 0);
    else if (kind === 'realm')
    {
        const arms = titleArms(idx, s, key, when, 0);
        const holder = s.facts.holder(key, when);
        const gov = holder ? s.facts.government(holder, when) : undefined;

        if (arms)
            info = { ...arms, note: arms.note + (gov ? tr(' — the realm\'s banner of the {displayName}', { displayName: s.facts.displayName('governments', gov) }) : ''), dated: true, frame: realmFrame(idx, s, key, gov) };
    }
    else if (kind === 'coa')
    {
        const own = entryArms(s.book, key, key);

        if (own)
            info = { key: own.key, how: own.alias ? 'alias' : 'own', note: own.alias ? tr('Arms of {key}', { key: own.key }) : tr('Coat of arms {key}', { key }), design: own.design };
    }
    else if (idx.get(kind === 'dynasty' ? 'dynasties' : 'dynasty_houses', key) || s.book.has(key))
    {
        const arms = familyArms(s, kind === 'house' ? key : undefined, kind === 'dynasty' ? key : undefined, when);
        const dynasty = kind === 'house' ? s.facts.houseDynasty(key) : key;
        const renown = renownLevel(idx, s, dynasty, when);
        const note = renown.level ? tr('; renown level {level} when the game starts on {dateText}', { level: renown.level, dateText: dateText(when) }) : '';

        if (arms)
            info = { key: arms.key, how: arms.how, note: arms.note + note, dated: renown.dated || undefined, design: arms.design, frame: familyFrame(idx, s, kind, dynasty, Math.floor(renown.level / s.facts.renownLevels().step)) };
    }

    return info ?? null;
}

/**
 * A dynasty's renown level in a game started at the date (the frame's cell follows it): none, then what the game
 * start's script does to it (start.ts): renown added (the level: how many of NDynasty LEVELS_PRESTIGE it reaches),
 * levels added, the level brought up or down to a value. `dated`: it has such steps (their limits may name dates).
 */
function renownLevel(idx: GameIndex, s: State, dynasty: string | undefined, when: number): { level: number; dated: boolean; }
{
    // (its own steps, and those for a title's holder's dynasty when the holder at the date is of it)
    const ofHolder = (title: string): string | undefined =>
    {
        const h = s.facts.holder(title, when);
        return h ? s.facts.person(h, when)?.dynasty : undefined;
    };
    const steps = dynasty ? (s.script ??= readStart(idx)).renown.filter((r) => r.dynasty === dynasty || (r.of && ofHolder(r.of) === dynasty)) : [];
    const { thresholds } = s.facts.renownLevels();
    const none: Scope = { t: 'none' };
    const ctx = s.triggers.ctx(when, none);
    let renown = 0;
    let level = 0;

    for (const { step, when: limits } of steps)
    {
        if (!limits.every((c) => s.triggers.holds(c.list, none, ctx) !== c.not))
            continue;

        if ('add' in step)
        {
            renown += step.add;
            level = Math.max(level, thresholds.filter((t) => renown >= t).length);
        }
        else if ('levels' in step)
            level += step.levels;
        else if ('atLeast' in step)
            level = Math.max(level, step.atLeast);
        else
            level = Math.min(level, step.atMost);

        level = Math.max(0, Math.min(thresholds.length, level));
    }

    return { level, dated: steps.length > 0 };
}

/** A title's arms at a date (`depth`: through `set_coa = title:x`). */
function titleArms(idx: GameIndex, s: State, key: string, when: number, depth: number): CoaInfo | undefined
{
    const { book, facts, triggers } = s;
    const holder = facts.holder(key, when);
    const who = holder ? facts.person(holder, when) : null;
    const held = who ? tr('{name} holds it on {dateText}', { name: who.name, dateText: dateText(when) }) : tr('no holder on {dateText}', { dateText: dateText(when) });
    const rules = (s.script ??= readStart(idx)).arms;
    const title: Scope = { t: 'title', key };
    // (unheld at the date: the red glow; whether it is held depends on the date)
    const out = (arms: Arms, how: CoaInfo['how'], note: string, dated: boolean): CoaInfo => ({ key: arms.key, how, note, dated: dated || !holder || undefined, design: arms.design, frame: holder ? TITLE_FRAME : UNHELD_FRAME });

    // game start effects: the last `set_coa` that reaches the title
    let set: { rule: StartRule; arms: Arms; note: string; } | undefined;

    for (const r of rules)
    {
        const t = r.target;

        if (t.how === 'key' ? t.key !== key : !holder || (t.how === 'primary' && facts.primaryTitle(holder, when) !== key) || (t.how === 'noble' && facts.titleField(key, 'noble_family') !== 'yes'))
            continue;

        const ctx = triggers.ctx(when, holder ? { t: 'char', id: holder } : { t: 'none' });
        const holds = r.when.every((c) =>
        {
            const on: Scope | undefined = c.on === 'title' ? title : c.on === 'none' ? { t: 'none' } : holder ? { t: 'char', id: holder } : undefined;
            return !!on && triggers.holds(c.list, on, ctx) !== c.not;
        });

        if (!holds)
            continue;

        const a = r.arms;

        if ('coa' in a)
        {
            const arms = entryArms(book, a.coa, key);

            if (arms)
                set = { rule: r, arms, note: tr('{key}: set when the game starts (set_coa in {at}) — {held}', { key: arms.key, at: r.at, held }) };
        }
        else if ('of' in a && who)
        {
            const arms = familyArms(s, a.of === 'house' ? who.house : undefined, who.dynasty, when);
            const whose = a.of === 'house' && who.house ? facts.displayName('dynasty_houses', who.house) : who.dynasty ? facts.displayName('dynasties', who.dynasty) : undefined;

            if (arms && whose)
                set = { rule: r, arms, note: tr('The arms of its holder\'s {value} {whose}: set when the game starts (set_coa in {at}) — {held}', { value: a.of === 'house' && who.house ? 'house' : 'dynasty', whose, at: r.at, held }) };
        }
        else if ('title' in a && a.title !== key && depth < 4)
        {
            const other = titleArms(idx, s, a.title, when, depth + 1);

            if (other)
                set = { rule: r, arms: other, note: tr('The arms of {title}: set when the game starts (set_coa in {at}) — {held}', { title: a.title, at: r.at, held }) };
        }
    }

    if (set)
        return out(set.arms, 'script', set.note, true);

    // the dynamic definition: its first item whose trigger holds (root: the title)
    const items = book.dynamicItems(key);
    const item = items?.find((i) => triggers.holds(i.trigger, title, triggers.ctx(when, title)));
    const dyn = item && entryArms(book, item.coa, key);

    if (dyn)
        return out(dyn, 'dynamic', tr('{key}: the first item of its dynamic definition (common/coat_of_arms/dynamic_definitions) that fits — {held}', { key: dyn.key, held }), true);

    // (the arms depend on the date when a holder can make a difference: a game start effect or a dynamic definition)
    const dated = !!items || facts.everHeld(key) || rules.some((r) => r.target.how === 'key' && r.target.key === key);
    const own = entryArms(book, key, key);

    if (own)
        return out(own, own.alias ? 'alias' : 'own', own.alias ? tr('Arms of {key}', { key: own.key }) : tr('Coat of arms {key}', { key }), dated);

    if (!facts.isTitle(key))
        return undefined;

    const culture = who?.culture;
    const arms = randomArms(book, key, tester(s, when, who, culture, key));
    const why = who ? tr(' for its holder\'s culture and faith ({name} on {dateText})', { name: who.name, dateText: dateText(when) }) : '';
    return arms && out(arms, 'random', tr('No arms of its own: the game rolls random ones every game (these: template {key}, picked by the key{why})', { key: arms.key, why }), dated);
}

/**
 * Realms (gui/shared/coat_of_arms.gui, coa_realm_huge): the primary title's arms in the banner of the holder's
 * government: gfx/interface/icons/realm_frames/<government>_mask.dds (the shape; its colours laid over the arms at
 * 40 %), common/governments `realm_mask_offset` / `_scale`, <government>_115_frame.dds over and _115_shadow.dds behind
 * (`_default_…` for governments without their own files: feudal), all 128 px, and the bar of the title's tier
 * (`[Character.GetPrimaryTitle.GetTierFrame]`: barony 1 … hegemony 6, cell 0 is empty) of topframe_115.dds 14 px higher.
 */
function realmFrame(idx: GameIndex, s: State, key: string, gov: string | undefined): CoaFrame
{
    const file = (name: string): string => (gov && idx.vfs.get(REALMS + gov + name, { engine: true }) ? REALMS + gov + name : REALMS + '_default' + name);
    const g = s.facts.governmentInfo(gov);
    const mask = file('_mask.dds');
    const cardinal = s.facts.isClericalElectorSeat(key) && !!idx.vfs.get(UI + 'cardinal_topframe_115.dds', { engine: true });
    const forced = s.facts.frameDefines().realm;
    return {
        mask,
        frame: file('_115_frame.dds'),
        under: file('_115_shadow.dds'),
        index: 0,
        ratio: 1,
        // (OVERRIDE_REALM_MASK_ENABLED: one offset and scale for every government)
        offset: forced?.offset ?? g?.maskOffset ?? [0, 0],
        scale: forced?.scale ?? g?.maskScale ?? [1, 1],
        overlay: mask,
        top: { texture: UI + 'topframe_115.dds', index: tierOf(key), dy: -14 / 128 },
        // (coa_realm_huge_crown, as most windows show realms: the tier's crown 2 px above; a landless adventurer's or an
        // ecclesiastical government's own decoration instead, or a cardinal's (1.20.1: the primary title a clerical elector's,
        // inferred from the title: isClericalElectorSeat); mercenaries' and holy orders' are not told apart here)
        crown: gov === 'landless_adventurer_government' ?
            { texture: UI + 'landless_adventurer_topframe_115.dds', index: 0, aspect: 80 / 128, gap: 2 / 128 } :
            gov === 'ecclesiastical_government' ?
            { texture: UI + (cardinal ? 'cardinal_topframe_115.dds' : 'ecclesiastic_topframe_115.dds'), index: 0, aspect: 80 / 128, gap: 2 / 128 } :
            { texture: UI + 'crown_strip_115.dds', index: tierOf(key), aspect: 80 / 128, gap: 2 / 128 }
    };
}

/**
 * Dynasties and houses: the frame of their culture (common/culture/cultures `dynasty_coa_frame`, `house_coa_frame` =
 * gfx/interface/coat_of_arms/frames/<name>.dds + <name>_mask.dds, `<kind>_coa_mask_offset` / `_scale`; from 1.20.1 a
 * dynasty without a frame takes the house frame), else common/defines/graphic NCoatOfArms DEFAULT_DYNASTY_COA_FRAME_NAME
 * "dynasty" / DEFAULT_HOUSE_COA_FRAME_NAME "house" (with their _OFFSET / _SCALE), and a non-empty OVERRIDE_<KIND>_COA_FRAME_NAME
 * wins over both.
 * A house's culture is its dynasty's. The gui draws dynasty arms at 120 px in a 172 px frame, house arms at 120 in 156,
 * both with coa_overlay.dds at 40 %. The strips have a cell per renown step (`cell`): the gui's
 * `[Dynasty.GetPrestigeFrame]` is the dynasty's renown level (common/defines NDynasty LEVELS_PRESTIGE: how many of its
 * thresholds, 300 … 37000, the renown reached) over LEVELS_PRESTIGE_GRAPHICAL_STEP (2): cells 0 … 5; history gives
 * dynasties no renown, so most start at level 0: cell 0 (the dark frame with a red rim).
 */
function familyFrame(idx: GameIndex, s: State, kind: 'dynasty' | 'house', dynasty: string | undefined, cell: number): CoaFrame
{
    const scalar = (list: PNode[], name: string): string | undefined =>
    {
        const c = list.find((x) => x.k === name);
        return typeof c?.v === 'string' ? c.v : undefined;
    };
    const body = (type: string, k: string | undefined): PNode[] =>
    {
        const e = k ? idx.get(type, k) : undefined;
        return kidsOf(e && idx.winningDef(e) ? idx.defNode(e)?.node : undefined);
    };
    const cn = body('culture/cultures', scalar(body('dynasties', dynasty), 'culture'));
    const pair = (k: string, def: [number, number]): [number, number] =>
    {
        const v = kidsOf(cn.find((c) => c.k === k)).map((c) => Number(c.v));
        return v.length === 2 && v.every(Number.isFinite) ? [v[0], v[1]] : def;
    };
    const house = kind === 'house';
    const defines = s.facts.frameDefines()[kind];
    // (1.20.1: a dynasty without a frame of its own takes its culture's house frame, and then its house's offset and scale
    // as the frame's mask is cut for them)
    const own = scalar(cn, `${kind}_coa_frame`);
    const borrowed = !house && own === undefined && scalar(cn, 'house_coa_frame') !== undefined;
    const name = own ?? (borrowed ? scalar(cn, 'house_coa_frame') : undefined) ?? defines.name;
    const fixed = defines.override;
    return {
        mask: `${UI}frames/${fixed?.name ?? name}_mask.dds`,
        frame: `${UI}frames/${fixed?.name ?? name}.dds`,
        index: cell,
        ratio: house ? 156 / 120 : 172 / 120,
        offset: fixed?.offset ?? pair(`${kind}_coa_mask_offset`, borrowed ? pair('house_coa_mask_offset', defines.offset) : defines.offset),
        scale: fixed?.scale ?? pair(`${kind}_coa_mask_scale`, borrowed ? pair('house_coa_mask_scale', defines.scale) : defines.scale),
        overlay: UI + 'coa_overlay.dds'
    };
}

const kidsOf = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
