/**
 * Cards of texts and names: game concepts, messages and their filters and groups, customizable localization, effect and
 * trigger localization, flavorization (the names of titles), modifier formats.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { rootCtx } from '../describer.ts';
import { capitalize, humanize, rich, titleCase } from '../text.ts';
import { entryLines, firstValidLines, join, kids, membersBy, note, pictureSeg, settingLines, str, values } from './presentation-util.ts';

/** `$VALUE|+0$` template parameters as italic placeholders ("value"). */
function withParams(r: Rich): Rich
{
    return r.flatMap((s) =>
    {
        if (typeof s !== 'string' || !s.includes('$'))
            return [s];

        return s
            .split(/(\$[A-Za-z_]+(?:\|[^$]*)?\$)/)
            .filter(Boolean)
            .map((p) => (/^\$[A-Za-z_]/.test(p) ? note(humanize(p.slice(1, -1).replace(/\|.*$/, '')), p) : p));
    });
}

/** A text by its key in quotes, its codes as placeholders; a missing one as the key, marked. */
function locText(b: StoryBuilder, key: string): Rich
{
    const t = b.d.loc(key);
    return t ? rich('“', withParams(t), '”') : rich({ text: key, kind: 'code' }, ' ', note('(no text)'));
}

/**
 * A message filter or group by its name in game (`message_filter_<key>`, `message_group_type_<key>`; the index names
 * them by the key, or by a loc key of the same name: "court").
 */
function messageSeg(b: StoryBuilder, type: string, key: string): Exclude<RichSeg, string>
{
    const e = b.idx.get(type, key);
    const t = b.idx.plainLoc(`${type === 'message_filter_types' ? 'message_filter_' : 'message_group_type_'}${key}`);
    const text = t ? b.d.plainText(t).trim() : capitalize(humanize(key));
    return e ? { text, kind: 'entity', ref: { type: e.type, name: e.name }, tip: key } : { text, kind: 'code', tip: key };
}

/** What the placeholder-only texts of messages stand for (`event_message_title` = "$TITLE$" …: send_interface_message's). */
const MESSAGE_PARTS: Record<string, string> = { TITLE: 'the title the sending effect gives', DESCRIPTION: 'the text the sending effect gives', EFFECT: 'what the sending effect does' };

/** A message's texts: key, label, the default key's suffix to the message's key (_messages.info). */
const MESSAGE_TEXTS: [string, string, string?][] = [
    ['title', 'Title', ''],
    ['desc', 'Text', '_desc'],
    ['tooltip', 'Tooltip']
];

/** A message text: the loc text, or — only `$TITLE$` / `$DESCRIPTION$` / `$EFFECT$` — what fills it in. */
function messageText(b: StoryBuilder, key: string): Rich
{
    const raw = b.idx.locRaw(key);
    const parts = raw !== undefined && /^(\s|\\n|\$(TITLE|DESCRIPTION|EFFECT)\$)*$/.test(raw) ? [...raw.matchAll(/\$(\w+)\$/g)].map((m) => MESSAGE_PARTS[m[1]]) : [];
    return parts.length ? [note(capitalize(parts.join(', then ')), key)] : locText(b, key);
}

/** The texts of a customizable localization's `text = { trigger localization_key fallback setup_scope }` entries. */
function customTexts(b: StoryBuilder, texts: PNode[], ctx: Ctx, suffix: string, random: boolean): Line[]
{
    return firstValidLines(
        b,
        texts,
        ctx,
        (list) =>
        {
            const key = str(list, 'localization_key');
            const setup = list.find((c) => c.k === 'setup_scope');
            return {
                text: rich(key ? locText(b, key + suffix) : '(no text)', str(list, 'fallback') === 'yes' ? rich(' ', note('— when none fits')) : ''),
                tip: key && `localization_key = ${key}${suffix ? ` (+ ${suffix})` : ''}`,
                children: setup ? b.d.effects(kids(setup), ctx) : undefined,
                // (✎ text in a mod's entry)
                ...(key ? { locKey: key + suffix } : {})
            };
        },
        random
    );
}

/** Effect / trigger localization keys: `global|first|third|none` + `_past` / `_neg` / `_not` (the .info files). */
const PERSON: Record<string, string> = { global: 'Plain', first: 'You', third: 'Someone', none: 'They' };

