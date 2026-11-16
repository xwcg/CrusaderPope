// Checks editing in place (src/main/mods/scriptEdit.ts, line anchors of src/main/describe) against a TEMP user folder
// with a temp mod: the text operations on small samples, then court.8190 and the traits brave / craven copied into the
// mod with the override code, the mod layered over the vanilla index, and edit / remove / insert run through the
// anchors of the readable view: the files checked byte for byte, parsed, re-indexed and described again. The real
// user folder is never used.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/script-edit-check.ts [keep]
// The vanilla index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew); each
// re-index with the mod is a fresh build on parse threads.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EntityCard, EventStory, Line, LineSource, ModInfo, OnActionStory, ScriptEditRequest, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { applyOverride } from '../src/main/mods/edit.ts';
import { createEntries, createEntry, newEntryPlan } from '../src/main/mods/create.ts';
import { modsState, type ModsHost } from '../src/main/mods/manager.ts';
import { applyEdit, checkEdit, commentNotes, editLoc, editScript, fireEvent, isCodeComment, locate, scriptProblems, statementText, unfireEvent } from '../src/main/mods/scriptEdit.ts';
import { dropJournals, forgetChange, journalOf, undoChange } from '../src/main/mods/undo.ts';
import { stmtCheck, textHash } from '../src/main/indexer/override.ts';
import { mapRange, trailEntry, type Splice, type TrailEntry } from '../src/main/mods/textTrail.ts';
import { commentsOf, formatScript, keepWritten, keepsStatement, replacesStatement } from '../src/shared/scriptFormat.ts';
import { parse } from '../src/main/indexer/parser.ts';
import { rootCtx } from '../src/main/describe/describer.ts';
// (round 13 wave 10: the title triple read back)
import { fillTemplate, findStatement, parseSnippet, printScript } from '../src/shared/scriptCatalog.ts';
import { defaultInstall } from './ck3-install.ts';
import { buildIndex, fastIndex } from './fast-index.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};
const show = (s: string): string => JSON.stringify(s);

// ---------------------------------------------------------------------------
// the text operations on samples
// ---------------------------------------------------------------------------

/** An anchor for [s, e) of a sample (the needle's first occurrence), `inner` from its braces. */
function at(text: string, needle: string, kind: LineSource['kind'] = 'effect'): LineSource
{
    const s = text.indexOf(needle);

    if (s < 0)
        throw new Error('not in sample: ' + needle);

    const e = s + needle.length;
    const a: LineSource = { file: 'x', rel: 'x.txt', line: 1, s, e, kind, hash: '' };
    const open = needle.indexOf('{');

    if (open >= 0 && needle.endsWith('}'))
        a.inner = [s + open + 1, e - 1];

    return a;
}
const edit = (text: string, req: Omit<ScriptEditRequest, 'at'>, needle: string): string => applyEdit(text, { ...req, at: at(text, needle) } as ScriptEditRequest).text;

{
    const tabs = 'ev = {\n\timmediate = {\n\t\t# the gold\n\t\tadd_gold = 10 # much\n\t\tadd_prestige = 5\n\t}\n}\n';
    check(edit(tabs, { op: 'remove' }, 'add_gold = 10') === 'ev = {\n\timmediate = {\n\t\tadd_prestige = 5\n\t}\n}\n', 'remove: its line, the comment after it and the comment line above go');
    check(edit(tabs, { op: 'replace', text: 'add_gold = 20' }, 'add_gold = 10') === tabs.replace('add_gold = 10', 'add_gold = 20'), 'replace a scalar: only its range changes');
    check(
        edit(tabs, { op: 'insert', where: 'inside', text: 'if = {\n\tlimit = { is_adult = yes }\n\tadd_piety = 1\n}' }, 'immediate = {\n\t\t# the gold\n\t\tadd_gold = 10 # much\n\t\tadd_prestige = 5\n\t}') ===
            tabs.replace('\t}\n}', '\t\tif = {\n\t\t\tlimit = { is_adult = yes }\n\t\t\tadd_piety = 1\n\t\t}\n\t}\n}'),
        'insert inside at the end: indented like the children, nested levels kept'
    );
    check(edit(tabs, { op: 'insert', text: 'add_dread = 3' }, 'add_gold = 10') === tabs.replace('# much\n', '# much\n\t\tadd_dread = 3\n'), 'insert after: a line of its own after the statement (and its comment)');
    check(edit(tabs, { op: 'insert', where: 'before', wrap: 'trigger', text: 'is_adult = yes' }, 'add_gold = 10') === tabs.replace('\t\t# the gold', '\t\ttrigger = {\n\t\t\tis_adult = yes\n\t\t}\n\t\t# the gold'), 'insert before, wrapped: before its comment lines');

    const crlf = 'ev = {\r\n    option = {\r\n        name = a\r\n    }\r\n}';
    const r1 = edit(crlf, { op: 'insert', where: 'inside', text: 'add_gold = 5\nadd_piety = 1' }, 'option = {\r\n        name = a\r\n    }');
    check(r1 === 'ev = {\r\n    option = {\r\n        name = a\r\n        add_gold = 5\r\n        add_piety = 1\r\n    }\r\n}', 'CRLF and 4-space indentation kept: ' + show(r1));
    const r2 = edit(crlf, { op: 'insert', text: 'option = {\n\tname = b\n}' }, 'option = {\r\n        name = a\r\n    }');
    check(r2 === 'ev = {\r\n    option = {\r\n        name = a\r\n    }\r\n    option = {\r\n        name = b\r\n    }\r\n}', 'insert after a block: tabs of the new text become the file’s spaces');
    const r3 = edit('a = 1\r\nb = 2', { op: 'remove' }, 'b = 2');
    check(r3 === 'a = 1', 'remove on the last line (no line break after it): the break before goes: ' + show(r3));

    // a list's item becoming a statement of its own (a tenet with its DLC): after the list, the item gone, also a
    // one-line list
    const faith = 'f = {\n\ttenets = {\n\t\ttenet_a\n\t\ttenet_b\n\t}\n\tx = 1\n}\n';
    const pair = 'tenet_selection_pair = {\n\trequires_dlc_flag = d\n\ttenet = tenet_a\n}';
    check(
        edit(faith, { op: 'replace', outside: true, text: pair }, 'tenet_a') === 'f = {\n\ttenets = {\n\t\ttenet_b\n\t}\n\ttenet_selection_pair = {\n\t\trequires_dlc_flag = d\n\t\ttenet = tenet_a\n\t}\n\tx = 1\n}\n',
        'replace outside: the text after the list holding the item, the item removed'
    );
    const r0 = edit('f = {\n\ttenets = { tenet_a tenet_b }\n}\n', { op: 'replace', outside: true, text: pair }, 'tenet_a');
    check(r0 === 'f = {\n\ttenets = { tenet_b }\n\ttenet_selection_pair = {\n\t\trequires_dlc_flag = d\n\t\ttenet = tenet_a\n\t}\n}\n', 'replace outside a one-line list: ' + show(r0));

    const one = 'x = {\n\tlimit = { a = yes }\n\tempty = { }\n}\n';
    check(edit(one, { op: 'insert', where: 'inside', text: 'b = no' }, 'limit = { a = yes }') === one.replace('a = yes }', 'a = yes b = no }'), 'one-liner block: a short statement joins it');
    check(edit(one, { op: 'insert', where: 'inside', text: 'c = 1' }, 'empty = { }') === one.replace('empty = { }', 'empty = {\n\t\tc = 1\n\t}'), 'empty block: opens up');
    check(edit(one, { op: 'remove' }, 'a = yes') === one.replace(' a = yes', ''), 'remove inside a one-liner: the statement and the space before it');
    check(edit('a = 1 b = 2\n', { op: 'remove' }, 'a = 1') === 'b = 2\n', 'remove sharing its line: the space after it goes along');

    const over = '\uFEFF# Mod: overrides\n\n# brave — copied from common/traits/00_traits.txt:3259 (the game)\n\n@c = 1\n\nbrave = {\n\tx = 1\n}\n\n# craven — copied from common/traits/00_traits.txt:3400 (the game)\n\n# a doc comment\ncraven = {\n\ty = 2\n}\n'.slice(1);
    const r4 = applyEdit(over, { op: 'removeDef', at: at(over, 'y = 2') }).text;
    check(r4 === over.slice(0, over.indexOf('\n# craven')), 'removeDef: the definition, its doc comment, its provenance comment and the blank line before go: ' + show(r4.slice(-20)));
    const r5 = applyEdit(over, { op: 'removeDef', at: at(over, 'x = 1') }).text;
    check(r5 === over.replace('brave = {\n\tx = 1\n}\n\n', ''), 'removeDef with a constant between: the provenance stays (not directly above)');

    // commented-out script above a statement is no comment about it: it stays (and so does what is above it)
    const code = 'ev = {\n\timmediate = {\n\t\t# add_gold = 5\n\t\tadd_gold = 10\n\t\t# the old one\n\t\t# }\n\t\tadd_piety = 1\n\t\t# add_prestige = 3\n\t\t# more piety\n\t\tadd_piety = 2\n\t}\n}\n';
    check(edit(code, { op: 'remove' }, 'add_gold = 10') === code.replace('\t\tadd_gold = 10\n', ''), 'remove: commented-out code directly above stays');
    check(edit(code, { op: 'remove' }, 'add_piety = 1') === code.replace('\t\tadd_piety = 1\n', ''), 'remove: a commented-out `}` above stays, and the words above it');
    check(edit(code, { op: 'remove' }, 'add_piety = 2') === code.replace('\t\t# more piety\n\t\tadd_piety = 2\n', ''), 'remove: the words directly above go, the commented-out code above them stays');
    check(
        isCodeComment('# add_gold = 5') && isCodeComment('\t# limit = { is_adult = yes }') && isCodeComment('# }') && isCodeComment('#trigger_event = { id = a.1 days = 5 } # later') && !isCodeComment('# Weight = 50 means often') && !isCodeComment('# 50% chance') && !isCodeComment('# scope:actor = the one who asks') &&
            !isCodeComment('# the gold'),
        'isCodeComment: script vs words'
    );
    check(edit(code, { op: 'insert', where: 'before', text: 'add_dread = 1' }, 'add_piety = 2') === code.replace('\t\t# more piety', '\t\tadd_dread = 1\n\t\t# more piety'), 'insert before: before its words, after commented-out code');

    check(scriptProblems('a = { b = c }').length === 0 && scriptProblems('a = { b = }').length === 1 && scriptProblems('a = { b = c').length === 1 && scriptProblems('a = b }').length === 1 && scriptProblems('x = "abc').length === 1, 'scriptProblems: missing value, unclosed brace, stray brace, open quote');

    // if / else: an edit may not leave an else without its if; "add after" an if goes after its else
    const chain = 'ev = {\n\toption = {\n\t\tif = {\n\t\t\tlimit = { is_adult = yes }\n\t\t\tadd_gold = 5\n\t\t}\n\t\telse = {\n\t\t\tadd_gold = 1\n\t\t}\n\t}\n}\n';
    const ifText = 'if = {\n\t\t\tlimit = { is_adult = yes }\n\t\t\tadd_gold = 5\n\t\t}';
    const refused = (req: Omit<ScriptEditRequest, 'at'>, needle: string): boolean =>
    {
        const r = { ...req, at: at(chain, needle) } as ScriptEditRequest;

        try
        {
            checkEdit(chain, r, applyEdit(chain, r));
            return false;
        }
        catch (e)
        {
            return /else/.test((e as Error).message);
        }
    };
    check(refused({ op: 'remove' }, ifText), 'if / else: removing the if (its else would be alone) is refused');
    check(refused({ op: 'replace', text: 'add_gold = 5' }, ifText), 'if / else: the if replaced by its content (“Always”) is refused');
    check(refused({ op: 'replace', text: 'random = {\n\tchance = 50\n\tif = { limit = { is_adult = yes } add_gold = 5 }\n}' }, ifText), 'if / else: the if wrapped alone (Chance…) is refused');
    check(refused({ op: 'replace', text: 'if = { limit = { is_adult = yes } add_gold = 5 }\nelse = { add_gold = 2 }' }, ifText), 'if / else: a second else is refused');
    check(!refused({ op: 'replace', text: 'if = { limit = { is_adult = yes } add_gold = 5 }\nelse_if = { limit = { is_male = yes } add_gold = 2 }' }, ifText), 'if / else: an else_if between them is fine');
    const added = edit(chain, { op: 'insert', text: 'add_gold = 3' }, ifText);
    check(added === chain.replace('\t\t\tadd_gold = 1\n\t\t}\n', '\t\t\tadd_gold = 1\n\t\t}\n\t\tadd_gold = 3\n'), 'if / else: added after the if, it goes after its else: ' + show(added));

    // a statement found again after other parts of the file changed (LineSource.stmt)
    const opt = (n: string, extra = ''): string => `\toption = {\n\t\tname = ${n}\n\t\tadd_gold = 100${extra}\n\t}\n`;
    const three = 'ev = {\n' + opt('a') + opt('b') + opt('c') + '}\n';
    /** an anchor of the nth occurrence of a needle, as the index makes it (file checksum, statement checks) */
    const anchor = (text: string, needle: string, nth = 0, inner?: boolean): LineSource =>
    {
        let s = -1;

        for (let i = 0; i <= nth; i++)
            s = text.indexOf(needle, s + 1);

        const e = s + needle.length;
        return { file: 'x', rel: 'x.txt', line: text.slice(0, s).split('\n').length, s, e, kind: 'effect', hash: textHash(text), stmt: stmtCheck(text, s, e), ...(inner ? { inner: [text.indexOf('{', s) + 1, e - 1] as [number, number] } : {}) };
    };
    const found = (text: string, a: LineSource): string =>
    {
        try
        {
            const l = locate(text, a);
            return `${text.slice(l.s - 11, l.s)}|${text.slice(l.s, l.e)}|${l.line}`;
        }
        catch (e)
        {
            return 'refused: ' + (e as Error).message;
        }
    };
    const goldB = anchor(three, 'add_gold = 100', 1);
    check(found('ev = {\n' + opt('b') + opt('c') + '}\n', goldB) === 'name = b\n\t\t|add_gold = 100|4', 'located: option a removed above, so option b’s add_gold, not c’s now at its old place: ' + found('ev = {\n' + opt('b') + opt('c') + '}\n', goldB));
    check(found(three.replace('name = c', 'name = c\n\t\tadd_piety = 5'), goldB) === `name = b\n\t\t|add_gold = 100|${goldB.line}`, 'located: a change below it, at its place');
    check(found('ev = {\n' + opt('a') + '\toption = {\n\t\tname = b\n\t\tadd_gold   =   100\n\t}\n' + opt('c') + '}\n', goldB).includes('|add_gold   =   100|'), 're-spaced (whitespace only): found');
    check(found(three.replace(opt('b'), opt('b').replace('100', '200')), goldB).startsWith('refused: x.txt: the statement at line 8 changed since'), 'the statement itself changed: refused');
    const five = 'ev = {\n' + opt('b').repeat(5) + '}\n';
    check(found('ev = {\n\tx = 1\n' + five.slice(7), anchor(five, 'add_gold = 100', 1)).startsWith('refused'), 'two the same, the same around them, neither at its place: refused');
    check(found('ev = {\n' + opt('b') + opt('b') + opt('c') + '}\n', goldB).includes('name = b\n\t\t|add_gold = 100|8'), 'two the same: the one with the same text after it');
    const optB = anchor(three, opt('b').trim(), 0, true);
    const moved = locate('ev = {\n' + opt('b') + opt('c') + '}\n', optB);
    check(moved.s === 8 && moved.inner![0] === moved.s + 10 && moved.inner![1] === moved.e - 1, 'a block found again: its inner offsets follow');
    check(found(three.replace('name = c', 'name = d'), anchor(three, 'add_gold = 100', 2)) === 'name = d\n\t\t|add_gold = 100|12', 'the text before it changed, the one after not: still found (the only one that fits)');

    // an anchor over several statements (a title change: create, change, resolve read as one line) found again after
    // another editor added a line above it: the run of the three, not a single statement
    const tripleText = 'ev = {\n\timmediate = {\n\t\tcreate_title_and_vassal_change = { type = granted save_scope_as = change }\n\t\ttitle:c_x = { change_title_holder = { holder = scope:y change = scope:change } }\n\t\tresolve_title_and_vassal_change = scope:change\n\t}\n}\n';
    const tripleRun = tripleText.slice(tripleText.indexOf('create_title'), tripleText.indexOf('resolve_title_and_vassal_change = scope:change') + 'resolve_title_and_vassal_change = scope:change'.length);
    const tripleMoved = found(tripleText.replace('\timmediate = {\n', '\timmediate = {\n\t\tadd_gold = 1\n'), anchor(tripleText, tripleRun));
    check(tripleMoved.includes('|create_title_and_vassal_change') && tripleMoved.includes('resolve_title_and_vassal_change = scope:change|') && tripleMoved.endsWith('|4'), 'a three-statement anchor found again after a line was added above it: ' + tripleMoved);

    // the app's own writes since the anchor (textTrail.ts): mapped through them; `mapRange` alone where it must not map
    const traced = (text: string, a: LineSource, trail: TrailEntry[]): LineSource | string =>
    {
        try
        {
            return locate(text, a, parse(text), trail);
        }
        catch (e)
        {
            return 'refused: ' + (e as Error).message;
        }
    };
    const span = (text: string, l: LineSource | string): string => (typeof l === 'string' ? l : text.slice(l.s, l.e));
    const braces = (text: string, l: LineSource | string): boolean => typeof l !== 'string' && !!l.inner && text[l.inner[0] - 1] === '{' && text[l.inner[1]] === '}' && l.inner[1] === l.e - 1;
    const entry = (before: string, out: { text: string; span?: Splice; }, written = out.text): TrailEntry => trailEntry(before, out.text, written, out.span)!;
    const two = 'ev = {\n' + opt('a') + opt('b') + '}\n';
    const blockB = anchor(two, opt('b').trim(), 0, true);
    const grown = applyEdit(two, { op: 'insert', where: 'inside', at: blockB, text: 'add_piety = 5' });
    const tGrown = entry(two, grown);
    const lb = traced(grown.text, blockB, [tGrown]);
    check(grown.span && span(grown.text, lb) === opt('b', '\n\t\tadd_piety = 5').trim() && braces(grown.text, lb) && (lb as LineSource).line === 6,'trail: a block that got a line is found, its new end and braces: ' + show(span(grown.text, lb)));
    check(found(grown.text, blockB).startsWith('refused'), 'trail: the same without the trail is refused (its own text changed)');
    const evAll = anchor(two, two.trim(), 0, true);
    const le = traced(grown.text, evAll, [tGrown]);
    check(span(grown.text, le) === grown.text.trim() && braces(grown.text, le), 'trail: the enclosing definition (a line added two levels down): found, its new end');
    const goldA = anchor(two, 'add_gold = 100');
    const la = traced(grown.text, goldA, [tGrown]);
    check(typeof la !== 'string' && la.s === goldA.s && la.e === goldA.e, 'trail: a statement before the change: at its offsets');
    // (twins: the same text and the same 32 characters around them, an edit above them)
    const twelve = 'ev = {\n' + opt('b').repeat(12) + '}\n';
    const twin = anchor(twelve, opt('b').trim(), 5, true);
    const twinGold = anchor(twelve, 'add_gold = 100', 6);
    const above = applyEdit(twelve, { op: 'insert', where: 'before', at: anchor(twelve, opt('b').trim(), 0, true), text: 'add_prestige = 1' });
    const shift = above.text.length - twelve.length;
    check(found(above.text, twin).startsWith('refused') && found(above.text, twinGold).startsWith('refused'), 'trail: twins, an edit above them: refused without the trail (neither at its place)');
    const lt = traced(above.text, twin, [entry(twelve, above)]);
    const ltg = traced(above.text, twinGold, [entry(twelve, above)]);
    check(typeof lt !== 'string' && lt.s === twin.s + shift && lt.e === twin.e + shift && braces(above.text, lt) && typeof ltg !== 'string' && ltg.s === twinGold.s + shift, `trail: twins, an edit above them: the sixth block and the seventh add_gold, by their mapped offsets (+${shift})`);
    // (an insertion right at the statement's end: it stays; the block around it grew)
    const lim = 'x = {\n\tlimit = { a = yes }\n}\n';
    const aYes = anchor(lim, 'a = yes');
    const limit = anchor(lim, 'limit = { a = yes }', 0, true);
    const joined = applyEdit(lim, { op: 'insert', at: aYes, text: 'b = yes' });
    const tJoined = entry(lim, joined);
    const ly = traced(joined.text, aYes, [tJoined]);
    const ll = traced(joined.text, limit, [tJoined]);
    check(joined.text === 'x = {\n\tlimit = { a = yes b = yes }\n}\n' && tJoined.p === aYes.e && typeof ly !== 'string' && ly.s === aYes.s && ly.e === aYes.e && span(joined.text, ll) === 'limit = { a = yes b = yes }' && braces(joined.text, ll), 'trail: an insertion at the end boundary: the statement stays, its block grew');
    // (the same write without its range: taken from the texts, it may start inside `a = yes` (the inserted text
    // repeats what is next to it), so that statement is not mapped: found by its own text instead)
    const tGuess = trailEntry(lim, joined.text, joined.text)!;
    const fell = traced(joined.text, aYes, [tGuess]);
    check(tGuess.p < aYes.e && !mapRange([tGuess], aYes.hash, textHash(joined.text), aYes.s, aYes.e) && typeof fell !== 'string' && fell.s === aYes.s && span(joined.text, traced(joined.text, limit, [tGuess])) === 'limit = { a = yes b = yes }', `trail: a partial overlap (the change guessed at [${tGuess.p}, ${tGuess.oldEnd})) is not mapped, it falls back (found by its own text); the block around it is mapped`);
    // (a text the trail does not lead to: a write it did not see; refused as before)
    const other = grown.text.replace('add_piety = 5', 'add_piety = 6');
    check(!mapRange([tGrown], blockB.hash, textHash(other), blockB.s, blockB.e) && span(other, traced(other, blockB, [tGrown])).startsWith('refused'), 'trail: a text it does not know (changed outside the app since): refused');
    // (a replaced statement's old anchor: refused, a block's as a scalar's; the block around it follows)
    const replaced = applyEdit(two, { op: 'replace', at: blockB, text: 'option = {\n\tname = b\n\tadd_gold = 100\n\tadd_piety = 5\n}' });
    const tRep = entry(two, replaced);
    check(span(replaced.text, traced(replaced.text, blockB, [tRep])).startsWith('refused: x.txt: the statement at line') && span(replaced.text, traced(replaced.text, evAll, [tRep])) === replaced.text.trim(), 'trail: a replaced block’s old anchor is refused (even with the same key and a line more); the event around it is found');
    const gold200 = applyEdit(two, { op: 'replace', at: anchor(two, 'add_gold = 100', 1), text: 'add_gold = 200' });
    const goldB2 = anchor(two, 'add_gold = 100', 1);
    const m200 = mapRange([entry(two, gold200)], goldB2.hash, textHash(gold200.text), goldB2.s, goldB2.e);
    check(span(gold200.text, traced(gold200.text, goldB2, [entry(two, gold200)])).startsWith('refused') && typeof m200 === 'object' && m200.within && gold200.text.slice(m200.s, m200.e) === 'add_gold = 200', 'trail: a replaced scalar’s old anchor is refused (looked for in the replaced range only: its text is not there)');
    check(found(gold200.text, goldB2) === 'name = a\n\t\t|add_gold = 100|4','trail: (without the trail its own text takes it for option a’s add_gold: why the replaced range is the only place looked in): ' + show(found(gold200.text, goldB2)));
    // (a statement inside the replaced range: the same statement there, found by its own text in that range only)
    const goldInB = traced(replaced.text, goldB2, [tRep]);
    check(typeof goldInB !== 'string' && goldInB.s === replaced.text.indexOf('add_gold = 100', replaced.text.indexOf('name = b')) && span(replaced.text, goldInB) === 'add_gold = 100', 'trail: a statement inside a replaced block (the block got a line): found in it, option b’s add_gold');
    const saved = applyEdit(two, { op: 'replace', at: evAll, text: two.trim().replace('name = b', 'name = c') });
    const tSaved = entry(two, saved);
    const sa = traced(saved.text, goldA, [tSaved]);
    const sb = traced(saved.text, goldB2, [tSaved]);
    check(saved.span && tSaved.exact && typeof sa !== 'string' && sa.s === saved.text.indexOf('add_gold = 100') && typeof sb !== 'string' && sb.s === saved.text.indexOf('add_gold = 100', saved.text.indexOf('name = c')), 'trail: a definition saved whole with one line changed: the statements inside it are found (option a’s add_gold, and option b’s by the text after it)');
    const wrapped = applyEdit(two, { op: 'replace', at: goldA, text: 'if = {\n\tlimit = { always = yes }\n\tadd_gold = 100\n}' });
    const tWrap = entry(two, wrapped);
    const lw = traced(wrapped.text, goldA, [tWrap]);
    const wrapAt = wrapped.text.indexOf('if = {');
    check(wrapped.span && tWrap.exact && typeof lw !== 'string' && lw.s === wrapped.text.indexOf('add_gold = 100', wrapAt) && lw.s < wrapped.text.indexOf('name = b') && span(wrapped.text, lw) === 'add_gold = 100', 'trail: a statement wrapped in a block (replaced by if = { limit = { } it }): found inside the if, not option b’s twin');
    check(found(wrapped.text, goldA).startsWith('refused'), 'trail: (the wrapped one without the trail: refused, it and option b’s twin equally good)');
    const unwrapped = applyEdit(two, { op: 'replace', at: goldA, text: 'if = {\n\tlimit = { always = yes }\n\tadd_gold = 200\n}' });
    check(span(unwrapped.text, traced(unwrapped.text, goldA, [entry(two, unwrapped)])).startsWith('refused'), 'trail: wrapped and changed (add_gold = 200 inside the if): refused, option b’s twin outside the if not taken');
    // (✕ through a grown block's mapped anchor: the block goes with its new line, as removing it before the write)
    const rmGrown = { op: 'remove' as const, at: lb as LineSource };
    const rmOut = applyEdit(grown.text, rmGrown);
    checkEdit(grown.text, rmGrown, rmOut);
    check(typeof lb !== 'string' && rmOut.text === applyEdit(two, { op: 'remove', at: blockB }).text && !rmOut.text.includes('add_piety') && !rmOut.text.includes('name = b'), 'trail: removing the grown block through its mapped anchor: option b goes with its new line: ' + show(rmOut.text));
    // (an undo restore, a new write from that text, a redo restore (none of them recorded): the first write's chain
    // still leads to the file)
    const t1 = grown.text;
    const t2 = applyEdit(two, { op: 'insert', where: 'inside', at: anchor(two, opt('a').trim(), 0, true), text: 'add_dread = 1' });
    const redo = [tGrown, entry(two, t2)];
    const lr = traced(t1, blockB, redo);
    check(typeof lr !== 'string' && span(t1, lr) === opt('b', '\n\t\tadd_piety = 5').trim() && braces(t1, lr), 'trail: undo, another write, redo (restores not recorded): the anchor of the first text is mapped through the older write that leads to the file');
    const removed = applyEdit(two, { op: 'remove', at: anchor(two, 'add_gold = 100', 1) });
    check(span(removed.text, traced(removed.text, anchor(two, 'add_gold = 100', 1), [entry(two, removed)])).startsWith('refused'), 'trail: a removed statement’s old anchor is refused');
    // (two writes in a row: an anchor of the first text, and one of the text between them)
    const next = applyEdit(grown.text, { op: 'insert', where: 'inside', at: anchor(grown.text, opt('a').trim(), 0, true), text: 'add_dread = 1' });
    const writes = [tGrown, entry(grown.text, next)];
    const lb2 = traced(next.text, blockB, writes);
    const la2 = traced(next.text, anchor(grown.text, opt('a').trim(), 0, true), writes);
    check(span(next.text, lb2) === opt('b', '\n\t\tadd_piety = 5').trim() && braces(next.text, lb2) && span(next.text, la2) === opt('a', '\n\t\tadd_dread = 1').trim() && braces(next.text, la2), 'trail: two writes: option b (grown by the first, shifted by the second) and option a (an anchor of the text between them, grown by the second)');
    // (a first write to a file that was not formatted: the edit's range, then the re-spacing of the whole file)
    const rough = 'ev={\n' + 'option={ name=b add_gold=100 }\n'.repeat(12) + '}\n';
    const roughFirst = anchor(rough, 'option={ name=b add_gold=100 }', 0, true);
    const roughTwin = anchor(rough, 'option={ name=b add_gold=100 }', 5, true);
    const roughGold = anchor(rough, 'add_gold=100', 7);
    const roughEdit = applyEdit(rough, { op: 'insert', where: 'inside', at: roughFirst, text: 'add_piety = 5' });
    const pretty = formatScript(roughEdit.text);
    const tRough = entry(rough, roughEdit, pretty);
    const nth = (text: string, needle: string, n: number): number =>
    {
        let i = -1;

        for (let k = 0; k <= n; k++)
            i = text.indexOf(needle, i + 1);

        return i;
    };
    const f0 = traced(pretty, roughFirst, [tRough]);
    const f5 = traced(pretty, roughTwin, [tRough]);
    const g7 = traced(pretty, roughGold, [tRough]);
    const at5 = nth(pretty, 'option = {', 5);
    check(pretty !== roughEdit.text && tRough.fmt && tRough.fmt.at.length > 12, `trail: formatting re-spaced the file (${tRough.fmt?.at.length} runs moved)`);
    check(typeof f0 !== 'string' && f0.s === pretty.indexOf('option = {') && span(pretty, f0).includes('add_piety = 5') && f0.e === pretty.indexOf('}', f0.s) + 1 && braces(pretty, f0), 'trail, formatted: the block that got a line is found, its new end and braces: ' + show(span(pretty, f0)));
    check(typeof f5 !== 'string' && f5.s === at5 && f5.e === pretty.indexOf('}', at5) + 1 && braces(pretty, f5) && typeof g7 !== 'string' && g7.s === nth(pretty, 'add_gold = 100', 7) && span(pretty, g7) === 'add_gold = 100', 'trail, formatted: the sixth of the twin blocks and the eighth add_gold, re-spaced: found at their places');
    check(found(pretty, roughTwin).startsWith('refused'), 'trail, formatted: the twin without the trail: refused');
    // (a wrap in a first write to an unformatted file: the replaced range followed through the re-spacing)
    const roughTwo = 'ev={\n' + 'option={ name=b add_gold=100 }\n'.repeat(2) + '}\n';
    const roughA = anchor(roughTwo, 'add_gold=100', 0);
    const roughWrap = applyEdit(roughTwo, { op: 'replace', at: roughA, text: 'if={ limit={ always=yes } add_gold=100 }' });
    const prettyWrap = formatScript(roughWrap.text);
    const tRw = entry(roughTwo, roughWrap, prettyWrap);
    const mw = mapRange([tRw], roughA.hash, textHash(prettyWrap), roughA.s, roughA.e);
    const lrw = traced(prettyWrap, roughA, [tRw]);
    const ifAt = prettyWrap.indexOf('if = {');
    check(prettyWrap !== roughWrap.text && tRw.fmt && typeof mw === 'object' && mw.within && mw.s <= ifAt && mw.e >= prettyWrap.indexOf('}', prettyWrap.indexOf('add_gold', ifAt)) + 1 && typeof lrw !== 'string' && lrw.s === prettyWrap.indexOf('add_gold = 100', ifAt) && lrw.s < nth(prettyWrap, 'option = {', 1), 'trail, formatted: a wrapped statement (the replaced range through the re-spacing): found inside the if: ' + show(typeof mw === 'object' ? prettyWrap.slice(mw.s, mw.e) : String(mw)));
}

