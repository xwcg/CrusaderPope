/** Field sets of the scripted cards (src/main/describe/cards/scripted.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

export const SCRIPTED_FIELDS: Record<string, FieldDef[]> = {
    // a weight block (`ai_will_do`, `ai_chance`, `weight` …, cards/weight.ts): its written numbers — the script value
    // operations and `base` / `factor` (common/scripted_modifiers/_scripted_modifiers.info)
    weight: [
        { key: 'base', label: 'Base', kind: 'number', k: 'b', presets: [0, 1, 5, 10, 25, 50, 100], ref: 'script_values', read: 'Starts at $' },
        { key: 'add', label: 'Add', kind: 'number', k: 'a', signed: true, presets: [5, 10, 25, 50, 100, -5, -10, -25, -50, -100], ref: 'script_values', read: '$' },
        { key: 'factor', label: 'Factor', kind: 'number', k: 'f', presets: [0, 0.25, 0.5, 0.75, 1.5, 2, 3], ref: 'script_values', read: '×$' },
        { key: 'value', label: 'Starts at', kind: 'number', k: 's', presets: [0, 1, 5, 10, 25, 50, 100], ref: 'script_values', read: 'Starts at $' },
        { key: 'subtract', label: 'Subtract', kind: 'number', k: 'u', presets: [1, 5, 10, 25, 50, 100], ref: 'script_values', read: '−$' },
        { key: 'multiply', label: 'Multiply by', kind: 'number', k: 'm', presets: [0, 0.5, 2, 3], ref: 'script_values', read: '×$' },
        { key: 'divide', label: 'Divide by', kind: 'number', k: 'd', presets: [2, 3, 4, 5, 10], ref: 'script_values', read: '÷$' },
        { key: 'min', label: 'At least', kind: 'number', k: 'l', presets: [0, 1, 5, 10], ref: 'script_values', read: 'At least $' },
        { key: 'max', label: 'At most', kind: 'number', k: 'o', presets: [1, 10, 50, 100, 1000], ref: 'script_values', read: 'At most $' }
    ],
    // common/scripted_relations/_scripted_relations.info
    scripted_relations: [
        { key: 'opinion', label: 'Opinion of the other', kind: 'number', k: 'o', signed: true, tone: 'good', presets: [10, 20, 30, 60, 120, -10, -20, -30, -60, -120], read: '$ opinion of the other one' },
        { key: 'corresponding', label: 'The other one’s relation', kind: 'ref', k: 'c', ref: 'scripted_relations', read: 'The other one holds $ in turn', help: 'The relation the target gets back (the same key for a two-way relation)' },
        { key: 'hidden', label: 'Hidden', kind: 'bool', k: 'h', read: { yes: 'Hidden from the player', no: 'Shown to the player' } },
        { key: 'title_grant_target', label: 'Gets titles', kind: 'bool', k: 't', read: { yes: 'Unlanded ones may be given titles by a liege holding it', no: 'No title grants for it' } },
        { key: 'special_guest', label: 'Special guest', kind: 'bool', k: 's', read: { yes: 'Shown specially in the court list', no: 'Not shown specially at court' }, help: 'A target in the same court is listed as “Harold’s Ward”' },
        { key: 'fertility', label: 'Fertility multiplier', kind: 'number', k: 'f', presets: [0.5, 0.75, 1.25, 1.5], read: 'Fertility between them ×$', help: 'In place of the PRIMARY_SPOUSE_FERTILITY_MULTIPLIER defines' },
        { key: 'secret', label: 'Secret', kind: 'ref', k: 'e', ref: 'secret_types', read: 'A secret: $' }
    ],
    // common/scripted_character_templates: who create_character makes
    scripted_character_templates: [
        { key: 'trait', label: 'Trait', kind: 'ref', k: 't', ref: 'traits', read: 'Has the trait $' },
        { key: 'gender', label: 'Gender', kind: 'choice', k: 'g', read: 'Always $', options: [['male', 'a man'], ['female', 'a woman']] },
        { key: 'gender_female_chance', label: 'Chance to be a woman (%)', kind: 'number', k: 'w', presets: [0, 10, 25, 50, 75, 100], ref: 'script_values', read: '$% chance to be a woman' },
        { key: 'random_traits', label: 'Random traits', kind: 'bool', k: 'r', read: { yes: 'Also gets random traits', no: 'No random traits' } },
        { key: 'dynasty', label: 'Dynasty', kind: 'choice', k: 'd', read: 'Dynasty: $', options: [['none', 'none (lowborn)'], ['generate', 'a new one']] }
    ],
    // common/schemes/agent_types/_agent_types.info
    'schemes/agent_types': [
        {
            key: 'contribution_type',
            label: 'Contributes to',
            kind: 'choice',
            k: 'c',
            read: 'Contributes to $',
            options: [
                ['success_chance', 'Success chance'],
                ['success_chance_max', 'Maximum success chance'],
                ['success_chance_growth', 'Success chance growth'],
                ['speed', 'Speed'],
                ['secrecy', 'Secrecy']
            ]
        }
    ]
};
