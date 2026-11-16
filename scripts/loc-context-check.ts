// The context rule of "Fix for 1.20…" (dataCalls.ts `contextChange`, a data call group with `contexts`; dataCallRule.ts; migrate.ts
// `loadedNames`, `fileRules`) on small texts and a small game folder in TEMP (no index, no real game): a text the game's program
// fills itself whose data context the game version replaced (1.20's hostile-faith opinion lines: FAITH is Rite) gets the game's
// context, the mod's wording stays; where no rename is safe (an ambiguous pair, a call the game never makes on the new context,
// several chains) the game's text of the key replaces the mod's (in the file's language, else English), the key's `:N` and a
// comment after it kept; a key whose file keeps the game's current text as a comment (the mod's own line is deliberate), a key a
// loaded script names, a key whose game text names no other context and a global function are left;
// a replace folder's text is answered in a replace folder; a second pass changes nothing.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/loc-context-check.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { applyCallEdits, languageOf, locCallEdits, type DataCallEnv, type DataCallGroup } from '../src/main/mods/dataCalls.ts';
import { dataCallEnv, dataCallNotes } from '../src/main/mods/dataCallRule.ts';
import { fileRules, loadedNames, namedContextKeys } from '../src/main/mods/migrate.ts';
import { MIGRATIONS, type Migration } from '../src/main/mods/migrations.ts';
import { layerRoots } from '../src/main/mods/gameLayers.ts';
import type { StatementEnv } from '../src/main/mods/scriptRules.ts';

let bad = 0;
let count = 0;
const check = (ok: unknown, what: string, detail?: string): void =>
{
    count++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);

    if (!ok)
        bad++;
};

// (the group as 1.20 defines it)
const group: DataCallGroup = MIGRATIONS[0].dataCalls!.find((g) => g.contexts)!;
check(!!group && group.files.includes('localization/**/*.yml') && !group.rules.length, 'the 1.20 migration has a context group for localization');

