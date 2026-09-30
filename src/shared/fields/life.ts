/** Field sets of the life cards (src/main/describe/cards/life.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

export const LIFE_FIELDS: Record<string, FieldDef[]> = {
    // common/deathreasons/_death_reasons.info (natural_death_trigger is a section of its own)
    deathreasons: [
        { key: 'public_knowledge', label: 'Killer publicly known', kind: 'bool', k: 'p', read: { yes: 'Everyone learns who the killer was', no: 'The killer can stay secret' }, help: 'Everybody knows the killer (default: no)' },
        { key: 'priority', label: 'Priority among natural deaths', kind: 'number', k: 'r', presets: [0, 10, 20, 50, 100], read: 'Priority $ among natural deaths', help: 'Of the natural death reasons whose trigger passes, the one with the highest priority is picked' },
        { key: 'default', label: 'Fallback natural death', kind: 'bool', k: 'd', read: { yes: 'A fallback when no natural death reason fits', no: 'No fallback' }, help: 'When no natural death reason can be picked, one of the fallbacks is picked at random' },
        { key: 'epidemic', label: 'Epidemic…', kind: 'ref', k: 'e', ref: 'epidemics', read: 'The death reason of the epidemic $', help: 'Used for characters with the epidemic’s disease trait; their deaths count towards an ongoing epidemic' },
        { key: 'use_equipped_artifact_in_slot', label: 'Weapon from an artifact slot…', kind: 'ref', k: 'a', ref: 'artifacts/slots', read: 'The killer’s artifact in the slot $ is named as the weapon' }
    ],
    // common/domiciles/types/_domicile_types.info (the building slots, assets and modifiers are blocks)
    'domiciles/types': [
        { key: 'travel', label: 'Travels', kind: 'bool', k: 't', read: { yes: 'Travels to new places', no: 'Does not travel' } },
        { key: 'provisions', label: 'Uses provisions', kind: 'bool', k: 'p', read: { yes: 'Manages provisions — travels when moved', no: 'No provisions — moved instantly' } },
        { key: 'herd', label: 'Manages a herd', kind: 'bool', k: 'h', read: { yes: 'Manages a herd', no: 'No herd' } },
        { key: 'culture_and_faith', label: 'Has a culture and faith', kind: 'bool', k: 'c', read: { yes: 'Keeps a culture and faith of its own', no: 'No culture or faith of its own' } },
        { key: 'can_move_manually', label: 'Can be moved', kind: 'bool', k: 'm', read: { yes: 'Can be moved by its owner', no: 'Cannot be moved by its owner' } },
        { key: 'move_with_realm_capital', label: 'Moves with the capital', kind: 'bool', k: 'w', read: { yes: 'Moves along with the realm capital', no: 'Stays when the realm capital moves' } },
        { key: 'base_external_slots', label: 'External building slots', kind: 'number', k: 'e', presets: [0, 1, 2, 3, 4], read: '$ external building slots unlocked at the start' },
        { key: 'rename_window', label: 'Named after…', kind: 'choice', k: 'n', read: '$', options: [['none', 'Has no name of its own'], ['primary_title', 'Named after the primary title'], ['house', 'Named after the house']] },
        { key: 'map_pin_anchor', label: 'Map pin position', kind: 'choice', read: 'Map pin $ its province', options: [['right', 'right of'], ['up', 'above'], ['left', 'left of']] },
        { key: 'map_pin_lobby', label: 'Shown in the game lobby', kind: 'bool', k: 'l', read: { yes: 'Shown in the game lobby', no: 'Not shown in the game lobby' } }
    ],
    // common/bookmarks/bookmarks/_bookmarks.info (the characters and the weight are blocks)
    'bookmarks/bookmarks': [
        { key: 'start_date', label: 'Start date', kind: 'text', k: 's', read: 'Starts on $' },
        { key: 'group', label: 'Group…', kind: 'ref', k: 'g', ref: 'bookmarks/groups', read: 'In the group $' },
        { key: 'is_playable', label: 'Playable', kind: 'bool', k: 'p', read: { yes: 'Playable', no: 'Not playable' } },
        { key: 'recommended', label: 'Recommended', kind: 'bool', k: 'r', read: { yes: 'Shown as recommended', no: 'Not recommended' } },
        { key: 'requires_dlc_flag', label: 'Needs a DLC…', kind: 'text', k: 'd', suggest: 'values:bookmarks/bookmarks:requires_dlc_flag', read: 'Needs the DLC feature “$”' },
        { key: 'test_default', label: 'Default in tests', kind: 'bool', read: { yes: 'The default bookmark of automated tests', no: 'Not the test default' } }
    ],
    // common/bookmarks/groups/_bookmark_groups.info
    'bookmarks/groups': [{ key: 'default_start_date', label: 'Default start date', kind: 'text', k: 's', read: 'Its bookmarks start on $ unless they say otherwise' }],
    // common/bookmarks/challenge_characters/_challenge_characters.info
    'bookmarks/challenge_characters': [{ key: 'start_date', label: 'Start date', kind: 'text', k: 's', read: 'Starts on $' }],
    // common/tutorial_lessons/_tutorial_lesson.info (the lesson's own settings; its steps are blocks)
    tutorial_lessons: [
        { key: 'chain', label: 'Chain…', kind: 'ref', k: 'c', ref: 'tutorial_lesson_chains', read: 'Part of the chain $' },
        { key: 'start_automatically', label: 'Starts by itself', kind: 'bool', k: 'a', read: { yes: 'Starts by itself when its conditions are met', no: 'Only started by script (start_tutorial_lesson)' } },
        { key: 'delay', label: 'Delay (seconds)', kind: 'number', k: 'd', presets: [0, 1, 2, 5, 10], read: 'Waits $ seconds before it starts' },
        { key: 'default_lesson_step_delay', label: 'Step delay (seconds)', kind: 'number', presets: [0, 1, 2, 5], read: 'Each step waits $ seconds before it shows' },
        { key: 'finish_gamestate_tutorial', label: 'Ends the guided tutorial', kind: 'bool', read: { yes: 'Ends the guided tutorial when done', no: 'Does not end the guided tutorial' } },
        { key: 'shown_in_encyclopedia', label: 'In the encyclopedia', kind: 'bool', k: 'e', read: { yes: 'Shown in the encyclopedia', no: 'Not in the encyclopedia' } }
    ],
    // common/artifacts/types/_types.info
    'artifacts/types': [
        { key: 'slot', label: 'Slot type', kind: 'text', k: 's', suggest: 'values:artifacts/slots:type', read: 'Goes into $ slots' },
        { key: 'default_visuals', label: 'Default looks…', kind: 'ref', k: 'v', ref: 'artifacts/visuals', read: 'Looks like $ in test artifacts' },
        { key: 'can_reforge', label: 'Can be reforged', kind: 'bool', k: 'r', read: { yes: 'Can be reforged', no: 'Cannot be reforged' } }
    ],
    // common/artifacts/templates/_templates.info (the rest are trigger and modifier blocks)
    'artifacts/templates': [{ key: 'unique', label: 'Unique', kind: 'bool', k: 'u', read: { yes: 'Shown as unique', no: 'Not shown as unique' } }],
    // common/artifacts/slots
    'artifacts/slots': [
        { key: 'type', label: 'Slot type', kind: 'text', k: 't', suggest: 'values:artifacts/slots:type', read: 'Holds $ artifacts' },
        { key: 'category', label: 'Where', kind: 'choice', k: 'c', read: '$', options: [['inventory', 'In the inventory'], ['court', 'In the royal court']] },
        { key: 'icon', label: 'Icon', kind: 'text', k: 'i', read: 'Icon: $' }
    ],
    // common/artifacts/visuals/_visuals.info (icons and 3D assets are lists of variants)
    'artifacts/visuals': [
        { key: 'default_type', label: 'Default type…', kind: 'ref', k: 't', ref: 'artifacts/types', read: 'For $ in test artifacts' },
        { key: 'pedestal', label: 'Pedestal', kind: 'text', k: 'p', suggest: 'values:artifacts/visuals:pedestal', read: 'Stands on a $ pedestal' },
        { key: 'support_type', label: 'Support', kind: 'text', k: 's', suggest: 'values:artifacts/visuals:support_type', read: 'Rests on a $ support' }
    ],
    // common/artifacts/blueprints/_blueprints.info
    'artifacts/blueprints': [
        { key: 'in_type', label: 'From the type…', kind: 'ref', k: 'i', ref: 'artifacts/types', read: 'Reforges artifacts of the type $' },
        { key: 'in_visuals', label: 'From the looks…', kind: 'ref', k: 'l', ref: 'artifacts/visuals', read: 'Reforges artifacts looking like $' },
        { key: 'out_type', label: 'Into the type…', kind: 'ref', k: 'o', ref: 'artifacts/types', read: 'Into the type $' },
        { key: 'out_visuals', label: 'Into the looks…', kind: 'ref', k: 'v', ref: 'artifacts/visuals', read: 'Into the looks of $' },
        { key: 'template', label: 'Template…', kind: 'ref', k: 't', ref: 'artifacts/templates', read: 'Gives it the template $' }
    ],
    // common/artifacts/features/_features.info (the trigger is a section)
    'artifacts/features': [
        { key: 'group', label: 'Group…', kind: 'ref', k: 'g', ref: 'artifacts/feature_groups', read: 'One of the features of $' },
        { key: 'weight', label: 'Weight', kind: 'number', k: 'w', presets: [1, 2, 5, 10], ref: 'script_values', read: 'Weight $ when one is picked at random' }
    ],
    // common/character_backgrounds: the trait characters generated with the background get (pool_character_selectors)
    character_backgrounds: [{ key: 'trait', label: 'Trait…', kind: 'ref', k: 't', ref: 'traits', read: 'Gets the trait $' }]
};
