/**
 * The map's right-click menu in the picker (docs/map.md, "Editing from the map"; docs/picker.md, plain menus): the
 * province's rows the side panel can change (its titles (holder, liege, colour), realm, culture, faith, holding,
 * development), each a menu of its values, chosen with the picker's keys, filter and cascade. The edit is the panel's
 * (runEdit: the active mod, the change bar with Undo); when it happens is main's default: the statement in effect for
 * culture, faith and holding, from the map's date for title history (the panel chooses otherwise).
 */
import type { CharacterPreset, MapCharacter, MapEditRequest, MapInfo, Settings } from '../../../../shared/api';
import { api } from '../../api';
import { createFor, newCharacterMenu } from '../../characterPick';
import { pickChoice } from '../../picker/pickStatement';
import type { ChoiceItem, ChoiceMenu } from '../../picker/model';
import { EDITABLE_LAYERS, countyProvinces, liegesOf, runEdit } from './MapEdit';
import { TIER_NAMES, ancestorAt, hashColor, provinceName } from './model';

import { tr } from '../../../../shared/i18n';
/** tiers from low to high */
const TIER_RANK = 'bcdkeh';

const yearOf = (d: string | undefined): string => (d ? d.slice(0, d.indexOf('.')) : '?');

/** A row's value: the edit and what the change bar says, or the colour (the panel's colour editor opens). */
type Picked = { req: MapEditRequest; text: string; } | { colour: number; } | { newCharacter: CharacterPreset; birth: string; title: number; };

/** the menu being made: the settings (presets) and the province (its county's culture and faith for a new character) */
let making: { settings: Settings | null; p: number; } = { settings: null, p: 0 };

/** A menu whose finishing rows carry `extra` too (their values are JSON objects). */
function tagged(m: ChoiceMenu, extra: Record<string, unknown>): ChoiceMenu
{
    const item = (c: ChoiceItem): ChoiceItem => ({ ...c, ...(c.value ? { value: JSON.stringify({ ...JSON.parse(c.value), ...extra }) } : {}), ...(c.sub ? { sub: () => tagged(c.sub!(), extra) } : {}) });
    return {
        ...m,
        items: m.items.map(item),
        ...(m.number ? { number: (n: number) => m.number!(n).map(item) } : {}),
        ...(m.input ? { input: (t: string) => { const c = m.input!(t); return c ? item(c) : null; } } : {}),
        // (rows loaded later and found by a search: tagged too)
        ...(m.load ? { load: async () => (await m.load!()).map(item) } : {}),
        ...(m.search ? { search: async (q: string) => (await m.search!(q)).map(item) } : {})
    };
}

const value = (v: Picked): string => JSON.stringify(v);

/** What the menu did: an edit was written (`done`), the colour editor is wanted (`colour`: the title), or nothing. */
export type MapPickResult = { done: true; } | { colour: number; } | null;

/** Opens the menu at a window point; the edit chosen is written before it resolves. */
export async function pickMapEdit(info: MapInfo, p: number, at: { x: number; y: number; }): Promise<MapPickResult>
{
    // (the holding types: every one the game has, not only those on the map)
    const holdings = await api.list('holdings').catch(() => []);
    making = { settings: await api.getSettings().catch(() => null), p };
    const chosen = await pickChoice(rootMenu(info, p, holdings), { at, title: tr('Change {provinceName}', { provinceName: provinceName(info, p) }) });

    if (!chosen)
        return null;

    const v = JSON.parse(chosen) as Picked;

    if ('colour' in v)
        return { colour: v.colour };

    // a new character as the holder: made (the county's culture and faith where the preset leaves them, the holder's
    // family for a "relative" dynasty), then set as the holder from the map's date
    if ('newCharacter' in v)
    {
        const title = info.titles[v.title];
        const layer = (id: string): string | undefined =>
        {
            const l = info.layers.find((x) => x.id === id);
            const i = l?.values[p] ?? -1;
            return l?.things && i >= 0 ? l.things[i].key : undefined;
        };
        const id = await createFor({ title: title.name, culture: layer('culture'), faith: layer('faith'), houseOf: title.holder?.id }, JSON.stringify(v));

        if (!id)
            return null;

        await runEdit({ kind: 'holder', title: title.key, value: id, date: info.date }, tr('Holder of {name}: {id} from {date}', { name: title.name, id, date: info.date }));
        // (the character is made either way: the map reads it again)
        return { done: true };
    }

    return (await runEdit(v.req, v.text)) ? null : { done: true };
}