// (the rule by itself, with an environment written here: which keys the program fills, the game's texts, the calls its texts make)
{
    const engine = new Set(['OPINION_X', 'OPINION_FR', 'WINDOW_TITLE', 'NO_COUNTERPART', 'TWO_NEW', 'BIRTH', 'GLOBAL', 'ARGS', 'STRINGS', 'COMMENTED', 'CHAINS']);
    const game: Record<string, string> = {
        OPINION_X: '[Rite.GetName] is $LEVEL$',
        OPINION_FR: '[Rite.GetName] est $LEVEL|l$',
        WINDOW_TITLE: 'Convert to [FaithConversionWindow.GetFaith.GetNameNoTooltip]',
        NO_COUNTERPART: 'The faith is $LEVEL$',
        TWO_NEW: '[CHARACTER.GetShortUIName] becomes [TARGET_CHARACTER.GetShortUINamePossessive] vassal',
        BIRTH: 'Born on [DATE.GetStringShort|V]',
        GLOBAL: '[CHARACTER.GetName]',
        ARGS: "[GetPlayer.Custom2_Title( 'a', Title.Self )][Title.GetLeaseInfo]",
        STRINGS: '[Rite.GetName]',
        COMMENTED: '[Rite.GetName]',
        CHAINS: '[Rite.GetName] of [Rite.GetFaith.GetName]',
        SCRIPT_KEY: '[RITE.GetAdjective]',
        SCRIPT_TWO: '[CHARACTER.GetName] and [TARGET_CHARACTER.GetName]'
    };
    // (the game's French texts: only these two; TWO_NEW has none in French)
    const gameFr: Record<string, string> = { OPINION_FR: '[Rite.GetName] est $LEVEL|l$', BIRTH: 'Naissance le [DATE.GetStringShort|V]' };
    const calls = new Set(['Rite.GetName', 'Rite.GetAdherentNamePlural', 'Title.GetHolder', 'Title.GetLeaseInfo']);
    const env: DataCallEnv = {
        tenets: new Set(),
        engineFilled: (k) => engine.has(k),
        gameText: (k, lang) => (lang === 'french' ? gameFr[k] : lang === 'english' ? game[k] : undefined),
        gameCalls: (root, method) => calls.has(`${root}.${method}`)
    };
    const run = (text: string, rel = 'localization/english/x_l_english.yml'): { out: string; r: ReturnType<typeof locCallEdits>; } =>
    {
        const r = locCallEdits(text, group, env, rel);
        return { out: applyCallEdits(text, r.edits), r };
    };

    const a = run('l_english:\n OPINION_X:0 "[FAITH.GetName] is $LEVEL$ (in [FAITH.GetName|U] lands)"\n');
    check(a.out === 'l_english:\n OPINION_X:0 "[Rite.GetName] is $LEVEL$ (in [Rite.GetName|U] lands)"\n' && a.r.contexts?.[0]?.from === 'FAITH' && a.r.contexts[0].to === 'Rite' && !a.r.contexts[0].why, 'an engine-filled key: FAITH is Rite, every root renamed, the wording and the format stay', a.out);

    // (the mod's own wording calls another method: one the game's texts call on the new context somewhere)
    const fr = run('﻿l_french:\n OPINION_FR:0 "Les [FAITH.GetAdherentNamePlural] sont $LEVEL|l$#L s#!"\n', 'localization/replace/french/x_l_french.yml');
    check(fr.out === '﻿l_french:\n OPINION_FR:0 "Les [Rite.GetAdherentNamePlural] sont $LEVEL|l$#L s#!"\n', 'the mod’s own wording in French: renamed when the game’s texts call that method on Rite (the French text of the game decides)', fr.out);
    check(languageOf('﻿# c\nl_french:\n K: "x"\n', 'a.yml') === 'french' && languageOf(' K: "x"\n', 'localization/x_l_simp_chinese.yml') === 'simp_chinese' && languageOf('', 'x.yml') === 'english', 'the language: the header (after a comment), else the file name, else English');

    // (the context became a chain from another one: the calls after it, compared from the end, give the chain)
    const w = run(' WINDOW_TITLE:0 "Convert to [FAITH.GetNameNoTooltip]"\n');
    check(w.out === ' WINDOW_TITLE:0 "Convert to [FaithConversionWindow.GetFaith.GetNameNoTooltip]"\n' && w.r.contexts?.[0]?.to === 'FaithConversionWindow.GetFaith', 'a context reached through a chain in the game’s text: renamed to the chain', w.out);
    check(run(w.out).r.edits.length === 0 && run(a.out).r.edits.length === 0 && run(fr.out, 'localization/replace/french/x_l_french.yml').r.edits.length === 0, 'a second pass changes nothing');

    // (left alone, nothing told: the game's text names no context instead; a key the program does not fill)
    const none = run(' NO_COUNTERPART:0 "[FAITH.GetName] is $LEVEL$"\n SCRIPT_KEY:0 "[FAITH.GetAdjective]"\n');
    check(none.r.edits.length === 0 && !none.r.contexts?.length, 'a key whose game text names no other context, and a key the program does not fill, stay as written (nothing told)');

    // (no safe rename: the game's text of the key in place of the mod's; its `:N` and a comment after it stay)
    const two = run(' TWO_NEW:2 "[Character.GetShortUIName] becomes your vassal" # the mod\'s note\n');
    check(two.out === ' TWO_NEW:2 "[CHARACTER.GetShortUIName] becomes [TARGET_CHARACTER.GetShortUINamePossessive] vassal" # the mod\'s note\n' && two.r.contexts?.[0]?.why !== undefined && two.r.contexts[0].from === 'Character' && two.r.contexts[0].to === 'CHARACTER, TARGET_CHARACTER' && !two.r.contexts[0].english, 'an ambiguous pair (two contexts in the game’s text): the game’s text, the version number and the comment kept, both sides told', `${two.out} ${JSON.stringify(two.r.contexts)}`);
    const birth = run(' BIRTH:0 "Born on [Character.GetBirthDate.GetString|V]"\n');
    check(birth.out === ' BIRTH:0 "Born on [DATE.GetStringShort|V]"\n' && /DATE\.GetBirthDate/.test(birth.r.contexts?.[0]?.why ?? ''), 'a call the game never makes on the new context (DATE.GetBirthDate): the game’s text', `${birth.out} ${JSON.stringify(birth.r.contexts)}`);
    const chains = run(' CHAINS:1 "[FAITH.GetName]"\n');
    check(chains.out === ' CHAINS:1 "[Rite.GetName] of [Rite.GetFaith.GetName]"\n' && !!chains.r.contexts?.[0]?.why, 'the same calls reached in more than one way in the game’s text: the game’s text', chains.out);

    // (the language: the game's text in the file's language, else its English one, told so)
    const birthFr = run('l_french:\n BIRTH:0 "Né le [Character.GetBirthDate.GetString|V]"\n', 'localization/replace/french/x_l_french.yml');
    check(birthFr.out === 'l_french:\n BIRTH:0 "Naissance le [DATE.GetStringShort|V]"\n' && !birthFr.r.contexts?.[0]?.english, 'a French file gets the game’s French text', birthFr.out);
    const twoFr = run('l_french:\n TWO_NEW:0 "[Character.GetShortUIName] devient votre vassal"\n', 'localization/french/x_l_french.yml');
    check(twoFr.out === `l_french:\n TWO_NEW:0 "${game.TWO_NEW}"\n` && twoFr.r.contexts?.[0]?.english === true, 'the game has no French text of the key: its English text, marked so', twoFr.out);

    // (a second pass over what was written: nothing more; the text names the game's contexts now)
    const again = [run(two.out), run(birth.out), run(chains.out), run(birthFr.out, 'localization/replace/french/x_l_french.yml'), run(twoFr.out, 'localization/french/x_l_french.yml')];
    check(again.every((x) => !x.r.edits.length && !x.r.contexts?.length), 'a second pass over the game’s text writes nothing and tells nothing');

    // (the guards on which keys are touched hold: a key the program does not fill keeps its text, however its contexts differ)
    check(run(' SCRIPT_TWO:0 "[Character.GetName] and [Other.GetName]"\n').r.edits.length === 0, 'a key the program does not fill (a script names it) is never replaced');

    const notes = dataCallNotes([], [], [...(two.r.contexts ?? []), ...(a.r.contexts ?? []), ...(w.r.contexts ?? []), ...(twoFr.r.contexts ?? [])]);
    check(notes.length === 2 && notes[0].includes('FAITH → Rite: 1 text (OPINION_X)') && notes[0].includes('FAITH → FaithConversionWindow.GetFaith: 1 text (WINDOW_TITLE)') && notes[1].startsWith('2 texts') && notes[1].includes('the game’s text of the key') && notes[1].includes('TWO_NEW (Character; the game’s: CHARACTER, TARGET_CHARACTER): not one context each way') && notes[1].includes('in English'), 'the notes: per context pair the renamed texts and keys; a line of their own for the keys replaced by the game’s text, with both sides, the reason and the English fallback', notes.join(' | '));

    // (the mod's file keeps the game's current text of the key as a comment (AGOT's `#BIRTH_DATE:0 "Born on [DATE.GetStringShort|V]"`
    // above its own line): the mod's line is deliberate, nothing changes, the notes say so)
    const keptRename = run(' #OPINION_X:0 "[Rite.GetName] is $LEVEL$"\n OPINION_X:0 "[FAITH.GetName] is $LEVEL$"\n');
    check(!keptRename.r.edits.length && keptRename.r.contexts?.length === 1 && keptRename.r.contexts[0].kept === true, 'the game’s current text as a comment in the same file: a rename case stays as the mod wrote it', JSON.stringify(keptRename.r.contexts));
    const keptGame = run('\t# BIRTH:3 "Born on [DATE.GetStringShort|V]"\r\n BIRTH:0 "Born on [Character.GetBirthDate.GetString|V]"\r\n');
    check(!keptGame.r.edits.length && keptGame.r.contexts?.[0]?.kept === true && !keptGame.r.contexts[0].why, 'the same for a key that would get the game’s text (blanks before and after the #, another version number, CRLF)', JSON.stringify(keptGame.r.contexts));
    const keptFr = run('l_french:\n#BIRTH:0 "Naissance le [DATE.GetStringShort|V]"\n BIRTH:0 "Né le [Character.GetBirthDate.GetString|V]"\n', 'localization/french/x_l_french.yml');
    check(!keptFr.r.edits.length && keptFr.r.contexts?.[0]?.kept === true, 'the comment is compared with the game’s text in the file’s language', JSON.stringify(keptFr.r.contexts));
    const oldComment = run(' #OPINION_X:0 "[FAITH.GetName] is $LEVEL$"\n OPINION_X:0 "[FAITH.GetName] is $LEVEL$"\n #BIRTH:0 "Born on [DATE.GetStringShort]"\n BIRTH:0 "Born on [Character.GetBirthDate.GetString|V]"\n');
    check(oldComment.out === ' #OPINION_X:0 "[FAITH.GetName] is $LEVEL$"\n OPINION_X:0 "[Rite.GetName] is $LEVEL$"\n #BIRTH:0 "Born on [DATE.GetStringShort]"\n BIRTH:0 "Born on [DATE.GetStringShort|V]"\n' && !oldComment.r.contexts?.some((c) => c.kept), 'a comment with another text (the older version’s, or not exactly the game’s) does not hold: renamed, the game’s text', oldComment.out);
    check(run(keptGame.out).r.edits.length === 0 && run(keptRename.out).r.contexts?.[0]?.kept === true, 'a second pass: still left, still told');
    const keptNotes = dataCallNotes([], [], [...(keptRename.r.contexts ?? []), ...(keptGame.r.contexts ?? []), ...(a.r.contexts ?? [])]);
    check(keptNotes.length === 2 && keptNotes[0].startsWith('1 text') && keptNotes[1].startsWith('2 texts') && keptNotes[1].includes('keeps the game’s current text as a comment, so its own line is deliberate — OPINION_X, BIRTH'), 'the notes: a line of its own for the keys left as the mod’s choice (not counted as renamed)', keptNotes.join(' | '));

    // (a global function is no context; contexts in arguments; strings, text outside the brackets and comments are not read)
    const glob = run(' GLOBAL:0 "[GetPlayer.GetName]"\n');
    check(glob.r.edits.length === 0 && !glob.r.contexts?.length, 'a global function (GetPlayer) is never a context to rename');
    const args = run(" ARGS:0 \"[GetPlayer.Custom2_Title( 'a', TITLE.Self )][TITLE.GetLeaseInfo] [AGOTName( TITLE.GetHolder )]\"\n");
    check(args.out === " ARGS:0 \"[GetPlayer.Custom2_Title( 'a', Title.Self )][Title.GetLeaseInfo] [AGOTName( Title.GetHolder )]\"\n", 'a context in the arguments of a global or a mod’s own function is renamed too', args.out);
    const strings = run(" STRINGS:0 \"FAITH.GetName [FAITH.GetName] [Foo( 'FAITH.GetName' )]\"\n COMMENTED:0 \"[FAITH.GetName]\" # [FAITH.GetName]\n");
    check(strings.out === " STRINGS:0 \"FAITH.GetName [Rite.GetName] [Foo( 'FAITH.GetName' )]\"\n COMMENTED:0 \"[Rite.GetName]\" # [FAITH.GetName]\n", 'a word outside the brackets, inside a string or in a comment is not renamed', strings.out);
    // (a text that already names both (the mod wrote 1.20's context next to the old one) is not this rule's)
    check(run(' OPINION_X:0 "[FAITH.GetName] [Rite.GetName]"\n').r.edits.length === 0, 'a text naming the new context already: nothing (no context of the game’s is missing)');
}

