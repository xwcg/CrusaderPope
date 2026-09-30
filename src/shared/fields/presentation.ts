/** Field sets of the presentation cards (src/main/describe/cards/presentation.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

const SORT: FieldDef = { key: 'sort_order', label: 'Sort order', kind: 'number', k: 's', presets: [0, 10, 100, 200, 300], read: 'Sort order $ (higher comes first)' };

/** `hidden = yes`, `percent = yes` … */
const flag = (key: string, label: string, yes: string, no: string, k?: string, help?: string): FieldDef => ({ key, label, kind: 'bool', k, read: { yes, no }, help });

export const PRESENTATION_FIELDS: Record<string, FieldDef[]> = {
    // common/game_concepts: `texture`, `framesize` / `frame` pick the icon; `alias = { … }` are more keys for [key|E]
    game_concepts: [
        { key: 'parent', label: 'Part of…', kind: 'ref', k: 'p', ref: 'game_concepts', read: 'Part of $', help: 'The broader concept it is listed under in the encyclopedia' },
        flag('shown_in_encyclopedia', 'Shown in the encyclopedia', 'Shown in the encyclopedia', 'Not in the encyclopedia', 'e'),
        { key: 'requires_dlc_flag', label: 'Needs a DLC feature…', kind: 'text', k: 'd', suggest: 'values:game_concepts:requires_dlc_flag', read: 'Needs the DLC feature “$”' },
        { key: 'texture', label: 'Icon', kind: 'text', k: 'i', read: 'Icon: $' },
        { key: 'frame', label: 'Icon frame', kind: 'number', k: 'f', presets: [1, 2, 3, 4], read: 'Frame $ of its icon' }
    ],
    // common/messages/_messages.info
    messages: [
        { key: 'style', label: 'Good or bad news', kind: 'choice', k: 's', read: 'News: $', options: [['good', 'Good'], ['bad', 'Bad'], ['neutral', 'Neutral']] },
        { key: 'display', label: 'Shown as…', kind: 'choice', k: 'd', read: 'Shown $', options: [['feed', 'in the message feed'], ['toast', 'as a toast']] },
        { key: 'message_filter_type', label: 'Filter…', kind: 'ref', k: 'f', ref: 'message_filter_types', read: 'Filter: $', help: 'Where the player sets how these messages show (the effect can name another)' },
        flag('combine_into_one', 'Combine into one', 'Combined into one while one is shown', 'Each one shown', 'c', 'For frequent messages: joined to one already in the feed, without a new sound'),
        { key: 'icon', label: 'Icon', kind: 'text', k: 'i', suggest: 'values:messages:icon', read: 'Icon: $' },
        { key: 'soundeffect', label: 'Sound', kind: 'text', k: 'o', read: 'Sound: $' },
        { key: 'title', label: 'Title text', kind: 'text', k: 't', read: 'Title from $' },
        { key: 'desc', label: 'Text', kind: 'text', k: 'x', read: 'Text from $' },
        { key: 'tooltip', label: 'Tooltip text', kind: 'text', k: 'p', read: 'Tooltip from $' }
    ],
    // common/message_filter_types/_message_filter_types.info (name and text: message_filter_<key>, _desc)
    message_filter_types: [
        { key: 'display', label: 'Shown as…', kind: 'choice', k: 'd', read: 'Shown $', options: [['feed', 'in the message feed'], ['toast', 'as a toast'], ['hidden', 'nowhere (hidden)']] },
        flag('always_show', 'Always shown', 'Players cannot hide these', 'Players can hide these', 'a'),
        flag('auto_pause', 'Pauses the game', 'Pauses the game', 'Does not pause the game', 'p'),
        { key: 'group', label: 'Group…', kind: 'ref', k: 'g', ref: 'message_group_types', read: 'In the group $' },
        SORT
    ],
    // common/message_group_types/_message_group_types.info (name: message_group_type_<key>)
    message_group_types: [SORT],
    // common/decision_group_types/_decision_group_types.info
    decision_group_types: [SORT, flag('important_decision_group', 'Important', 'An important group', 'Not an important group', 'i')],
    'activities/activity_group_types': [SORT],
    'situation/situation_group_types': [SORT],
    // common/character_interaction_categories (`index` must have no gaps)
    character_interaction_categories: [
        { key: 'index', label: 'Position', kind: 'number', k: 'i', presets: [0, 1, 2, 3, 4, 5], read: 'Position $ in the menu (from 0, no gaps)' },
        flag('default', 'Default category', 'The default category', 'Not the default', 'd'),
        flag('favorite_interactions', 'Holds the favourites', 'Also lists the player’s favourite interactions', 'No favourites', 'f'),
        { key: 'desc', label: 'Description text', kind: 'text', k: 'x', read: 'Described by $' }
    ],
    // common/modifier_definition_formats/_definitions.info
    modifier_definition_formats: [
        { key: 'decimals', label: 'Decimals', kind: 'number', k: 'd', presets: [0, 1, 2], read: 'Shown with $ decimals' },
        { key: 'color', label: 'Colour', kind: 'choice', k: 'c', read: 'More is $', options: [['good', 'good (green)'], ['bad', 'bad (red)'], ['neutral', 'neutral (no colour)']] },
        flag('percent', 'Percent', 'Shown as a percentage (0.1 = 10%)', 'Not a percentage', 'p'),
        flag('already_percent', 'Already a percent', 'Shown with % as written (10 = 10%)', 'Not written as a percent', 'a'),
        flag('hidden', 'Hidden', 'Hidden in game', 'Shown in game', 'h'),
        flag('no_difference_sign', 'No + / − sign', 'Shown without + / −', 'Shown with + / −', 'n'),
        { key: 'prefix', label: 'Prefix text', kind: 'text', k: 'r', read: 'Prefix from $' },
        { key: 'suffix', label: 'Suffix text', kind: 'text', k: 'u', read: 'Suffix from $' },
        { key: 'negative_suffix', label: 'Suffix for negative values', kind: 'text', read: 'Negative suffix from $' },
        { key: 'dlc_feature', label: 'Needs a DLC feature…', kind: 'text', k: 'f', suggest: 'values:modifier_definition_formats:dlc_feature', read: 'Only with the DLC feature “$”' }
    ],
    // common/flavorization/_flavourization.info: what the name is for, whose it is
    flavorization: [
        { key: 'type', label: 'Names…', kind: 'choice', k: 't', read: 'Names $', options: [['character', 'a character (their title)'], ['title', 'a title (its rank)'], ['domicile', 'a domicile']] },
        { key: 'gender', label: 'Men or women', kind: 'choice', k: 'g', read: 'For $', options: [['male', 'men'], ['female', 'women']] },
        { key: 'tier', label: 'Title tier', kind: 'choice', k: 'r', read: 'Tier: $', options: [['barony', 'Barony'], ['county', 'County'], ['duchy', 'Duchy'], ['kingdom', 'Kingdom'], ['empire', 'Empire'], ['hegemony', 'Hegemony'], ['none', 'Any']] },
        {
            key: 'special',
            label: 'Special case…',
            kind: 'choice',
            k: 's',
            read: 'For $',
            options: [['holder', 'the title’s holder'], ['head_of_faith', 'heads of faith'], ['councillor', 'councillors'], ['queen_mother', 'mothers of child rulers'], ['ruler_child', 'rulers’ children'], ['domicile', 'those with a domicile']]
        },
        { key: 'priority', label: 'Priority', kind: 'number', k: 'p', presets: [1, 10, 50, 100, 300, 1000], read: 'Priority $ (the highest that fits wins)' },
        { key: 'council_position', label: 'Council position…', kind: 'ref', k: 'c', ref: 'council_positions', read: 'Holding the council position $' },
        { key: 'holding', label: 'Holding…', kind: 'ref', k: 'h', ref: 'holdings', read: 'The title’s holding is $' },
        { key: 'domicile_type', label: 'Domicile…', kind: 'ref', k: 'd', ref: 'domiciles/types', read: 'With the domicile $' },
        { key: 'flag', label: 'Flag', kind: 'text', k: 'f', suggest: 'values:flavorization:flag', read: 'With the flag “$”' },
        { key: 'flavourization_rules', label: 'Rules…', kind: 'block', k: 'u', sub: 'flavourization_rules', read: 'Rules' }
    ],
    // `flavourization_rules = { … }` (bools; top_liege and spouse_takes_title default to yes)
    flavourization_rules: [
        flag('top_liege', 'Top liege decides', 'Its conditions are checked on the top liege', 'Its conditions are checked on the title’s holder, not the top liege', 't'),
        flag('only_independent', 'Only independent', 'Only independent rulers', 'Also vassals', 'i'),
        flag('only_vassals', 'Only vassals', 'Only vassals', 'Also independent rulers', 'v'),
        flag('only_holder', 'Only the holder', 'Only the title’s holder', 'Also others (their spouse)', 'h'),
        flag('spouse_takes_title', 'Spouse shares it', 'The holder’s spouse gets it too', 'Not the holder’s spouse', 's'),
        flag('faction', 'Faction leaders', 'Faction leaders (the title has a faction)', 'Not for faction leaders', 'f'),
        flag('ignore_top_liege_government', 'Own government', 'The government is the character’s own, not the top liege’s', 'The top liege’s government counts', 'g')
    ],
    // common/customizable_localization/_custom_loc.info
    customizable_localization: [
        {
            key: 'type',
            label: 'Runs on…',
            kind: 'choice',
            k: 't',
            read: 'Runs on $',
            options: [
                ['character', 'a character'],
                ['landed_title', 'a title'],
                ['province', 'a province'],
                ['faith', 'a faith'],
                ['dynasty', 'a dynasty'],
                ['artifact', 'an artifact'],
                ['activity', 'an activity'],
                ['secret', 'a secret'],
                ['scheme', 'a scheme'],
                ['combat', 'a battle'],
                ['combat_side', 'a side in battle'],
                ['title_and_vassal_change', 'a title and vassal change'],
                ['all', 'anything']
            ]
        },
        flag('random_valid', 'At random', 'One of the texts that fit, at random', 'The first text that fits', 'r'),
        flag('log_loc_errors', 'Log missing texts', 'Logs an error when no text fits', 'No error when no text fits', 'l'),
        { key: 'parent', label: 'Variant of…', kind: 'ref', k: 'p', ref: 'customizable_localization', read: 'A variant of $' },
        { key: 'suffix', label: 'Suffix', kind: 'text', k: 's', read: 'Adds “$” to the chosen text’s key' }
    ]
};
