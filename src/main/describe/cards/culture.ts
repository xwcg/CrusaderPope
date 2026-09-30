/** Cards: Culture, faith and dynasty — cultures, name lists, innovations, ethnicities, faiths, religions, doctrines, dynasties, houses, nicknames. */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { FAITH_CARDS } from './culture-faith.ts';
import { DYNASTY_CARDS } from './culture-dynasty.ts';
import { capitalize, formatNumber, humanize, rich, signed, titleCase } from '../text.ts';
import { aiSection, block, bodyOf, colorSeg, dateText, dlcName, doctrineModifierLines, dynastyWord, gameText, items, joined, paramLines, sample, scalar, scalars, statementLine, word } from './culture-util.ts';

const PILLAR = ['culture/pillars'];

/** A graphical culture key (`western_clothing_gfx`) by its name in game ("Continental European"). */
function gfxSeg(b: StoryBuilder, key: string): RichSeg
{
    return { text: b.idx.plainLoc(key)?.trim() || titleCase(humanize(key.replace(/_(coa|building|clothing|unit)_gfx$/, ''))), kind: 'value', tip: key };
}

/** Graphical unit types (levy and knight pictures) by the unit graphics keys they list (`graphical_cultures`) — a handful. */
function unitTypes(b: StoryBuilder): Map<string, string>
{
    const by = new Map<string, string>();

    for (const name of b.idx.names('graphical_unit_types'))
    {
        for (const x of items(block(bodyOf(b, b.idx.get('graphical_unit_types', name)), 'graphical_cultures')))
            if (!by.has(x.v as string))
                by.set(x.v as string, name);
    }

    return by;
}

/** The graphical unit type a culture's `unit_gfx = { … }` picks: the first of its keys one lists (graphical_unit_types/_graphical_unit_types.info). */
function unitTypeOf(by: Map<string, string>, keys: string[]): string | undefined
{
    return by.get(keys.find((k) => by.has(k)) ?? '');
}

/** A tradition with its category (culture/traditions `category`: realm, combat, societal, ritual, regional). */
function traditionSeg(b: StoryBuilder, key: string): Rich
{
    const category = scalar(bodyOf(b, b.idx.get('culture/traditions', key)), 'category');
    return rich(b.d.ref(key, ['culture/traditions']), category ? { text: ` · ${humanize(category)}`, kind: 'ph' } : '');
}

/** How the head of culture is found (culture/pillars `head_determination_type`). */
const HEAD: Record<string, string> = { domain: 'the ruler with the largest domain', herd: 'the ruler with the largest herd' };

/** Graphics of a culture (culture/cultures/_cultures.info): several blocks of one key make a hybrid's look. */
const GFX: Record<string, string> = { clothing_gfx: 'Clothes', building_gfx: 'Buildings', unit_gfx: 'Soldiers', coa_gfx: 'Coats of arms' };

const CULTURE_SKIP = new Set([
    'color',
    'created',
    'parents',
    'history_loc_override',
    'traditions',
    'dlc_tradition',
    'dlc_fallback_pillar',
    'ethos',
    'heritage',
    'language',
    'martial_custom',
    'head_determination',
    'name_list',
    'name_order_convention',
    'ethnicities',
    'house_coa_frame',
    'dynasty_coa_frame',
    'house_coa_mask_offset',
    'house_coa_mask_scale',
    ...Object.keys(GFX)
]);

/**
 * A culture (culture/cultures/_cultures.info): its pillars and traditions as links, where it came from (hybrid /
 * divergence, creation date), its name lists, ethnicities by weight, and its look.
 */
