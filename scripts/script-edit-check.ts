// Checks editing in place (src/main/mods/scriptEdit.ts, line anchors of src/main/describe) against a TEMP user folder
// with a temp mod: the text operations on small samples, then court.8190 and the traits brave / craven copied into the
// mod with the override code, the mod layered over the vanilla index, and edit / remove / insert run through the
// anchors of the readable view — the files checked byte for byte, parsed, re-indexed and described again. The real
// user folder is never used.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/script-edit-check.ts [keep]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntityCard, EventStory, Line, LineSource, ModInfo, OnActionStory, ScriptEditRequest, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { applyOverride } from '../src/main/mods/edit.ts';
import { createEntries, createEntry } from '../src/main/mods/create.ts';
import { modsState, type ModsHost } from '../src/main/mods/manager.ts';
import { applyEdit, checkEdit, editLoc, editScript, isCodeComment, locate, scriptProblems, statementText } from '../src/main/mods/scriptEdit.ts';
import { dropJournals, forgetChange, journalOf, undoChange } from '../src/main/mods/undo.ts';
import { stmtCheck, textHash } from '../src/main/indexer/override.ts';
import { parse } from '../src/main/indexer/parser.ts';
import { rootCtx } from '../src/main/describe/describer.ts';
import { defaultInstall } from './ck3-install.ts';

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
    check(found('ev = {\n' + opt('b') + opt('c') + '}\n', goldB) === 'name = b\n\t\t|add_gold = 100|4', 'located: option a removed above — option b’s add_gold, not c’s now at its old place: ' + found('ev = {\n' + opt('b') + opt('c') + '}\n', goldB));
    check(found(three.replace('name = c', 'name = c\n\t\tadd_piety = 5'), goldB) === `name = b\n\t\t|add_gold = 100|${goldB.line}`, 'located: a change below it — at its place');
    check(found('ev = {\n' + opt('a') + '\toption = {\n\t\tname = b\n\t\tadd_gold   =   100\n\t}\n' + opt('c') + '}\n', goldB).includes('|add_gold   =   100|'), 're-spaced (whitespace only): found');
    check(found(three.replace(opt('b'), opt('b').replace('100', '200')), goldB).startsWith('refused: x.txt: the statement at line 8 changed since'), 'the statement itself changed: refused');
    const five = 'ev = {\n' + opt('b').repeat(5) + '}\n';
    check(found('ev = {\n\tx = 1\n' + five.slice(7), anchor(five, 'add_gold = 100', 1)).startsWith('refused'), 'two the same, the same around them, neither at its place: refused');
    check(found('ev = {\n' + opt('b') + opt('b') + opt('c') + '}\n', goldB).includes('name = b\n\t\t|add_gold = 100|8'), 'two the same: the one with the same text after it');
    const optB = anchor(three, opt('b').trim(), 0, true);
    const moved = locate('ev = {\n' + opt('b') + opt('c') + '}\n', optB);
    check(moved.s === 8 && moved.inner![0] === moved.s + 10 && moved.inner![1] === moved.e - 1, 'a block found again: its inner offsets follow');
    check(found(three.replace('name = c', 'name = d'), anchor(three, 'add_gold = 100', 2)) === 'name = d\n\t\t|add_gold = 100|12', 'the text before it changed, the one after not: still found (the only one that fits)');
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
const vanilla = new GameIndex(new GameFiles(gameDir), 'english');
vanilla.build();

