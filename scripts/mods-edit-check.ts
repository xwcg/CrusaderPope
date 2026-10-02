// Checks editing the active mod (src/main/mods/edit.ts, GameIndex.overrideSource) against a TEMP user folder with a
// temp mod: builds the vanilla index in Node, copies definitions into the mod and checks the files written. The real
// user folder is never used.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/mods-edit-check.ts [keep]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OverridePlan, OverrideResult, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { applyOverride, composeScript, planOverride } from '../src/main/mods/edit.ts';
import type { ModsHost } from '../src/main/mods/manager.ts';
import { formatScript } from '../src/shared/scriptFormat.ts';
import type { OverrideSource } from '../src/main/indexer/override.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const tmp = mkdtempSync(join(tmpdir(), 'ckp-edit-'));
const root = join(tmp, 'mod', 'edit_test');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Edit Test"\nsupported_version="1.19.*"\n');
writeFileSync(join(tmp, 'mod', 'edit_test.mod'), `version="1.0"\nname="Edit Test"\nsupported_version="1.19.*"\npath="${root.replace(/\\/g, '/')}"\n`);

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

console.log('building the vanilla index …');
const idx = new GameIndex(new GameFiles(gameDir), 'english');
idx.build();
const settings: Settings = { gameDir: install, language: 'english', userDir: tmp, activeMod: 'mod/edit_test.mod' };
let reindexed = 0;
const wrote: string[] = [];
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    gameDir: () => gameDir,
    documents: () => join(tmp, 'no-documents'),
    reindex: () => reindexed++,
    query: async <T>(method: string, ...params: unknown[]): Promise<T> => (idx as unknown as Record<string, (...a: unknown[]) => T>)[method](...params),
    wrote: (files) => wrote.push(...files),
    // (undo steps: kept there — mods/undo.ts)
    dataDir: () => join(tmp, 'data')
};
const src = (type: string, name: string): OverrideSource => idx.overrideSource(type, name, settings.activeMod)!;
const gameText = (rel: string): Buffer => readFileSync(join(gameDir, rel));
const modText = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const lineOf = (text: string, line: number): string => text.replace(/^\uFEFF/, '').split(/\r?\n/)[line - 1];