const culture: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const settings = own('field', 'culture/cultures');

    for (const k of ['heritage', 'language', 'ethos'])
    {
        const v = scalar(body, k);

        if (v)
            card.facts.push(rich(capitalize(k), ': ', b.d.ref(v, PILLAR)));
    }

    const parentNode = body.find((c) => c.k === 'parents' && Array.isArray(c.v));
    const parents = items(parentNode).map((x) => b.d.ref(x.v as string, ['culture/cultures']));
    const origin = parents.length > 1 ? rich('Hybrid of ', joined(parents)) : parents.length ? rich('Diverged from ', parents[0]) : undefined;

    if (origin)
        card.facts.push(origin);

    const created = scalar(body, 'created');

    if (created)
        card.facts.push([`Since ${created.split('.')[0]}`]);

    const pillars: Line[] = [];

    for (const c of body)
    {
        if (c.k === 'ethos' || c.k === 'heritage' || c.k === 'language' || c.k === 'martial_custom')
        {
            if (typeof c.v === 'string')
                pillars.push(statementLine(b, c, ctx, rich(capitalize(humanize(c.k)), ': ', b.d.ref(c.v, PILLAR)), 'culture/cultures'));
        }
        else if (c.k === 'head_determination' && typeof c.v === 'string')
        {
            const how = HEAD[scalar(bodyOf(b, b.idx.get('culture/pillars', c.v)), 'head_determination_type') ?? ''];
            const seg = b.d.ref(c.v, PILLAR);
            pillars.push(statementLine(b, c, ctx, rich('Head of culture: ', how && typeof seg !== 'string' ? { ...seg, text: how } : seg), 'culture/cultures'));
        }
        else if (c.k === 'dlc_fallback_pillar' && Array.isArray(c.v))
        {
            const fb = scalar(c.v, 'fallback');
            const dlc = scalar(c.v, 'requires_dlc_flag');

            if (fb)
                pillars.push(statementLine(b, c, ctx, rich(dlc ? `Without ${dlcName(dlc)}: ` : 'Fallback: ', b.d.ref(fb, PILLAR))));
        }
    }

    card.sections.push({ title: 'Pillars', lines: pillars, src: settings });

    const trad = body.find((c) => c.k === 'traditions' && Array.isArray(c.v));
    const traditions = items(trad).map((c) => statementLine(b, c, ctx, traditionSeg(b, c.v as string), undefined, { icon: 'note' }));

    // dlc_tradition = { trait = x requires_dlc_flag = f fallback = y }: x with the DLC, else y
    for (const c of body)
    {
        if (c.k !== 'dlc_tradition' || !Array.isArray(c.v))
            continue;

        const t = scalar(c.v, 'trait');
        const dlc = scalar(c.v, 'requires_dlc_flag');
        const fb = scalar(c.v, 'fallback');

        if (t)
            traditions.push(statementLine(b, c, ctx, rich(traditionSeg(b, t), dlc ? ` — with ${dlcName(dlc)}` : '', fb ? rich(', else ', traditionSeg(b, fb)) : ''), undefined, { icon: 'note' }));
    }

    card.sections.push({ title: 'Traditions', lines: traditions, src: trad ? b.blockSection(trad, 'other', ctx) : undefined });

    const history: Line[] = [];

    for (const c of body)
    {
        if (c.k === 'created' && typeof c.v === 'string')
            history.push(statementLine(b, c, ctx, [`Created on ${dateText(c.v)}`], 'culture/cultures', { icon: 'note' }));
        else if (c === parentNode && origin)
            history.push(statementLine(b, c, ctx, origin, undefined, { icon: 'note' }));
        else if (c.k === 'history_loc_override' && typeof c.v === 'string')
            history.push(statementLine(b, c, ctx, rich('History text: ', { text: c.v, kind: 'code' }), 'culture/cultures'));
    }

    if (history.length)
        card.sections.push({ title: 'Origin', lines: history });

    const lists = scalars(body, 'name_list');
    const names = lists.map((c, i) => statementLine(b, c, ctx, rich('Names from ', b.d.ref(c.v as string, ['culture/name_lists']), lists.length > 1 && !i ? { text: ' · the main one', kind: 'ph' } : ''), 'culture/cultures'));
    const order = body.find((c) => c.k === 'name_order_convention' && typeof c.v === 'string');

    if (order)
        names.push(statementLine(b, order, ctx, [`Name order: ${word(b, 'culture_aesthetics_naming_' + order.v)}`], 'culture/cultures'));

    card.sections.push({ title: 'Names', lines: names, src: settings });

    // ethnicities = { 10 = caucasian_blond … }: how common each look is
    const eth = body.find((c) => c.k === 'ethnicities' && Array.isArray(c.v));

    if (eth)
    {
        const entries = (eth.v as PNode[]).filter((c) => typeof c.v === 'string').map((c) => ({ c, w: c.k ? parseFloat(c.k) || 0 : 1 }));
        const total = entries.reduce((s, x) => s + x.w, 0);
        const lines = entries.map(({ c, w }) => statementLine(b, c, ctx, rich({ text: total ? `${formatNumber(Math.round((1000 * w) / total) / 10)}%` : String(w), kind: 'value', tip: `weight ${c.k ?? 1}` }, ' ', b.d.ref(c.v as string, ['ethnicities']))));
        card.sections.push({ title: 'Ethnicities', lines, src: b.blockSection(eth, 'other', ctx) });
    }

    const look: Line[] = [];

    for (const c of body)
    {
        if (c.k === 'color')
            look.push(statementLine(b, c, ctx, rich('Map colour: ', colorSeg(b, c))));
        else if (c.k && GFX[c.k] && Array.isArray(c.v))
        {
            const keys = items(c).map((x) => x.v as string);
            const unit = c.k === 'unit_gfx' ? unitTypeOf(unitTypes(b), keys) : undefined;
            look.push(statementLine(b, c, ctx, rich(GFX[c.k], ': ', joined(keys.map((k) => gfxSeg(b, k)), ', '), unit ? rich({ text: ' · pictures: ', kind: 'ph' }, b.d.ref(unit, ['graphical_unit_types'])) : '')));
        }
        else if ((c.k === 'house_coa_frame' || c.k === 'dynasty_coa_frame') && typeof c.v === 'string')
        {
            look.push(statementLine(b, c, ctx, rich(c.k === 'house_coa_frame' ? 'House' : 'Dynasty', ' coat of arms frame: ', { text: humanize(c.v), kind: 'value', tip: c.v }), 'culture/cultures'));
        }
    }

    card.sections.push({ title: 'Look', lines: look, src: settings });
    b.genericSections(e, body, card, ctx, own, CULTURE_SKIP);
    return true;
};