// "Change to…" puts another statement in place of the edited one (ScriptEditRequest.withComments): the comment lines
// directly above the old one and its comment after it go along; the same statement changed keeps them
{
    const src = 'ev = {\n\timmediate = {\n\t\t# the gold\n\t\t# a second line\n\t\tadd_gold = 10 # much\n\t\tadd_prestige = 5 # keep\n\t}\n}\n';
    const swap = (text: string, needle: string, body: string, withComments = true): string => applyEdit(text, { op: 'replace', at: at(text, needle), text: body, ...(withComments ? { withComments } : {}) }).text;
    const swapped = swap(src, 'add_gold = 10', 'add_piety = 3');
    check(swapped === 'ev = {\n\timmediate = {\n\t\tadd_piety = 3\n\t\tadd_prestige = 5 # keep\n\t}\n}\n', 'replace withComments: the old statement’s two comment lines and its comment go, the next statement’s comment stays: ' + show(swapped));
    check(swap(src, 'add_gold = 10', 'add_gold = 20', false) === src.replace('add_gold = 10', 'add_gold = 20'), 'replace without withComments: only the statement, its comments stay');
    check(commentNotes(src, swapped).join('|').includes('3 comments went') && /# the gold/.test(commentNotes(src, swapped)[0]), 'the change bar names the three comments: ' + show(commentNotes(src, swapped).join('|')));
    const crlf = src.replace(/\n/g, '\r\n');
    check(swap(crlf, 'add_gold = 10', 'add_piety = 3') === swapped.replace(/\n/g, '\r\n'), 'CRLF: the same, the line ends kept');
    const code = 'ev = {\n\timmediate = {\n\t\t# add_gold = 1\n\t\t# about it\n\t\tadd_gold = 10\n\t}\n}\n';
    check(swap(code, 'add_gold = 10', 'add_piety = 3') === 'ev = {\n\timmediate = {\n\t\t# add_gold = 1\n\t\tadd_piety = 3\n\t}\n}\n', 'a commented-out statement above stays (only the comment lines directly under it describe the statement)');
    const apart = 'ev = {\n\timmediate = {\n\t\t# far away\n\n\t\tadd_gold = 10\n\t}\n}\n';
    check(swap(apart, 'add_gold = 10', 'add_piety = 3') === apart.replace('add_gold = 10', 'add_piety = 3'), 'a comment with a blank line between stays');
    const shared = 'ev = {\n\timmediate = { add_gold = 10 add_prestige = 5 } # both\n}\n';
    check(swap(shared, 'add_gold = 10', 'add_piety = 3') === shared.replace('add_gold = 10', 'add_piety = 3'), 'a statement sharing its line: only the statement is replaced, the line’s comment stays');
    const block = 'ev = {\n\timmediate = {\n\t\t# the block\n\t\tif = {\n\t\t\tlimit = { is_adult = yes }\n\t\t\tadd_gold = 10\n\t\t} # end\n\t}\n}\n';
    check(swap(block, 'if = {\n\t\t\tlimit = { is_adult = yes }\n\t\t\tadd_gold = 10\n\t\t}', 'add_piety = 3\nadd_dread = 1') === 'ev = {\n\timmediate = {\n\t\tadd_piety = 3\n\t\tadd_dread = 1\n\t}\n}\n', 'a block of several lines replaced by two statements: its comments above and after it go, indentation kept');
    const first = '# top\nadd_gold = 10\n';
    check(swap(first, 'add_gold = 10', 'add_piety = 3') === 'add_piety = 3\n', 'at the file’s start: the comment above goes');
    const last = 'a = {\n\tadd_gold = 10 # end';
    check(swap(last, 'add_gold = 10', 'add_piety = 3') === 'a = {\n\tadd_piety = 3', 'the last line of a text with no line break: the statement and its comment replaced');

    // which Change takes the old statement's comments (replacesStatement): only another statement in its place; the same one changed,
    // wrapped (When…, Chance…, NOT, hidden effect, an iterator) or unwrapped keeps them, whatever its first key now is
    const rep = (before: string, after: string): boolean => replacesStatement(before, after);
    check(rep('add_gold = 10', 'add_piety = 3') && rep('add_gold = 10', 'add_piety = 3\nadd_dread = 1') && rep('every_child = {\n\tadd_gold = 1\n}', 'every_vassal = {\n\tadd_gold = 1\n}'), 'replacesStatement: another statement (also two, and another iterator) replaces the old one: its comments go');
    check(!rep('add_gold = 10', 'add_gold = 20') && !rep('has_trait = x', 'has_trait = y') && !rep('if = {\n\tlimit = { a = b }\n\tadd_gold = 10\n}', 'if = {\n\tlimit = { a = c }\n\tadd_gold = 10\n}'), 'replacesStatement: the same statement with other values keeps its comments');
    check(!rep('add_gold = 10', 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 10\n}') && !rep('add_gold = 10', 'random = {\n\tchance = 50\n\tadd_gold = 10\n}') && !rep('add_gold = 10', 'hidden_effect = {\n\tadd_gold = 10\n}') && !rep('add_gold = 10', 'every_child = {\n\tadd_gold = 10\n}'), 'replacesStatement: the statement wrapped (When…, Chance…, hidden effect, an iterator) is still there: its comments stay');
    check(!rep('has_trait = x', 'NOT = { has_trait = x }') && !rep('NOT = { has_trait = x }', 'has_trait = x') && !rep('if = {\n\tlimit = { a = b }\n\tadd_gold = 10\n}', 'add_gold = 10'), 'replacesStatement: a NOT wrapped / unwrapped, an if taken off: the statement is still there');
    check(keepsStatement('add_gold = 10 # c', 'x = {\n\t# d\n\tadd_gold = 10\n}') && !keepsStatement('add_gold = 10', 'add_gold = 100') && !keepsStatement('add_gold = 10', 'add_gold = {\n\tvalue = 10\n}') && !keepsStatement('a = {', 'b'), 'keepsStatement: tokens run on unbroken, comments aside; 10 is not 100; unparsable text is false');
    // (the wrap is written over the statement only: the comments above it and after it stay, in the file)
    {
        const src = 'ev = {\n\timmediate = {\n\t\t# pay the court\n\t\tadd_gold = 10 # much\n\t}\n}\n';
        const wrap = 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 10\n}';
        const out = applyEdit(src, { op: 'replace', at: at(src, 'add_gold = 10'), text: wrap, ...(rep('add_gold = 10', wrap) ? { withComments: true } : {}) }).text;
        check(out.includes('# pay the court\n\t\tif = {') && out.includes('# much') && commentsOf(out).length === 2, 'When… wrap through the Change path: both comments stay: ' + show(out));
    }
}

// ---------------------------------------------------------------------------
// the real flow: a temp mod over the vanilla index (SAMPLES=1: only the samples above)
// ---------------------------------------------------------------------------

if (process.env.SAMPLES)
    process.exit(failures ? 1 : 0);

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const tmp = mkdtempSync(join(tmpdir(), 'ckp-inplace-'));
const root = join(tmp, 'mod', 'edit_test');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Edit Test"\nsupported_version="1.19.*"\n');
writeFileSync(join(tmp, 'mod', 'edit_test.mod'), `version="1.0"\nname="Edit Test"\nsupported_version="1.19.*"\npath="${root.replace(/\\/g, '/')}"\n`);

console.log('building the vanilla index …');
const vanilla = await fastIndex(new GameFiles(gameDir), { cache: true });

// (the readable view reads an iterator's count with every operator; the picker's "How many of them…" writes them)
{
    const d = new StoryBuilder(vanilla).d;
    const read = (s: string): string => d.triggers(parse(s), rootCtx(s))[0]?.text.map((x) => (typeof x === 'string' ? x : x.text)).join('') ?? '';
    const cases: [string, string][] = [
        ['any_child = { count > 0 }', 'Any child exists'],
        ['any_child = { count >= 1 }', 'Any child exists'],
        ['any_child = { count != 0 }', 'Any child exists'],
        ['any_child = { count = 0 }', 'No child exists'],
        ['any_child = { count < 1 }', 'No child exists'],
        ['any_child = { count >= 3 }', 'At least 3 children exist'],
        ['any_child = { count > 2 }', 'More than 2 children exist'],
        ['any_child = { count <= 2 }', 'At most 2 children exist'],
        ['any_child = { count = all is_adult = yes }', 'Every child where:'],
        ['NOT = { any_child = { count >= 2 } }', 'Fewer than 2 children exist']
    ];

    for (const [s, want] of cases)
        check(read(s) === want, `count read: ${s} → ${show(read(s))}`);
}
const settings: Settings = { gameDir: install, language: 'english', userDir: tmp, activeMod: 'mod/edit_test.mod' };
let refreshed: string[] = [];
let idx: GameIndex = vanilla;
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    gameDir: () => gameDir,
    documents: () => join(tmp, 'no-documents'),
    reindex: () => undefined,
    query: async <T>(method: string, ...params: unknown[]): Promise<T> => (idx as unknown as Record<string, (...a: unknown[]) => T>)[method](...params),
    wrote: () => undefined,
    // (an empty list is no refresh: makeEntries skips it, and main's queueRefresh([]) resolves it at once when nothing is queued
    // (11422c9); this guard fails here if a caller starts sending one again)
    refreshFiles: async (files) =>
    {
        if (!files.length)
            throw new Error('refreshFiles([]): makeEntries skips an empty refresh');

        refreshed.push(...files);
    },
    // (the undo steps are kept there (undo.ts); dropJournals() reads them again, as after a restart)
    dataDir: () => join(tmp, 'data')
};