// (the environment the plan and the run use, on a small game folder: the executable's strings, the game's texts per language with a
// replace folder winning, the calls its texts and interface files make, a key a loaded script names; and fileRules on a mod with a
// replace-folder text)
const dir = mkdtempSync(join(tmpdir(), 'ckp-locctx-'));

try
{
    const gameDir = join(dir, 'install', 'game');
    const put = (root: string, rel: string, text: string): string =>
    {
        const f = join(root, ...rel.split('/'));
        mkdirSync(join(f, '..'), { recursive: true });
        writeFileSync(f, text);
        return f;
    };
    // (the executable: the keys as whole strings among others; one of them is named by the game's script)
    put(join(dir, 'install'), 'binaries/ck3.exe', '\0\0MZ\0OPINION_X\0EDUCATE_X\0\x01ROTATE\0WINDOW_TITLE\0MOD_NAMED\0');
    put(gameDir, 'localization/english/m_l_english.yml', '﻿l_english:\n OPINION_X:0 "old [FAITH.GetName]"\n EDUCATE_X:0 "[RITE.GetAdjective]"\n WINDOW_TITLE:0 "[FaithConversionWindow.GetFaith.GetName]"\n NOT_IN_EXE:0 "[Rite.GetName]"\n MOD_NAMED:0 "[Rite.GetName]"\n');
    put(gameDir, 'localization/english/replace/m_l_english.yml', '﻿l_english:\n OPINION_X:0 "[Rite.GetName] is $LEVEL$"\n');
    put(gameDir, 'localization/french/m_l_french.yml', '﻿l_french:\n OPINION_X:0 "[Rite.GetName] est $LEVEL$"\n');
    put(gameDir, 'gui/w.gui', 'w = { text = "[Rite.GetAdherentNamePlural]" }\n');
    put(gameDir, 'common/scripted_effects/e.txt', 'e = { custom_description = { text = EDUCATE_X subject = scope:x.faith } }\n');

    const named = await loadedNames(layerRoots(gameDir), [], ['OPINION_X', 'EDUCATE_X', 'WINDOW_TITLE']);
    check([...named].join() === 'EDUCATE_X', 'loadedNames: a key a loaded script names is found, the others not', [...named].join());
    const env = dataCallEnv(gameDir, new Set(), named);
    check(env.engineFilled!('OPINION_X') && !env.engineFilled!('EDUCATE_X') && !env.engineFilled!('NOT_IN_EXE') && !dataCallEnv(gameDir, new Set()).engineFilled, 'engine-filled: a string of the executable that no loaded file names (none without the named set)');
    check(env.gameText!('OPINION_X', 'english') === '[Rite.GetName] is $LEVEL$' && env.gameText!('OPINION_X', 'french') === '[Rite.GetName] est $LEVEL$' && env.gameText!('OPINION_X', 'german') === undefined && env.gameText!('NOT_IN_EXE', 'english') === undefined, 'the game’s text per language (a replace folder wins; only the executable’s keys are kept)');
    check(env.gameCalls!('Rite', 'GetAdherentNamePlural') && env.gameCalls!('FaithConversionWindow', 'GetFaith') && !env.gameCalls!('GetFaith', 'GetName'), 'the calls the game’s texts and interface files make on the first segment of a chain');

    const edu = locCallEdits(' EDUCATE_X:0 "I will become [FAITH.GetAdjective]"\n OPINION_X:0 "[FAITH.GetName] is it"\n', group, env, 'localization/english/x_l_english.yml');
    check(applyCallEdits(' EDUCATE_X:0 "I will become [FAITH.GetAdjective]"\n OPINION_X:0 "[FAITH.GetName] is it"\n', edu.edits) === ' EDUCATE_X:0 "I will become [FAITH.GetAdjective]"\n OPINION_X:0 "[Rite.GetName] is it"\n', 'a key a loaded script names (its context is the script’s: EDUCATE_…) stays, the engine’s key is renamed');

    // (fileRules: the mod's replace-folder text and its plain one, each listed by its own path, which the patch mod's copy takes)
    const mod = join(dir, 'mod');
    const files = new Map<string, { file?: string; }>([
        ['localization/replace/english/m_l_english.yml', { file: put(mod, 'localization/replace/english/m_l_english.yml', '﻿l_english:\r\n OPINION_X:0 "[FAITH.GetName] is $LEVEL$"\r\n') }],
        ['localization/french/m_l_french.yml', { file: put(mod, 'localization/french/m_l_french.yml', '﻿l_french:\n OPINION_X:0 "Les [FAITH.GetName] sont $LEVEL$"\n') }],
        ['localization/english/own_l_english.yml', { file: put(mod, 'localization/english/own_l_english.yml', '﻿l_english:\n EDUCATE_X:0 "[FAITH.GetAdjective]"\n') }]
    ]);
    const step: Migration = { from: '1.19', to: '1.20', label: '', changes: [], types: [], section: '', order: [], newFolders: {}, dataCalls: [group] };
    const script: StatementEnv = { sets: { tenets: new Set() }, defined: () => false, roots: [] };
    const rules = fileRules({} as ModInfo, [step], gameDir, files, script, undefined, [], undefined, { namedKeys: named });
    const r = rules.find((x) => x.kind === 'dataCalls');
    check(r?.files.join() === 'localization/replace/english/m_l_english.yml,localization/french/m_l_french.yml', 'the plan lists the replace-folder text by its replace path (the patch mod’s copy of that path answers it), the script-named key’s file not', r?.files.join());
    check(!!r?.notes?.some((n) => n.includes('FAITH → Rite: 2 texts (OPINION_X)')), 'the plan’s note counts the texts per context pair', r?.notes?.join(' | '));
    const crlf = 'l_english:\r\n OPINION_X:0 "[FAITH.GetName] is $LEVEL$"\r\n';
    check(applyCallEdits(crlf, locCallEdits(crlf, group, env, 'localization/replace/english/m_l_english.yml').edits) === 'l_english:\r\n OPINION_X:0 "[Rite.GetName] is $LEVEL$"\r\n', 'a CRLF file keeps its line ends (edits by offset)');
    check(!fileRules({} as ModInfo, [step], gameDir, files, script, undefined, [], undefined, {}).some((x) => x.kind === 'dataCalls'), 'without the loaded files’ names (no world) nothing counts as filled by the program: no rule');

    // (the plan's and the run's pre-pass: the keys the rule would touch, then which of them the loaded files name (the game's script,
    // the mod's own script), read from the mod's texts as the groups before it leave them)
    files.set('localization/english/more_l_english.yml', { file: put(mod, 'localization/english/more_l_english.yml', '﻿l_english:\n MOD_NAMED:0 "[FAITH.GetName]"\n') });
    files.set('common/scripted_effects/own.txt', { file: put(mod, 'common/scripted_effects/own.txt', 'own = { custom_tooltip = MOD_NAMED }\n') });
    const pre = await namedContextKeys({ mod: {} as ModInfo, modFiles: files, gameDir }, [step], script);
    check([...pre].sort().join() === 'EDUCATE_X,MOD_NAMED', 'the pre-pass: of the keys the rule would touch, the ones the game’s script and the mod’s own script name (OPINION_X: none)', [...pre].join());
    const withPre = fileRules({} as ModInfo, [step], gameDir, files, script, undefined, [], undefined, { namedKeys: pre }).find((x) => x.kind === 'dataCalls');
    check(withPre?.files.join() === 'localization/replace/english/m_l_english.yml,localization/french/m_l_french.yml', 'with the pre-pass’s names the key the mod’s script names stays', withPre?.files.join());
    check((await namedContextKeys({ mod: {} as ModInfo, modFiles: files, gameDir }, [{ ...step, dataCalls: MIGRATIONS[0].dataCalls!.filter((g) => !g.contexts) }], script)).size === 0, 'no context group: nothing is read');

    // (the comment counts in the file of the mod's live line only: one in another file of the mod says nothing about this one)
    const split = new Map<string, { file?: string; }>([
        ['localization/english/comment_l_english.yml', { file: put(mod, 'localization/english/comment_l_english.yml', '﻿l_english:\n #OPINION_X:0 "[Rite.GetName] is $LEVEL$"\n') }],
        ['localization/english/live_l_english.yml', { file: put(mod, 'localization/english/live_l_english.yml', '﻿l_english:\n OPINION_X:0 "[FAITH.GetName] is $LEVEL$"\n') }],
        ['localization/english/both_l_english.yml', { file: put(mod, 'localization/english/both_l_english.yml', '﻿l_english:\n #OPINION_X:0 "[Rite.GetName] is $LEVEL$"\n OPINION_X:0 "[FAITH.GetName] is it"\n') }]
    ]);
    const splitPre = await namedContextKeys({ mod: {} as ModInfo, modFiles: split, gameDir }, [step], script);
    const splitRule = fileRules({} as ModInfo, [step], gameDir, split, script, undefined, [], undefined, { namedKeys: splitPre }).find((x) => x.kind === 'dataCalls');
    check(splitRule?.files.join() === 'localization/english/live_l_english.yml,localization/english/both_l_english.yml' && splitRule.notes?.some((n) => n.startsWith('1 text') && n.includes('(OPINION_X)')) && splitRule.notes?.some((n) => n.includes('as a comment') && n.includes('OPINION_X')) && [...splitPre].join() === '', 'a comment in another file does not count: that file’s live line is renamed, the file with both is left and told', `${splitRule?.files.join()} | ${splitRule?.notes?.join(' | ')} | ${[...splitPre].join()}`);
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `${bad} of ${count} checks failed` : `all ${count} checks ok`);
process.exit(bad ? 1 : 0);
