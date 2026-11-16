/**
 * Migrations of a mod between game versions (docs/mods.md, "Migrating a mod to a newer game version"): a mod written
 * for an older game (its descriptor's `supported_version`) brought up to the loaded game's layouts. Each migration is
 * one game version step with what changed; the plan lists what of the mod needs it, read from the views' own marks (the
 * entries' "Update for <version>" sections, the same rules the cards use), and each fix is one of modernize.ts's.
 * The fixes go into a patch mod loaded after the mod (mods/migrate.ts); the mod itself stays as its author wrote it.
 */
import type { MigrationFinding, MigrationPlan } from '../../shared/api.ts';
import { tr } from '../../shared/i18n.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import { PREFIX_TYPES, T_FLAG, T_IMAGE, T_LOC, T_MODEL, T_VARIABLE, typeLabel } from '../indexer/schema.ts';
import type { StoryBuilder } from '../describe/stories.ts';
import type { AddRule } from './addKeys.ts';
import type { GainRule } from './gainKeys.ts';
import type { BannerRule } from './bannerKeys.ts';
import type { DataCallGroup } from './dataCalls.ts';
import type { FlagKind, LibraryFolder } from './libraries.ts';
import type { DefinitionRoot, StatementGroup } from './scriptRules.ts';


/** A game version step and what changed in it that a mod's files must follow. */
export interface Migration
{
    /** the versions it goes between (major.minor) */
    from: string;
    to: string;
    label: string;
    /** what changed, in words (shown with the plan) */
    changes: string[];
    /** the entry types whose definitions may be written the old way */
    types: string[];
    /** the title of the cards' section marking an entry written the old way */
    section: string;
    /** the order fixes run in (by fix id): what others rely on first */
    order: string[];
    /**
     * folders new in this version that hold what an older folder held: a mod hiding the older one (`replace_path`)
     * hides these too, else the game's new files load into its world (a faith of a religion the mod doesn't have)
     */
    newFolders: Record<string, string[]>;
    /**
     * per older folder (of `newFolders`): the key the content that moved into the new folders was written under inside the
     * entries of the older one (1.19: the `faiths` of a religion). A mod whose entries still have it is not laid out for the
     * new version, whatever files it has in the new folders: they are hidden with the rest (`foldersWithoutOwnFiles`)
     */
    oldForms?: Record<string, string>;
    /**
     * keys renamed inside the definitions of some folders (blocks, anywhere in a definition); `definedParameter`: a block
     * whose `parameter` no doctrine or tenet defines is left out instead (the old key let it pass, the new one crashes the
     * game on it); `drop` (no `to`): the version has no such block any more; it is left out and the result says so
     */
    renames?: { folders: string[]; from: string; to?: string; label: string; definedParameter?: boolean; drop?: boolean; }[];
    /**
     * the game's files the version changed so that a mod's older copy breaks: the patch mod carries the game's own
     * (what the mod changed in them is lost: the price of a working game until the mod is updated). `dir/**`: every
     * file below dir that the mod overrides.
     */
    restore?: { files: string[]; label: string; }[];
    /**
     * game effect files (`.shader`, `.fxh`) the version changed so that a mod's older copy breaks, and that the mod uses to
     * add effects of its own: the patch mod carries the game's file with the mod's effects (and what they need) added
     * (shaderMerge.ts); what the mod changed in the game's own definitions is lost. Files that match are not restored.
     */
    mergeShaders?: { files: string[]; label: string; }[];
    /** game files the version removed: a mod's older copy is emptied in the patch mod (it would still load) */
    removed?: { files: string[]; label: string; }[];
    /**
     * game files in a subfolder of a folder the mod replaces (`replace_path` hides the files directly in the folder, not those in
     * its subfolders): they still load. When the top-level entries of such a file are `prefix:` entries (`title`) that the loaded
     * files lack, the reader reports every one after the first it does not know ("Title does not exist"): the patch mod holds
     * an empty file of the same path
     */
    survivors?: { folder: string; prefix: string; label: string; }[];
    /**
     * settings the version added to the game's named blocks (`block = { name = "…" … }`): a mod's copy of the file
     * gets them in its block of the same name; the rest of the copy stays the mod's
     */
    settings?: { files: string[]; block: string; keys: string[]; label: string; own?: boolean; }[];
    /**
     * the game's portrait models (`.asset` files, `files`) a mod copies: the animation states the version added to an entity of
     * the copy (`state = { name … }`) that a portrait animation names (the `head` and `torso` of the `animations` folder's
     * files: the game's, the mod's, the patch mod's) or that an added state goes on to, and the animations (`animation = { id … }`
     * of a mesh or an animation set) the models' states play that the copy's block lacks (modelStates.ts). The mod's own entries stay.
     * With `packs`, the files are the portrait animations' modifier pack files (`.modifierpack`) a mod copies: the game's packs a
     * portrait animation of the folder names (`portrait_modifier_pack = x`) and no loaded pack file defines, at the copy's end.
     * With `props`, the files are the copies of the game's files of its folders: the portrait modifiers (`props.modifiers`) that the
     * animations that may load and the packs that load name and no loaded file defines, in a group applied only where named; the gene
     * templates (`props.genes`) those name that the loaded gene lacks; the accessories (`props.accessories`) the templates name that no
     * loaded file defines; the entities (`props.entities`, the model files) those name that no loaded file defines are told
     */
    modelStates?: { files: string[]; animations: string; label: string; packs?: boolean; props?: { modifiers: string; genes: string; accessories: string; entities: string; }; }[];
    /** text rewritten in a mod's files (a regular expression, its replacement): a call the version changed */
    rewrites?: { files: string[]; find: string; replace: string; label: string; }[];
    /**
     * database files the mod overrides with an older copy: the entries the game's version has and no file of the mod
     * defines, and the words `lists` gained (an alias …), in a file of the patch mod loaded after them (last wins)
     */
    merge?: { files: string[]; lists: string[]; label: string; }[];
    /**
     * folders of definitions that do nothing until something names them (libraries.ts): a mod's older copy of a game
     * file hides what the version added to it, while the game's other files, the mod's and the patch mod's still call
     * it. An entry the game defines in a file the mod hid, that no loaded file of the folder defines and that a loaded
     * file names, goes (as the game wrote it) into one file of the patch mod for the folder, and so does what those
     * name in turn. World and content folders (cultures, titles, traits, events …) are never listed: a loaded file
     * naming an entry of a folder the mod replaced on purpose is not a reason to bring vanilla content back
     */
    libraries?: { label: string; folders: LibraryFolder[]; flags: FlagKind[]; };
    /**
     * localization files of the game a mod copies at the same path (`files`; the copy replaces the game's file): the game's keys the
     * copy lacks that no loaded localization file defines and that something loaded uses (a loaded file or text names it, the program
     * has it as a string, a text brought back names it) go, as the game wrote them, into one file of the patch mod per language
     * (hiddenTexts.ts). The mod's keys stay; a key the mod dropped that nothing uses stays dropped. After the libraries rule, whose
     * files name some of them
     */
    texts?: { files: string[]; label: string; }[];
    /**
     * icons the version moved to another folder (`from` → `to`) and renamed (`prefix`: old → new start of the name):
     * the definitions in `folders` (those of the patch mod too: fixes move entries there) naming an icon the new
     * folder lacks get the new name where the game has it, or the mod's icon copied into the new folder.
     * `alsoPlan`: folders where such definitions sit before the fixes (the plan reads the mod's files only)
     */
    icons?: { folders: string[]; alsoPlan?: string[]; from: string; to: string; prefix?: [string, string]; label: string; }[];
    /**
     * defines (`Namespace = { KEY = value }`, merged key by key over all files of the folder): for each of the game's
     * files the mod overrides, the keys the game's version has and the mod's copy lacks go into one file of the patch
     * mod; the mod's own values stay. `lists`: list defines whose words name entries (`GOVERNMENT_TYPES`, `prefix` as script
     * names them: `government:x`): a key is merged over the whole list, so the mod's older list is written again with the game's
     * words it lacks that the loaded world has an entry for
     */
    defines?: { folder: string; label: string; lists?: { key: string; prefix: string; }[]; }[];
    /**
     * the scope the blocks of a definition run in, by folder (`tenet_types`: `name` runs with a rite as root, `can_pick`
     * with a faith): what the `statements` rules take their scope condition from
     */
    roots?: DefinitionRoot[];
    /**
     * script statements (`key = value`) found in the parsed script, not by its text (scriptRules.ts): by key, value, the
     * blocks around and the scope they stand in; renamed, their value rewritten or dropped. In the mod's files and in the
     * patch mod's own (the fixes write tenet files there)
     */
    statements?: StatementGroup[];
    /**
     * names the version renamed by cutting a suffix (`prefix_x_common` → `prefix_x`): a map for the statement rules
     * (`valueMap`) from every key defined in the folder's files (the game's and its DLCs', the mod's and the patch
     * mod's) plus the suffix to the key, unless that is a key too
     */
    nameMaps?: { name: string; folder: string; suffix: string; }[];
    /** statements the version requires in definitions that lack them (addKeys.ts): the mod's older ones get them in the patch mod's copy */
    adds?: AddRule[];
    /**
     * what the version added to definitions a mod's older copy of a game file still holds (gainKeys.ts): the keys of the
     * game's definition of the same name that the mod's lacks, and the words of its lists, as long as the mod shows no
     * sign of knowing them. The mod's own statements stay
     */
    gains?: GainRule[];
    /**
     * a religion family's tenet banners (bannerKeys.ts): the old key goes, the four keys the version requires come in (the
     * banner the mod ships carried over, the game's values for the rest); a religion that overrode its family's banner gets
     * them in its `religion_details`
     */
    banners?: BannerRule[];
    /**
     * calls in interface and localization text the version renamed, moved or gave other arguments (dataCalls.ts): found in
     * the expressions in brackets, not by the files' text, in the mod's files and in the patch mod's copies
     */
    dataCalls?: DataCallGroup[];
    /**
     * particle files naming a compound graph by its older display name (`graph = "Spawn Delay & Duration"`): 1.20 finds a
     * compound by its id (`spawn_delay_and_duration`, the game's `compounds` folder); the name is rewritten when its
     * normalisation is an id and the linked pins are that compound's (textureRules.ts)
     */
    particles?: { folder: string; compounds: string; label: string; }[];
    /**
     * DDS files under `folder` with a DX10 header around BC1–BC3 (DXGI 70–78) get the legacy FourCC header; the block data
     * stays (the game ships no DX10 file in these formats; the engine misread one of a mod)
     */
    ddsLegacy?: { folder: string; label: string; }[];
    /**
     * the colormask textures a mod's `pattern_textures` blocks name (in `folder`'s files) with a longer mip chain than the
     * game's own (the pattern texture array wants the game's) are cut to the game's mip count
     */
    maskMips?: { folder: string; label: string; }[];
    /**
     * entries and values the version renamed that a mod's older copies of its files still name (renameRule.ts, found by comparing
     * each copy with the game's file of the same path, no name lists): an entry gets the new key, or keeps the old one with the texts,
     * files and references of the new; a value that exists nowhere takes the game's spelling
     */
    renamed?: { label: string; };
}