// (the readable view reads an iterator's count with every operator — the picker's "How many of them…" writes them)
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
    refreshFiles: async (files) => void refreshed.push(...files),
    // (the undo steps are kept there — undo.ts; dropJournals() reads them again, as after a restart)
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
function reindex(): void
{
    const t = Date.now();
    idx = new GameIndex(new GameFiles(gameDir!, [mod]), 'english');
    idx.build();
    sb = new StoryBuilder(idx);
    console.log(`  (re-indexed with the mod in ${Date.now() - t} ms)`);
}
const story = (): EventStory => sb.eventStory(idx.get('events', 'court.8190')!)!;
const card = (name: string): EntityCard => sb.card(idx.get('traits', name)!);
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
/** Everything outside [from, to) of the old text is unchanged in the new one, byte for byte. */
const keeps = (before: string, after: string, from: number, to: number): boolean => after.startsWith(before.slice(0, from)) && after.endsWith(before.slice(to));

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
    reindex();

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
    reindex();
    ev = story();
    let texts = storyTexts(ev);
    const imm = flat(ev.immediate);
    check(txt(imm[imm.length - 1]) === '+100 Gold' && imm[imm.length - 1].src?.rel === EV, 'story: “+100 Gold” is the last line of Right away, anchored');
    check(JSON.stringify(texts.filter((t, i) => !(t === 'I +100 Gold' && i === texts.indexOf('I +100 Gold')))) === JSON.stringify(oldTexts), `the other ${oldTexts.length} story lines are unchanged`);
    brave = card('brave');
    check(brave.sections.find((s) => s.title === 'Modifiers')!.lines.some((l) => txt(l) === '+4 Martial'), 'card: +4 Martial');
    // a stale anchor (the file changed since): refused
    await editScript(host, { op: 'remove', at: im }).then(
        () => check(false, 'a stale anchor is refused'),
        (e: Error) => check(/changed since/.test(e.message), 'a stale anchor (made before the last edit) is refused: ' + e.message)
    );

    // --- round 2: replace the new line · remove the only condition · insert a modifier into the trait
    const gold = flat(ev.immediate).find((l) => txt(l) === '+100 Gold')!;
    before = read(EV);
    await editScript(host, { op: 'replace', at: gold.src!, text: 'add_gold = 250' });
    check(read(EV) === before.slice(0, gold.src!.s + 1) + 'add_gold = 250' + before.slice(gold.src!.e + 1), 'replace add_gold = 100 → 250');
    // (the file changed since the anchors were made: they are found again by their own text — round 6 tries that)
    brave = card('brave');
    const own = brave.sections.find((s) => s.title === 'Modifiers')!.src!.src!;
    await editScript(host, { op: 'insert', where: 'inside', at: own, text: 'diplomacy = 1' });
    check(read(TR).includes('\tdiplomacy = 1\n}') && scriptProblems(read(TR).slice(1)).length === 0, 'trait: diplomacy = 1 added at the end of its block');
    reindex();
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
    reindex();
    ev = story();
    check(ev.conditions.length === 0 && ev.sections!.trigger.src?.inner, 'story: no conditions; the empty trigger block is still there to add to');
    brave = card('brave');
    check(!brave.sections.find((s) => s.title === 'Modifiers')!.lines.some((l) => /Prowess/.test(txt(l))), 'card: no prowess');

    // --- round 4: add a condition into the empty trigger · create `after` · create option a's trigger · remove craven
    await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.trigger.src!, text: 'is_adult = yes' });
    reindex();
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
    reindex();
    ev = story();
    check(flat(ev.after).some((l) => txt(l) === '+50 Prestige'), 'story: Afterwards +50 Prestige');
    check(idx.get('traits', 'craven') && !idx.detail('traits', 'craven')!.defs.some((d) => d.file === TR), 'craven: the game’s definition only');

    // --- round 5: a trigger for option a (created in the option) · remove the last option · add an option
    const optA = ev.options[0];
    await editScript(host, { op: 'insert', where: 'inside', at: optA.trigger!.parent!, wrap: 'trigger', text: 'age >= 16' });
    reindex();
    ev = story();
    check(ev.options[0].conditions.some((l) => /age/i.test(txt(l)) && /16/.test(txt(l))), 'option a: “Only if” age ≥ 16: ' + ev.options[0].conditions.map(txt).join('; '));
    const n = ev.options.length;
    await editScript(host, { op: 'remove', at: ev.options[n - 1].src! });
    reindex();
    ev = story();
    check(ev.options.length === n - 1, `the last option removed (${n} → ${ev.options.length})`);
    await editScript(host, { op: 'insert', where: 'inside', at: ev.src!, text: 'option = {\n\tname = court.8190.z\n\tadd_gold = 5\n}' });
    reindex();
    ev = story();
    check(ev.options.length === n && flat(ev.options[n - 1].effects).some((l) => txt(l) === '+5 Gold'), 'an option added at the end of the event');

    // --- round 6: anchors of a file changed since (no re-index between the edits) — found again by their own text
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
    await editScript(host, { op: 'insert', where: 'inside', at: optionA, text: 'add_dread = 1' }).then(
        () => check(false, 'the stale anchor of option a (changed itself) is refused'),
        (e: Error) => check(/changed since/.test(e.message), 'the stale anchor of option a (the block changed itself) is refused: ' + e.message)
    );
    const src6 = await statementText(host, five);
    check(src6.problem && /changed since/.test(src6.problem), 'the replaced statement’s old anchor: no text for the editor (' + src6.problem + ')');

    // --- round 7: an if with one condition: that condition, shown in the if's text, is edited on its own (Line.condSegs)
    reindex();
    ev = story();
    await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.immediate.src!, text: 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 10\n}' });
    reindex();
    ev = story();
    const ifLine = flat(ev.immediate).find((l) => l.condSegs && l.children?.some((c) => txt(c) === '+10 Gold'))!;
    const segs = ifLine && txt({ text: ifLine.text.slice(...ifLine.condSegs!) } as Line);
    check(ifLine && ifLine.ifConds?.length === 1 && ifLine.ifConds[0].src?.mod === mod.id && segs === 'is an adult' && txt(ifLine) === `If ${segs}:`, `the if reads “${ifLine && txt(ifLine)}”: its condition's segments “${segs}”, anchored on their own`);
    const own7 = await statementText(host, ifLine.ifConds![0].src!);
    check(own7.text === 'is_adult = yes', 'the condition’s own script: ' + show(own7.text));
    await editScript(host, { op: 'replace', at: ifLine.ifConds![0].src!, text: 'is_female = yes' });
    check(/limit = \{ is_female = yes \}\r\n\t+add_gold = 10/.test(read(EV)), 'the condition replaced inside the one-line limit');
    reindex();
    ev = story();
    check(
        flat(ev.immediate).some((l) => l.condSegs && /^If .*female/i.test(txt(l)) && l.children?.some((c) => txt(c) === '+10 Gold')),
        'story: the if reads its new condition: ' + flat(ev.immediate)
            .filter((l) => l.condSegs)
            .map(txt)
            .join(' | ')
    );

    // --- round 8: an on_action of the mod (a new one: `effect = { }` only) — its sections are anchored: an event into
    // its `events` (the list made), a random event, an effect; ✕ on a list entry (then its steps undone)
    const made = await createEntry(host, { type: 'on_action', key: 'edit_test_on_check' });
    reindex();
    const oa = (): OnActionStory => sb.onActionStory(idx.get('on_action', 'edit_test_on_check')!);
    let o = oa();
    check(o.src?.mod === mod.id && o.sections?.effect.src?.inner && !o.sections.events.src && o.sections.events.parent?.inner && o.sections.random_events.parent, `on_action ${made.rel}: anchored; effect a block, events / random_events made in it`);
    await editScript(host, { op: 'insert', where: 'inside', at: o.sections!.events.parent!, wrap: 'events', text: 'court.8190' });
    // (the on_action's block changed itself: its stale anchor is refused until the index has the file)
    await editScript(host, { op: 'insert', where: 'inside', at: o.sections!.random_events.parent!, wrap: 'random_events', text: '100 = court.8190' }).then(
        () => check(false, 'the on_action block changed itself: a stale anchor is refused'),
        (e: Error) => check(/changed since/.test(e.message), 'the on_action block changed itself: its stale anchor is refused')
    );
    reindex();
    o = oa();
    const effect8 = o.sections!.effect.src!;
    await editScript(host, { op: 'insert', where: 'inside', at: o.sections!.random_events.parent!, wrap: 'random_events', text: '100 = court.8190' });
    // (the effect block did not change: its anchor, made before, is found again)
    await editScript(host, { op: 'insert', where: 'inside', at: effect8, text: 'add_gold = 5' });
    const oaText = readFileSync(made.file, 'utf8').replace(/\r\n/g, '\n');
    check(/edit_test_on_check = \{\n\teffect = \{\n\t\tadd_gold = 5\n\t\}\n\tevents = \{\n\t\tcourt\.8190\n\t\}\n\trandom_events = \{\n\t\t100 = court\.8190\n\t\}\n\}/.test(oaText), 'written: events and random_events lists made, the effect added: ' + show(oaText.slice(oaText.indexOf('edit_test_on_check'))));
    reindex();
    o = oa();
    check(o.events.length === 1 && o.events[0].target.name === 'court.8190' && o.events[0].src?.mod === mod.id && o.randomEvents.length === 1 && flat(o.effects).some((l) => txt(l) === '+5 Gold'), 'story: always fires court.8190 (its entry anchored), one random event, +5 Gold');
    await editScript(host, { op: 'remove', at: o.events[0].src! });
    check(!/\tevents = /.test(readFileSync(made.file, 'utf8')) && /random_events/.test(readFileSync(made.file, 'utf8')), '✕ on the list’s only entry: the list goes with it: ' + show(readFileSync(made.file, 'utf8').slice(-80)));
    const kinds8: string[] = [];

    for (let i = 0; i < 5; i++)
        kinds8.push((await undoChange(host, { mod: mod.id }))!.kind);

    check(kinds8.join() === 'edit,edit,edit,edit,create' && !existsSync(made.file), `round 8 undone (${kinds8.join(' ')}): the on_action's file is gone again`);

    // --- round 9: lines of an inlined scripted effect are its own text (LineSource.owner) — the mod's file-local
    // employed_booner_reward_effect (a $POS$ filled in: offsets mapped back), then a game effect overridden into the mod
    reindex();
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
    reindex();
    ev = story();
    const gameCall = flat(ev.immediate).find((l) => l.icon === 'call' && /disburse/i.test(txt(l)))!;
    const gameLine = gameCall?.children?.find((l) => l.src)!;
    check(gameLine?.src?.owner?.name === 'disburse_activity_stress_loss' && !gameLine.src.mod && gameLine.src.rel === 'common/scripted_effects/00_activity_effects.txt' && gameLine.src.stmt, `a game effect's line “${gameLine && txt(gameLine)}”: the game's anchor (no mod) with its owner and checks`);
    const ov = await applyOverride(host, { type: 'scripted_effects', name: 'disburse_activity_stress_loss', mode: 'copy' });
    reindex();
    ev = story();
    const again = flat(ev.immediate).find((l) => l.icon === 'call' && /disburse/i.test(txt(l)))!.children!.find((l) => l.src)!;
    check(again.src!.mod === mod.id && again.src!.rel === ov.rel && again.src!.stmt?.text === gameLine.src!.stmt!.text && again.src!.owner?.name === 'disburse_activity_stress_loss', `overridden into ${ov.rel}: the line is the mod's, its statement found by the same check`);
    await editScript(host, { op: 'replace', at: again.src!, text: 'add_stress = -20' });
    reindex();
    ev = story();
    check(flat(ev.immediate).find((l) => l.icon === 'call' && /disburse/i.test(txt(l)))?.children?.some((l) => /20 Stress/.test(txt(l))), 'story: the call reads the edited effect (−20 Stress)');
    const kinds9: string[] = [];

    for (let i = 0; i < 4; i++)
        kinds9.push((await undoChange(host, { mod: mod.id }))!.kind);

    check(kinds9.join() === 'edit,override,edit,edit' && !existsSync(join(root, 'common', 'scripted_effects')), `round 9 undone (${kinds9.join(' ')}): the effect's overrides file and its folder are gone`);

    // --- round 10: localization — a line reading a text (Line.locKey), the text changed (an override in the replace
    // file), the key's line edited as text (the Source tab's editor on a .yml), the key's card
    reindex();
    ev = story();
    const TT = 'employer_booner_invalidated_tt';
    const ttLine = flat(ev.options[0].effects).find((l) => l.locKey === TT)!;
    check(ttLine?.src?.mod === mod.id, `the custom tooltip “${ttLine && txt(ttLine)}” carries its text's key (${TT}) and is the mod's line`);
    const lr = await editLoc(host, { key: TT, text: 'The booner is gone' });
    const LOC = 'localization/english/replace/edit_test_l_english.yml';
    const locFile = (): string => readFileSync(join(root, LOC), 'utf8');
    check(lr.rel === LOC && locFile().startsWith('﻿l_english:') && locFile().includes(` ${TT}:0 "The booner is gone"`), `the text overridden in ${lr.rel} (BOM, header, the line)`);
    reindex();
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
    reindex();
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
    // (undo: the edit, then the override — the replace file and the folders made for it go)
    const u10a = await undoChange(host, { mod: mod.id });
    check(u10a?.kind === 'edit' && locFile().includes(`${TT}:0 "The booner is gone"`) && locFile().includes('edit_test_other'), 'undo: the line as it was before the edit (the hand-written line above stays)');
    writeFileSync(join(root, LOC), locFile().replace(' edit_test_other:0 "Other"\n', ''));
    const u10b = await undoChange(host, { mod: mod.id });
    check(u10b?.kind === 'text' && !existsSync(join(root, 'localization')), 'undo the text: the replace file and its folders are gone');

    // --- round 11: a picked statement with the entries made for it (ScriptEditRequest.creates) is one undo step — one
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
        reindex();
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
        reindex();
        const optA = new StoryBuilder(idx).eventStory(idx.get('events', 'edit_test.0001')!)!.options[0].src!;
        const trBlock = card('edit_test_first').src!;
        check(optA.rel === evA.rel && trBlock.rel === trA.rel, `the option's anchor in ${optA.rel}, the trait's in ${trBlock.rel} — where new events and traits go`);
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
        // a later change of the same file: named; another editor: said so; "Forget" lets the next undo through
        reindex();
        ev = story();
        before = folder();
        const e1 = await editScript(host, { op: 'insert', where: 'inside', at: ev.sections!.immediate.src!, text: 'add_gold = 11', label: 'first change' });
        const e2 = await editScript(host, { op: 'insert', where: 'inside', at: ev.options[0].src!, text: 'add_gold = 22', label: 'second change' });
        u = await undoChange(host, { id: e1.step! });
        check(u?.refused && /changed again by a later change \(“second change”\)/.test(u.refused), 'undoing an older change of a file a later change touched: refused, the later one named — ' + u?.refused);
        const mid = read(EV);
        writeFileSync(join(root, EV), mid + '\r\n# a note\r\n');
        u = await undoChange(host, { mod: mod.id });
        check(u?.refused && /changed since \(in another editor\?\)/.test(u.refused) && u.id === e2.step, 'the file changed in another editor: refused, nothing written — ' + u?.refused);
        check(forgetChange(host, u!.id) && journalOf(host).list(mod.id)[0]?.label === 'first change', '“Forget this change”: the next undo reaches the change before it');
        writeFileSync(join(root, EV), mid.replace(/\r\n\t+add_gold = 22/, ''));
        u = await undoChange(host, { mod: mod.id });
        check(u && !u.refused && same(before, folder()) && count() === n0, 'the change before it undone (the file put back by hand first): as before');
    }

    // --- undo (undo.ts): kept in the data folder — read again as after a restart, then every edit, newest first; the
    // files are the copies again, byte for byte
    const steps = journalOf(host).list(mod.id);
    check(steps.length === 20 && steps.filter((s) => s.kind === 'override').length === 3 && steps[0].kind === 'edit', `20 undo steps (17 edits, 3 overrides): ${steps.map((s) => s.kind).join(' ')}`);
    dropJournals();
    check(journalOf(host).list(mod.id).length === 20 && existsSync(join(tmp, 'data', 'undo', 'journal.json')), 'the steps are read again from the data folder (a restart)');
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
    check(readdirSync(join(tmp, 'data', 'undo')).join() === 'journal.json', 'the journal’s folder keeps no earlier bytes any more: ' + readdirSync(join(tmp, 'data', 'undo')).join(', '));
}
finally
{
    console.log(failures ? `\n${failures} FAILED` : '\nall ok', '— temp user folder', tmp);

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
