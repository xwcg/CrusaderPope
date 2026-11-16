// Checks the interface rules of "Fix for 1.20…" that look at hooks and lost types (src/main/mods/guiWork.ts) on a TEMP user folder: a mod
// with an older copy of the game's shared/mapmodes.gui (the base type without two of its blocks, the faith map mode type left out so it is
// carried over with the game's base inlined), a copy of a game window that defines a type another file of the mod uses, a second mod
// that ships an older copy of a game file. Overrides land on nothing where the thing overridden lacks the block, whatever block of the
// carried types has the name; another mod's older copy is not the mod's to restore; an offered restore tells the types it takes away.
// Pure cases for inlineBase (an override outside the base's own body, CRLF text) and for what a hook overrides.
// The rest of the migration is scripts/migrate-check.ts.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/migrate-check-gui.ts [keep]
// Every index it builds is a fresh build on parse threads (scripts/fast-index.ts buildIndex; THREADS=0: one thread), never from a cache.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { modsOfList, modsState, type ModsHost } from '../src/main/mods/manager.ts';
import { dataRoots, dropAbsentWidgets, guiWork, inlineBase, renameOf, summarizeText, type GuiConfig, type GuiWork } from '../src/main/mods/guiWork.ts';
import { carriedCalls, guiNotes, guiPlan, guiTodo } from '../src/main/mods/guiRule.ts';
import type { ModInfo } from '../src/shared/api.ts';
import { dataCallEnv } from '../src/main/mods/dataCallRule.ts';
import { MIGRATIONS } from '../src/main/mods/migrations.ts';
import { gwalk, parseGui } from '../src/main/gui/parser.ts';
import { defaultInstall } from './ck3-install.ts';
import { buildIndex } from './fast-index.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

// ---- pure cases

{
    const sum = summarizeText('t.gui', 'root_kind = {\n\tname = "r"\n\tusing = tpl3\n\tblockoverride "h" { }\n}\n\nwindow = {\n\tname = "w"\n\tthing = {\n\t\tblockoverride "a" { }\n\t\tblock "b" { inner = { blockoverride "c" { } } }\n\t}\n\tother = base_x { using = tpl blockoverride "d" { } }\n}\n\ntype t1 = base_t\n{\n\tusing = tpl2\n\tblockoverride "e" { }\n\tblock "f" { blockoverride "g" { } }\n}\n');
    const hooks = (d: string) => Object.fromEntries(sum.defs.find((x) => x.name === d)!.hooks.map((h) => [h.name, h.of.join('|')]));
    const w = hooks('w');
    check(w.a === 'thing' && w.c === 'inner' && w.d === 'other|base_x|tpl', `a hook overrides the nearest statement around it: its kind, base and using (${JSON.stringify(w)})`);
    check(hooks('r').h === 'root_kind|tpl3', `a root widget overrides its own kind and using (${JSON.stringify(hooks('r'))})`);
    const t1 = hooks('t1');
    check(t1.e === 'base_t|tpl2' && t1.g === 'base_t|tpl2', `a hook in a type overrides its base and using, a block around it is skipped (${JSON.stringify(t1)})`);
}

