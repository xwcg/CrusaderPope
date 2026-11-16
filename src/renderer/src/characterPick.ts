/**
 * New historical characters and birth dates in the picker (docs/mods.md, "New characters"): a birth date typed, a
 * relative (father, mother, sibling, twin, child) from a preset with a birth in years from the character's (a
 * nonsensical one warned, never refused), a new character for a title (the map's holder) from a preset at an age.
 * The presets and default ages are global (Settings → Characters; shared/characterPresets.ts).
 */
import type { CharacterPreset, EntryCreate, Relation, Settings } from '../../shared/api';
import { DEFAULT_RELATIVE_AGES, RELATION_LABELS, oddRelativeAge, presetsOf, relativeAgesOf, yearsFrom } from '../../shared/characterPresets';
import { tr } from '../../shared/i18n';
import { api } from './api';
import { reportChange } from './changes';
import { activeModId } from './modStore';
import { pickChoice, pickStatement } from './picker/pickStatement';
import type { ChoiceItem, ChoiceMenu } from './picker/model';
import { reportEditError } from './scriptEdits';

const DATE = /^-?\d{1,4}\.\d{1,2}\.\d{1,2}$/;
const RELATIONS: Relation[] = ['father', 'mother', 'sibling', 'twin', 'child'];

const sexOf = (p: CharacterPreset): string => (p.sex === 'female' ? tr('a woman') : p.sex === 'male' ? tr('a man') : tr('a man or a woman'));
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** A date typed (year.month.day), the current one offered. */
function dateMenu(title: string, now?: string): ChoiceMenu
{
    return {
        title,
        typeahead: true,
        items: now ? [{ label: tr('Keep {now}', { now }), value: now }] : [],
        input: (text) => (DATE.test(text.trim()) ? { label: tr('Born on {date}', { date: text.trim() }), value: text.trim() } : null),
        note: tr('Type a date: year.month.day (1036.3.1)')
    };
}

/** A historical character's birth date: picked, then written (EntryCreate `birth`). */
export async function pickBirth(character: string, now: string | undefined, at: { x: number; y: number; }): Promise<void>
{
    const date = await pickChoice(dateMenu(tr('{character} born on', { character }), now), { at, title: tr('Birth date of {character}', { character }) });

    if (!date || date === now)
        return;

    await make([{ what: 'birth', key: character, fields: [['date', date]] }], tr('{character} born on {date}', { character, date }));
}

/**
 * "＋ life event" on a historical character's card: the date (typed; their birth offered), then what happens, a
 * history change (trait, marriage, death, nickname …; field set `character_life`) or any effect (the statement
 * picker, written as `effect = { … }`); written into that date's block (EntryCreate `life_event`). A date line's
 * "＋ on this date" gives the date (`c.date`): not asked.
 */
export async function pickLifeEvent(c: { character: string; birth?: string; name: string; date?: string; }, at: { x: number; y: number; }): Promise<void>
{
    const when = c.date ?? await pickChoice(
        {
            title: tr('When?'),
            typeahead: true,
            items: c.birth ? [{ label: tr('On their birth date ({date})', { date: c.birth }), value: c.birth }] : [],
            input: (text) => (DATE.test(text.trim()) ? { label: tr('On {date}', { date: text.trim() }), value: text.trim() } : null),
            note: tr('Type a date: year.month.day (1066.9.15)')
        },
        { at, title: tr('Life of {name}', { name: c.name }) }
    );

    if (!when)
        return;

    const how = await pickChoice(
        {
            title: tr('What happens on {date}?', { date: when }),
            items: [
                { label: tr('A change in their history…'), key: 'h', hint: tr('trait, marriage, death, nickname, court, culture, faith, government'), value: 'history' },
                { label: tr('An effect…'), key: 'e', hint: 'effect = { … }', value: 'effect' }
            ]
        },
        { at, title: tr('Life of {name}', { name: c.name }) }
    );

    if (!how)
        return;

    const r = how === 'history' ?
        await pickStatement({ kind: 'field', type: 'character_life', title: tr('{name} on {date}', { name: c.name, date: when }), at, newEntries: true }) :
        await pickStatement({ kind: 'effect', title: tr('{name} on {date}', { name: c.name, date: when }), subject: c.name, at, newEntries: true });

    if (!r?.text.trim())
        return;

    const text = how === 'history' ? r.text : `effect = {\n${r.text.split('\n').map((l) => '\t' + l).join('\n')}\n}`;
    await make([...(r.creates ?? []), { what: 'life_event', key: c.character, fields: [['date', when], ['text', text]] }], tr('{name} on {date}: {what}', { name: c.name, date: when, what: r.summary ?? r.text.split('\n')[0] }));
}

