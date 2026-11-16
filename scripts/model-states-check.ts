// The model states rule of "Fix for 1.20…" (modelStates.ts; migrate.ts `fileRules`, `modelStatesWork`) on small texts and a small
// game folder in TEMP, no index, no real game: a mod's copy of a game portrait model gets the game's animation states its entity lacks
// that a portrait animation names (the game's files, hidden or not, the mod's, the patch mod's) or that an added state goes on to, and
// the game's animations its mesh or set lacks that a state of the models plays (the game's model files the mod does not copy count),
// when the clip is a file; a state only the game's newer version of a state reaches is not added, a state whose animation no model has
// and an animation without a clip are left out and told; the mod's own entries stay; entries go after the block's last of their kind
// (indentation, CRLF, a block closing on that line); a second pass adds nothing. The second entry, the modifier packs: the named packs a
// copy of the pack file lacks, at its end. The third, the props: the portrait modifiers the animations and packs name (into a group
// applied only where named), the gene templates those name (the game's index or the smallest free one), the accessories those name; the
// entities told.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/model-states-check.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { addModelEntries, addsSummary, modelWork, namedModifiers, namedPacks, namedStates, packWork, propsWork, readModel, type ModelCopy, type PropsInput } from '../src/main/mods/modelStates.ts';
import { fileRules, modelStatesWork } from '../src/main/mods/migrate.ts';
import { MIGRATIONS, type Migration } from '../src/main/mods/migrations.ts';

let bad = 0;
let count = 0;
const check = (ok: unknown, what: string, detail?: string): void =>
{
    count++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);

    if (!ok)
        bad++;
};

const rule = MIGRATIONS[0].modelStates?.[0];
check(!!rule && rule.files.includes('gfx/models/portraits/**/*.asset') && rule.animations === 'gfx/portraits/portrait_animations', 'the 1.20 migration has the rule for the portrait models');

// (a head model as the game writes it: an animation set, a mesh importing it, an entity with states; the 1.20 entries at the end)
const anim = (id: string): string => `\tanimation = { id = "${id}"\t\ttype = "male_head_${id}.anim" }`;
const state = (name: string, plays: string, next = name): string => `\tstate = {\tname = "${name}"\t\tanimation = "${plays}" looping = no next_state = "${next}" }`;
const gameHead = [
    'skeletal_animation_set = {',
    '\tname = "common_head"',
    anim('head_idle'),
    anim('head_pray'),
    anim('head_pray_loop'),
    anim('head_gesture'),
    anim('head_unused'),
    anim('head_noclip'),
    '}',
    '',
    'pdxmesh = {',
    '\tname = "male_head_mesh"',
    '\tfile = "male_head.mesh"',
    '\timport = { type = skeletal_animation_set name = "common_head" }',
    '}',
    '',
    'entity = {',
    '\tname = "head_entity_male"',
    '\tpdxmesh = "male_head_mesh"',
    '\tdefault_state = "idle"',
    state('idle', 'head_idle'),
    state('cynical', 'head_idle', 'cynical_1'),
    state('cynical_1', 'head_idle'),
    state('pray', 'head_pray', 'pray_loop'),
    state('pray_loop', 'head_pray_loop'),
    state('pray_loop', 'head_pray_loop', 'pray'),
    state('gesture', 'head_gesture'),
    state('noclip', 'head_noclip'),
    state('unnamed', 'head_unused'),
    '}',
    ''
].join('\n');
// (the mod's 1.19 copy: the set and the entity without the new entries, a state of its own and its own text of `cynical`)
const modHead = [
    'skeletal_animation_set = {',
    '\tname = "common_head"',
    anim('head_idle'),
    '\tanimation = { id = "head_own" type = "male_head_own.anim" }',
    '}',
    '',
    'pdxmesh = {',
    '\tname = "male_head_mesh"',
    '\tfile = "male_head.mesh"',
    '\timport = { type = skeletal_animation_set name = "common_head" }',
    '}',
    '',
    'entity = {',
    '\tname = "head_entity_male"',
    '\tpdxmesh = "male_head_mesh"',
    '\tdefault_state = "idle"',
    state('idle', 'head_idle'),
    state('cynical', 'head_idle'),
    '\tstate = { name = "own_pose" animation = "head_own" }',
    '}',
    ''
].join('\n');
const named = namedStates('a = {\n\tdefault = { head = "idle" torso = "idle" }\n\tv = { animation = { head = "pray" torso = "pray" } }\n\tw = { animation = { head = "gesture" torso = "gesture" } }\n\t# head = "unnamed"\n\tx = { animation = { head = "noclip" } }\n\ty = { animation = { head = "cynical" } }\n}\n');
check([...named].sort().join() === 'cynical,gesture,idle,noclip,pray', 'the states the portrait animations name: head and torso values anywhere, not in a comment', [...named].join());