/**
 * Names only the holy_site scope has (the game's blocks that loop over holy sites: holy_site_county, holy_site_barony,
 * holy_site_has_artifact, is_eminent in 50_holy_site_decisions.txt, pam_values.txt:5800 is_holy_site_type, `this =
 * holy_site:x`, can_enshrine_holy_site_artifact = { holy_site = prev } of 50_holy_site_decisions.txt:669): a loop body
 * with one of them is written for 1.20 already.
 */
const HOLY_SITE_SCOPE_ONLY = '\\bholy_site_(?:county|barony|has_artifact)\\b|\\bis_eminent\\b|\\bis_holy_site_type\\b|\\bholy_site:|\\bcan_enshrine_holy_site_artifact\\b';

export const MIGRATIONS: Migration[] = [
    {
        from: '1.19',
        to: '1.20',
        label: tr('1.20 “Crozier”: religions and laws reorganised'),
        changes: [
            tr('Faiths: their own files (common/religion/faith_types) — settings in faith_details, holy_sites / doctrines / tenets lists'),
            tr('Tenets: a type of their own (common/religion/tenet_types)'),
            tr('Doctrines name their group (doctrine_group_type)'),
            tr('Law groups: their own files (common/law_groups); laws name their group (law_group_type, index)'),
            tr('Doctrine values (number_of_spouses, minimum_fervor …) in special_parameters; hostility as level names (hostility_levels)'),
            tr('Religions: family, temple models, piety icons … only inside religion_details; religion families: four tenet banner keys'),
            tr('New folders for faiths, their history, rites and holy orders: a mod replacing the game’s religions hides them too'),
            tr('Script: renamed keys, effects and triggers; fields 1.20 added to the game’s entries a mod’s older copy defines'),
            tr('Interface and text: the calls and types of windows and localization, the game’s files an older copy breaks (faith window, tooltips)'),
            tr('Shaders, particles and textures: the game’s effect files with the mod’s own effects added, compound graph names, DDS headers and mask mips'),
            tr('Definitions the game added (defines, game concepts, library entries, texts, portrait animation states) that a mod’s copy of a file hides')
        ],
        types: ['religion/doctrine_types', 'religion/tenet_types', 'religion/doctrine_group_types', 'laws', 'law_groups', 'religion/religion_types', 'religion/religion_family_types', 'faith'],
        section: tr('Update for 1.20'),
        order: ['tenet-doctrine', 'doctrine-group', 'doctrine-parameters', 'tenet-parameters', 'law-group', 'religion-details', 'religion-faiths', 'faith'],
        newFolders: {
            // (history/faiths: the known, permitted and prohibited tenets per faith and date; a faith it names that the
            // mod's religions lack is "Invalid faith key X found in faith history", once per entry; rite_names and
            // rite_icons stay: see docs/mods.md)
            'common/religion/religion_types': ['common/religion/faith_types', 'common/religion/rite_types', 'common/holy_orders', 'history/faiths']
        },
        oldForms: { 'common/religion/religion_types': 'faiths' },
        renames: [
            // (common/traits/_traits.info: "Modifier that will be applied for characters if their rite has some tenet
            // or doctrine with the specified parameter"; the 1.19 name is no longer read: the trait reader loses step
            // and makes traits of the block's keys, a `}` among them, which breaks every save written with it)
            { folders: ['common/traits'], from: 'faith_modifier', to: 'rite_modifier', label: tr('Traits: faith_modifier is rite_modifier (an older trait with it breaks the saves)'), definedParameter: true },
            // (_holy_site_types.info: the holder's modifier is county_holder_character_modifier; the 1.19 name is an
            // "Unexpected token": the holy sites read wrong, and the faith window's Holy Sites tab crashes the game)
            { folders: ['common/religion/holy_site_types'], from: 'character_modifier', to: 'county_holder_character_modifier', label: tr('Holy sites: character_modifier is county_holder_character_modifier (an older one crashes the Holy Sites tab)') },
            // (_buildings.info: province_rite_modifier, county_rite_modifier and duchy_capital_county_rite_modifier apply "only
            // if the county's rite has this parameter"; the game's temples write them where 1.19 had the faith_ ones, with
            // the same parameters; the old names are "Unexpected token", the block lost. A parameter nothing defines goes, as
            // the traits' does. The game has no character_rite_modifier or any character modifier by a rite's parameter:
            // character_faith_modifier is dropped, like the game reads it today)
            { folders: ['common/buildings'], from: 'province_faith_modifier', to: 'province_rite_modifier', label: tr('Buildings: province_faith_modifier is province_rite_modifier'), definedParameter: true },
            { folders: ['common/buildings'], from: 'county_faith_modifier', to: 'county_rite_modifier', label: tr('Buildings: county_faith_modifier is county_rite_modifier'), definedParameter: true },
            { folders: ['common/buildings'], from: 'duchy_capital_county_faith_modifier', to: 'duchy_capital_county_rite_modifier', label: tr('Buildings: duchy_capital_county_faith_modifier is duchy_capital_county_rite_modifier'), definedParameter: true },
            { folders: ['common/buildings'], from: 'character_faith_modifier', drop: true, label: tr('Buildings: character_faith_modifier has no 1.20 counterpart (no modifier of the owner by the rite’s parameter) — left out') },
            // (the modifier by the faith's doctrine: lifestyle_perks, dynasty_perks and culture/_cultural_traits.info and
            // situation/_situations.info document faith_character_modifier = { doctrine = x … }; the game's perks,
            // traditions and situations write it where 1.19 had doctrine_character_modifier; the old key is an "Unexpected
            // token", the block lost)
            { folders: ['common/lifestyle_perks', 'common/dynasty_perks', 'common/culture', 'common/situation'], from: 'doctrine_character_modifier', to: 'faith_character_modifier', label: tr('Perks, traditions and situations: doctrine_character_modifier is faith_character_modifier') },
            // (_decisions.info: `title_valid` ("root = title being evaluated (a barony for the holy order controllers)") is
            // the trigger of the create_holy_order / revoke_holy_order_lease / select_<tier>_title widgets; the game's
            // holy order decisions write it, 1.19's was barony_valid)
            { folders: ['common/decisions'], from: 'barony_valid', to: 'title_valid', label: tr('Decisions: the widget trigger barony_valid is title_valid') }
        ],
        defines: [
            // (AGOT's 1.19 copies of 00_defines.txt, ai/00_ai.txt, graphic/00_graphics.txt lack 80 of 1.20's keys
            // (NFaith.MAX_VIRTUES_SINS, MAX_FAITH_SIZE_PER_RITE …, NGameIcons.TENET_TYPE_ICON_PATH): engine defaults instead)
            // (GOVERNMENT_TYPES is a list: AGOT's lacks ecclesiastical_government, so the engine never registered that government's
            // modifiers ("Could not find the preregistered modifier type") while the game's governments file defines it)
            { folder: 'common/defines', label: tr('Defines: the keys 1.20 added, next to the mod’s older copies (its own values stay)'), lists: [{ key: 'GOVERNMENT_TYPES', prefix: 'government' }] }
        ],
        icons: [
            // (1.19's tenets were doctrines, their icons gfx/interface/icons/faith_doctrines/core_tenet_X; 1.20 reads
            // tenet icons from faith_tenets/ and named the game's tenet_X; none of the old files is left)
            {
                folders: ['common/religion/tenet_types'],
                alsoPlan: ['common/religion/doctrine_types'],
                from: 'gfx/interface/icons/faith_doctrines',
                to: 'gfx/interface/icons/faith_tenets',
                prefix: ['core_tenet_', 'tenet_'],
                label: tr('Tenet icons: 1.20 reads them from faith_tenets (the game’s renamed tenet_…) — without it tenets show empty frames')
            }
        ],
        restore: [
            // (the faith window reads 1.20's faiths, rites, holy sites and doctrines; the tooltips gained the rite,
            // holy order … ones: an older copy fails and shows nothing)
            // (and the faith conversion window: its 1.19 copy calls FaithConversionWindow.ConvertFaith / CanConvertFaith,
            // which 1.20 doesn't have)
            { files: ['gui/window_faith.gui', 'gui/window_faith_conversion.gui', 'gui/shared/cooltip.gui'], label: tr('The faith window, faith conversion and the tooltips: 1.20 reads new data in them') },
            // (the shaders' interfaces change with the game: an older copy of a game shader or of an include fails to
            // compile, and everything using it with it (characters, buildings, water). The engine layers' includes too:
            // gfx/FX/jomini/portrait.shader, gfx/FX/cw/pdxmesh.fxh …. Not the body and head models: a mod's own define
            // the head shapes its genes use (the game's lack them); see `settings`. The effect files themselves are
            // `mergeShaders`; what is left here under gfx/FX are the textures)
            { files: ['gfx/FX/**'], label: tr('The game’s textures under gfx/FX: an older copy does not match the 1.20 shaders') }
        ],
        mergeShaders: [
            // (the game's effect files with the mod's own effects added: restoring them whole takes the mod's materials'
            // effects with them ("Failed getting Effect"), and its mountains, rocks, sky and buildings are not drawn)
            { files: ['gfx/FX/**'], label: tr('The game’s shaders with the mod’s own effects added: an older copy fails to compile under 1.20') }
        ],
        removed: [
            // (1.20 made faith creation rite creation (window_rite_creation.gui); an older copy still registers its
            // types and templates first ("already registered"), and 1.20's are refused)
            { files: ['gui/window_faith_creation.gui'], label: tr('The faith creation window: 1.20 has none (rite creation instead) — an older copy registers the doctrine types first') }
        ],
        survivors: [
            // (a mod that replaces history/titles (and common/landed_titles with its own world) still gets the game's
            // history/titles/ce3/00_ecclesiastical_titles.txt: its titles are the game's, the first the world lacks is
            // reported with every title after it, 121 lines in AGOT's log)
            { folder: 'history/titles', prefix: 'title', label: tr('Title history in a subfolder of the replaced folder: the game’s file still loads and names titles the loaded files lack') }
        ],
        settings: [
            // (1.20 streams meshes; the game's body, head, eye and eyelash meshes are marked `streaming = Never`, loaded
            // at once. A mod's 1.19 copy of these models lacks it: its meshes are streamed in seconds later, after the
            // portrait system checked the skeleton points its cameras, lights and props aim at ("Invalid camera look
            // at node 'camera_torso_look_at'", "invalid node 'bn_l_prop'"); the cameras show the feet)
            { files: ['gfx/models/portraits/**/*.asset'], block: 'pdxmesh', keys: ['streaming'], label: tr('Portrait models: 1.20 loads them at once (streaming = Never) — without it portraits show only legs') },
            // (the same for a mesh the mod brings itself with a skeleton or animations of its own (a creature): a streamed mesh
            // gets its animations imported before its skeleton is there and never again, "Failed to import animation … Setting
            // animation failed for mesh". The game defines no such block, so it is found by what the block holds; `own`)
            { files: ['gfx/models/portraits/**/*.asset'], block: 'pdxmesh', keys: ['streaming'], own: true, label: tr('The mod’s own animated portrait models: 1.20 loads them at once (streaming = Never) — streamed, they get their animations before their skeleton is there and have none') }
        ],
        modelStates: [
            // (1.20's portrait animations, its religious poses among them, play states its head and body models define: male_head.asset's
            // entity has `state = { name = "divine_gesture_1" animation = "head_divine_gesture_1" … }`, its `common_head` set the animation,
            // which female_head.asset's mesh imports. A mod's 1.19 copy of these models lacks them, while the libraries rule brings in the
            // portrait animations that name them: "Unknown animation state 'divine_gesture_1' scripted for portrait animation
            // 'divine_gesture_1' in default (part 'head', type 'male')", for each portrait type, and the pose does not play)
            { files: ['gfx/models/portraits/**/*.asset'], animations: 'gfx/portraits/portrait_animations', label: tr('Portrait models: the animation states 1.20’s portrait animations play, and their animations, next to the mod’s own (without them its new poses do not play)') },
            // (1.20's religious poses add the portrait modifiers of packs by name, `portrait_modifier_pack = crozier`, packs 1.20 added to
            // the game's `animations.modifierpack`; a mod's 1.19 copy of that file hides them, and the libraries rule leaves out the game's
            // portrait animations that name one: "lack what it needs (modifier pack crozier)")
            { files: ['gfx/portraits/portrait_animations/**/*.modifierpack'], animations: 'gfx/portraits/portrait_animations', packs: true, label: tr('Portrait modifier packs: the ones 1.20’s portrait animations add (a crozier, a book …), next to the mod’s own (without them its new poses are left out)') },
            // (what those poses hold: a portrait modifier of 00_animation_props.txt, `pam_crozier_catholic_basic = { dna_modifiers = {
            // accessory = { gene = props_left template = pam_crozier_catholic_basic_01 } } }`, the gene template in 07_genes_special_
            // accessories_misc.txt, the accessory in props.txt, the entity in the prop's .asset file. A mod's 1.19 copies of the modifier and
            // gene files lack 1.20's props and templates: the pose plays empty-handed, "could not find template [x]" for a modifier that is
            // loaded, and the libraries rule leaves out the animations that name a modifier no loaded file defines)
            {
                files: ['gfx/portraits/portrait_modifiers/**/*.txt', 'common/genes/**/*.txt', 'gfx/portraits/accessories/**/*.txt'],
                animations: 'gfx/portraits/portrait_animations',
                props: { modifiers: 'gfx/portraits/portrait_modifiers', genes: 'common/genes', accessories: 'gfx/portraits/accessories', entities: 'gfx/models' },
                label: tr('Portrait props: what 1.20’s portrait animations and modifier packs hold (a crozier, a book …), its gene templates and accessories, next to the mod’s own (without them the poses are empty-handed)')
            }
        ],
        rewrites: [
            // (1.20 opens the faith view with the faith or rite itself: OpenGameViewData( 'faith', Faith.Self ); the
            // 1.19 interface passed its id (Faith.GetID), which opens nothing)
            {
                files: ['gui/**/*.gui'],
                find: "((?:Open|Toggle)GameViewData\\(\\s*'faith'\\s*,\\s*)([A-Za-z_][\\w.]*?)\\.GetID(\\s*\\))",
                replace: '$1$2.Self$3',
                label: tr('Interface: the faith view opens with the faith, not its id (an older call opens nothing)')
            },
            // (faith creation is rite creation: the game's common/defines/00_defines.txt has the discount in NRite as
            // RITE_CREATION_FERVOR_DISCOUNT_PER_MISSING_FERVOR / _MAX and its 02_religion_values.txt reads them there
            // (faith_conversion_fervor_mult); the engine's define groups are fixed, so a mod's own copy of the old keys in
            // NFaith is never read, and "Invalid define, could not find define for :FAITH_CREATION_FERVOR_DISCOUNT_…")
            {
                files: ['common/**/*.txt', 'events/**/*.txt', 'history/**/*.txt'],
                find: 'define:NFaith\\|FAITH_CREATION_FERVOR_DISCOUNT_(PER_MISSING_FERVOR|MAX)\\b',
                replace: 'define:NRite|RITE_CREATION_FERVOR_DISCOUNT_$1',
                label: tr('Defines: NFaith|FAITH_CREATION_FERVOR_DISCOUNT_… is NRite|RITE_CREATION_FERVOR_DISCOUNT_…')
            }
        ],
        roots: [
            // (_tenet_types.info: `name`, `desc`, `historical_glossary` and `piety_cost` run with a rite as root (1.19's
            // tenets were doctrines, those blocks a faith's), `is_shown`, `can_pick` and `icon` with a faith;
            // _doctrine_types.info: only `piety_cost` runs with a rite, the rest with a faith)
            { folder: 'common/religion/tenet_types', blocks: { name: 'rite', desc: 'rite', historical_glossary: 'rite', piety_cost: 'rite', is_shown: 'faith', can_pick: 'faith', icon: 'faith' } },
            { folder: 'common/religion/doctrine_types', blocks: { name: 'faith', descriptive_name: 'faith', desc: 'faith', historical_glossary: 'faith', piety_cost: 'rite', is_shown: 'faith', can_pick: 'faith' } }
        ],
        statements: [
            // (1.20 made tenets a type of their own: the game has no `has_doctrine = tenet_…` (has_tenet in a faith scope,
            // rite_has_tenet in a rite's: _tenet_types.info, 1,181 uses of rite_has_tenet), no `doctrine:tenet_…` link
            // (tenet:…) and add_tenet / remove_tenet for add_doctrine / remove_doctrine)
            {
                files: ['common/**/*.txt', 'events/**/*.txt', 'history/**/*.txt', 'gfx/portraits/**/*.txt'],
                label: tr('Tenets are no doctrines: has_doctrine, add_doctrine and remove_doctrine of a tenet are has_tenet (rite_has_tenet in a rite), add_tenet and remove_tenet; doctrine:… is tenet:…'),
                links: [{ from: 'doctrine', to: 'tenet', valueIn: 'tenets' }],
                rules: [
                    { key: 'has_doctrine', valueIn: 'tenets', scope: ['rite'], rename: 'rite_has_tenet' },
                    { key: 'has_doctrine', valueIn: 'tenets', rename: 'has_tenet' },
                    { key: 'add_doctrine', valueIn: 'tenets', rename: 'add_tenet' },
                    { key: 'remove_doctrine', valueIn: 'tenets', rename: 'remove_tenet' }
                ]
            },
            // (the blocks of a tenet that run with a rite (and a doctrine's piety_cost) use the rite's own triggers; the
            // game's tenet files write rite_has_doctrine, rite_religion_tag, rite_has_parameter there)
            {
                files: ['common/religion/tenet_types/*.txt', 'common/religion/doctrine_types/*.txt'],
                label: tr('Tenet and doctrine blocks that run with a rite (name, desc, piety_cost): rite_has_doctrine, rite_religion_tag, rite_has_parameter'),
                rules: [
                    { key: 'has_doctrine', valueNotIn: 'tenets', scope: ['rite'], rename: 'rite_has_doctrine' },
                    { key: 'religion_tag', scope: ['rite'], rename: 'rite_religion_tag' },
                    { key: 'has_doctrine_parameter', scope: ['rite'], rename: 'rite_has_parameter' }
                ]
            },
            // (the opinion flags: the doctrine fix writes `pacifist_opinion_active = yes` as the flag `pacifist` (the game's own
            // tenet_pacifism, 03_fp2_interactions.txt `has_doctrine_parameter = pacifist`); what tests the old name tests
            // a parameter no definition has any more: "doctrine parameter pacifist_opinion_active does not exist". The pairs
            // are those of the mod's doctrines and tenets the fix converts: the map `opinion_flags`, migrate.ts)
            {
                files: ['common/**/*.txt', 'events/**/*.txt', 'history/**/*.txt', 'gfx/portraits/**/*.txt'],
                label: tr('Opinion flags the doctrine fix renamed: has_doctrine_parameter and rite_has_parameter test pacifist, not pacifist_opinion_active'),
                rules: [
                    { key: 'has_doctrine_parameter', valueMap: 'opinion_flags' },
                    { key: 'rite_has_parameter', valueMap: 'opinion_flags' }
                ]
            },
            // (num_virtuous_traits / num_sinful_traits count the traits of a rite now ("target: scope type faith, expected
            // rite"); the game writes `target = root.rite`, `faith.main_rite`)
            {
                files: ['common/**/*.txt', 'events/**/*.txt', 'history/**/*.txt', 'gfx/portraits/**/*.txt'],
                label: tr('num_virtuous_traits and num_sinful_traits: the target is a rite (x.rite), not a faith'),
                // (a macro parameter as the target, `target = $FAITH$`: the call sites decide; the game writes `FAITH = host.rite`
                // where 1.19 had `host.faith`, ep3_laamp_flavour_ewan_events.txt. The `macroArg` rules write the call sites of the
                // scripted triggers and effects whose parameter is nothing but such a target, the arguments as the target rules
                // write theirs; one that uses the parameter otherwise as well stays and is told)
                macroArgs: [{ key: 'target', inside: ['num_virtuous_traits', 'num_sinful_traits'] }],
                rules: [
                    { key: 'target', inside: ['num_virtuous_traits', 'num_sinful_traits'], value: '(.+\\.)?faith', replace: '$1rite' },
                    { key: 'target', inside: ['num_virtuous_traits', 'num_sinful_traits'], value: 'faith:\\w+', replace: '$&.main_rite' },
                    // (fine as they are: a rite already; a macro parameter, whose call sites are the rules below)
                    { key: 'target', inside: ['num_virtuous_traits', 'num_sinful_traits'], note: '(.+\\.)?(main_|state_)?rite|rite:\\w+|.*\\$\\w+\\$.*' },
                    { keyPattern: '\\w+', macroArg: true, value: '(.+\\.)?faith', replace: '$1rite' },
                    { keyPattern: '\\w+', macroArg: true, value: 'faith:\\w+', replace: '$&.main_rite' },
                    { keyPattern: '\\w+', macroArg: true, note: '(.+\\.)?(main_|state_)?rite|rite:\\w+|\\$\\w+\\$' }
                ]
            },
            // (renamed in 1.20, each seen in the game's own files: lease_out_to_holy_order, set_state_rite = x.rite, the
            // scripted effect ..._effect, the scripted trigger ..._in_rite_trigger with RITE; a scripted one the mod defines
            // itself keeps its name)
            {
                files: ['common/**/*.txt', 'events/**/*.txt', 'history/**/*.txt', 'gfx/portraits/**/*.txt'],
                label: tr('Effects and triggers 1.20 renamed: lease_out_to_holy_order, set_state_rite, guardian_or_court_tutor_trigger_event_effect, sexual_activity_with_partner_is_criminal_in_rite_trigger'),
                rules: [
                    { key: 'lease_out_to', rename: 'lease_out_to_holy_order' },
                    { key: 'set_state_faith', value: '(.+\\.)?faith', replace: '$1rite', rename: 'set_state_rite', note: true },
                    { key: 'guardian_or_court_tutor_trigger_event', rename: 'guardian_or_court_tutor_trigger_event_effect', unlessDefined: { folder: 'common/scripted_effects', name: 'old' } },
                    {
                        key: 'sexual_activity_with_partner_is_criminal_in_faith_trigger',
                        rename: 'sexual_activity_with_partner_is_criminal_in_rite_trigger',
                        children: [{ key: 'FAITH', value: '(.+\\.)?faith', replace: '$1rite', rename: 'RITE' }],
                        unlessDefined: { folder: 'common/scripted_triggers', name: 'old' },
                        note: true
                    }
                ]
            },
            // (the modifier was renamed: AGOT's 1.19 common/modifiers/00_ep2_travel_modifiers.txt writes
            // faith_creation_piety_cost_mult where the game's file writes rite_creation_piety_cost_mult; the old name is
            // "Unknown modifier type". Both forms: the game's modifier_definition_formats/00_definitions.txt defines
            // rite_creation_piety_cost_add and _mult next to the unchanged faith_conversion_piety_cost_*, and MOD_RITE_… are
            // the only keys of the family in the localization. A sweep of the 1.19 vanilla copies AGOT ships and of the other
            // installed mods' modifiers for any other faith/rite/doctrine/holy-site key the 1.20 files lack found no more)
            {
                files: ['common/**/*.txt'],
                label: tr('Modifiers: faith_creation_piety_cost_add and _mult are rite_creation_piety_cost_add and _mult'),
                rules: [
                    { key: 'faith_creation_piety_cost_mult', rename: 'rite_creation_piety_cost_mult' },
                    { key: 'faith_creation_piety_cost_add', rename: 'rite_creation_piety_cost_add' }
                ]
            },
            // (a script value the engine asks for by name: "The game expects the named value 'rite_creation_cost_mult' to exist"; the
            // doctrine cost multiplier of a new rite, which 1.19 called faith_creation_cost_mult; the game's 02_religion_values.txt
            // defines it under the new name, with the same scope:old_faith, and nothing reads the old one. A copy of that file in a
            // mod, or a value of the mod's own under the old name, is renamed; one the mod defines under the new name stays)
            {
                files: ['common/script_values/*.txt'],
                label: tr('Script values: faith_creation_cost_mult is rite_creation_cost_mult (the name the engine asks for)'),
                rules: [{ key: 'faith_creation_cost_mult', top: true, rename: 'rite_creation_cost_mult', unlessDefined: { folder: 'common/script_values', name: 'new' } }]
            },
            // (the scripted rule for creating a faith is the one for creating a rite: the game's 00_rules.txt has the same
            // comment on can_create_rite and can_create_rite_trigger the same body; the game keeps faith_conversion)
            {
                files: ['common/scripted_rules/*.txt'],
                label: tr('Scripted rules: faith_creation is can_create_rite'),
                rules: [{ key: 'faith_creation', top: true, rename: 'can_create_rite', unlessDefined: { folder: 'common/scripted_rules', name: 'new' } }]
            },
            // (a government is administrative or theocratic by its mechanic_type now (_governments.info: "Use the
            // government_has_mechanic trigger to check mechanic in script"); the game's scripts write
            // `government_has_mechanic = administrative` where 1.19's wrote government_allows = administrative (the same
            // place in 00_succession_laws.txt: line 138 of the game's against 1.19's NOT = { government_allows = administrative });
            // `government_allows` takes the government rules, and 1.20 has no `administrative` or `religious` among them
            // ("Not a valid government rule"). Theocracy: the game's theocracy governments are mechanic_type = theocracy)
            {
                files: ['common/**/*.txt', 'events/**/*.txt', 'history/**/*.txt', 'gfx/portraits/**/*.txt'],
                label: tr('government_allows = administrative (religious) is government_has_mechanic = administrative (theocracy)'),
                rules: [
                    { key: 'government_allows', value: 'administrative', rename: 'government_has_mechanic' },
                    { key: 'government_allows', value: 'religious', rename: 'government_has_mechanic', replace: 'theocracy' }
                ]
            },
            // (and the government rules `administrative = yes` / `religious = yes`, which 1.20 reads as an "Unexpected enum":
            // the game's administrative governments (administrative, celestial, steppe_admin, meritocratic …) carry
            // `mechanic_type = administrative` instead and no such rule, its theocracy ones `mechanic_type = theocracy`. A
            // government of the mod that has none gets it, so the trigger above keeps finding it)
            {
                files: ['common/governments/*.txt'],
                label: tr('Government rules: administrative = yes and religious = yes are mechanic_type administrative and theocracy'),
                rules: [
                    { key: 'administrative', value: 'yes', inside: ['government_rules'], drop: true, alsoAdd: [{ key: 'mechanic_type', value: 'administrative' }] },
                    { key: 'religious', value: 'yes', inside: ['government_rules'], drop: true, alsoAdd: [{ key: 'mechanic_type', value: 'theocracy' }] },
                    // (`= no` was the default: the key is gone without a replacement; it is the same "Unexpected enum", AGOT's
                    // 1.20.0.4 error.log has it for `religious = no` three times)
                    { key: 'administrative', value: 'no', inside: ['government_rules'], drop: true },
                    { key: 'religious', value: 'no', inside: ['government_rules'], drop: true }
                ]
            },
            // (_succession_appointment.info: `allowed_candidate_tier` lower (the default) / lower_or_equal / any; the game's
            // appointments that allow the same tier write it with `cooldown = yes` ("take care when disabling cooldown when
            // same-tier or higher-tier candidates are allowed: sidegrading can cause succession loops"), every one of them:
            // the game's celestial_governor.txt, meritocratic_regent.txt … against the 1.19 copies' allow_same_tier_candidates)
            {
                files: ['common/succession_appointment/*.txt'],
                label: tr('Appointments: allow_same_tier_candidates = yes is allowed_candidate_tier = lower_or_equal (with a cooldown, as the game’s), = no goes'),
                rules: [
                    { key: 'allow_same_tier_candidates', value: 'yes', rename: 'allowed_candidate_tier', replace: 'lower_or_equal', alsoAdd: [{ key: 'cooldown', value: 'yes' }] },
                    { key: 'allow_same_tier_candidates', value: 'no', drop: true }
                ]
            },
            // (_succession_election.info: the candidates and the electors are `character_sets`, a keyed block per set with its
            // `type` and `limit`, unique keys, "used to support tracing the candidates back to the set"; the game's
            // 01_princely_elective.txt names them <elective>_electors_holder … . 1.19 listed them as `add = holder` /
            // `add = { type = x limit = { … } }` statements of the blocks)
            {
                files: ['common/succession_election/*.txt'],
                label: tr('Elections: the candidates and electors listed with add = … are character_sets'),
                rules: [
                    { key: 'candidates', collect: { child: 'add', into: 'character_sets', type: 'type' } },
                    { key: 'electors', collect: { child: 'add', into: 'character_sets', type: 'type' } }
                ]
            },
            // (the accessories the genes list by name: a name that is no accessory of the game or the mods, while it minus
            // 1.19's `_common` is one; the game's own male_clothes_religious_orthodox_head_01 where the 1.19 copy lists
            // …_01_common ("has an invalid accessory"); a name that is an accessory stays)
            {
                files: ['common/genes/**/*.txt'],
                label: tr('Genes: accessory names that lost 1.19’s _common are the accessories without it'),
                rules: [
                    { keyPattern: '\\d+', contains: '_common', valueMap: 'accessories_common' },
                    { bare: true, contains: '_common', valueMap: 'accessories_common' }
                ]
            },
            // (a faith's holy sites are holy_site scopes in 1.20: any_/every_/random_holy_site go over them, with holy_site_county,
            // holy_site_barony, is_eminent … (the game's 50_holy_site_decisions.txt, pam_interactions.txt:4941); 1.19's loop gave
            // the barony title, and the game's own files that kept that reading write any_/every_/random_holy_site_barony (54, 8
            // and 16 uses; 80_major_decisions.txt:757, 00_religious_triggers.txt:1442, legend_spread_events_8.txt:1588 are the
            // 1.19 blocks of AGOT's copies with the new name). A 1.19 block is renamed unless its body already speaks of the
            // holy site (a mod partly updated): error.log "Invalid scope types for event target link, link: county|barony|
            // title_province", 24 times. ordered_ has no use in the game's files; the engine makes the four iterators of a list)
            {
                files: ['common/**/*.txt', 'events/**/*.txt', 'history/**/*.txt', 'gfx/portraits/**/*.txt'],
                label: tr('Holy site loops: any_/every_/random_holy_site went over barony titles, they are now any_/every_/random_holy_site_barony (holy_site is a scope of its own)'),
                rules: ['any', 'every', 'random', 'ordered'].map((p) => ({ key: `${p}_holy_site`, bodyNot: HOLY_SITE_SCOPE_ONLY, rename: `${p}_holy_site_barony` }))
            },
            // (_holy_site_types.info: `parameters = { x }`, "arbitrary parameters", tested by has_holy_site_parameter (barony) and
            // controls_holy_site_with_parameter (faith), which the game's court chaplain values use for jerusalem_conversion_bonus;
            // 1.19's was `flag = x`, repeatable (DA-TAW's 1.19 _holy_sites.info: "flag = flag1 / flag = flag2"), an unknown key now)
            {
                files: ['common/religion/holy_site_types/*.txt'],
                label: tr('Holy sites: flag = x are the parameters = { x } of the site'),
                rules: [{ key: 'flag', gather: { into: 'parameters' } }]
            },
            // (1.19's religion families had `is_pagan = yes|no`; 1.20's _religion_family_types.info has no such key and none of the
            // game's families writes it: "Unexpected token: is_pagan" for each family that has it. The reader skips it, so it goes
            // without a change in what the family does)
            {
                files: ['common/religion/religion_family_types/*.txt'],
                label: tr('Religion families: is_pagan is no key of 1.20 (the game reads it as an unexpected token) — left out'),
                rules: [{ key: 'is_pagan', drop: true }]
            }
        ],
        nameMaps: [{ name: 'accessories_common', folder: 'gfx/portraits/accessories', suffix: '_common' }],
        adds: [
            // (_activity_type.info: `header_background`, a texture, or a block of triggers and a reference; every game
            // activity type has one, and 1.20 logs "Activity type X is missing Header Background texture" for the 1.19
            // ones. The pictures are gfx/interface/illustrations/activity_header_backgrounds/activity_<name>.dds; 1.19 named
            // one in the type's own `background` (the game's tournament still does). A type of the game's own kind gets the
            // game's; any other the feast's, the most general gathering)
            {
                files: ['common/activities/activity_types/*.txt'],
                key: 'header_background',
                // (the game's pilgrimage has twelve: eleven blocks with a trigger that names its religions, faiths and families
                // (`religion:islam_religion`, `faith:orthodox`, `rf_sinitic`), and the plain fallback. A mod that replaces the game's
                // religions has none of those names: only the blocks it can read are taken over, the fallback among them)
                dropAbsent: true,
                label: tr('Activity types: header_background, new in 1.20 (the type’s own header picture, the game’s of that name, else the feast’s)'),
                sources: [
                    { own: { block: 'background', child: 'texture', value: '.*/activity_header_backgrounds/.*' } },
                    { game: true },
                    { text: '"gfx/interface/illustrations/activity_header_backgrounds/activity_feast.dds"' }
                ]
            }
        ],
        gains: [
            // (a 1.19 copy of the game's tenet (AGOT's 30_core_tenets.txt: 62 of the game's 97 tenets) overrides the game's
            // 1.20 one and lacks what only 1.20 has: _tenet_types.info `personal_tenet_modifier`, `personal_tenet_parameters`,
            // `can_pick_as_personal_tenet` (personal tenets are new in 1.20), `historical_glossary`, `divergence_multiplier`
            // (rite divergence); the game's 00_tenet_types.txt has 111 lines with personal_tenet_modifier or personal_tenet_parameters (152 with
            // 00_pam_tenets.txt), no file of AGOT one; and the parameters the game's scripts test
            // (`has_doctrine_parameter = tenet_legalism_sinful_revocation`: "doctrine parameter X does not exist", 117 of
            // the 146 log lines). A parameter some tenet or doctrine of the mod's own files already has is left: the mod
            // knew it and may have taken it out of this tenet)
            {
                files: ['common/religion/tenet_types/*.txt'],
                pending: ['common/religion/doctrine_types/*.txt'],
                keys: ['personal_tenet_modifier', 'personal_tenet_parameters', 'can_pick_as_personal_tenet', 'historical_glossary', 'divergence_multiplier'],
                lists: ['parameters', 'special_parameters'],
                dropAbsent: true,
                gaps: 'tenets',
                label: tr('Tenets the game defines too: personal tenet settings, glossary, divergence and the parameters 1.20 added (the mod’s own stay)')
            },
            // (_doctrine_types.info `divergence`: "Divergence value for this particular doctrine", 92 of the game's 126 doctrines
            // have it, none of AGOT's 324; _doctrine_group_types.info `divergence = category|sequence`, `doctrine_lock`,
            // `main_rite`: 1.20's rites diverge from each other by the doctrines they differ in)
            {
                files: ['common/religion/doctrine_types/*.txt'],
                keys: ['divergence'],
                // (the parameters the game's scripts test: `rite_has_parameter = clergy_can_marry_disabled` in court_scheme.txt,
                // `has_doctrine_parameter = immaterial_harmony_no_holy_orders` in 00_religious_triggers.txt; AGOT's copies lack 18
                // words of 14 doctrines; one some other doctrine of the mod has is left, as with the tenets)
                lists: ['parameters', 'special_parameters'],
                label: tr('Doctrines the game defines too: divergence and the parameters 1.20 added (the mod’s own stay)')
            },
            {
                files: ['common/religion/doctrine_group_types/*.txt'],
                keys: ['divergence', 'doctrine_lock', 'main_rite'],
                label: tr('Doctrine groups the game defines too: divergence, doctrine_lock and main_rite, new in 1.20')
            },
            // (_law_groups.info `required_government_flag`: "fast-path filter checked before can_have_group", `can_have_group`: the
            // game's groups gate themselves (crown_authority with government_uses_crown_authority, title_succession_laws with
            // `can_have_group = { always = no }`); 1.19's gated through the laws' can_keep, so the copy a fix writes into
            // law_groups would be valid for every government)
            {
                files: ['common/law_groups/*.txt'],
                pending: ['common/laws/*.txt'],
                keys: ['required_government_flag', 'can_have_group'],
                label: tr('Law groups the game defines too: required_government_flag and can_have_group, new in 1.20')
            },
            // (the game's 00_basic_modifiers.txt gives piety_level_0, 4, 5, 6, 7 and 8 `personal_tenet_slot_add` (-1, 1, 1, 1, 1, 2): the
            // engine applies the modifiers by name, so without it no piety level gives a personal tenet slot)
            {
                files: ['common/modifiers/*.txt'],
                keys: ['personal_tenet_slot_add'],
                label: tr('Modifiers the game defines too: personal_tenet_slot_add (the piety levels’ personal tenet slots), new in 1.20')
            },
            // (_templates.info `is_holy_relic`: "Relics can be enshrined into holy sites"; 36 of the game's 76 artifact templates
            // have it, none of AGOT's 212; it names the religions whose relics they are)
            {
                files: ['common/artifacts/templates/*.txt'],
                keys: ['is_holy_relic'],
                dropAbsent: true,
                label: tr('Artifact templates the game defines too: is_holy_relic (which relics a holy site can enshrine), new in 1.20')
            }
        ],
        banners: [
            // (_religion_family_types.info: `tenet_background_icon` ("approved by Faith, or Core for Faith/Rite"),
            // `tenet_heretical_background_icon`, `tenet_neutral_background_icon`, `tenet_unknown_background_icon`: names of
            // textures in faith_tenets/ with a _small variant, "make sure both textures exist"; the game's families all write
            // the same four. 1.19's doctrine_background_icon is an "Unexpected token", and a family without the four is
            // "Religious family X needs complete icon setup")
            {
                files: ['common/religion/religion_family_types/*.txt'],
                old: 'doctrine_background_icon',
                keys: ['tenet_background_icon', 'tenet_heretical_background_icon', 'tenet_neutral_background_icon', 'tenet_unknown_background_icon'],
                always: true,
                from: 'gfx/interface/icons/faith_doctrines',
                to: 'gfx/interface/icons/faith_tenets',
                valuesIn: 'common/religion/religion_family_types',
                label: tr('Religion families: the four tenet banner keys 1.20 requires instead of doctrine_background_icon (the banner the mod ships carried over, the game’s for the rest)')
            },
            // (_religion_types.info: the same four in religion_details ("all four must be set for the religion to override
            // the family's icons"))
            {
                files: ['common/religion/religion_types/*.txt'],
                old: 'doctrine_background_icon',
                keys: ['tenet_background_icon', 'tenet_heretical_background_icon', 'tenet_neutral_background_icon', 'tenet_unknown_background_icon'],
                into: 'religion_details',
                from: 'gfx/interface/icons/faith_doctrines',
                to: 'gfx/interface/icons/faith_tenets',
                valuesIn: 'common/religion/religion_family_types',
                label: tr('Religions with a tenet banner of their own: the four keys in religion_details (a banner the mod does not ship is left out: the family’s applies)')
            }
        ],
        // (error.log of a 1.19 mod: "Failed to find compound node graph 'Spawn Delay & Duration'"; 1.20's gfx/compound_nodes has
        // spawn_delay_and_duration.compound, which the game's own particles name by that id; the pins match. Unconfirmed by a game run)
        particles: [
            { folder: 'gfx/particles', compounds: 'gfx/compound_nodes', label: tr('Particles: a compound graph is named by its id (Spawn Delay & Duration is spawn_delay_and_duration)') }
        ],
        // (a DX10 header in BC3 sRGB (DXGI 78): the engine logged "Expected more data in the texture mipmaps" and chose
        // B8G8R8A8; the game ships no DX10 file in BC1–BC3. Unconfirmed by a game run)
        ddsLegacy: [
            { folder: 'gfx', label: tr('Textures: BC1–BC3 with a DX10 header get the plain DDS header (the game has none with it)') }
        ],
        // (error.log: "inconsistent properties … should have the same resolution and format as the first one" for every
        // colormask with 10 mip levels; all 309 distinct ones the game references (507 references) have 2. Unconfirmed by a game run)
        maskMips: [
            { folder: 'gfx/portraits/accessory_variations', label: tr('Portrait pattern masks: cut to the mip levels of the game’s own (a longer chain is refused)') }
        ],
        // (seen in a mod's 1.20 game run, for example: the trait scholar is erudite in 1.20, the reactive advice action and its lesson
        // got `_rites`, the unique artifact icons artefact_icons_ are artifact_icons_, the ambient sound entities map_ambient_3D_ are
        // map_ambient_3d_; the rule finds them by the comparison, it names none)
        renamed: { label: tr('Entries and names 1.20 renamed that the mod’s copies of the game’s files still use') },
        dataCalls: [
            // (interface calls, each read from the 1.20.1.2 game's own file at the same widget: hud.gui:6140/6147 and
            // shared/mapmodes.gui:245/396 ClearExplored…, window_my_realm.gui:2170/3871 OpenGameView( 'designate_heir' ),
            // :3968 OpenGameViewData( 'succession_law_change', GuiLawGroup.Self ), :4047/:4190 'title_election',
            // window_military.gui:3954/3965 the holy order row, window_title.gui:2547 Title.GetSuccessionDescription under
            // TitleViewWindow.GetTitle (:41), window_ruler_designer.gui:272-273 the designer's state is a rite,
            // window_domicile.gui:1885 PlayBuildingSfx, 21 uses of HasMechanic( 'administrative' ) and none of the rule,
            // map_icon_layer.gui:496-520 no `visible` on the strait icon)
            {
                files: ['gui/**/*.gui'],
                label: tr('Interface: calls 1.20 renamed or moved (explored realms and houses, the succession windows, a holy order’s view, the state rite, the ruler designer’s rite, the administrative mechanic …)'),
                rules: [
                    { name: 'ClearExploringRealms', rename: 'ClearExploredRealms' },
                    { name: 'ClearExploringHouses', rename: 'ClearExploredHouses' },
                    { name: 'OpenDesignateHeirWindow', args: 'none', call: "OpenGameView( 'designate_heir' )" },
                    { name: 'OpenSuccessionLawChangeWindow', args: 1, call: "OpenGameViewData( 'succession_law_change', $1 )" },
                    { name: 'OpenSuccessionElectionWindowForTitle', args: 1, call: "OpenGameViewData( 'title_election', $1 )" },
                    // (a judgement call: the 1.20 row opens the order's title window, no holy order detail panel is left)
                    { name: 'OpenHolyOrderDetailView', args: 1, argMatch: ['HolyOrder\\.Self'], call: "OpenGameViewData( 'title_view_window', HolyOrder.GetTitle )" },
                    { name: 'IsHolyOrderDetailViewShown', args: 1, argMatch: ['HolyOrder\\.Self'], call: "IsGameViewDataShown( 'title_view_window', HolyOrder.GetTitle )" },
                    { name: 'TitleViewWindow.GetSuccessionDescription', rename: 'TitleViewWindow.GetTitle.GetSuccessionDescription' },
                    // (icon_trait's faith_context: the designer supplies its rite there, as the game's overrides do; elsewhere the faith is the rite's)
                    { name: 'RulerDesignerWindow.GetFaith', inside: 'faith_context', rename: 'RulerDesignerWindow.GetRite' },
                    { name: 'RulerDesignerWindow.GetFaith', rename: 'RulerDesignerWindow.GetRite.GetFaith' },
                    { name: 'PlayBuildingNotificationSfx', rename: 'PlayBuildingSfx' },
                    { name: 'HasRule', args: 1, argMatch: ["'administrative'"], rename: 'HasMechanic' },
                    { name: 'StraitMapIcon.ShouldBeShown', dropProperty: true },
                    { name: 'LedgerFaithItem', rename: 'FaithItem' },
                    // (calls that changed in a way no rewrite maps: told)
                    { name: 'GreatProjectType.GetIllustration', args: 'none', report: tr('needs a character now (the planner of the great project item)') },
                    { name: 'GreatProjectType.GetGreatProjectItemDescriptionTooltip', args: 'none', report: tr('needs a character now (the planner of the great project item)') },
                    { name: 'GetType.GetGreatProjectItemDescriptionTooltip', report: tr('is GreatProject.GetProjectCompletedEffectsDescription now') },
                    { name: 'RulerDesignerWindow.SetFaith', report: tr('the ruler designer picks a rite now (SetRite)') },
                    { name: 'GetDoctrineBackgroundIcon', report: tr('the ledger lists a rite’s tenets now (Faith.GetTenetBackgroundIcon( Rite.Self, TenetType.Self ))') }
                ],
                // (icon_trait: `faith_context` sets the faith and the rite (Character.GetFaith, Character.GetRite); the game's
                // overrides in window_accolade.gui:486-487 and window_character_filter.gui:305-306 supply both)
                siblings: [{ inside: 'faith_context', key: 'datacontext', from: 'GetFaith', to: 'GetRite' }]
            },
            // (the faith state, faith creation and activity phases in texts: the game's loc and gui write the right-hand
            // sides: GetStateRite (title_view_l_english.yml GRANT_TO_*_NOBLE_INFO), RiteCreationWindow.* (rite_creation_window_l_english.yml:123),
            // ActivityPhase.GetDescription( Activity.Self ) (activity_window_l_english.yml:66,129), DecisionViewWidgetSelectBarony.HasValidTitles
            // (specialinteractions_l_english.yml:622); the faith creation window itself is gone: what only it showed has no replacement)
            {
                files: ['gui/**/*.gui', 'localization/**/*.yml'],
                label: tr('Texts: the state rite, rite creation, an activity phase’s description, the holy order barony check (renamed or given an argument)'),
                rules: [
                    { name: 'GetStateFaith', rename: 'GetStateRite' },
                    { name: 'GetCountiesOfStateFaith', rename: 'GetCountiesOfStateRite' },
                    { name: 'FaithCreationWindow.CalcPietyCost', in: 'loc', rename: 'RiteCreationWindow.CalcPietyCost' },
                    { name: 'FaithCreationWindow.CalcPietyMissing', in: 'loc', rename: 'RiteCreationWindow.CalcPietyMissing' },
                    { name: 'FaithCreationWindow.GetCreationBlockers', in: 'loc', rename: 'RiteCreationWindow.GetCreationBlockers' },
                    { name: 'FaithCreationWindow.GetPietyCostDesc', in: 'loc', rename: 'RiteCreationWindow.GetPietyCostDesc' },
                    { name: 'FaithCreationWindow.GetHostilityLevel', in: 'loc', rename: 'RiteCreationWindow.GetHostilityLevel' },
                    { name: 'FaithCreationWindow.CanCreateFaith', in: 'loc', rename: 'RiteCreationWindow.CanCreateRite' },
                    { name: 'FaithCreationWindow.GetNewFaithName', in: 'loc', rename: 'RiteCreationWindow.GetNewRiteName' },
                    // (these two stand in interface files too: tournament_contest_information.gui:237 and
                    // decision_view_widget_create_holy_order.gui:51 write the 1.20 forms)
                    { name: 'ActivityPhase.GetDescription', args: 'none', call: 'ActivityPhase.GetDescription( Activity.Self )' },
                    { name: 'DecisionViewWidgetCreateHolyOrder.HasValidBaronies', rename: 'DecisionViewWidgetSelectBarony.HasValidTitles' }
                ],
                // (what only the faith creation window showed: no text of the game's replaces it. A key of the game's goes (its text
                // shows), else it stays and the result tells it)
                gone: ['FaithCreationDoctrineItem', 'FaithCreationWindow']
            },
            // (the doctrines of 1.19's API: GetFaithDoctrine( 'x' ), FaithDoctrine, FAITH_DOCTRINE. 1.20 splits them: a tenet is
            // GetTenetType( 'x' ) (97 of the 99 names the game passes are tenet_types keys), a doctrine GetDoctrineType( 'x' ) (all
            // 94 are doctrine_types keys); the type is DoctrineType, the loc scope DOCTRINE_TYPE; a tenet's GetName and
            // DoctrineType.GetEffectsDescription take a rite (299 × GetPlayer.GetRite in the game). The two keys the game
            // restructured: FAITH_DOCTRINE_GENERAL_TOOLTIP is split in two (religion_l_english.yml:113-114, cooltip.gui reads
            // both), CHARACTERS_OF_CULTURE_DOCTRINE_MODIFIER uses the type form (culture_window_l_english.yml:123): the game's text)
            {
                files: ['gui/**/*.gui', 'localization/**/*.yml'],
                label: tr('Doctrines of the old API: GetFaithDoctrine( … ) is GetTenetType or GetDoctrineType, FaithDoctrine is DoctrineType, FAITH_DOCTRINE is DOCTRINE_TYPE (what takes a rite gets one)'),
                rules: [
                    { name: 'GetFaithDoctrine', special: 'faithDoctrine' },
                    { name: 'FaithDoctrine', special: 'faithDoctrine' },
                    { name: 'FAITH_DOCTRINE', in: 'loc', special: 'faithDoctrine' }
                ],
                keepGame: ['FAITH_DOCTRINE_GENERAL_TOOLTIP', 'CHARACTERS_OF_CULTURE_DOCTRINE_MODIFIER']
            },
            // (texts the game's program fills itself (the key a string of ck3.exe, named by no loaded script or interface file)
            // get the data contexts it gives them: 1.20 gives the hostile-faith opinion lines a Rite, modifiers_l_*.yml writes
            // [Rite.GetName] in all three languages where 1.19's text, in two mods' copies, wrote [FAITH.GetName]; game test 5:
            // "Data error in loc string 'OPINION_HOSTILE_FAITH'", 382 lines from one opinion tooltip. A mod's copy of such a text
            // naming one context the game's text no longer does, where the game's names one the mod's does not, gets the game's;
            // its wording stays. Where no rename is safe, the game's text of the key (the owner's choice). Last: it reads the texts
            // as the groups above leave them)
            {
                files: ['localization/**/*.yml'],
                label: tr('Texts the game fills itself: a data context 1.20 renamed (the hostile-faith opinion lines name the rite, FAITH is Rite) — renamed in the mod’s wording, else the game’s text of the key'),
                rules: [],
                contexts: true
            }
        ],
        texts: [
            // (a mod's 1.19 copies of the game's gui/specialinteractions_l_english.yml and modifiers/modifiers_l_english.yml lack 144 and 74
            // keys 1.20 added that no other file defines: "Unlocalized text 'GRANT_AS_GOVERNMENT_TYPE'", TITLE_SELECTOR_TEXT, "Expected
            // modifier localization key 'MOD_PIETY_STANDALONE_GAIN_MULT'", raw keys in the grant-titles window, the title selector and
            // modifier lines. Only the keys something loaded uses: the same mod's copy of load_tips_l_english.yml keeps its own 25 tips of
            // the game's 151 (the program shows LOADING_TIP_%d), its credits file is empty next to a credits.txt of its own)
            { files: ['localization/**/*.yml'], label: tr('Texts 1.20 added to localization files the mod replaces with older copies, that loaded files use (the game’s texts, in a file of the patch mod)') }
        ],
        merge: [
            // (1.20 added game concepts and aliases (heresy's `heretical`, `secular_ruler`, `church_authority` …); a
            // mod's 1.19 copy of the concept files lacks them: texts using them fail, the faith window's headings)
            { files: ['common/game_concepts/*.txt'], lists: ['alias'], label: tr('Game concepts: the ones 1.20 added (and new aliases) next to the mod’s older copy') },
            // (and the scripted rules: a mod's 00_rules.txt lacks can_edit_rite, rite_conversion, can_change_faith,
            // can_create_title … ("No script rule defined for 'can_edit_rite'", the rule then always true). The renamed
            // faith_creation counts as can_create_rite: the mod's body stays)
            { files: ['common/scripted_rules/*.txt'], lists: [], label: tr('Scripted rules: the ones 1.20 added (rite editing and conversion, title rules …) next to the mod’s older copy') }
        ],
        // (a mod's copy of 00_religious_triggers.txt hides the *_in_rite_trigger the game's own files call, a copy of
        // 00_religion_effects.txt the rite effects …: "Unknown trigger" and the scripts that use them misbehave. Only
        // folders of definitions that do nothing until they are named; the registries the engine asks for by itself
        // (scripted_rules, on_action) have no reference to find: the scripted rules are merged above. The names that
        // are common words need the key they stand under (an event theme `christian`, a decision group `religious`))
        libraries: {
            label: tr('Definitions 1.20 added to files the mod replaces, that loaded files still use'),
            folders: [
                { folder: 'common/scripted_triggers', label: tr('Scripted triggers') },
                { folder: 'common/scripted_effects', label: tr('Scripted effects') },
                { folder: 'common/script_values', label: tr('Script values'), use: 'both' },
                { folder: 'common/scripted_modifiers', label: tr('Scripted modifiers') },
                { folder: 'common/customizable_localization', label: tr('Customizable localization'), use: 'both', keys: ['parent'] },
                { folder: 'common/scripted_guis', label: tr('Scripted GUIs'), use: 'loc' },
                { folder: 'common/event_themes', label: tr('Event themes'), keys: ['theme', 'override_theme'] },
                { folder: 'common/event_backgrounds', label: tr('Event backgrounds'), keys: ['reference', 'background', 'event_background', 'override_background'] },
                { folder: 'common/scripted_animations', label: tr('Scripted animations'), keys: ['scripted_animation'] },
                { folder: 'common/domiciles/types', label: tr('Domicile types'), keys: ['is_domicile_type', 'domicile_type', 'allowed_domicile_types'] },
                { folder: 'common/decision_group_types', label: tr('Decision groups'), keys: ['decision_group_type'] },
                { folder: 'common/modifiers', label: tr('Static modifiers'), keys: ['modifier', '*_modifier'] },
                // (the opinion modifiers 1.20 added to the game's files: holy orders, church claims, dioceses, cardinals. A mod's older
                // copies of 00_opinion_modifiers.txt, 00_religious_opinions.txt … hide them, while the game's own interactions and
                // decisions still give them: "Unknown opinion modifier". Named under `modifier =` of add_opinion, reverse_add_opinion,
                // has_opinion_modifier and remove_opinion (the key static modifiers have too: the candidates of the two folders
                // tell them apart), a trait's `triggered_opinion = { opinion_modifier = x }`, and the macro arguments the game's
                // scripted effects pass on as `modifier = $X$`)
                { folder: 'common/opinion_modifiers', label: tr('Opinion modifiers'), keys: ['modifier', 'opinion_modifier', 'OPINION_TYPE', 'OPINION_MODIFIER', 'MODIFIER'] },
                { folder: 'gfx/portraits/portrait_animations', label: tr('Portrait animations'), keys: ['animation', 'head', 'torso'] },
                { folder: 'gfx/map/map_modes', label: tr('Map modes'), keys: ['controller', 'map_mode'], use: 'both' },
                // (the tooltip texts of triggers and effects, under the name of the trigger/effect: the carried scripted triggers
                // and the game's own files call the new ones; without an entry the tooltip shows the name)
                { folder: 'common/trigger_localization', label: tr('Trigger localization') },
                { folder: 'common/effect_localization', label: tr('Effect localization') },
                // (the invite rules of an activity type, `1 = activity_invite_cardinals`; the secret types of `any_secret = { type = x }`;
                // the categories an interaction names with `category = x`: a cheat or UI mod copies the game's category file)
                { folder: 'common/activities/guest_invite_rules', label: tr('Guest invite rules') },
                { folder: 'common/secret_types', label: tr('Secret types') },
                { folder: 'common/character_interaction_categories', label: tr('Interaction categories'), keys: ['category'] },
                // (the formats of the modifiers the engine registers: it logs "Modifier formatting definition for x is missing" for
                // each one a mod's older copy of the files lacks, whether a file names it or not. The ones about content the
                // loaded files lack (a culture's `kru_opinion`, a region's, a religion's, a scheme's) have nothing to format)
                {
                    folder: 'common/modifier_definition_formats', label: tr('Modifier formats'), engine: {
                        content: ['common/culture/cultures', 'common/religion/religion_types', 'common/religion/faith_types', 'common/religion/religion_family_types', 'map_data/geographical_regions',
                            'common/terrain_types', 'common/schemes/scheme_types', 'common/governments', 'common/holdings', 'common/lifestyles', 'common/traits']
                    }
                }
            ],
            // (the flag words the game's entries of the same name gained (`government_is_in_steppe`, `authority_level_1` …):
            // "Unknown government flag", and what tests them never holds. Only a word that a loaded file tests and no
            // loaded entry defines, added to the mod's own entry; an entry the mod lacks is told in the notes)
            flags: [
                { folder: 'common/governments', label: tr('Government flags'), queries: ['government_has_flag', 'government_type_has_flag', 'required_government_flag'] },
                { folder: 'common/laws', label: tr('Law flags'), queries: ['has_realm_law_flag', 'has_title_law_flag'] },
                { folder: 'common/legitimacy', label: tr('Legitimacy flags'), queries: ['has_legitimacy_flag'] },
                { folder: 'common/traits', label: tr('Trait flags'), queries: ['has_trait_with_flag', 'has_trait_flag'] },
                { folder: 'common/buildings', label: tr('Building flags'), queries: ['has_building_with_flag', 'has_construction_with_flag'], blocks: ['has_building_with_flag'] },
                { folder: 'common/subject_contracts/contracts', label: tr('Subject contract flags'), queries: ['vassal_contract_has_flag', 'subject_contract_has_flag'] },
                // (a doctrine's `parameters = { … }`, tested by `has_doctrine_parameter`: 1.20.1 added clerical_appointment_*_can_replace_ecc)
                { folder: 'common/religion/doctrine_types', label: tr('Doctrine parameters'), queries: ['has_doctrine_parameter'], list: 'parameters' }
            ]
        }
    }
];