/** The active mod's historical characters (the explorer's list of the type, filtered). */
async function ownCharacters(): Promise<{ name: string; display?: string; }[]>
{
    const active = activeModId()?.toLowerCase();

    if (!active)
        return [];

    return (await api.list('characters')).filter((e) => e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active));
}

/** Creates entries and reports them (the change bar, with Undo); the keys made (a new character's id), or null. */
async function make(creates: EntryCreate[], what: string): Promise<string[] | null>
{
    try
    {
        const r = await api.createEntries(creates);
        reportChange({ kind: 'ok', text: what, file: r.files[0], details: r.notes.length ? r.notes : undefined, undo: r.step });
        return r.keys ?? [];
    }
    catch (e)
    {
        reportEditError(tr('Not made'))(e);
        return null;
    }
}

/** The presets as rows (a parent's sex is the relation's whatever the preset says). */
function presetItems(presets: CharacterPreset[], sub: (p: CharacterPreset) => ChoiceMenu, forced?: 'male' | 'female'): ChoiceItem[]
{
    return presets.map((p) => ({
        label: p.label,
        hint: forced ? (forced === 'female' ? tr('a woman') : tr('a man')) : sexOf(p),
        explain: [p.culture && tr('culture {culture}', { culture: p.culture }), p.faith && tr('faith {faith}', { faith: p.faith }), p.dynasty === 'none' ? tr('lowborn') : p.dynasty && p.dynasty !== 'relative' ? tr('dynasty {dynasty}', { dynasty: p.dynasty }) : tr('of the family'), p.traits?.length ? p.traits.join(', ') : '']
            .filter(Boolean)
            .join(' · '),
        sub: () => sub(p)
    }));
}

/**
 * Someone, in the picker: `first` rows (a character's spouses), the active mod's characters, anyone found by name,
 * house or id; `none` a row for nobody. `next` makes the step after a choice (a menu) or the final value (a string).
 */
function personMenu(o: { title: string; note?: string; none?: string; first?: { id: string; name: string; hint: string; female?: boolean; }[]; exclude?: string[]; sex?: 'male' | 'female'; next: (id: string, name: string, female?: boolean) => ChoiceMenu | string; }): ChoiceMenu
{
    const skip = new Set(o.exclude ?? []);
    const fits = (female: boolean | undefined): boolean => !o.sex || female === undefined || female === (o.sex === 'female');
    const row = (id: string, name: string, hint: string, explain?: string, female?: boolean): ChoiceItem =>
    {
        const n = o.next(id, name, female);
        return typeof n === 'string' ? { label: name || id, hint, explain, value: n } : { label: name || id, hint, explain, sub: () => n };
    };
    const first = (o.first ?? []).filter((p) => !skip.has(p.id));
    const firstIds = new Set(first.map((p) => p.id));
    return {
        title: o.title,
        typeahead: true,
        wide: true,
        items: [...(o.none !== undefined ? [row('', o.none, '')] : []), ...first.filter((p) => fits(p.female)).map((p) => row(p.id, p.name, p.hint, undefined, p.female))],
        load: async () =>
        {
            const own = (await ownCharacters()).filter((e) => !skip.has(e.name) && !firstIds.has(e.name));
            const sex = new Map((await api.characterLifespans(own.map((e) => e.name)).catch(() => [])).map((x) => [x.id, x.female]));
            return own.filter((e) => fits(sex.get(e.name))).map((e) => row(e.name, e.display ?? e.name, tr('your mod · {name}', { name: e.name }), undefined, sex.get(e.name)));
        },
        search: async (q) => (await api.searchCharacters(q, 60)).filter((x) => !skip.has(x.id) && fits(x.female)).map((x) => row(x.id, x.name, x.about ?? x.id, x.about, x.female)),
        note: o.note ?? tr('Your mod’s characters — type a name, house or id to search all')
    };
}