const m = readModel(gameHead);
check(
    [...m.keys()].join() === 'skeletal_animation_set|common_head,pdxmesh|male_head_mesh,entity|head_entity_male' && m.get('skeletal_animation_set|common_head')!.animations.length === 6 && m.get('entity|head_entity_male')!.states.length === 9 && m.get('entity|head_entity_male')!.states[3].next === 'pray_loop' &&
        m.get('skeletal_animation_set|common_head')!.animations[1].clip === 'male_head_head_pray.anim',
    'a model file: its blocks by key and name, their animations (id, clip) and states (name, animation, next state)'
);

const clips = new Set([
    'gfx/models/portraits/male_head/male_head_head_idle.anim',
    'gfx/models/portraits/male_head/male_head_head_pray.anim',
    'gfx/models/portraits/male_head/male_head_head_pray_loop.anim',
    'gfx/models/portraits/male_head/male_head_head_gesture.anim',
    'gfx/models/portraits/male_head/male_head_head_unused.anim'
]);
const rel = 'gfx/models/portraits/male_head/male_head.asset';
const w = modelWork([{ rel, game: gameHead, copy: modHead }], [], named, (r) => clips.has(r));
const adds = w.adds.get(rel);
const sum = adds ? addsSummary(adds) : { states: [], animations: [] };
check(sum.states.join() === 'pray,pray_loop,gesture', 'states: the named ones the copy lacks and the state an added one goes on to (pray_loop); not one named by nothing (unnamed), not one only the game’s newer `cynical` reaches (cynical_1)', sum.states.join());
check(sum.animations.join() === 'head_pray,head_pray_loop,head_gesture', 'animations: the ones the states play that the copy’s set lacks; not one no state plays (head_unused)', sum.animations.join());
check(adds?.states.get('entity|head_entity_male')?.filter((s) => s.id === 'pray_loop').length === 2, 'a state the game writes twice (two variants) comes with both entries');
check(w.noClip.join() === `${rel}: head_noclip (male_head_head_noclip.anim)` && w.unplayable.join() === `${rel}: noclip (head_noclip)`, 'an animation whose clip is no file is left out, and so is the state that plays it (no model has its animation): both told', `${w.noClip.join()} | ${w.unplayable.join()}`);

const out = addModelEntries(modHead, adds);
check(out.includes('\tanimation = { id = "head_own" type = "male_head_own.anim" }\n' + anim('head_pray') + '\n' + anim('head_pray_loop') + '\n' + anim('head_gesture') + '\n}'), 'the animations go after the set’s last animation, as the game writes them, with that line’s indentation', out);
check(out.includes('\tstate = { name = "own_pose" animation = "head_own" }\n' + state('pray', 'head_pray', 'pray_loop') + '\n'), 'the states go after the entity’s last state', out);
check(
    out.includes(state('cynical', 'head_idle')) && !out.includes('cynical_1') && out.includes('own_pose') && out.includes('head_own') && out.split('\n').filter((l) => l.includes('"idle"')).length === modHead.split('\n').filter((l) => l.includes('"idle"')).length,
    'the mod’s own entries stay as the mod wrote them (its cynical, its own pose and animation)'
);
check(addModelEntries(out, adds) === out && !modelWork([{ rel, game: gameHead, copy: out }], [], named, (r) => clips.has(r)).adds.size, 'a second pass adds nothing');
check(
    out.startsWith(modHead.slice(0, modHead.indexOf(anim('head_idle')))) && out.length - modHead.length === adds!.animations
                .get('skeletal_animation_set|common_head')!
                .concat(adds!.states.get('entity|head_entity_male')!)
                .reduce((n, e) => n + e.text.length + 2, 0),
    'nothing but the entries and their line breaks and indentation is written'
);

const crlf = modHead.replace(/\n/g, '\r\n');
const outCrlf = addModelEntries(crlf, adds);
check(outCrlf === out.replace(/\n/g, '\r\n'), 'a CRLF copy keeps its line ends');
const oneLine = 'entity = { name = "head_entity_male" state = { name = "idle" animation = "head_idle" } }\n';
const outOne = addModelEntries(oneLine, { animations: new Map(), states: new Map([['entity|head_entity_male', [{ id: 'pray', text: 'state = { name = "pray" animation = "head_pray" }' }]]]) });
check(outOne === 'entity = { name = "head_entity_male" state = { name = "idle" animation = "head_idle" }\n\tstate = { name = "pray" animation = "head_pray" }\n}\n', 'a block closing on the line of its last entry: the entry before the brace, on a line of its own', JSON.stringify(outOne));