/** "1.19.0.6" / "1.19.*" → [1, 19] */
function majorMinor(v: string | undefined): [number, number] | undefined
{
    const m = /^v?(\d+)\.(\d+)/i.exec(v?.trim() ?? '');
    return m ? [Number(m[1]), Number(m[2])] : undefined;
}

const before = (a: [number, number], b: [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * A supported version that names no game version: a wildcard where the major or minor number should be (`1.*.*`, `*.*.*`, `*`).
 * The author did not say which game the mod is for, and the game loads it all the same.
 */
export function versionUnknown(supported: string | undefined): boolean
{
    const v = supported?.trim().replace(/^v/i, '');
    return !!v && /^(\*|\d+\.\*)/.test(v) && !majorMinor(v);
}

/** Where a mod's migrations start: its supported version's major.minor; an unknown one (`versionUnknown`) starts at the first step. */
function startOf(supported: string | undefined): [number, number] | undefined
{
    if (!versionUnknown(supported))
        return majorMinor(supported);

    const major = /^v?(\d+)\./i.exec(supported!.trim());
    return [major ? Number(major[1]) : 0, 0];
}

/** The migrations from a mod's supported version up to the game's (a version that says nothing: all of them). */
export function migrationsBetween(supported: string | undefined, game: string | undefined): Migration[]
{
    const from = startOf(supported);
    const to = majorMinor(game);

    if (!from || !to)
        return [];

    return MIGRATIONS.filter((m) =>
    {
        const a = majorMinor(m.from)!;
        const b = majorMinor(m.to)!;
        // (the mod is at or before the step's start, the game at or after its end)
        return !before(a, from) && !before(to, b);
    });
}

/** The `replace_path`s a fixes patch mod needs for a mod hiding these folders (none it has already). */
export function newReplacePaths(steps: Migration[], replaced: string[]): string[]
{
    const has = new Set(replaced.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()));
    const out = steps.flatMap((m) => Object.entries(m.newFolders).filter(([old]) => has.has(old.toLowerCase())).flatMap(([, now]) => now));
    return [...new Set(out)].filter((p) => !has.has(p.toLowerCase()));
}

/**
 * The new folders a patch mod would hide, told apart by the mod's own files: a mod that ships a file directly in one of them
 * wrote that part of the new layout itself, and the patch mod loads after it: its `replace_path` would hide those files.
 * `kept`: the folders left out for that. `inline`: folders the mod is not laid out for (`oldForms`): hidden all the same;
 * `shadowed`: of those, the ones with files of the mod's own.
 */
export function foldersWithoutOwnFiles(folders: string[], modFiles: Iterable<string>, inline: string[] = []): { hide: string[]; kept: string[]; shadowed: string[]; }
{
    const parents = new Set<string>();

    for (const rel of modFiles)
        parents.add(rel.replace(/\\/g, '/').toLowerCase().replace(/\/?[^/]*$/, ''));

    const forced = new Set(inline.map((p) => p.toLowerCase()));
    const kept = folders.filter((p) => parents.has(p.toLowerCase()) && !forced.has(p.toLowerCase()));
    return { hide: folders.filter((p) => !kept.includes(p)), kept, shadowed: folders.filter((p) => parents.has(p.toLowerCase()) && forced.has(p.toLowerCase())) };
}

/**
 * Which of the names the loaded index has (renameRule.ts asks of the values it would rename): `defined` when an entry of a script type
 * has a live definition by the name, `known` when anything else has it (a flag, a variable, a localization key, an entry a mod
 * removed, an image or model path); a name the index has never heard of is left out.
 */
export function knownNames(idx: GameIndex, names: string[]): Record<string, 'defined' | 'known'>
{
    const out: Record<string, 'defined' | 'known'> = {};

    for (const name of names)
    {
        const es = idx.named(name);

        if (es.some((e) => !e.dead && e.defs.length > 0 && e.type !== T_IMAGE && e.type !== T_MODEL && !idx.isRemoved(e)))
            out[name] = 'defined';
        else if (es.length || idx.get(T_LOC, name) || idx.get(T_FLAG, name) || idx.get(T_VARIABLE, name) || idx.locRaw(name) !== undefined)
            out[name] = 'known';
    }

    return out;
}

/**
 * Of the `prefix:name` references a fix or a rule makes (addKeys.ts `namedRefs`: `religion:x`, `faith:x`, `title:x` …,
 * `family:rf_x`, `trigger:x`; `category:x` a doctrine category, `loc:KEY` a localization key), the ones the loaded index has no
 * entry for: the mods hide or replace the game's religions, titles and cultures; what a statement names there is a scope error.
 */
export function absentNames(idx: GameIndex, refs: string[]): string[]
{
    const own: Record<string, string[]> = { family: ['religion/religion_family_types'], trigger: ['scripted_triggers'], category: ['religion/doctrine_category_types'] };

    return refs.filter((r) =>
    {
        const at = r.indexOf(':');
        const prefix = r.slice(0, at);
        const name = r.slice(at + 1);

        if (prefix === 'loc')
            return idx.locRaw(name) === undefined;

        // (an entry a mod hid (replace_path, a file of the same name) is in the index with all its definitions hidden: not there)
        const types = own[prefix] ?? PREFIX_TYPES[prefix];
        return !!types && !types.some((x) =>
        {
            const e = idx.get(x, name);
            return !!e && !idx.isRemoved(e);
        });
    });
}

/** Whether an entry's card still marks it written the old way (a fix done on its religion may have done it already). */
export function stillOld(idx: GameIndex, stories: StoryBuilder, type: string, name: string): boolean
{
    const e = idx.get(type, name);
    const sections = new Set(MIGRATIONS.map((m) => m.section));
    return !!e && stories.card(e).sections.some((s) => sections.has(s.title));
}

/**
 * What of a mod (a loaded source, by ModInfo id) needs these migrations: its entries whose winning definition is the
 * mod's and whose card marks them written the old way, with the fix the card offers.
 */
export function migrationPlan(idx: GameIndex, stories: StoryBuilder, modId: string, supported: string | undefined, game: string | undefined, patchId?: string): MigrationPlan
{
    const steps = migrationsBetween(supported, game);
    const source = idx.vfs.sources.findIndex((s) => s.modId?.toLowerCase() === modId.toLowerCase());
    // (a second run: what the patch mod has of the mod's entries (copied there by the first) counts as the mod's)
    const patch = patchId ? idx.vfs.sources.findIndex((s) => s.modId?.toLowerCase() === patchId.toLowerCase()) : -1;
    const findings: MigrationFinding[] = [];

    if (source < 1)
        return { modId, supported, game, steps: [], findings, problem: tr('The mod is not in the loaded mod list: load a list with it first') };

    const seen = new Set<string>();

    for (const m of steps)
    {
        for (const type of m.types)
        {
            for (const name of idx.names(type))
            {
                const e = idx.get(type, name);
                const d = e && idx.winningDef(e);

                if (!e || !d || (idx.files[d.file].source !== source && idx.files[d.file].source !== patch))
                    continue;

                const card = stories.card(e);
                const sec = card.sections.find((s) => s.title === m.section);

                if (!sec)
                    continue;

                const act = sec.lines.find((l) => l.act?.do.kind === 'modernize')?.act?.do as { kind: 'modernize'; type: string; name: string; fix: string; } | undefined;
                const key = act ? `${act.fix}|${act.type}|${act.name}` : `-|${type}|${name}`;

                if (seen.has(key))
                    continue;

                seen.add(key);
                // (named by what the fix rewrites: a law's mark fixes its group)
                const target = act ? idx.get(act.type, act.name) : undefined;
                findings.push({
                    step: `${m.from}→${m.to}`,
                    type,
                    typeLabel: typeLabel(type),
                    name,
                    display: (target && idx.displayName(target)) ?? act?.name ?? idx.displayName(e) ?? name,
                    rel: idx.files[d.file].rel,
                    what: sec.lines.map((l) => (typeof l.text === 'string' ? l.text : l.text.map((t) => (typeof t === 'string' ? t : t.text)).join(''))),
                    ...(act ? { fix: { type: act.type, name: act.name, fix: act.fix } } : {})
                });
            }
        }

        // (the order fixes run in: tenets before the faiths naming them, groups before their members)
        const rank = (f: MigrationFinding): number => (f.fix ? m.order.indexOf(f.fix.fix) : m.order.length);
        findings.sort((a, b) => rank(a) - rank(b));
    }

    const replacePaths = newReplacePaths(steps, idx.vfs.sources[source].replacePaths ?? []);
    // (what such a replace_path would hide besides the game's: the files of the mods before this one, as they load now)
    const replacePathHides = replacePaths.flatMap((folder) => [...idx.vfs.earlierFiles(source, folder)].map(([i, files]) => ({ folder, mod: idx.vfs.sources[i].name, files: files.length })));
    return { modId, supported, game, steps: steps.map((m) => ({ from: m.from, to: m.to, label: m.label, changes: m.changes })), findings, replacePaths, replacePathHides, ...(versionUnknown(supported) ? { versionUnknown: true } : {}) };
}
