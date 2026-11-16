/**
 * Whose view the fog of war shows, chosen in the picker (docs/map.md, "Fog of war"): a title held at the map's date
 * (its holder's realm) or a character (a ruler; anyone found by name, house or id). Always through the picker.
 */
import type { MapInfo } from '../../../../shared/api';
import { api } from '../../api';
import { pickChoice } from '../../picker/pickStatement';
import type { ChoiceItem, ChoiceMenu } from '../../picker/model';
import { tr } from '../../../../shared/i18n';
import type { Viewpoint } from './fog';

/** the tiers offered as titles (h e k d c; baronies are no one's view), highest first */
const TIERS = 'hekdc';

/** The viewpoint chosen, or null when cancelled. */
export async function pickViewpoint(info: MapInfo, at: { x: number; y: number; }): Promise<Viewpoint | null>
{
    const held = info.titles.map((t, i) => ({ t, i })).filter(({ t }) => t.holder && TIERS.includes(t.tier));
    const titles: ChoiceItem[] = held
        .sort((a, b) => TIERS.indexOf(a.t.tier) - TIERS.indexOf(b.t.tier) || a.t.name.localeCompare(b.t.name))
        .map(({ t }) => ({ label: t.name, hint: t.holder!.name, entry: { type: 'landed_titles', name: t.key }, value: 'title:' + t.key }));
    // the rulers of empires and kingdoms to start with; anyone else is found by name
    const rulers: ChoiceItem[] = held
        .filter(({ t }) => t.tier === 'e' || t.tier === 'k')
        .sort((a, b) => TIERS.indexOf(a.t.tier) - TIERS.indexOf(b.t.tier) || a.t.name.localeCompare(b.t.name))
        .map(({ t }) => ({ label: t.holder!.name, hint: t.name, value: 'character:' + t.holder!.id }));
    const titleMenu: ChoiceMenu = {
        title: tr('Fog of war: the realm of a title’s holder'),
        typeahead: true,
        wide: true,
        items: titles,
        note: tr('Titles held on {date} — type to filter', { date: info.date })
    };
    const characterMenu: ChoiceMenu = {
        title: tr('Fog of war: a character’s realm'),
        typeahead: true,
        wide: true,
        items: rulers,
        search: async (q) => (await api.searchCharacters(q, 60)).map((x) => ({ label: x.name, hint: x.about || x.id, value: 'character:' + x.id })),
        note: tr('The rulers of empires and kingdoms — type a name, house or id to search all (a character holding no title then sees nothing)')
    };
    const menu: ChoiceMenu = {
        title: tr('Fog of war: whose view'),
        items: [
            { label: tr('A title…'), hint: tr('its holder’s realm'), sub: () => titleMenu },
            { label: tr('A character…'), hint: tr('their realm'), sub: () => characterMenu }
        ]
    };
    const v = await pickChoice(menu, { at, title: menu.title });

    if (!v)
        return null;

    const i = v.indexOf(':');
    return { kind: v.slice(0, i) === 'character' ? 'character' : 'title', key: v.slice(i + 1) };
}