/** Name list keys whose value is a loc key (a prefix / suffix), read as the name they make. */
const AFFIX: Record<string, [string, 'before' | 'after', string]> = {
    dynasty_of_location_prefix: ['Dynasties named after a place', 'before', 'Place'],
    bastard_dynasty_prefix: ['Bastard dynasties', 'before', 'Name'],
    patronym_prefix_male: ['Sons', 'before', 'Parent'],
    patronym_prefix_male_vowel: ['Sons, before a vowel', 'before', 'Parent'],
    patronym_prefix_female: ['Daughters', 'before', 'Parent'],
    patronym_prefix_female_vowel: ['Daughters, before a vowel', 'before', 'Parent'],
    patronym_suffix_male: ['Sons', 'after', 'Parent'],
    patronym_suffix_female: ['Daughters', 'after', 'Parent']
};

const NAME_BLOCKS: Record<string, string> = { male_names: 'Men’s names', female_names: 'Women’s names' };

/** The names of a list: character names are loc keys (`BA_rd` → "Bård"). */
function namesIn(b: StoryBuilder, list: PNode[]): string[]
{
    return items(list).map((x) => word(b, x.v as string));
}

/** Every name of a name block — plain (`{ a b }`) or in weight groups (`{ 10 = { a b } 1 = { c } }`). */
function allNames(n: PNode): PNode[]
{
    return Array.isArray(n.v) ? [...items(n), ...n.v.filter((c) => c.k && Array.isArray(c.v)).flatMap((c) => items(c))] : [];
}

/** A name block as lines: one per weight group (a sample, the full list folded under it). */
function nameLines(b: StoryBuilder, n: PNode, ctx: Ctx): Line[]
{
    const line = (names: string[], label: string, node: PNode): Line =>
    {
        const l = statementLine(b, node, ctx, rich({ text: `${names.length} name${names.length === 1 ? '' : 's'}`, kind: 'value' }, label, ': ', sample(names)));

        if (names.length > 12)
        {
            l.children = [{ text: [names.join(', ')] }];
            l.collapsed = true;
        }

        return l;
    };
    const list = n.v as PNode[];
    const out: Line[] = [];

    if (items(list).length)
        out.push(line(namesIn(b, list), '', n));

    for (const g of list)
        if (g.k && Array.isArray(g.v))
            out.push(line(namesIn(b, g.v), ` · weight ${g.k}`, g));

    return out;
}

