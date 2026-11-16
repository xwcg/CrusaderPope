// Checks the value editor's knowledge of a value (src/renderer/src/components/valueKinds.ts): kindsOf (what is
// written, the catalog's statement, the key scan's shapes) and suggestValues with stubbed data (no index, no app).
// Light: no game files are read.
// Usage: node --experimental-strip-types --no-warnings scripts/value-kinds-check.ts
import type { Line, PickTarget, ScriptKeyInfo } from '../src/shared/api.ts';
import { COMMON_SCOPES, commonScopes, gameListNames, kindsLabel, kindsOf, listsRightAway, parseScalar, suggestValues, type ListName, type ValueKind, type ValueSources } from '../src/renderer/src/components/valueKinds.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const info = (key: string, shapes: ScriptKeyInfo['shapes'], values: [string, number][] = []): ScriptKeyInfo => ({ key, count: Object.values(shapes).reduce((a, n) => a + (n ?? 0), 0), shapes, values });
const kinds = (text: string, trigger = false, line?: Line, i?: ScriptKeyInfo): string =>
    kindsOf(parseScalar(text)!, trigger, line, i)
        .map((k: ValueKind) => (k.kind === 'entry' ? `entry:${k.type}` : k.kind))
        .join(',');

// --- kindsOf
check(kinds('add_gold = 100') === 'number', `add_gold = 100, no key scan: number (written, the catalog's number) → ${kinds('add_gold = 100')}`);
check(kinds('add_gold = 100', false, undefined, info('add_gold', { number: 90, scope: 10 })) === 'number,scope', `add_gold = 100 with scope shapes (10 %): number, scope → ${kinds('add_gold = 100', false, undefined, info('add_gold', { number: 90, scope: 10 }))}`);
check(kinds('add_gold = 100', false, undefined, info('add_gold', { number: 98, scope: 2 })) === 'number', 'a shape under 5 % of the uses is left out');
check(kinds('is_child_of = scope:x', true) === 'scope', `is_child_of = scope:x: scope → ${kinds('is_child_of = scope:x', true)}`);
check(kinds('gold > scope:cost', true) === 'scope,number', `gold > scope:cost (a comparison written with a scope): scope, then the catalog's number → ${kinds('gold > scope:cost', true)}`);
check(kinds('has_character_flag = my_flag', true).startsWith('flag'), `has_character_flag = x: a flag first → ${kinds('has_character_flag = my_flag', true)}`);
check(kinds('add_gold = var:stash').startsWith('variable') && kinds('add_gold = var:stash').includes('number'), `add_gold = var:stash: variable, number → ${kinds('add_gold = var:stash')}`);
check(kinds('add_to_list = my_list') === 'list', `add_to_list = x: a list's name → ${kinds('add_to_list = my_list')}`);
const traitLine: Line = { text: ['Has the trait ', { text: 'Brave', kind: 'entity', ref: { type: 'traits', name: 'brave' } }] };
check(kinds('has_trait = brave', true, traitLine).startsWith('entry:traits'), `has_trait = brave with its link: an entry of traits → ${kinds('has_trait = brave', true, traitLine)}`);
check(kinds('some_unknown_key = foo') === 'text', 'an unknown statement with a word: text');
check(kindsLabel(kindsOf(parseScalar('add_gold = 100')!, false, undefined, info('add_gold', { number: 90, scope: 10 }))) === 'number or script value, scope', 'kindsLabel names the set');
check(listsRightAway(kindsOf(parseScalar('is_child_of = scope:x')!, true)) && !listsRightAway(kindsOf(parseScalar('add_gold = 100')!, false)), 'a scope lists right away, a number waits for typing');

// --- suggestValues with stubbed data
const targets: PickTarget[] = [{ key: 'scope:child', label: 'Child', about: 'the new born' }];
let known = true;
const src: ValueSources = {
    scriptValues: async () => [{ name: 'medium_gold_value', display: 'Medium gold' }, { name: 'my_mod_gold', mine: true }],
    targets: () => targets,
    targetsKnown: () => known,
    values: async () => [{ key: 'scope:b2_amount', label: 'B2 amount', about: 'a value saved here: 50' }],
    lists: async () => [{ name: 'my_list' }, { name: 'other_list', about: 'added by my_effect' }],
    keyValues: async (key) => (key === 'has_character_flag' ? [['flag:used_flag', 7], ['used_two', 3]] : []),
    search: async (type, q) => (type === 'flag' ? [{ name: 'any_' + q }] : type === 'variable' ? [{ name: q + '_var' }] : type === 'traits' ? [{ name: 'brave', display: 'Brave' }] : [])
};
const values = async (text: string, typed: string, trigger = false, i?: ScriptKeyInfo, line?: Line): Promise<string[]> =>
{
    const s = parseScalar(text)!;
    return (await suggestValues(kindsOf(s, trigger, line, i), s.key, trigger, typed, src)).map((x) => x.value);
};

