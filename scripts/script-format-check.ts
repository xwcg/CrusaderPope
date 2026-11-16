// The script formatter (src/shared/scriptFormat.ts) over the game's script files: how many it re-spaces, leaves as they
// are, refuses (their tokens don't nest; the text is kept), and whether formatting twice changes anything (it must not).
// Also sameScript (the "same as the game" comparison): a re-spaced file says the same, one changed number does not.
// And keepLayout (a written statement the picker changed keeps its layout): small cases, then the game's statements
// reprinted, with a number changed and with a statement added. And keepWritten (the same with the written comments
// kept, or gone with a statement the picker removed or replaced): small cases, then the game's statements with comments,
// their removals compared with the main side's remove (scriptEdit.ts applyEdit). Reads only.
// Usage: node --experimental-strip-types --no-warnings scripts/script-format-check.ts [folder …]
// (folders under game/, default common events history gfx/portraits gfx/coat_of_arms). GAME=<install dir> (default: the
// development install).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { parse as parseNodes, type PNode } from '../src/main/indexer/parser.ts';
import { parseSnippet, printScript } from '../src/shared/scriptCatalog.ts';
import { commentsOf, formatScript, isScriptFile, keepLayout, keepWritten, layoutKept, lostComments, rewrittenKept, sameScript, scriptSignature, type NotKept } from '../src/shared/scriptFormat.ts';
import { fold, foldHas } from '../src/shared/fold.ts';
import { applyEdit } from '../src/main/mods/scriptEdit.ts';
import { defaultInstall } from './ck3-install.ts';

// Small inputs for the syntaxes the game files use rarely (no install needed): a comment between the operator and the
// value stays after the operator and the value follows on its own line, an operator can be a value
const samples: [string, string][] = [
    ['a = {\n 1215.1.1 = # c1\n # c2\n {\n x = 1\n }\n}\n', 'a = {\n\t1215.1.1 = # c1\n\t# c2\n\t{\n\t\tx = 1\n\t}\n}\n'],
    ['a = {\n k = # c\n word\n}\n', 'a = {\n\tk = # c\n\tword\n}\n'],
    ['a = {\n k = # c\n rgb { 1 2 3 }\n}\n', 'a = {\n\tk = # c\n\trgb {\n\t\t1\n\t\t2\n\t\t3\n\t}\n}\n'],
    ['a = {\n OPERATOR = >=\n b = <=\n}\n', 'a = {\n\tOPERATOR = >=\n\tb = <=\n}\n']
];

let sampleFails = 0;

for (const [input, want] of samples)
{
    const got = formatScript(input);

    if (got !== want || formatScript(got) !== got || !sameScript(input, got))
    {
        console.log('  sample fails ' + JSON.stringify(input) + ' -> ' + JSON.stringify(got));
        sampleFails++;
    }
}

// keepLayout (the picker's Change path, docs/picker.md): [what, the statement as written, the picker's text, the result]
const keepCases: [string, string, string, string][] = [
    [
        'an unchanged multi-line limit kept byte for byte, a value beside it changed',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t\tis_female = yes\n\t}\n\tadd_gold = 100\n}',
        'if = {\n\tlimit = { is_adult = yes is_female = yes }\n\tadd_gold = 200\n}',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t\tis_female = yes\n\t}\n\tadd_gold = 200\n}'
    ],
    [
        'a sibling added at the end of a multi-line block, the spacing of the others kept',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t}\n\n\tadd_gold   = 100\n}',
        'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n\tadd_prestige = 5\n}',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t}\n\n\tadd_gold   = 100\n\tadd_prestige = 5\n}'
    ],
    [
        'a sibling added in the middle',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t}\n\tadd_gold = 100\n}',
        'if = {\n\tlimit = { is_adult = yes }\n\tadd_piety = 1\n\tadd_gold = 100\n}',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t}\n\tadd_piety = 1\n\tadd_gold = 100\n}'
    ],
    [
        'an inner value changed in a nested block, the blank line and the one-line block beside it kept',
        'random_list = {\n\t10 = { add_gold = 5 }\n\n\t20 = {\n\t\tmodifier = {\n\t\t\tadd = 5\n\t\t\tis_adult = yes\n\t\t}\n\t\tadd_gold = 10\n\t}\n}',
        'random_list = {\n\t10 = { add_gold = 5 }\n\t20 = {\n\t\tmodifier = { add = 5 is_adult = no }\n\t\tadd_gold = 10\n\t}\n}',
        'random_list = {\n\t10 = { add_gold = 5 }\n\n\t20 = {\n\t\tmodifier = {\n\t\t\tadd = 5\n\t\t\tis_adult = no\n\t\t}\n\t\tadd_gold = 10\n\t}\n}'
    ],
    [
        'one-line style kept for a block written on one line (the picker breaks it up)',
        'if = { limit = { is_adult = yes } add_gold = 100 }',
        'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n\tadd_piety = 5\n}',
        'if = { limit = { is_adult = yes } add_gold = 100 add_piety = 5 }'
    ],
    [
        'a block the picker printed on one line stays multi-line as written',
        'limit = {\n\tis_adult = yes\n\tis_female = yes\n}',
        'limit = { is_adult = yes is_female = no }',
        'limit = {\n\tis_adult = yes\n\tis_female = no\n}'
    ],
    [
        'CRLF and four-space indentation: kept, the new line in the same unit and line end',
        'if = {\r\n    limit = {\r\n        is_adult = yes\r\n    }\r\n    add_gold = 100\r\n}',
        'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n\tif = {\n\t\tlimit = { is_female = yes }\n\t\tadd_piety = 5\n\t}\n}',
        'if = {\r\n    limit = {\r\n        is_adult = yes\r\n    }\r\n    add_gold = 100\r\n    if = {\r\n        limit = { is_female = yes }\r\n        add_piety = 5\r\n    }\r\n}'
    ],
    [
        'an else added after the statement (top level): the statement as written, the else printed',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t}\n\tadd_gold = 100\n}',
        'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}\nelse = {\n\tadd_gold = 5\n}',
        'if = {\n\tlimit = {\n\t\tis_adult = yes\n\t}\n\tadd_gold = 100\n}\nelse = {\n\tadd_gold = 5\n}'
    ],
    [
        'nothing changed: the written text whatever its spacing',
        'add_opinion={ target=root   modifier = friendly_opinion }',
        'add_opinion = { target = root modifier = friendly_opinion }',
        'add_opinion={ target=root   modifier = friendly_opinion }'
    ],
    [
        'a different statement (no head in common): the picker\'s text',
        'add_gold = 100',
        'add_prestige = 100',
        'add_prestige = 100'
    ],
    [
        'fallback on a token mismatch: a kept multi-line string would move, so the picker\'s text comes back',
        'x = { a = 1 b = "s\nt" }',
        'x = {\n\tb = "s\nt"\n}',
        'x = {\n\tb = "s\nt"\n}'
    ],
    [
        'a bare value changed (an rgb triple): the new one in the written one\'s place',
        'color = rgb {\n\t1 2 3\n}',
        'color = rgb { 1 2 4 }',
        'color = rgb {\n\t1 2 4\n}'
    ],
    [
        'a bare value added to a list written several to a line: on the line of the one before it',
        'names = {\n\ta b\n\tc\n}',
        'names = { a b d c }',
        'names = {\n\ta b d\n\tc\n}'
    ],
    [
        'a bare value added at the end of a triple on one line of a multi-line block',
        'c = {\n\t1 2 3\n}',
        'c = { 1 2 3 4 }',
        'c = {\n\t1 2 3 4\n}'
    ],
    [
        'a bare value added to a list written one to a line: on a line of its own',
        'names = {\n\ta\n\tb\n}',
        'names = { a b c }',
        'names = {\n\ta\n\tb\n\tc\n}'
    ],
    [
        'a block written on one line: the written spacing between neighbours and at the ends kept',
        'x = {  a=1   b=2  }',
        'x = { a = 1 b = 3 }',
        'x = {  a=1   b = 3  }'
    ],
    [
        'an empty block written on one line, a statement added to it',
        'if = { limit = { } add_gold = 1 }',
        'if = { limit = { is_adult = yes } add_gold = 1 }',
        'if = { limit = { is_adult = yes } add_gold = 1 }'
    ],
    ['fallback: a comment in the written text (the picker does not read those: stage B)', 'if = {\n\tadd_gold = 1 # one\n}', 'if = {\n\tadd_gold = 2\n}', 'if = {\n\tadd_gold = 2\n}'],
    ['fallback: unbalanced written text', 'if = {\n\tadd_gold = 1', 'if = {\n\tadd_gold = 2\n}', 'if = {\n\tadd_gold = 2\n}'],
    ['only whitespace written', '  \n\t', 'add_gold = 2', 'add_gold = 2'],
    ['only whitespace from the picker', 'add_gold = 1', ' \n', ' \n']
];