/** Dynasty names: `dynn_x`, or `{ dynnp_von dynn_x }` with a prefix. */
function dynastyNames(b: StoryBuilder, n: PNode): string[]
{
    return (Array.isArray(n.v) ? n.v : []).flatMap((c) =>
    {
        if (c.k !== null)
            return [];

        if (typeof c.v === 'string')
            return [dynastyWord(b, c.v)];

        return [items(c).map((x) => dynastyWord(b, x.v as string)).join('')];
    });
}

/**
 * A name list (culture/name_lists/_name_lists.info): its names (counts and samples), dynasty names, naming customs
 * (after whom children are named, patronyms, dynasties named after places) and mercenary company names.
 */
const nameList: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const count = (k: string): number =>
    {
        const n = body.find((c) => c.k === k && Array.isArray(c.v));
        return n ? (k.includes('dynasty') ? dynastyNames(b, n).length : allNames(n).length) : 0;
    };
    const facts: [string, string][] = [
        ['male_names', 'men’s names'],
        ['female_names', 'women’s names'],
        ['dynasty_names', 'dynasty names']
    ];

    for (const [k, label] of facts)
    {
        const n = count(k);

        if (n)
            card.facts.push([`${n} ${label}`]);
    }

    for (const c of body)
        if (c.k && NAME_BLOCKS[c.k] && Array.isArray(c.v))
            card.sections.push({ title: NAME_BLOCKS[c.k], lines: nameLines(b, c, ctx), src: b.blockSection(c, 'other', ctx) });

    const dyn: Line[] = [];

    for (const c of body)
    {
        if ((c.k !== 'dynasty_names' && c.k !== 'cadet_dynasty_names') || !Array.isArray(c.v))
            continue;

        const names = dynastyNames(b, c);
        const l = statementLine(b, c, ctx, rich(c.k === 'dynasty_names' ? 'Dynasties: ' : 'Cadet branches: ', { text: String(names.length), kind: 'value' }, ` — ${sample(names, 10)}`));

        if (names.length > 10)
        {
            l.children = [{ text: [names.join(', ')] }];
            l.collapsed = true;
        }

        dyn.push(l);
    }

    if (dyn.length)
        card.sections.push({ title: 'Dynasty names', lines: dyn });

    const customs: Line[] = [];

    for (const c of body)
    {
        if (!c.k || typeof c.v !== 'string')
            continue;

        const a = AFFIX[c.k];

        if (a)
        {
            const part: RichSeg = { text: dynastyWord(b, c.v), kind: 'value', tip: c.v };
            const who: RichSeg = { text: a[2], kind: 'ph' };
            customs.push(statementLine(b, c, ctx, rich(a[0], ': “', a[1] === 'before' ? [part, who] : [who, part], '”'), 'culture/name_lists'));
        }
        else
            customs.push(...b.fieldLines('culture/name_lists', [c], ctx));
    }

    if (customs.length || card.src)
        card.sections.push({ title: 'Naming customs', lines: customs, src: own('field', 'culture/name_lists') });

    const merc = body.find((c) => c.k === 'mercenary_names' && Array.isArray(c.v));

    if (merc)
    {
        const names = (merc.v as PNode[]).map((m) => (Array.isArray(m.v) ? scalar(m.v, 'name') : undefined)).filter((x): x is string => !!x);
        card.sections.push({ title: 'Mercenary companies', lines: [statementLine(b, merc, ctx, [sample(names.map((x) => word(b, x)), 8)], undefined, { icon: 'note' })] });
    }

    b.genericSections(
        e,
        body,
        card,
        ctx,
        own,
        new Set([...body.map((c) => c.k ?? '').filter((k) => k.endsWith('_names') || k.endsWith('_chance') || AFFIX[k]), 'founder_named_dynasties', 'house_based_map_names', 'suggest_family_names', 'suggest_ancestor_names', 'always_use_patronym', 'dynasty_name_first', 'grammar_transform'])
    );
    return true;
};