/**
 * "＋ relative" on a character's card: which relative (a father, mother, sibling (the same parents, a different
 * mother or father), twin (identical or fraternal) or child ("With…": the other parent)), then someone existing or a
 * new one from a preset born how many years from them (the default from the settings, any number typed; a parent born
 * after them is warned, not refused); then made.
 */
export async function pickRelative(c: { character: string; name: string; birth?: string; female?: boolean; }, at: { x: number; y: number; }): Promise<void>
{
    const settings: Settings | null = await api.getSettings().catch(() => null);
    const presets = presetsOf(settings);
    const ages = relativeAgesOf(settings);
    const family = await api.familyTree(c.character).catch(() => null);
    const spouses = (family?.spouses ?? []).map((p) => ({ id: p.id, name: p.name, hint: tr('spouse · {id}', { id: p.id }), female: p.female }));
    type Extra = { siblings?: 'same' | 'mother' | 'father'; other_parent?: string; twin?: 'identical' | 'fraternal'; };
    const last = (_relation: Relation, base: Record<string, unknown>, extra: Extra): string => JSON.stringify({ ...base, ...extra });
    // when: years from their birth, or, without one, a date typed
    const when = (relation: Relation, p: CharacterPreset, extra: Extra): ChoiceMenu =>
    {
        const item = (label: string, birth: string, years: number | undefined, more: Partial<ChoiceItem> = {}): ChoiceItem =>
        {
            const n = last(relation, { relation, preset: p.id, birth }, extra);
            return { label, ...more, ...(typeof n === 'string' ? { value: n } : { sub: () => n }) };
        };

        if (!c.birth)
            return { ...dateMenu(tr('Born on'), undefined), input: (text) => (DATE.test(text.trim()) ? item(tr('Born on {date}', { date: text.trim() }), text.trim(), undefined) : null), note: tr('{name} has no birth date: type the new one’s (year.month.day)', { name: c.name }) };

        const row = (years: number, label?: string): ChoiceItem =>
            item(label ?? tr('{years} years', { years: signed(years) }), yearsFrom(c.birth!, years), years, {
                hint: tr('born {date}', { date: yearsFrom(c.birth!, years) }),
                warn: oddRelativeAge(relation, years),
                explain: oddRelativeAge(relation, years) ? tr('Odd, but written as asked: {why}', { why: oddRelativeAge(relation, years)! }) : undefined
            });
        return {
            title: tr('Born how many years from {name}?', { name: c.name }),
            typeahead: true,
            items: [row(ages[relation], tr('{years} years (default)', { years: signed(ages[relation]) }))],
            number: (n) => (Number.isInteger(n) ? [row(n)] : []),
            note: tr('Type a number of years: negative before {name}, positive after', { name: c.name })
        };
    };
    // someone existing, or a new one from a preset
    const who = (relation: Relation, extra: Extra): ChoiceMenu =>
    {
        // (an identical twin is a man or a woman as they are)
        const forced = relation === 'father' ? 'male' : relation === 'mother' ? 'female' : extra.twin === 'identical' && c.female !== undefined ? (c.female ? 'female' : 'male') : undefined;
        return {
            title: tr('{relation}: someone existing, or a new one from which preset?', { relation: RELATION_LABELS[relation] }),
            items: [
                {
                    label: tr('An existing character…'),
                    key: 'e',
                    sub: () => personMenu({ title: tr('{relation}: which character?', { relation: RELATION_LABELS[relation] }), exclude: [c.character], next: (id, name) => last(relation, { relation, existing: id, name: name || id }, extra) })
                },
                { label: tr('Presets'), header: true },
                ...presetItems(presets, (p) => when(relation, p, extra), forced)
            ]
        };
    };
    const steps = (r: Relation): ChoiceMenu =>
    {
        if (r === 'sibling')
        {
            return {
                title: tr('A sibling: whose child?'),
                items: [
                    { label: tr('The same parents'), key: 's', hint: tr('a full sibling'), sub: () => who(r, { siblings: 'same' }) },
                    { label: tr('A different mother…'), key: 'm', hint: tr('the same father'), sub: () => personMenu({ title: tr('Their mother'), none: tr('Unknown — no mother'), exclude: [c.character], next: (id) => who(r, { siblings: 'mother', other_parent: id }) }) },
                    { label: tr('A different father…'), key: 'f', hint: tr('the same mother'), sub: () => personMenu({ title: tr('Their father'), none: tr('Unknown — no father'), exclude: [c.character], next: (id) => who(r, { siblings: 'father', other_parent: id }) }) }
                ]
            };
        }

        if (r === 'twin')
        {
            return {
                title: tr('A twin (the same parents)'),
                items: [
                    { label: tr('Identical'), key: 'i', hint: tr('the same sex and the same face (a shared DNA)'), sub: () => who(r, { twin: 'identical' }) },
                    { label: tr('Fraternal'), key: 'f', hint: tr('a face of their own'), sub: () => who(r, { twin: 'fraternal' }) }
                ]
            };
        }

        if (r === 'child')
        {
            const base = who(r, {});
            return { ...base, title: tr('A child: with someone, between two people, someone existing, or a new one'), items: [withItem(), betweenItem(), ...base.items] };
        }

        return who(r, {});
    };
    // "With…" / "Between…": a child of two people; the age, then (both alive at the birth) which of them are known as
    // its parents; its face a mix of theirs either way (known or not: maybe only a genetic mix was wanted)
    const childAge = (father: string, mother: string): ChoiceMenu =>
    {
        // the parents as the world knows them, toggled in one menu: the mother known or not; the father known, hidden
        // (the real father, `set_real_father`; known as someone else or nobody) or not a parent. Only who is alive at
        // the birth can be either; the rest give only their genes. Default: no known parents.
        type Known = { f: boolean; m: boolean; mother: 'known' | 'none'; father: 'known' | 'hidden' | 'none'; knownFather?: { id: string; name: string; }; };
        const FATHER: Record<Known['father'], string> = { none: tr('Unknown'), known: tr('Known'), hidden: tr('Hidden') };
        const FATHER_EXPLAIN: Record<Known['father'], string> = { none: tr('Not a parent — only his genes'), known: tr('Written as the father'), hidden: tr('The real father, not known as such: someone else or nobody is known as the father') };
        const parentsMenu = (birth: string, st: Known): ChoiceMenu =>
        {
            const items: ChoiceItem[] = [{
                label: tr('Done'),
                key: 'd',
                hint: [st.mother === 'known' && 'mother', st.father === 'known' && 'father', st.father === 'hidden' && tr('real father')].filter(Boolean).join(', ') || tr('no known parents'),
                value: JSON.stringify({ relation: 'child', mix: true, father, mother, birth, motherKnown: st.mother === 'known', fatherMode: st.father, knownFather: st.knownFather?.id })
            }];
            items.push(
                st.m ?
                    { label: tr('Mother'), key: 'm', state: st.mother === 'known' ? tr('Known') : tr('Unknown'), explain: st.mother === 'known' ? tr('Written as the mother') : tr('Not a parent — only her genes'), toggle: () => parentsMenu(birth, { ...st, mother: st.mother === 'known' ? 'none' : 'known' }) } :
                    { label: tr('The mother is not alive on {date}: only her genes', { date: birth }), header: true }
            );
            items.push(
                st.f ?
                    { label: tr('Father'), key: 'f', state: FATHER[st.father], explain: FATHER_EXPLAIN[st.father], toggle: () => parentsMenu(birth, { ...st, father: st.father === 'none' ? 'known' : st.father === 'known' ? 'hidden' : 'none', knownFather: undefined }) } :
                    { label: tr('The father is not alive on {date}: only his genes', { date: birth }), header: true }
            );

            if (st.f && st.father === 'hidden')
            {
                items.push({
                    label: tr('Known as the father'),
                    key: 'k',
                    state: st.knownFather?.name ?? tr('Nobody'),
                    explain: tr('Someone else, or nobody'),
                    sub: () => personMenu({ title: tr('Known as the father'), none: tr('Nobody'), sex: 'male', exclude: [father, mother], next: (id, name) => parentsMenu(birth, { ...st, knownFather: id ? { id, name: name || id } : undefined }) })
                });
            }

            return { title: tr('Parents as the world knows them'), items, note: tr('Letters toggle · ⏎ on Done makes the child') };
        };
        const known = (birth: string): ChoiceMenu => ({
            title: tr('Parents as the world knows them'),
            items: [],
            load: async () =>
            {
                const at = dateNumber(birth);
                const spans = await api.characterLifespans([father, mother]).catch(() => []);
                const living = (id: string): boolean =>
                {
                    const x = spans.find((y) => y.id === id);
                    return !!x && (!x.birth || dateNumber(x.birth) <= at) && (!x.death || dateNumber(x.death) > at);
                };
                return parentsMenu(birth, { f: living(father), m: living(mother), mother: 'none', father: 'none' }).items;
            }
        });

        if (!c.birth)
            return { ...dateMenu(tr('Born on'), undefined), input: (text) => (DATE.test(text.trim()) ? { label: tr('Born on {date}', { date: text.trim() }), sub: () => known(text.trim()) } : null), note: tr('{name} has no birth date: type the child’s (year.month.day)', { name: c.name }) };

        const row = (years: number, label?: string): ChoiceItem => ({
            label: label ?? tr('{years} years', { years: signed(years) }),
            hint: tr('born {date}', { date: yearsFrom(c.birth!, years) }),
            sub: () => known(yearsFrom(c.birth!, years))
        });
        return {
            title: tr('Born how many years from {name}?', { name: c.name }),
            typeahead: true,
            items: [row(ages.child, tr('{years} years (default)', { years: signed(ages.child) }))],
            number: (n) => (Number.isInteger(n) ? [row(n)] : []),
            note: tr('Type a number of years: negative before {name}, positive after', { name: c.name })
        };
    };
    const otherSex = (female: boolean | undefined): 'male' | 'female' | undefined => (female === undefined ? undefined : female ? 'male' : 'female');
    const withItem = (): ChoiceItem => ({
        label: tr('With…'),
        key: 'w',
        hint: c.female ? tr('a father') : tr('a mother'),
        explain: tr('{name} and someone else', { name: c.name }),
        sub: () =>
            personMenu({
                title: c.female ? tr('With… (the father)') : tr('With… (the mother)'),
                first: spouses,
                exclude: [c.character],
                sex: otherSex(c.female),
                next: (id) => childAge(c.female ? id : c.character, c.female ? c.character : id)
            })
    });
    const betweenItem = (): ChoiceItem => ({
        label: tr('Between…'),
        key: 'b',
        hint: tr('two people'),
        explain: tr('Any two characters — {name} need not be one of them', { name: c.name }),
        sub: () =>
            personMenu({
                title: tr('Between… (the first parent)'),
                next: (first, _n, female) =>
                    personMenu({
                        title: female === undefined ? tr('… and (the other parent)') : female ? tr('… and (the father)') : tr('… and (the mother)'),
                        exclude: [first],
                        sex: otherSex(female),
                        next: (second, _m, female2) => (female ?? female2 === false) ? childAge(second, first) : childAge(first, second)
                    })
            })
    });
    const menu: ChoiceMenu = {
        title: tr('A relative of {name}', { name: c.name }),
        items: RELATIONS.map((r) => ({ label: RELATION_LABELS[r], hint: tr('{years} years', { years: signed(ages[r] ?? DEFAULT_RELATIVE_AGES[r]) }), sub: () => steps(r) }))
    };
    const chosen = await pickChoice(menu, { at, title: tr('New relative of {name}', { name: c.name }) });

    if (!chosen)
        return;

    const v = JSON.parse(chosen) as { relation: Relation; preset: string; birth: string; existing?: string; name?: string; mix?: boolean; father?: string; mother?: string; motherKnown?: boolean; fatherMode?: string; knownFather?: string; } & Extra;

    if (v.mix)
    {
        // (no preset: a man or a woman by chance; family, culture and faith from the parents)
        await make(
            [{
                what: 'character',
                key: '',
                fields: [
                    ['preset', JSON.stringify({ id: 'child', name: '' })],
                    ['birth', v.birth],
                    ['father', v.father!],
                    ['mother', v.mother!],
                    ['mother_known', v.motherKnown ? 'yes' : 'no'],
                    ['father_mode', v.fatherMode ?? 'none'],
                    ...(v.knownFather ? [['known_father', v.knownFather] as [string, string]] : []),
                    ['mix', 'yes']
                ]
            }],
            tr('New child of {father} and {mother}', { father: v.father!, mother: v.mother! })
        );
        return;
    }
    const extra: [string, string][] = (['siblings', 'other_parent', 'twin'] as const).filter((k) => v[k] !== undefined).map((k) => [k, v[k]!]);

    if (v.existing)
    {
        await make(
            [{ what: 'relative', key: c.character, fields: [['relation', v.relation], ['other', v.existing], ['parent_years', String(ages.father)], ...extra] }],
            tr('{other} is {name}’s {relation} now', { other: v.name ?? v.existing, name: c.name, relation: RELATION_LABELS[v.relation].toLowerCase() })
        );
        return;
    }

    const preset = presets.find((p) => p.id === v.preset)!;
    await make(
        [{ what: 'character', key: '', fields: [['preset', JSON.stringify(preset)], ['birth', v.birth], ['relation', v.relation], ['relative', c.character], ['parent_years', String(ages.father)], ...extra] }],
        tr('New {relation} of {name}', { relation: RELATION_LABELS[v.relation].toLowerCase(), name: c.name })
    );
}