function rootMenu(info: MapInfo, p: number, holdings: { name: string; display?: string; }[]): ChoiceMenu
{
    const P = info.province;
    const items: ChoiceItem[] = [];

    for (const tier of ['b', 'c', 'd', 'k', 'e', 'h'] as const)
    {
        const t = ancestorAt(info, p, tier);

        if (t >= 0)
            items.push({ label: TIER_NAMES[tier][0], hint: info.titles[t].name, sub: () => titleMenu(info, t) });
    }

    if (P.realm[p] >= 0)
        items.push({ label: tr('Realm'), hint: info.titles[P.realm[p]].name, sub: () => titleMenu(info, P.realm[p]) });

    for (const l of info.layers)
    {
        // (culture and faith are the county's, the holding its barony's, as in the panel)
        const t = l.id === 'holding' ? P.barony[p] : ancestorAt(info, p, 'c');

        if (!EDITABLE_LAYERS.has(l.id) || t < 0)
            continue;

        const v = l.values[p];
        const now = l.things ? (v >= 0 ? l.things[v].name : tr('none')) : Number.isFinite(v) ? String(Math.round(v * 10) / 10) : tr('none');
        items.push({ label: l.row, hint: now, sub: () => layerMenu(info, p, l.id as 'culture' | 'faith' | 'holding' | 'development', t, holdings) });
    }

    return { title: provinceName(info, p), items };
}

/** A county's culture or faith, a barony's holding, a county's development level. */
function layerMenu(info: MapInfo, p: number, kind: 'culture' | 'faith' | 'holding' | 'development', t: number, holdings: { name: string; display?: string; }[]): ChoiceMenu
{
    const layer = info.layers.find((l) => l.id === kind)!;
    const title = info.titles[t];
    const v = layer.values[p];
    const provinces = kind === 'holding' ? [p] : kind !== 'development' ? countyProvinces(info, t) : undefined;
    const lieges = kind === 'development' ? liegesOf(info, t) : undefined;
    const pick = (val: string, name: string): string => value({ req: { kind, title: title.key, provinces, lieges, value: val, date: info.date }, text: tr('{row} of {name}: {name2}', { row: layer.row, name: title.name, name2: name }) });
    const of = tr('{row} of {name}', { row: layer.row, name: title.name });

    if (kind === 'development')
    {
        const now = Number.isFinite(v) ? Math.round(v) : 0;
        const level = (n: number): ChoiceItem => ({ label: tr('Level {n}', { n }), hint: n === now ? 'now' : n > now ? `+${n - now}` : `${n - now}`, value: pick(String(n), String(n)) });
        return {
            title: of,
            typeahead: true,
            items: [now + 1, now + 5, now + 10, now - 1, now - 5].filter((n) => n >= 0 && n !== now).map(level),
            number: (n) => (Number.isInteger(n) && n >= 0 && n <= 999 ? [level(n)] : []),
            note: tr('Type a level (sets it: change_development_level, at the map’s date)')
        };
    }

    const current = v >= 0 ? layer.things?.[v]?.key : undefined;
    const list = kind === 'holding' ?
        [
            ...holdings.map((h) => ({ key: h.name, name: h.display ?? h.name })),
            { key: 'none', name: 'No holding' },
            { key: 'auto', name: 'Automatic' }
        ] :
        (layer.things ?? []).map((x) => ({ key: x.key, name: x.name }));
    const color = (key: string): string => layer.things?.find((x) => x.key === key)?.color ?? hashColor(key);
    return {
        title: of,
        typeahead: true,
        wide: true,
        items: list.map((c) => ({ label: c.name, hint: c.key === current ? 'now' : c.key, color: color(c.key), value: pick(c.key, c.name) })),
        note: kind === 'holding' ? tr('The barony’s holding') : tr('Written on the county’s capital')
    };
}

/** A title's holder, liege (history at the map's date) and colour. */
function titleMenu(info: MapInfo, t: number): ChoiceMenu
{
    const title = info.titles[t];
    const holder = title.holder ? `${title.holder.name}${title.holder.house ? ' ' + title.holder.house : ''}` : 'none';
    return {
        title: title.name,
        items: [
            { label: tr('Holder'), hint: holder, sub: () => holderMenu(info, t) },
            { label: tr('Liege'), sub: () => liegeMenu(info, t) },
            { label: tr('Colour…'), hint: title.color, value: value({ colour: t }), explain: tr('Opens the colour editor (the title’s definition in the mod)') }
        ]
    };
}