{
    // (an override that is no block of the base's own body: the block is in a nested type; the type stays as the game has it)
    const own = 'types T\n{\n\ttype x = base_t\n\t{\n\t\tblockoverride "deep" { size = { 1 1 } }\n\t}\n}\n';
    const base = 'types T\n{\n\ttype base_t = widget\n\t{\n\t\tnested_t = { }\n\t}\n\n\ttype nested_t = widget\n\t{\n\t\tblock "deep" { }\n\t}\n}\n';
    const x = summarizeText('o.gui', own).defs.find((d) => d.name === 'x')!;
    const b = summarizeText('b.gui', base).defs.find((d) => d.name === 'base_t')!;
    check(inlineBase(own, x, base, b) === undefined, 'inlineBase: an override with no block in the base’s own body is left (undefined)');
    const base2 = base.replace('nested_t = { }', 'block "deep" { }');
    const b2 = summarizeText('b.gui', base2).defs.find((d) => d.name === 'base_t')!;
    const r = inlineBase(own, x, base2, b2);
    check(!!r && r.text.includes('type x') && !r.text.includes('base_t') && r.text.includes('block "deep"') && r.text.includes('size = { 1 1 }'), `inlineBase: the same override as a block of the body is written into it (${r?.text.replace(/\s+/g, ' ')})`);
    // (a CRLF game file: the pieces parse back to one type, and the file's end of line is put on afterwards)
    const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
    const own3 = crlf(own);
    const base3 = crlf(base2);
    const x3 = summarizeText('o.gui', own3).defs.find((d) => d.name === 'x')!;
    const b3 = summarizeText('b.gui', base3).defs.find((d) => d.name === 'base_t')!;
    const r3 = inlineBase(own3, x3, base3, b3);
    const fixed = r3?.text.replace(/\r?\n/g, '\r\n');
    const parsed = fixed ? parseGui(fixed) : [];
    check(!!fixed && /^type x\b/.test(fixed) && parsed.length === 1 && parsed[0].key === 'type' && parsed[0].name === 'x' && !/[^\r]\n/.test(fixed) && fixed.includes('size = { 1 1 }'), `inlineBase: CRLF texts give one type, only CRLF line ends after the file's end of line is put on (${JSON.stringify(fixed?.slice(0, 80))})`);
}

{
    // (when the game's definition is the renamed old one: the old name plus a word, any base; a base changed with the same word of the name; a name close by)
    const defs = summarizeText('t.gui', 'types T\n{\n\ttype tenet_item = container {}\n\ttype tenet_item_small = widget {}\n\ttype fervor_vbox = vbox {}\n\ttype fervor_hbox = hbox {}\n\ttype fervor_panel = hbox {}\n}\n').defs;
    const [oi, os, ov, nv, np] = defs;
    check(renameOf(oi, os), 'a rename: the old name plus a _word, although the base changed');
    check(renameOf(ov, nv) && !renameOf(ov, np), 'a rename: vbox -> hbox in the name and the base alike; another name on the same new base is not one');
    check(!renameOf(oi, nv) && !renameOf(os, oi), 'and not an unrelated definition, nor the shorter name for the longer');
    const roots = [...dataRoots('text = "[FaithDoctrine.GetNameNoTooltip( Faith.Self )]"\ntexture = "[GetPlayer.GetRite.GetIcon]"\ntext = "[EqualTo_string( DoctrineType.GetGroup.GetCategory, \'Rite.x\' )]"')].sort().join();
    check(roots === 'DoctrineType,Faith,FaithDoctrine', `the objects an expression starts from, global functions and quoted text left out (${roots})`);
}

{
    // (a definition carried with its old body goes through the data call rules: a renamed call is rewritten, a site no rule maps is told)
    const groups = MIGRATIONS.flatMap((m) => m.dataCalls ?? []);
    const env = dataCallEnv('', new Set<string>());
    const old = '﻿types T\n{\n\ttype my_item = container\n\t{\n\t\ttext = "[ClearExploringRealms]"\n\t\ttexture = "[Faith.GetDoctrineBackgroundIcon]"\n\t}\n}\n';
    const r = carriedCalls(old, 'gui/zz_p_types.gui', groups, env);
    check(r.text.startsWith('﻿') && r.text.includes('[ClearExploredRealms]') && !r.text.includes('ClearExploringRealms'), `a carried body is rewritten by the data call rules (${JSON.stringify(r.text.slice(0, 120))})`);
    check(r.left.length === 1 && r.left[0].includes('GetDoctrineBackgroundIcon'), `a site the rules cannot map is told with the file (${JSON.stringify(r.left)})`);
    const r2 = carriedCalls(r.text, 'gui/zz_p_types.gui', groups, env);
    check(r2.text === r.text, 'a second pass gives the same text');
}