// (two files: the female head's entity plays the male head's set; the male head copied or not)
const femaleGame = 'pdxmesh = {\n\tname = "female_head_mesh"\n\timport = { type = skeletal_animation_set name = "common_head" }\n}\nentity = {\n\tname = "head_entity_female"\n' + state('idle', 'head_idle') + '\n' + state('pray', 'head_pray', 'pray_loop') + '\n' + state('pray_loop', 'head_pray_loop') + '\n}\n';
const femaleCopy = 'pdxmesh = {\n\tname = "female_head_mesh"\n\timport = { type = skeletal_animation_set name = "common_head" }\n}\nentity = {\n\tname = "head_entity_female"\n' + state('idle', 'head_idle') + '\n}\n';
const femaleRel = 'gfx/models/portraits/female_head/female_head.asset';
const onlyFemale = modelWork([{ rel: femaleRel, game: femaleGame, copy: femaleCopy }], [gameHead], new Set(['pray']), (r) => clips.has(r));
check(addsSummary(onlyFemale.adds.get(femaleRel)!).states.join() === 'pray,pray_loop' && !onlyFemale.unplayable.length, 'the female head copied alone: its states play the game’s male set (not copied: it loads as the game wrote it)');
const both = modelWork([{ rel, game: gameHead, copy: modHead }, { rel: femaleRel, game: femaleGame, copy: femaleCopy }], [], new Set(['pray']), (r) => clips.has(r));
check(addsSummary(both.adds.get(rel)!).animations.join() === 'head_pray,head_pray_loop' && addsSummary(both.adds.get(femaleRel)!).states.join() === 'pray,pray_loop', 'both copied: the male set gets the animations the female states play too');
const onlyMale = modelWork([{ rel, game: gameHead, copy: modHead }], [femaleGame], new Set<string>(), (r) => clips.has(r));
check(addsSummary(onlyMale.adds.get(rel)!).animations.join() === 'head_pray,head_pray_loop' && !addsSummary(onlyMale.adds.get(rel)!).states.length, 'the male head copied alone, nothing names its states: its set still gets what the game’s female head plays');
const renamedSet = modelWork([{ rel, game: gameHead, copy: modHead.replace('"common_head"', '"mod_head"') }], [], new Set(['pray']), (r) => clips.has(r));
check(!renamedSet.adds.get(rel)?.states.size && renamedSet.unplayable.length === 2, 'a copy whose set has another name: no animation can come, so no state that would play it either (told)', renamedSet.unplayable.join());

// the portrait modifier packs (the rule's second entry, `packs`): a mod's copy of the game's pack file gets the game's packs a portrait
// animation names that no loaded pack file defines, at its end; the mod's own packs stay (the props the packs name: the third entry)
{
    const packRule = MIGRATIONS[0].modelStates?.find((r) => r.packs);
    check(!!packRule && packRule.files.some((p) => p.endsWith('*.modifierpack')) && packRule.animations === 'gfx/portraits/portrait_animations' && packRule.packs === true, 'the 1.20 migration has the rule for the modifier packs');
    const pack = (name: string, prop: string): string => `${name} = {\r\n\tportrait_modifier = {\r\n\t\tanimations_props = ${prop}\r\n\t}\r\n}`;
    const gamePacks = ['### Weapons ###', '', pack('axe', 'axe_prop'), '', pack('crozier', 'crozier_prop'), '', pack('book', 'book_prop'), '', pack('unnamed', 'x_prop'), '', pack('elsewhere', 'y_prop'), ''].join('\r\n');
    const copyPacks = ['### Weapons ###', '', 'axe = {\r\n\tportrait_modifier = { animations_props = mod_axe_prop }\r\n}', '', pack('mod_own', 'mod_prop'), ''].join('\r\n');
    const named = new Set(['axe', 'crozier', 'book', 'elsewhere']);
    const prel = 'gfx/portraits/portrait_animations/animations.modifierpack';
    const w = packWork([{ rel: prel, game: gamePacks, copy: copyPacks }], [pack('elsewhere', 'y_prop')], named);
    check(w.get(prel)?.map((e) => e.id).join() === 'crozier,book', 'the named packs the copy and the other pack files lack; not one nothing names, not the copy\'s own version, not one another file defines', w.get(prel)?.map((e) => e.id).join());
    const out = addModelEntries(copyPacks, { animations: new Map(), states: new Map(), top: w.get(prel) });
    check(out === copyPacks.replace(/\r\n$/, '') + '\r\n\r\n' + pack('crozier', 'crozier_prop') + '\r\n\r\n' + pack('book', 'book_prop') + '\r\n', 'the packs go at the end, a blank line before each, the file\'s line ends; the copy\'s own text stays', JSON.stringify(out.slice(copyPacks.length - 4)));
    check(!packWork([{ rel: prel, game: gamePacks, copy: out }], [pack('elsewhere', 'y_prop')], named).get(prel), 'a second pass adds nothing');
    check(addModelEntries(out, { animations: new Map(), states: new Map(), top: w.get(prel) }) === out, 'packs the copy has by now are not added again');
    const lf = addModelEntries(copyPacks.replace(/\r\n/g, '\n'), { animations: new Map(), states: new Map(), top: w.get(prel) });
    check(!lf.includes('\r') && lf.includes('\n\ncrozier = {\n\tportrait_modifier = {'), 'a copy with LF line ends gets the packs with LF');
    check(namedPacks('a = { male = { default = { head = "idle" } portrait_modifier_pack = crozier portrait_modifier_set = { portrait_modifier_pack = "book" } } }\n').size === 2, 'the packs an animation names: plain and quoted, in a set too');
}