/**
 * A name equivalency (culture/name_equivalency/_info.info): spellings of one name across cultures — a character
 * changing culture takes the new culture's form. The key ends in `_female` for women's names, else men's.
 */
const nameEquivalency: CardFn = (b, { e, body, card, ctx }) =>
{
    const female = e.name.endsWith('_female');
    card.title = titleCase(humanize(e.name.replace(/_(male|female)$/, '')));
    card.facts.push([female ? 'Women’s name' : 'Men’s name']);
    card.description ??= ['A character who changes culture takes the new culture’s form of the name.'];
    card.sections.push({ title: 'Forms of the name', lines: items(body).map((c) => statementLine(b, c, ctx, [word(b, c.v as string)], undefined, { icon: 'note' })) });
    return true;
};

/** What an era or innovation unlocks (culture/eras/_culture_eras.info, innovations/_culture_innovations.info). */
const UNLOCK: Record<string, [string, string]> = {
    unlock_building: ['the building', 'buildings'],
    unlock_maa: ['the men-at-arms', 'men_at_arms_types'],
    unlock_law: ['the law', 'laws'],
    unlock_decision: ['the decision', 'decisions'],
    unlock_casus_belli: ['the casus belli', 'casus_belli_types']
};

/** Men-at-arms stats of a `maa_upgrade`. */
const MAA_STATS: Record<string, string> = { damage: 'damage', toughness: 'toughness', pursue: 'pursuit', screen: 'screen', siege_value: 'siege value', max_size: 'regiment size' };

/** Unlocks, custom effect texts (loc keys) and men-at-arms upgrades as lines. */
function unlockLines(b: StoryBuilder, body: PNode[], ctx: Ctx, fields: string): Line[]
{
    const out: Line[] = [];

    for (const c of body)
    {
        if (!c.k)
            continue;

        const u = UNLOCK[c.k];

        if (u && typeof c.v === 'string')
            out.push(statementLine(b, c, ctx, rich('Unlocks ', u[0], ' ', b.d.ref(c.v, [u[1]])), fields, { icon: 'note' }));
        else if (c.k === 'custom' && typeof c.v === 'string')
            out.push(statementLine(b, c, ctx, gameText(b, c.v) ?? [humanize(c.v)], fields, { icon: 'note' }));
        else if (c.k === 'maa_upgrade' && Array.isArray(c.v))
        {
            const t = scalar(c.v, 'type') ?? scalar(c.v, 'men_at_arms');
            const stats = c.v.filter((x) => x.k && MAA_STATS[x.k] && typeof x.v === 'string').map((x) => `${signed(parseFloat(x.v as string))} ${MAA_STATS[x.k!]}`);
            out.push(statementLine(b, c, ctx, rich(t ? b.d.ref(t, ['men_at_arms_types']) : 'Men-at-arms', ': ', stats.join(', ')), undefined, { icon: 'modifier', tone: 'good' }));
        }
    }

    return out;
}

/** A region key (`world_europe_north`) by its name in game, else made readable. */
function regionSeg(b: StoryBuilder, key: string): RichSeg
{
    return { text: b.idx.plainLoc(key)?.trim() || titleCase(humanize(key.replace(/^(world|custom|ghw_region)_/, ''))), kind: 'value', tip: key };
}

const INNOVATION_SKIP = new Set(['culture_era', 'group', 'skill', 'region', 'flag', 'icon', 'custom', 'maa_upgrade', 'parameters', 'asset', 'can_progress', 'ai_weight_for_fascination', 'ai_weight_for_spread', ...Object.keys(UNLOCK)]);

/**
 * An innovation (culture/innovations/_culture_innovations.info): era, group, region, what it brings (unlocks, custom
 * texts, parameters in the game's words `culture_parameter_<name>`, men-at-arms upgrades), its culture-specific
 * names, when it can progress; modifiers and conditions follow, the AI's fascination weight last.
 */
