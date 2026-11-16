/** Field sets of the presentation cards (src/main/describe/cards/presentation.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

import { tr } from '../i18n.ts';
const SORT: FieldDef = { key: 'sort_order', label: tr('Sort order'), kind: 'number', k: 's', presets: [0, 10, 100, 200, 300], read: tr('Sort order $ (higher comes first)') };

/** `hidden = yes`, `percent = yes` … */
const flag = (key: string, label: string, yes: string, no: string, k?: string, help?: string): FieldDef => ({ key, label, kind: 'bool', k, read: { yes, no }, help });

export const PRESENTATION_FIELDS: Record<string, FieldDef[]> = {
    // common/game_concepts: `texture`, `framesize` / `frame` pick the icon; `alias = { … }` are more keys for [key|E]
    game_concepts: [
        { key: 'parent', label: tr('Part of…'), kind: 'ref', k: 'p', ref: 'game_concepts', read: tr('Part of $'), help: tr('The broader concept it is listed under in the encyclopedia') },
        flag('shown_in_encyclopedia', tr('Shown in the encyclopedia'), tr('Shown in the encyclopedia'), tr('Not in the encyclopedia'), 'e'),
        { key: 'requires_dlc_flag', label: tr('Needs a DLC feature…'), kind: 'text', k: 'd', suggest: 'values:game_concepts:requires_dlc_flag', read: tr('Needs the DLC feature “$”') },
        { key: 'texture', label: tr('Icon'), kind: 'text', k: 'i', read: tr('Icon: $') },
        { key: 'frame', label: tr('Icon frame'), kind: 'number', k: 'f', presets: [1, 2, 3, 4], read: tr('Frame $ of its icon') }
    ],
    // common/messages/_messages.info
    messages: [
        { key: 'style', label: tr('Good or bad news'), kind: 'choice', k: 's', read: tr('News: $'), options: [['good', tr('Good')], ['bad', tr('Bad')], ['neutral', tr('Neutral')]] },
        { key: 'display', label: tr('Shown as…'), kind: 'choice', k: 'd', read: tr('Shown $'), options: [['feed', tr('in the message feed')], ['toast', tr('as a toast')]] },
        { key: 'message_filter_type', label: tr('Filter…'), kind: 'ref', k: 'f', ref: 'message_filter_types', read: tr('Filter: $'), help: tr('Where the player sets how these messages show (the effect can name another)') },
        flag('combine_into_one', tr('Combine into one'), tr('Combined into one while one is shown'), tr('Each one shown'), 'c', tr('For frequent messages: joined to one already in the feed, without a new sound')),
        { key: 'icon', label: tr('Icon'), kind: 'text', k: 'i', suggest: 'values:messages:icon', read: tr('Icon: $') },
        { key: 'soundeffect', label: tr('Sound'), kind: 'text', k: 'o', read: tr('Sound: $') },
        { key: 'title', label: tr('Title text'), kind: 'text', k: 't', read: tr('Title from $') },
        { key: 'desc', label: tr('Text'), kind: 'text', k: 'x', read: tr('Text from $') },
        { key: 'tooltip', label: tr('Tooltip text'), kind: 'text', k: 'p', read: tr('Tooltip from $') }
    ],
    // common/message_filter_types/_message_filter_types.info (name and text: message_filter_<key>, _desc)
    message_filter_types: [
        { key: 'display', label: tr('Shown as…'), kind: 'choice', k: 'd', read: tr('Shown $'), options: [['feed', tr('in the message feed')], ['toast', tr('as a toast')], ['hidden', tr('nowhere (hidden)')]] },
        flag('always_show', tr('Always shown'), tr('Players cannot hide these'), tr('Players can hide these'), 'a'),
        flag('auto_pause', tr('Pauses the game'), tr('Pauses the game'), tr('Does not pause the game'), 'p'),
        { key: 'group', label: tr('Group…'), kind: 'ref', k: 'g', ref: 'message_group_types', read: tr('In the group $') },
        SORT
    ],
    // common/message_group_types/_message_group_types.info (name: message_group_type_<key>)
    message_group_types: [SORT],
    // common/decision_group_types/_decision_group_types.info
    decision_group_types: [SORT, flag('important_decision_group', tr('Important'), tr('An important group'), tr('Not an important group'), 'i')],
    'activities/activity_group_types': [SORT],
    'situation/situation_group_types': [SORT],
    // common/character_interaction_categories (`index` must have no gaps)
    character_interaction_categories: [
        { key: 'index', label: tr('Position'), kind: 'number', k: 'i', presets: [0, 1, 2, 3, 4, 5], read: tr('Position $ in the menu (from 0, no gaps)') },
        flag('default', tr('Default category'), tr('The default category'), tr('Not the default'), 'd'),
        flag('favorite_interactions', tr('Holds the favourites'), tr('Also lists the player’s favourite interactions'), tr('No favourites'), 'f'),
        { key: 'desc', label: tr('Description text'), kind: 'text', k: 'x', read: tr('Described by $') }
    ],
    // common/modifier_definition_formats/_definitions.info
    modifier_definition_formats: [
        { key: 'decimals', label: tr('Decimals'), kind: 'number', k: 'd', presets: [0, 1, 2], read: tr('Shown with $ decimals') },
        { key: 'color', label: tr('Colour'), kind: 'choice', k: 'c', read: tr('More is $'), options: [['good', tr('good (green)')], ['bad', tr('bad (red)')], ['neutral', tr('neutral (no colour)')]] },
        flag('percent', tr('Percent'), tr('Shown as a percentage (0.1 = 10%)'), tr('Not a percentage'), 'p'),
        flag('already_percent', tr('Already a percent'), tr('Shown with % as written (10 = 10%)'), tr('Not written as a percent'), 'a'),
        flag('hidden', tr('Hidden'), tr('Hidden in game'), tr('Shown in game'), 'h'),
        flag('no_difference_sign', 'No + / − sign', tr('Shown without + / −'), tr('Shown with + / −'), 'n'),
        { key: 'prefix', label: tr('Prefix text'), kind: 'text', k: 'r', read: tr('Prefix from $') },
        { key: 'suffix', label: tr('Suffix text'), kind: 'text', k: 'u', read: tr('Suffix from $') },
        { key: 'negative_suffix', label: tr('Suffix for negative values'), kind: 'text', read: tr('Negative suffix from $') },
        { key: 'dlc_feature', label: tr('Needs a DLC feature…'), kind: 'text', k: 'f', suggest: 'values:modifier_definition_formats:dlc_feature', read: tr('Only with the DLC feature “$”') }
    ],
    // common/flavorization/_flavourization.info: what the name is for, whose it is
    flavorization: [
        { key: 'type', label: tr('Names…'), kind: 'choice', k: 't', read: tr('Names $'), options: [['character', tr('a character (their title)')], ['title', tr('a title (its rank)')], ['domicile', tr('a domicile')]] },
        { key: 'gender', label: tr('Men or women'), kind: 'choice', k: 'g', read: tr('For $'), options: [['male', 'men'], ['female', 'women']] },
        { key: 'tier', label: tr('Title tier'), kind: 'choice', k: 'r', read: tr('Tier: $'), options: [['barony', tr('Barony')], ['county', tr('County')], ['duchy', tr('Duchy')], ['kingdom', tr('Kingdom')], ['empire', tr('Empire')], ['hegemony', tr('Hegemony')], ['none', tr('Any')]] },
        {
            key: 'special',
            label: tr('Special case…'),
            kind: 'choice',
            k: 's',
            read: tr('For $'),
            options: [['holder', tr('the title’s holder')], ['head_of_faith', tr('heads of faith')], ['councillor', 'councillors'], ['queen_mother', tr('mothers of child rulers')], ['ruler_child', tr('rulers’ children')], ['domicile', tr('those with a domicile')]]
        },
        { key: 'priority', label: tr('Priority'), kind: 'number', k: 'p', presets: [1, 10, 50, 100, 300, 1000], read: tr('Priority $ (the highest that fits wins)') },
        { key: 'council_position', label: tr('Council position…'), kind: 'ref', k: 'c', ref: 'council_positions', read: tr('Holding the council position $') },
        { key: 'holding', label: tr('Holding…'), kind: 'ref', k: 'h', ref: 'holdings', read: tr('The title’s holding is $') },
        { key: 'domicile_type', label: tr('Domicile…'), kind: 'ref', k: 'd', ref: 'domiciles/types', read: tr('With the domicile $') },
        { key: 'flag', label: tr('Flag'), kind: 'text', k: 'f', suggest: 'values:flavorization:flag', read: tr('With the flag “$”') },
        { key: 'flavourization_rules', label: tr('Rules…'), kind: 'block', k: 'u', sub: 'flavourization_rules', conds: ['top_liege', 'only_independent', 'only_vassals', 'only_holder', 'spouse_takes_title', 'faction', 'ignore_top_liege_government'], read: tr('Rules') }
    ],
    // `flavourization_rules = { … }` (bools; top_liege and spouse_takes_title default to yes)
    flavourization_rules: [
        flag('top_liege', tr('Top liege decides'), tr('Its conditions are checked on the top liege'), tr('Its conditions are checked on the title’s holder, not the top liege'), 't'),
        flag('only_independent', tr('Only independent'), tr('Only independent rulers'), tr('Also vassals'), 'i'),
        flag('only_vassals', tr('Only vassals'), tr('Only vassals'), tr('Also independent rulers'), 'v'),
        flag('only_holder', tr('Only the holder'), tr('Only the title’s holder'), tr('Also others (their spouse)'), 'h'),
        flag('spouse_takes_title', tr('Spouse shares it'), tr('The holder’s spouse gets it too'), tr('Not the holder’s spouse'), 's'),
        flag('faction', tr('Faction leaders'), tr('Faction leaders (the title has a faction)'), tr('Not for faction leaders'), 'f'),
        flag('ignore_top_liege_government', tr('Own government'), tr('The government is the character’s own, not the top liege’s'), tr('The top liege’s government counts'), 'g')
    ],
    // common/customizable_localization/_custom_loc.info
    customizable_localization: [
        {
            key: 'type',
            label: tr('Runs on…'),
            kind: 'choice',
            k: 't',
            read: tr('Runs on $'),
            options: [
                ['character', tr('a character')],
                ['landed_title', tr('a title')],
                ['province', tr('a province')],
                ['faith', tr('a faith')],
                ['dynasty', tr('a dynasty')],
                ['artifact', tr('an artifact')],
                ['activity', tr('an activity')],
                ['secret', tr('a secret')],
                ['scheme', tr('a scheme')],
                ['combat', tr('a battle')],
                ['combat_side', tr('a side in battle')],
                ['title_and_vassal_change', tr('a title and vassal change')],
                ['all', 'anything']
            ]
        },
        flag('random_valid', tr('At random'), tr('One of the texts that fit, at random'), tr('The first text that fits'), 'r'),
        flag('log_loc_errors', tr('Log missing texts'), tr('Logs an error when no text fits'), tr('No error when no text fits'), 'l'),
        { key: 'parent', label: tr('Variant of…'), kind: 'ref', k: 'p', ref: 'customizable_localization', read: tr('A variant of $') },
        { key: 'suffix', label: tr('Suffix'), kind: 'text', k: 's', read: tr('Adds “$” to the chosen text’s key') }
    ]
};