// the props (the rule's third entry, `props`): the portrait modifiers the animations and packs name that no loaded file defines, from the
// game's file into the copy's group (only a group applied where named), the gene templates those name into the copy's gene (the game's
// index, else the smallest free one), the accessories the templates name at the accessory copy's end; the entities they name told
const propsRule = MIGRATIONS[0].modelStates?.find((r) => r.props);
check(
    !!propsRule && propsRule.files.includes('gfx/portraits/portrait_modifiers/**/*.txt') && propsRule.files.includes('common/genes/**/*.txt') && propsRule.props?.genes === 'common/genes' && propsRule.props?.entities === 'gfx/models' &&
        MIGRATIONS[0].modelStates!.indexOf(propsRule) > MIGRATIONS[0].modelStates!.findIndex((r) => r.packs),
    'the 1.20 migration has the props entry, after the pack entry (the packs it brings name props)'
);
const MREL = 'gfx/portraits/portrait_modifiers/00_animation_props.txt';
const GREL = 'common/genes/07_genes_special_accessories_misc.txt';
const AREL = 'gfx/portraits/accessories/props.txt';
const prop = (name: string, gene: string, tpl: string, more = ''): string => `\t${name} = {\n\t\tdna_modifiers = {\n\t\t\taccessory = {\n\t\t\t\tmode = add\n\t\t\t\tgene = ${gene}\n\t\t\t\ttemplate = ${tpl}${more}\n\t\t\t\tvalue = 1.0\n\t\t\t}\n\t\t}\n\t}`;
const gameMods = [
    'animations_props = {',
    '\tusage = none',
    '',
    prop('old_prop', 'props_left', 'old_tpl'),
    '',
    prop('crozier_prop', 'props_left', 'crozier_tpl'),
    '',
    prop('book_prop', 'props_right', 'book_tpl'),
    '',
    prop('unnamed_prop', 'props_left', 'x_tpl'),
    '',
    prop('direct_prop', 'props_left', 'old_tpl', '\n\t\t\t\taccessory = direct_acc'),
    '',
    prop('walk_prop', 'props_left', 'walk_tpl'),
    '}',
    '',
    'game_looks = {',
    '\tlook_a = { dna_modifiers = { } }',
    '}',
    '',
    'missing_group = {',
    '\tusage = none',
    '\tm = { dna_modifiers = { } }',
    '}',
    ''
].join('\n');
const copyMods = ['animations_props = {', '\tusage = none', '', prop('old_prop', 'props_left', 'mod_tpl'), '}', '', 'game_looks = {', '\tmod_look = { dna_modifiers = { } }', '}', ''].join('\r\n').replace(/\r?\n/g, '\r\n');
const tpl = (name: string, index: number, body: string, ind = '\t'): string => `${ind}${name} = {\n${ind}\tindex = ${index}\n${ind}\tmale = {\n${body.split('\n').map((l) => `${ind}\t\t${l}`).join('\n')}\n${ind}\t}\n${ind}\tfemale = male\n${ind}}`;
const gameGenes = [
    'special_genes = {',
    '',
    'accessory_genes = {',
    '',
    'props_left = {',
    tpl('no_props', 0, ''),
    tpl('old_tpl', 1, '1 = old_acc'),
    tpl('crozier_tpl', 2, '1 = crozier_acc\n1 = crozier_acc_2'),
    tpl('walk_tpl', 3, '1 = walk_acc'),
    '}',
    '\tprops_right = {',
    tpl('no_props', 0, '', '\t\t'),
    tpl('book_tpl', 3, '2 = { book_acc book_acc_hood }\n1 = empty', '\t\t'),
    '\t}',
    '}',
    '}',
    ''
].join('\n');
// (the mod's 1.19 copy: its own template at the game's index 2, its props_right names one template twice (indices 1 and 3))
const copyGenes = ['special_genes = {', 'accessory_genes = {', '\tprops_left = {', tpl('no_props', 0, '', '\t\t'), tpl('old_tpl', 1, '1 = old_acc', '\t\t'), tpl('mod_tpl', 2, '1 = mod_acc', '\t\t'), '\t}', '\tprops_right = {', tpl('no_props', 0, '', '\t\t'), tpl('mod_r', 1, '1 = mod_acc', '\t\t'), tpl('mod_r', 3, '1 = mod_acc', '\t\t'), '\t}', '}', '}', ''].join('\n');
const acc = (name: string, entity: string, more = ''): string => `${name} = {\n\tentity = { required_tags = "" node = "bn_l_prop" ${more}entity = "${entity}" }\n}`;
const gameAcc = [acc('crozier_acc', 'crozier_entity'), '', acc('crozier_acc_2', 'crozier_2_entity', 'game_entity_override = weapon '), '', acc('book_acc', 'book_entity'), '', acc('book_acc_hood', 'missing_entity'), ''].join('\n');
const copyAcc = [acc('crozier_acc', 'crozier_entity'), '', acc('book_acc', 'book_entity'), '', acc('mod_acc', 'mod_entity'), ''].join('\n');
const propsNamed = namedModifiers('a = { male = { portrait_modifier = { trigger = { animations_props = no_trigger } animations_props = crozier_prop animations = "expr" } portrait_modifier_pack = p portrait_modifier_set = { portrait_modifier = { animations_props = book_prop } } } }\n');
check([...propsNamed].sort().join() === 'animations_props|book_prop,animations_props|crozier_prop,animations|expr', 'the portrait modifiers an animation names: group and name of a portrait_modifier\'s values (quoted too, in a set too), not in its trigger, not a pack', [...propsNamed].join());
const pin = (over: Partial<PropsInput> = {}): PropsInput => ({
    named: new Set(['animations_props|crozier_prop', 'animations_props|book_prop', 'animations_props|old_prop', 'animations_props|direct_prop', 'animations_props|walk_prop', 'animations_props|elsewhere_prop', 'game_looks|look_a', 'missing_group|m']),
    modifiers: { copies: [{ rel: MREL, game: gameMods, copy: copyMods }], others: ['animations_props = {\n\tusage = none\n\telsewhere_prop = { }\n}\n'] },
    genes: { copies: [{ rel: GREL, game: gameGenes, copy: copyGenes }], others: [{ rel: 'common/genes/mod_own.txt', text: 'special_genes = { accessory_genes = { mod_gene = { t = { index = 0 } } } }\n' }] },
    accessories: { copies: [{ rel: AREL, game: gameAcc, copy: copyAcc }], others: ['walk_acc = { entity = { entity = "walk_entity" } }\n'] },
    entity: (n) => ['crozier_entity', 'crozier_2_entity', 'book_entity', 'walk_entity', 'mod_entity'].includes(n),
    ...over
});
{
    const asked: string[] = [];
    const pw = propsWork(pin({ entity: (n) => (asked.push(n), pin().entity(n)) }));
    const ids = (rel: string, path?: string): string => (path ? pw.adds.get(rel)?.nested?.get(path) : pw.adds.get(rel)?.top)?.map((e) => e.id).join() ?? '';
    check(ids(MREL, 'animations_props') === 'crozier_prop,book_prop,direct_prop,walk_prop' && pw.adds.get(MREL)?.kind === 'modifiers', 'modifiers: the named ones the copy lacks, in the game\'s order, into its group; not the copy\'s own version (old_prop), not one another file defines, not one nothing names', ids(MREL, 'animations_props'));
    check(pw.told?.byItself.join() === 'game_looks look_a' && pw.told?.noGroup.join() === 'missing_group m', 'a modifier of a group the copy applies without a name (no usage = none) and one of a group the copy lacks: told, not brought', JSON.stringify(pw.told));
    check(ids(GREL, 'special_genes/accessory_genes/props_left') === 'crozier_tpl,walk_tpl' && ids(GREL, 'special_genes/accessory_genes/props_right') === 'book_tpl', 'templates: the ones the brought modifiers name that the copy\'s gene lacks, in the game\'s order; not one the copy has (old_tpl), not one of an unnamed modifier', `${ids(GREL, 'special_genes/accessory_genes/props_left')} | ${ids(GREL, 'special_genes/accessory_genes/props_right')}`);
    const crozierTpl = pw.adds.get(GREL)?.nested?.get('special_genes/accessory_genes/props_left')?.[0].text ?? '';
    const walkTpl = pw.adds.get(GREL)?.nested?.get('special_genes/accessory_genes/props_left')?.[1].text ?? '';
    const bookTpl = pw.adds.get(GREL)?.nested?.get('special_genes/accessory_genes/props_right')?.[0].text ?? '';
    check(walkTpl.includes('index = 3') && crozierTpl.includes('index = 4') && pw.told?.indices.join(' | ') === 'props_left crozier_tpl: 2 → 4 | props_right book_tpl: 3 → 2', 'indices: a free game index is kept (walk 3), a taken one (the mod\'s own at 2) gets the smallest none has after that (4, not a shift of the others); a name the copy writes twice holds both its indices (3 taken): told', `${pw.told?.indices.join(' | ')} | ${bookTpl.match(/index = \d+/)}`);
    check(ids(AREL) === 'crozier_acc_2,book_acc_hood' && pw.adds.get(AREL)?.kind === 'accessories', 'accessories: the templates\' ones no loaded file defines (in lists too, not `empty`), from the game\'s file of the copy; not one the copy or another file has', ids(AREL));
    check(pw.told?.accessories.join() === 'direct_acc' && pw.told?.entities.join() === 'missing_entity (book_acc_hood)' && !asked.includes('weapon'), 'an accessory a modifier names directly that no game file of a copy has, and an entity no loaded model file defines: told; `game_entity_override = weapon` names no entity', JSON.stringify([pw.told?.accessories, pw.told?.entities, asked]));
    const outMods = addModelEntries(copyMods, pw.adds.get(MREL));
    const outGenes = addModelEntries(copyGenes, pw.adds.get(GREL));
    const outAcc = addModelEntries(copyAcc, pw.adds.get(AREL));
    check(
        outMods.startsWith(copyMods.slice(0, copyMods.indexOf('}\r\n\r\ngame_looks'))) && outMods.includes('\t}\r\n\r\n\tcrozier_prop = {\r\n\t\tdna_modifiers = {') && !/[^\r]\n/.test(outMods) && outMods.includes('\tmod_look = { dna_modifiers = { } }') && outMods.includes('template = mod_tpl'),
        'the modifiers go after the group\'s last entry, a blank line before each as the copy has, CRLF kept; the mod\'s own entries stay',
        JSON.stringify(outMods.slice(0, 400))
    );
    check(
        outGenes.includes('\t\tmod_tpl = {') && outGenes.includes('\t\t}\n\t\tcrozier_tpl = {\n\t\t\tindex = 4\n\t\t\tmale = {\n\t\t\t\t1 = crozier_acc\n') && outGenes.includes('\t\twalk_tpl = {\n\t\t\tindex = 3') && outGenes.includes('\t\tbook_tpl = {\n\t\t\tindex = 2'),
        'the templates go after the gene\'s last template, moved to the copy\'s indentation (the game writes this gene one level less), no blank line where the copy has none',
        outGenes
    );
    check(outAcc.startsWith(copyAcc.replace(/\n$/, '')) && outAcc.endsWith('\n\n' + acc('crozier_acc_2', 'crozier_2_entity', 'game_entity_override = weapon ') + '\n\n' + acc('book_acc_hood', 'missing_entity') + '\n'), 'the accessories go at the copy\'s end, a blank line before each', JSON.stringify(outAcc.slice(copyAcc.length - 10)));
    const again = propsWork(pin({ modifiers: { copies: [{ rel: MREL, game: gameMods, copy: outMods }], others: pin().modifiers.others }, genes: { copies: [{ rel: GREL, game: gameGenes, copy: outGenes }], others: pin().genes.others }, accessories: { copies: [{ rel: AREL, game: gameAcc, copy: outAcc }], others: pin().accessories.others } }));
    check(!again.adds.size && addModelEntries(outGenes, pw.adds.get(GREL)) === outGenes && addModelEntries(outMods, pw.adds.get(MREL)) === outMods, 'a second pass adds nothing (the templates by their names, whatever index they got)');
    const ownGene = propsWork(pin({ genes: { copies: pin().genes.copies, others: [{ rel: 'common/genes/mod_props.txt', text: 'special_genes = { accessory_genes = { props_right = { mod_x = { index = 9 } } } }\n' }] } }));
    check(ownGene.told?.ownGene.join() === 'props_right book_tpl' && !ownGene.adds.get(GREL)?.nested?.has('special_genes/accessory_genes/props_right'), 'a gene a file of the mod\'s own defines too: its templates told, not brought (which definition loads is unclear)', JSON.stringify(ownGene.told));
    const noGene = propsWork(pin({ genes: { copies: [{ rel: GREL, game: gameGenes, copy: copyGenes.replace(/\tprops_right = \{[\s\S]*?\n\t\}\n/, '') }], others: [] } }));
    check(noGene.told?.noGene.join() === 'props_right book_tpl', 'a gene the copy lacks: its templates told', JSON.stringify(noGene.told));
    const empty = addModelEntries('special_genes = {\n\taccessory_genes = {\n\t\tprops_right = { }\n\t}\n}\n', { animations: new Map(), states: new Map(), nested: new Map([['special_genes/accessory_genes/props_right', [{ id: 'book_tpl', text: 'book_tpl = {\n\t\tindex = 2\n\t}', indent: '\t' }]]]) });
    check(empty === 'special_genes = {\n\taccessory_genes = {\n\t\tprops_right = { \n\t\t\tbook_tpl = {\n\t\t\t\tindex = 2\n\t\t\t}\n\t\t}\n\t}\n}\n', 'an empty block: the entry inside it, one level in, the brace on a line of its own', JSON.stringify(empty));
}