/**
 * A new character for a title (the map's holder): a preset, then an age at `date` (the preset's, any typed); made
 * with the county's culture and faith where the preset leaves them, the holder's family for a "relative" dynasty.
 * Resolves with the new character's id (null: cancelled or refused).
 */
export async function newCharacterFor(o: { title: string; date: string; culture?: string; faith?: string; houseOf?: string; }, at: { x: number; y: number; }): Promise<string | null>
{
    const p = await pickChoice(newCharacterMenu(o.title, o.date, await api.getSettings().catch(() => null)), { at, title: tr('New character for {title}', { title: o.title }) });
    return p ? createFor(o, p) : null;
}

/**
 * The presets and ages for a new character of a title, as a menu (the map's holder menu nests it); "Between…" first
 * picks two parents (any characters): their family, culture and faith, and once the birth is known, maybe them as
 * the parents (createFor).
 */
export function newCharacterMenu(title: string, date: string, settings: Settings | null): ChoiceMenu
{
    const age = (p: CharacterPreset, parents: { father?: string; mother?: string; }): ChoiceMenu =>
    {
        const row = (n: number, label?: string): ChoiceItem => ({
            label: label ?? tr('Age {n}', { n }),
            hint: tr('born {date}', { date: yearsFrom(date, -n) }),
            warn: n < 0 ? tr('born after the date') : undefined,
            value: JSON.stringify({ newCharacter: p, birth: yearsFrom(date, -n), ...parents })
        });
        return {
            title: tr('{label}: how old on {date}?', { label: p.label, date }),
            typeahead: true,
            items: [row(p.age, tr('Age {n} (the preset’s)', { n: p.age }))],
            number: (n) => (Number.isInteger(n) ? [row(n)] : []),
            note: tr('Type an age in years')
        };
    };
    const presets = presetsOf(settings);
    const between: ChoiceItem = {
        label: tr('Between…'),
        key: 'b',
        hint: tr('two parents first'),
        explain: tr('Any two characters: the new one takes their family, culture and faith — and, when both are alive at the birth, can be written as their child'),
        sub: () =>
            personMenu({
                title: tr('Between… (the father)'),
                none: tr('No father'),
                next: (father) =>
                    personMenu({
                        title: tr('… and (the mother)'),
                        none: tr('No mother'),
                        exclude: father ? [father] : [],
                        next: (mother) => ({ title: tr('Which preset?'), items: presetItems(presets, (p) => age(p, { father: father || undefined, mother: mother || undefined })) })
                    })
            })
    };
    return { title: tr('New character for {title}', { title }), items: [between, ...presetItems(presets, (p) => age(p, {}))] };
}