const innovation: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const era = scalar(body, 'culture_era');

    if (era)
        card.facts.push(rich('Era: ', b.d.ref(era, ['culture/eras'])));

    const group = scalar(body, 'group');

    if (group)
        card.facts.push([`${word(b, group)} innovation`]);

    const region = scalar(body, 'region');

    if (region)
        card.facts.push(rich('Only in ', regionSeg(b, region)));

    const settings = own('field', 'culture/innovations');
    const params = body.find((c) => c.k === 'parameters' && Array.isArray(c.v));
    const brings = [...unlockLines(b, body, ctx, 'culture/innovations'), ...(params ? paramLines(b, params.v as PNode[], ctx, 'culture_parameter_') : [])];
    card.sections.push({ title: 'What it brings', lines: brings, src: settings });
    // asset = { trigger = { … } name = key icon = path }: the first whose trigger the culture meets styles the name and icon
    const assets = body
        .filter((c) => c.k === 'asset' && Array.isArray(c.v))
        .map((c) =>
        {
            const kids = c.v as PNode[];
            const name = scalar(kids, 'name');
            const trigger = block(kids, 'trigger');
            const text = rich(name ? rich('Called ', { text: word(b, name), kind: 'value', tip: name }) : 'Its own icon', name && scalar(kids, 'icon') ? ', with its own icon' : '');
            return statementLine(b, c, ctx, text, undefined, { icon: 'note', conditions: trigger ? b.d.triggers(trigger, ctx) : undefined });
        });

    if (assets.length)
        card.sections.push({ title: 'For some cultures', lines: assets });

    const progress = body.find((c) => c.k === 'can_progress' && Array.isArray(c.v));

    if (progress)
        card.sections.push({ title: 'Can progress when', lines: b.d.triggers(progress.v as PNode[], ctx), src: b.blockSection(progress, 'trigger', ctx) });

    const lines: Line[] = [];

    for (const c of body)
    {
        if (typeof c.v !== 'string')
            continue;

        let text: Rich | undefined;

        if (c.k === 'culture_era')
            text = rich('Era: ', b.d.ref(c.v, ['culture/eras']));
        else if (c.k === 'group')
            text = [`Group: ${word(b, c.v)}`];
        else if (c.k === 'skill')
            text = [`Fascination uses the head of culture’s ${word(b, c.v)}`];
        else if (c.k === 'region')
            text = rich('Only progresses in ', regionSeg(b, c.v));
        else if (c.k === 'flag')
            text = rich('Flag: ', { text: humanize(c.v), kind: 'value', tip: c.v });

        if (text)
            lines.push(statementLine(b, c, ctx, text, 'culture/innovations'));
    }

    card.sections.push({ title: 'Settings', lines, src: settings });
    b.genericSections(e, body, card, ctx, own, INNOVATION_SKIP);
    const ai = aiSection(b, body, ctx, { ai_weight_for_fascination: 'Fascination weight (the AI head of culture):', ai_weight_for_spread: 'Weight when spreading it:' });

    if (ai)
        card.sections.push(ai);

    return true;
};

/**
 * An era (culture/eras/_culture_eras.info): the year its innovations start spreading, governments that can't use
 * them, what it brings, its innovations; modifiers follow.
 */
const era: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const year = scalar(body, 'year');

    if (year)
        card.facts.push([year === '0' ? 'From the start' : `From ${year}`]);

    const innovations = b.idx.incomingSources(e).filter((s) => s.entity.type === 'culture/innovations' && s.contexts.includes('culture_era'));

    if (innovations.length)
        card.facts.push([`${innovations.length} innovations`]);

    const settings = own('field', 'culture/eras');
    const lines: Line[] = [];

    for (const c of body)
    {
        if (c.k === 'year' && typeof c.v === 'string')
            lines.push(...b.fieldLines('culture/eras', [c], ctx));
        else if (c.k === 'invalid_for_government' && typeof c.v === 'string')
            lines.push(statementLine(b, c, ctx, rich('Not for rulers with the government ', b.d.ref(c.v, ['governments'])), 'culture/eras'));
    }

    card.sections.push({ title: 'Settings', lines, src: settings });
    card.sections.push({ title: 'What it brings', lines: unlockLines(b, body, ctx, 'culture/eras'), src: settings });

    if (innovations.length)
    {
        const rows = innovations.map((s) =>
        {
            const group = scalar(bodyOf(b, s.entity), 'group');
            return { text: rich(b.d.entitySeg(s.entity), group ? { text: ` · ${word(b, group)}`, kind: 'ph' } : ''), icon: 'note' };
        });
        card.sections.push({ title: 'Innovations', lines: rows });
    }

    b.genericSections(e, body, card, ctx, own, new Set(['year', 'invalid_for_government', 'custom', 'maa_upgrade', ...Object.keys(UNLOCK)]));
    return true;
};