function holderMenu(info: MapInfo, t: number): ChoiceMenu
{
    const title = info.titles[t];
    // who holds what at the date: a character's highest title
    const holds = new Map<string, { name: string; rank: number; }>();

    for (const x of info.titles)
    {
        const rank = TIER_RANK.indexOf(x.tier);
        const had = x.holder && holds.get(x.holder.id);

        if (x.holder && (!had || rank > had.rank))
            holds.set(x.holder.id, { name: x.name, rank });
    }

    const pick = (id: string, name: string): string => value({ req: { kind: 'holder', title: title.key, value: id, date: info.date }, text: tr('Holder of {name}: {name2} from {date}', { name: title.name, name2: name, date: info.date }) });
    const item = (c: MapCharacter): ChoiceItem =>
    {
        const name = c.house ? `${c.name} ${c.house}` : c.name;
        const life = c.birth || c.death ? `${yearOf(c.birth)}–${c.death ? yearOf(c.death) : ''}` : '';
        const held = holds.get(c.id)?.name;
        const age = c.alive ? (c.age !== undefined ? tr('age {age}', { age: c.age }) : tr('alive')) : tr('not alive then');
        return {
            label: name,
            hint: c.note ? `${c.note} · ${age}` : age,
            dim: !c.alive,
            explain: [life, c.culture?.name, held && tr('holds {held}', { held }), `#${c.id}`].filter(Boolean).join(' · '),
            value: pick(c.id, name)
        };
    };
    // the first list, before anything is typed: the holder, the de jure liege's and the vassal titles' holders, and
    // their close family (main: mapHolderSuggestions; the alive at the date first)
    const seeds: [string, string][] = [];
    // (the characters the first list has: the search leaves them out)
    let listed = new Set<string>();

    if (title.holder)
        seeds.push([title.holder.id, tr('holds it now')]);

    const liege = title.parent >= 0 ? info.titles[title.parent] : undefined;

    if (liege?.holder)
        seeds.push([liege.holder.id, tr('holder of {name}', { name: liege.name })]);

    for (const x of info.titles)
        if (x.parent === t && x.holder)
            seeds.push([x.holder.id, tr('holder of {name}', { name: x.name })]);
    // (main readies its character lists for the date meanwhile)
    void api.mapCharacters('', info.date).catch(() => undefined);
    return {
        title: tr('Holder of {name}', { name: title.name }),
        typeahead: true,
        wide: true,
        items: [
            { label: tr('No holder'), hint: 'holder = 0', value: pick('0', 'none') },
            { label: tr('＋ New character…'), hint: tr('from a preset'), sub: () => tagged(newCharacterMenu(title.name, info.date, making.settings), { title: t }) }
        ],
        // (then everyone else alive at the date: typing filters them here; the search adds those not alive then)
        load: async () =>
        {
            const list = await api.mapHolderSuggestions(seeds, info.date, true);
            listed = new Set(list.map((c) => c.id));
            return list.map(item);
        },
        search: async (q) => (await api.mapCharacters(q, info.date)).filter((c) => !listed.has(c.id)).map(item),
        note: tr('The holder, their liege and vassals and their families, then everyone alive at {date} — type to filter (a name, house or id)', { date: info.date })
    };
}

function liegeMenu(info: MapInfo, t: number): ChoiceMenu
{
    const title = info.titles[t];
    const rank = TIER_RANK.indexOf(title.tier);
    const pick = (key: string, name: string): string => value({ req: { kind: 'liege', title: title.key, value: key, date: info.date }, text: tr('Liege of {name}: {name2} from {date}', { name: title.name, name2: name, date: info.date }) });
    const above = info.titles
        .filter((x) => TIER_RANK.indexOf(x.tier) > rank)
        .sort((a, b) => Number(!a.holder) - Number(!b.holder) || a.name.localeCompare(b.name));
    return {
        title: tr('Liege of {name}', { name: title.name }),
        typeahead: true,
        wide: true,
        items: [
            { label: tr('None (independent)'), hint: 'liege = 0', value: pick('0', 'none') },
            ...above.map((x) => ({
                label: x.name,
                hint: `${TIER_NAMES[x.tier]?.[0] ?? x.tier} · ${x.holder ? x.holder.name : tr('no holder')}`,
                color: x.color ?? hashColor(x.key),
                dim: !x.holder,
                value: pick(x.key, x.name)
            }))
        ]
    };
}
