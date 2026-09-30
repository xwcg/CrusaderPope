/** Cards of the artifact definitions (common/artifacts/*): types, slots, templates, looks, reforging blueprints, features and their groups. */
import type { Entity } from '../../indexer/gameIndex.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { weightLines } from './weight.ts';
import { addSection, blockOf, charTriggers, commentLines, entries, joined, kids, settingsSection, str, triggerSection, words, type SettingValue } from './life-shared.ts';

/** An artifact slot type by its name (loc `artifact_slot_<type>`: primary_armament → "Weapon"). */
function slotTypeSeg(b: StoryBuilder, type: string): RichSeg
{
    return { text: b.d.richString(b.d.loc(`artifact_slot_${type}`) ?? [humanize(type)]), kind: 'value', tip: type };
}

/** An artifact type linked by the name loc `artifact_<key>` gives it (_types.info; its plain key loc is another word: `sword` = "sword sheath"). */
function typeSeg(b: StoryBuilder, name: string): RichSeg
{
    const seg = b.d.ref(name, ['artifacts/types']);
    const loc = b.idx.plainLoc(`artifact_${name}`);
    return loc && typeof seg !== 'string' && seg.kind === 'entity' ? { ...seg, text: capitalize(b.d.plainText(loc)) } : seg;
}

/** Artifact types as links; types sharing a name (six kinds of "Armor") by their keys instead. */
function typeLinks(b: StoryBuilder, names: string[]): RichSeg[]
{
    const segs = names.map((n) => typeSeg(b, n));
    const text = (s: RichSeg): string => (typeof s === 'string' ? s : s.text);
    return segs.map((s, i) => (typeof s !== 'string' && segs.some((o, j) => j !== i && text(o) === s.text) ? { ...s, text: capitalize(humanize(names[i])) } : s));
}

/** A slot linked with its number when its name has none (pedestal_1 … pedestal_4 are all called "Pedestal"). */
function slotSeg(b: StoryBuilder, e: Entity): RichSeg
{
    const seg = b.d.entitySeg(e);
    const n = /_(\d+)$/.exec(e.name)?.[1];
    return n && typeof seg !== 'string' && !seg.text.includes(n) ? { ...seg, text: `${seg.text} ${n}` } : seg;
}

/** Artifact types and slot types in the settings lines, by their names. */
function artifactValue(b: StoryBuilder): SettingValue
{
    return (v, f) => (f.ref === 'artifacts/types' ? typeSeg(b, v) : f.key === 'slot' || f.key === 'type' ? slotTypeSeg(b, v) : undefined);
}

/** One line listing entries as links, or nothing. */
function listLine(text: string, segs: RichSeg[]): Line[]
{
    return segs.length ? [{ text: rich(text, joined(segs)), icon: 'note' }] : [];
}

/** Links, one per line (at most 40, then how many more there are). */
function linkLines(segs: RichSeg[]): Line[]
{
    const out: Line[] = segs.slice(0, 40).map((s) => ({ text: [s], icon: 'note' }));

    if (segs.length > 40)
        out.push({ text: [`… and ${segs.length - 40} more`] });

    return out;
}

/** A static modifier by name with what it gives: "‹Artifact dread gain 1›: +10% Dread gain". */
function modifierWithStats(b: StoryBuilder, name: string): Rich
{
    const e = b.idx.get('modifiers', name);
    const stats = e ? b.d.modifierStats(e).map((l) => l.text) : [];
    return rich(b.d.ref(name, ['modifiers']), stats.length ? rich(': ', ...stats.flatMap((t, i) => (i ? [', ', ...t] : t))) : '');
}