{
    // (widgets of a carried type that name an entry the playset lacks go; the others, and widgets with something inside, stay)
    const t = 'type t_x = button\n{\n\tblock "a" { }\n\n\twidget = {\n\t\tname = "w1"\n\t\tsize = { 100% 100% }\n\t\tvisible = "[ObjectsEqual( GetDecision(\'gone\'), Decision.Self)]"\n\t}\n\n\twidget = {\n\t\tname = "w2"\n\t\tvisible = "[ObjectsEqual( GetDecision(\'here\'), Decision.Self)]"\n\t}\n\n\tcontainer = {\n\t\tname = "c"\n\t\tvisible = "[ObjectsEqual( GetDecision(\'gone\'), Decision.Self)]"\n\t\tchild = { name = "k" }\n\t}\n\n\ttext_single = {\n\t\tname = "t"\n\t\ttext = "[GetPlayer.GetName] [GetTrait(\'gone\').GetName]"\n\t}\n}\n';
    const r = dropAbsentWidgets(t, (g, k) => (g === 'GetDecision' || g === 'GetTrait') && k === 'gone');
    const parsed = parseGui(r.text);
    check(r.dropped.length === 2 && r.dropped[0].startsWith('w1 (GetDecision(\'gone\'))') && r.dropped[1].startsWith('t (GetTrait'), `dropAbsentWidgets: the leaf widgets naming a missing entry go (${JSON.stringify(r.dropped)})`);
    check(!r.text.includes('"w1"') && r.text.includes('"w2"') && r.text.includes('name = "c"') && r.text.includes('block "a"') && parsed.length === 1 && parsed[0].key === 'type', 'the widget with a present entry, the container with a child widget and the block stay; the text parses back to one type');
    check(dropAbsentWidgets(r.text, (g, k) => k === 'gone').text === r.text && dropAbsentWidgets(t, () => false).text === t, 'a second pass changes nothing, and a playset that has everything changes nothing');
}

// ---- a mod and the index

const install = defaultInstall();
const gameDir = resolveGameDir(install)!;
const tmp = mkdtempSync(join(tmpdir(), 'ckp-gui-'));
mkdirSync(join(tmp, 'mod'), { recursive: true });
const settings: Settings = { gameDir: install, language: 'english', userDir: tmp, customModLists: [{ id: 'l1', name: 'Test list', mods: [] }], modList: 'custom:l1' };
let idx!: GameIndex;
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    gameDir: () => gameDir,
    documents: () => join(tmp, 'no-documents'),
    reindex: () => undefined,
    ready: () => Promise.resolve(),
    query: async () => undefined as never,
    wrote: () => undefined,
    refreshFiles: async () => undefined,
    dataDir: () => join(tmp, 'data')
};

const makeMod = (folder: string, name: string, supported: string): ((rel: string, text: string) => void) =>
{
    const root = join(tmp, 'mod', folder);
    mkdirSync(root, { recursive: true });
    const desc = `version="1.0"\nname="${name}"\nsupported_version="${supported}"\n`;
    writeFileSync(join(root, 'descriptor.mod'), desc);
    writeFileSync(join(tmp, 'mod', `${folder}.mod`), `${desc}path="${root.replace(/\\/g, '/')}"\n`);
    return (rel, text) =>
    {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), '﻿' + text);
    };
};

const gameText = (rel: string): string => readFileSync(join(gameDir, ...rel.split('/')), 'utf8').replace(/^﻿/, '');
/** The text without some statements (found by a test on the node). */
const without = (text: string, drop: (n: ReturnType<typeof parseGui>[number]) => boolean): string =>
{
    const cut: { s: number; e: number; }[] = [];
    gwalk(parseGui(text), (n) =>
    {
        if (drop(n))
            cut.push({ s: n.s, e: n.e });
    });
    return cut.sort((a, b) => b.s - a.s).reduce((t, c) => t.slice(0, c.s) + t.slice(c.e), text);
};

