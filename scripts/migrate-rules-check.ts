// Light unit cases of rules of "Fix for 1.20…" that need no game files: the libraries rule's reference scan (src/main/mods/libraries.ts
// `scan`) with its folder table (migrations.ts `libraries`): which key a name must stand under for a folder, and two folders whose names
// stand under the same key (static and opinion modifiers, both `modifier = x`) told apart by their candidates; statement groups of
// migrations.ts applied to small texts (scriptRules.ts `statementEdits`); the flags rule of the libraries step with the renamed rule's aliases.
// Usage: node --experimental-strip-types --no-warnings scripts/migrate-rules-check.ts
import { libraryWork, scan, type LibraryFolder } from '../src/main/mods/libraries.ts';
import { MIGRATIONS } from '../src/main/mods/migrations.ts';
import { applyStatementEdits, statementEdits, type StatementEnv } from '../src/main/mods/scriptRules.ts';
import { definesFile } from '../src/main/mods/defineDiff.ts';
import { gamePathOrder } from '../src/main/mods/gamefiles.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const folders = MIGRATIONS.flatMap((m) => m.libraries?.folders ?? []);
const folder = (name: string): LibraryFolder => folders.find((f) => f.folder === name)!;
const opinions = folder('common/opinion_modifiers');
const statics = folder('common/modifiers');
check(!!opinions && !!statics, 'the 1.20 libraries list the opinion modifiers next to the static modifiers');

// (the candidates: an opinion modifier and a static modifier the mod's copies hide)
const byName = new Map<string, LibraryFolder[]>([['circumvented_my_authority_opinion', [opinions]], ['rejected_from_marriage_bed_modifier', [statics]]]);
const hits = (text: string): string[] =>
{
    const out: string[] = [];
    scan(text, 'script', byName, (h) => out.push(`${h.folder.folder}|${h.name}`));
    return out;
};
const O = 'common/opinion_modifiers|circumvented_my_authority_opinion';
const S = 'common/modifiers|rejected_from_marriage_bed_modifier';

check(hits('e = {\n\tadd_opinion = {\n\t\ttarget = scope:actor\n\t\tmodifier = circumvented_my_authority_opinion\n\t}\n}\n').join() === O, 'add_opinion = { modifier = x }: the opinion modifier');
check(hits('e = {\n\treverse_add_opinion = { target = scope:x modifier = circumvented_my_authority_opinion opinion = -10 }\n}\n').join() === O, 'reverse_add_opinion on one line');
check(hits('t = {\n\thas_opinion_modifier = { target = scope:x modifier = circumvented_my_authority_opinion }\n}\n').join() === O, 'has_opinion_modifier');
check(hits('e = {\n\tadd_character_modifier = { modifier = rejected_from_marriage_bed_modifier years = 5 }\n\tremove_character_modifier = rejected_from_marriage_bed_modifier\n}\n').join() === [S, S].join(), 'the static modifier under the same key and under *_modifier: the static one');
check(hits('x = {\n\ttriggered_opinion = {\n\t\tparameter = p\n\t\topinion_modifier = circumvented_my_authority_opinion\n\t}\n}\n').join() === O, 'a trait\'s triggered_opinion names it as opinion_modifier');
check(hits('e = {\n\tsome_effect = { OPINION_TYPE = circumvented_my_authority_opinion }\n\tother_effect = { OPINION_MODIFIER = circumvented_my_authority_opinion }\n\tthird_effect = { MODIFIER = circumvented_my_authority_opinion }\n}\n').join() === [O, O, O].join(), 'the macro arguments the game\'s scripted effects pass on as modifier = $X$');
check(!hits('e = {\n\tset_variable = { name = circumvented_my_authority_opinion value = 1 }\n\tdesc = circumvented_my_authority_opinion\n}\n').length, 'the name under another key is no reference (a variable, a text key)');
check(!hits('# modifier = circumvented_my_authority_opinion\ncircumvented_my_authority_opinion = {\n\topinion = -10\n}\n').length, 'a comment and the definition itself are no references');
check(!hits('e = {\n\tadd_opinion = { modifier = $MOD$ target = scope:x }\n}\n').length, 'a macro parameter is no name');

