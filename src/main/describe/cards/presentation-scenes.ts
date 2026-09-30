/**
 * Cards of the event window's looks: common/event_backgrounds, event_themes, event_transitions, event_2d_effects (their
 * .info files). Every part is a list of `{ trigger reference … }` entries of which the first that fits is used; the
 * triggers get the event's scope (its character).
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { Line, Rich } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { formatNumber, rich } from '../text.ts';
import { constant, firstValidLines, kids, pictureSeg, soundSeg, str, words } from './presentation-util.ts';

/** A picture or a video (`.bk2`), how long it shows. */
function shown(b: StoryBuilder, e: Entity, list: PNode[]): Rich
{
    const ref = str(list, 'reference');

    if (!ref)
        return ['(nothing set)'];

    const video = /\.bk2$/i.test(ref) || str(list, 'video') === 'yes';
    const d = str(list, 'duration');
    const dur = d === undefined ? undefined : Number(d);
    return rich(video ? 'Video: ' : '', pictureSeg(b, constant(b, e, ref), 'event_backgrounds', /^event_effect_/), dur === undefined || !Number.isFinite(dur) ? '' : dur > 0 ? ` for ${formatNumber(dur)} seconds` : ', without end');
}

/** The other fields of an entry: lighting, ambient sound, masks. */
function details(list: PNode[]): Line[]
{
    const out: Line[] = [];
    const env = str(list, 'environment');

    if (env)
        out.push({ text: rich('Portrait lighting: ', { text: words(env, /^environment_/), kind: 'code', tip: env }), tip: `environment = ${env}` });

    const amb = str(list, 'ambience');

    if (amb)
        out.push({ text: rich('Ambient sound: ', soundSeg(amb)), tip: `ambience = ${amb}` });

    for (const k of ['video_mask', 'mask'])
    {
        const m = str(list, k);

        if (m)
            out.push({ text: rich(str(list, 'mask_type') === 'video' || /\.bk2$/i.test(m) ? 'Faded in through the video ' : 'Faded in through the mask ', { text: words(m), kind: 'code', tip: m }), tip: `${k} = ${m}` });
    }

    return out;
}

/** The entries under `key` as lines (the event's character as their triggers' scope). */
function scenes(b: StoryBuilder, e: Entity, body: PNode[], ctx: Ctx, key: string): Line[]
{
    const entries = body.filter((c) => c.k === key && Array.isArray(c.v));
    const lines = firstValidLines(b, entries, { ...ctx, scopeType: 'character' }, (list) => ({ text: shown(b, e, list), children: details(list) }));

    // (one entry: its details open)
    if (lines.length === 1)
        lines[0].collapsed = false;

    return lines;
}

/** A theme's parts, what they are called, the entry type they name (else a picture or a sound). */
const THEME_PARTS: [string, string, string?][] = [
    ['background', 'Scene', 'event_backgrounds'],
    ['icon', 'Icon'],
    ['header_background', 'Header'],
    ['sound', 'Sound'],
    ['transition', 'Transition', 'event_transitions'],
    ['effect_2d', '2D effect', 'event_2d_effects']
];

// (none has a text of its own: `<key>_desc` is another entry's — activity_feast_desc is the feast activity's)
export const SCENE_CARDS: Record<string, CardFn> = {
    // `background = { trigger reference environment ambience video video_mask }`, the first that fits
    event_backgrounds: (b, { e, body, card, ctx, own }) =>
    {
        card.description = undefined;
        const lines = scenes(b, e, body, ctx, 'background');

        if (lines.length > 1)
        {
            card.facts.push([`${lines.length} scenes`]);
            const fallback = body.find((c) => c.k === 'background' && !kids(c).some((x) => x.k === 'trigger'));
            const ref = fallback && str(kids(fallback), 'reference');

            if (ref)
                card.facts.push(rich('Usually ', pictureSeg(b, ref, e.type)));
        }

        card.sections.push({ title: lines.length > 1 ? 'Scene — the first that fits' : 'Scene', lines, src: own('other') });
        return true;
    },
    // `transition = { trigger reference duration video ambience video_mask }`: over the whole window, then fades
    event_transitions: (b, { e, body, card, ctx, own }) =>
    {
        card.description = undefined;
        card.sections.push({ title: 'Transition', lines: scenes(b, e, body, ctx, 'transition'), src: own('other') });
        return true;
    },
    // `effect_2d = { trigger reference mask mask_type duration }`: a video over the scene (duration 0: no end)
    event_2d_effects: (b, { e, body, card, ctx, own }) =>
    {
        card.description = undefined;
        card.sections.push({ title: '2D effect', lines: scenes(b, e, body, ctx, 'effect_2d'), src: own('other') });
        return true;
    },
    // background / icon / header_background / sound / transition / effect_2d: each a list of which the first that fits is used
    event_themes: (b, { e, body, card, ctx, own }) =>
    {
        card.description = undefined;
        const sctx = { ...ctx, scopeType: 'character' };
        const lines: Line[] = [];

        for (const [key, label, type] of THEME_PARTS)
        {
            const entries = body.filter((c) => c.k === key && Array.isArray(c.v));
            const found = firstValidLines(b, entries, sctx, (list) =>
            {
                const ref = str(list, 'reference');
                const v = ref && constant(b, e, ref);
                return { text: !v ? ['(nothing set)'] : [type ? b.d.ref(v, [type]) : key === 'sound' ? soundSeg(v) : pictureSeg(b, v, e.type, /^type_/)] };
            });

            // one entry without conditions: "Scene: X"; else a line per entry under "Scene — the first that fits:"
            if (found.length === 1 && !found[0].conditions)
                lines.push({ ...found[0], text: rich(label + ': ', found[0].text) });
            else if (found.length)
                lines.push({ text: [`${label} — the first that fits:`], children: found });
        }

        const bg = body.find((c) => c.k === 'background' && !kids(c).some((x) => x.k === 'trigger'));
        const ref = bg && str(kids(bg), 'reference');

        if (ref)
            card.facts.push(rich('Scene: ', b.d.ref(ref, ['event_backgrounds'])));

        card.sections.push({ title: 'Look and sound', lines, src: own('other') });
        return true;
    }
};