const flat = (lines: Line[], out: Line[] = []): Line[] =>
{
    for (const l of lines)
    {
        out.push(l);
        flat(l.conditions ?? [], out);
        flat(l.children ?? [], out);
    }

    return out;
};
const txt = (l: Line): string => l.text.map((s) => (typeof s === 'string' ? s : s.text)).join('');
const storyLines = (ev: EventStory): Line[] => flat([...ev.conditions, ...ev.immediate, ...ev.options.flatMap((o) => [...o.conditions, ...o.effects]), ...ev.after]);
const storyTexts = (ev: EventStory): string[] => [
    ...flat(ev.conditions).map((l) => 'C ' + txt(l)),
    ...flat(ev.immediate).map((l) => 'I ' + txt(l)),
    ...ev.options.flatMap((o, i) => [...flat(o.conditions), ...flat(o.effects)].map((l) => `O${i} ` + txt(l))),
    ...flat(ev.after).map((l) => 'A ' + txt(l))
];

let mod: ModInfo;
let sb: StoryBuilder;
async function reindex(): Promise<void>
{
    const t = Date.now();
    idx = await buildIndex(new GameIndex(new GameFiles(gameDir!, [mod]), 'english'));
    sb = new StoryBuilder(idx);
    console.log(`  (re-indexed with the mod in ${Date.now() - t} ms)`);
}
const story = (): EventStory => sb.eventStory(idx.get('events', 'court.8190')!)!;
const card = (name: string): EntityCard => sb.card(idx.get('traits', name)!);
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
/** Everything outside [from, to) of the old text is unchanged in the new one, byte for byte. */
const keeps = (before: string, after: string, from: number, to: number): boolean => after.startsWith(before.slice(0, from)) && after.endsWith(before.slice(to));
/** The `}` closing the block opened at `open` (braces counted, comments and quoted strings skipped); -1: none. */
const blockClose = (text: string, open: number): number =>
{
    let depth = 0;

    for (let i = open; i < text.length; i++)
    {
        const c = text[i];

        if (c === '#')
        {
            while (i < text.length && text[i] !== '\n')
                i++;
        }
        else if (c === '"')
        {
            for (i++; i < text.length && text[i] !== '"'; i++)
            {
                if (text[i] === '\\')
                    i++;
            }
        }
        else if (c === '{')
            depth++;
        else if (c === '}' && --depth === 0)
            return i;
    }

    return -1;
};

const EV = 'events/court_events/zz_edit_test_overrides.txt';
const TR = 'common/traits/zz_edit_test_overrides.txt';