/** `third_past_neg` → "Someone, past, for a loss" */
function variantLabel(k: string): string | undefined
{
    const m = /^(global|first|third|none)((?:_past|_neg|_not)*)$/.exec(k);

    if (!m)
        return undefined;

    const how = [m[2].includes('_past') && 'past', m[2].includes('_neg') && 'for a loss', m[2].includes('_not') && 'negated'].filter(Boolean);
    return [PERSON[m[1]], ...how].join(', ');
}

/**
 * The texts of an effect_localization / trigger_localization entry, one line per variant (a `_category = { … }` group
 * holds entries). A trigger's variant without its own `_not` is negated by the key `NOT_<key>`
 * (_trigger_localization.info) — shown too, when it has a text.
 */
function variantLines(b: StoryBuilder, body: PNode[], ctx: Ctx, trigger: boolean): Line[]
{
    const out: Line[] = [];

    for (const c of body)
    {
        if (c.k && Array.isArray(c.v))
            out.push({ text: [capitalize(humanize(c.k)) + ':'], children: variantLines(b, c.v, ctx, trigger), src: b.d.anchor(c, ctx, 'other', true) });

        if (!c.k || typeof c.v !== 'string')
            continue;

        const label = variantLabel(c.k);
        const l: Line = { text: rich(label ?? capitalize(humanize(c.k)), ': ', locText(b, c.v)), tip: `${c.k} = ${c.v}`, locKey: c.v };

        if (ctx.file)
            l.src = b.d.anchor(c, ctx, 'other', false);

        out.push(l);

        if (trigger && label && !c.k.endsWith('_not') && !body.some((x) => x.k === `${c.k}_not`) && b.idx.locRaw(`NOT_${c.v}`) !== undefined)
            out.push({ text: rich(`${label}, negated: `, locText(b, `NOT_${c.v}`)), tip: `NOT_${c.v} (the negation of ${c.v})`, locKey: `NOT_${c.v}` });
    }

    return out;
}

/** Who a flavorization's name is for, in a few words: "Male children of kingdom-tier rulers". */
function flavorFor(list: PNode[]): string
{
    const type = str(list, 'type') ?? 'character';
    const tier = str(list, 'tier');
    // (named titles: "the listed")
    const t = tier && tier !== 'none' ? `${tier}-tier ` : list.some((c) => c.k === 'titles' || c.k === 'de_jure_liege') ? 'the listed ' : '';

    if (type === 'title')
        return `Name of ${t || 'any '}titles`;

    if (type === 'domicile')
        return 'Name of a domicile';

    const g = str(list, 'gender') === 'female' ? 'female ' : str(list, 'gender') === 'male' ? 'male ' : '';

    switch (str(list, 'special') ?? 'holder')
    {
        case 'ruler_child':
            return capitalize(`${g}children of ${t}rulers`);
        case 'queen_mother':
            return capitalize(`${g}mothers of child ${t}rulers`);
        case 'head_of_faith':
            return capitalize(`${g}heads of faith`) + (t ? ` (${t}title)` : '');
        case 'councillor':
            return capitalize(`${g}councillors`) + (t ? ` (${t}realm)` : '');
        case 'domicile':
            return capitalize(`${g}characters with a domicile`);
    }

    return capitalize(`${g}holders of ${t || 'any '}titles`);
}

/** The lists a flavorization checks on the character whose title counts: what each is called, the type it names. */
const FLAVOR_LISTS: [string, string, string?][] = [
    ['governments', 'Government:', 'governments'],
    ['heritages', 'Culture heritage:', 'culture/pillars'],
    ['name_lists', 'Culture name list:', 'culture/name_lists'],
    ['religions', 'Religion:', 'religion/religion_types'],
    ['faiths', 'Faith:', 'faith'],
    ['titles', 'The title is', 'landed_titles'],
    ['de_jure_liege', 'The title is de jure under', 'landed_titles'],
    ['subject_contract_obligation_flags', 'A contract obligation flagged']
];