/**
 * Makes the character a newCharacterMenu row chose; its id, or null. With parents chosen ("Between…") and both alive
 * at the birth, asks whether to write them as the parents (else they only give family, culture and faith).
 */
export async function createFor(o: { title: string; culture?: string; faith?: string; houseOf?: string; }, chosen: string): Promise<string | null>
{
    const v = JSON.parse(chosen) as { newCharacter: CharacterPreset; birth: string; father?: string; mother?: string; };
    const parents = [v.father, v.mother].filter((x): x is string => !!x);
    let link = false;

    if (parents.length)
    {
        const at = dateNumber(v.birth);
        const spans = await api.characterLifespans(parents).catch(() => []);
        const alive = spans.length === parents.length && spans.every((s) => (!s.birth || dateNumber(s.birth) <= at) && (!s.death || dateNumber(s.death) > at));

        if (alive)
        {
            const yes = await pickChoice(
                {
                    title: tr('Both are alive on {date}: make them the parents?', { date: v.birth }),
                    items: [
                        { label: tr('Yes — their child'), key: 'y', hint: tr('father / mother'), value: 'yes' },
                        { label: tr('No — only their family, culture and faith'), key: 'n', value: 'no' }
                    ]
                },
                { title: tr('New character for {title}', { title: o.title }) }
            );

            if (yes === null)
                return null;

            link = yes === 'yes';
        }
    }

    const keys = await make(
        [{
            what: 'character',
            key: '',
            fields: [
                ['preset', JSON.stringify(v.newCharacter)],
                ['birth', v.birth],
                ...(o.culture ? [['culture', o.culture] as [string, string]] : []),
                ...(o.faith ? [['faith', o.faith] as [string, string]] : []),
                ...(o.houseOf ? [['house_of', o.houseOf] as [string, string]] : []),
                ...(v.father ? [['father', v.father] as [string, string]] : []),
                ...(v.mother ? [['mother', v.mother] as [string, string]] : []),
                ['link', link ? 'yes' : 'no'],
                // (both chosen: a face mixed from theirs, as a child "Between…" on a card)
                ...(v.father && v.mother ? [['mix', 'yes'] as [string, string]] : [])
            ]
        }],
        tr('New character for {title}', { title: o.title })
    );
    return keys?.[0] ?? null;
}