try
{
    for (
        const [type, name] of [
            ['events', 'court.8190'],
            ['traits', 'brave'],
            ['traits', 'craven']
        ]
    )
        await applyOverride(host, { type, name, mode: 'copy' });

    const original = { ev: readFileSync(join(root, EV)), tr: readFileSync(join(root, TR)) };
    mod = (await modsState(host)).mods.find((m) => m.id === settings.activeMod)!;
    console.log('building the index with the mod …');
    await reindex();

    // --- anchors
    let ev = story();
    const lines = storyLines(ev);
    // (lines of the scripted effects / triggers it calls are anchored in their definitions: `owner` \u2014 round 9)
    const anchored = lines.filter((l) => l.src && l.src.rel === EV);
    const elsewhere = lines.filter((l) => l.src && l.src.rel !== EV);
    check(ev.src?.mod === mod.id && ev.src.rel === EV && ev.src.hash === textHash(read(EV).replace(/^\uFEFF/, '')), `event anchor: ${ev.src?.rel}:${ev.src?.line} (${mod.id}), checksum of the file`);
    check(
        anchored.length > 0 && anchored.every((l) => l.src!.mod === mod.id) && elsewhere.every((l) => l.src!.owner && !l.src!.mod),
        `${anchored.length} of ${lines.length} story lines anchored in the mod's file, ${elsewhere.length} in the game's scripted triggers / effects it calls (owner set)`
    );
    const evText = read(EV).replace(/^\uFEFF/, '');
    check(
        anchored.every((l) => /^[\w:.@?$-]+\s*(=|\?=|<|>|<=|>=|!=)/.test(evText.slice(l.src!.s, l.src!.e)) && evText.slice(l.src!.s, l.src!.e).length === l.src!.e - l.src!.s),
        'every anchor spans a statement of the file'
    );
    check(
        anchored.every((l) =>
            evText.split('\n')
                        .slice(0, l.src!.line - 1)
                        .join('\n').length + (l.src!.line > 1 ? 1 : 0) <= l.src!.s
        ),
        'anchor lines are right'
    );
    check(ev.sections?.immediate.src?.inner && !ev.sections.after.src && ev.sections.after.parent === ev.src, 'sections: immediate is a block, `after` would be created in the event');
    check(ev.options.every((o) => o.src?.inner) && !ev.options[0].trigger?.src && ev.options[1].trigger?.src, 'options: blocks; option a has no trigger block, b has one');
    const vanillaCard = new StoryBuilder(vanilla).card(vanilla.get('traits', 'brave')!);
    check(vanillaCard.src && !vanillaCard.src.mod && flat(vanillaCard.sections.flatMap((s) => s.lines)).some((l) => l.src && !l.src.mod), 'the game’s lines are anchored too, without a mod');
    let brave = card('brave');
    const mods = brave.sections.find((s) => s.title === 'Modifiers')!;
    check(mods.src?.src?.inner && mods.lines.some((l) => l.src && txt(l).includes('Martial')), 'trait card: Modifiers section anchored to the trait’s block, its lines to their statements');

    // --- refusals
    const game = flat(vanillaCard.sections.flatMap((s) => s.lines)).find((l) => l.src)!.src!;
    await editScript(host, { op: 'remove', at: game }).then(
        () => check(false, 'a game line is refused'),
        (e: Error) => check(/game’s file/.test(e.message), 'a game line is refused: ' + e.message)
    );
    const im = ev.sections!.immediate.src!;
    await editScript(host, { op: 'insert', where: 'inside', at: im, text: 'add_gold = {' }).then(
        () => check(false, 'an incomplete statement is refused'),
        (e: Error) => check(/not complete/.test(e.message), 'an incomplete statement is refused: ' + e.message)
    );
    await editScript(host, { op: 'insert', where: 'inside', at: im, text: 'add_gold = 1 }' }).then(
        () => check(false, 'a stray brace is refused'),
        (e: Error) => check(/not complete/.test(e.message), 'a stray brace is refused: ' + e.message)
    );
    check(readFileSync(join(root, EV)).equals(original.ev) && refreshed.length === 0, 'refused edits wrote nothing');

    // --- round 1: insert inside immediate (event, CRLF) · replace a modifier (trait, LF)
    let before = read(EV);
    let r = await editScript(host, { op: 'insert', where: 'inside', at: im, text: 'add_gold = 100' });
    let after = read(EV);
    const closeLine = before.lastIndexOf('\n', im.inner![1] + 1 - 1) + 1; // (offsets are without the BOM: +1 in the file)
    const expectedIns = '\t\tadd_gold = 100\r\n';
    check(after === before.slice(0, closeLine) + expectedIns + before.slice(closeLine), `insert inside immediate: one CRLF line before its closing brace (line ${r.line})`);
    check(after.charCodeAt(0) === 0xfeff && scriptProblems(after.slice(1)).length === 0, 'BOM kept, parses cleanly');
    check(refreshed.pop() === join(root, EV) && r.undo === 4 && r.step !== undefined, `the index was handed the file; an undo step (${r.undo} with the three overrides)`);
    const martial = brave.sections.find((s) => s.title === 'Modifiers')!.lines.find((l) => txt(l).includes('Martial'))!;
    const trBefore = read(TR);
    const text = await statementText(host, martial.src!);
    check(text.text === 'martial = 2' && text.indent === '\t' && !text.problem, 'statement text for the editor: ' + show(text.text));
    r = await editScript(host, { op: 'replace', at: martial.src!, text: 'martial = 4' });
    const trAfter = read(TR);
    check(trAfter === trBefore.slice(0, martial.src!.s + 1) + 'martial = 4' + trBefore.slice(martial.src!.e + 1), `replace martial = 2 → 4 byte-exact (line ${r.line})`);
    const oldTexts = storyTexts(ev);
    await reindex();
    ev = story();
    let texts = storyTexts(ev);
    const imm = flat(ev.immediate);
    check(txt(imm[imm.length - 1]) === '+100 Gold' && imm[imm.length - 1].src?.rel === EV, 'story: “+100 Gold” is the last line of Right away, anchored');
    check(JSON.stringify(texts.filter((t, i) => !(t === 'I +100 Gold' && i === texts.indexOf('I +100 Gold')))) === JSON.stringify(oldTexts), `the other ${oldTexts.length} story lines are unchanged`);
    brave = card('brave');
    check(brave.sections.find((s) => s.title === 'Modifiers')!.lines.some((l) => txt(l) === '+4 Martial'), 'card: +4 Martial');
    // a stale anchor (the file changed since): a statement the edit replaced is refused; a block that got a line follows
    // its new length (the file's trail of the app's writes, textTrail.ts)
    await editScript(host, { op: 'remove', at: martial.src! }).then(
        () => check(false, 'a stale anchor of a replaced statement is refused'),
        (e: Error) => check(/changed since/.test(e.message) && read(TR) === trAfter, 'a stale anchor (martial = 2, replaced since) is refused, nothing written: ' + e.message)
    );
    const imNow = await statementText(host, im);
    check(!imNow.problem && imNow.text.startsWith('immediate = {') && /\badd_gold = 100\s*\}$/.test(imNow.text), 'the stale anchor of immediate (it got a line since): its text as it is now, the new line at its end: ' + show(imNow.problem ?? imNow.text.slice(-40)));

    // --- round 2: replace the new line · remove the only condition · insert a modifier into the trait
    const gold = flat(ev.immediate).find((l) => txt(l) === '+100 Gold')!;
    before = read(EV);
    await editScript(host, { op: 'replace', at: gold.src!, text: 'add_gold = 250' });
    check(read(EV) === before.slice(0, gold.src!.s + 1) + 'add_gold = 250' + before.slice(gold.src!.e + 1), 'replace add_gold = 100 → 250');
    // (the file changed since the anchors were made: they are found again by their own text; round 6 tries that)
    brave = card('brave');
    const own = brave.sections.find((s) => s.title === 'Modifiers')!.src!.src!;
    await editScript(host, { op: 'insert', where: 'inside', at: own, text: 'diplomacy = 1' });
    check(read(TR).includes('\tdiplomacy = 1\n}') && scriptProblems(read(TR).slice(1)).length === 0, 'trait: diplomacy = 1 added at the end of its block');
    await reindex();
    ev = story();
    check(flat(ev.immediate).some((l) => txt(l) === '+250 Gold'), 'story: +250 Gold');
    brave = card('brave');
    check(brave.sections.find((s) => s.title === 'Modifiers')!.lines.some((l) => /\+1 Diplomacy/.test(txt(l))), 'card: +1 Diplomacy');

    // --- round 3: remove the event's condition · remove prowess from the trait
    const cond = ev.conditions[0];
    before = read(EV);
    const condText = before.slice(cond.src!.s + 1, cond.src!.e + 1);
    await editScript(host, { op: 'remove', at: cond.src! });
    after = read(EV);
    const lineStart = before.lastIndexOf('\n', cond.src!.s + 1) + 1;
    const lineEnd = before.indexOf('\n', cond.src!.e + 1) + 1;
    check(after === before.slice(0, lineStart) + before.slice(lineEnd), `remove the condition ${show(condText)}: its whole line`);
    const prowess = brave.sections.find((s) => s.title === 'Modifiers')!.lines.find((l) => /Prowess/.test(txt(l)))!;
    const tb = read(TR);
    await editScript(host, { op: 'remove', at: prowess.src! });
    check(read(TR) === tb.replace('\tprowess = 3\n', ''), 'trait: prowess = 3 removed with its line');
    await reindex();
    ev = story();
    check(ev.conditions.length === 0 && ev.sections!.trigger.src?.inner, 'story: no conditions; the empty trigger block is still there to add to');
    brave = card('brave');
    check(!brave.sections.find((s) => s.title === 'Modifiers')!.lines.some((l) => /Prowess/.test(txt(l))), 'card: no prowess');

    // --- round 4: add a condition into the empty trigger · create `after` · create option a's trigger · remove craven
    await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.trigger.src!, text: 'is_adult = yes' });
    await reindex();
    ev = story();
    check(ev.conditions.length === 1 && txt(ev.conditions[0]) === 'Is an adult', 'story: the condition “Is an adult”');
    const after0 = ev.sections!.after;
    await editScript(host, { op: 'insert', where: after0.before ? 'before' : 'inside', at: (after0.before ?? after0.parent)!, wrap: 'after', text: 'add_prestige = 50' });
    check(/\r\n\tafter = \{\r\n\t\tadd_prestige = 50\r\n\t\}\r\n\}/.test(read(EV)), 'created `after = { add_prestige = 50 }` at the end of the event (CRLF, tabs)');
    const craven = card('craven');
    const tb2 = read(TR);
    await editScript(host, { op: 'removeDef', at: craven.src! });
    const tr2 = read(TR);
    check(!/craven = \{/.test(tr2) && !/# craven — copied from/.test(tr2) && /brave = \{/.test(tr2) && tr2 === tb2.slice(0, tb2.indexOf('\n\n# craven — copied from') + 1) + tb2.slice(tb2.indexOf('\n', craven.src!.e + 1) + 1), 'removeDef craven: its definition and provenance comment gone, brave stays');
    await reindex();
    ev = story();
    check(flat(ev.after).some((l) => txt(l) === '+50 Prestige'), 'story: Afterwards +50 Prestige');
    check(idx.get('traits', 'craven') && !idx.detail('traits', 'craven')!.defs.some((d) => d.file === TR), 'craven: the game’s definition only');

    // --- round 5: a trigger for option a (created in the option) · remove the last option · add an option
    const optA = ev.options[0];
    await editScript(host, { op: 'insert', where: 'inside', at: optA.trigger!.parent!, wrap: 'trigger', text: 'age >= 16' });
    await reindex();
    ev = story();
    check(ev.options[0].conditions.some((l) => /age/i.test(txt(l)) && /16/.test(txt(l))), 'option a: “Only if” age ≥ 16: ' + ev.options[0].conditions.map(txt).join('; '));
    const n = ev.options.length;
    await editScript(host, { op: 'remove', at: ev.options[n - 1].src! });
    await reindex();
    ev = story();
    check(ev.options.length === n - 1, `the last option removed (${n} → ${ev.options.length})`);
    await editScript(host, { op: 'insert', where: 'inside', at: ev.src!, text: 'option = {\n\tname = court.8190.z\n\tadd_gold = 5\n}' });
    await reindex();
    ev = story();
    check(ev.options.length === n && flat(ev.options[n - 1].effects).some((l) => txt(l) === '+5 Gold'), 'an option added at the end of the event');

    // --- round 6: anchors of a file changed since (no re-index between the edits), found again by their own text
    const five = ev.options[n - 1].effects.find((l) => txt(l) === '+5 Gold')!.src!;
    const firstEffect = ev.options[0].effects.find((l) => l.src && !l.src.inner)!;
    const optionA = ev.options[0].src!;
    before = read(EV);
    const first = before.slice(firstEffect.src!.s + 1, firstEffect.src!.e + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await editScript(host, { op: 'insert', at: firstEffect.src!, text: 'add_piety = 7' });
    check(new RegExp(first + '\\r\\n\\t+add_piety = 7\\r\\n').test(read(EV)), `round 6: add_piety = 7 after the first effect of option a (${first})`);
    const t6 = read(EV);
    await editScript(host, { op: 'replace', at: five, text: 'add_gold = 6' });
    check(read(EV) === t6.replace('add_gold = 5', 'add_gold = 6'), 'the stale anchor of add_gold = 5 (made before that edit, further down): found again, replaced');
    await editScript(host, { op: 'insert', at: firstEffect.src!, text: 'add_piety = 8' });
    check(new RegExp(first + '\\r\\n\\t+add_piety = 8\\r\\n\\t+add_piety = 7\\r\\n').test(read(EV)), 'the stale anchor of the first effect itself (what follows it changed): found, add_piety = 8 right after it');
    // (option a got two lines since its anchor was made, three writes ago: the trail maps it, the new line goes at
    // its end; option a's block found by counting braces in the text before)
    const t6b = read(EV);
    await editScript(host, { op: 'insert', where: 'inside', at: optionA, text: 'add_dread = 11' });
    const t6c = read(EV);
    const openA = t6b.lastIndexOf('option = {', t6b.indexOf('name = court.8190.a'));
    const closeA = blockClose(t6b, t6b.indexOf('{', openA));
    const lsA = t6b.lastIndexOf('\n', closeA) + 1;
    const added6 = t6c.slice(lsA, lsA + t6c.length - t6b.length);
    check(openA > 0 && keeps(t6b, t6c, lsA, lsA) && /^\t+add_dread = 11\r\n$/.test(added6), 'the stale anchor of option a (the block got lines since): found, add_dread = 11 at its end: ' + show(added6));
    // (a change the trail did not see, written by another editor: the same stale anchor is refused, nothing written)
    const raw6 = readFileSync(join(root, EV));
    writeFileSync(join(root, EV), t6c.replace('add_dread = 11', 'add_dread = 12'));
    await editScript(host, { op: 'insert', where: 'inside', at: optionA, text: 'add_dread = 13' }).then(
        () => check(false, 'the file changed outside the app: the stale anchor of option a is refused'),
        (e: Error) => check(/changed since/.test(e.message) && read(EV) === t6c.replace('add_dread = 11', 'add_dread = 12'), 'the file changed outside the app (writeFileSync): the stale anchor of option a is refused, nothing written: ' + e.message)
    );
    writeFileSync(join(root, EV), raw6);
    const src6 = await statementText(host, five);
    check(src6.problem && /changed since/.test(src6.problem), 'the replaced statement’s old anchor: no text for the editor (' + src6.problem + ')');

    // --- round 7: an if with one condition: that condition, shown in the if's text, is edited on its own (Line.condSegs)
    await reindex();
    ev = story();
    await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.immediate.src!, text: 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 10\n}' });
    await reindex();
    ev = story();
    const ifLine = flat(ev.immediate).find((l) => l.condSegs && l.children?.some((c) => txt(c) === '+10 Gold'))!;
    const segs = ifLine && txt({ text: ifLine.text.slice(...ifLine.condSegs!) } as Line);
    check(ifLine && ifLine.ifConds?.length === 1 && ifLine.ifConds[0].src?.mod === mod.id && segs === 'you are an adult' && txt(ifLine) === `If ${segs}:`, `the if reads “${ifLine && txt(ifLine)}”: its condition's segments “${segs}”, anchored on their own`);
    const own7 = await statementText(host, ifLine.ifConds![0].src!);
    check(own7.text === 'is_adult = yes', 'the condition’s own script: ' + show(own7.text));
    await editScript(host, { op: 'replace', at: ifLine.ifConds![0].src!, text: 'is_female = yes' });
    check(/limit = \{ is_female = yes \}\r\n\t+add_gold = 10/.test(read(EV)), 'the condition replaced inside the one-line limit');
    await reindex();
    ev = story();
    check(
        flat(ev.immediate).some((l) => l.condSegs && /^If .*female/i.test(txt(l)) && l.children?.some((c) => txt(c) === '+10 Gold')),
        'story: the if reads its new condition: ' + flat(ev.immediate)
            .filter((l) => l.condSegs)
            .map(txt)
            .join(' | ')
    );

    // --- round 8: an on_action of the mod (a new one: `effect = { }` only); its sections are anchored: an event into
    // its `events` (the list made), a random event, an effect; ✕ on a list entry (then its steps undone)
    const made = await createEntry(host, { type: 'on_action', key: 'edit_test_on_check' });
    await reindex();
    const oa = (): OnActionStory => sb.onActionStory(idx.get('on_action', 'edit_test_on_check')!);
    let o = oa();
    check(o.src?.mod === mod.id && o.sections?.effect.src?.inner && !o.sections.events.src && o.sections.events.parent?.inner && o.sections.random_events.parent, `on_action ${made.rel}: anchored; effect a block, events / random_events made in it`);
    const effect8 = o.sections!.effect.src!;
    await editScript(host, { op: 'insert', where: 'inside', at: o.sections!.events.parent!, wrap: 'events', text: 'court.8190' });
    // (no re-index between: the on_action's block got the events list since its anchor was made: the anchor follows
    // the file's trail, random_events goes in after events; the effect block, before the change, is found again)
    await editScript(host, { op: 'insert', where: 'inside', at: o.sections!.random_events.parent!, wrap: 'random_events', text: '100 = court.8190' });
    await editScript(host, { op: 'insert', where: 'inside', at: effect8, text: 'add_gold = 5' });
    const oaText = readFileSync(made.file, 'utf8').replace(/\r\n/g, '\n');
    check(/edit_test_on_check = \{\n\teffect = \{\n\t\tadd_gold = 5\n\t\}\n\tevents = \{\n\t\tcourt\.8190\n\t\}\n\trandom_events = \{\n\t\t100 = court\.8190\n\t\}\n\}/.test(oaText), 'written: events and random_events lists made, the effect added: ' + show(oaText.slice(oaText.indexOf('edit_test_on_check'))));
    await reindex();
    o = oa();
    check(o.events.length === 1 && o.events[0].target.name === 'court.8190' && o.events[0].src?.mod === mod.id && o.randomEvents.length === 1 && flat(o.effects).some((l) => txt(l) === '+5 Gold'), 'story: always fires court.8190 (its entry anchored), one random event, +5 Gold');
    await editScript(host, { op: 'remove', at: o.events[0].src! });
    check(!/\tevents = /.test(readFileSync(made.file, 'utf8')) && /random_events/.test(readFileSync(made.file, 'utf8')), '✕ on the list’s only entry: the list goes with it: ' + show(readFileSync(made.file, 'utf8').slice(-80)));
    const kinds8: string[] = [];

    for (let i = 0; i < 5; i++)
        kinds8.push((await undoChange(host, { mod: mod.id }))!.kind);

    check(kinds8.join() === 'edit,edit,edit,edit,create' && !existsSync(made.file), `round 8 undone (${kinds8.join(' ')}): the on_action's file is gone again`);

    // --- round 8b: an on_action's other lists (first_valid, random_on_action, first_valid_on_action), its fallbacks, and a
    // delay / chances at a list's start: sections anchored (or `parent` when the list is missing), an insert into each
    // makes the list, first_valid's new entry goes before an unconditional last one, delay and chances are written at the
    // list start and replaced the second time, ✕ on each; then every step undone, the mod folder compared byte for byte
    {
        const snap = (dir: string, out = new Map<string, Buffer>()): Map<string, Buffer> =>
        {
            for (const d of readdirSync(dir, { withFileTypes: true }))
                d.isDirectory() ? snap(join(dir, d.name), out) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));

            return out;
        };
        const sameFolder = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v));
        const snap0 = snap(root);
        let steps = 0;
        const go = async (req: ScriptEditRequest): Promise<void> =>
        {
            await editScript(host, req);
            steps++;
        };
        const oaMade = await createEntry(host, { type: 'on_action', key: 'edit_test_on_lists' });
        const evMade = await createEntry(host, { type: 'events', key: 'edit_lists.0001', name: 'No trigger' });
        steps += 2;
        await reindex();
        const ol = (): OnActionStory => sb.onActionStory(idx.get('on_action', 'edit_test_on_lists')!);
        const file8 = (): string => readFileSync(oaMade.file, 'utf8').replace(/\r\n/g, '\n');
        // (a list's lines: between `\n\t<key> = {\n` and the next `\n\t}`)
        // (the file's text of an anchor: offsets are without the byte order mark)
        const evText8 = (a: LineSource): string => readFileSync(a.file, 'utf8').replace(/^﻿/, '').slice(a.s, a.e);
        const list8 = (key: string): string =>
        {
            const head = `\n\t${key} = {\n`;
            const from = file8().indexOf(head);
            return from < 0 ? '' : file8().slice(from + head.length, file8().indexOf('\n\t}', from + head.length));
        };
        let s = ol();
        const sec = s.sections!;
        check(sec.first_valid.parent && !sec.first_valid.src && sec.random_on_action.parent && !sec.random_on_action.src && sec.first_valid_on_action.parent && !sec.first_valid_on_action.src && sec.first_valid.key === 'first_valid' && sec.random_on_action.key === 'random_on_action', 'on_action lists: the three new ones are `parent` (the on_action’s block) when missing, `random_on_action` is the key a new one is made under');
        check(s.fallbacks.length === 0 && s.randomOnActions.length === 0 && s.firstValidOnActions.length === 0 && s.firstValid.length === 0 && s.lists?.first_valid.lines.length === 0 && !s.lists?.first_valid.first, 'on_action lists: the new pools and the lists’ settings are empty');

        // an insert into each makes the list (the anchors follow the file's trail: no re-index between)
        await go({ op: 'insert', where: 'inside', at: sec.first_valid.parent!, wrap: 'first_valid', text: 'edit_lists.0001' });
        await go({ op: 'insert', where: 'inside', at: sec.random_on_action.parent!, wrap: 'random_on_action', text: '100 = on_birthday' });
        await go({ op: 'insert', where: 'inside', at: sec.first_valid_on_action.parent!, wrap: 'first_valid_on_action', text: 'on_death' });
        await go({ op: 'insert', where: 'inside', at: s.src!, text: 'fallback_event = court.8190' });
        await go({ op: 'insert', where: 'inside', at: s.src!, text: 'fallback = on_game_start' });
        check(list8('first_valid') === '\t\tedit_lists.0001' && list8('random_on_action') === '\t\t100 = on_birthday' && list8('first_valid_on_action') === '\t\ton_death' && /\n\tfallback_event = court\.8190\n\tfallback = on_game_start\n\}/.test(file8()), 'on_action lists written: first_valid, random_on_action (100 = id), first_valid_on_action, fallback_event, fallback: ' + show(file8().slice(file8().indexOf('edit_test_on_lists'))));
        await reindex();
        s = ol();
        const fb = s.fallbacks.map((f) => `${f.target.type}:${f.target.name}`).join();
        check(
            s.firstValid.length === 1 && s.firstValid[0].src?.mod === mod.id && s.randomOnActions.length === 1 && s.randomOnActions[0].target.name === 'on_birthday' && s.randomOnActions[0].when.length === 1 && s.randomOnActions[0].src &&
                s.firstValidOnActions.length === 1 && s.firstValidOnActions[0].target.name === 'on_death' && s.firstValidOnActions[0].src && fb === 'events:court.8190,on_action:on_game_start' && s.fallbacks.every((f) => f.src?.mod === mod.id) &&
                s.onActions.length === 0 && s.events.length === 0,
            `story: its own pools (first_valid ${s.firstValid.length}, random_on_action ${s.randomOnActions.length} with its share, first_valid_on_action ${s.firstValidOnActions.length}, fallbacks ${fb}), none of them in “Also triggers” / “Always fires”`
        );
        check(s.sections!.first_valid.src?.inner && s.sections!.random_on_action.src?.inner && s.sections!.first_valid_on_action.src?.inner && s.lists!.random_on_action.first?.mod === mod.id, 'sections now anchored to the blocks; the random list’s first entry is anchored');
        const fvBlock = s.sections!.first_valid.src!;
        check(s.firstValidLast?.mod === mod.id && s.firstValidLast.s > fvBlock.s && s.firstValidLast.e < fvBlock.e && evText8(s.firstValidLast) === 'edit_lists.0001', 'first_valid: its last event has no trigger, so its own statement (not the list’s) is the anchor a new entry goes before (firstValidLast)');

        // a new first_valid entry goes before the unconditional last one
        await go({ op: 'insert', at: s.firstValidLast!, where: 'before', text: 'court.8190' });
        check(list8('first_valid') === '\t\tcourt.8190\n\t\tedit_lists.0001', 'first_valid: the new entry is written before the unconditional last one: ' + show(list8('first_valid')));
        await reindex();
        s = ol();

        // the delay at the list start, then replaced; a chance in each of the random lists, then replaced
        check(s.lists!.first_valid.first?.s === s.firstValid[0].src!.s && !s.lists!.first_valid.delay, 'first_valid: the list’s first entry is anchored, no delay yet');
        await go({ op: 'insert', at: s.lists!.first_valid.first!, where: 'before', text: 'delay = { days = 5 }' });
        check(list8('first_valid') === '\t\tdelay = { days = 5 }\n\t\tcourt.8190\n\t\tedit_lists.0001', 'delay written at the list’s start: ' + show(list8('first_valid')));
        await reindex();
        s = ol();
        // (since round 13 wave 9: a delay at the list's start is its row only, no chip on the entries; it holds them all)
        check(s.lists!.first_valid.delay && s.lists!.first_valid.lines.length === 1 && /5 days/.test(txt(s.lists!.first_valid.lines[0])) && s.firstValid.every((f) => !f.delay && !f.delayAt), `the delay is a line of the list (${s.lists!.first_valid.lines.map(txt).join()}), no chip on its entries (${s.firstValid.map((f) => f.delay ?? '-').join()})`);
        await go({ op: 'replace', at: s.lists!.first_valid.delay!, text: 'delay = { months = 2 }' });
        check(list8('first_valid') === '\t\tdelay = { months = 2 }\n\t\tcourt.8190\n\t\tedit_lists.0001', 'the delay the second time: replaced, not added: ' + show(list8('first_valid')));
        await go({ op: 'insert', at: s.lists!.random_on_action.first!, where: 'before', text: 'chance_of_no_event = 20' });
        check(list8('random_on_action') === '\t\tchance_of_no_event = 20\n\t\t100 = on_birthday', 'chance_of_no_event written at the random list’s start: ' + show(list8('random_on_action')));
        await reindex();
        s = ol();
        // (since round 13 wave 9 the note holds only what has no row: the chance is not in it)
        check(s.lists!.random_on_action.chance_of_no_event && s.lists!.random_on_action.lines.length === 1 && /20% chance/.test(txt(s.lists!.random_on_action.lines[0])) && !(s.notes ?? []).length, `the chance is a line of the list (${s.lists!.random_on_action.lines.map(txt).join()}), not in the note (${JSON.stringify(s.notes)})`);
        await go({ op: 'replace', at: s.lists!.random_on_action.chance_of_no_event!, text: 'chance_of_no_event = 30' });
        await go({ op: 'insert', at: s.lists!.random_on_action.first!, where: 'before', text: 'chance_to_happen = 40' });
        check(list8('random_on_action') === '\t\tchance_of_no_event = 30\n\t\tchance_to_happen = 40\n\t\t100 = on_birthday', 'chance_of_no_event the second time replaced (not added); chance_to_happen written before the first entry, after the other statement at the start: ' + show(list8('random_on_action')));
        await reindex();
        s = ol();
        check(s.lists!.random_on_action.chance_to_happen && s.lists!.random_on_action.chance_of_no_event && s.lists!.random_on_action.lines.length === 2, 'both chances are anchored lines of the list');

        // ✕ on each: the settings, the entries, the fallbacks
        await go({ op: 'remove', at: s.lists!.first_valid.lines[0].src! });
        await go({ op: 'remove', at: s.lists!.random_on_action.lines[0].src! });
        await go({ op: 'remove', at: s.lists!.random_on_action.lines[1].src! });
        check(list8('first_valid') === '\t\tcourt.8190\n\t\tedit_lists.0001' && list8('random_on_action') === '\t\t100 = on_birthday', '✕ on the delay and on both chances: each statement’s line goes');
        await reindex();
        s = ol();
        await go({ op: 'remove', at: s.fallbacks[0].src! });
        await go({ op: 'remove', at: s.fallbacks[1].src! });
        await go({ op: 'remove', at: s.randomOnActions[0].src! });
        await go({ op: 'remove', at: s.firstValidOnActions[0].src! });
        await go({ op: 'remove', at: s.firstValid[0].src! });
        check(!/fallback/.test(file8()) && !/random_on_action|first_valid_on_action/.test(file8()) && list8('first_valid') === '\t\tedit_lists.0001', '✕ on both fallbacks and the only entry of each list (its list goes along): ' + show(file8().slice(file8().indexOf('edit_test_on_lists'))));

        // "Change to…": another statement in place of one with comments (ScriptEditRequest.withComments): the comments go with it, one undo brings them back
        await reindex();
        s = ol();
        await go({ op: 'insert', where: 'inside', at: s.sections!.effect.src!, text: '# about the gold\nadd_gold = 5 # five' });
        await reindex();
        s = ol();
        const gold = flat(s.effects).find((l) => /5 Gold/.test(txt(l)))!;
        const B0 = readFileSync(oaMade.file);
        // (control: the same statement changed keeps both comments; one undo, the bytes as before)
        const plain = await editScript(host, { op: 'replace', at: gold.src!, text: 'add_gold = 6' });
        check(/# about the gold\n\t\tadd_gold = 6 # five/.test(file8()) && plain.notes.length === 0, 'replace without withComments (the same statement changed): both comments stay, no note');
        await undoChange(host, { mod: mod.id });
        check(readFileSync(oaMade.file).equals(B0), 'its undo: the file equals the bytes before (Buffer.equals)');
        // (Change to… a wrapper around the same statement (When…): no withComments, the comments stay, no note)
        const wrapText = 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 5\n}';
        const wrapped = await editScript(host, { op: 'replace', at: gold.src!, text: wrapText, ...(replacesStatement('add_gold = 5', wrapText) ? { withComments: true } : {}) });
        check(/# about the gold\n\t\tif = \{/.test(file8()) && /add_gold = 5\n\t\t\} # five/.test(file8()) && wrapped.notes.length === 0, 'Change to… When… (the statement kept inside an if): both comments stay, no note: ' + show(file8().slice(file8().indexOf('# about'))));
        await undoChange(host, { mod: mod.id });
        check(readFileSync(oaMade.file).equals(B0), 'its undo: the file equals the bytes before (Buffer.equals)');
        // (Change to… another statement: the comment above and the one after it on its line go with it, the change bar names both)
        const swapped = await editScript(host, { op: 'replace', at: gold.src!, text: 'add_prestige = 3', withComments: true });
        steps++;
        const B1 = readFileSync(oaMade.file);
        check(/\n\t\tadd_prestige = 3\n/.test(file8()) && !/about the gold|five/.test(file8()) && swapped.notes.length === 1 && /2 comments went/.test(swapped.notes[0]) && /about the gold/.test(swapped.notes[0]) && /five/.test(swapped.notes[0]), 'Change to… another statement (withComments): its comment above and after it go, the change bar names both: ' + show(swapped.notes.join('|')));
        const u1 = await undoChange(host, { mod: mod.id });
        check(u1?.kind === 'edit' && readFileSync(oaMade.file).equals(B0), 'one Undo: the comments and the statement are back, the file equals the bytes before (Buffer.equals)');
        await editScript(host, { op: 'replace', at: gold.src!, text: 'add_prestige = 3', withComments: true });
        check(readFileSync(oaMade.file).equals(B1), 'the same change again gives the bytes of the first time (Buffer.equals)');

        // a chance written as a block with a comment inside: the picker's number would replace it whole, so it opens the script editor (InPlaceEdit addListSetting reads statementText + commentsOf)
        await reindex();
        s = ol();
        await go({ op: 'insert', where: 'inside', at: s.src!, text: 'random_on_action = {\n\tchance_of_no_event = {\n\t\tadd = 80 # the AI needs fewer\n\t}\n\t100 = on_birthday\n}' });
        await reindex();
        s = ol();
        const blockChance = s.lists!.random_on_action.chance_of_no_event;
        const blockText = blockChance && (await statementText(host, blockChance));
        check(blockText && !blockText.problem && commentsOf(blockText.text).join() === '# the AI needs fewer', 'a chance block with a comment inside: the statement’s text has the comment (the picker would lose it, so the script editor opens): ' + show(blockText ? blockText.text : ''));
        const plainChance = s.lists!.random_on_action.chance_to_happen;
        check(!plainChance, 'a list without a chance_to_happen has none to replace');
        await go({ op: 'remove', at: s.sections!.random_on_action.src! });
        check(!/random_on_action/.test(file8()), 'the list with the commented chance block removed again');

        // everything undone: the mod folder as it was before the round (every file, byte for byte)
        const kinds8b: string[] = [];

        for (let i = 0; i < steps; i++)
            kinds8b.push((await undoChange(host, { mod: mod.id }))!.kind);

        check(sameFolder(snap(root), snap0) && !existsSync(oaMade.file) && !existsSync(evMade.file), `round 8b undone (${steps} steps, ${kinds8b.filter((k) => k === 'create').length} creates): the mod folder equals its state before (${snap0.size} files, Buffer.equals)`);
    }

    // --- round 8c (round 13 wave 9): an on_action's lists as rows in every view, a delay from a later entry on, the
    // plural spelling `random_on_actions` (read, added into, renamed by fire), fire / unfire, an artifact's name line.
    // Every list write is read back from the file (a new delay overrides the one before it: _on_actions.info:47-50);
    // then every step undone and the mod folder compared (Buffer.equals)
    {
        const snap = (dir: string, out = new Map<string, Buffer>()): Map<string, Buffer> =>
        {
            for (const d of readdirSync(dir, { withFileTypes: true }))
                d.isDirectory() ? snap(join(dir, d.name), out) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));

            return out;
        };
        const sameFolder = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v));
        const snap0 = snap(root);
        let steps = 0;
        const go = async (req: ScriptEditRequest): Promise<void> =>
        {
            await editScript(host, req);
            steps++;
        };
        const made = await createEntry(host, { type: 'on_action', key: 'edit_test_on_more' });
        steps++;
        const fileC = (): string => readFileSync(made.file, 'utf8').replace(/\r\n/g, '\n');
        const listC = (key: string, from = 'edit_test_on_more'): string =>
        {
            const t = fileC();
            const at0 = t.indexOf(`\n${from} = {`);
            const head = `\n\t${key} = {\n`;
            const i = t.indexOf(head, at0);
            return i < 0 ? '' : t.slice(i + head.length, t.indexOf('\n\t}', i + head.length));
        };
        await reindex();
        const om = (name = 'edit_test_on_more'): OnActionStory => sb.onActionStory(idx.get('on_action', name)!);
        let s = om();
        // (no re-index between: the anchors follow the file's trail)
        await go({ op: 'insert', where: 'inside', at: s.sections!.effect.src!, text: 'set_artifact_name = edit_test_artifact_name\nset_artifact_description = edit_test_artifact_desc' });
        await go({ op: 'insert', where: 'inside', at: s.src!, text: 'events = {\n\tdelay = { days = 3 }\n\tcourt.8190\n\tcourt.8191\n\tcourt.8192\n}\nrandom_on_actions = {\n\t100 = on_birthday\n}' });
        // (a game on_action written again in the mod: its random list has the game's chance_to_happen = 25 as well)
        await go({ op: 'insert', where: 'after', at: s.src!, text: 'three_year_pool_pulse = {\n\trandom_events = {\n\t\tchance_to_happen = 25\n\t\t100 = court.8190\n\t\t50 = 0\n\t}\n}' });
        check(listC('events') === '\t\tdelay = { days = 3 }\n\t\tcourt.8190\n\t\tcourt.8191\n\t\tcourt.8192' && listC('random_on_actions') === '\t\t100 = on_birthday' && /\n\t\tset_artifact_name = edit_test_artifact_name\n\t\tset_artifact_description = edit_test_artifact_desc\n/.test(fileC()) && listC('random_events', 'three_year_pool_pulse') === '\t\tchance_to_happen = 25\n\t\t100 = court.8190\n\t\t50 = 0', 'written: three events after a start delay, a plural random list, the artifact lines, the game on_action’s list: ' + show(fileC()));
        await reindex();
        s = om();

        // a start delay: the list's row, no chip; the entries after the first can get "Delay from here…"
        check(s.lists!.events.lines.length === 1 && /3 days/.test(txt(s.lists!.events.lines[0])) && s.lists!.events.lines[0].src?.mod === mod.id && s.events.length === 3 && s.events.every((f) => !f.delay && !f.delayAt) && !s.events[0].afterFirst && !!s.events[1].afterFirst && !!s.events[2].afterFirst, `start delay: one row (${s.lists!.events.lines.map(txt).join()}), no chips (${s.events.map((f) => f.delay ?? '-').join()}), afterFirst ${s.events.map((f) => !!f.afterFirst).join()}`);

        // the plural list: read into "Picks an on_action at random", the section anchored to it, a hint naming the file
        const plural = s.lists!.random_on_action.plural ?? [];
        check(s.randomOnActions.length === 1 && s.randomOnActions[0].target.name === 'on_birthday' && s.randomOnActions[0].when.length === 1 && s.sections!.random_on_action.src && s.sections!.random_on_action.key === 'random_on_actions' && plural.length === 1 && /^common\/on_action\//.test(plural[0]), `random_on_actions read: ${s.randomOnActions.map((f) => f.target.name).join()}, section key ${s.sections!.random_on_action.key}, hint files ${plural.join()}`);
        await go({ op: 'insert', where: 'inside', at: s.sections!.random_on_action.src!, text: '100 = on_death' });
        check(listC('random_on_actions') === '\t\t100 = on_birthday\n\t\t100 = on_death' && (fileC().match(/random_on_actions? = \{/g) ?? []).length === 1, '＋ into the plural list: added into it, no second list: ' + show(listC('random_on_actions')));

        // the artifact lines: hidden lines with their text keys, the mod's lines
        const artName = flat(s.effects).find((l) => l.locKey === 'edit_test_artifact_name');
        const artDesc = flat(s.effects).find((l) => l.locKey === 'edit_test_artifact_desc');
        check(artName?.src?.mod === mod.id && artName.hidden && /^Names the artifact /.test(txt(artName)) && artDesc?.src?.mod === mod.id && /^Describes the artifact: /.test(txt(artDesc)), `set_artifact_name / _description: lines with their keys (${artName && txt(artName)} | ${artDesc && txt(artDesc)})`);
        const artLoc = await editLoc(host, { key: 'edit_test_artifact_name', text: 'The Test Sword' });
        steps++;
        check(readFileSync(artLoc.file, 'utf8').includes(' edit_test_artifact_name:0 "The Test Sword"'), `✎ text on the artifact's name: the key written in ${artLoc.rel}`);

        // two definitions write the random list: both chance rows (the other one unanchored), the tip names the file;
        // the note keeps the `0 =` weight, which has no row
        const pulse = om('three_year_pool_pulse');
        const happen = pulse.lists!.random_events.lines.filter((l) => /^Only happens 25%/.test(txt(l)));
        check(happen.length === 2 && happen.filter((l) => l.src?.mod === mod.id).length === 1 && happen.filter((l) => !l.src).length === 1 && happen.every((l) => /^Written in /.test(l.tip ?? '')) && pulse.lists!.random_events.chance_to_happen?.mod === mod.id && (pulse.notes ?? []).some((t) => /chance that nothing happens/.test(t)), `two definitions with chance_to_happen = 25: rows ${pulse.lists!.random_events.lines.map((l) => `${txt(l)} [${l.src?.mod ? 'mod' : l.src ? 'game' : '-'}; ${l.tip}]`).join(' | ')}; notes ${JSON.stringify(pulse.notes)}`);

        // a game on_action read-only: the start delay is the row, the later ones the chips (no anchors of the mod)
        const health = om('yearly_health_pulse');
        check(health.lists!.on_actions.lines.length === 1 && !health.lists!.on_actions.lines[0].src?.mod && !health.onActions[0].delay && health.onActions.slice(1).every((f) => !!f.delay && !f.src?.mod), `yearly_health_pulse: rows ${health.lists!.on_actions.lines.map(txt).join()}, chips ${health.onActions.map((f) => f.delay ?? '-').join()}`);

        // "Delay from here…" before entry 2 of 3 (addListSetting with `before`: an insert before the entry), then replaced
        // (its chip's ✎: in place of delayAt), then ✕ on the chip
        await go({ op: 'insert', at: s.events[1].src!, where: 'before', text: 'delay = { days = 10 }' });
        check(listC('events') === '\t\tdelay = { days = 3 }\n\t\tcourt.8190\n\t\tdelay = { days = 10 }\n\t\tcourt.8191\n\t\tcourt.8192', 'delay from entry 2 on: written right before it: ' + show(listC('events')));
        await reindex();
        s = om();
        check(s.lists!.events.lines.length === 1 && !s.events[0].delay && /10 days/.test(s.events[1].delay ?? '') && s.events[1].delayAt?.mod === mod.id && /10 days/.test(s.events[2].delay ?? '') && !s.events[2].delayAt, `mid-list delay: no row (${s.lists!.events.lines.map(txt).join()}), chips ${s.events.map((f) => f.delay ?? '-').join()}, delayAt on entry 2 only`);
        await go({ op: 'replace', at: s.events[1].delayAt!, text: 'delay = { months = 2 }' });
        check(listC('events') === '\t\tdelay = { days = 3 }\n\t\tcourt.8190\n\t\tdelay = { months = 2 }\n\t\tcourt.8191\n\t\tcourt.8192', 'the delay from entry 2 the second time: replaced, not added: ' + show(listC('events')));
        await reindex();
        s = om();
        check(/2 months/.test(s.events[1].delay ?? '') && /2 months/.test(s.events[2].delay ?? ''),`chips after the change: ${s.events.map((f) => f.delay ?? '-').join()}`);
        check(flat(s.effects).some((l) => l.locKey === 'edit_test_artifact_name' && /The Test Sword/.test(txt(l))), 'the artifact line reads its new text');
        await go({ op: 'remove', at: s.events[1].delayAt! });
        check(listC('events') === '\t\tdelay = { days = 3 }\n\t\tcourt.8190\n\t\tcourt.8191\n\t\tcourt.8192', '✕ on the chip: the delay before entry 2 goes, the start delay stays: ' + show(listC('events')));

        // (review fix) the delays no chip had: one with a comment and a chance between it and entry 2 (the chip's), one
        // replaced by a later delay before any entry, one after the last entry (rows of the list, anchored)
        await go({ op: 'insert', at: s.events[1].src!, where: 'before', text: 'delay = { days = 5 }\ndelay = { # wait\n\tdays = 30\n}\nchance_to_happen = 50' });
        await go({ op: 'insert', at: s.events[2].src!, where: 'after', text: 'delay = { days = 7 }' });
        await reindex();
        s = om();
        const rowsD = s.lists!.events.lines.map(txt);
        check(rowsD.length === 4 && /3 days/.test(rowsD[0]) && /^Delay \(5 days\): the next delay replaces it/.test(rowsD[1]) && /50%/.test(rowsD[2]) && /^Delay after the last entry \(7 days\)/.test(rowsD[3]) && s.lists!.events.lines.every((l) => l.src?.mod === mod.id) && /30 days/.test(s.events[1].delay ?? '') && s.events[1].delayAt?.mod === mod.id && /30 days/.test(s.events[2].delay ?? '') && !s.events[2].delayAt, `delays no chip had: rows ${rowsD.join(' | ')}; chips ${s.events.map((f) => f.delay ?? '-').join()}, delayAt on entry 2 only (line ${s.events[1].delayAt?.line})`);
        const commented = s.events[1].delayAt!;
        check(/# wait/.test(readFileSync(made.file, 'utf8').split(/\r?\n/)[commented.line - 1] ?? ''), `the chip's delay is the commented one (line ${commented.line}): the one addListSetting opens as script (the app walk shows its editor)`);
        await go({ op: 'remove', at: s.lists!.events.lines[3].src! });
        await go({ op: 'remove', at: s.lists!.events.lines[2].src! });
        await go({ op: 'remove', at: commented });
        await go({ op: 'remove', at: s.lists!.events.lines[1].src! });
        check(listC('events') === '\t\tdelay = { days = 3 }\n\t\tcourt.8190\n\t\tcourt.8191\n\t\tcourt.8192', 'the rows’ ✕ and the chip’s ✕: the list as before: ' + show(listC('events')));

        // fire with send + sometimes: the relay goes into `random_on_action` (the documented spelling), and unfire takes it out
        const oaDir = join(root, 'common', 'on_action');
        mkdirSync(oaDir, { recursive: true });
        const send = 'random_parent = {\n\ttrigger_event = court.8190\n}';
        const f1 = await fireEvent(host, { event: 'court.8190', onAction: 'on_16th_birthday', how: 'sometimes', weight: 100, send });
        steps++;
        const relay = /fires (\S+), which sends/.exec(f1.notes[0] ?? '')?.[1] ?? '';
        const t1 = readFileSync(f1.file, 'utf8').replace(/\r\n/g, '\n');
        check(!!relay && t1.includes(`on_16th_birthday = {\n\trandom_on_action = {\n\t\t100 = ${relay}\n\t}\n}`) && !/random_on_actions/.test(t1.slice(t1.indexOf('on_16th_birthday'))) && t1.includes(`\n${relay} = {`), `fire, sometimes, someone of theirs: random_on_action = { 100 = ${relay} } and the relay: ` + show(t1.slice(t1.indexOf('on_16th_birthday'))));
        await unfireEvent(host, { event: 'court.8190', onAction: relay });
        steps++;
        const t1b = readFileSync(f1.file, 'utf8');
        check(!t1b.includes(relay) && !t1b.includes('on_16th_birthday'), 'unfire: the relay and its singular entry (and the emptied block) are gone');

        // a block that already holds a plural list (as this app wrote it before): the same edit renames it and adds into
        // it, one undo step; a block with both spellings: the singular list gets it, the plural stays
        const hand = join(oaDir, 'edit_test_hand_on_actions.txt');
        const handText = 'on_17th_birthday = {\n\trandom_on_actions = {\n\t\t50 = on_death\n\t}\n}\non_18th_birthday = {\n\trandom_on_actions = {\n\t\t50 = on_death\n\t}\n\trandom_on_action = {\n\t\t20 = on_birthday\n\t}\n}\n';
        writeFileSync(hand, handText);
        const H0 = readFileSync(hand);
        const f2 = await fireEvent(host, { event: 'court.8190', onAction: 'on_17th_birthday', how: 'sometimes', weight: 100, send });
        const t2 = readFileSync(hand, 'utf8');
        const relay2 = /fires (\S+), which sends/.exec(f2.notes[0] ?? '')?.[1] ?? '';
        check(f2.file === hand && t2.startsWith(`on_17th_birthday = {\n\trandom_on_action = {\n\t\t50 = on_death\n\t\t100 = ${relay2}\n\t}\n}`) && f2.notes.some((n) => /random_on_actions is now spelled random_on_action/.test(n)), `fire into a plural list: renamed to random_on_action and added into, the change bar names it (${f2.notes.join(' | ')}): ` + show(t2.slice(0, 120)));
        const u2 = await undoChange(host, { mod: mod.id });
        check(u2?.kind === 'edit' && readFileSync(hand).equals(H0), 'one undo: the file as hand-written (Buffer.equals)');
        const f3 = await fireEvent(host, { event: 'court.8190', onAction: 'on_18th_birthday', how: 'sometimes', weight: 100, send });
        const t3 = readFileSync(hand, 'utf8');
        const relay3 = /fires (\S+), which sends/.exec(f3.notes[0] ?? '')?.[1] ?? '';
        check(t3.includes(`on_18th_birthday = {\n\trandom_on_actions = {\n\t\t50 = on_death\n\t}\n\trandom_on_action = {\n\t\t20 = on_birthday\n\t\t100 = ${relay3}\n\t}\n}`) && !f3.notes.some((n) => /now spelled/.test(n)), 'both spellings there: the singular list gets the relay, the plural stays as written: ' + show(t3.slice(t3.indexOf('on_18th_birthday'), t3.indexOf('on_18th_birthday') + 170)));
        await undoChange(host, { mod: mod.id });
        check(readFileSync(hand).equals(H0), 'its undo: the file as hand-written (Buffer.equals)');

        // unfire finds a relay entry under the plural too (a relay written before this fix)
        writeFileSync(hand, 'edit_test_relay_old = {\n\teffect = {\n\t\trandom_parent = {\n\t\t\ttrigger_event = court.8190\n\t\t}\n\t}\n}\non_17th_birthday = {\n\trandom_on_actions = {\n\t\t100 = edit_test_relay_old\n\t}\n}\n');
        const H1 = readFileSync(hand);
        await unfireEvent(host, { event: 'court.8190', onAction: 'edit_test_relay_old' });
        const t4 = readFileSync(hand, 'utf8');
        check(!t4.includes('edit_test_relay_old') && !t4.includes('on_17th_birthday'), 'unfire: the relay and its entry under random_on_actions are gone: ' + show(t4));
        await undoChange(host, { mod: mod.id });
        check(readFileSync(hand).equals(H1), 'its undo: the file as before (Buffer.equals)');
        rmSync(hand);

        const kinds8c: string[] = [];

        for (let i = 0; i < steps; i++)
            kinds8c.push((await undoChange(host, { mod: mod.id }))!.kind);

        check(sameFolder(snap(root), snap0) && !existsSync(made.file), `round 8c undone (${steps} steps: ${kinds8c.join(' ')}): the mod folder equals its state before (${snap0.size} files, Buffer.equals)`);
    }

    // --- round 9: lines of an inlined scripted effect are its own text (LineSource.owner): the mod's file-local
    // employed_booner_reward_effect (a $POS$ filled in: offsets mapped back), then a game effect overridden into the mod
    await reindex();
    ev = story();
    const call = flat(ev.options[0].effects).find((l) => l.icon === 'call' && /booner/i.test(txt(l)))!;
    const mine = flat(call?.children ?? []).filter((l) => l.src);
    const modifier = mine.find((l) => /modifier/i.test(read(EV).slice(l.src!.s + 1, l.src!.s + 30)))!;
    const mtext = modifier && read(EV).slice(modifier.src!.s + 1, modifier.src!.e + 1);
    check(mine.length > 0 && mine.every((l) => l.src!.owner?.name === 'employed_booner_reward_effect' && l.src!.mod === mod.id && l.src!.rel === EV), `the call “${call && txt(call)}”: ${mine.length} lines anchored in the effect's definition (the mod's copy), owner set`);
    check(/^add_character_modifier = \{\s+modifier = employer_booner_\$POS\$_modifier\s+years = 10\s+\}$/.test(mtext ?? ''), 'the modifier line’s anchor spans the statement as written ($POS$ mapped back): ' + show(mtext ?? ''));
    await editScript(host, { op: 'replace', at: modifier.src!, text: 'add_character_modifier = {\n\tmodifier = employer_booner_$POS$_modifier\n\tyears = 20\n}' });
    check(/modifier = employer_booner_\$POS\$_modifier\r\n\t+years = 20/.test(read(EV)), 'edited in the effect’s definition: years = 20');
    const vanillaStory = new StoryBuilder(vanilla).eventStory(vanilla.get('events', 'court.8190')!)!;
    check(!storyLines(vanillaStory).some((l) => l.src?.owner), 'the game’s own entries: the lines of effects they call get no anchors');
    // a game effect: its lines carry the game's anchors and its key; overridden into the mod they are the mod's
    await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.immediate.src!, text: 'disburse_activity_stress_loss = yes' });
    await reindex();
    ev = story();
    const gameCall = flat(ev.immediate).find((l) => l.icon === 'call' && /disburse/i.test(txt(l)))!;
    const gameLine = gameCall?.children?.find((l) => l.src)!;
    check(gameLine?.src?.owner?.name === 'disburse_activity_stress_loss' && !gameLine.src.mod && gameLine.src.rel === 'common/scripted_effects/00_activity_effects.txt' && gameLine.src.stmt, `a game effect's line “${gameLine && txt(gameLine)}”: the game's anchor (no mod) with its owner and checks`);
    const ov = await applyOverride(host, { type: 'scripted_effects', name: 'disburse_activity_stress_loss', mode: 'copy' });
    await reindex();
    ev = story();
    const again = flat(ev.immediate).find((l) => l.icon === 'call' && /disburse/i.test(txt(l)))!.children!.find((l) => l.src)!;
    check(again.src!.mod === mod.id && again.src!.rel === ov.rel && again.src!.stmt?.text === gameLine.src!.stmt!.text && again.src!.owner?.name === 'disburse_activity_stress_loss', `overridden into ${ov.rel}: the line is the mod's, its statement found by the same check`);
    await editScript(host, { op: 'replace', at: again.src!, text: 'add_stress = -20' });
    await reindex();
    ev = story();
    check(flat(ev.immediate).find((l) => l.icon === 'call' && /disburse/i.test(txt(l)))?.children?.some((l) => /20 Stress/.test(txt(l))), 'story: the call reads the edited effect (−20 Stress)');
    const kinds9: string[] = [];

    for (let i = 0; i < 4; i++)
        kinds9.push((await undoChange(host, { mod: mod.id }))!.kind);

    check(kinds9.join() === 'edit,override,edit,edit' && !existsSync(join(root, 'common', 'scripted_effects')), `round 9 undone (${kinds9.join(' ')}): the effect's overrides file and its folder are gone`);

    // --- round 10: localization, a line reading a text (Line.locKey), the text changed (an override in the replace
    // file), the key's line edited as text (the Source tab's editor on a .yml), the key's card
    await reindex();
    ev = story();
    const TT = 'employer_booner_invalidated_tt';
    const ttLine = flat(ev.options[0].effects).find((l) => l.locKey === TT)!;
    check(ttLine?.src?.mod === mod.id, `the custom tooltip “${ttLine && txt(ttLine)}” carries its text's key (${TT}) and is the mod's line`);
    const lr = await editLoc(host, { key: TT, text: 'The booner is gone' });
    const LOC = 'localization/english/replace/edit_test_l_english.yml';
    const locFile = (): string => readFileSync(join(root, LOC), 'utf8');
    check(lr.rel === LOC && locFile().startsWith('﻿l_english:') && locFile().includes(` ${TT}:0 "The booner is gone"`), `the text overridden in ${lr.rel} (BOM, header, the line)`);
    await reindex();
    ev = story();
    check(flat(ev.options[0].effects).some((l) => l.locKey === TT && txt(l) === 'The booner is gone'), 'story: the tooltip reads the new text');
    const locDef = idx.detail('localization', TT)!.defs.find((d) => d.src?.mod === mod.id)!;
    check(locDef?.src?.rel === LOC && locDef.src.stmt, `the key's definition in the mod: a line anchor in ${locDef?.src?.rel}:${locDef?.src?.line}`);
    const lt = await statementText(host, locDef.src!);
    check(lt.text === `${TT}:0 "The booner is gone"`, 'the Source editor reads its line: ' + show(lt.text));
    // (another line above it first: the anchor is found again by its own checks)
    writeFileSync(join(root, LOC), locFile().replace('l_english:\n', 'l_english:\n edit_test_other:0 "Other"\n'));
    await editScript(host, { op: 'replace', at: locDef.src!, text: `${TT}:0 "The booner is gone for good" # edited` });
    check(locFile() === `﻿l_english:\n edit_test_other:0 "Other"\n ${TT}:0 "The booner is gone for good" # edited\n`, 'the line replaced (the file changed above it since): ' + show(locFile()));
    await editScript(host, { op: 'replace', at: locDef.src!, text: `${TT}:0 "Again"` }).then(
        () => check(false, 'the line changed itself since the anchor: refused'),
        (e: Error) => check(/changed since/.test(e.message), 'the line changed itself since its anchor: refused')
    );
    await reindex();
    const lcard = new StoryBuilder(idx).card(idx.get('localization', TT)!);
    check(lcard.descriptionKey === TT && lcard.src?.mod === mod.id && lcard.src.rel === LOC, 'the key’s card: its text editable (descriptionKey), anchored to the mod’s line');
    const two = idx.detail('localization', TT)!.defs.find((d) => d.src?.mod === mod.id)!.src!;
    await editScript(host, { op: 'replace', at: two, text: `${TT}:0 "Two\nlines"` }).then(
        () => check(false, 'a line break is refused'),
        (e: Error) => check(/one line/.test(e.message), 'a line break in the line is refused: ' + e.message)
    );
    await editScript(host, { op: 'replace', at: two, text: `edit_test_x:0 "Nope"` }).then(
        () => check(false, 'another key is refused'),
        (e: Error) => check(/key must stay/.test(e.message), 'another key is refused: ' + e.message)
    );
    // (undo: the edit, then the override; the replace file and the folders made for it go)
    const u10a = await undoChange(host, { mod: mod.id });
    check(u10a?.kind === 'edit' && locFile().includes(`${TT}:0 "The booner is gone"`) && locFile().includes('edit_test_other'), 'undo: the line as it was before the edit (the hand-written line above stays)');
    writeFileSync(join(root, LOC), locFile().replace(' edit_test_other:0 "Other"\n', ''));
    const u10b = await undoChange(host, { mod: mod.id });
    check(u10b?.kind === 'text' && !existsSync(join(root, 'localization')), 'undo the text: the replace file and its folders are gone');

    // --- round 11: a picked statement with the entries made for it (ScriptEditRequest.creates) is one undo step: one
    // undo takes all back, the mod folder byte for byte as before; a refused statement takes its entries back at once;
    // entries written into the statement's own file; a failing batch; refusals that say why and can be forgotten
    {
        const folder = (): Map<string, Buffer> =>
        {
            const out = new Map<string, Buffer>();
            const walk = (dir: string): void =>
            {
                for (const d of readdirSync(dir, { withFileTypes: true }))
                    d.isDirectory() ? walk(join(dir, d.name)) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));
            };
            walk(root);
            return out;
        };
        const same = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([p, x]) => b.get(p)?.equals(x));
        const count = (): number => journalOf(host).list(mod.id).length;
        await reindex();
        ev = story();
        const n0 = count();
        let before = folder();
        const r11 = await editScript(host, {
            op: 'insert',
            where: 'inside',
            at: ev.sections!.immediate.src!,
            text: 'add_opinion = { target = root modifier = edit_test_scorned }\nadd_trait = edit_test_bold',
            label: 'Added: a scorned, bold one',
            creates: [
                { what: 'opinion_modifiers', key: 'edit_test_scorned', fields: [['opinion', '-15']], loc: 'Scorned' },
                { what: 'entry', key: 'edit_test_bold', fields: [['type', 'traits']], loc: 'Bold' }
            ]
        });
        check(
            existsSync(join(root, 'common/opinion_modifiers/edit_test_opinion_modifiers.txt')) && existsSync(join(root, 'common/traits/edit_test_traits.txt')) && /edit_test_scorned/.test(read(EV)) && count() === n0 + 1 && r11.step !== undefined,
            `the statement and its new entries: one step (${r11.notes.join('; ')})`
        );
        const u11 = await undoChange(host, { mod: mod.id });
        check(u11 && !u11.refused && same(before, folder()), `one undo takes the statement and its new entries back, the mod folder byte for byte as before (removed again: ${u11?.removed.join(', ')}; also: ${u11?.also.join(', ')})`);
        // a refused statement: its entries go at once, no step is left
        before = folder();
        await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.immediate.src!, text: 'add_trait = {', creates: [{ what: 'entry', key: 'edit_test_rash', fields: [['type', 'traits']], loc: 'Rash' }] }).then(
            () => check(false, 'an incomplete statement with a new entry is refused'),
            (e: Error) => check(/not complete/.test(e.message) && same(before, folder()) && count() === n0, 'a refused statement takes its new entry back at once, no step left: ' + e.message)
        );
        // a batch whose later entry fails (the key exists): what it wrote goes, no step
        await createEntries(host, [{ what: 'opinion_modifiers', key: 'edit_test_fine', fields: [['opinion', '5']], loc: 'Fine' }, { what: 'entry', key: 'brave', fields: [['type', 'traits']] }]).then(
            () => check(false, 'a batch whose second entry exists is refused'),
            (e: Error) => check(/exists already/.test(e.message) && same(before, folder()) && count() === n0, 'a batch whose later entry fails takes back what it wrote, no step: ' + e.message)
        );

        // the new entry in the statement's own file: a new event made from an option of an event in
        // events/edit_test_events.txt, a new trait as an opposite on a trait in common/traits/edit_test_traits.txt
        const evA = await createEntry(host, { type: 'events', key: 'edit_test.0001', name: 'First' });
        const trA = await createEntry(host, { type: 'traits', key: 'edit_test_first', name: 'First' });
        await reindex();
        const optA = new StoryBuilder(idx).eventStory(idx.get('events', 'edit_test.0001')!)!.options[0].src!;
        const trBlock = card('edit_test_first').src!;
        check(optA.rel === evA.rel && trBlock.rel === trA.rel, `the option's anchor in ${optA.rel}, the trait's in ${trBlock.rel}: where new events and traits go`);
        before = folder();
        await editScript(host, { op: 'insert', where: 'inside', at: optA, text: 'trigger_event = edit_test.0002', creates: [{ what: 'entry', key: 'edit_test.0002', fields: [['type', 'events']], loc: 'Second' }] });
        const evFile = readFileSync(join(root, evA.rel), 'utf8');
        const inOption = /edit_test\.0001 = \{[\s\S]*option = \{[^}]*trigger_event = edit_test\.0002[\s\S]*\}[\s\S]*edit_test\.0002 = \{/.test(evFile);
        check(inOption, 'a new event made from an option in the same file: the event appended, the option (its anchor made before) gets trigger_event');
        let u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && same(before, folder()), 'one undo takes both back');
        await editScript(host, { op: 'insert', where: 'inside', at: trBlock, text: 'opposites = {\n\tedit_test_second\n}', creates: [{ what: 'entry', key: 'edit_test_second', fields: [['type', 'traits']], loc: 'Second' }] });
        const trFile = readFileSync(join(root, trA.rel), 'utf8');
        check(/edit_test_first = \{[^}]*opposites = \{\s*edit_test_second\s*\}[\s\S]*edit_test_second = \{/.test(trFile), 'a new trait as an opposite in the same file: the trait appended, the first one gets its opposites');
        u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && same(before, folder()), 'one undo takes both back');

        // refusals: a file the step made and that is gone since is no obstacle (removing it is what undo would do)
        const gone = await createEntry(host, { type: 'opinion_modifiers', key: 'edit_test_gone', name: 'Gone' });
        check(u && gone.step !== undefined && existsSync(join(root, gone.rel)), `a new opinion modifier in a new file (${gone.rel})`);
        rmSync(join(root, gone.rel));
        u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && same(before, folder()), 'its file deleted since: undone all the same (its text taken back from the loc file)');
        // the two new entries made for this: undone, their files removed
        u = await undoChange(host, { mod: mod.id });
        const u2 = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && u2 && !u2.refused && !existsSync(join(root, trA.rel)) && !existsSync(join(root, evA.rel)) && count() === n0, `the new trait and event undone: the journal as before (${count()} steps)`);

        // the 1.20 layouts (docs/game-structure.md, "Layouts that changed"): a religion's new faith on its own in the
        // mod's religion/faith_types, naming it; a doctrine put into a group: `doctrine_group_type` in its copy
        if (idx.layouts().doctrinesNameTheirGroup)
        {
            before = folder();
            const nf = await createEntries(host, [{ what: 'faith', key: 'edit_test_faith', fields: [['religion', 'christianity_religion']], loc: 'Test Faith' }]);
            const ff = join(root, 'common/religion/faith_types/edit_test_faith_types.txt');
            check(existsSync(ff) && /edit_test_faith = \{\s*faith_details = \{\s*religion = christianity_religion\s*\}\s*\}/.test(readFileSync(ff, 'utf8')), `a new faith (1.20): a block of its own naming its religion (${nf.notes.join('; ')})`);
            u = await undoChange(host, { mod: mod.id });
            check(u && !u.refused && same(before, folder()) && count() === n0, 'undone: the mod folder as before');
            const dg = await createEntries(host, [{ what: 'doctrine_group_member', key: 'doctrine_polygamy', fields: [['group', 'doctrine_divorce']] }]);
            const df = dg.files.find((f) => /doctrine_types/.test(f));
            const block = df && /doctrine_polygamy = \{[\s\S]*?\n\}/.exec(readFileSync(df, 'utf8'))?.[0];
            check(block && /doctrine_group_type = doctrine_divorce/.test(block) && block.match(/doctrine_group_type/g)?.length === 1, `a doctrine put into a group (1.20): its copy names the group, once (${dg.notes.join('; ')})`);

            while (count() > n0)
                u = await undoChange(host, { mod: mod.id });

            check(same(before, folder()), 'undone: the mod folder as before');
        }

        // (round 13 wave 10's review: a `loc` create of a key the game has (a named track's trait_track_falconer, a
        // track's text key being global) goes into the mod's replace folder, not beside the game's line as a duplicate;
        // a new key into the mod's loc file; one undo takes both back)
        {
            before = folder();
            const lr = await createEntries(host, [
                { what: 'loc', key: 'trait_track_falconer', fields: [['for', 'falconer']], loc: 'Hawk Master' },
                { what: 'loc', key: 'trait_track_edit_test_new', fields: [['for', 'edit_test_new']], loc: 'Edit Test' }
            ]);
            const slashed = lr.files.map((f) => f.split(String.fromCharCode(92)).join('/'));
            const rep = slashed.find((f) => f.includes('/localization/english/replace/'));
            const main = slashed.find((f) => /\/localization\/english\/[^/]+$/.test(f));
            const repText = rep ? readFileSync(rep, 'utf8') : '';
            const mainText = main ? readFileSync(main, 'utf8') : '';
            check(repText.includes(' trait_track_falconer:0 "Hawk Master"') && !mainText.includes('trait_track_falconer') && mainText.includes(' trait_track_edit_test_new:0 "Edit Test"') && !repText.includes('edit_test_new') && lr.notes.some((x) => x.includes('replace folder wins')), `a loc create of the game's key: into the replace folder, a new key into the mod's file (${slashed.join(', ')}; ${lr.notes.join('; ')})`);
            u = await undoChange(host, { mod: mod.id });
            check(u && !u.refused && same(before, folder()) && count() === n0, 'undone: the mod folder as before');
        }

        // a later change of the same file: named; another editor: said so; "Forget" lets the next undo through
        await reindex();
        ev = story();
        before = folder();
        const e1 = await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.immediate.src!, text: 'add_gold = 11', label: 'first change' });
        const e2 = await editScript(host, { op: 'insert', where: 'inside', at: ev.options[0].src!, text: 'add_gold = 22', label: 'second change' });
        u = await undoChange(host, { id: e1.step! });
        check(u?.refused && /changed again by a later change \(“second change”\)/.test(u.refused), 'undoing an older change of a file a later change touched: refused, the later one named: ' + u?.refused);
        const mid = read(EV);
        writeFileSync(join(root, EV), mid + '\r\n# a note\r\n');
        u = await undoChange(host, { mod: mod.id });
        check(u?.refused && /changed since \(in another editor\?\)/.test(u.refused) && u.id === e2.step, 'the file changed in another editor: refused, nothing written: ' + u?.refused);
        check(forgetChange(host, u!.id) && journalOf(host).list(mod.id)[0]?.label === 'first change', '“Forget this change”: the next undo reaches the change before it');
        writeFileSync(join(root, EV), mid.replace(/\r\n\t+add_gold = 22/, ''));
        u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && same(before, folder()) && count() === n0, 'the change before it undone (the file put back by hand first): as before');
    }

    // --- round 13 (P1a): a nested type's new entry (the picker's "＋ New <type>…" for a type written inside others) carries
    // its holder in EntryCreate.fields: an existing holder (copied into the mod first), or a new one made with it; one
    // undo takes it all back, the mod folder byte for byte as before. game_rule_options sit in game_rules (`difficulty`).
    {
        const folder13 = (): Map<string, Buffer> =>
        {
            const out = new Map<string, Buffer>();
            const walk = (dir: string): void =>
            {
                for (const d of readdirSync(dir, { withFileTypes: true }))
                    d.isDirectory() ? walk(join(dir, d.name)) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));
            };
            walk(root);
            return out;
        };
        const same13 = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([p, x]) => b.get(p)?.equals(x));
        const holding = (re: RegExp): string[] => [...folder13()].filter(([p, b]) => re.test(b.toString('utf8'))).map(([p]) => p.slice(root.length + 1).replace(/\\/g, '/'));
        const n13 = journalOf(host).list(mod.id).length;
        const before13 = folder13();
        const plan13 = await newEntryPlan(host, 'game_rule_options');
        check(!!plan13.nested && plan13.nested.holderType === 'game_rules' && plan13.nested.newHolder && !plan13.rel, `the plan of a nested type: holder ${plan13.nested?.holderType}, a new holder possible: ${plan13.nested?.newHolder}`);
        // an existing holder, not yet in the mod: copied in, the entry inside it, its name in the mod's text
        const r13 = await createEntries(host, [{ what: 'entry', key: 'edit_test_option', fields: [['type', 'game_rule_options'], ['holder', 'difficulty']], loc: 'Test option' }]);
        const text13 = holding(/edit_test_option = \{/);
        const body13 = text13.length ? readFileSync(join(root, text13[0]), 'utf8') : '';
        check(
            text13.length === 1 && /(^|\n)difficulty = \{[\s\S]*edit_test_option = \{/.test(body13) && holding(/edit_test_option:0 "Test option"/).length === 1 && journalOf(host).list(mod.id).length === n13 + 1,
            `a nested entry in an existing holder: ${text13.join(', ')} (${r13.notes.join('; ')}), one step`
        );
        const u13 = await undoChange(host, { mod: mod.id });
        check(u13 && !u13.refused && same13(before13, folder13()) && journalOf(host).list(mod.id).length === n13, 'one undo takes the copied holder, the entry and its text back, the mod folder byte for byte as before');
        // a new holder made with it (its key and name given)
        const r13b = await createEntries(host, [{ what: 'entry', key: 'edit_test_option2', fields: [['type', 'game_rule_options'], ['newHolder', 'edit_test_rule'], ['newHolderName', 'Test Rule']], loc: 'Test option 2' }]);
        const hold13 = holding(/edit_test_rule = \{/);
        const body13b = hold13.length ? readFileSync(join(root, hold13[0]), 'utf8') : '';
        check(
            hold13.length === 1 && /edit_test_rule = \{[\s\S]*edit_test_option2 = \{/.test(body13b) && holding(/edit_test_rule:0 "Test Rule"/).length === 1 && holding(/edit_test_option2:0 "Test option 2"/).length === 1,
            `a nested entry in a new holder: ${hold13.join(', ')} (${r13b.notes.join('; ')})`
        );
        const u13b = await undoChange(host, { mod: mod.id });
        check(u13b && !u13b.refused && same13(before13, folder13()) && journalOf(host).list(mod.id).length === n13, 'one undo takes the new holder and its entry back, the mod folder byte for byte as before');
        // no names typed, keys with a dot: the name is the picker's "Keep:" name (what stands before the last dot is dropped)
        const r13d = await createEntries(host, [{ what: 'entry', key: 'edit.test_option5', fields: [['type', 'game_rule_options'], ['newHolder', 'edit.test_rule5']] }]);
        check(
            holding(/:0 "Test rule5"/).length === 1 && holding(/:0 "Test option5"/).length === 1,
            `dotted keys, no names typed: the default names ("Test rule5", "Test option5") are written (${r13d.notes.join('; ')})`
        );
        const u13d = await undoChange(host, { mod: mod.id });
        check(u13d && !u13d.refused && same13(before13, folder13()) && journalOf(host).list(mod.id).length === n13, 'one undo takes them back, the mod folder byte for byte as before');
        // with a statement (the picker's real path): the statement and the nested entry, one step
        await reindex();
        ev = story();
        const r13c = await editScript(host, {
            op: 'insert',
            where: 'inside',
            at: ev.sections!.immediate.src!,
            text: 'add_gold = 3',
            creates: [{ what: 'entry', key: 'edit_test_option3', fields: [['type', 'game_rule_options'], ['holder', 'difficulty']], loc: 'Test option 3' }]
        });
        check(/add_gold = 3/.test(read(EV)) && holding(/edit_test_option3 = \{/).length === 1 && r13c.step !== undefined && journalOf(host).list(mod.id).length === n13 + 1, `a statement with a nested entry: one step (${r13c.notes.join('; ')})`);
        const u13c = await undoChange(host, { mod: mod.id });
        check(u13c && !u13c.refused && same13(before13, folder13()) && journalOf(host).list(mod.id).length === n13, 'one undo takes both back, the mod folder byte for byte as before');
        // no holder given: refused, nothing written, no step
        await createEntries(host, [{ what: 'entry', key: 'edit_test_option4', fields: [['type', 'game_rule_options']], loc: 'No holder' }]).then(
            () => check(false, 'a nested entry without a holder is refused'),
            (e: Error) => check(/Choose the/.test(e.message) && same13(before13, folder13()) && journalOf(host).list(mod.id).length === n13, 'a nested entry without a holder: refused, nothing written, no step: ' + e.message)
        );
        await reindex();
        ev = story();
    }

    // --- round 13 wave 9 (P1r): several nested entries in one batch. The app's refreshFiles waits until the index has taken
    // the files in (main's queueRefresh), so a second nested create of a batch finds what the first wrote; this host's
    // refreshFiles only records the files, so for this block it re-indexes too (restored afterwards, the other blocks keep
    // the recording host). One undo step per batch (the journal count), and after its undo the whole mod folder is
    // Buffer.equals to its snapshot.
    {
        const folderQ = (): Map<string, Buffer> =>
        {
            const out = new Map<string, Buffer>();
            const walk = (dir: string): void =>
            {
                for (const d of readdirSync(dir, { withFileTypes: true }))
                    d.isDirectory() ? walk(join(dir, d.name)) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));
            };
            walk(root);
            return out;
        };
        const sameQ = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([p, x]) => b.get(p)?.equals(x));
        const holdingQ = (re: RegExp): string[] => [...folderQ()].filter(([, b]) => re.test(b.toString('utf8'))).map(([p]) => p.slice(root.length + 1).replace(/\\/g, '/'));
        const countIn = (re: RegExp): number => [...folderQ()].reduce((n, [, b]) => n + (b.toString('utf8').match(re)?.length ?? 0), 0);
        const steps = (): number => journalOf(host).list(mod.id).length;
        const recording = host.refreshFiles;
        let reindexed = 0;
        host.refreshFiles = async (files) =>
        {
            if (!files.length)
                throw new Error('refreshFiles([]): makeEntries skips an empty refresh');

            refreshed.push(...files);
            await reindex();
            reindexed++;
        };

        try
        {
            const nQ = steps();
            const beforeQ = folderQ();
            // (i) two entries into the same game holder: the first copies `difficulty` into the mod, the second finds the copy
            const ri = await createEntries(host, [
                { what: 'entry', key: 'edit_q_option_a', fields: [['type', 'game_rule_options'], ['holder', 'difficulty']], loc: 'Q option A' },
                { what: 'entry', key: 'edit_q_option_b', fields: [['type', 'game_rule_options'], ['holder', 'difficulty']], loc: 'Q option B' }
            ]);
            const fi = holdingQ(/edit_q_option_a = \{/);
            const bodyI = fi.length ? readFileSync(join(root, fi[0]), 'utf8') : '';
            check(
                fi.length === 1 && holdingQ(/edit_q_option_b = \{/).join() === fi.join() && countIn(/(^|\n)difficulty = \{/g) === 1 &&
                    /(^|\n)difficulty = \{[\s\S]*edit_q_option_a = \{[\s\S]*edit_q_option_b = \{/.test(bodyI) && holdingQ(/edit_q_option_a:0 "Q option A"/).length === 1 &&
                    holdingQ(/edit_q_option_b:0 "Q option B"/).length === 1 && steps() === nQ + 1,
                `(i) two nested entries into one game holder in a batch: one copy of difficulty (${countIn(/(^|\n)difficulty = \{/g)}) in ${fi.join(', ')}, both entries in it, both names, one step (${steps() - nQ}) (${ri.notes.join('; ')})`
            );
            const ui = await undoChange(host, { mod: mod.id });
            check(ui && !ui.refused && sameQ(beforeQ, folderQ()) && steps() === nQ, `(i) one undo takes the copied holder, both entries and their texts back: the mod folder Buffer.equals its snapshot (${folderQ().size} files)`);
            // (ii) two entries into one new holder (each carries the holder's fields, as the picker's "… · new" row gives
            // them): the first makes it, the second goes into it (create.ts madeHolders), not "exists already"
            const newRule: [string, string][] = [['type', 'game_rule_options'], ['newHolder', 'edit_q_rule'], ['newHolderName', 'Q Rule']];
            const rii = await createEntries(host, [
                { what: 'entry', key: 'edit_q_option_c', fields: newRule, loc: 'Q option C' },
                { what: 'entry', key: 'edit_q_option_d', fields: newRule, loc: 'Q option D' }
            ]);
            const fii = holdingQ(/edit_q_rule = \{/);
            const bodyII = fii.length ? readFileSync(join(root, fii[0]), 'utf8') : '';
            check(
                fii.length === 1 && countIn(/(^|\n)edit_q_rule = \{/g) === 1 && /edit_q_rule = \{[\s\S]*edit_q_option_c = \{[\s\S]*edit_q_option_d = \{/.test(bodyII) &&
                    countIn(/edit_q_rule:0 "Q Rule"/g) === 1 && holdingQ(/edit_q_option_c:0 "Q option C"/).length === 1 && holdingQ(/edit_q_option_d:0 "Q option D"/).length === 1 &&
                    steps() === nQ + 1,
                `(ii) two nested entries into one new holder in a batch: one holder (${countIn(/(^|\n)edit_q_rule = \{/g)}) in ${fii.join(', ')}, both entries in it, one name line each, one step (${steps() - nQ}) (${rii.notes.join('; ')})`
            );
            const uii = await undoChange(host, { mod: mod.id });
            check(uii && !uii.refused && sameQ(beforeQ, folderQ()) && steps() === nQ, '(ii) one undo takes the new holder, both entries and the three names back: the mod folder Buffer.equals its snapshot');
            // (ii, the holder named again in a later batch: the index knows it now, "exists already", nothing written)
            await createEntries(host, [{ what: 'entry', key: 'edit_q_option_c', fields: newRule }]);
            await createEntries(host, [{ what: 'entry', key: 'edit_q_option_e', fields: newRule }]).then(
                () => check(false, '(ii) a new holder of an earlier batch named again is refused'),
                (e: Error) => check(/exists already/.test(e.message) && steps() === nQ + 1, '(ii) a new holder of an earlier batch named again: refused, no step: ' + e.message)
            );
            await undoChange(host, { mod: mod.id });
            check(sameQ(beforeQ, folderQ()) && steps() === nQ, '(ii) undone: the mod folder Buffer.equals its snapshot');
            // (ii') the first entry's key is the new holder's own: the second entry goes into the holder, found again by its
            // line (create.ts madeHolders), not into the option of the same name inside it
            {
                const rule3: [string, string][] = [['type', 'game_rule_options'], ['newHolder', 'edit_q_rule3'], ['newHolderName', 'Q Rule 3']];
                const r3 = await createEntries(host, [
                    { what: 'entry', key: 'edit_q_rule3', fields: rule3 },
                    { what: 'entry', key: 'edit_q_option_h', fields: rule3, loc: 'Q option H' }
                ]);
                const f3 = holdingQ(/edit_q_rule3 = \{/);
                const top = f3.length === 1 ? parse(readFileSync(join(root, f3[0]), 'utf8')).filter((n) => n.k === 'edit_q_rule3') : [];
                const kids = top.length === 1 && Array.isArray(top[0].v) ? top[0].v.filter((n) => Array.isArray(n.v)).map((n) => n.k) : [];
                const inner = top.length === 1 && Array.isArray(top[0].v) ? top[0].v.find((n) => n.k === 'edit_q_rule3') : undefined;
                check(
                    f3.length === 1 && top.length === 1 && kids.join(' ') === 'edit_q_rule3 edit_q_option_h' && Array.isArray(inner?.v) && !inner.v.length &&
                        holdingQ(/edit_q_option_h:0 "Q option H"/).length === 1 && steps() === nQ + 1,
                    `(ii') an option keyed as its new rule, then a second option: one rule in ${f3.join(', ')} holding ${kids.join(', ')} (the first option empty: ${Array.isArray(inner?.v) && !inner.v.length}), one step (${steps() - nQ}) (${r3.notes.join('; ')})`
                );
                const u3 = await undoChange(host, { mod: mod.id });
                check(u3 && !u3.refused && sameQ(beforeQ, folderQ()) && steps() === nQ, "(ii') one undo takes the rule and both options back: the mod folder Buffer.equals its snapshot");
            }
            // (iii) the same inside a statement's edit (ScriptEditRequest.creates, the picker's real path): the statement, the
            // new holder and both entries, one step
            ev = story();
            const rule2: [string, string][] = [['type', 'game_rule_options'], ['newHolder', 'edit_q_rule2'], ['newHolderName', 'Q Rule 2']];
            const riii = await editScript(host, {
                op: 'insert',
                where: 'inside',
                at: ev.sections!.immediate.src!,
                text: 'add_gold = 4',
                creates: [
                    { what: 'entry', key: 'edit_q_option_f', fields: rule2, loc: 'Q option F' },
                    { what: 'entry', key: 'edit_q_option_g', fields: rule2, loc: 'Q option G' }
                ]
            });
            const fiii = holdingQ(/edit_q_rule2 = \{/);
            const bodyIII = fiii.length ? readFileSync(join(root, fiii[0]), 'utf8') : '';
            check(
                /add_gold = 4/.test(read(EV)) && countIn(/(^|\n)edit_q_rule2 = \{/g) === 1 && /edit_q_rule2 = \{[\s\S]*edit_q_option_f = \{[\s\S]*edit_q_option_g = \{/.test(bodyIII) &&
                    countIn(/edit_q_rule2:0 "Q Rule 2"/g) === 1 && holdingQ(/edit_q_option_f:0 "Q option F"/).length === 1 && holdingQ(/edit_q_option_g:0 "Q option G"/).length === 1 &&
                    riii.step !== undefined && steps() === nQ + 1,
                `(iii) a statement with two entries into one new holder: the statement, one holder in ${fiii.join(', ')}, both entries, one name line each, one step (${steps() - nQ}) (${riii.notes.join('; ')})`
            );
            const uiii = await undoChange(host, { mod: mod.id });
            check(uiii && !uiii.refused && sameQ(beforeQ, folderQ()) && steps() === nQ, '(iii) one undo takes the statement, the holder and both entries back: the mod folder Buffer.equals its snapshot');
        }
        finally
        {
            host.refreshFiles = recording;
        }

        check(reindexed > 0, `the block's host re-indexed on each refresh (${reindexed}×)`);
        await reindex();
        ev = story();

        // a new text version's key travels with the statement (textVariants.ts: a `loc` create, empty): one step, the yml
        // holds the empty key, one undo leaves the mod folder Buffer.equals to its snapshot; a refused statement leaves no key
        {
            const KQ = 'court.8190.t.2';
            const nL = steps();
            const beforeL = folderQ();
            const title = ev.titleSrc ? (await statementText(host, ev.titleSrc)).text : '';
            const old = /^title\s*=\s*(\S+)$/.exec(title.trim())?.[1];
            check(!!old && !idx.detail('localization', KQ), `the event's title is one key (${show(title)}), ${KQ} is not a text yet`);
            const variant = `title = {\n\tfirst_valid = {\n\t\ttriggered_desc = {\n\t\t\ttrigger = { is_adult = yes }\n\t\t\tdesc = ${KQ}\n\t\t}\n\t\tdesc = ${old}\n\t}\n}`;
            const rl = await editScript(host, { op: 'replace', at: ev.titleSrc!, text: variant, creates: [{ what: 'loc', key: KQ, fields: [], loc: '' }] });
            const ymls = holdingQ(new RegExp(`(^|\\n) ${KQ.replace(/\./g, '\\.')}:0 ""\\r?(\\n|$)`));
            check(
                read(EV).includes(`desc = ${KQ}`) && ymls.length === 1 && /^localization\/english\/[^/]+_l_english\.yml$/.test(ymls[0]) && rl.step !== undefined && steps() === nL + 1,
                `a text version with its key in the same request: the statement and the empty key in ${ymls.join(', ')}, one step (${steps() - nL})`
            );
            const ul = await undoChange(host, { mod: mod.id });
            check(ul && !ul.refused && sameQ(beforeL, folderQ()) && steps() === nL, 'one undo takes the text version and its key back: the mod folder Buffer.equals its snapshot');
            await editScript(host, { op: 'replace', at: ev.titleSrc!, text: 'title = {', creates: [{ what: 'loc', key: KQ, fields: [], loc: '' }] }).then(
                () => check(false, 'a refused text version with its key is refused'),
                (e: Error) => check(sameQ(beforeL, folderQ()) && steps() === nL, 'a refused statement with its text key: nothing left behind, no step: ' + e.message)
            );
        }
    }

    // --- undo (undo.ts): kept in the data folder, read again as after a restart, then every edit, newest first; the
    // files are the copies again, byte for byte
    const steps = journalOf(host).list(mod.id);
    check(steps.length === 21 && steps.filter((s) => s.kind === 'override').length === 3 && steps[0].kind === 'edit', `21 undo steps (18 edits, 3 overrides): ${steps.map((s) => s.kind).join(' ')}`);
    dropJournals();
    check(journalOf(host).list(mod.id).length === 21 && existsSync(join(tmp, 'data', 'undo', 'journal.json')), 'the steps are read again from the data folder (a restart)');
    // (a change made in another editor since the last edit: that undo is refused, nothing written)
    const last = read(EV);
    writeFileSync(join(root, EV), last + '\r\n# a note\r\n');
    const refusedU = await undoChange(host, { mod: mod.id });
    check(refusedU?.refused && /changed since/.test(refusedU.refused) && read(EV) === last + '\r\n# a note\r\n', 'undo of a file changed since is refused, nothing written: ' + refusedU?.refused);
    writeFileSync(join(root, EV), last);
    let undone = 0;

    while (journalOf(host).list(mod.id)[0]?.kind === 'edit')
    {
        const u = await undoChange(host, { mod: mod.id });

        if (!u)
            break;

        undone++;
    }

    check(readFileSync(join(root, EV)).equals(original.ev) && readFileSync(join(root, TR)).equals(original.tr), `undo ×${undone}: both files are byte for byte what the override wrote`);
    check(scriptProblems(read(EV).slice(1)).length === 0, 'the undone file parses cleanly');
    // the overrides too: the files they made go, and the folders made for them
    const u1 = await undoChange(host, { mod: mod.id });
    const u2 = await undoChange(host, { mod: mod.id });
    const u3 = await undoChange(host, { mod: mod.id });
    check(u3?.removed.join() === EV && !existsSync(join(root, EV)) && !existsSync(join(root, 'events')) && !existsSync(join(root, 'common')), `undoing the overrides removes the files they made (${[u1, u2, u3].map((u) => u?.label).join('; ')}) and the folders made for them`);
    check(existsSync(join(root, 'descriptor.mod')) && (await undoChange(host, { mod: mod.id })) === null, 'nothing left to undo; the mod folder itself stays');
    // (undone steps stay as redo entries: their bytes (before and after) are kept for redo, nothing else)
    const journal = JSON.parse(readFileSync(join(tmp, 'data', 'undo', 'journal.json'), 'utf8')) as { steps: { files: { blob?: string; }[]; }[]; redos?: { step: { files: { blob?: string; }[]; }; files: { blob?: string; }[]; }[]; };
    const forRedo = new Set((journal.redos ?? []).flatMap((r) => [...r.step.files, ...r.files].map((f) => f.blob)));
    const blobs = readdirSync(join(tmp, 'data', 'undo')).filter((f) => f !== 'journal.json');
    check(journal.steps.length === 0 && blobs.every((b) => forRedo.has(b)), 'the journal’s folder keeps only the bytes of the undone changes, for redo: ' + blobs.filter((b) => !forRedo.has(b)).join(', '));

    // --- round 13: texts the cards read without a statement of their own (Line.locKey with Line.locAt, titleKey), a
    // game scripted effect's text in a mod's entry (an override of just its key in the replace folder), each name of a
    // name list linking to its key's card
    {
        const vsb = new StoryBuilder(vanilla);
        const all = (c: EntityCard): Line[] => flat(c.sections.flatMap((s) => s.lines));
        const first = (type: string, ok: (c: EntityCard) => boolean, prefer?: string): string | undefined =>
        {
            for (const name of [...(prefer ? [prefer] : []), ...vanilla.names(type)])
            {
                const e = vanilla.get(type, name);

                if (e && ok(vsb.card(e)))
                    return name;
            }

            return undefined;
        };
        // (the derived NOT_ text and a message's default text: lines with a key and no statement)
        const notLine = (c: EntityCard): Line | undefined => all(c).find((l) => l.locKey?.startsWith('NOT_') && !l.src);
        const dfltLine = (c: EntityCard): Line | undefined => all(c).find((l) => l.locKey && !l.src);
        const picks: [string, string | undefined][] = [
            ['dynasty_house_mottos', first('dynasty_house_mottos', (c) => c.sections.some((s) => s.lines.length > 0), 'by_x_and_y')],
            ['dynasty_house_motto_inserts', first('dynasty_house_motto_inserts', (c) => all(c).length > 0, 'noun_immaterial')],
            ['religion/holy_site_types', first('religion/holy_site_types', () => true, 'jerusalem')],
            ['game_concepts', first('game_concepts', (c) => c.sections.some((s) => s.title === 'Also called'), 'vassal')],
            ['trigger_localization', first('trigger_localization', (c) => !!notLine(c))],
            ['messages', first('messages', (c) => !!dfltLine(c))],
            ['bookmarks/bookmarks', first('bookmarks/bookmarks', () => true, 'bm_867_iberia')]
        ];
        check(picks.every(([, n]) => n), 'round 13 samples: ' + picks.map(([t, n]) => `${t}:${n}`).join(' '));
        // (the vanilla entries: their texts carry the keys, but no locAt of a mod: no "✎ text" there)
        const vb = vsb.card(vanilla.get('bookmarks/bookmarks', picks[6][1]!)!);
        check(all(vb).every((l) => !l.locAt?.mod), 'the game’s bookmark: no line’s text owner is a mod');
        check(vsb.card(vanilla.get('dynasty_house_mottos', picks[0][1]!)!).titleKey === 'motto_' + picks[0][1], 'a motto’s title key is motto_<key>');
        // name lists: every name of a list links to its key's card (folded under a sample when long)
        const nl = vanilla.names('culture/name_lists').map((n) => vsb.card(vanilla.get('culture/name_lists', n)!)).find((c) => all(c).some((l) => l.collapsed && l.children?.length));
        const folded = nl && all(nl).find((l) => l.collapsed && l.children?.[0]?.text.some((s) => typeof s !== 'string' && s.ref?.type === 'localization'));
        const links = (folded?.children?.[0].text ?? []).filter((s): s is Exclude<typeof s, string> => typeof s !== 'string' && s.ref?.type === 'localization');
        const n0 = Number(/^(\d+)/.exec(folded ? txt(folded) : '')?.[1] ?? -1);
        const resolved = links.filter((s) => vanilla.get('localization', s.ref!.name)).length;
        check(links.length > 12 && links.length === n0 && resolved === links.length, `name list ${nl?.key.name}: ${links.length} names linked to their key's card (the line says ${n0}; ${resolved} keys are localization entries)`);

        for (const [type, name] of picks)
            await applyOverride(host, { type, name: name!, mode: 'copy' });

        // (an event of the mod calling a game scripted effect whose first line is a custom tooltip)
        const EV13 = 'events/zz_b2_texts.txt';
        mkdirSync(join(root, 'events'), { recursive: true });
        writeFileSync(join(root, EV13), 'namespace = b2test\n\nb2test.0001 = {\n\ttype = character_event\n\ttitle = b2test.0001.t\n\tdesc = b2test.0001.desc\n\ttheme = default\n\timmediate = {\n\t\tdog_got_pregnant_effect = yes\n\t\tadd_gold = 100\n\t}\n\toption = {\n\t\tname = b2test.0001.a\n\t}\n}\n');
        // (two dynasties of the mod: one with its own name key and the shared prefix dynnp_de, one with a game name key)
        const DYN13 = 'common/dynasties/zz_b2_dynasties.txt';
        const DLOC13 = 'localization/english/zz_b2_dyn_l_english.yml';
        mkdirSync(join(root, 'common', 'dynasties'), { recursive: true });
        mkdirSync(join(root, 'localization', 'english'), { recursive: true });
        writeFileSync(join(root, DYN13), 'b2dyn_own = {\n\tname = "dynn_b2_own"\n\tprefix = "dynnp_de"\n\tmotto = "dynn_b2_motto"\n}\n\nb2dyn_game = {\n\tname = "dynn_Li_674E"\n}\n');
        writeFileSync(join(root, DLOC13), '﻿l_english:\n dynn_b2_own:0 "Bitwood"\n dynn_b2_motto:0 "Ever onward"\n');
        await reindex();
        const mc = (type: string, name: string): EntityCard => sb.card(idx.get(type, name)!);
        // a dynasty's settings: the motto and a name key of the mod's own carry their key; a prefix (a shared particle)
        // and a name key of the game's do not (saving would change the text of every dynasty that uses it)
        const settings = (name: string): Line[] => mc('dynasties', name).sections.find((s) => s.lines.some((l) => txt(l).startsWith('Name: ')))?.lines ?? [];
        const setLine = (name: string, head: string): Line | undefined => settings(name).find((l) => txt(l).startsWith(head));
        const dOwn = ['Name: ', 'Prefix: ', 'Motto'].map((h) => setLine('b2dyn_own', h));
        const dGame = setLine('b2dyn_game', 'Name: ');
        check(dOwn.every((l) => l) && dOwn[0]!.locKey === 'dynn_b2_own' && !dOwn[1]!.locKey && dOwn[2]!.locKey === 'dynn_b2_motto' && !!dGame && !dGame.locKey, `the mod's dynasties: name ${dOwn[0]?.locKey ?? '-'}, prefix ${dOwn[1]?.locKey ?? '-'}, motto ${dOwn[2]?.locKey ?? '-'}; a game name key: ${dGame ? dGame.locKey ?? '-' : 'no line'}`);
        const ev13s = (): EventStory => sb.eventStory(idx.get('events', 'b2test.0001')!)!;
        const ownText = (l: Line): boolean => !!l.locKey && (l.src?.mod === mod.id || l.locAt?.mod === mod.id);
        const motto = mc('dynasty_house_mottos', picks[0][1]!);
        check(motto.src?.mod === mod.id && motto.titleKey === 'motto_' + picks[0][1], `the mod's motto: its text is the title's key (${motto.titleKey})`);
        const words = mc('dynasty_house_motto_inserts', picks[1][1]!).sections.find((s) => s.title === 'Words')?.lines ?? [];
        check(words.length > 0 && words.every((l) => l.locKey?.startsWith('motto_') && l.locKey === 'motto_' + l.tip && ownText(l)), `the mod's motto words: ${words.length} lines, each with its key (motto_<word>), the mod's`);
        const site = mc('religion/holy_site_types', picks[2][1]!);
        check(site.src?.mod === mod.id && site.titleKey === `holy_site_${picks[2][1]}_name` && site.title === vanilla.plainLoc(site.titleKey)?.trim(), `the mod's holy site: title key ${site.titleKey}, read “${site.title}”`);
        const aliases = mc('game_concepts', picks[3][1]!).sections.find((s) => s.title === 'Also called')?.lines ?? [];
        check(aliases.length > 0 && aliases.every((l) => l.locKey?.startsWith('game_concept_') && l.locAt?.mod === mod.id && !l.src), `the mod's concept: ${aliases.length} aliases, each a line with its key and the definition as owner (no row)`);
        const neg = notLine(mc('trigger_localization', picks[4][1]!));
        check(neg?.locAt?.mod === mod.id && ownText(neg), `the mod's trigger localization: its ${neg?.locKey} line has the variant as owner`);
        const msg = mc('messages', picks[5][1]!);
        const dflt = dfltLine(msg);
        check(dflt?.locAt?.mod === mod.id && dflt.locAt.s === msg.src?.s, `the mod's message: its default text ${dflt?.locKey} has the definition as owner`);
        const bm = all(mc('bookmarks/bookmarks', picks[6][1]!));
        const bmTexts = bm.filter((l) => l.locKey);
        check(bmTexts.length >= 3 && bmTexts.every(ownText) && bmTexts.some((l) => l.locKey === picks[6][1]) && bmTexts.filter((l) => !l.src).length === bmTexts.length, `the mod's bookmark: ${bmTexts.length} texts (its name, the characters' names …), each with the mod's owner and no row of its own`);
        // a game scripted effect's line in the mod's event: the game's (no mod), with its owner and its text's key
        const ev13 = ev13s();
        const tt = flat(ev13.immediate).find((l) => l.src?.owner?.name === 'dog_got_pregnant_effect' && l.locKey);
        const shownLines = flat(ev13.immediate).map((l) => `${txt(l).slice(0, 40)} [${l.icon ?? ''} ${l.src?.owner?.name ?? '-'} ${l.locKey ?? '-'}]`).join(' | ');
        check(ev13.src?.mod === mod.id && tt?.src?.owner?.name === 'dog_got_pregnant_effect' && !tt.src.mod && tt.locKey === 'dog_got_pregnant_tooltip', `the mod's event calls the game's effect: its line “${tt && txt(tt)}” is the game's, with owner and key ${tt?.locKey}${tt ? '' : ' (lines: ' + shownLines + ')'}`);
        // its text changed: an override of just that key in the replace folder (the effect is not copied)
        const before = vanilla.plainLoc('dog_got_pregnant_tooltip');
        const r13 = await editLoc(host, { key: 'dog_got_pregnant_tooltip', text: 'The dog is expecting' });
        const LOC13 = 'localization/english/replace/edit_test_l_english.yml';
        check(r13.rel === LOC13 && readFileSync(join(root, LOC13), 'utf8') === '﻿l_english:\n dog_got_pregnant_tooltip:0 "The dog is expecting"\n' && !existsSync(join(root, 'common', 'scripted_effects')) && r13.notes.length === 1, `the game's text overridden in ${r13.rel}, nothing else (${r13.notes.join('; ')})`);
        await reindex();
        const tt2 = flat(ev13s().immediate).find((l) => l.src?.owner?.name === 'dog_got_pregnant_effect' && l.locKey === 'dog_got_pregnant_tooltip');
        check(tt2 && txt(tt2) === 'The dog is expecting' && before !== 'The dog is expecting', 'story: the effect’s line reads the new text');
        // undo: the text, then the overrides; then the event written by hand
        const kinds13: string[] = [];

        for (let u = await undoChange(host, { mod: mod.id }); u; u = await undoChange(host, { mod: mod.id }))
            kinds13.push(u.kind);

        rmSync(join(root, EV13));
        rmSync(join(root, 'events'), { recursive: true, force: true });
        // (the dynasty and its texts written by hand: the files, then their folders when empty)
        for (const rel of [DYN13, DLOC13])
        {
            rmSync(join(root, rel));

            for (let dir = dirname(join(root, rel)); dir !== root && readdirSync(dir).length === 0; dir = dirname(dir))
                rmSync(dir, { recursive: true });
        }

        const left = readdirSync(root);
        check(kinds13.length === 1 + picks.length && kinds13[0] === 'text' && left.join() === 'descriptor.mod', `round 13 undone (${kinds13.join(' ')}): the mod folder holds only ${left.join(', ')}`);
    }

    // --- round 13 (P3 stage B): comments next to a statement. ✕ remove takes the comment lines above it and the one
    // after it along, and the change bar's note names them; the picker's Change path (InPlaceEdit: statementText, then
    // keepWritten on the picker's text, then a replace) keeps the comments of what it kept or changed, lets those of a
    // statement it removed go (named in the note), and writes nothing when a comment sits inside a statement it
    // replaced (the renderer opens the script editor). Each write undone, the mod folder compared byte for byte.
    // Then a new doctrine parameter: written bare into the doctrine's parameters (round 13 wave 4), the block made where
    // the doctrine has none; undone.
    {
        const folderB = (): Map<string, Buffer> =>
        {
            const out = new Map<string, Buffer>();
            const walk = (dir: string): void =>
            {
                for (const d of readdirSync(dir, { withFileTypes: true }))
                    d.isDirectory() ? walk(join(dir, d.name)) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));
            };
            walk(root);
            return out;
        };
        const sameB = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([p, x]) => b.get(p)?.equals(x));
        const SE = 'common/scripted_effects/edit_test_comments.txt';
        const fileB = join(root, SE);
        const textB = [
            'edit_test_comments_effect = {',
            '\t# the gold',
            '\tadd_gold = 10 # much',
            '\tadd_prestige = 5',
            '\tif = {',
            '\t\tlimit = { is_adult = yes } # grown',
            '\t\t# the reward',
            '\t\tadd_piety = 1',
            '\t\trandom = {',
            '\t\t\tchance = 5 # five',
            '\t\t\tadd_gold = 1',
            '\t\t}',
            '\t}',
            '\t# end',
            '}',
            ''
        ].join('\n');
        mkdirSync(dirname(fileB), { recursive: true });
        writeFileSync(fileB, textB);
        const nB = journalOf(host).list(mod.id).length;
        const beforeB = folderB();
        const atB = (needle: string, kind: LineSource['kind'] = 'effect'): LineSource =>
        {
            const cur = readFileSync(fileB, 'utf8');
            const s = cur.indexOf(needle);
            const a: LineSource = { file: fileB, rel: SE, line: cur.slice(0, s).split('\n').length, s, e: s + needle.length, kind, hash: textHash(cur), mod: mod.id };
            const open = needle.indexOf('{');

            if (open >= 0 && needle.endsWith('}'))
                a.inner = [s + open + 1, s + needle.length - 1];

            return a;
        };
        const ifText = textB.slice(textB.indexOf('if = {'), textB.indexOf('\t}\n\t# end') + 2);

        // ✕ on add_gold = 10: its line with "# much", "# the gold" above it; the note names both
        const r1 = await editScript(host, { op: 'remove', at: atB('add_gold = 10') });
        check(readFileSync(fileB, 'utf8') === textB.replace('\t# the gold\n\tadd_gold = 10 # much\n', '') && r1.notes.length === 1 && r1.notes[0].includes('# the gold') && r1.notes[0].includes('# much'), `remove: the statement and its two comments gone, the note says so (${r1.notes.join('; ')})`);
        let u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && sameB(beforeB, folderB()), 'undone: the mod folder byte for byte as before (the comments back)');

        // the Change path on the if: a value changed inside, every comment kept, no note
        let t = await statementText(host, atB(ifText));
        const changed = keepWritten(t.text, 'if = {\n\tlimit = { is_adult = yes }\n\tadd_piety = 2\n\trandom = {\n\t\tchance = 5\n\t\tadd_gold = 1\n\t}\n}', t.indent);
        const r2 = changed.text !== null ? await editScript(host, { op: 'replace', at: atB(ifText), text: changed.text }) : undefined;
        check(r2 && readFileSync(fileB, 'utf8') === textB.replace('add_piety = 1', 'add_piety = 2') && !r2.notes.length && !changed.gone.length, `change: a value inside the if changed, the file otherwise as written, comments and all (notes: ${r2?.notes.join('; ') || 'none'})`);
        u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && sameB(beforeB, folderB()), 'undone: the mod folder byte for byte as before');

        // the Change path: the random block removed from the if: "# five" goes with it, the note names it
        t = await statementText(host, atB(ifText));
        const removed = keepWritten(t.text, 'if = {\n\tlimit = { is_adult = yes }\n\tadd_piety = 1\n}', t.indent);
        const r3 = removed.text !== null ? await editScript(host, { op: 'replace', at: atB(ifText), text: removed.text }) : undefined;
        const want3 = textB.replace('\t\trandom = {\n\t\t\tchance = 5 # five\n\t\t\tadd_gold = 1\n\t\t}\n', '');
        check(r3 && readFileSync(fileB, 'utf8') === want3 && removed.gone.join() === '# five' && r3.notes.length === 1 && r3.notes[0].includes('# five'), `change: a statement removed inside the if, its comment with it, the others kept, the note says so (${r3?.notes.join('; ')})`);
        u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && sameB(beforeB, folderB()), 'undone: the mod folder byte for byte as before');

        // the Change path: the random block replaced by another statement: "# five" is inside it, nothing is written
        t = await statementText(host, atB(ifText));
        const replaced = keepWritten(t.text, 'if = {\n\tlimit = { is_adult = yes }\n\tadd_piety = 1\n\tadd_dread = 5\n}', t.indent);
        check(replaced.text === null && sameB(beforeB, folderB()) && journalOf(host).list(mod.id).length === nB, 'change: a statement with a comment inside replaced by another: no text to write (the script editor opens), the file as it was');

        // the Change path, replacing the statement the comment above belongs to: "# the reward" goes, "# grown" and "# end" stay
        t = await statementText(host, atB(ifText));
        const swapped = keepWritten(t.text, 'if = {\n\tlimit = { is_adult = yes }\n\tadd_prestige = 2\n\trandom = {\n\t\tchance = 5\n\t\tadd_gold = 1\n\t}\n}', t.indent);
        const r5 = swapped.text !== null ? await editScript(host, { op: 'replace', at: atB(ifText), text: swapped.text }) : undefined;
        check(r5 && readFileSync(fileB, 'utf8') === textB.replace('\t\t# the reward\n\t\tadd_piety = 1\n', '\t\tadd_prestige = 2\n') && r5.notes.length === 1 && r5.notes[0].includes('# the reward'), `change: a statement replaced by another, its comment line with it, the note says so (${r5?.notes.join('; ')})`);
        u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && sameB(beforeB, folderB()) && journalOf(host).list(mod.id).length === nB, 'undone: the mod folder byte for byte as before, the journal as before');
        rmSync(fileB);
        rmSync(join(root, 'common'), { recursive: true, force: true });

        // a new doctrine parameter, written bare: into a doctrine's parameters, and into one without them (the block made)
        const beforeD = folderB();
        const nD = journalOf(host).list(mod.id).length;

        for (const [doctrine, hasBlock] of [['doctrine_polygamy', true], ['doctrine_monotheist', false]] as [string, boolean][])
        {
            const key = 'edit_test_param_' + (hasBlock ? 'a' : 'b');
            const made = await createEntries(host, [{ what: 'doctrine_parameter', key, fields: [['doctrine', doctrine]], loc: 'Test parameter' }]);
            const df = made.files.find((f) => /doctrine_types/.test(f));
            const dtext = df ? readFileSync(df, 'utf8') : '';
            const at = dtext.search(new RegExp(`(^|\\n)${doctrine} = \\{`));
            const body = at >= 0 ? dtext.slice(at, blockClose(dtext, dtext.indexOf('{', at)) + 1) : '';
            const params = /\bparameters = \{[^}]*\}/.exec(body)?.[0] ?? '';
            check(new RegExp(`\\n\\t+${key}\\r?\\n`).test(params) && !new RegExp(`${key}\\s*=`).test(dtext), `a new doctrine parameter of ${doctrine} (${hasBlock ? 'its parameters block' : 'a parameters block made'}): written bare, no “= yes” (${JSON.stringify(params.slice(0, 120))}; ${made.notes.join('; ')})`);

            // (an undo refused or taking nothing back ends the loop: the compare below fails then)
            for (let left = journalOf(host).list(mod.id).length; left > nD;)
            {
                u = await undoChange(host, { mod: mod.id });
                const now = journalOf(host).list(mod.id).length;

                if (!u || u.refused || now >= left)
                    break;

                left = now;
            }

            check(sameB(beforeD, folderB()), `undone: the mod folder byte for byte as before (${readdirSync(root).join(', ')})`);
        }
    }

    // --- round 13 wave 10 (P11r(a)): a written title triple (create / change_title_holder / resolve, next to each other)
    // reads as one line whose anchor spans the three (describer.ts titleTriple); the Change path (statementText,
    // findStatement, the picker's text, keepWritten, one replace) changes its type in one undo step, comments kept; ✕
    // takes the three with the comment above the create; the triple with another statement between stays statement by
    // statement. Each write undone, the mod folder compared with Buffer.equals.
    {
        const folderT = (): Map<string, Buffer> =>
        {
            const out = new Map<string, Buffer>();
            const walk = (dir: string): void =>
            {
                for (const d of readdirSync(dir, { withFileTypes: true }))
                    d.isDirectory() ? walk(join(dir, d.name)) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));
            };
            walk(root);
            return out;
        };
        const sameT = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([p, x]) => b.get(p)?.equals(x));
        const ST = 'common/scripted_effects/edit_test_triple.txt';
        const fileT = join(root, ST);
        const textT = [
            'edit_test_triple_effect = {',
            '\tadd_gold = 1',
            '\t# the change',
            '\tcreate_title_and_vassal_change = {',
            '\t\ttype = granted',
            '\t\tsave_scope_as = change_2',
            '\t\tadd_claim_on_loss = no',
            '\t}',
            '\t# between',
            '\ttitle:k_france = {',
            '\t\tchange_title_holder = {',
            '\t\t\tholder = prev',
            '\t\t\tchange = scope:change_2',
            '\t\t\tgovernment_base = root',
            '\t\t}',
            '\t}',
            '\tresolve_title_and_vassal_change = scope:change_2 # done',
            '\tadd_prestige = 2',
            '\t# another statement between: not one',
            '\tcreate_title_and_vassal_change = { type = granted save_scope_as = change }',
            '\tadd_piety = 1',
            '\ttitle:k_france = { change_title_holder = { holder = root change = scope:change } }',
            '\tresolve_title_and_vassal_change = scope:change',
            '}',
            ''
        ].join('\n');
        mkdirSync(dirname(fileT), { recursive: true });
        writeFileSync(fileT, textT);
        await reindex();
        const nT = journalOf(host).list(mod.id).length;
        const beforeT = folderT();
        const se = idx.get('scripted_effects', 'edit_test_triple_effect');
        const seLines = se ? flat(sb!.card(se).sections.flatMap((s) => s.lines)) : [];
        const given = seLines.filter((l) => txt(l).startsWith('Gives '));
        const src = given[0]?.src;
        const s0 = textT.indexOf('create_title_and_vassal_change');
        const e0 = textT.indexOf('scope:change_2 # done') + 'scope:change_2'.length;
        check(
            given.length === 1 && src?.s === s0 && src.e === e0 && src.mod === mod.id && src.line === 4,
            `one line for the adjacent triple: ${given.map(txt).join(' | ')}; its anchor ${src?.s}-${src?.e} (the create's start ${s0} to the resolve's end ${e0}), line ${src?.line}`
        );
        const second = seLines.filter((l) => /^Create title and vassal change/.test(txt(l)));
        check(second.length === 1 && second[0].src && textT.slice(second[0].src.s, second[0].src.e) === 'create_title_and_vassal_change = { type = granted save_scope_as = change }', `with another statement between: statement by statement (${second.map((l) => txt(l)).join(' | ')})`);

        if (src)
        {
            // the Change path: the type changed to usurped; the change's name, the holder (prev), government_base and every comment kept
            const t = await statementText(host, src);
            const found = findStatement('effect', t.text, 'character');
            const v = found?.values ?? {};
            check(
                // (government_base is a value of the statement since the script database round (4a4c00b): read back as `gov`,
                // nothing left to keep where it was written)
                found?.def.id === 'e.do.give_title' && v.title === 'title:k_france' && v.holder === 'this' && v.type === 'granted' && v.claim === 'no' && v.baronies === '' && v.change === 'change_2' &&
                    v.gov === 'root' && !found.restAt?.length,
                `read back as Give a title: ${JSON.stringify(v)}, kept where written: ${JSON.stringify(found?.restAt?.map((r) => [r.at, r.keys, printScript(r.nodes)]))}`
            );

            if (found)
            {
                // (what the picker writes (model.ts statementNodes): the template filled, the kept fields put back where they were)
                const nodes = parseSnippet(fillTemplate(found.def, { ...v, type: 'usurped' }));

                for (const r of found.restAt ?? [])
                {
                    let place = nodes[r.at];

                    for (const k of r.keys)
                        place = place?.kids?.find((x) => x.k === k)!;

                    place?.kids?.push(...r.nodes);
                }

                const kept = keepWritten(t.text, printScript(nodes), t.indent);
                const r1 = kept.text !== null ? await editScript(host, { op: 'replace', at: src, text: kept.text, ...(replacesStatement(t.text, kept.text) ? { withComments: true } : {}) }) : undefined;
                check(
                    r1 && readFileSync(fileT, 'utf8') === textT.replace('type = granted\n\t\tsave_scope_as = change_2', 'type = usurped\n\t\tsave_scope_as = change_2') && !r1.notes.length && journalOf(host).list(mod.id).length === nT + 1,
                    `change: the type of the three is usurped, everything else as written, comments and all, one step (${kept.text === null ? 'not kept: ' + kept.why : 'notes: ' + (r1?.notes.join('; ') || 'none')})`
                );
                const u1 = await undoChange(host, { mod: mod.id });
                check(u1 && !u1.refused && sameT(beforeT, folderT()) && journalOf(host).list(mod.id).length === nT, 'undone: the mod folder Buffer.equals its snapshot');
            }

            // ✕: the three and the comment above the create (and the one between, and the one after the resolve) go, one step
            const r2 = await editScript(host, { op: 'remove', at: src });
            const gone = textT.slice(textT.indexOf('\t# the change'), textT.indexOf('\tadd_prestige = 2'));
            check(
                readFileSync(fileT, 'utf8') === textT.replace(gone, '') && r2.notes.length === 1 && ['# the change', '# between', '# done'].every((c) => r2.notes[0].includes(c)) && journalOf(host).list(mod.id).length === nT + 1,
                `remove: the three statements and their comments gone, the note says so, one step (${r2.notes.join('; ')})`
            );
            const u2 = await undoChange(host, { mod: mod.id });
            check(u2 && !u2.refused && sameT(beforeT, folderT()) && journalOf(host).list(mod.id).length === nT, 'undone: the mod folder Buffer.equals its snapshot');
        }

        rmSync(fileT);
        rmSync(join(root, 'common'), { recursive: true, force: true });
    }

    // A written `track` turned into `tracks` by a new named track (the owner's choice, 2026-11-15; ScriptEditRequest.fromTrack):
    // the card's "＋ named track" on a mod trait with `track` alone, the edit as the picker's Done sends it: the block becomes
    // `tracks` with its track named after the trait and the new one after it, the mod's add_trait_xp / has_trait_xp of the
    // trait without a track get `track = <trait>` (one written already and another trait's left alone), one undo step;
    // undone, the mod folder Buffer.equals its snapshot.
    {
        const folderK = (): Map<string, Buffer> =>
        {
            const out = new Map<string, Buffer>();
            const walk = (dir: string): void =>
            {
                for (const d of readdirSync(dir, { withFileTypes: true }))
                    d.isDirectory() ? walk(join(dir, d.name)) : out.set(join(dir, d.name), readFileSync(join(dir, d.name)));
            };
            walk(root);
            return out;
        };
        const sameK = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([p, x]) => b.get(p)?.equals(x));
        const fileK = join(root, 'common/traits/edit_test_track.txt');
        const textK = 'edit_test_track_trait = {\n\tcategory = lifestyle\n\ttrack = {\n\t\t50 = {\n\t\t\tprowess = 1\n\t\t}\n\t}\n}\n';
        const fileE = join(root, 'events/edit_test_track_events.txt');
        const textE = [
            'namespace = edit_test_track',
            '',
            'edit_test_track.1 = {',
            '\ttype = character_event',
            '\timmediate = {',
            '\t\tadd_trait_xp = { trait = edit_test_track_trait value = 10 }',
            '\t\tif = {',
            '\t\t\tlimit = {',
            '\t\t\t\thas_trait_xp = {',
            '\t\t\t\t\ttrait = edit_test_track_trait',
            '\t\t\t\t\tvalue >= 50',
            '\t\t\t\t}',
            '\t\t\t}',
            '\t\t\tadd_trait_xp = { trait = edit_test_track_trait track = edit_test_track_trait value = 5 }',
            '\t\t}',
            '\t\tadd_trait_xp = { trait = lifestyle_hunter track = falconer value = 1 }',
            '\t}',
            '}',
            ''
        ].join('\n');
        mkdirSync(dirname(fileK), { recursive: true });
        mkdirSync(dirname(fileE), { recursive: true });
        writeFileSync(fileK, textK);
        writeFileSync(fileE, textE);
        await reindex();
        const nK = journalOf(host).list(mod.id).length;
        const beforeK = folderK();
        const tt = idx.get('traits', 'edit_test_track_trait');
        const rows = tt ? flat(sb!.card(tt).sections.flatMap((s) => s.lines)) : [];
        const row = rows.find((l) => l.act?.label === '＋ named track');
        const act = row?.act?.do as { kind: string; at?: { src?: LineSource; fromTrack?: string; hint?: { common?: string[]; }; }; } | undefined;
        const at = act?.kind === 'add' ? act.at : undefined;
        check(at?.fromTrack === 'edit_test_track_trait' && at.src?.fields === 'trait_tracks' && at.hint?.common?.join() === 'edit_test_track_trait' && at.src && textK.slice(at.src.s, at.src.e).startsWith('track = {'), `the card: "＋ named track" on a mod trait with track alone, into its track block (${JSON.stringify({ fromTrack: at?.fromTrack, fields: at?.src?.fields, common: at?.hint?.common })})`);

        if (at?.src)
        {
            const r = await editScript(host, { op: 'insert', at: at.src, where: 'inside', fromTrack: at.fromTrack, text: 'hawker = { 50 = { } }', label: 'Added: a named track' });
            const wantK = 'edit_test_track_trait = {\n\tcategory = lifestyle\n\ttracks = {\n\t\tedit_test_track_trait = {\n\t\t\t50 = {\n\t\t\t\tprowess = 1\n\t\t\t}\n\t\t}\n\t\thawker = { 50 = { } }\n\t}\n}\n';
            const wantE = textE
                .replace('add_trait_xp = { trait = edit_test_track_trait value = 10 }', 'add_trait_xp = { trait = edit_test_track_trait track = edit_test_track_trait value = 10 }')
                .replace('\t\t\t\t\ttrait = edit_test_track_trait\n', '\t\t\t\t\ttrait = edit_test_track_trait\n\t\t\t\t\ttrack = edit_test_track_trait\n');
            const gotK = readFileSync(fileK, 'utf8');
            const gotE = readFileSync(fileE, 'utf8');
            check(gotK === wantK, `the trait: track became tracks, its track named after the trait, the new one after it:\n${gotK}`);
            check(gotE === wantE, `the calls: the two without a track got track = edit_test_track_trait (one inline, one on a line of its own), the written one and another trait's left alone:\n${gotE}`);
            check(r.notes.some((x) => x.includes('now written as tracks')) && r.notes.some((x) => x.startsWith('2 add_trait_xp / has_trait_xp')) && journalOf(host).list(mod.id).length === nK + 1, `one undo step, the notes say both (${r.notes.join(' | ')})`);
            const u = await undoChange(host, { mod: mod.id });
            check(u && !u.refused && sameK(beforeK, folderK()) && journalOf(host).list(mod.id).length === nK, 'one undo takes back the trait and the calls: the mod folder Buffer.equals its snapshot');
        }

        rmSync(fileK);
        rmSync(fileE);
        rmSync(join(root, 'common'), { recursive: true, force: true });
    }
}
finally
{
    console.log(failures ? `\n${failures} FAILED` : '\nall ok', `(temp user folder ${tmp})`);

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