export const TEXT_CARDS: Record<string, CardFn> = {
    // common/game_concepts: name game_concept_<key>, text …_desc (the card's), `alias = { … }` more keys with names of their own
    game_concepts: (b, { e, body, card, ctx, own }) =>
    {
        const seen = new Set([card.title.toLowerCase()]);
        const aliases: RichSeg[] = [];

        for (const a of values(body.find((c) => c.k === 'alias')))
        {
            // (possessive and icon forms are the same word)
            if (/possessive$|_i$/.test(a))
                continue;

            const t = b.idx.plainLoc(`game_concept_${a}`);
            const text = t ? b.d.plainText(t).trim() : capitalize(humanize(a));

            if (seen.has(text.toLowerCase()))
                continue;

            seen.add(text.toLowerCase());
            aliases.push({ text, kind: 'value', tip: `[${a}|E]` });
        }

        if (aliases.length)
            card.facts.push(rich('Also called ', join(aliases)));

        const parent = str(body, 'parent');

        if (parent)
            card.facts.push(rich('Part of ', b.d.ref(parent, ['game_concepts'])));

        const dlc = str(body, 'requires_dlc_flag');

        if (dlc)
            card.facts.push([`Needs ${titleCase(humanize(dlc))}`]);

        card.facts.push(rich('In texts: ', { text: `[${e.name}|E]`, kind: 'code', tip: 'A localization text links the concept with this code' }));
        const narrower = membersBy(b, e.type, 'parent').get(e.name);

        if (narrower)
            card.sections.push({ title: 'Related', lines: [{ text: rich('More specific: ', join(narrower.map((x) => b.d.entitySeg(x)), ', ')), icon: 'note' }] });

        const show = (k: string, v: string): Rich | undefined =>
        {
            if (k === 'texture')
                return rich('Icon: ', pictureSeg(b, v, e.type));

            return k === 'requires_dlc_flag' ? rich('Needs the DLC feature ', { text: titleCase(humanize(v)), kind: 'value', tip: v }) : undefined;
        };
        const settings = settingLines(b, e.type, body, ctx, show);
        card.sections.push({ title: 'Settings', lines: settings, src: own('field', e.type) });
        return true;
    },
    // common/messages/_messages.info: texts default to the key and <key>_desc
    messages: (b, { e, body, card, ctx, own }) =>
    {
        const style = str(body, 'style') ?? 'neutral';
        card.facts.push([{ text: `${capitalize(style)} news`, kind: style === 'good' ? 'good' : style === 'bad' ? 'bad' : 'value' }]);
        card.facts.push([str(body, 'display') === 'toast' ? 'Pops up as a toast' : 'In the message feed']);
        const filter = str(body, 'message_filter_type');

        if (filter)
            card.facts.push(rich('Filter: ', messageSeg(b, 'message_filter_types', filter)));

        const texts: Line[] = [];

        for (const [k, label, dflt] of MESSAGE_TEXTS)
        {
            const n = body.find((c) => c.k === k && typeof c.v === 'string');
            const key = (n?.v as string | undefined) ?? (dflt === undefined ? undefined : e.name + dflt);

            if (!key || (!n && b.idx.locRaw(key) === undefined))
                continue;

            const l: Line = { text: rich(label, ': ', messageText(b, key)), tip: n ? `${k} = ${key}` : `${key} (the default)`, locKey: key };

            if (n && ctx.file)
                l.src = b.fieldAnchor(n, ctx, e.type);

            texts.push(l);
            // (the card is named by its title: another key's when it names one — unless that is filled in by the effect)
            const t = k === 'title' && n && !/\$(TITLE|DESCRIPTION|EFFECT)\$/.test(b.idx.locRaw(key) ?? '$TITLE$') ? b.idx.plainLoc(key) : undefined;

            if (t?.trim())
                card.title = b.d.plainText(t).trim();
        }

        // (the texts are the section below)
        card.description = undefined;
        card.sections.push({ title: 'What it says', lines: texts, src: own('field', e.type) });
        const rest = body.filter((c) => c.k !== 'title' && c.k !== 'desc' && c.k !== 'tooltip');
        const show = (k: string, v: string): Rich | undefined =>
        {
            if (k === 'message_filter_type')
                return rich('Filter: ', messageSeg(b, 'message_filter_types', v));

            const img = k === 'icon' ? b.idx.resolveImageName(v.replace(/\.dds$/i, ''), e.type, false) : undefined;
            return img ? rich('Icon: ', pictureSeg(b, img.name, e.type)) : undefined;
        };
        card.sections.push({ title: 'Settings', lines: settingLines(b, e.type, rest, ctx, show), src: own('field', e.type) });
        return true;
    },
    // common/message_filter_types: name message_filter_<key>, text …_desc
    message_filter_types: (b, { e, body, card, ctx, own }) =>
    {
        card.title = messageSeg(b, e.type, e.name).text || card.title;
        card.description = b.d.loc(`message_filter_${e.name}_desc`) ?? card.description;
        const display = str(body, 'display') ?? 'feed';
        card.facts.push([display === 'toast' ? 'Pops up as a toast' : display === 'hidden' ? 'Not shown' : 'In the message feed']);

        if (str(body, 'always_show') === 'yes')
            card.facts.push(['Cannot be hidden']);

        if (str(body, 'auto_pause') === 'yes')
            card.facts.push(['Pauses the game']);

        // (without a group: the settings window's default one — _message_filter_types.info says misc, the game's groups have default)
        const group = str(body, 'group');
        card.facts.push(group ? rich('Group: ', messageSeg(b, 'message_group_types', group)) : ['No group set']);
        const show = (k: string, v: string): Rich | undefined => (k === 'group' ? rich('In the group ', messageSeg(b, 'message_group_types', v)) : undefined);
        const members = membersBy(b, 'messages', 'message_filter_type').get(e.name);

        if (members)
            card.sections.push({ title: `Messages (${members.length})`, lines: entryLines(b, members, 'note') });

        card.sections.push({ title: 'Settings', lines: settingLines(b, e.type, body, ctx, show), src: own('field', e.type) });
        return true;
    },
    // common/message_group_types: a foldable group of filters in the message settings
    message_group_types: (b, { e, body, card, ctx, own }) =>
    {
        card.title = messageSeg(b, e.type, e.name).text || card.title;
        const filters = membersBy(b, 'message_filter_types', 'group').get(e.name) ?? [];
        card.facts.push([`${filters.length} filter${filters.length === 1 ? '' : 's'}`]);

        if (filters.length)
            card.sections.push({ title: 'Filters', lines: filters.map((f) => ({ text: [messageSeg(b, 'message_filter_types', f.name)] })) });

        card.sections.push({ title: 'Settings', lines: settingLines(b, e.type, body, ctx), src: own('field', e.type) });
        return true;
    },
    // common/customizable_localization/_custom_loc.info: `[<scope>.Custom('<key>')]` in a text picks one of its texts
    customizable_localization: (b, { e, body, card, ctx, own }) =>
    {
        const type = str(body, 'type');
        const sctx = { ...ctx, scopeType: type && type !== 'all' ? type : undefined };
        card.facts.push(rich('In texts: ', { text: !type || type === 'character' ? `[ROOT.Char.Custom('${e.name}')]` : `[<${type === 'all' ? 'scope' : type}>.Custom('${e.name}')]`, kind: 'code', tip: 'How a localization text uses it, on the scope it runs on' }));
        let texts = body.filter((c) => c.k === 'text' && Array.isArray(c.v));
        let random = str(body, 'random_valid') === 'yes';
        let lines = customTexts(b, texts, sctx, '', random);
        // a variant: its parent's texts, each key with the suffix added
        const parent = str(body, 'parent');
        const p = parent && !texts.length ? b.idx.get(e.type, parent) : undefined;
        const pd = p && b.idx.defNode(p);

        if (pd)
        {
            const suffix = str(body, 'suffix') ?? '';
            texts = kids(pd.node).filter((c) => c.k === 'text' && Array.isArray(c.v));
            random = str(kids(pd.node), 'random_valid') === 'yes';
            lines = customTexts(b, texts, rootCtx(pd.src, undefined, sctx.scopeType), suffix, random);
            card.facts.push(rich('Picks like ', b.d.entitySeg(p), suffix ? `, then “${suffix}” is added to the text’s key` : ''));
        }

        card.facts.push([`${texts.length} text${texts.length === 1 ? '' : 's'}`]);
        card.sections.push({ title: random ? 'Texts — one of those that fit, at random' : 'Texts — the first that fits', lines, src: pd ? undefined : own('other') });
        card.sections.push({ title: 'Settings', lines: settingLines(b, e.type, body, ctx), src: own('field', e.type) });
        return true;
    },
    // common/effect_localization: the texts the game shows for an effect (engine or scripted)
    effect_localization: (b, { e, body, card, ctx, own }) =>
    {
        const se = b.idx.get('scripted_effects', e.name);
        card.facts.push(rich('Texts for ', se ? b.d.entitySeg(se) : { text: capitalize(humanize(e.name)), kind: 'code', tip: e.name }));
        card.sections.push({ title: 'Texts', lines: variantLines(b, body, ctx, false), src: own('other') });
        return true;
    },
    // common/trigger_localization: the texts of a condition (engine or scripted), or of a `custom_description = { text = <key> }`
    trigger_localization: (b, { e, body, card, ctx, own }) =>
    {
        const st = b.idx.get('scripted_triggers', e.name);
        card.facts.push(rich('Texts for ', st ? b.d.entitySeg(st) : { text: capitalize(humanize(e.name)), kind: 'code', tip: e.name }));
        card.sections.push({ title: 'Texts', lines: variantLines(b, body, ctx, true), src: own('other') });
        return true;
    },
    // common/flavorization/_flavourization.info: the name (loc key = the entry's key) of whoever fits, highest priority first
    flavorization: (b, { e, body, card, ctx, own }) =>
    {
        card.facts.push([flavorFor(body)]);
        const lines = settingLines(b, e.type, body, ctx);

        for (const [k, label, type] of FLAVOR_LISTS)
        {
            const n = body.find((c) => c.k === k && Array.isArray(c.v));

            if (!n)
                continue;

            const names = values(n).map((v): RichSeg => (type ? b.d.ref(v, [type]) : { text: humanize(v), kind: 'value', tip: v }));
            const l: Line = { text: rich(label, ' ', join(names, ' or ')), tip: `${k} = { ${values(n).join(' ')} }` };

            if (ctx.file)
                l.src = b.d.anchor(n, ctx, 'other', false);

            lines.push(l);
        }

        const rules = body.find((c) => c.k === 'flavourization_rules' && Array.isArray(c.v));

        if (rules)
        {
            const l: Line = { text: ['Rules:'], children: settingLines(b, 'flavourization_rules', kids(rules), ctx), tip: 'flavourization_rules' };

            if (ctx.file)
                l.src = b.fieldAnchor(rules, ctx, 'flavourization_rules', true);

            lines.push(l);
        }

        card.sections.push({ title: 'Who gets this name', lines, src: own('field', e.type) });
        return true;
    },
    // common/modifier_definition_formats/_definitions.info: how a (code-defined) modifier reads — name MOD_<KEY>
    modifier_definition_formats: (b, { e, body, card, ctx, own }) =>
    {
        const f = b.d.modifierFormat(e.name);
        card.title = f.label || card.title;
        // (`<key>_desc` is another entry's: diplomacy_desc is the diplomatic range)
        card.description = undefined;
        const ex = f.percent ? '0.1' : f.alreadyPercent ? '10' : f.decimals > 0 ? '0.5' : '2';
        const pos = b.d.statLine(e.name, ex);
        const neg = b.d.statLine(e.name, '-' + ex);

        if (pos && neg)
            card.facts.push(rich('Reads ', pos.text, ' or ', neg.text));
        else
            card.facts.push(['Hidden in game']);

        card.facts.push([f.color === 'neutral' ? 'Neither good nor bad' : f.color === 'bad' ? 'More is bad' : 'More is good']);
        const dlc = str(body, 'dlc_feature');

        if (dlc)
            card.facts.push([`Only with the DLC feature ${humanize(dlc)}`]);

        // (prefix / suffix are loc keys, mostly an icon)
        const show = (k: string, v: string): Rich | undefined =>
        {
            if (k === 'dlc_feature')
                return rich('Only with the DLC feature ', { text: humanize(v), kind: 'value', tip: v });

            if (!/suffix|prefix/.test(k))
                return undefined;

            const t = b.d.loc(v);
            return rich(capitalize(humanize(k)), ': ', t && b.d.richString(t).trim() ? rich('“', t, '”') : note('an icon', v));
        };
        card.sections.push({ title: 'Settings', lines: settingLines(b, e.type, body, ctx, show), src: own('field', e.type) });
        return true;
    }
};