const g1 = await values('add_gold = 100', '');
check(g1.length === 0, 'a number, nothing typed: nothing offered');
const g2 = await values('add_gold = 100', '50');
check(g2.length === 0, 'a number, digits typed: nothing offered');
const g3 = await values('add_gold = 100', 'scope:');
check(g3.join() === 'scope:b2_amount', `a number, "scope:" typed: the saved values → ${g3.join()}`);
const g4 = await values('add_gold = 100', 'gold');
check(g4.join() === 'medium_gold_value,my_mod_gold', `a number, letters typed: the script values → ${g4.join()}`);
const g5 = await values('add_gold = 100', 'var:sta');
check(g5.join() === 'var:sta_var', `a number, "var:" typed: the variables, prefix kept → ${g5.join()}`);
const g6 = await values('add_gold = 100', 'scope:', false, info('add_gold', { number: 80, scope: 20 }));
check(g6[0] === 'scope:b2_amount' && g6.includes('scope:child') && !g6.includes('scope:actor'), `a number also used with scopes, "scope:": saved values, then the entry's scopes; known scopes: no actor → ${g6.join()}`);

known = true;
const s1 = await values('is_child_of = scope:x', '', true);
check(s1[0] === 'scope:child' && !s1.includes('scope:actor') && !s1.includes('scope:recipient') && s1.includes('root') && s1.includes('prev'), `a scope, the entry's scopes known: its own first, no interaction scopes → ${s1.slice(0, 6).join()}`);
known = false;
const s2 = await values('is_child_of = scope:x', '', true);
check(s2.includes('scope:actor') && s2.includes('scope:secondary_recipient'), 'a scope, scopes not known: the interaction scopes are offered');
known = true;
targets.push({ key: 'scope:actor', label: 'Actor' });
const s3 = await values('is_child_of = scope:x', 'actor', true);
check(s3.filter((v) => v === 'scope:actor').length === 1, `known scopes that include the actor: offered once (its own row) → ${s3.join()}`);
targets.pop();
check(commonScopes(true, []).length === COMMON_SCOPES.length - 4 && commonScopes(false, []).length === COMMON_SCOPES.length, 'commonScopes: the four interaction scopes only when not known');
const s4 = await values('is_child_of = scope:x', 'scope:', true, info('is_child_of', { scope: 50, number: 50 }));
check(s4[0] === 'scope:child' && s4.includes('scope:b2_amount'), `a scope also used with numbers, "scope:" typed: the scopes first, then the saved values → ${s4.join()}`);
const s5 = await values('is_child_of = scope:x', 'med', true, info('is_child_of', { scope: 50, number: 50 }));
check(s5.includes('medium_gold_value'), `a scope also used with numbers, letters typed: script values too → ${s5.join()}`);

// (the shown entry's scopes where the edited statement is: one saved later in the file is left out; docs/picker.md "Scopes in reach")
targets.push({ key: 'scope:later_one', label: 'Later one', reach: { file: 'D:/m/events/x.txt', def: [0, 1000], ranges: [[500, 900]] } });
const placed = async (offset: number | undefined): Promise<string[]> => (await suggestValues([{ kind: 'scope' }], 'is_child_of', true, '', { ...src, place: offset === undefined ? undefined : { file: 'D:/m/events/x.txt', offset } })).map((x) => x.value);
const r1 = await placed(100);
const r2 = await placed(600);
const r3 = await placed(undefined);
check(!r1.includes('scope:later_one') && r1.includes('scope:child'), `a scope before the save of one: it is left out, the others stay → ${r1.slice(0, 4).join()}`);
check(r2.includes('scope:later_one') && r3.includes('scope:later_one'), 'after its save, and with no place known: offered');
targets.pop();

const f1 = await values('has_character_flag = my_flag', '', true);
check(f1.join() === 'used_flag,used_two', `a flag, nothing typed: the ones the game writes with it → ${f1.join()}`);
const f2 = await values('has_character_flag = my_flag', 'flag:us', true);
check(f2[0] === 'flag:used_flag' && f2.includes('flag:any_us'), `a flag, "flag:us" typed: prefix kept, then any flag → ${f2.join()}`);
const l1 = await values('add_to_list = my_list', 'oth');
check(l1.join() === 'other_list', `a list's name: the lists the entry adds to → ${l1.join()}`);