for (const [what, before, after, want] of keepCases)
{
    const got = keepLayout(before, after);

    if (got !== want)
    {
        console.log('  keepLayout fails (' + what + '): ' + JSON.stringify(before) + ' + ' + JSON.stringify(after) + ' -> ' + JSON.stringify(got));
        sampleFails++;
    }
}

console.log(`keepLayout: ${keepCases.length} cases`);

// keepWritten (the picker's Change path with comments, docs/mods.md "Comments next to a statement"): [what, the
// statement as written, the picker's text, the result (null: the script editor opens), the comments that go]
const writtenCases: [string, string, string, string | null, string[]][] = [
    [
        'a value changed: the comment line above it and the one after it stay',
        'if = {\n\t# the gold\n\tadd_gold = 10 # much\n\tadd_prestige = 5\n}',
        'if = {\n\tadd_gold = 20\n\tadd_prestige = 5\n}',
        'if = {\n\t# the gold\n\tadd_gold = 20 # much\n\tadd_prestige = 5\n}',
        []
    ],
    [
        'a statement removed: its comment line above and its comment after it go with it',
        'if = {\n\t# the gold\n\tadd_gold = 10 # much\n\tadd_prestige = 5\n}',
        'if = {\n\tadd_prestige = 5\n}',
        'if = {\n\tadd_prestige = 5\n}',
        ['# the gold', '# much']
    ],
    [
        'a statement replaced by another: its comments go with it',
        'if = {\n\t# the gold\n\tadd_gold = 10 # much\n\tadd_prestige = 5\n}',
        'if = {\n\tadd_piety = 1\n\tadd_prestige = 5\n}',
        'if = {\n\tadd_piety = 1\n\tadd_prestige = 5\n}',
        ['# the gold', '# much']
    ],
    [
        'the comment after a `{`, one inside a kept block, a loose one between blank lines and one at the block\'s end stay; a statement added after the last',
        'if = { # head\n\tlimit = {\n\t\tis_adult = yes # grown\n\t}\n\n\t# loose\n\n\tadd_gold = 10\n\t# end\n}',
        'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 10\n\tadd_piety = 2\n}',
        'if = { # head\n\tlimit = {\n\t\tis_adult = yes # grown\n\t}\n\n\t# loose\n\n\tadd_gold = 10\n\t# end\n\tadd_piety = 2\n}',
        []
    ],
    [
        'a comment inside a statement the picker replaced by another: the script editor',
        'if = {\n\trandom = {\n\t\tchance = 5 # five\n\t}\n\tadd_gold = 10\n}',
        'if = {\n\tadd_piety = 1\n\tadd_gold = 10\n}',
        null,
        []
    ],
    [
        'a comment inside a statement the picker removed: it goes with it',
        'if = {\n\trandom = {\n\t\tchance = 5 # five\n\t}\n\tadd_gold = 10\n}',
        'if = {\n\tadd_gold = 10\n}',
        'if = {\n\tadd_gold = 10\n}',
        ['# five']
    ],
    ['the whole statement replaced by another, a comment inside: the script editor', 'if = {\n\tadd_gold = 1 # x\n}', 'add_prestige = 5', null, []],
    ['a comment with a blank line below it is no statement\'s: it stays', 'if = {\n\t# loose\n\n\tadd_gold = 10\n\tadd_piety = 1\n}', 'if = {\n\tadd_piety = 1\n}', 'if = {\n\t# loose\n\tadd_piety = 1\n}', []],
    ['commented-out script above a statement stays', 'if = {\n\t# add_gold = 5\n\tadd_gold = 10\n\tadd_piety = 1\n}', 'if = {\n\tadd_piety = 1\n}', 'if = {\n\t# add_gold = 5\n\tadd_piety = 1\n}', []],
    [
        'the comment lines above a statement up to commented-out script: those below it go, it and those above stay',
        'if = {\n\t# words\n\t# add_gold = 5\n\t# the gold\n\tadd_gold = 10\n\tadd_piety = 1\n}',
        'if = {\n\tadd_piety = 1\n}',
        'if = {\n\t# words\n\t# add_gold = 5\n\tadd_piety = 1\n}',
        ['# the gold']
    ],
    ['two statements on a line, the second removed: the line\'s comment stays (on a line of its own)', 'if = {\n\ta = 1 b = 2 # c\n}', 'if = {\n\ta = 1\n}', 'if = {\n\ta = 1\n\t# c\n}', []],
    ['two statements on a line, the first removed: the line\'s comment stays with the other', 'if = {\n\ta = 1 b = 2 # c\n}', 'if = {\n\tb = 2\n}', 'if = {\n\tb = 2 # c\n}', []],
    ['the comment above a line of two statements, the first removed: it stays (the line is not the statement\'s alone)', 'if = {\n\t# about\n\ta = 1 b = 2\n}', 'if = {\n\tb = 2\n}', 'if = {\n\t# about\n\tb = 2\n}', []],
    [
        'CRLF and four-space indentation with comments: kept, the new line in the same unit',
        'if = {\r\n    # doc\r\n    add_gold = 1 # one\r\n    add_piety = 2\r\n}',
        'if = {\n\tadd_gold = 1\n\tadd_piety = 3\n\tadd_prestige = 4\n}',
        'if = {\r\n    # doc\r\n    add_gold = 1 # one\r\n    add_piety = 3\r\n    add_prestige = 4\r\n}',
        []
    ],
    ['a comment between a changed `key =` and its value: the script editor', 'if = {\n\tadd_gold = # c\n\t10\n}', 'if = {\n\tadd_gold = 11\n}', null, []],
    ['a statement added to a block with a comment after its `{`', 'limit = { # who\n\tis_adult = yes\n}', 'limit = { is_adult = yes is_female = yes }', 'limit = { # who\n\tis_adult = yes\n\tis_female = yes\n}', []],
    ['nothing changed: the written text with its comments, byte for byte', 'if = {\n\t# a\n\tlimit = { is_adult = yes } # b\n\tadd_gold = 1 # c\n}', 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 1\n}', 'if = {\n\t# a\n\tlimit = { is_adult = yes } # b\n\tadd_gold = 1 # c\n}', []],
    [
        'a nested block changed inside: the comment above its kept condition stays',
        'if = {\n\tlimit = {\n\t\t# only adults\n\t\tis_adult = yes\n\t}\n\tadd_gold = 1\n}',
        'if = {\n\tlimit = { is_adult = yes is_female = yes }\n\tadd_gold = 2\n}',
        'if = {\n\tlimit = {\n\t\t# only adults\n\t\tis_adult = yes\n\t\tis_female = yes\n\t}\n\tadd_gold = 2\n}',
        []
    ],
    [
        'a condition replaced inside a kept block: the comment above it goes with it',
        'if = {\n\tlimit = {\n\t\t# only adults\n\t\tis_adult = yes\n\t}\n\tadd_gold = 1\n}',
        'if = {\n\tlimit = { is_female = yes }\n\tadd_gold = 1\n}',
        'if = {\n\tlimit = {\n\t\tis_female = yes\n\t}\n\tadd_gold = 1\n}',
        ['# only adults']
    ],
    ['everything removed: the comments go', 'if = {\n\tadd_gold = 1 # one\n}', '', '', ['# one']],
    [
        'two statements swapped: the one kept in place keeps its comment, the other is the picker\'s',
        'if = {\n\tadd_gold = 1\n\t# moved\n\tadd_piety = 1\n}',
        'if = {\n\tadd_piety = 1\n\tadd_gold = 1\n}',
        'if = {\n\t# moved\n\tadd_piety = 1\n\tadd_gold = 1\n}',
        []
    ],
    [
        'a random list\'s outcome changed inside: the comments above both outcomes and inside stay',
        'random_list = {\n\t# rare\n\t10 = { add_gold = 5 }\n\t90 = {\n\t\t# usual\n\t\tadd_gold = 1\n\t}\n}',
        'random_list = {\n\t10 = { add_gold = 5 }\n\t90 = { add_gold = 2 }\n}',
        'random_list = {\n\t# rare\n\t10 = { add_gold = 5 }\n\t90 = {\n\t\t# usual\n\t\tadd_gold = 2\n\t}\n}',
        []
    ],
    ['a `#` inside a quoted string is no comment', 'if = {\n\tcustom_tooltip = "50 # of them"\n\tadd_gold = 1\n}', 'if = {\n\tcustom_tooltip = "50 # of them"\n\tadd_gold = 2\n}', 'if = {\n\tcustom_tooltip = "50 # of them"\n\tadd_gold = 2\n}', []],
    ['written text that does not parse, with a comment: the script editor', 'if = {\n\tadd_gold = 1 # one', 'if = {\n\tadd_gold = 2\n}', null, []],
    // (twins: statements written the same next to each other, one fewer in the picker's text: one without comments goes)
    ['twins, the last with a comment, one fewer: a twin without comments goes, the comment stays', 'if = {\n\tx = 1\n\tx = 1\n\tx = 1 # c\n}', 'if = {\n\tx = 1\n\tx = 1\n}', 'if = {\n\tx = 1\n\tx = 1 # c\n}', []],
    ['twins, the second with a comment line above it, one fewer: the first goes', 'if = {\n\tx = 1\n\t# about\n\tx = 1\n\ty = 2\n}', 'if = {\n\tx = 1\n\ty = 2\n}', 'if = {\n\t# about\n\tx = 1\n\ty = 2\n}', []],
    // (a statement the picker moved, written the same: it goes along with its comments)
    [
        'two statements with comments swapped: each takes its comments along',
        'if = {\n\t# f\n\tadd_gold = 1\n\t# g\n\tadd_piety = 1\n}',
        'if = {\n\tadd_piety = 1\n\tadd_gold = 1\n}',
        'if = {\n\t# g\n\tadd_piety = 1\n\t# f\n\tadd_gold = 1\n}',
        []
    ]
];

for (const [what, before, after, want, wantGone] of writtenCases)
{
    const got = keepWritten(before, after);

    if (got.text !== want || got.gone.join('\n') !== wantGone.join('\n'))
    {
        console.log('  keepWritten fails (' + what + '): ' + JSON.stringify(before) + ' + ' + JSON.stringify(after) + ' -> ' + JSON.stringify(got));
        sampleFails++;
    }
}

// lostComments (main's note, scriptEdit.ts commentNotes): each comment as often as it is missing; quotes are no comment
{
    const lost = lostComments('a = 1 # x\nb = 2 # x\nc = "# no" # y\n', 'b = 2 # x\n');
    const unread = commentsOf('a = "open # q\nb = 1 # z');

    if (lost.join('|') !== '# x|# y' || unread.join('|') !== '# z')
    {
        console.log('  lostComments / commentsOf fail: ' + JSON.stringify(lost) + ' ' + JSON.stringify(unread));
        sampleFails++;
    }
}

// why keepWritten gives no text (the change bar's wording, scriptEdits.ts notKeptText)
// ('unaligned': more than a million cells to align, lcs() gives up; at the top level, and inside a block the picker
// changed. 'check': the result's comments are not the written ones less those that go; the picker's own text never
// holds a comment, a comment in it is the one input found that fails the check, so the case is a contract violation, not
// something the picker can send: random pairs of a commented text and a comment-free one (550 000, run once over nested
// blocks, strings holding `#`, operators, CRLF) gave 'inside' or a text, never 'check'.)
const statements = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i} = ${i}`).join('\n');
const whyCases: [string, string, string, NotKept][] = [
    ['a comment inside a statement the picker replaced', 'if = {\n\trandom = {\n\t\tchance = 5 # five\n\t}\n\tadd_gold = 10\n}', 'if = {\n\tadd_piety = 1\n\tadd_gold = 10\n}', 'inside'],
    ['the whole statement replaced', 'if = {\n\tadd_gold = 1 # x\n}', 'add_prestige = 5', 'inside'],
    ['a comment between a changed key and its value', 'if = {\n\tadd_gold = # c\n\t10\n}', 'if = {\n\tadd_gold = 11\n}', 'inside'],
    ['the written text does not close', 'if = {\n\tadd_gold = 1 # one', 'if = {\n\tadd_gold = 2\n}', 'parse'],
    ['the picker\'s text does not close', 'if = {\n\tadd_gold = 1 # one\n}', 'if = { add_gold = "2 }', 'parse'],
    ['too many statements at the top level to align', '# c\n' + statements('x', 1100), statements('y', 1100), 'unaligned'],
    ['too many statements in a block the picker changed', 'a = {\n\t# c\n' + statements('x', 1100).replace(/^/gm, '\t') + '\n}', 'a = {\n' + statements('y', 1100).replace(/^/gm, '\t') + '\n}', 'unaligned'],
    ['a comment in the picker\'s own text (not one it prints)', '# c2\nb = 2', '# other\nb = 2', 'check']
];
const reasonsSeen = new Set<string>();

for (const [what, before, after, why] of whyCases)
{
    const got = keepWritten(before, after);

    if (got.text !== null || got.why !== why)
    {
        console.log('  keepWritten why fails (' + what + '): ' + JSON.stringify(before).slice(0, 200) + ' + ' + JSON.stringify(after).slice(0, 200) + ' -> ' + JSON.stringify(got) + ', want ' + why);
        sampleFails++;
    }
    else
        reasonsSeen.add(why);
}

// foldHas (src/shared/fold.ts): the text searches fold what is typed once and each name with it
{
    const wrong = [
        !(foldHas('Étienne', fold('etienne')) && foldHas('Étienne', fold('ÉTIEN')) && foldHas('etienne', fold('étienne'))),
        !(foldHas('odważna', fold('odwazna')) && foldHas('Straße', fold('strasse')) && foldHas('ёж', fold('еж'))),
        !(!foldHas(undefined, fold('a')) && !foldHas('', fold('a')) && foldHas('abc', '')),
        !(!foldHas('Étienne', fold('etiennes')) && !foldHas('日本語', fold('本日')) && foldHas('日本語', fold('本')))
    ];

    wrong.forEach((w, i) =>
    {
        if (w)
        {
            console.log('  foldHas case ' + (i + 1) + ' fails');
            sampleFails++;
        }
    });
}

// rewrittenKept (the event view's rewrites: text versions, scenes, portraits, built with parseSnippet + printScript as
// textVariants.ts, SceneChooser.tsx withReference and EventCast.tsx portraitBlock build them): [what, written, the
// rewrite's text, the result (null: nothing written), the comments that go]
const rewriteCases: [string, string, string, string | null, string[]][] = [];
{
    const desc = 'desc = {\n\tfirst_valid = {\n\t\t# the rich\n\t\ttriggered_desc = {\n\t\t\ttrigger = { gold > 100 } # gold\n\t\t\tdesc = ev.desc.rich\n\t\t}\n\t\t# else\n\t\tdesc = ev.desc\n\t}\n}';
    const n = parseSnippet(desc)[0];
    const fv = n.kids![0];
    const variant = { k: 'triggered_desc', op: '=', kids: [{ k: 'trigger', op: '=', kids: parseSnippet('is_adult = yes') }, { k: 'desc', op: '=', v: 'ev.desc.2' }] };
    const print = (kids: typeof fv.kids): string => printScript([{ ...n, kids: [{ ...fv, kids }] }]);
    rewriteCases.push(
        [
            'a text version added to a commented first_valid (withTextVariant): every comment stays',
            desc,
            print([fv.kids![0], variant, fv.kids![1]]),
            'desc = {\n\tfirst_valid = {\n\t\t# the rich\n\t\ttriggered_desc = {\n\t\t\ttrigger = { gold > 100 } # gold\n\t\t\tdesc = ev.desc.rich\n\t\t}\n\t\ttriggered_desc = {\n\t\t\ttrigger = { is_adult = yes }\n\t\t\tdesc = ev.desc.2\n\t\t}\n\t\t# else\n\t\tdesc = ev.desc\n\t}\n}',
            []
        ],
        ['a commented triggered_desc removed (withRemoved): its comments go, the fallback\'s stays', desc, print([fv.kids![1]]), 'desc = {\n\tfirst_valid = {\n\t\t# else\n\t\tdesc = ev.desc\n\t}\n}', ['# the rich', '# gold']],
        [
            'two texts swapped (withSwapped): each takes its comments along',
            desc,
            print([fv.kids![1], fv.kids![0]]),
            'desc = {\n\tfirst_valid = {\n\t\t# else\n\t\tdesc = ev.desc\n\t\t# the rich\n\t\ttriggered_desc = {\n\t\t\ttrigger = { gold > 100 } # gold\n\t\t\tdesc = ev.desc.rich\n\t\t}\n\t}\n}',
            []
        ],
        ['a text without comments: the rewrite\'s text as it is', 'desc = {\n\tdesc = a\n}', printScript(parseSnippet('desc = { desc = a desc = b }')), 'desc = { desc = a desc = b }', []]
    );
    const scene = 'override_background = {\n\t# only at night\n\ttrigger = { is_night = yes }\n\treference = bp1_dungeon # dark\n}';
    const sn = parseSnippet(scene)[0];
    rewriteCases.push([
        'a scene\'s background changed (withReference): its comments stay',
        scene,
        printScript([{ ...sn, kids: sn.kids!.map((c) => (c.k === 'reference' ? { ...c, v: 'throne_room' } : c)) }]),
        'override_background = {\n\t# only at night\n\ttrigger = { is_night = yes }\n\treference = throne_room # dark\n}',
        []
    ]);
    const portrait = 'left_portrait = {\n\tcharacter = scope:a\n\t# grim\n\tanimation = anger\n}';
    rewriteCases.push(
        ['a portrait\'s animation changed (portraitBlock): the comment above it stays', portrait, 'left_portrait = {\n\tcharacter = scope:a\n\tanimation = happiness\n}', 'left_portrait = {\n\tcharacter = scope:a\n\t# grim\n\tanimation = happiness\n}', []],
        ['a portrait taken over by someone else (portraitBlock): the settings left out go with their comments', portrait, 'left_portrait = {\n\tcharacter = scope:b\n}', 'left_portrait = {\n\tcharacter = scope:b\n}', ['# grim']],
        ['a portrait block with a comment inside made the short form: nothing written', portrait, 'left_portrait = scope:a', null, []]
    );
}

for (const [what, before, after, want, wantGone] of rewriteCases)
{
    const got = rewrittenKept(before, after, '\t');

    if (got.text !== want || got.gone.join('\n') !== wantGone.join('\n'))
    {
        console.log('  rewrittenKept fails (' + what + '): ' + JSON.stringify(before) + ' + ' + JSON.stringify(after) + ' -> ' + JSON.stringify(got));
        sampleFails++;
    }
}

console.log(`keepWritten: ${writtenCases.length} cases, ${whyCases.length} refusals with ${reasonsSeen.size} distinct reasons (${[...reasonsSeen].sort().join(', ')}); rewrittenKept: ${rewriteCases.length} cases`);

if (reasonsSeen.size !== 4)
{
    console.log('  keepWritten: every NotKept reason needs a case (inside, unaligned, check, parse), got ' + [...reasonsSeen].sort().join(', '));
    sampleFails++;
}

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const folders = process.argv.slice(2).length ? process.argv.slice(2) : ['common', 'events', 'history', 'gfx/portraits', 'gfx/coat_of_arms'];
const files: string[] = [];

const walk = (dir: string): void =>
{
    for (const e of readdirSync(dir, { withFileTypes: true }))
    {
        const p = join(dir, e.name);

        if (e.isDirectory())
            walk(p);
        else if (isScriptFile(p))
            files.push(p);
    }
};

for (const f of folders)
    walk(join(gameDir, f));

let changed = 0;
let same = 0;
let bytes = 0;
const refused: string[] = [];
const unstable: string[] = [];
const notSame: string[] = [];
const t0 = performance.now();

for (const f of files)
{
    const text = readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    bytes += text.length;
    const once = formatScript(text);

    if (once === text)
    {
        // (formatted already, or refused: a trailing space it would drop tells them apart)
        if (formatScript(text + ' ') === text + ' ')
            refused.push(f.slice(gameDir.length + 1));
        else
            same++;

        continue;
    }

    changed++;

    if (formatScript(once) !== once)
        unstable.push(f.slice(gameDir.length + 1));

    // sameScript ("same as the game", docs/mods.md): the re-spaced text says the same, one changed number does not,
    // and it agrees with the tokenizer's view (scriptSignature)
    // (the first number that is not in a comment)
    const m = [...text.matchAll(/=[ \t]*(\d+)\b/g)].find((x) => !text.slice(text.lastIndexOf('\n', x.index) + 1, x.index).includes('#'));
    const mutated = m ? text.slice(0, m.index) + '= ' + (Number(m[1]) + 1) + text.slice(m.index + m[0].length) : undefined;
    const sigText = scriptSignature(text);

    if (!sameScript(text, once) || sigText !== scriptSignature(once) || (mutated !== undefined && (sameScript(text, mutated) || sigText === scriptSignature(mutated))))
        notSame.push(f.slice(gameDir.length + 1));
}

console.log(`${files.length} files, ${(bytes / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms: ${changed} re-spaced, ${same} as they were, ${refused.length} refused, ${unstable.length} not stable, ${notSame.length} where sameScript is wrong`);

// keepLayout over the game's statements: every keyed block inside a definition (no comment, no inline maths: what the
// picker opens; at most 60 lines, to keep the run short), every 4th of them unless FULL=1, read as the picker's Change
// path gets it
// (statementText: later lines without the statement's indentation), whose reprint by the picker (printScript of
// parseSnippet) has the same tokens:
// - reprinted unchanged it must come back byte for byte;
// - with its last number changed (+1), the result is compared line by line with the written text so changed;
// - with a statement added at the end of its first block, with the written text: every written line kept and one
//   more; one written line replaced by one; one replaced by several, split by whether that block was written on one
//   line (likely grown past the one-line limit) or not (likely its closing brace on its last item's line); other.
// "fallback": keepLayout gave the picker's text back (its own token check, or nothing kept). The check fails on an
// unchanged statement not kept byte for byte and on any fallback.
// (lines of a not in b, lines of b not in a: by an LCS of the lines, their trailing spaces aside: the edit's write
// drops those, scriptEdit.ts reindent)
const lineDiff = (a: string, b: string): { lost: number; extra: number; } =>
{
    const x = a.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''));
    const y = b.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''));
    let lo = 0;

    while (lo < x.length && lo < y.length && x[lo] === y[lo])
        lo++;

    let hi = 0;

    while (hi < x.length - lo && hi < y.length - lo && x[x.length - 1 - hi] === y[y.length - 1 - hi])
        hi++;

    const n = x.length - lo - hi;
    const m = y.length - lo - hi;
    const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            len[i][j] = x[lo + i] === y[lo + j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);

    return { lost: n - len[0][0], extra: m - len[0][0] };
};
const keep = { samples: 0, notReprinted: 0, unchangedWrong: 0, value: [0, 0, 0], valueFallback: 0, added: [0, 0, 0, 0, 0], addedFallback: 0, pastLimit: 0, blankOnly: 0 };
const every = process.env.FULL === '1' ? 1 : 4;
let eligible = 0;
const examples = { unchanged: [] as string[], value: [] as string[], added: [] as string[], notPast: [] as string[] };

// keepWritten over the game's statements with comments (the same blocks, every 4th of them unless FULL=1; their reprint
// has no comments):
// - reprinted unchanged it must come back byte for byte, no comment gone;
// - with its last number changed and with a statement added, every comment must stay (or the script editor opens:
//   counted, not a failure: a comment between an operator and its value, a check that does not hold);
// - with its first or last statement removed, the comments must be the ones the main side's remove leaves
//   (scriptEdit.ts applyEdit, removalRange), and those that go the ones it takes: the two rules agree. A case is skipped
//   when the picker's tree and the parse do not line up (their tokens differ).
// The check fails on an unchanged one not kept, a comment gone where none should, and a disagreement with the main side.
let eligibleC = 0;
const kc = { samples: 0, notReprinted: 0, unchangedWrong: 0, valueKept: 0, valueEditor: 0, valueGone: 0, addKept: 0, addEditor: 0, addGone: 0, removed: 0, agree: 0, twins: 0, twinsKeepMore: 0, twinsLoseMore: 0, disagree: 0, removeEditor: 0, skipped: 0 };
const kcExamples = { wrong: [] as string[], editor: [] as string[], disagree: [] as string[] };

function commented(where: string, before: string): void
{
    const tree = parseSnippet(before);
    const reprint = printScript(tree);
    kc.samples++;

    if (scriptSignature(reprint) !== scriptSignature(before))
    {
        kc.notReprinted++;
        return;
    }

    const same = keepWritten(before, reprint);

    if (same.text !== before || same.gone.length)
    {
        kc.unchangedWrong++;

        if (kcExamples.wrong.length < 5)
            kcExamples.wrong.push(`unchanged ${where} -> ${JSON.stringify(same).slice(0, 200)}`);
    }

    const tally = (r: { text: string | null; gone: string[]; }, what: 'value' | 'add'): void =>
    {
        if (r.text === null)
        {
            kc[what === 'value' ? 'valueEditor' : 'addEditor']++;

            if (kcExamples.editor.length < 5)
                kcExamples.editor.push(`${what} ${where}`);
        }
        else if (r.gone.length)
        {
            kc[what === 'value' ? 'valueGone' : 'addGone']++;

            if (kcExamples.wrong.length < 5)
                kcExamples.wrong.push(`${what} ${where}: gone ${JSON.stringify(r.gone)}`);
        }
        else
            kc[what === 'value' ? 'valueKept' : 'addKept']++;
    };

    let num: PNode | undefined;
    const last = (l: PNode[]): void =>
    {
        for (const c of l)
            if (Array.isArray(c.v))
                last(c.v);
            else if (!c.q && c.k !== null && /^-?\d+$/.test(c.v))
                num = c;
    };
    const nodes = parseNodes(before);
    last(nodes);

    if (num)
    {
        const v = num.v as string;
        tally(keepWritten(before, printScript(parseSnippet(before.slice(0, num.vs) + String(Number(v) + 1) + before.slice(num.vs + v.length)))), 'value');
    }

    const target = tree[0]?.kids?.find((c) => c.kids) ?? tree[0];

    if (target?.kids)
    {
        const added = parseSnippet(before);
        const t2 = added[0]?.kids?.find((c) => c.kids) ?? added[0];
        t2.kids!.push({ k: 'ckp_added', op: '=', v: '1' });
        tally(keepWritten(before, printScript(added)), 'add');
    }

    // (the first and the last statement of the top block removed, here and by the main side's remove)
    const top = nodes[0];
    const kids = top && Array.isArray(top.v) ? top.v : [];

    for (const i of kids.length > 1 ? [0, kids.length - 1] : [])
    {
        const child = kids[i];
        const cut = parseSnippet(before);

        if (!cut[0]?.kids || cut[0].kids.length !== kids.length || cut[0].kids[i].k !== child.k)
        {
            kc.skipped++;
            continue;
        }

        cut[0].kids.splice(i, 1);
        const mine = keepWritten(before, printScript(cut));
        const main = applyEdit(before, { op: 'remove', at: { file: 'x', rel: 'x.txt', line: 1, s: child.s, e: child.e, kind: 'effect', hash: '' } }).text;

        if (scriptSignature(main) !== scriptSignature(printScript(cut)))
        {
            kc.skipped++;
            continue;
        }

        kc.removed++;

        if (mine.text === null)
        {
            kc.removeEditor++;

            if (kcExamples.editor.length < 5)
                kcExamples.editor.push(`remove ${where}`);

            continue;
        }

        // (the comments that go, as a multiset: a comment written twice is told by its text only)
        const sorted = (l: string[]): string => [...l].sort().join('\n');

        // (a statement written twice the same in that block: the picker's text does not tell which one went, its
        // alignment may take another of them; then the main side's remove of that twin must agree)
        const agrees = (m: string): boolean => commentsOf(mine.text!).join('\n') === commentsOf(m).join('\n') && sorted(mine.gone) === sorted(lostComments(before, m));
        const sig = scriptSignature(before.slice(child.s, child.e));
        const twin = kids.some((x, j) => j !== i && scriptSignature(before.slice(x.s, x.e)) === sig && agrees(applyEdit(before, { op: 'remove', at: { file: 'x', rel: 'x.txt', line: 1, s: x.s, e: x.e, kind: 'effect', hash: '' } }).text));

        if (agrees(main))
            kc.agree++;
        else if (twin)
        {
            kc.twins++;

            // (the alignment drops a twin without comments where there is one: never more comments than main's remove of
            // the statement taken out)
            const mainGone = lostComments(before, main).length;

            if (mine.gone.length < mainGone)
                kc.twinsKeepMore++;
            else if (mine.gone.length > mainGone)
            {
                kc.twinsLoseMore++;

                if (kcExamples.disagree.length < 5)
                    kcExamples.disagree.push(`${where} #${i}: a twin with more comments dropped: ${JSON.stringify(mine.gone).slice(0, 200)}`);
            }
        }
        else
        {
            kc.disagree++;

            if (kcExamples.disagree.length < 5)
                kcExamples.disagree.push(`${where} #${i}: picker keeps ${JSON.stringify(commentsOf(mine.text)).slice(0, 300)}, lets go ${JSON.stringify(mine.gone).slice(0, 200)} / main keeps ${JSON.stringify(commentsOf(main)).slice(0, 300)}`);
        }
    }
}
const t1 = performance.now();

