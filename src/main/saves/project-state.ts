/**
 * What a loaded save says about game entries (docs/saves.md, "Overrides"): its state of titles, faiths, cultures,
 * houses and dynasties, each a list of facts the entry's card shows first ("Savegame"), and the entry marked as
 * overridden by the save. Faiths only the save has (reformed: `dynamic_faith_<id>`) are entries of their own
 * (`savegame/faiths`, written like faiths).
 */
import type { SaveFact } from '../mods/gamefiles.ts';
import { tr } from '../../shared/i18n.ts';
import { cleanText, entries, Gamestate, type Entry } from './gamestate.ts';
import { T_SAVE_CHARACTER, T_SAVE_FAITH } from '../indexer/schema.ts';

export const SAVE_FAITHS_FILE = 'savegame/faiths/faiths.txt';

/** A database block's entries: id → its scalar fields (the last of a key; `many` keys: every value) and its blocks. */
function rows(g: Gamestate, db: Entry | undefined, many: string[] = []): Map<number, { f: Map<string, string>; all: Map<string, string[]>; blocks: Map<string, Entry>; }>
{
    const out = new Map<number, { f: Map<string, string>; all: Map<string, string[]>; blocks: Map<string, Entry>; }>();
    const b = g.buf;

    if (!db?.block)
        return out;

    for (const x of entries(b, db.vs, db.ve))
    {
        if (!x.block || !x.key || !/^\d+$/.test(x.key))
            continue;

        const r = { f: new Map<string, string>(), all: new Map<string, string[]>(), blocks: new Map<string, Entry>() };

        for (const f of entries(b, x.vs, x.ve))
        {
            if (!f.key)
                continue;

            if (f.block)
            {
                r.blocks.set(f.key, f);
                continue;
            }

            const v = cleanText(b.subarray(f.vs, f.ve).toString('utf8').replace(/^"|"$/g, ''));
            r.f.set(f.key, v);

            if (many.includes(f.key))
                r.all.set(f.key, [...(r.all.get(f.key) ?? []), v]);
        }

        out.set(Number(x.key), r);
    }

    return out;
}

/** The scalar items of a list block (`{ a b c }`). */
function items(g: Gamestate, e: Entry | undefined): string[]
{
    return e?.block ? [...entries(g.buf, e.vs, e.ve)].filter((x) => !x.block && x.key === null).map((x) => g.buf.subarray(x.vs, x.ve).toString('utf8').replace(/^"|"$/g, '')) : [];
}

const NONE = '4294967295';

export interface SaveState
{
    /** `type|name` → the facts its card shows */
    facts: Map<string, SaveFact[]>;
    /** `type|name` → the save's own entry for it (a link), or {} (overridden, no entry of its own) */
    overrides: Map<string, { type?: string; name?: string; }>;
    /** the save's own faiths, as script */
    faiths: string;
}

/** The save's titles: key → its holder (a save character id) and de facto liege title (key): the save's history. */
export function saveTitleHolders(g: Gamestate): Map<string, { holder?: string; liege?: string; }>
{
    const titles = rows(g, g.sub(g.section('landed_titles'), 'landed_titles'));
    const keyOf = new Map<number, string>();

    for (const [id, r] of titles)
        if (r.f.get('key'))
            keyOf.set(id, r.f.get('key')!);

    const out = new Map<string, { holder?: string; liege?: string; }>();

    for (const [, r] of titles)
    {
        const key = r.f.get('key');
        const holder = r.f.get('holder');
        const liege = keyOf.get(Number(r.f.get('de_facto_liege')));

        if (key)
            out.set(key, { ...(holder && holder !== NONE ? { holder } : {}), ...(liege ? { liege } : {}) });
    }

    return out;
}