export const ARTIFACT_CARDS: Record<string, CardFn> = {
    // common/artifacts/types/_types.info
    'artifacts/types': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        const title = typeSeg(b, e.name);

        if (typeof title !== 'string' && title.kind === 'entity')
            card.title = title.text;

        const slot = str(body, 'slot');

        if (slot)
            card.facts.push(rich('Goes into ', slotTypeSeg(b, slot), ' slots'));

        if (str(body, 'can_reforge') === 'yes')
            card.facts.push(['Can be reforged']);

        const features: Line[] = [];

        for (
            const [k, label] of [
                ['required_features', 'Always gets one of each: '],
                ['optional_features', 'Script can add one of each: ']
            ]
        )
        {
            const n = blockOf(body, k);

            if (n)
                features.push({ text: rich(label, joined(words(n).map((g) => b.d.ref(g, ['artifacts/feature_groups'])))), icon: 'note', tip: k, src: ctx.file ? b.d.anchor(n, ctx, 'other', false) : undefined });
        }

        addSection(card, 'Features', features);
        settingsSection(b, x, artifactValue(b));
        addSection(
            card,
            'Where it goes',
            listLine(
                'Fits the slots ',
                [...entries(b, 'artifacts/slots')].filter((s) => slot && str(s.body, 'type') === slot).map((s) => slotSeg(b, s.e))
            )
        );
        const reforge = [...entries(b, 'artifacts/blueprints')]
            .filter((bp) => str(bp.body, 'in_type') === e.name)
            .map((bp): Line => ({ text: rich(b.d.entitySeg(bp.e), ': into ', typeSeg(b, str(bp.body, 'out_type') ?? '?')), icon: 'note' }));
        addSection(card, 'Reforging', reforge);
        b.genericSections(e, body, card, ctx, x.own, new Set(['slot', 'required_features', 'optional_features', 'default_visuals', 'can_reforge']));
        return true;
    },

    // common/artifacts/slots: `type` (the slot type artifact types go into), `category` (inventory / court), `icon`
    'artifacts/slots': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        const own = slotSeg(b, e);

        if (typeof own !== 'string')
            card.title = own.text;

        const type = str(body, 'type');
        card.facts.push([str(body, 'category') === 'court' ? 'In the royal court' : 'In the inventory']);

        if (type)
            card.facts.push(rich('Holds ', slotTypeSeg(b, type)));

        settingsSection(b, x, artifactValue(b));
        addSection(card, 'Artifact types it holds', linkLines(typeLinks(b, [...entries(b, 'artifacts/types')].filter((t) => type && str(t.body, 'slot') === type).map((t) => t.e.name))));
        addSection(card, 'Slots of the same kind', listLine('', [...entries(b, 'artifacts/slots')].filter((s) => s.e !== e && type && str(s.body, 'type') === type).map((s) => slotSeg(b, s.e))));
        b.genericSections(e, body, card, ctx, x.own, new Set(['type', 'category', 'icon']));
        return true;
    },

    // common/artifacts/templates/_templates.info: root is the character, scope:artifact the artifact
    'artifacts/templates': (b, x) =>
    {
        const { e, body, card, ctx } = x;

        if (str(body, 'unique') === 'yes')
            card.facts.push(['Unique']);

        triggerSection(b, card, blockOf(body, 'can_equip'), 'Can be equipped by', ctx, 'Anyone');
        triggerSection(b, card, blockOf(body, 'can_benefit'), 'Gives its full modifiers to', ctx, 'Everyone');
        const fallback = blockOf(body, 'fallback');

        if (fallback)
        {
            const lines = b.d.statsOf(kids(fallback), ctx);

            if (!lines.length)
                lines.push({ text: ['Nothing'], icon: 'note' });

            addSection(card, 'Gives the others instead', lines, b.blockSection(fallback, 'modifier', ctx));
        }

        triggerSection(b, card, blockOf(body, 'can_repair'), 'Can be repaired by', ctx, 'Anyone');
        triggerSection(b, card, blockOf(body, 'can_reforge'), 'Can be reforged by', ctx, 'Anyone');
        settingsSection(b, x);
        b.genericSections(e, body, card, ctx, x.own, new Set(['can_equip', 'can_benefit', 'fallback', 'can_repair', 'can_reforge', 'unique', 'ai_score']));
        const ai = blockOf(body, 'ai_score');

        if (ai)
            addSection(card, 'AI', weightLines(b, kids(ai), ctx));

        return true;
    },

    // common/artifacts/visuals/_visuals.info: icons and 3D assets, each plain or `{ trigger = { … } reference = … }` (a valid one is picked)
    'artifacts/visuals': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        const def = str(body, 'default_type');

        if (def)
            card.facts.push(rich('For ', typeSeg(b, def)));

        const looks: Line[] = [];

        for (const c of body)
        {
            if (c.k !== 'icon' && c.k !== 'asset')
                continue;

            const ref = typeof c.v === 'string' ? c.v : str(c.v, 'reference');

            if (!ref)
                continue;

            const img = c.k === 'icon' ? b.idx.resolveImagePath(ref, e.type) : undefined;
            const what: RichSeg = img ? b.d.entitySeg(img) : { text: ref, kind: 'code', tip: ref };
            const cond = Array.isArray(c.v) ? blockOf(c.v, 'trigger') : undefined;
            const l: Line = { text: rich(c.k === 'icon' ? 'Icon ' : '3D model ', what, cond ? ' when:' : ''), icon: 'note', tip: `${c.k} = ${ref}` };

            if (cond)
                l.conditions = charTriggers(b, cond, ctx);

            if (ctx.file)
                l.src = b.d.anchor(c, ctx, 'other', false);

            looks.push(l);
        }

        addSection(card, 'Looks', looks);
        settingsSection(b, x, artifactValue(b));
        b.genericSections(e, body, card, ctx, x.own, new Set(['icon', 'asset', 'default_type', 'pedestal', 'support_type']));
        return true;
    },

    // common/artifacts/blueprints/_blueprints.info: what an artifact can be reforged into
    'artifacts/blueprints': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        const from = str(body, 'in_type');
        const to = str(body, 'out_type');

        if (from && to)
            card.facts.push(rich(typeSeg(b, from), ' → ', typeSeg(b, to)));

        settingsSection(b, x, artifactValue(b));
        const lost = blockOf(body, 'disallowed_modifiers');

        if (lost)
        {
            const labels = [...new Set(words(lost).map((k) => b.d.modifierFormat(k).label))];
            addSection(card, 'Modifiers it loses', [{ text: [labels.join(', ')], icon: 'modifier', tip: words(lost).join(' '), src: ctx.file ? b.d.anchor(lost, ctx, 'other', false) : undefined }]);
        }

        const repl = blockOf(body, 'replacement_modifiers');

        if (repl)
            addSection(
                card,
                'Gets instead, at random',
                kids(repl)
                    .filter((r) => r.k && Array.isArray(r.v))
                    .map((r) => ({ text: [`${capitalize(humanize(r.k!))} artifacts:`], icon: 'modifier', children: words(r).map((m) => ({ text: modifierWithStats(b, m), tip: m })), src: ctx.file ? b.d.anchor(r, ctx, 'other', false) : undefined })),
                b.blockSection(repl, 'other', ctx)
            );

        b.genericSections(e, body, card, ctx, x.own, new Set(['in_type', 'in_visuals', 'out_type', 'out_visuals', 'template', 'disallowed_modifiers', 'replacement_modifiers']));
        return true;
    },

    // common/artifacts/features/_features.info (loc `feature_<key>` names it: "a wolf's head")
    'artifacts/features': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        card.title = capitalize(card.title);
        const group = str(body, 'group');

        if (group)
            card.facts.push(rich('In the group ', b.d.ref(group, ['artifacts/feature_groups'])));

        settingsSection(b, x);
        b.genericSections(e, body, card, ctx, x.own, new Set(['group', 'weight']));
        const w = blockOf(body, 'weight');

        if (w)
            addSection(card, 'Weight', weightLines(b, kids(w), ctx));

        return true;
    },

    // common/artifacts/feature_groups: only names (`key = {}`) — the features in them, the types that use them
    'artifacts/feature_groups': (b, { e, card }) =>
    {
        const features = [...entries(b, 'artifacts/features')].filter((f) => str(f.body, 'group') === e.name);
        card.facts.push([`${features.length} features`]);
        addSection(card, 'Notes in the file', commentLines(b, e));
        const types = [...entries(b, 'artifacts/types')];
        const using = (k: string): RichSeg[] => typeLinks(b, types.filter((t) => words(blockOf(t.body, k)).includes(e.name)).map((t) => t.e.name));
        addSection(card, 'Artifact types', [...listLine('Always on ', using('required_features')), ...listLine('Script can add it to ', using('optional_features'))]);
        addSection(card, 'Features', linkLines(features.map((f) => b.d.entitySeg(f.e))));
        return true;
    }
};
