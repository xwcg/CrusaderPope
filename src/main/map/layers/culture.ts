/** Map layers of the counties' cultures at the date (docs/map.md): their heritages and languages. */
import type { MapThing } from '../../../shared/api.ts';
import { bodyOf, fieldOf, once, Things, type LayerCtx, type LayerDef } from '../layers.ts';
import { countyKeys, thingsOf } from './basic.ts';

type Pillar = 'heritage' | 'language';

/**
 * The pillars of a type (common/culture/pillars: `type = heritage`, `language`) with their colour — languages have
 * one (`color`, often a named colour); a heritage without one takes the colour of its first culture — and per culture
 * its pillar (common/culture/cultures: `heritage = heritage_x`, `language = language_x`).
 */
export function pillars(ctx: LayerCtx, what: Pillar): { list: MapThing[]; ofCulture: Map<string, number>; }
{
    return once(ctx, 'pillars:' + what, () =>
    {
        const all = thingsOf(ctx, 'culture/pillars');
        const cultures = thingsOf(ctx, 'culture/cultures').list;
        const things = new Things();

        for (const p of all.list)
            if (fieldOf(bodyOf(ctx, 'culture/pillars', p.key), 'type') === what)
                things.of(p.key, () => ({ name: p.name, color: p.color, type: p.type }));

        const ofCulture = new Map<string, number>();

        for (const c of cultures)
        {
            const key = fieldOf(bodyOf(ctx, 'culture/cultures', c.key), what);

            if (!key)
                continue;

            const i = things.of(key, () => ({ name: ctx.name('culture/pillars', key) }));
            things.list[i].color ??= c.color;
            ofCulture.set(c.key, i);
        }

        return { list: things.list, ofCulture };
    });
}

function pillarLayer(what: Pillar, label: string, row: string): LayerDef
{
    return {
        id: what,
        build: (ctx) =>
        {
            const { list, ofCulture } = pillars(ctx, what);
            const values = countyKeys(ctx, 'culture').map((k) => (k ? (ofCulture.get(k) ?? -1) : -1));
            return { id: what, label, title: `The ${what}s of the counties’ cultures at the date`, row, historical: true, things: list, values };
        }
    };
}

export const CULTURE_LAYERS: LayerDef[] = [pillarLayer('heritage', 'Heritages', 'Heritage'), pillarLayer('language', 'Languages', 'Language')];