// statement groups of 1.20
{
    const env: StatementEnv = { sets: {}, defined: () => false, roots: [] };
    const groups = MIGRATIONS.flatMap((m) => m.statements ?? []);
    const run = (rel: string, text: string): string =>
        groups.filter((g) => g.files.some((p) => new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`, 'i').test(rel)))
            .reduce((t, g) => applyStatementEdits(t, statementEdits(t, rel, g, env).edits), text);
    const family = 'rf_old = {\r\n\tis_pagan = yes\r\n\tgraphical_faith = pagan_gfx\r\n\thostility_doctrine = pagan_hostility_doctrine\r\n}\r\n\r\nrf_other = {\r\n\tis_pagan = no # not pagan\r\n\tgraphical_faith = x\r\n}\r\n';
    const out = run('common/religion/religion_family_types/x_paganism.txt', family);
    check(out === 'rf_old = {\r\n\tgraphical_faith = pagan_gfx\r\n\thostility_doctrine = pagan_hostility_doctrine\r\n}\r\n\r\nrf_other = {\r\n\t # not pagan\r\n\tgraphical_faith = x\r\n}\r\n', `a religion family loses is_pagan (yes or no), its line with it (a comment behind it stays): ${JSON.stringify(out)}`);
    check(run('common/religion/religion_family_types/x_paganism.txt', out) === out, 'a second pass changes nothing');
    check(run('common/religion/religion_types/x.txt', 'r = {\n\tis_pagan = yes\n}\n') === 'r = {\n\tis_pagan = yes\n}\n', 'the key is only dropped in the families');
}

// the defines file loads after every file of the folder: the game reads a folder's own files first, then its subfolders, and the later value wins
{
    const file = definesFile('common/defines', '3767974559_1_20_fixes');
    const before = ['common/defines/00_defines.txt', 'common/defines/graphic/00_graphics.txt', 'common/defines/ai/00_ai.txt', 'common/defines/jomini/text_formatting.txt', 'common/defines/zz_other_mod_defines.txt'];
    check(file === 'common/defines/zz_3767974559_1_20_fixes/zz_3767974559_1_20_fixes_defines.txt', `the file: ${file}`);
    check(before.every((rel) => gamePathOrder(rel, file) < 0), 'it loads after the mod\'s root and subfolder files (graphic/00_graphics.txt among them) and the game\'s');
    check(gamePathOrder('common/defines/zz_3767974559_1_20_fixes_defines.txt', 'common/defines/graphic/00_graphics.txt') < 0, 'the root file of earlier runs loaded before graphic/00_graphics.txt (why its TRAIT_OVERLAY_VIRTUE lost)');
}

// the flags rule and the renamed rule's aliases: an entry the mod keeps under its old key (scholar) gets the flags 1.20 gave the new one (erudite)
{
    type F = { rel: string; source: number; text: string; };
    const GAME = 0;
    const MOD = 1;
    const files: F[] = [
        { rel: 'common/traits/00_traits.txt', source: GAME, text: 'erudite = {\n\tflag = gnostic_learning_piety_trait\n\tflag = old_flag\n}\n\nbrave = {\n\tflag = brave_flag\n}\n' },
        { rel: 'common/traits/00_traits.txt', source: MOD, text: 'scholar = {\n\tflag = old_flag\n}\n\nbrave = {\n\tflag = brave_flag\n}\n' },
        { rel: 'events/e.txt', source: GAME, text: 'e.1 = {\n\ttrigger = { has_trait_with_flag = gnostic_learning_piety_trait }\n}\n' }
    ];
    // (the layering: the mod's file of a path hides the game's)
    const winner = (rel: string): F => files.filter((f) => f.rel === rel).sort((a, b) => b.source - a.source)[0];
    const loaded = files.filter((f) => winner(f.rel) === f);
    const under = (top: string, ext?: RegExp): (f: F) => boolean => (f) => f.rel.startsWith(top + '/') && (!ext || ext.test(f.rel));
    const vfs = {
        list: (top: string, o?: { ext?: RegExp; }) => loaded.filter(under(top, o?.ext)),
        hidden: (top: string, o?: { ext?: RegExp; }) => files.filter((f) => winner(f.rel) !== f && under(top, o?.ext)(f)).map((f) => ({ file: f, by: winner(f.rel).source, how: 'file' as const })),
        readText: (f: F) => f.text,
        get: (rel: string) => winner(rel)
    } as unknown as Parameters<typeof libraryWork>[0];
    const kinds = MIGRATIONS.flatMap((m) => m.libraries?.flags ?? []).filter((k) => k.folder === 'common/traits');
    // (what the rule tells the inert step: whether a test of a word is false)
    const said: { missing?: (folder: string, word: string) => boolean; } = {};
    const ask = (word: string): boolean | undefined => said.missing?.('common/traits', word);
    const inert = { text: (_: string, t: string) => t, gainable: () => undefined, declined: () => undefined, flags: (fn: (folder: string, word: string) => boolean) => void (said.missing = fn) };
    const aliases = [{ type: 'lifestyle_perks', from: 'erudite', to: 'brave' }, { type: 'traits', from: 'erudite', to: 'scholar' }];
    const out = libraryWork(vfs, { folders: [], flags: kinds }, MOD, -1, 'english', [], [], inert, aliases).find((f) => f.folder === 'common/traits');
    const entry = out?.entries.find((e) => e.name === 'scholar');
    check(kinds.length === 1 && entry?.text === 'scholar = {\n\tflag = old_flag\n\tflag = gnostic_learning_piety_trait\n}' && entry.words?.join() === 'gnostic_learning_piety_trait', `the mod's scholar gets the flag the game's erudite carries: ${JSON.stringify(entry?.text)}`);
    check(!out?.gone?.length && ask('gnostic_learning_piety_trait') === false, 'the word is not gone, and no test of it is made false');
    said.missing = undefined;
    const plain = libraryWork(vfs, { folders: [], flags: kinds }, MOD, -1, 'english', [], [], inert).find((f) => f.folder === 'common/traits');
    check(!plain?.entries.length && plain?.gone?.join() === 'gnostic_learning_piety_trait (erudite)' && ask('gnostic_learning_piety_trait') === true, 'without the alias: no entry to give it to (told), its tests made false');
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
