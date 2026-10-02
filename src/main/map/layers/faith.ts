/** Map layers of religion (docs/map.md): the counties' religions and religion families at the date, holy sites. */
import type { PNode } from '../../indexer/parser.ts';
import { T_FAITH } from '../../indexer/schema.ts';
import { faithField, faithHolySites } from '../../indexer/layouts.ts';
import type { MapThing } from '../../../shared/api.ts';
import { bodyOf, fieldOf, once, perCounty, Things, type LayerCtx, type LayerDef } from '../layers.ts';
import { countyKeys, thingsOf } from './basic.ts';

/** Colours of the religion families, in their load order (they have none of their own). */
const FAMILY_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7', '#008300', '#e34948'];

interface Religions
{
    religions: MapThing[];
    families: MapThing[];
    /** per faith: its religion (index) */
    religionOf: Map<string, number>;
    /** per religion: its family (index), −1 */
    familyOf: number[];
}

/**
 * common/religion/religion_types: a religion's faiths are the blocks of its `faiths = { }`, or (1.20) the faiths naming
 * it in `faith_details = { religion = x }`; its `family` names a religion_family_types entry. Religions have no colour:
 * they take their first faith's.
 */
export function religions(ctx: LayerCtx): Religions
{
    return once(ctx, 'religions', () =>
    {
        const faiths = thingsOf(ctx, T_FAITH);
        const rel = new Things();
        const fam = new Things();

        for (const f of thingsOf(ctx, 'religion/religion_family_types').list)
            fam.of(f.key, () => ({ name: f.name, color: FAMILY_COLORS[fam.list.length % FAMILY_COLORS.length], type: f.type }));

        const religionOf = new Map<string, number>();
        const familyOf: number[] = [];
        // (1.20: per religion, the faiths naming it)
        const naming = new Map<string, string[]>();

        for (const f of faiths.list)
        {
            const r = faithField(bodyOf(ctx, T_FAITH, f.key), 'religion');

            if (typeof r?.v === 'string')
                (naming.get(r.v) ?? naming.set(r.v, []).get(r.v)!).push(f.key);
        }

        for (const r of thingsOf(ctx, 'religion/religion_types').list)
        {
            const body = bodyOf(ctx, 'religion/religion_types', r.key);
            const own = [...body.filter((c) => c.k === 'faiths' && Array.isArray(c.v)).flatMap((c) => (c.v as PNode[]).filter((x) => x.k && Array.isArray(x.v)).map((x) => x.k!)), ...(naming.get(r.key) ?? [])];
            const first = own.map((k) => faiths.list[faiths.at.get(k) ?? -1]).find(Boolean);
            const i = rel.of(r.key, () => ({ name: r.name, color: first?.color, type: r.type }));

            for (const k of own)
                religionOf.set(k, i);

            const family = fieldOf(body, 'family');
            familyOf[i] = family ? fam.of(family, () => ({ name: ctx.name('religion/religion_family_types', family), color: FAMILY_COLORS[fam.list.length % FAMILY_COLORS.length] })) : -1;
        }

        return { religions: rel.list, families: fam.list, religionOf, familyOf };
    });
}

const religion: LayerDef = {
    id: 'religion',
    build: (ctx) =>
    {
        const r = religions(ctx);
        const values = countyKeys(ctx, 'faith').map((k) => (k ? (r.religionOf.get(k) ?? -1) : -1));
        return { id: 'religion', label: 'Religions', title: 'The counties’ religions (their faiths grouped) at the date', row: 'Religion', historical: true, things: r.religions, values };
    }
};

const religionFamily: LayerDef = {
    id: 'religion_family',
    build: (ctx) =>
    {
        const r = religions(ctx);
        const values = countyKeys(ctx, 'faith').map((k) =>
        {
            const i = k ? r.religionOf.get(k) : undefined;
            return i !== undefined ? r.familyOf[i] : -1;
        });
        return { id: 'religion_family', label: 'Religion families', title: 'The families of the counties’ religions at the date', row: 'Religion family', historical: true, things: r.families, values };
    }
};

/**
 * Holy sites (common/religion/holy_site_types: `county = c_x`, `barony = b_y` — the barony the site is shown on, else
 * the county's capital) and the faiths naming them (`holy_site = <site>`, 1.20: `holy_sites` / `eminent_holy_sites`). The whole county is the site on
 * the map — one thing per county: vanilla has 20 counties with two or three sites (c_kufa: babylon, kufa, nadjaf),
 * named together and linked to the first; its colour is the religion's of the first faith naming one. Name: loc
 * `holy_site_<key>_name`.
 */
const holySite: LayerDef = {
    id: 'holy_site',
    build: (ctx) =>
        once(ctx, 'layer:holy_site', () =>
        {
            const r = religions(ctx);
            const holyTo = new Map<string, string[]>();

            for (const f of thingsOf(ctx, T_FAITH).list)
            {
                for (const { name } of faithHolySites(bodyOf(ctx, T_FAITH, f.key)))
                    (holyTo.get(name) ?? holyTo.set(name, []).get(name)!).push(f.key);
            }

            const sites = new Map<number, string[]>();

            for (const key of ctx.idx.names('religion/holy_site_types'))
            {
                const county = ctx.tree.byKey.get(fieldOf(bodyOf(ctx, 'religion/holy_site_types', key), 'county') ?? '');

                if (county !== undefined)
                    (sites.get(county) ?? sites.set(county, []).get(county)!).push(key);
            }

            const things = new Things();
            const siteOf = new Map<number, number>();
            const nameOf = (key: string, county: number): string => ctx.idx.plainLoc(`holy_site_${key}_name`) ?? ctx.name('landed_titles', ctx.tree.titles[county].key);
            const faithList = (who: string[]): string =>
            {
                const names = who.map((f) => ctx.name(T_FAITH, f));
                return names.length > 6 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more faiths` : names.join(', ');
            };

            for (const [county, keys] of sites)
            {
                // (sites of one name — toledo and toledo_mozarabic — are one)
                const byName = new Map<string, string[]>();

                for (const k of keys)
                    (byName.get(nameOf(k, county)) ?? byName.set(nameOf(k, county), []).get(nameOf(k, county))!).push(...(holyTo.get(k) ?? []));

                const rel = [...byName.values()]
                    .flat()
                    .map((f) => r.religionOf.get(f))
                    .find((i) => i !== undefined);
                const notes = [...byName].map(([name, who]) => (byName.size > 1 ? name + ': ' : '') + (who.length ? `holy to ${faithList(who)}` : 'no faith names it'));
                const note = notes.join('; ');
                siteOf.set(county, things.of(keys[0], () => ({ name: [...byName.keys()].join(' / '), color: rel !== undefined ? r.religions[rel].color : '#8a8a8a', type: 'religion/holy_site_types', note: note.charAt(0).toUpperCase() + note.slice(1) })));
            }

            return { id: 'holy_site', label: 'Holy sites', title: 'The faiths’ holy sites', row: 'Holy site', things: things.list, values: perCounty(ctx, (ci) => siteOf.get(ci) ?? -1) };
        })
};

export const FAITH_LAYERS: LayerDef[] = [religion, religionFamily, holySite];
