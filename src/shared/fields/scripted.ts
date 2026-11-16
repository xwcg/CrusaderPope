/** Field sets of the scripted cards (src/main/describe/cards/scripted.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

import { tr } from '../i18n.ts';
export const SCRIPTED_FIELDS: Record<string, FieldDef[]> = {
    // a weight block (`ai_will_do`, `ai_chance`, `weight` …, cards/weight.ts): its written numbers: the script value
    // operations and `base` / `factor` (common/scripted_modifiers/_scripted_modifiers.info)
    weight: [
        { key: 'base', label: tr('Base'), kind: 'number', k: 'b', presets: [0, 1, 5, 10, 25, 50, 100], ref: 'script_values', read: tr('Starts at $') },
        { key: 'add', label: tr('Add'), kind: 'number', k: 'a', signed: true, presets: [5, 10, 25, 50, 100, -5, -10, -25, -50, -100], ref: 'script_values', read: '$' },
        { key: 'factor', label: tr('Factor'), kind: 'number', k: 'f', presets: [0, 0.25, 0.5, 0.75, 1.5, 2, 3], ref: 'script_values', read: '×$' },
        { key: 'value', label: tr('Starts at'), kind: 'number', k: 's', presets: [0, 1, 5, 10, 25, 50, 100], ref: 'script_values', read: tr('Starts at $') },
        { key: 'subtract', label: tr('Subtract'), kind: 'number', k: 'u', presets: [1, 5, 10, 25, 50, 100], ref: 'script_values', read: '−$' },
        { key: 'multiply', label: tr('Multiply by'), kind: 'number', k: 'm', presets: [0, 0.5, 2, 3], ref: 'script_values', read: '×$' },
        { key: 'divide', label: tr('Divide by'), kind: 'number', k: 'd', presets: [2, 3, 4, 5, 10], ref: 'script_values', read: '÷$' },
        { key: 'min', label: tr('At least'), kind: 'number', k: 'l', presets: [0, 1, 5, 10], ref: 'script_values', read: tr('At least $') },
        { key: 'max', label: tr('At most'), kind: 'number', k: 'o', presets: [1, 10, 50, 100, 1000], ref: 'script_values', read: tr('At most $') }
    ],
    // common/scripted_relations/_scripted_relations.info
    scripted_relations: [
        { key: 'opinion', label: tr('Opinion of the other'), kind: 'number', k: 'o', signed: true, tone: 'good', presets: [10, 20, 30, 60, 120, -10, -20, -30, -60, -120], read: tr('$ opinion of the other one') },
        { key: 'corresponding', label: tr('The other one’s relation'), kind: 'ref', k: 'c', ref: 'scripted_relations', read: tr('The other one holds $ in turn'), help: tr('The relation the target gets back (the same key for a two-way relation)') },
        { key: 'hidden', label: tr('Hidden'), kind: 'bool', k: 'h', read: { yes: tr('Hidden from the player'), no: tr('Shown to the player') } },
        { key: 'title_grant_target', label: tr('Gets titles'), kind: 'bool', k: 't', read: { yes: tr('Unlanded ones may be given titles by a liege holding it'), no: tr('No title grants for it') } },
        { key: 'special_guest', label: tr('Special guest'), kind: 'bool', k: 's', read: { yes: tr('Shown specially in the court list'), no: tr('Not shown specially at court') }, help: tr('A target in the same court is listed as “Harold’s Ward”') },
        { key: 'fertility', label: tr('Fertility multiplier'), kind: 'number', k: 'f', presets: [0.5, 0.75, 1.25, 1.5], read: tr('Fertility between them ×$'), help: tr('In place of the PRIMARY_SPOUSE_FERTILITY_MULTIPLIER defines') },
        { key: 'secret', label: tr('Secret'), kind: 'ref', k: 'e', ref: 'secret_types', read: tr('A secret: $') }
    ],
    // common/scripted_character_templates: who create_character makes (_scripted_character_templates.info: every
    // create_character parameter but location and save_scope_as)
    scripted_character_templates: [
        { key: 'trait', label: tr('Trait'), kind: 'ref', k: 't', ref: 'traits', read: tr('Has the trait $') },
        {
            key: 'random_traits_list',
            label: tr('Traits at random from a list…'),
            kind: 'block',
            k: 'l',
            sub: 'random_traits_list',
            ask: ['count'],
            read: tr('Traits at random from a list'),
            help: tr('Picks some of the listed traits, by weight, none twice (random_traits_list)')
        },
        { key: 'random_traits', label: tr('Random traits'), kind: 'bool', k: 'r', read: { yes: tr('Also gets random traits'), no: tr('No random traits') } },
        { key: 'gender', label: tr('Gender'), kind: 'choice', k: 'g', read: tr('Always $'), options: [['male', tr('a man')], ['female', tr('a woman')]] },
        { key: 'gender_female_chance', label: tr('Chance to be a woman (%)'), kind: 'number', k: 'w', presets: [0, 10, 25, 50, 75, 100], ref: 'script_values', read: tr('$% chance to be a woman') },
        { key: 'age', label: tr('Age…'), kind: 'number', k: 'a', presets: [16, 18, 20, 25, 30, 40, 50, 60], ref: 'script_values', read: tr('Aged $') },
        { key: 'dynasty', label: tr('Dynasty'), kind: 'choice', k: 'd', read: tr('Dynasty: $'), options: [['none', tr('none (lowborn)')], ['generate', tr('a new one')]] },
        { key: 'culture', label: tr('Culture…'), kind: 'ref', k: 'c', ref: 'culture/cultures', read: tr('Culture: $') },
        { key: 'faith', label: tr('Faith…'), kind: 'ref', k: 'f', ref: 'faith', read: tr('Faith: $') },
        { key: 'dynasty_house', label: tr('House…'), kind: 'ref', k: 'h', ref: 'dynasty_houses', read: tr('House: $') },
        ...(['diplomacy', 'martial', 'stewardship', 'intrigue', 'learning', 'prowess'] as const).map((skill, i): FieldDef => ({
            key: skill,
            label: [tr('Diplomacy…'), tr('Martial…'), tr('Stewardship…'), tr('Intrigue…'), tr('Learning…'), tr('Prowess…')][i],
            kind: 'number',
            presets: [0, 4, 8, 12, 16, 20],
            ref: 'script_values',
            read: [tr('Diplomacy $'), tr('Martial $'), tr('Stewardship $'), tr('Intrigue $'), tr('Learning $'), tr('Prowess $')][i]
        })),
        { key: 'health', label: tr('Health…'), kind: 'number', presets: [1, 3, 5, 7], ref: 'script_values', read: tr('Health $') },
        { key: 'fertility', label: tr('Fertility…'), kind: 'number', presets: [0.1, 0.25, 0.5, 0.75, 1], ref: 'script_values', read: tr('Fertility $') }
    ],
    // a template's `random_traits_list = { count = N <trait> = { weight = { base = W } trigger = { … } } … }`: the traits
    // to pick from, each with its weight (1 when not written)
    random_traits_list: [
        { key: 'count', label: tr('How many…'), kind: 'number', k: 'n', presets: [1, 2, 3], read: tr('Picks $') },
        { key: '*', anyKey: 'traits', label: tr('A trait…'), kind: 'number', k: 't', presets: [1, 5, 10, 20, 50], wrap: '{ weight = { base = $ } }', read: tr('%k: weight $'), help: tr('Its weight: its share of the picks against the others') }
    ],
    // common/schemes/agent_types/_agent_types.info
    'schemes/agent_types': [
        {
            key: 'contribution_type',
            label: tr('Contributes to'),
            kind: 'choice',
            k: 'c',
            read: tr('Contributes to $'),
            options: [
                ['success_chance', tr('Success chance')],
                ['success_chance_max', tr('Maximum success chance')],
                ['success_chance_growth', tr('Success chance growth')],
                ['speed', tr('Speed')],
                ['secrecy', tr('Secrecy')]
            ]
        }
    ]
};