for (const f of files)
{
    const text = readFileSync(f, 'utf8').replace(/^﻿/, '');
    let nodes: PNode[];

    try
    {
        nodes = parseNodes(text);
    }
    catch
    {
        continue;
    }

    const walk = (list: PNode[], depth: number): void =>
    {
        for (const n of list)
        {
            if (!Array.isArray(n.v))
                continue;

            walk(n.v, depth + 1);

            if (depth === 0 || n.k === null)
                continue;

            const raw = text.slice(n.s, n.e);

            if (raw.includes('@[') || raw.split('\n').length > 60)
                continue;

            const ls = text.lastIndexOf('\n', n.s - 1) + 1;
            const base = /^[ \t]*/.exec(text.slice(ls, n.s))![0];
            const lines = raw.split(/\r?\n/);
            const before = [lines[0], ...lines.slice(1).map((l) => (l.startsWith(base) ? l.slice(base.length) : l.replace(/^[ \t]+/, '')))].join('\n');

            if (raw.includes('#'))
            {
                if (!(eligibleC++ % every))
                    commented(f.slice(gameDir.length + 1) + ':' + n.line, before);

                continue;
            }

            if (eligible++ % every)
                continue;

            const reprint = printScript(parseSnippet(before));

            keep.samples++;

            if (scriptSignature(reprint) !== scriptSignature(before))
            {
                keep.notReprinted++;
                continue;
            }

            if (keepLayout(before, reprint) !== before)
            {
                keep.unchangedWrong++;

                if (examples.unchanged.length < 5)
                    examples.unchanged.push(f.slice(gameDir.length + 1) + ':' + n.line);
            }

            // (the last unquoted number)
            let num: PNode | undefined;
            const last = (l: PNode[]): void =>
            {
                for (const c of l)
                    if (Array.isArray(c.v))
                        last(c.v);
                    else if (!c.q && c.k !== null && /^-?\d+$/.test(c.v))
                        num = c;
            };
            last(parseNodes(before));

            if (num)
            {
                const v = num.v as string;
                const changed = before.slice(0, num.vs) + String(Number(v) + 1) + before.slice(num.vs + v.length);
                const after = printScript(parseSnippet(changed));
                const got = layoutKept(before, after);

                if (got === null)
                    keep.valueFallback++;
                else
                {
                    const d = lineDiff(changed, got);
                    const which = d.lost === 0 && d.extra === 0 ? 0 : d.lost <= 1 && d.extra <= 1 ? 1 : 2;
                    keep.value[which]++;

                    if (which === 2 && examples.value.length < 5)
                        examples.value.push(`${f.slice(gameDir.length + 1)}:${n.line} ${JSON.stringify(changed).slice(0, 200)} -> ${JSON.stringify(got).slice(0, 200)}`);
                }
            }

            const tree = parseSnippet(before);
            const target = tree[0]?.kids?.find((c) => c.kids) ?? tree[0];
            // (the same block in the written text: written on one line or not)
            const top = parseNodes(before)[0];
            const written = top && Array.isArray(top.v) ? (top.v.find((c) => Array.isArray(c.v)) ?? top) : top;
            const oneLine = !!written && !/\n/.test(before.slice(written.s, written.e));

            if (target?.kids)
            {
                target.kids.push({ k: 'ckp_added', op: '=', v: '1' });
                const after = printScript(tree);
                const got = layoutKept(before, after);

                if (got === null)
                    keep.addedFallback++;
                else
                {
                    const d = lineDiff(before, got);
                    const which = d.lost === 0 && d.extra === 1 ? 0 : d.lost === 1 && d.extra === 1 ? 1 : d.lost === 1 ? (oneLine ? 2 : 3) : 4;
                    keep.added[which]++;

                    // (one replaced by several, the block on one line: whether keepLayout's one-line rule broke it up.
                    // The statement added makes the block (and each block around it on that line) longer by
                    // ' ckp_added = 1 ' less the block's written gap before its `}`; such a block breaks when its
                    // column (what stands before it on its line, a tab as 4) plus its grown width is over max(120, that
                    // column plus its written width), as scriptFormat.ts rebuilt() decides)
                    if (which === 2 && written)
                    {
                        const w = before.slice(written.s, written.e);
                        const grow = ' ckp_added = 1 '.length - (w.length - 1 - w.slice(0, -1).replace(/\s+$/, '').length);
                        const around = (list: PNode[]): PNode | undefined => list.find((x) => x.s <= written.s && written.e <= x.e);
                        let past = false;

                        for (let x = around(parseNodes(before)); x; x = Array.isArray(x.v) && x !== written ? around(x.v) : undefined)
                        {
                            const col = before.slice(before.lastIndexOf('\n', x.s - 1) + 1, x.s).replace(/\t/g, '    ').length;

                            if (!/\n/.test(before.slice(x.s, x.e)) && col + x.e - x.s + grow > Math.max(120, col + x.e - x.s))
                                past = true;
                        }

                        if (past)
                            keep.pastLimit++;
                        else if (examples.notPast.length < 5)
                            examples.notPast.push(`${f.slice(gameDir.length + 1)}:${n.line} ${JSON.stringify(before).slice(0, 200)} -> ${JSON.stringify(got).slice(0, 200)}`);
                    }

                    // (other: the same once blank lines are left out, the added line aside: only blank lines differ)
                    if (which === 4)
                    {
                        const noBlank = (s: string): string => s.split(/\r?\n/).filter((l) => l.trim()).join('\n');
                        const nb = lineDiff(noBlank(before), noBlank(got));

                        if (nb.lost === 0 && nb.extra === 1)
                            keep.blankOnly++;
                    }

                    if (which === 4 && examples.added.length < 5)
                        examples.added.push(`${f.slice(gameDir.length + 1)}:${n.line} ${JSON.stringify(before).slice(0, 200)} -> ${JSON.stringify(got).slice(0, 200)}`);
                }
            }
        }
    };
    walk(nodes, 0);
}