/** y.m.d as one comparable number */
const dateNumber = (d: string): number =>
{
    const [y, m, day] = d.split('.').map(Number);
    return y * 10000 + (m || 1) * 100 + (day || 1);
};

/**
 * One entry of a type in the picker (a culture, a faith, a trait, a dynasty): the type's entries by their name in game,
 * the key beside it, most referenced first; `none` (a label): a row for "none". Resolves with the key ('' for none),
 * or null when cancelled.
 */
export async function pickEntry(type: string, title: string, at: { x: number; y: number; }, opts: { none?: string; current?: string; } = {}): Promise<string | null>
{
    const menu: ChoiceMenu = {
        title,
        typeahead: true,
        wide: true,
        items: opts.none ? [{ label: opts.none, value: '\u0000' }] : [],
        load: async () =>
            (await api.list(type))
                .filter((e) => !e.mod || e.mod.state !== 'removed')
                .sort((a, b) => b.refs - a.refs)
                .map((e) => ({ label: e.display ?? e.name, hint: e.name === opts.current ? tr('now · {name}', { name: e.name }) : e.name, icon: e.icon, entry: { type, name: e.name }, value: e.name })),
        note: tr('Type to filter (a name or key)')
    };
    const v = await pickChoice(menu, { at, title });
    return v === null ? null : v === '\u0000' ? '' : v;
}

declare global
{
    interface Window
    {
        /** test hook (scripts/icon-check.mjs): opens the entry picker */
        __pickEntry?: typeof pickEntry;
    }
}
window.__pickEntry = pickEntry;