// (fileRules on a small game folder: the copy of a game model, the mod's own model, a copy that lacks nothing)
const dir = mkdtempSync(join(tmpdir(), 'ckp-modelstates-'));

try
{
    const gameDir = join(dir, 'install', 'game');
    const put = (root: string, r: string, text: string): string =>
    {
        const f = join(root, ...r.split('/'));
        mkdirSync(join(f, '..'), { recursive: true });
        writeFileSync(f, text);
        return f;
    };
    put(gameDir, rel, gameHead);
    put(gameDir, femaleRel, femaleGame);
    put(gameDir, 'gfx/models/portraits/hair/hair.asset', 'pdxmesh = { name = "hair_mesh" file = "hair.mesh" }\n');

    for (const c of clips)
        put(gameDir, c, 'anim');

    put(gameDir, 'gfx/portraits/portrait_animations/animations.txt', 'pray_anim = { male = { default = { head = "pray" torso = "pray" } } }\nnoclip_anim = { male = { default = { head = "noclip" } } }\n');
    const mod = join(dir, 'mod');
    const files = new Map<string, { file?: string; }>([
        [rel, { file: put(mod, rel, '﻿' + modHead) }],
        [femaleRel, { file: put(mod, femaleRel, femaleGame) }],
        ['gfx/models/portraits/own/own.asset', { file: put(mod, 'gfx/models/portraits/own/own.asset', 'entity = { name = "own_entity" state = { name = "x" animation = "y" } }\n') }],
        ['gfx/portraits/portrait_animations/own_animations.txt', { file: put(mod, 'gfx/portraits/portrait_animations/own_animations.txt', 'own = { male = { default = { head = "gesture" } } }\n') }]
    ]);
    const step: Migration = { from: '1.19', to: '1.20', label: '', changes: [], types: [], section: '', order: [], newFolders: {}, modelStates: MIGRATIONS[0].modelStates };
    const rules = fileRules({} as ModInfo, [step], gameDir, files);
    const r = rules.find((x) => x.kind === 'modelStates');
    check(r?.files.join() === rel, 'the plan: the copy of the game’s model with something to add; not a copy that lacks nothing, not the mod’s own model', r?.files.join());
    check(!!r?.notes?.some((n) => n.includes('head_noclip')) && !!r?.notes?.some((n) => n.includes('noclip (head_noclip)')), 'the plan tells the animation without a clip and the state left out with it', r?.notes?.join(' | '));
    check(!rules.some((x) => x.kind === 'modelStates' && x.files.includes('gfx/models/portraits/own/own.asset')), 'the mod’s own model file (no game file of its path) is not the rule’s');

    // (what names the states: the mod's own portrait animations, the patch mod's (a library file the libraries rule wrote))
    const without = (line: string): string => gameHead.replace(line + '\n', '');
    const lacking = (text: string, more: [string, string][] = []): Map<string, { file?: string; }> => new Map([[rel, { file: put(mod, rel, text) }], ...more.map(([r, t]): [string, { file?: string; }] => [r, { file: put(mod, r, t) }])]);
    const ownNamed = ['gfx/portraits/portrait_animations/own_animations.txt', 'own = { male = { default = { head = "gesture" } } }\n'] as [string, string];
    check(!fileRules({} as ModInfo, [step], gameDir, lacking(without(state('gesture', 'head_gesture')))).some((x) => x.kind === 'modelStates'), 'a copy lacking only a state nothing names: no rule');
    check(fileRules({} as ModInfo, [step], gameDir, lacking(without(state('gesture', 'head_gesture')), [ownNamed])).some((x) => x.kind === 'modelStates'), 'the same copy, a portrait animation of the mod names the state: the rule');
    const patchRoot = join(dir, 'patch');
    put(patchRoot, 'gfx/portraits/portrait_animations/zz_patch_library.txt', 'carried = { male = { default = { head = "unnamed" } } }\n');
    const onlyUnnamed = lacking(without(state('unnamed', 'head_unused')));
    check(
        !fileRules({} as ModInfo, [step], gameDir, onlyUnnamed).some((x) => x.kind === 'modelStates') && fileRules({} as ModInfo, [step], gameDir, onlyUnnamed, undefined, patchRoot).some((x) => x.kind === 'modelStates'),
        'a state only the patch mod’s portrait animations (the libraries rule’s file) name: the rule with the patch mod, none without'
    );
    // (the pack rule on the same folder: a copy of the game's pack file that lacks a pack the game's portrait animations name)
    const packRel = 'gfx/portraits/portrait_animations/animations.modifierpack';
    // (a game folder of its own: the game's files are read once per game folder and session)
    const packGame = join(dir, 'install2', 'game');
    put(packGame, packRel, 'crozier = {\n\tportrait_modifier = { animations_props = crozier_prop }\n}\n\nbook = {\n\tportrait_modifier = { animations_props = book_prop }\n}\n');
    put(packGame, 'gfx/portraits/portrait_animations/packs.txt', 'holding_crozier = { male = { default = { head = "idle" } portrait_modifier_pack = crozier } }\n');
    put(packGame, 'gfx/portraits/portrait_modifiers/00_animation_props.txt', 'animations_props = {\n\tcrozier_prop = { }\n}\n');
    const packFiles = new Map<string, { file?: string; }>([[packRel, { file: put(mod, packRel, 'book = {\n\tportrait_modifier = { animations_props = mod_book }\n}\n') }]]);
    const pr = fileRules({} as ModInfo, [step], packGame, packFiles).filter((x) => x.kind === 'modelStates');
    check(pr.length === 1 && pr[0].files.join() === packRel && !!pr[0].packs && !pr[0].notes?.length, 'the plan: the copy of the game\'s pack file that lacks a named pack, under the pack rule; its prop is loaded, nothing told', JSON.stringify(pr.map((x) => [x.files, x.notes])));
    packFiles.set('gfx/portraits/portrait_modifiers/00_animation_props.txt', { file: put(mod, 'gfx/portraits/portrait_modifiers/00_animation_props.txt', 'animations_props = {\n\tother_prop = { }\n}\n') });
    const pr2 = fileRules({} as ModInfo, [step], packGame, packFiles).filter((x) => x.kind === 'modelStates');
    check(pr2.length === 1 && !!pr2[0].packs, 'the mod\'s copy of the portrait modifiers lacks the pack\'s prop, in a group the game applies by itself (no usage = none): the props entry brings nothing', JSON.stringify(pr2.map((x) => [x.files, x.notes])));
    const named2 = new Map(packFiles);
    named2.set(packRel, { file: put(mod, packRel, 'book = { }\ncrozier = { }\n') });
    check(!fileRules({} as ModInfo, [step], packGame, named2).some((x) => x.kind === 'modelStates'), 'a copy that has the named pack (its own version): no rule');

    // (the props entry on a game folder of its own: a pack the pack entry brings names a prop; a game animation the mod defines itself
    // names nothing; the run applies the pack entry, then the props entry, each to the files as they are by then)
    const g3 = join(dir, 'install3', 'game');
    put(g3, packRel, 'crozier = {\n\tportrait_modifier = { animations_props = crozier_prop }\n}\n');
    put(g3, 'gfx/portraits/portrait_animations/animations.txt', 'holding_crozier = { male = { default = { head = "idle" } portrait_modifier_pack = crozier } }\nmod_redefined = { male = { portrait_modifier = { animations_props = unnamed_prop } } }\nwhip = { male = { portrait_modifier = { animations_props = walk_prop } } }\n');
    put(g3, MREL, gameMods);
    put(g3, GREL, gameGenes);
    put(g3, AREL, gameAcc);
    put(g3, 'gfx/portraits/accessories/other.txt', 'walk_acc = { entity = { entity = "walk_entity" } }\n');
    put(g3, 'gfx/models/props/props.asset', 'entity = {\n\tname = "crozier_entity"\n}\nentity = { # a comment before the name\n\tname = "crozier_2_entity"\n}\nentity = { name = "walk_entity" }\n');
    const mod3 = join(dir, 'mod3');
    const f3 = new Map<string, { file?: string; }>([
        [packRel, { file: put(mod3, packRel, 'book = { }\n') }],
        [MREL, { file: put(mod3, MREL, '﻿' + copyMods) }],
        [GREL, { file: put(mod3, GREL, copyGenes) }],
        ['gfx/portraits/portrait_animations/mod_animations.txt', { file: put(mod3, 'gfx/portraits/portrait_animations/mod_animations.txt', 'mod_redefined = { male = { default = { head = "idle" } } }\n') }]
    ]);
    const rules3 = fileRules({} as ModInfo, [step], g3, f3).filter((x) => x.kind === 'modelStates');
    const pr3 = rules3.find((x) => x.props);
    check(rules3.length === 2 && rules3[0].packs && pr3?.files.join() === `${MREL},${GREL}`, 'the plan: the copies of the modifier and gene files under the props entry, after the pack entry (whose pack names the crozier); no accessory copy', JSON.stringify(rules3.map((x) => x.files)));
    check(!!pr3?.notes?.some((n) => n.includes('props_left crozier_tpl: 2 → 4')) && pr3?.notes?.length === 1, 'the plan tells the template that got another index; nothing else (the accessories and entities load: the game\'s files, the entity with a comment before its name)', pr3?.notes?.join(' | '));
    const now = new Map<string, string>();
    const read3 = (r: string): string | undefined => now.get(r) ?? (f3.get(r)?.file ? readFileSync(f3.get(r)!.file!, 'utf8').replace(/^﻿/, '') : undefined);
    const ctx3 = { mod: {} as ModInfo, modFiles: f3, gameDir: g3 };

    for (const r of rules3)
    {
        const w3 = modelStatesWork(ctx3, r, read3);

        for (const x of r.files.filter((x) => w3.adds.has(x)))
            now.set(x, addModelEntries(read3(x)!, w3.adds.get(x)));
    }

    const mods3 = now.get(MREL) ?? '';
    check(
        now.get(packRel)?.includes('crozier = {') && mods3.includes('crozier_prop = {') && mods3.includes('walk_prop = {') && !mods3.includes('unnamed_prop') && !mods3.includes('book_prop') && (now.get(GREL) ?? '').includes('crozier_tpl = {\n\t\t\tindex = 4'),
        'the run: the pack, then its prop and the one a game animation names; not the one only a game animation the mod defines itself names, not one nothing names; the template with the free index',
        mods3
    );
    check(rules3.every((r) => !modelStatesWork(ctx3, r, read3).adds.size), 'a second pass adds nothing (both entries)');
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `${bad} of ${count} checks failed` : `all ${count} checks ok`);
process.exit(bad ? 1 : 0);