/** Portrait colours of an ethnicity: weighted areas `{ x0 y0 x1 y1 }` of gfx/portraits/<skin|eye|hair>_palette.dds. */
const COLOURS: Record<string, string> = { skin_color: 'Skin colour', eye_color: 'Eye colour', hair_color: 'Hair colour' };

/** Options of a gene or colour: `<weight> = { … }` (weight 0: only by trait, e.g. beauty). */
function options(n: PNode): { w: number; o: PNode[]; }[]
{
    return (Array.isArray(n.v) ? n.v : []).filter((c) => c.k && /^\d+(\.\d+)?$/.test(c.k) && Array.isArray(c.v)).map((c) => ({ w: parseFloat(c.k!), o: c.v as PNode[] }));
}

/**
 * An ethnicity (common/ethnicities, portraits: docs/portraits.md): the template it builds on, its colours (weighted
 * palette areas) and the genes it sets — each with its options' gene templates.
 */
const ethnicity: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const template = scalar(body, 'template');

    if (template)
        card.facts.push(rich('Based on ', b.d.ref(template, ['ethnicities'])));

    if (scalar(body, 'visible') === 'no')
        card.facts.push(['Hidden — a template for others']);

    const genes = body.filter((c) => c.k && !COLOURS[c.k] && options(c).length);

    if (genes.length)
        card.facts.push([`Sets ${genes.length} gene${genes.length === 1 ? '' : 's'}`]);

    const settings: Line[] = [];

    for (const c of body)
    {
        if (c.k === 'template' && typeof c.v === 'string')
            settings.push(statementLine(b, c, ctx, rich('Based on ', b.d.ref(c.v, ['ethnicities'])), 'ethnicities'));
        else if (c.k === 'using' && typeof c.v === 'string')
            settings.push(statementLine(b, c, ctx, rich('Using: ', { text: word(b, c.v), kind: 'value', tip: c.v })));
        else if (c.k === 'visible' && typeof c.v === 'string')
            settings.push(...b.fieldLines('ethnicities', [c], ctx));
    }

    card.sections.push({ title: 'Settings', lines: settings, src: own('field', 'ethnicities') });
    const colours = body
        .filter((c) => c.k && COLOURS[c.k] && Array.isArray(c.v))
        .map((c) =>
        {
            const opts = options(c);
            const total = opts.reduce((s, x) => s + x.w, 0);
            const children: Line[] = opts.map(({ w, o }) =>
            {
                const n = items(o).map((x) => x.v as string);
                return { text: rich({ text: total ? `${formatNumber(Math.round((1000 * w) / total) / 10)}%` : String(w), kind: 'value' }, n.length >= 4 ? ` — palette x ${n[0]}–${n[2]}, y ${n[1]}–${n[3]}` : '') };
            });
            return statementLine(b, c, ctx, [`${COLOURS[c.k!]}: ${opts.length} area${opts.length === 1 ? '' : 's'} of its palette`], undefined, { icon: 'note', children, collapsed: true });
        });

    if (colours.length)
        card.sections.push({ title: 'Colours', lines: colours });

    if (genes.length)
    {
        const lines = genes.map((c) =>
        {
            const opts = options(c).filter((x) => x.w > 0);
            const templates = [...new Set(opts.map((x) => scalar(x.o, 'name')).filter((x): x is string => !!x))];
            return statementLine(b, c, ctx, rich(b.d.ref(c.k!, ['genes']), { text: ` · ${opts.length} option${opts.length === 1 ? '' : 's'}${templates.length ? ': ' + templates.map((t) => humanize(t)).join(', ') : ''}`, kind: 'ph' }));
        });
        card.sections.push({ title: 'Genes', lines });
    }

    b.genericSections(e, body, card, ctx, own, new Set(['template', 'using', 'visible', ...genes.map((c) => c.k!), ...Object.keys(COLOURS)]));
    return true;
};

