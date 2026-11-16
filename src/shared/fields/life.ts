/** Field sets of the life cards (src/main/describe/cards/life.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

import { tr } from '../i18n.ts';
export const LIFE_FIELDS: Record<string, FieldDef[]> = {
    // common/deathreasons/_death_reasons.info (natural_death_trigger is a section of its own)
    deathreasons: [
        { key: 'public_knowledge', label: tr('Killer publicly known'), kind: 'bool', k: 'p', read: { yes: tr('Everyone learns who the killer was'), no: tr('The killer can stay secret') }, help: tr('Everybody knows the killer (default: no)') },
        { key: 'priority', label: tr('Priority among natural deaths'), kind: 'number', k: 'r', presets: [0, 10, 20, 50, 100], read: tr('Priority $ among natural deaths'), help: tr('Of the natural death reasons whose trigger passes, the one with the highest priority is picked') },
        { key: 'default', label: tr('Fallback natural death'), kind: 'bool', k: 'd', read: { yes: tr('A fallback when no natural death reason fits'), no: tr('No fallback') }, help: tr('When no natural death reason can be picked, one of the fallbacks is picked at random') },
        { key: 'epidemic', label: tr('Epidemic…'), kind: 'ref', k: 'e', ref: 'epidemics', read: tr('The death reason of the epidemic $'), help: tr('Used for characters with the epidemic’s disease trait; their deaths count towards an ongoing epidemic') },
        { key: 'use_equipped_artifact_in_slot', label: tr('Weapon from an artifact slot…'), kind: 'ref', k: 'a', ref: 'artifacts/slots', read: tr('The killer’s artifact in the slot $ is named as the weapon') }
    ],
    // common/domiciles/types/_domicile_types.info (the building slots, assets and modifiers are blocks)
    'domiciles/types': [
        { key: 'travel', label: tr('Travels'), kind: 'bool', k: 't', read: { yes: tr('Travels to new places'), no: tr('Does not travel') } },
        { key: 'provisions', label: tr('Uses provisions'), kind: 'bool', k: 'p', read: { yes: tr('Manages provisions — travels when moved'), no: tr('No provisions — moved instantly') } },
        { key: 'herd', label: tr('Manages a herd'), kind: 'bool', k: 'h', read: { yes: tr('Manages a herd'), no: tr('No herd') } },
        { key: 'culture_and_faith', label: tr('Has a culture and faith'), kind: 'bool', k: 'c', read: { yes: tr('Keeps a culture and faith of its own'), no: tr('No culture or faith of its own') } },
        { key: 'can_move_manually', label: tr('Can be moved'), kind: 'bool', k: 'm', read: { yes: tr('Can be moved by its owner'), no: tr('Cannot be moved by its owner') } },
        { key: 'move_with_realm_capital', label: tr('Moves with the capital'), kind: 'bool', k: 'w', read: { yes: tr('Moves along with the realm capital'), no: tr('Stays when the realm capital moves') } },
        { key: 'base_external_slots', label: tr('External building slots'), kind: 'number', k: 'e', presets: [0, 1, 2, 3, 4], read: tr('$ external building slots unlocked at the start') },
        { key: 'rename_window', label: tr('Named after…'), kind: 'choice', k: 'n', read: '$', options: [['none', tr('Has no name of its own')], ['primary_title', tr('Named after the primary title')], ['house', tr('Named after the house')]] },
        { key: 'map_pin_anchor', label: tr('Map pin position'), kind: 'choice', read: tr('Map pin $ its province'), options: [['right', tr('right of')], ['up', 'above'], ['left', tr('left of')]] },
        { key: 'map_pin_lobby', label: tr('Shown in the game lobby'), kind: 'bool', k: 'l', read: { yes: tr('Shown in the game lobby'), no: tr('Not shown in the game lobby') } }
    ],
    // common/bookmarks/bookmarks/_bookmarks.info (the characters and the weight are blocks)
    'bookmarks/bookmarks': [
        { key: 'start_date', label: tr('Start date'), kind: 'text', k: 's', read: tr('Starts on $') },
        { key: 'group', label: tr('Group…'), kind: 'ref', k: 'g', ref: 'bookmarks/groups', read: tr('In the group $') },
        { key: 'is_playable', label: tr('Playable'), kind: 'bool', k: 'p', read: { yes: tr('Playable'), no: tr('Not playable') } },
        { key: 'recommended', label: tr('Recommended'), kind: 'bool', k: 'r', read: { yes: tr('Shown as recommended'), no: tr('Not recommended') } },
        { key: 'requires_dlc_flag', label: tr('Needs a DLC…'), kind: 'text', k: 'd', suggest: 'values:bookmarks/bookmarks:requires_dlc_flag', read: tr('Needs the DLC feature “$”') },
        { key: 'test_default', label: tr('Default in tests'), kind: 'bool', read: { yes: tr('The default bookmark of automated tests'), no: tr('Not the test default') } }
    ],
    // a bookmark's `character = { … }` (_bookmarks.info): who, what they rule, how they are shown (`name` / `<name>_desc` are
    // its texts, the card's text lines; `position`, the spot on the bookmark screen, in the code)
    bookmark_character: [
        { key: 'history_id', label: tr('Historical character…'), kind: 'ref', ref: 'characters', k: 'h', read: tr('The historical character $') },
        { key: 'title', label: tr('Title…'), kind: 'ref', ref: 'landed_titles', k: 't', read: tr('Starts with $') },
        { key: 'government', label: tr('Government…'), kind: 'ref', ref: 'governments', k: 'g', read: tr('$ government') },
        { key: 'culture', label: tr('Culture…'), kind: 'ref', ref: 'culture/cultures', k: 'c', read: tr('Culture $') },
        { key: 'religion', label: tr('Faith…'), kind: 'ref', ref: 'faith', k: 'f', read: tr('Faith $') },
        { key: 'dynasty', label: tr('Dynasty…'), kind: 'ref', ref: 'dynasties', k: 'y', read: tr('Dynasty $') },
        { key: 'dynasty_house', label: tr('House…'), kind: 'ref', ref: 'dynasty_houses', k: 'o', read: tr('House $') },
        { key: 'type', label: tr('Man or woman'), kind: 'choice', k: 's', read: '$', options: [['male', tr('A man')], ['female', tr('A woman')]] },
        { key: 'birth', label: tr('Born on…'), kind: 'text', k: 'b', read: tr('Born $'), help: tr('A date: year.month.day') },
        { key: 'difficulty', label: tr('Difficulty…'), kind: 'text', k: 'd', suggest: 'nested:bookmarks/bookmarks:difficulty', read: tr('Difficulty $') },
        { key: 'relation', label: tr('Relation (beside a main character)…'), kind: 'text', k: 'r', suggest: 'nested:bookmarks/bookmarks:relation', read: tr('Relation $') },
        { key: 'animation', label: tr('Animation…'), kind: 'text', k: 'a', suggest: 'nested:bookmarks/bookmarks:animation', read: tr('Animation $') },
        { key: 'dynasty_splendor_level', label: tr('Dynasty renown level'), kind: 'number', k: 'l', presets: [1, 2, 3, 4, 5, 6], read: tr('Dynasty renown level $') },
        { key: 'bookmark_type', label: tr('Starts as…'), kind: 'choice', k: 'w', read: '$', options: [['existing_ruler', tr('An existing ruler')], ['new_landless_adventurer', tr('A new landless adventurer')], ['new_noble_family', tr('A new noble family')]] }
    ],
    // common/bookmarks/groups/_bookmark_groups.info
    'bookmarks/groups': [{ key: 'default_start_date', label: tr('Default start date'), kind: 'text', k: 's', read: tr('Its bookmarks start on $ unless they say otherwise') }],
    // common/bookmarks/challenge_characters/_challenge_characters.info
    'bookmarks/challenge_characters': [{ key: 'start_date', label: tr('Start date'), kind: 'text', k: 's', read: tr('Starts on $') }],
    // common/tutorial_lessons/_tutorial_lesson.info (the lesson's own settings; its steps are blocks)
    tutorial_lessons: [
        { key: 'chain', label: tr('Chain…'), kind: 'ref', k: 'c', ref: 'tutorial_lesson_chains', read: tr('Part of the chain $') },
        { key: 'start_automatically', label: tr('Starts by itself'), kind: 'bool', k: 'a', read: { yes: tr('Starts by itself when its conditions are met'), no: tr('Only started by script (start_tutorial_lesson)') } },
        { key: 'delay', label: tr('Delay (seconds)'), kind: 'number', k: 'd', presets: [0, 1, 2, 5, 10], read: tr('Waits $ seconds before it starts') },
        { key: 'default_lesson_step_delay', label: tr('Step delay (seconds)'), kind: 'number', presets: [0, 1, 2, 5], read: tr('Each step waits $ seconds before it shows') },
        { key: 'finish_gamestate_tutorial', label: tr('Ends the guided tutorial'), kind: 'bool', read: { yes: tr('Ends the guided tutorial when done'), no: tr('Does not end the guided tutorial') } },
        { key: 'shown_in_encyclopedia', label: tr('In the encyclopedia'), kind: 'bool', k: 'e', read: { yes: tr('Shown in the encyclopedia'), no: tr('Not in the encyclopedia') } }
    ],
    // common/artifacts/types/_types.info
    'artifacts/types': [
        { key: 'slot', label: tr('Slot type'), kind: 'text', k: 's', suggest: 'values:artifacts/slots:type', read: tr('Goes into $ slots') },
        { key: 'default_visuals', label: tr('Default looks…'), kind: 'ref', k: 'v', ref: 'artifacts/visuals', read: tr('Looks like $ in test artifacts') },
        { key: 'can_reforge', label: tr('Can be reforged'), kind: 'bool', k: 'r', read: { yes: tr('Can be reforged'), no: tr('Cannot be reforged') } }
    ],
    // common/artifacts/templates/_templates.info (the rest are trigger and modifier blocks)
    'artifacts/templates': [{ key: 'unique', label: tr('Unique'), kind: 'bool', k: 'u', read: { yes: tr('Shown as unique'), no: tr('Not shown as unique') } }],
    // common/artifacts/slots
    'artifacts/slots': [
        { key: 'type', label: tr('Slot type'), kind: 'text', k: 't', suggest: 'values:artifacts/slots:type', read: tr('Holds $ artifacts') },
        { key: 'category', label: tr('Where'), kind: 'choice', k: 'c', read: '$', options: [['inventory', tr('In the inventory')], ['court', tr('In the royal court')]] },
        { key: 'icon', label: tr('Icon'), kind: 'text', k: 'i', read: tr('Icon: $') }
    ],
    // common/artifacts/visuals/_visuals.info (icons and 3D assets are lists of variants)
    'artifacts/visuals': [
        { key: 'default_type', label: tr('Default type…'), kind: 'ref', k: 't', ref: 'artifacts/types', read: tr('For $ in test artifacts') },
        { key: 'pedestal', label: tr('Pedestal'), kind: 'text', k: 'p', suggest: 'values:artifacts/visuals:pedestal', read: tr('Stands on a $ pedestal') },
        { key: 'support_type', label: tr('Support'), kind: 'text', k: 's', suggest: 'values:artifacts/visuals:support_type', read: tr('Rests on a $ support') }
    ],
    // common/artifacts/blueprints/_blueprints.info
    'artifacts/blueprints': [
        { key: 'in_type', label: tr('From the type…'), kind: 'ref', k: 'i', ref: 'artifacts/types', read: tr('Reforges artifacts of the type $') },
        { key: 'in_visuals', label: tr('From the looks…'), kind: 'ref', k: 'l', ref: 'artifacts/visuals', read: tr('Reforges artifacts looking like $') },
        { key: 'out_type', label: tr('Into the type…'), kind: 'ref', k: 'o', ref: 'artifacts/types', read: tr('Into the type $') },
        { key: 'out_visuals', label: tr('Into the looks…'), kind: 'ref', k: 'v', ref: 'artifacts/visuals', read: tr('Into the looks of $') },
        { key: 'template', label: tr('Template…'), kind: 'ref', k: 't', ref: 'artifacts/templates', read: tr('Gives it the template $') }
    ],
    // common/artifacts/features/_features.info (the trigger is a section)
    'artifacts/features': [
        { key: 'group', label: tr('Group…'), kind: 'ref', k: 'g', ref: 'artifacts/feature_groups', read: tr('One of the features of $') },
        { key: 'weight', label: tr('Weight'), kind: 'number', k: 'w', presets: [1, 2, 5, 10], ref: 'script_values', read: tr('Weight $ when one is picked at random') }
    ],
    // common/character_backgrounds: the trait characters generated with the background get (pool_character_selectors)
    character_backgrounds: [{ key: 'trait', label: tr('Trait…'), kind: 'ref', k: 't', ref: 'traits', read: tr('Gets the trait $') }]
};