export function projectState(g: Gamestate): SaveState
{
    const facts = new Map<string, SaveFact[]>();
    const overrides = new Map<string, { type?: string; name?: string; }>();
    const set = (type: string, name: string, list: SaveFact[], by: { type?: string; name?: string; } = {}): void =>
    {
        const kept = list.filter((x) => x.text !== undefined || x.ref || x.refs?.length);

        if (!kept.length)
            return;

        facts.set(`${type}|${name}`, kept);
        overrides.set(`${type}|${name}`, by);
    };
    const char = (id: string | undefined): SaveFact['ref'] => (id && id !== NONE ? { type: T_SAVE_CHARACTER, name: id } : undefined);

    // titles: holder, lieges, name, laws, capital, by the save's title ids → keys
    const titles = rows(g, g.sub(g.section('landed_titles'), 'landed_titles'));
    const titleKey = new Map<number, string>();

    for (const [id, r] of titles)
        if (r.f.get('key'))
            titleKey.set(id, r.f.get('key')!);

    const title = (id: string | undefined): SaveFact['ref'] =>
    {
        const k = id ? titleKey.get(Number(id)) : undefined;
        return k ? { type: 'landed_titles', name: k } : undefined;
    };

    for (const [, r] of titles)
    {
        const key = r.f.get('key');

        if (!key || key.startsWith('x_'))
            continue;

        const nameData = r.blocks.get('title_name_data');
        const name = nameData ? [...entries(g.buf, nameData.vs, nameData.ve)].find((x) => x.key === 'name' && !x.block) : undefined;
        set('landed_titles', key, [
            { label: tr('Holder'), ref: char(r.f.get('holder')) ?? undefined, text: r.f.get('holder') ? undefined : tr('none') },
            { label: tr('Held since'), text: r.f.get('holder') ? r.f.get('date') : undefined },
            { label: tr('Liege'), ref: title(r.f.get('de_facto_liege')) },
            { label: tr('De jure liege'), ref: title(r.f.get('de_jure_liege')) },
            { label: tr('Name'), text: name ? cleanText(g.buf.subarray(name.vs, name.ve).toString('utf8').replace(/^"|"$/g, '')) : undefined },
            { label: tr('Capital'), ref: title(r.f.get('capital')) },
            { label: tr('Laws'), refs: items(g, r.blocks.get('laws')).map((l) => ({ type: 'laws', name: l })) },
            { label: tr('Heirs'), refs: items(g, r.blocks.get('heir')).map((h) => char(h)!).filter(Boolean) }
        ]);
    }

    // faiths: a game faith (tag = its key) overridden; a reformed one (dynamic_faith_<id>) an entry of the save's own
    // (1.18 / 1.19: `religion.faiths`, the template `template`; 1.20: the top-level `faiths.database`, the template
    // `faith_type`, a name on every faith, the founder on the main rite)
    const faiths = rows(g, g.faithTable(), ['doctrine', 'tenet']);
    const rites = rows(g, g.riteTable());
    const own: string[] = [];
    // (1.20: a faith's rites other than its main one (made by the rite growth or scripted) by their own names)
    const otherRites = new Map<number, string[]>();

    for (const [rite, faith] of g.riteFaiths())
        if (g.mainRiteOf(faith) !== rite)
            otherRites.set(faith, [...(otherRites.get(faith) ?? []), g.riteNames().get(rite) ?? `#${rite}`]);

    for (const [id, r] of faiths)
    {
        const tag = r.f.get('tag') ?? r.f.get('template') ?? r.f.get('faith_type');
        const template = r.f.get('template') ?? r.f.get('faith_type');

        if (!tag)
            continue;

        // (a faith made in the game: its tag is not its template's; only that one has a name of its own to show)
        const reformed = template ? tag !== template : /^dynamic_faith/.test(tag);
        const mainRite = Number(r.f.get('main_rite'));
        const doctrines = r.all.get('doctrine') ?? [];
        const tenets = r.all.get('tenet') ?? [];
        const list: SaveFact[] = [
            { label: tr('Name'), text: reformed || g.faithLayout() === 'religion' ? r.f.get('name') : undefined },
            { label: tr('Reformed from'), ref: reformed && template ? { type: 'faith', name: template } : undefined },
            { label: tr('Head of faith'), ref: char(r.f.get('religious_head')) },
            { label: tr('Founder'), ref: char(r.f.get('founder') ?? rites.get(mainRite)?.f.get('founder')) },
            { label: tr('Fervor'), text: r.f.get('fervor') },
            { label: tr('Doctrines and tenets'), refs: [...(r.all.get('tenet') ?? []), ...doctrines].map((d) => ({ name: d })) },
            { label: tr('Other rites'), text: otherRites.get(id)?.join(', ') }
        ];

        if (!reformed)
            set('faith', tag, list);
        else
        {
            const q = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
            own.push([
                `${tag} = {`,
                ...(r.f.get('name') ? [`\tname = ${q(r.f.get('name')!)}`] : []),
                ...(template ? [`\ttemplate = ${template}`] : []),
                ...(r.f.get('icon') ? [`\ticon = ${r.f.get('icon')}`] : []),
                // (1.20: the tenets are `tenet = x` lines of the faith; the game's own files write `tenets = { x y }`)
                ...(tenets.length ? [`\ttenets = { ${tenets.join(' ')} }`] : []),
                ...doctrines.map((d) => `\tdoctrine = ${d}`),
                '}'
            ].join('\n'));
            set(T_SAVE_FAITH, tag, list);
        }
    }

    // cultures: by their key (a divergent or hybrid one the game doesn't have is left out)
    for (const [, r] of rows(g, g.sub(g.section('culture_manager'), 'cultures')))
    {
        const key = r.f.get('name');

        if (!key)
            continue;

        set('culture/cultures', key, [
            { label: tr('Head of culture'), ref: char(r.f.get('head')) },
            { label: tr('Ethos'), ref: r.f.get('ethos') ? { name: r.f.get('ethos')! } : undefined },
            { label: tr('Heritage'), ref: r.f.get('heritage') ? { name: r.f.get('heritage')! } : undefined },
            { label: tr('Language'), ref: r.f.get('language') ? { name: r.f.get('language')! } : undefined },
            { label: tr('Martial custom'), ref: r.f.get('martial_custom') ? { name: r.f.get('martial_custom')! } : undefined },
            { label: tr('Traditions'), refs: items(g, r.blocks.get('traditions')).map((t) => ({ type: 'culture/traditions', name: t })) }
        ]);
    }

    // houses (a static house: its key) and dynasties (their key)
    const dyn = g.section('dynasties');

    for (const [, r] of rows(g, g.sub(dyn, 'dynasty_house')))
    {
        const key = r.f.get('key');

        if (key)
            set('dynasty_houses', key, [{ label: tr('Head of house'), ref: char(r.f.get('head_of_house')) }, { label: tr('Founded'), text: r.f.get('found_date') }]);
    }

    for (const [, r] of rows(g, g.sub(dyn, 'dynasties')))
    {
        const key = r.f.get('key');

        if (key)
            set('dynasties', key, [{ label: tr('Head of dynasty'), ref: char(r.f.get('dynasty_head')) }, { label: tr('Legacies'), refs: items(g, r.blocks.get('perk')).map((p) => ({ name: p })) }]);
    }

    return { facts, overrides, faiths: own.join('\n') + '\n' };
}
