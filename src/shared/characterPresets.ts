/**
 * The app's presets for new historical characters (docs/mods.md, "New characters") and the default ages of new
 * relatives; Settings.characterPresets / relativeAges change them, for every mod.
 */
import type { CharacterPreset, Relation, Settings } from './api.ts';
import { tr } from './i18n.ts';

export const DEFAULT_PRESETS: CharacterPreset[] = [
    { id: 'noble_man', label: tr('Noble man'), sex: 'male', age: 30, dynasty: 'relative' },
    { id: 'noble_woman', label: tr('Noble woman'), sex: 'female', age: 28, dynasty: 'relative' },
    { id: 'lowborn_man', label: tr('Lowborn man'), sex: 'male', age: 30, dynasty: 'none' },
    { id: 'lowborn_woman', label: tr('Lowborn woman'), sex: 'female', age: 28, dynasty: 'none' },
    { id: 'child', label: tr('Child (either)'), sex: 'either', age: 6, dynasty: 'relative' },
    { id: 'warrior', label: tr('Warrior'), sex: 'male', age: 25, dynasty: 'none', traits: ['brave', 'education_martial_3'], skills: { martial: 12, prowess: 14 } }
];

/** A relative's birth in years from the character's: parents earlier, a child later, a twin the same day. */
export const DEFAULT_RELATIVE_AGES: Record<Relation, number> = { father: -18, mother: -18, sibling: 2, twin: 0, child: 6 };

export const RELATION_LABELS: Record<Relation, string> = { father: tr('Father'), mother: tr('Mother'), sibling: tr('Sibling'), twin: tr('Twin'), child: tr('Child') };

export function presetsOf(s: Settings | null | undefined): CharacterPreset[]
{
    return s?.characterPresets?.length ? s.characterPresets : DEFAULT_PRESETS;
}

export function relativeAgesOf(s: Settings | null | undefined): Record<Relation, number>
{
    return { ...DEFAULT_RELATIVE_AGES, ...(s?.relativeAges ?? {}) };
}

/**
 * What is odd about a relative's birth `years` from the character's (a parent born after them, a child before, a twin
 * not the same day …): a warning only: a mod may want it (time travel).
 */
export function oddRelativeAge(relation: Relation, years: number): string | undefined
{
    if ((relation === 'father' || relation === 'mother') && years >= 0)
        return years ? tr('a parent born {n} years after them', { n: years }) : tr('a parent born the same day');

    if (relation === 'child' && years <= 0)
        return years ? tr('a child born {n} years before them', { n: -years }) : tr('a child born the same day');

    if (relation === 'twin' && years !== 0)
        return tr('a twin not born the same day');

    return undefined;
}

/** A date `years` from `date` (y.m.d), the same month and day. */
export function yearsFrom(date: string, years: number): string
{
    const [y, m, d] = date.split('.').map(Number);
    return `${y + years}.${m || 1}.${d || 1}`;
}