/**
 * A graphical unit type (graphical_unit_types/_graphical_unit_types.info): the levy and knight pictures (named like
 * the key) for cultures whose unit graphics it lists — a culture takes the first of its keys that one lists.
 */
const unitType: CardFn = (b, { e, body, card, ctx, own }) =>
{
    card.facts.push(['Pictures of levies and knights']);
    const list = body.find((c) => c.k === 'graphical_cultures' && Array.isArray(c.v));

    if (list)
        card.sections.push({ title: 'For the unit graphics', lines: items(list).map((c) => statementLine(b, c, ctx, [gfxSeg(b, c.v as string)], undefined, { icon: 'note' })), src: b.blockSection(list, 'other', ctx) });

    const by = unitTypes(b);
    const users: RichSeg[] = [];

    for (const name of b.idx.names('culture/cultures'))
    {
        const c = b.idx.get('culture/cultures', name)!;

        if (unitTypeOf(by, items(block(bodyOf(b, c), 'unit_gfx')).map((x) => x.v as string)) === e.name)
            users.push(b.d.entitySeg(c));
    }

    if (users.length)
        card.sections.push({ title: 'Cultures', lines: [{ text: rich(`${users.length}: `, joined(users.slice(0, 40), ', '), users.length > 40 ? ` … and ${users.length - 40} more` : '') }] });

    b.genericSections(e, body, card, ctx, own, new Set(['graphical_cultures']));
    return true;
};

/**
 * A tradition or pillar (culture/_cultural_traits.info): its category or type, what its parameters do in the game's
 * words (`culture_parameter_<name>`), modifiers for faiths with a doctrine, when a hybrid can pick it; cost, conditions
 * and modifiers follow, the AI's weight last.
 */
const culturalTrait: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const kind = scalar(body, 'category') ?? scalar(body, 'type');

    if (kind)
        card.facts.push([`${capitalize(humanize(kind))} ${e.type === 'culture/traditions' ? 'tradition' : 'pillar'}`]);

    const params = body.find((c) => c.k === 'parameters' && Array.isArray(c.v));
    const head = body.find((c) => c.k === 'head_determination_type' && typeof c.v === 'string');
    const does = [...(head ? [statementLine(b, head, ctx, [`The head of culture is ${HEAD[head.v as string] ?? humanize(head.v as string)}`], undefined, { icon: 'note' })] : []), ...(params ? paramLines(b, params.v as PNode[], ctx, 'culture_parameter_') : [])];

    if (does.length)
        card.sections.push({ title: 'What it does', lines: does, src: params && b.blockSection(params, 'other', ctx) });

    const color = body.find((c) => c.k === 'color');

    if (color)
        card.sections.push({ title: 'Look', lines: [statementLine(b, color, ctx, rich('Map colour: ', colorSeg(b, color)))] });

    const doctrines = doctrineModifierLines(b, body, ctx);

    if (doctrines.length)
        card.sections.push({ title: 'With a doctrine', lines: doctrines });

    const hybrid = body.find((c) => c.k === 'can_pick_for_hybridization' && Array.isArray(c.v));

    if (hybrid)
        card.sections.push({ title: 'Can be picked for a hybrid when', lines: b.d.triggers(hybrid.v as PNode[], ctx), src: b.blockSection(hybrid, 'trigger', ctx) });

    b.genericSections(e, body, card, ctx, own, new Set(['category', 'type', 'parameters', 'head_determination_type', 'color', 'doctrine_character_modifier', 'can_pick_for_hybridization', 'ai_will_do']));
    const ai = aiSection(b, body, ctx, { ai_will_do: 'Weight when the AI picks it:' });

    if (ai)
        card.sections.push(ai);

    return true;
};

export const CULTURE_CARDS: Record<string, CardFn> = {
    'culture/cultures': culture,
    'culture/traditions': culturalTrait,
    'culture/pillars': culturalTrait,
    'culture/name_lists': nameList,
    'culture/name_equivalency': nameEquivalency,
    'culture/innovations': innovation,
    'culture/eras': era,
    ethnicities: ethnicity,
    graphical_unit_types: unitType,
    ...FAITH_CARDS,
    ...DYNASTY_CARDS
};