// (the list names: the ones in reach first with where they come from, then the game's, marked; the owner's E6 decision)
{
    const REACH_FILE = 'D:/m/events/x.txt';
    const own: ListName[] = [
        { name: 'own_list' },
        { name: 'called_list', about: 'added by my_effect' },
        { name: 'later_list', about: 'a list this entry adds to', reach: { file: REACH_FILE, def: [0, 1000], ranges: [[500, 900]] } }
    ];
    const lsrc: ValueSources = { ...src, lists: async () => own, gameLists: async () => [['game_list', 40], ['own_list', 12], ['later_list', 9], ['rare_list', 1]] };
    const rows = async (typed: string, offset?: number): Promise<{ value: string; hint?: string; }[]> =>
        suggestValues([{ kind: 'list' }], 'is_in_list', true, typed, { ...lsrc, place: offset === undefined ? undefined : { file: REACH_FILE, offset } });
    const at100 = await rows('', 100);
    check(at100.map((r) => r.value).join() === 'own_list,called_list,game_list,rare_list', `list names before a save: in reach first, then the game's; the entry's own out of reach left out, also from the game's → ${at100.map((r) => r.value).join()}`);
    check(at100[0].hint === 'a list this entry adds to' && at100[1].hint === 'added by my_effect' && at100[2].hint === 'used 40× in the game', `list hints: own, a called effect's, the game's count → ${at100.map((r) => r.hint).join(' | ')}`);
    const at600 = await rows('', 600);
    check(at600.map((r) => r.value).join() === 'own_list,called_list,later_list,game_list,rare_list', `list names after its save: the later one too → ${at600.map((r) => r.value).join()}`);
    const typedL = await rows('ra');
    check(typedL.map((r) => r.value).join() === 'rare_list', `list names, "ra" typed: filtered → ${typedL.map((r) => r.value).join()}`);
    const noGame = await suggestValues([{ kind: 'list' }], 'is_in_list', true, '', { ...src, lists: async () => own });
    check(noGame.map((r) => r.value).join() === 'own_list,called_list,later_list', 'no game list source: the entry\'s only (no place: every one)');
}

// (gameListNames: the key scan's list statements and the *_in_list iterators' `list` field, summed, most used first)
{
    const effects: ScriptKeyInfo[] = [
        { ...info('add_to_list', { name: 10 }, [['a_list', 7], ['b_list', 3]]) },
        { ...info('add_to_temporary_list', { name: 2 }, [['t_list', 2]]) },
        { ...info('every_in_list', { block: 5 }), fieldValues: { list: [['a_list', 4], ['scope:x', 1]] } },
        { ...info('add_gold', { number: 5 }, [['a_list', 99]]) }
    ];
    const triggers: ScriptKeyInfo[] = [
        { ...info('is_in_list', { name: 6 }, [['b_list', 6]]) },
        { ...info('any_in_list', { block: 1 }), fieldValues: { list: [['c_list', 1]] } }
    ];
    const g = gameListNames(effects, triggers);
    check(g.map(([n, c]) => `${n}:${c}`).join() === 'a_list:11,b_list:9,t_list:2,c_list:1', `gameListNames: summed per name, other keys and non-words left out → ${g.map(([n, c]) => `${n}:${c}`).join()}`);
    check(gameListNames(undefined, undefined).length === 0, 'gameListNames: no scan loaded, nothing');
}

// (the saved values where the edited statement is: one saved in another option is left out)
{
    const VFILE = 'D:/m/events/v.txt';
    const vsrc: ValueSources = { ...src, values: async () => [{ key: 'scope:b2_amount', label: 'B2 amount' }, { key: 'scope:opt_a_value', label: 'Opt a value', reach: { file: VFILE, def: [0, 1000], ranges: [[100, 200], [800, 900]] } }] };
    const at = async (offset?: number): Promise<string[]> => (await suggestValues([{ kind: 'number' }], 'add_gold', false, 'scope:', { ...vsrc, place: offset === undefined ? undefined : { file: VFILE, offset } })).map((x) => x.value);
    const inB = await at(500);
    const inA = await at(150);
    check(inB.join() === 'scope:b2_amount', `a number, "scope:" typed in option b: a value saved in option a left out → ${inB.join()}`);
    check(inA.join() === 'scope:b2_amount,scope:opt_a_value' && (await at()).length === 2, 'a number in option a after its save, and with no place: offered');
}
const t1 = await values('has_trait = brave', 'trait:bra', true, undefined, traitLine);
check(t1[0] === 'trait:brave', `an entry, "trait:bra" typed: prefix kept → ${t1.join()}`);
const t2 = (await suggestValues([{ kind: 'entry', type: 'traits', prefix: 'trait:' }], 'x', false, 'bra', src)).map((x) => x.value);
check(t2.join() === 'trait:brave', `an entry whose parameter has a prefix, "bra" typed: the parameter's prefix added → ${t2.join()}`);
const t3 = (await suggestValues([{ kind: 'entry', type: 'traits' }], 'x', false, 'bra', src)).map((x) => x.value);
check(t3.join() === 'brave', `an entry without a prefix, "bra" typed: no prefix → ${t3.join()}`);

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