console.log(`keepLayout over ${keep.samples} game statements (${every === 1 ? 'all' : 'every ' + every + 'th; FULL=1 for all'}) in ${Math.round(performance.now() - t1)} ms: ${keep.notReprinted} not reprinted with the same tokens (skipped), ${keep.unchangedWrong} unchanged ones not kept byte for byte`);
console.log(`  a number changed: ${keep.value[0]} as written but that number, ${keep.value[1]} with one line different, ${keep.value[2]} with more; ${keep.valueFallback} fallbacks`);
console.log(`  a statement added: ${keep.added[0]} every written line kept and one more, ${keep.added[1]} one written line replaced by one, ${keep.added[2]} one replaced by several (the block written on one line; ${keep.pastLimit} of them wider than the one-line limit with the statement added), ${keep.added[3]} one replaced by several (the block over several lines), ${keep.added[4]} other (${keep.blankOnly} of them differ only in blank lines besides); ${keep.addedFallback} fallbacks`);
console.log(`keepWritten over ${kc.samples} game statements with comments (${every === 1 ? 'all' : 'every ' + every + 'th'}): ${kc.notReprinted} not reprinted with the same tokens (skipped), ${kc.unchangedWrong} unchanged ones not kept byte for byte`);
console.log(`  a number changed: ${kc.valueKept} every comment kept, ${kc.valueEditor} script editor, ${kc.valueGone} with a comment gone; a statement added: ${kc.addKept} every comment kept, ${kc.addEditor} script editor, ${kc.addGone} with a comment gone`);
console.log(`  the first or last statement removed: ${kc.removed} (${kc.skipped} skipped: not lined up), ${kc.agree} keep and drop the comments the main side's remove does, ${kc.twins} as the main side's remove of another statement written the same in that block (the picker's text does not tell which one went; ${kc.twinsKeepMore} of them keep a comment that remove drops, ${kc.twinsLoseMore} drop more), ${kc.disagree} do not, ${kc.removeEditor} script editor`);

for (const x of [...kcExamples.wrong, ...kcExamples.editor.map((e) => 'script editor: ' + e), ...kcExamples.disagree.map((e) => 'not as the main side: ' + e)])
    console.log('  keepWritten ' + x);

for (const x of examples.notPast)
    console.log('  one replaced by several, not past the limit: ' + x);

for (const x of examples.unchanged)
    console.log('  unchanged not kept: ' + x);

for (const x of examples.value)
    console.log('  number changed, more differs: ' + x);

for (const x of examples.added)
    console.log('  statement added, other: ' + x);

for (const f of refused)
    console.log('  refused     ' + f);

for (const f of unstable)
    console.log('  not stable  ' + f);

for (const f of notSame)
    console.log('  sameScript  ' + f);

process.exitCode = unstable.length || notSame.length || sampleFails || keep.unchangedWrong || keep.valueFallback || keep.addedFallback || kc.unchangedWrong || kc.valueGone || kc.addGone || kc.disagree || kc.twinsLoseMore || kc.removeEditor ? 1 : 0;