try
{
    const put = makeMod('old_mod_gui', 'Old Mod Gui', '1.19.0.6');
    const putB = makeMod('other_mod_gui', 'Other Mod Gui', '1.20.1.2');
    // (the base type without the two blocks 1.20 gave it, the faith map mode type left out: the game's windows use both)
    put('gui/shared/mapmodes.gui', without(gameText('gui/shared/mapmodes.gui'), (n) => (n.key === 'block' && (n.name === 'map_mode_button_expand' || n.name === 'map_mode_button_expand_menu')) || (n.key === 'type' && n.name === 'faith_mini_map_mode')));
    // (a copy of a game window that calls a name the game does not know and defines a type a file of the mod's own uses)
    put('gui/window_activity_log.gui', 'window = {\n\tname = "om_activity_log"\n\ttext = "[GetPlayer.GetRemovedThing]"\n\tom_f_type = { }\n}\n\ntypes OmTypes\n{\n\ttype om_f_type = widget\n\t{\n\t\tsize = { 4 4 }\n\t}\n}\n');
    put('gui/om_u.gui', 'window = {\n\tname = "om_u"\n\tom_f_type = { }\n}\n');
    // (a copy that is clean: nothing in it calls what the game removed)
    put('gui/window_domicile.gui', 'window = {\n\tname = "om_domicile"\n}\n');
    // (overrides of the achievement hooks, whose declarations another mod's older copy of the game file lacks)
    put('gui/om_hook_user.gui', 'window = {\n\tname = "om_hook_user"\n\twidget_achievement_list_entry = {\n\t\tblockoverride "achievement_icon" { size = { 10 10 } }\n\t\tblockoverride "achievement_description" { }\n\t}\n}\n');
    putB('gui/achievements/jomini_achievements_types.gui', gameText('gui/achievements/jomini_achievements_types.gui').replace('block "achievement_icon" {}', '').replace('block "achievement_description" {}', ''));
    // (an older map icon layer: two roots the game's code looks up by name are missing, and the type only one of them uses; another file of
    // the mod defines the second root itself, so only the first is appended)
    const rootName = (n: ReturnType<typeof parseGui>[number]): string | undefined => n.children?.find((c) => c.key === 'name')?.value?.replace(/"/g, '');
    put('gui/map_icon_layer.gui', without(gameText('gui/map_icon_layer.gui'), (n) => (n.key === 'container' && ['religious_head_widget', 'clerical_region_elector_icon'].includes(rootName(n) ?? '')) || (n.key === 'type' && n.name === 'religious_head_map_icon')));
    put('gui/om_roots.gui', 'container = {\n\tname = "clerical_region_elector_icon"\n}\n');
    settings.customModLists![0].mods.push({ id: 'mod/old_mod_gui.mod', enabled: true }, { id: 'mod/other_mod_gui.mod', enabled: true });
    const state = await modsState(host);
    idx = await buildIndex(new GameIndex(new GameFiles(gameDir, modsOfList(state, state.selected)), 'english'));
    const cfg: GuiConfig = { typesRel: 'gui/zz_old_mod_gui_1_20_fixes_types.gui', restore: [], empty: [], candidates: [], covered: [] };
    const w = guiWork(idx, cfg, 'mod/old_mod_gui.mod', undefined)!;
    check(!!w, 'guiWork finds the mod');

    const mi = w.roots.find((r) => r.rel === 'gui/map_icon_layer.gui');
    check(!!mi && mi.roots.map((r) => r.name).join() === 'religious_head_widget', `the root the older copy lacks is appended, the one another file defines is not (${JSON.stringify(mi?.roots)})`);
    check(!!mi && mi.text.includes('### Head of Faith / Head of Rite Map Icon') && mi.text.includes('name = "religious_head_widget"') && parseGui(mi.text).filter((n) => rootName(n) === 'religious_head_widget').length === 1, 'the root is written as the game wrote it, with its comment, once, after the copy');
    check(!!mi && w.types.defs.some((d) => d.name === 'religious_head_map_icon') && w.types.text.includes('type religious_head_map_icon'), 'the type only the appended root uses is carried into the types file');
    check(w.roots.filter((r) => r.rel === 'gui/map_icon_layer.gui').length === 1 && w.roots.every((r) => r.roots.length && parseGui(r.text).length > 1), `each copy lacking a root of the game's file gets them (${w.roots.map((r) => r.rel + ':' + r.roots.length).join()}), the window copies of this test included`);
    const faith = w.types.defs.find((d) => d.name === 'faith_mini_map_mode');
    check(faith?.inlined?.base === 'mini_map_mode' && faith.inlined.hooks.join() === 'map_mode_button_expand,map_mode_button_expand_menu', `the carried faith map mode is written with the game's base inlined (${JSON.stringify(faith?.inlined)})`);
    check(w.types.text.includes('block "map_mode_button_expand"') && !w.types.text.includes('blockoverride "map_mode_button_expand"'), 'its text declares the blocks itself, no override of them is left');

    const maps = w.hooks.find((h) => h.file === 'gui/shared/mapmodes.gui');
    check(!!maps && maps.names.includes('map_mode_button_expand') && maps.names.includes('map_mode_button_expand_menu') && maps.users.some((u) => u.startsWith('gui/window_the_great_steppe.gui:')), `the overrides of the older mini_map_mode land on nothing, although the carried type declares the blocks: told for its file (${JSON.stringify(maps)})`);
    check(!w.hooks.some((h) => h.file === 'gui/achievements/jomini_achievements_types.gui'), 'another mod’s older copy of a game file is not told as the mod’s');
    check(!w.offers.some((o) => o.rel === 'gui/achievements/jomini_achievements_types.gui'), 'and not offered as a restore');
    const mapsOffer = w.offers.find((o) => o.rel === 'gui/shared/mapmodes.gui');
    check(!!mapsOffer && mapsOffer.hooks.includes('map_mode_button_expand'), `the older mapmodes.gui is offered with the hooks as the reason (${JSON.stringify(mapsOffer?.hooks)})`);

    const logOffer = w.offers.find((o) => o.rel === 'gui/window_activity_log.gui');
    check(!!logOffer && logOffer.names.includes('GetRemovedThing') && logOffer.takes.join() === 'om_f_type', `an offered restore tells the type of the copy that a file of the mod uses and the game's file lacks (${JSON.stringify(logOffer)})`);
    check(!w.offers.some((o) => o.rel === 'gui/window_domicile.gui'), `a clean copy of a game window is not offered (${JSON.stringify(w.offers.find((o) => o.rel === 'gui/window_domicile.gui'))}, ${JSON.stringify(w.hooks.filter((h) => h.file.includes('domicile')))})`);
    check(w.lost.length === 0 && !(mapsOffer?.takes.length), `nothing is lost before the restore, the other offer takes nothing (${JSON.stringify(mapsOffer?.takes)})`);

    // ---- widgets of the game's body that name a decision the playset lacks
    // (a mod that took the DLC decisions out (files of the same paths with nothing in them) and keeps an older copy of the decisions
    // window: its button type lacks the hooks the game's button with parameters overrides, so that type is written with the game's button
    // body, and the tutorial highlights of the game's body that name the decisions the playset lacks would log every lookup)
    const putD = makeMod('dec_mod_gui', 'Dec Mod Gui', '1.19.0.6');
    const dec = gameText('gui/window_decisions.gui');
    const cut: { s: number; e: number; }[] = [];
    gwalk(parseGui(dec), (n, parents) =>
    {
        const inButton = parents[parents.length - 1]?.name === 'button_decision_entry';

        if ((n.key === 'type' && n.name === 'button_decision_entry_with_parameters') || (inButton && ((n.key === 'block' && ['tooltip_widget', 'extra_context'].includes(n.name ?? '')) || n.key === 'widget')))
            cut.push({ s: n.s, e: n.e });
    });
    putD('gui/window_decisions.gui', cut.sort((a, b) => b.s - a.s).reduce((t, c) => t.slice(0, c.s) + t.slice(c.e), dec));
    putD('common/decisions/dlc_decisions/tgp/tgp_japan_decisions.txt', '# disabled by the mod\n');
    putD('common/decisions/dlc_decisions/tgp/tgp_china_decisions.txt', '# disabled by the mod\n');
    settings.customModLists![0].mods.length = 0;
    settings.customModLists![0].mods.push({ id: 'mod/dec_mod_gui.mod', enabled: true });
    const stateD = await modsState(host);
    const idxD = await buildIndex(new GameIndex(new GameFiles(gameDir, modsOfList(stateD, stateD.selected)), 'english'));
    const wd = guiWork(idxD, { typesRel: 'gui/zz_dec_patch_types.gui', restore: [], empty: [], candidates: [], covered: [] }, 'mod/dec_mod_gui.mod', undefined)!;
    const bp = wd.types.defs.find((d) => d.name === 'button_decision_entry_with_parameters');
    check(!!bp?.inlined && bp.inlined.base === 'button_decision_entry', `the game's button with parameters is carried with the game's button body (${JSON.stringify(bp?.inlined)})`);
    check(bp?.inlined?.dropped?.length === 3 && bp.inlined.dropped.every((x) => x.includes('tgp_')), `and without the three highlights that name the DLC decisions (${JSON.stringify(bp?.inlined?.dropped)})`);
    check(!/tgp_(japan|china)/.test(wd.types.text) && wd.types.text.includes("GetDecision('renounce_governorship_decision')") && wd.types.text.includes('renounce_governorship_decision_tutorial_highlight'), 'the types file has no key of the missing decisions, and the highlight of the decision that exists');
    check(parseGui(wd.types.text).length >= 1 && summarizeText('t.gui', wd.types.text.replace(/^\ufeff/, '')).defs.some((d) => d.name === 'button_decision_entry_with_parameters'), 'and parses back');

    // ---- the plan for the types file of an older run that nothing carries now: deleted when the tool wrote it, kept and told when it was changed
    {
        const work: GuiWork = { roots: [], types: { text: '', defs: [], skipped: [] }, orphans: [], lost: [], hooks: [], offers: [], ownUnknown: [] };
        const fake = { query: async () => work } as unknown as ModsHost;
        const root = join(tmp, 'leftover_patch');
        const rel = 'gui/zz_lp_types.gui';
        const patchMod = { id: 'mod/lp.mod', root } as unknown as ModInfo;
        const cfgL = { restore: [], empty: [], candidates: [], covered: [] };
        const plan = (): ReturnType<typeof guiPlan> => guiPlan(fake, { id: 'mod/m.mod' } as unknown as ModInfo, 'lp', patchMod, cfgL);
        const write = (text: string): void => { mkdirSync(join(root, 'gui'), { recursive: true }); writeFileSync(join(root, rel), text); };
        const stubs = ['\ufeff# Nothing to carry over (any more): every type the game’s windows use is defined by a loaded file.\n', '\ufeff# Types and templates the game\'s windows use that the mod\'s older copies of shared interface files lack — 2, as the game writes them. Written by CrusaderPope.\n\ntype a = widget {}\n'];

        for (const text of stubs)
        {
            write(text);
            const p1 = (await plan())!;
            const todo = guiTodo(p1, root);
            check(p1.typesRemove === true && todo.length === 1 && todo[0].rel === rel && todo[0].remove === true && p1.entries.some((e) => e.kind === 'guiTypes' && e.todo.includes(rel)), `a types file the tool wrote, that nothing carries now, is to be deleted (${JSON.stringify(todo)})`);
            check(guiNotes(p1, todo).some((n) => n.includes(rel + ' is deleted')), 'and the result says so');
        }

        write('# my own types\ntype mine = widget {}\n');
        const p2 = (await plan())!;
        check(!p2.typesRemove && guiTodo(p2, root).length === 0 && p2.notes.some((n) => n.includes(rel) && n.includes('changed by hand — kept')) && !p2.entries.length, 'a file changed by hand stays and is told');
        rmSync(join(root, rel));
        const p3 = (await plan())!;
        check(!p3.typesRemove && guiTodo(p3, root).length === 0 && !p3.entries.length && !p3.notes.length, 'no file, nothing to do and nothing to tell');
    }

    // ---- a type only the hidden copy defined, and a copy without a byte-order mark
    // (the patch mod restores the game's window file the mod's copy of which defined a type and a template another file of the mod uses:
    // they are carried into the types file with what they use; a second run with that file in place gives the same text)
    const putNb = (folder: string, name: string): ((rel: string, text: string) => void) =>
    {
        const root = join(tmp, 'mod', folder);
        mkdirSync(root, { recursive: true });
        const desc = `version="1.0"\nname="${name}"\nsupported_version="1.20.1.2"\n`;
        writeFileSync(join(root, 'descriptor.mod'), desc);
        writeFileSync(join(tmp, 'mod', `${folder}.mod`), `${desc}path="${root.replace(/\\/g, '/')}"\n`);
        return (rel, text) =>
        {
            mkdirSync(join(root, rel, '..'), { recursive: true });
            writeFileSync(join(root, rel), text);
        };
    };
    const put2 = putNb('hid_mod_gui', 'Hid Mod Gui');
    const patch2 = putNb('hid_patch_gui', 'Hid Patch Gui');
    const crlf = (t: string): string => t.replace(/\r?\n/g, '\r\n');
    put2('gui/window_domicile.gui', crlf('window = {\n\tname = "hm_domicile"\n}\n\ntypes HmTypes\n{\n\ttype hm_tip = widget\n\t{\n\t\tusing = hm_tpl\n\t\thm_inner = { }\n\t}\n\n\ttype hm_inner = widget\n\t{\n\t\tsize = { 2 2 }\n\t}\n\n\ttype hm_unused = widget\n\t{\n\t}\n}\n\ntemplate hm_tpl\n{\n\talpha = 0.5\n}\n'));
    put2('gui/hm_user.gui', crlf('window = {\n\tname = "hm_user"\n\thm_tip = { }\n\tfaith_tooltip_core_tenents = { }\n\tfervor_container_vbox = { }\n\thbox = {\n\t\tdatamodel = "[Faith.GetDoctrines]"\n\t\titem = {\n\t\t\tcontainer_tenet_item = { }\n\t\t}\n\t}\n}\n'));
    // (the mod's older copy of the faith window file: 1.19's tenet item reads a doctrine, the game's renamed one reads a rite; the fervor box was a vbox)
    put2('gui/window_faith.gui', crlf('types HmFaith\n{\n\ttype container_tenet_item = container\n\t{\n\t\ttext = "[FaithDoctrine.GetNameNoTooltip( Faith.Self )]"\n\t}\n\n\ttype fervor_container_vbox = vbox\n\t{\n\t\tname = "fervor_container"\n\t\ttext = "[Faith.GetYearlyFervorChange]"\n\t}\n}\n'));
    patch2('gui/window_faith.gui', '﻿' + gameText('gui/window_faith.gui'));
    // (a 1.19 type the game renamed: the mod's older copy of the shared file defines the old name, the game's file the new one)
    put2('gui/shared/cooltip.gui', crlf('types HmCool\n{\n\ttype faith_tooltip_core_tenents = faith_tooltip\n\t{\n\t\tusing = old_tenets_info\n\t}\n}\n'));
    patch2('gui/shared/cooltip.gui', '\ufeff' + gameText('gui/shared/cooltip.gui'));
    // (no byte-order mark, line ends CRLF: two roots missing)
    put2('gui/map_icon_layer.gui', crlf(without(gameText('gui/map_icon_layer.gui'), (n) => n.key === 'container' && ['religious_head_widget', 'clerical_region_elector_icon'].includes(rootName(n) ?? ''))));
    patch2('gui/window_domicile.gui', '\ufeff' + gameText('gui/window_domicile.gui'));
    settings.customModLists![0].mods.length = 0;
    settings.customModLists![0].mods.push({ id: 'mod/hid_mod_gui.mod', enabled: true }, { id: 'mod/hid_patch_gui.mod', enabled: true });
    const state2 = await modsState(host);
    const idx2 = await buildIndex(new GameIndex(new GameFiles(gameDir, modsOfList(state2, state2.selected)), 'english'));
    const cfg2: GuiConfig = { typesRel: 'gui/zz_hid_patch_gui_types.gui', restore: ['gui/window_domicile.gui', 'gui/shared/cooltip.gui', 'gui/window_faith.gui'], empty: [], candidates: [], covered: [] };
    const w2 = guiWork(idx2, cfg2, 'mod/hid_mod_gui.mod', 'mod/hid_patch_gui.mod')!;
    const carried = w2.types.defs.filter((d) => d.fromMod && !d.aliasOf && d.file !== 'gui/window_faith.gui').map((d) => d.name).sort().join();
    check(carried === 'hm_inner,hm_tip,hm_tpl', `the hidden copy's type a file of the mod uses is carried, with the type and the template it uses in turn, the unused one is not (${carried})`);
    const al = w2.types.defs.find((d) => d.name === 'faith_tooltip_core_tenents');
    check(al?.aliasOf === 'faith_tooltip_core_tenets', `a type the game's current file renamed becomes an alias of the new one (${JSON.stringify(al)})`);
    check(w2.types.text.includes('type faith_tooltip_core_tenents = faith_tooltip_core_tenets {}') && !w2.types.text.includes('old_tenets_info'), 'written as an alias with an empty body, the old body is not carried');
    const fv = w2.types.defs.find((d) => d.name === 'fervor_container_vbox');
    check(fv?.aliasOf === 'fervor_container_hbox' && w2.types.text.includes('type fervor_container_vbox = fervor_container_hbox {}'), `a type whose base and name changed by the same word is an alias (${JSON.stringify(fv)})`);
    const ti = w2.types.defs.find((d) => d.name === 'container_tenet_item');
    check(!!ti && !ti.aliasOf && ti.fromMod && w2.types.text.includes('type container_tenet_item = container'), `the renamed type whose new form reads a rite, where the users give a doctrine, keeps the old body (${JSON.stringify(ti)})`);
    check(w2.types.skipped.some((n) => n.startsWith('container_tenet_item ') && n.includes('container_tenet_item_small') && n.includes('Rite') && n.includes('FaithDoctrine')), `and the result says why (${JSON.stringify(w2.types.skipped)})`);
    check(w2.lost.length === 0, `nothing it carried stays lost (${JSON.stringify(w2.lost)})`);
    check(w2.types.text.includes('type hm_tip') && w2.types.text.includes('template hm_tpl') && w2.types.text.startsWith('\ufeff') && !w2.types.text.includes('hm_unused'), 'the types file holds them');
    const parsedTypes = summarizeText('t.gui', w2.types.text).defs.map((d) => d.name);
    check(['hm_tip', 'hm_inner', 'hm_tpl'].every((n) => parsedTypes.includes(n)), `and parses back to them (${parsedTypes.join()})`);

    // (second run: the types file is in the patch mod; the text it gives is the same)
    patch2(cfg2.typesRel, w2.types.text.replace(/^\ufeff/, ''));
    const idx3 = await buildIndex(new GameIndex(new GameFiles(gameDir, modsOfList(state2, state2.selected)), 'english'));
    const w3 = guiWork(idx3, cfg2, 'mod/hid_mod_gui.mod', 'mod/hid_patch_gui.mod')!;
    check(w3.types.text === w2.types.text && w3.lost.length === 0, 'a second run with the types file in place gives the same text');

    const mi2 = w2.roots.find((r) => r.rel === 'gui/map_icon_layer.gui');
    check(!!mi2 && mi2.roots.length === 2 && !mi2.text.startsWith('\ufeff') && /\r\n/.test(mi2.text) && !/[^\r]\n/.test(mi2.text), 'the roots appended to a copy without a byte-order mark leave it without one (crlf kept)');
    const mi1 = w.roots.find((r) => r.rel === 'gui/map_icon_layer.gui');
    check(!!mi1 && mi1.text.startsWith('\ufeff'), 'and a copy that has one keeps it');
}
finally
{
    if (!process.argv.includes('keep'))
        rmSync(tmp, { recursive: true, force: true });
    else
        console.log('kept', tmp);
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
