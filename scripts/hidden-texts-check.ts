// The texts rule of "Fix for 1.20…" (hiddenTexts.ts; migrate.ts `textsInput`, `textsEntry`) on a small game folder, mod and patch mod in
// TEMP, no index, no real game: a mod's copy of a game localization file (same path: it replaces the game's file) gets back, in a file
// of the patch mod per language, the game's keys it lacks that no loaded file of the language defines and that something loaded uses:
// a loaded script, interface or root file names it (not a game file the mod hides by its path or a replace_path), a loaded text names
// it ($KEY$, 'KEY'), the program has it as a string, the patch mod's library files or the texts a run is about to write name it, a text
// that comes back names it, NOT_ of a key that is used. A key nothing uses (the mod's own loading tips) stays out and is told; a key the
// copy has stays the mod's; the game's line is written as the game wrote it (version number, a comment after it) with the copy's line
// ends and a byte order mark; a second pass writes nothing; an older run's file that no copy needs any more is stale.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/hidden-texts-check.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { isTextsFile, locLines, textRefs, textsDone, textsFile, textsSummary, textsWork } from '../src/main/mods/hiddenTexts.ts';
import { textsEntry, textsInput } from '../src/main/mods/migrate.ts';
import { MIGRATIONS } from '../src/main/mods/migrations.ts';

let bad = 0;
let count = 0;
const check = (ok: unknown, what: string, detail?: string): void =>
{
    count++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);

    if (!ok)
        bad++;
};

const rule = MIGRATIONS[0].texts?.[0];
check(!!rule && rule.files.join() === 'localization/**/*.yml', 'the 1.20 migration has the texts rule for localization files');

// (the pure parts)
const lines = locLines('﻿l_english:\r\n KEY_A:0 "a [X.Y] $KEY_E$" # note\r\n  KEY_B: "b"\r\n#KEY_C:0 "c"\r\n KEY_A:1 "later"\r\n');
check(lines.get('KEY_A') === 'KEY_A:1 "later"' && lines.get('KEY_B') === 'KEY_B: "b"' && !lines.has('KEY_C') && !lines.has('l_english'), 'the lines of a file: from the key to the end of its line, a later line of a key wins, comments are no keys', JSON.stringify([...lines]));
check([...textRefs(`"[Localize( 'KEY_Q' )] $KEY_E$ $KEY_F|U$ the king's men"`)].sort().join() === 'KEY_E,KEY_F,KEY_Q', 'what a text names: $KEY$ (a format too), a quoted argument; not an apostrophe of the prose');
check(
    textsFile('m_1_20_fixes', 'english') === 'localization/english/m_1_20_fixes_game_texts_l_english.yml' && isTextsFile('localization/french/m_1_20_fixes_game_texts_l_french.yml', 'm_1_20_fixes') && !isTextsFile('localization/english/other_game_texts_l_english.yml', 'm_1_20_fixes'),
    'the file per language and how a run knows its own'
);

const dir = mkdtempSync(join(tmpdir(), 'ckp-texts-'));