try
{
    // --- a trait with the file's @constants
    const brave = src('traits', 'brave');
    check(brave.copy && brave.copy.constants.map((c) => c.name).includes('pos_compat_high'), `brave carries its constants: ${brave.copy?.constants.map((c) => '@' + c.name).join(' ')}`);
    check(gameText(brave.def!.rel).includes(Buffer.from(brave.copy!.text, 'utf8')), 'brave: the copied text is a byte-exact slice of its game file');
    let plan: OverridePlan = await planOverride(host, 'traits', 'brave');
    check(plan.mod?.name === 'Edit Test' && !plan.mod.loaded, 'plan: the active mod, not loaded');
    check(plan.copy.target === 'common/traits/zz_edit_test_overrides.txt', 'plan: copy target ' + plan.copy.target);
    check(plan.file.target === brave.def!.rel && !plan.file.exists, 'plan: file target ' + plan.file.target);
    let r: OverrideResult = await applyOverride(host, { type: 'traits', name: 'brave', mode: 'copy' });
    const traitsFile = 'common/traits/zz_edit_test_overrides.txt';
    let t = modText(traitsFile);
    check(r.action === 'copied' && r.rel === traitsFile && !r.reindex && reindexed === 0, `copied brave → ${r.rel}:${r.line} (no re-index: not loaded)`);
    check(t.startsWith('\uFEFF# Edit Test: overrides written by CrusaderPope'), 'new overrides file: BOM + header');
    check(lineOf(t, r.line!) === 'brave = {', `line ${r.line} is the definition: "${lineOf(t, r.line!)}"`);
    // (the mod keeps it formatted: the same text, re-spaced)
    const lf = (x: string): string => x.replace(/\r\n/g, '\n');
    check(lf(t).includes(lf(formatScript(brave.copy!.text)).trimEnd()) && t.indexOf('@pos_compat_high = 30') < t.indexOf('brave = {'), 'the constants come before the definition (formatted)');
    check(wrote.some((f) => f.endsWith('zz_edit_test_overrides.txt')), 'the watcher was told about the write');
    // again: the mod defines it already → opened, nothing written
    r = await applyOverride(host, { type: 'traits', name: 'brave', mode: 'copy' });
    check(r.action === 'opened' && lineOf(modText(traitsFile), r.line!) === 'brave = {' && modText(traitsFile) === t, 'copy again: opens the existing definition');
    // another trait: the constants are there already
    r = await applyOverride(host, { type: 'traits', name: 'craven', mode: 'copy' });
    t = modText(traitsFile);
    check(r.action === 'copied' && lineOf(t, r.line!) === 'craven = {', `craven appended at line ${r.line}`);
    check(t.split('@pos_compat_high = 30').length === 2, 'constants are not repeated');

    // a constant of the same name with another value: the next overrides file
    writeFileSync(join(root, traitsFile), t.replace('@neg_compat_high = -30', '@neg_compat_high = -31'));
    const other = ['diligent', 'lazy', 'wrathful', 'calm', 'gregarious', 'shy', 'honest', 'deceitful'].find((n) => src('traits', n).copy?.constants.some((c) => c.name === 'neg_compat_high'))!;
    r = await applyOverride(host, { type: 'traits', name: other, mode: 'copy' });
    check(r.action === 'copied' && r.rel === 'common/traits/zz_edit_test_overrides_2.txt', `${other}: @neg_compat_high differs in the first file → ${r.rel} (${r.notes.join(' ')})`);

    // --- an event: namespace at the top, the file-local effects it calls
    const ev = src('events', 'coronation_events.0100');
    check(ev.copy?.namespace === 'coronation_events', 'event namespace: ' + ev.copy?.namespace);
    check(ev.copy?.locals.map((l) => l.name).join(',') === 'sworn_oath_effect,warlike_oath_effect', 'event takes its local effects: ' + ev.copy?.locals.map((l) => l.name).join(', '));
    // the game keeps no winner for a duplicated event id: the plan says so (docs/mods.md, "Which definition wins")
    plan = await planOverride(host, 'events', 'coronation_events.0100');
    check(plan.copy.notes.some((n) => /Duplicated event ID/.test(n)), 'event copy: the duplicate note');
    r = await applyOverride(host, { type: 'events', name: 'coronation_events.0100', mode: 'copy' });
    const evFile = 'events/activities/coronation_activity/zz_edit_test_overrides.txt';
    t = modText(evFile);
    const lines = t.replace(/^\uFEFF/, '').split(/\r?\n/);
    check(r.rel === evFile && lines[1] === 'namespace = coronation_events', 'namespace declared right after the header: ' + lines[1]);
    check(lineOf(t, r.line!) === 'coronation_events.0100 = {', `event at line ${r.line}`);
    check(t.indexOf('scripted_effect sworn_oath_effect = {') < t.indexOf('coronation_events.0100 = {'), 'the local effect comes before the event');
    r = await applyOverride(host, { type: 'events', name: 'coronation_events.0110', mode: 'copy' });
    t = modText(evFile);
    check(t.split('namespace = coronation_events').length === 2, 'second event of the namespace: declared once');
    check(lineOf(t, r.line!) === 'coronation_events.0110 = {', `second event at line ${r.line}`);
    // a namespace added to an existing file goes after its namespace lines
    const other2 = composeScript('\uFEFFnamespace = a\r\n\r\na.1 = { }\r\n', { ...ev.copy!, namespace: 'b', locals: [], constants: [] }, 'x', 'h');
    check(other2.content!.startsWith('\uFEFFnamespace = a\r\nnamespace = b\r\n\r\na.1 = { }'), 'namespace inserted after the existing ones (CRLF kept)');

    // --- a localization key: the mod's replace file
    plan = await planOverride(host, 'localization', 'trait_brave');
    check(plan.loc && plan.copy.target === 'localization/english/replace/edit_test_l_english.yml', 'loc target ' + plan.copy.target);
    r = await applyOverride(host, { type: 'localization', name: 'trait_brave', mode: 'copy' });
    const loc = readFileSync(join(root, r.rel));
    check(loc[0] === 0xef && loc[1] === 0xbb && loc[2] === 0xbf, 'loc file: UTF-8 with BOM');
    const locLines = loc.toString('utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/);
    check(locLines[0] === 'l_english:' && /^ trait_brave:\d* "/.test(locLines[1]) && r.line === 2, `loc entry: ${locLines[1]} (line ${r.line})`);
    r = await applyOverride(host, { type: 'localization', name: 'trait_brave', mode: 'copy' });
    check(r.action === 'opened' && r.line === 2, 'loc key again: opened');

    // --- nested definitions: a faith is copied with its religion (1.20: on its own, religion/faith_types); a gene
    // inside a category block is not copyable
    const faith = src('faith', 'catholic');

    if (faith.container)
        check(faith.container.type === 'religion/religion_types' && faith.copy?.key === faith.container.name, `faith catholic is copied inside ${faith.container.name}`);
    else
        check(faith.copy?.key === 'catholic', 'faith catholic is copied on its own (1.20 layout)');

    const gene = idx.names('genes')[0];
    const g = src('genes', gene);
    check(!g.copy && /inside the block/.test(g.copyProblem ?? ''), `gene ${gene}: ${g.copyProblem}`);
    // a landed title: its own block without its vassals, inside empty blocks of its lieges (the game merges a title
    // written again into the one it has)
    const county = src('landed_titles', 'c_ile_de_france');
    check(county.path?.join(' › ') === 'e_france › k_france › d_valois' && county.container?.name === 'd_valois', `c_ile_de_france is written inside ${county.path?.join(' › ')}`);
    const ct = county.copy!.text;
    check(/^e_france = \{\r?\n\tk_france = \{\r?\n\t\td_valois = \{\r?\n\t\t\tc_ile_de_france = \{/.test(ct) && !/b_paris/.test(ct) && /color = \{ 24 52 226 \}/.test(ct), 'the copy: the lieges as empty blocks, the county’s values, no baronies');
    const own = ct.slice(county.copy!.at, county.copy!.end);
    check(own.startsWith('c_ile_de_france = {') && own.endsWith('}') && gameText(county.def!.rel).includes(Buffer.from(own.slice(0, own.indexOf('\n')), 'utf8')), 'at / end frame the county’s own block, as written');
    r = await applyOverride(host, { type: 'landed_titles', name: 'c_ile_de_france', mode: 'copy' });
    const titlesFile = 'common/landed_titles/zz_edit_test_overrides.txt';
    t = modText(titlesFile);
    check(r.rel === titlesFile && lineOf(t, r.line!).trim() === 'c_ile_de_france = {' && r.notes.some((n) => /without its de jure vassals/.test(n)), `copied into ${r.rel}:${r.line} (${r.notes[0]})`);
    r = await applyOverride(host, { type: 'landed_titles', name: 'c_ile_de_france', mode: 'copy' });
    check(r.action === 'opened' && lineOf(modText(titlesFile), r.line!).trim() === 'c_ile_de_france = {', 'copy again: opens it (found inside the empty blocks)');
    // its liege afterwards: a block of its own — the county the mod changed is not written again
    r = await applyOverride(host, { type: 'landed_titles', name: 'k_france', mode: 'copy' });
    t = modText(titlesFile);
    const heads = (x: string, k: string): number => x.split(/\r?\n/).filter((l) => l.trim().startsWith(k + ' = {')).length;
    check(r.action === 'copied' && heads(t, 'c_ile_de_france') === 1 && heads(t, 'e_france') === 2, 'k_france copied after it: its own block, the county not written again');
    // a copy of the county under a new key: its own block renamed, in empty blocks of its lieges (the new titles file)
    const { duplicateEntry } = await import('../src/main/mods/create.ts');
    const dup = await duplicateEntry(host, { type: 'landed_titles', source: 'c_ile_de_france', key: 'c_edit_test_copy', name: 'Test County' });
    const dt = modText(dup.rel);
    check(
        /e_france = \{\s*k_france = \{\s*d_valois = \{\s*c_edit_test_copy = \{\s*color = \{ 24 52 226 \}\s*\}\s*\}\s*\}\s*\}/.test(dt) && !/b_paris/.test(dt) && lineOf(dt, dup.line).trim() === 'c_edit_test_copy = {',
        `duplicate: c_edit_test_copy inside e_france › k_france › d_valois in ${dup.rel}:${dup.line}, no baronies`
    );
    // file-local scripted effects are not copied alone
    const local = src('scripted_effects', 'sworn_oath_effect');
    check(!local.copy && /File-local/.test(local.copyProblem ?? ''), 'local effect: ' + local.copyProblem);
    // on_actions merge
    plan = await planOverride(host, 'on_action', 'on_birth_child');
    check(plan.merging && plan.copy.notes.some((n) => /merge/.test(n)), 'on_action: merge note');

    // --- the whole file: same path, byte-exact; asks before replacing
    r = await applyOverride(host, { type: 'traits', name: 'brave', mode: 'file' });
    check(r.action === 'replaced' && readFileSync(r.file).equals(gameText(brave.def!.rel)) && r.line === brave.def!.line, `replaced ${r.rel} (byte-exact, line ${r.line})`);
    r = await applyOverride(host, { type: 'traits', name: 'craven', mode: 'file' });
    check(r.action === 'exists', 'the mod has that file now: asks first');
    writeFileSync(r.file, 'changed');
    r = await applyOverride(host, { type: 'traits', name: 'craven', mode: 'file', overwrite: true });
    check(r.action === 'replaced' && readFileSync(r.file).equals(gameText(brave.def!.rel)), 'overwrite: replaced');

    // --- the mod loaded over the game: its copies win, the index knows them as the mod's own
    const { modsState } = await import('../src/main/mods/manager.ts');
    const info = (await modsState(host)).mods.find((m) => m.id === settings.activeMod)!;
    console.log('building the index with the mod …');
    const withMod = new GameIndex(new GameFiles(gameDir, [info]), 'english');
    withMod.build();
    const bd = withMod.detail('traits', 'brave')!;
    // (brave's text is the game's, but its file's @neg_compat_high is -31, not -30: not the same as the game — docs/mods.md)
    check(bd.mod?.state === 'overridden' && bd.mod.mods.join() === info.id && bd.defs[bd.defs.length - 1].file === traitsFile, `brave: the mod's copy wins, overridden through its file's changed constant (${bd.mod?.state}), in ${bd.defs[bd.defs.length - 1].file}`);
    const od = withMod.detail('traits', other)!;
    check(od.mod?.state === 'same', `${other}: its copy in a file with the game's constants is the same as the game (${od.mod?.state})`);
    const ld = withMod.detail('localization', 'trait_brave')!;
    check(ld.mod?.state === 'same' && ld.defs[0].overridden && /replace\//.test(ld.defs[ld.defs.length - 1].file), `trait_brave: the replace file wins (the game text marked overridden), the same text (${ld.mod?.state})`);
    const ed = withMod.detail('events', 'coronation_events.0100')!;
    // (the game keeps no winner for an event defined in two files, however alike: a duplicate, not "the same")
    check(ed.defs[ed.defs.length - 1].file === evFile && ed.mod?.state === 'overridden' && ed.mod.duplicate, `coronation_events.0100: the copy is a duplicate (${ed.mod?.state}${ed.mod?.duplicate ? ', duplicate' : ''})`);
    const again = withMod.overrideSource('traits', 'brave', info.id)!;
    check(again.inMod?.rel === traitsFile && again.activeSource === 1, `the index knows the mod's own definition (${again.inMod?.rel}:${again.inMod?.line})`);
    // titles: the county's copy wins; the lieges the mod writes only as the way to it stay the game's, untouched
    const cd = withMod.detail('landed_titles', 'c_ile_de_france')!;
    check(cd.mod?.state === 'overridden' && cd.defs[cd.defs.length - 1].file === titlesFile, 'c_ile_de_france: the mod’s copy wins');
    const fd = withMod.detail('landed_titles', 'e_france')!;
    const vd = withMod.detail('landed_titles', 'd_valois')!;
    check(!fd.mod && fd.defs.some((d) => d.path && d.file === titlesFile) && !withMod.overrideSource('landed_titles', 'e_france', info.id)!.inMod, 'e_france: only the way in — no mod touch, the game’s definition wins, no definition of the mod’s own');
    check(!vd.mod && !withMod.overrideSource('landed_titles', 'd_valois', info.id)!.inMod && withMod.detail('landed_titles', 'k_france')?.mod?.state === 'overridden', 'd_valois: only the way in (untouched); k_france: its own copy wins');
    check(withMod.detail('landed_titles', 'c_edit_test_copy')?.mod?.state === 'added', 'c_edit_test_copy: added by the mod');

    // --- a later mod's replace_path over the target folder: the mod's file there would not load
    const later = join(tmp, 'mod', 'later_mod');
    mkdirSync(later, { recursive: true });
    const laterDesc = 'version="1.0"\nname="Later Mod"\nsupported_version="1.19.*"\nreplace_path="common/traits"\nreplace_path="common/scripted_effects"\nreplace_path="localization/english/replace"\n';
    writeFileSync(join(later, 'descriptor.mod'), laterDesc);
    writeFileSync(join(tmp, 'mod', 'later_mod.mod'), laterDesc + `path="${later.replace(/\\/g, '/')}"\n`);
    settings.customModLists = [{ id: 'order', name: 'Order', mods: [{ id: 'mod/edit_test.mod', enabled: true }, { id: 'mod/later_mod.mod', enabled: true }] }];
    settings.modList = 'custom:order';
    plan = await planOverride(host, 'scripted_effects', 'add_achievement_flag_effect');
    check(plan.mod?.loaded && /Later Mod loads after Edit Test and replaces common\/scripted_effects \(replace_path\)/.test(plan.copy.disabled ?? ''), 'replace_path of a later mod: copy refused — ' + plan.copy.disabled);
    check(/replaces common\/scripted_effects/.test(plan.file.disabled ?? ''), 'and the whole file too — ' + plan.file.disabled);
    // (the mod has diligent already — its copy of 00_traits.txt: opened, with the reason it doesn't load)
    plan = await planOverride(host, 'traits', 'diligent');
    check(plan.copy.open?.rel === 'common/traits/00_traits.txt' && plan.copy.notes.some((n) => /replaces common\/traits/.test(n)), `the mod's own definition in a replaced folder: opened, noted — ${plan.copy.notes.join(' ')}`);
    plan = await planOverride(host, 'localization', 'trait_calm');
    check(plan.copy.target === 'localization/replace/english/edit_test_l_english.yml' && plan.copy.notes.some((n) => /Not in localization\/english\/replace/.test(n)), `loc: the other replace folder — ${plan.copy.target} (${plan.copy.notes[0]})`);
    r = await applyOverride(host, { type: 'localization', name: 'trait_calm', mode: 'copy' });
    check(r.action === 'copied' && r.rel === 'localization/replace/english/edit_test_l_english.yml', 'loc copy written to ' + r.rel);
    plan = await planOverride(host, 'localization', 'trait_calm');
    check(plan.copy.open?.rel === r.rel, 'the key is found there next time: ' + plan.copy.open?.rel);
    const { newEntryPlan } = await import('../src/main/mods/create.ts');
    const np = await newEntryPlan(host, 'traits');
    check(/replaces common\/traits/.test(np.problem ?? ''), 'a new trait: refused — ' + np.problem);
    // the active mod after it: fine again
    settings.customModLists = [{ id: 'order', name: 'Order', mods: [{ id: 'mod/later_mod.mod', enabled: true }, { id: 'mod/edit_test.mod', enabled: true }] }];
    plan = await planOverride(host, 'scripted_effects', 'add_achievement_flag_effect');
    check(!plan.copy.disabled && plan.copy.target === 'common/scripted_effects/zz_edit_test_overrides.txt' && !plan.file.disabled, 'loaded after it: the copy goes to ' + plan.copy.target);
    settings.modList = undefined;

    // --- undo (mods/undo.ts): every write above is a step, kept in the data folder
    const { journalOf, undoChange, dropJournals } = await import('../src/main/mods/undo.ts');
    const create = await import('../src/main/mods/create.ts');
    const modId = settings.activeMod!;
    const kinds = journalOf(host).list(modId).map((s) => s.kind);
    // (the overrides and the duplicate above — the files written by hand in between are no steps)
    check(kinds.length > 8 && kinds.every((k) => k === 'override' || k === 'create'), `${kinds.length} steps: ${journalOf(host).list(modId).map((s) => s.label).join('; ')}`);
    // a new trait: its file and its texts' file, one step; a duplicate: another
    const locRel = 'localization/english/edit_test_l_english.yml';
    // (the texts' file may be there already — then undo gives it back as it was, else removes it)
    const locBefore = existsSync(join(root, locRel)) ? readFileSync(join(root, locRel), 'utf8') : null;
    const made = await create.createEntry(host, { type: 'traits', key: 'edit_test_new', name: 'Newly' });
    check(made.step !== undefined && existsSync(join(root, made.rel)) && existsSync(join(root, locRel)), `new trait: ${made.rel} and ${locRel} (step ${made.step})`);
    const dup2 = await create.duplicateEntry(host, { type: 'traits', source: 'brave', key: 'edit_test_bold', name: 'Bold' });
    check(dup2.step === made.step! + 1 && modText(dup2.rel).includes('edit_test_bold = {'), 'duplicate of brave: the next step');
    dropJournals();
    let u = await undoChange(host, { mod: modId });
    check(u?.label === 'brave duplicated as edit_test_bold' && !modText(made.rel).includes('edit_test_bold') && !modText(locRel).includes('edit_test_bold'), 'undo (after a restart): the duplicate is gone from both files');
    u = await undoChange(host, { mod: modId });
    const locNow = existsSync(join(root, locRel)) ? readFileSync(join(root, locRel), 'utf8') : null;
    check(u?.removed.includes(made.rel) && !existsSync(join(root, made.rel)) && locNow === locBefore, `undo: the new trait's file is removed (${u?.removed.join(', ')}), its texts' file as before (${locBefore === null ? 'removed' : 'restored'})`);
    // (the loc copy into the other replace folder, made after the overwrite below: its own step)
    u = await undoChange(host, { mod: modId });
    check(!!u?.label && /trait_calm/.test(u.label) && !u.refused, 'undo the loc copy: ' + u?.label);
    // the whole-file overwrite: back to what the file was before it (written by hand); then the first replacement: gone
    const craven = join(root, brave.def!.rel);
    u = await undoChange(host, { mod: modId });
    check(u?.label === 'Override of craven (its whole file)' && readFileSync(craven, 'utf8') === 'changed', 'undo the overwrite: the file is what it was before (“changed”)');
    const steps = journalOf(host).list(modId).length;
    u = await undoChange(host, { mod: modId });
    check(u?.refused && /changed since/.test(u.refused) && readFileSync(craven, 'utf8') === 'changed', 'undo of the first replacement: refused, the file was changed by hand since: ' + u?.refused);
    check(journalOf(host).list(modId).length === steps, 'the refused step stays');

    // --- no active mod
    settings.activeMod = undefined;
    plan = await planOverride(host, 'traits', 'brave');
    check(!!plan.problem && plan.copy.disabled === plan.problem, 'no active mod: ' + plan.problem);
    check(existsSync(join(tmp, 'no-documents')) === false, 'nothing written outside the temp user folder');
}
finally
{
    console.log(failures ? `\n${failures} FAILED` : '\nall ok', '— temp user folder', tmp);

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