try
{
    const install = join(dir, 'install');
    const gameDir = join(install, 'game');
    const put = (root: string, rel: string, text: string): string =>
    {
        const f = join(root, ...rel.split('/'));
        mkdirSync(join(f, '..'), { recursive: true });
        writeFileSync(f, text);
        return f;
    };
    const gameLoc = 'localization/english/gui/inter_l_english.yml';
    put(
        gameDir,
        gameLoc,
        [
            '﻿l_english:',
            ' OLD_KEY:0 "the game\'s old text"',
            ' GUI_KEY:0 "Grant as $NAMED_BY_TEXT$" # 1.20',
            ' SCRIPT_KEY:1 "a reason"',
            ' NAMED_BY_TEXT:0 "[GovernmentType.GetName]"',
            ' LOADED_REF:0 "named by a loaded text"',
            ' EXE_KEY:0 "the program asks for it"',
            ' custom_x:0 "custom"',
            ' NOT_custom_x:0 "not custom"',
            ' LIBRARY_KEY:0 "named by the patch mod\'s library file"',
            ' EXTRA_KEY:0 "named by a text the run writes"',
            ' HIDDEN_ONLY:0 "named only by a game file the mod hides"',
            ' REPLACED_ONLY:0 "named only by a game file in a folder the mod replaces"',
            ' ELSEWHERE:0 "the mod defines it in another file"',
            ' OTHER_MOD:0 "another mod of the list defines it"',
            ' TIP_7:0 "a tip nothing names"',
            ' DELETED:0 "the patch mod\'s copy dropped it"',
            ' TIGHT:0 "the copy has it without a blank before its text"',
            ''
        ].join('\r\n')
    );
    put(gameDir, 'localization/english/other_l_english.yml', '﻿l_english:\n SHOWN:0 "uses $LOADED_REF$"\n');
    put(gameDir, 'localization/french/gui/inter_l_french.yml', '﻿l_french:\n GUI_KEY:0 "Accorder"\n');
    put(gameDir, 'gui/window.gui', 'w = { text = "GUI_KEY" tooltip = "DELETED" name = "TIGHT" }\n');
    put(gameDir, 'common/interactions/hidden.txt', 'x = { desc = HIDDEN_ONLY }\n');
    put(gameDir, 'common/replaced/a.txt', 'x = { desc = REPLACED_ONLY }\n');
    put(gameDir, 'common/interactions/game.txt', 'x = { desc = SCRIPT_KEY custom_description = { text = custom_x } }\n');
    put(gameDir, 'gfx/map/map_object_data/huge.txt', 'x = { desc = TIP_7 }\n');
    put(install, 'binaries/ck3.exe', '\0MZ\0EXE_KEY\0OTHER\0');
    // (the game's loading tips, which the mod copies later with a tip of its own: the game's files are listed once per session)
    const tipsLoc = 'localization/english/load_tips/tips_l_english.yml';
    put(gameDir, tipsLoc, '﻿l_english:\n TIP_0:0 "zero"\n TIP_1:0 "one"\n TIP_2:0 "two"\n');
    // (the game's traits texts, which the mod copies later: a line naming a trait the renamed rule keeps under its old key)
    const traitLoc = 'localization/english/traits/traits_l_english.yml';
    put(gameDir, traitLoc, '﻿l_english:\n TRAIT_LINE:0 "[GetTrait(\'erudite\').GetName( X )], \'eruditely\'"\n TRAIT_LINK:0 "#TOOLTIP:GAME_TRAIT,erudite,X #L erudite#!#!"\n');
    put(gameDir, 'gui/traits.gui', 'w = { text = "TRAIT_LINE" }\nl = { text = "TRAIT_LINK" }\n');

    const modRoot = join(dir, 'mod');
    const modFiles = new Map<string, { file?: string; }>();
    const modPut = (rel: string, text: string): void => void modFiles.set(rel, { file: put(modRoot, rel, text) });
    // (the mod's 1.19 copy: two keys of its own text, CRLF, no byte order mark)
    modPut(gameLoc, 'l_english:\r\n OLD_KEY:0 "the mod\'s own text"\r\n DELETED:0 "kept by the mod"\r\n TIGHT:0"the mod\'s"\r\n');
    modPut('localization/english/own_l_english.yml', '﻿l_english:\n ELSEWHERE:0 "the mod\'s"\n');
    modPut('common/interactions/hidden.txt', 'x = { desc = something_else }\n');
    modPut('descriptor.mod', 'name = "m"\n');
    const mod = { id: 'mod/m.mod', name: 'm', root: modRoot, replacePaths: ['common/replaced'] } as unknown as ModInfo;
    const patchRoot = join(dir, 'patch');
    // (the patch mod: its copy of the mod's file without DELETED, a library file, the descriptor)
    put(patchRoot, gameLoc, 'l_english:\r\n OLD_KEY:0 "the mod\'s own text"\r\n TIGHT:0"the mod\'s"\r\n');
    put(patchRoot, 'common/scripted_modifiers/zz_m_1_20_fixes_library.txt', 'm = { desc = LIBRARY_KEY }\n');
    put(patchRoot, 'descriptor.mod', 'name = "m fixes"\n');
    const other = join(dir, 'other');
    put(other, 'localization/english/o_l_english.yml', '﻿l_english:\n OTHER_MOD:0 "theirs"\n');

    const folder = 'm_1_20_fixes';
    const input = (extra: string[] = []) => textsInput({ mod, modFiles, gameDir, patchRoot, others: [other] }, folder, { replacePaths: [] } as unknown as ModInfo, rule!.files, extra);
    const w = textsWork(input(['m = { desc = EXTRA_KEY }']));
    const x = w.copies.get(gameLoc);
    check(
        x?.keys.join() === 'GUI_KEY,SCRIPT_KEY,NAMED_BY_TEXT,LOADED_REF,EXE_KEY,custom_x,NOT_custom_x,LIBRARY_KEY,EXTRA_KEY,DELETED',
        'what comes back, in the game’s order: named by a gui, a script, a text that comes back, a loaded text, the program, NOT_ of a used key, the patch mod’s library file, a text the run writes; the key the patch mod’s copy dropped',
        x?.keys.join()
    );
    check(x?.unused.join() === 'HIDDEN_ONLY,REPLACED_ONLY,TIP_7', 'what stays out: named only by a game file the mod hides by its path or a replace_path, or by a data folder the scan skips', x?.unused.join());
    check(!x?.keys.includes('OLD_KEY') && !x?.keys.includes('TIGHT') && !x?.keys.includes('ELSEWHERE') && !x?.keys.includes('OTHER_MOD'), 'a key the copy has (also one written without a blank before its text), one the mod defines in another file and one another mod defines do not come');
    const out = w.outputs.get('english');
    check(
        out?.rel === textsFile(folder, 'english') && out.text.startsWith('﻿l_english:\r\n# ' + gameLoc + ': ') && out.text.includes('\r\n GUI_KEY:0 "Grant as $NAMED_BY_TEXT$" # 1.20\r\n SCRIPT_KEY:1 "a reason"\r\n') && !out.text.replace(/\r\n/g, '').includes('\n') && out.text.endsWith('\r\n'),
        'the file: a byte order mark, the header, a comment naming the copy, the game’s lines as it wrote them (version number, comment), the copy’s CRLF throughout',
        JSON.stringify(out?.text)
    );
    check(!w.outputs.has('french') && w.copies.size === 1 && !w.stale.length, 'a language the mod does not copy is the game’s own: nothing for it');
    const noExtra = textsWork(input());
    check(!noExtra.copies.get(gameLoc)?.keys.includes('EXTRA_KEY') && noExtra.copies.get(gameLoc)!.unused.includes('EXTRA_KEY'), 'without the run’s text the key it names stays out');

    // (the plan entry, a written file, a second pass, the summary for the notes)
    const entry = textsEntry(w, rule!.label, patchRoot);
    check(
        entry?.kind === 'texts' && entry.files.join() === gameLoc && entry.todo.join() === gameLoc && !!entry.notes?.some((n) => n.includes('10 keys') && n.includes('GUI_KEY')) && !!entry.notes?.some((n) => n.includes('3 more keys') && n.includes('TIP_7')),
        'the plan: the copy to do, the keys that come back and the ones that stay out told',
        JSON.stringify(entry)
    );
    put(patchRoot, out!.rel, out!.text);
    const again = textsWork(input(['m = { desc = EXTRA_KEY }']));
    check(
        textsDone(patchRoot, again.outputs.get('english')!) && JSON.stringify(textsSummary(again)) === JSON.stringify(textsSummary(w)) && !again.stale.length && textsEntry(again, rule!.label, patchRoot)?.todo.length === 0,
        'a second pass: the file holds what it would write (its own keys do not count as defined), nothing to do'
    );
    check(readFileSync(join(patchRoot, ...out!.rel.split('/')), 'utf8') === out!.text, 'the file on disk is the text');

    // (an older run's file of a language no copy needs: stale; a copy whose keys nothing uses: told, nothing written)
    put(patchRoot, textsFile(folder, 'french'), '﻿l_french:\n');
    const stale = textsWork(input(['m = { desc = EXTRA_KEY }']));
    check(stale.stale.join() === textsFile(folder, 'french') && textsEntry(stale, rule!.label, patchRoot)?.todo.includes(textsFile(folder, 'french')), 'an older run’s file nothing needs is stale (the plan has it to do: the run deletes it)', stale.stale.join());
    rmSync(join(patchRoot, ...textsFile(folder, 'french').split('/')));
    modPut(tipsLoc, '﻿l_english:\n TIP_0:0 "the mod\'s own tip"\n');
    const tips = textsWork(input(['m = { desc = EXTRA_KEY }']));
    check(!tips.copies.has(tipsLoc) && tips.idle.get(tipsLoc)?.join() === 'TIP_1,TIP_2' && textsSummary(tips).some((s) => s.rel === tipsLoc && !s.keys.length && s.unused.length === 2), 'the mod’s own loading tips: the game’s tips it dropped stay out, told', JSON.stringify([...tips.idle]));

    // (with the renamed rule's aliases: a line that comes back names the entry as the loaded world has it, a quoted argument only)
    modPut(traitLoc, '﻿l_english:\n OWN_TRAIT:0 "the mod\'s"\n');
    const aliasIn = textsInput({ mod, modFiles, gameDir, patchRoot, others: [other] }, folder, { replacePaths: [] } as unknown as ModInfo, rule!.files, [], [{ type: 'traits', from: 'erudite', to: 'scholar' }]);
    const withAlias = textsWork(aliasIn).outputs.get('english')?.text ?? '';
    const noAlias = textsWork(input()).outputs.get('english')?.text ?? '';
    check(
        withAlias.includes(` TRAIT_LINE:0 "[GetTrait('scholar').GetName( X )], 'eruditely'"`) && noAlias.includes(` TRAIT_LINE:0 "[GetTrait('erudite').GetName( X )], 'eruditely'"`),
        'a renamed entry kept under its old key: the line that comes back names the old key (GetTrait(\'scholar\')), as the game wrote it without aliases',
        JSON.stringify([withAlias, noAlias])
    );
    // (and its tooltip links of the entry's kind, with the link types the renamed rule found)
    const linkIn = textsInput({ mod, modFiles, gameDir, patchRoot, others: [other] }, folder, { replacePaths: [] } as unknown as ModInfo, rule!.files, [], [{ type: 'traits', from: 'erudite', to: 'scholar', links: ['GAME_TRAIT'] }]);
    const withLinks = textsWork(linkIn).outputs.get('english')?.text ?? '';
    check(
        withLinks.includes(' TRAIT_LINK:0 "#TOOLTIP:GAME_TRAIT,scholar,X #L erudite#!#!"') && withAlias.includes(' TRAIT_LINK:0 "#TOOLTIP:GAME_TRAIT,erudite,X #L erudite#!#!"'),
        'a tooltip link of the kind the alias has link types for names the old key too (the words stay); without the types it stays',
        JSON.stringify([withLinks, withAlias])
    );

    // (a mod with no copy that lacks a key: nothing read, nothing to do)
    const plain = new Map<string, { file?: string; }>([['localization/english/own_l_english.yml', modFiles.get('localization/english/own_l_english.yml')!]]);
    const none = textsWork(textsInput({ mod, modFiles: plain, gameDir, patchRoot: join(dir, 'nopatch') }, folder, undefined, rule!.files, []));
    check(!none.copies.size && !none.outputs.size && !textsEntry(none, rule!.label, undefined), 'a mod without such a copy: no work, no plan entry');
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `${bad} of ${count} checks failed` : `all ${count} checks ok`);
process.exit(bad ? 1 : 0);
