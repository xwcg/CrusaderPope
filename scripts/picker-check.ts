// Checks the statement picker's catalog (src/shared/scriptCatalog.ts) against the game's script: every effect,
// trigger and iterator it writes must be used by the game in the same role (effect / trigger block), and fills the
// templates of every statement. Also prints the most used keys the catalog does not cover (candidates to add).
// Then the key scan's incremental rescan: an editable mod's files changed, added and removed are taken in like a full
// scan would (scripts/picker-check.ts … prints "rescan: ok"). Then the menus (picker/model.ts): paths of rows chosen by
// their labels against the script they must build ("menus: N scenarios ok").
// Usage: node --experimental-strip-types scripts/picker-check.ts [installDir] [top]
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameFiles, type GameFile } from '../src/main/mods/gamefiles.ts';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { ScriptKeyScanner } from '../src/main/describe/scriptKeys.ts';
import { ITERATORS, STATEMENTS, fillTemplate, parseSnippet, printScript, type StatementDef } from '../src/shared/scriptCatalog.ts';
import type { EntryCreate, ModInfo, ModifierKeyInfo, ScriptKeys } from '../src/shared/api.ts';
import { canPickEdit, chainType, menuOf, usedCreates, resultText, startStates, type Item, type Next, type PickerData, type RefEntry, type State } from '../src/renderer/src/picker/model.ts';
import { scopeOf } from '../src/shared/scriptCatalog.ts';
import { firstSelectable, rowsOf } from '../src/renderer/src/picker/rows.ts';
import { defaultInstall } from './ck3-install.ts';

const gameDir = resolveGameDir(process.argv[2] ?? defaultInstall());

if (!gameDir)
    throw new Error('No CK3 game folder');

const TOP = Number(process.argv[3] ?? 40);

const t0 = performance.now();
const scan = new ScriptKeyScanner().scan(new GameFiles(gameDir));
console.log(`scanned in ${Math.round(performance.now() - t0)} ms: ${scan.effect.length} effect keys, ${scan.trigger.length} trigger keys`);
const known = { effect: new Map(scan.effect.map((k) => [k.key, k.count])), trigger: new Map(scan.trigger.map((k) => [k.key, k.count])) };

/** The keys a statement writes (a choice filling the key gives one per option). */
function keysOf(d: StatementDef): string[]
{
    const k = /^[\w$]+/.exec(d.script)?.[0] ?? '';
    const c = d.params.find((p) => p.kind === 'choice' && k.includes(`$${p.name}$`));
    return c && c.kind === 'choice' ? c.options.map((o) => k.replace(`$${c.name}$`, o.value)) : [k];
}

let bad = 0;
const covered = new Set<string>();

for (const d of STATEMENTS)
{
    for (const k of keysOf(d))
    {
        covered.add(d.kind + ':' + k);

        if (d.subjectValue || known[d.kind].has(k))
            continue;

        console.log(`NOT USED BY THE GAME as ${d.kind}: ${k} (${d.id})`);
        bad++;
    }

    // the template with sample values parses and prints
    const values: Record<string, string> = {};

    for (const p of d.params)
        values[p.name] = p.kind === 'choice' ? p.options[0].value : p.kind === 'compare' ? '>=' : p.kind === 'duration' ? 'years = 5' : p.kind === 'number' ? '10' : 'x';

    values.subject = 'liege';
    const text = printScript(parseSnippet(fillTemplate(d, values)));

    if (!text || /\$\w+\$|[[\]]/.test(text))
    {
        console.log(`BAD TEMPLATE ${d.id}: ${text}`);
        bad++;
    }
}

for (const i of ITERATORS)
{
    if (i.effect && !known.effect.has('every_' + i.list))
        (console.log(`NOT USED: every_${i.list}`), bad++);

    if (i.trigger && !known.trigger.has('any_' + i.list))
        (console.log(`NOT USED: any_${i.list}`), bad++);
}

const effects = STATEMENTS.filter((s) => s.kind === 'effect' && !s.hidden).length;
const triggers = STATEMENTS.filter((s) => s.kind === 'trigger').length;
console.log(`catalog: ${effects} effects, ${triggers} triggers, ${ITERATORS.length} iterators — ${bad ? bad + ' problems' : 'all used by the game'}`);

for (const kind of ['effect', 'trigger'] as const)
{
    const miss = scan[kind].filter((k) => !k.scripted && !covered.has(kind + ':' + k.key) && !/^(every|random|ordered|any)_/.test(k.key)).slice(0, TOP);
    console.log(`\nmost used ${kind}s not in the catalog (reachable through "Other…"):\n` + miss.map((k) => `${k.key}:${k.count}`).join('  '));
}

// ---------------------------------------------------------------------------
// The key scan's rescan (an incremental index update): an editable mod's files changed, added, removed
// ---------------------------------------------------------------------------

{
    const tmp = mkdtempSync(join(tmpdir(), 'ckp-keys-'));
    const root = join(tmp, 'keys_test');
    const write = (rel: string, text: string): void =>
    {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), text);
    };
    const EV = 'events/keys_test_events.txt';
    const SE = 'common/scripted_effects/keys_test_effects.txt';
    write(EV, 'namespace = keys_test\nkeys_test.1 = {\n\timmediate = {\n\t\tkeys_test_first_effect = yes\n\t\tadd_gold = 7\n\t}\n}\n');
    const mod: ModInfo = { id: 'mod/keys_test.mod', name: 'Keys Test', tags: [], root, source: 'local', replacePaths: [], status: 'ok', editable: true };
    const own = (files: GameFiles) => (g: GameFile): boolean => g.source > 0 && files.sources[g.source]?.modId === mod.id;
    /** what a full scan of the files as they are now gives: count and shapes per key */
    const full = (): ScriptKeys =>
    {
        const files = new GameFiles(gameDir!, [mod]);
        return new ScriptKeyScanner().scan(files, undefined, own(files));
    };
    const sig = (k: ScriptKeys): string =>
        (['effect', 'trigger'] as const).map((kind) =>
            k[kind]
                .map((x) => `${x.key}:${x.count}:${JSON.stringify(Object.entries(x.shapes).sort())}`)
                .sort()
                .join('\n')
        ).join('\n--\n');
    const files = new GameFiles(gameDir, [mod]);
    const scanner = new ScriptKeyScanner();
    let t = performance.now();
    const first = scanner.scan(files, undefined, own(files));
    const ms0 = Math.round(performance.now() - t);
    let problems = 0;
    const has = (k: ScriptKeys, kind: 'effect' | 'trigger', key: string): boolean => k[kind].some((x) => x.key === key);

    if (!has(first, 'effect', 'keys_test_first_effect'))
        (console.log("RESCAN: the mod's key is missing after the first scan"), problems++);

    // a changed file, a new file (a scripted effect with a condition), then the first file removed
    const steps: [string, () => string[], (k: ScriptKeys) => boolean][] = [
        ['changed', () => (write(EV, 'namespace = keys_test\nkeys_test.1 = {\n\timmediate = {\n\t\tkeys_test_second_effect = 3\n\t\tadd_gold = 8\n\t}\n}\n'), [EV]), (k) => has(k, 'effect', 'keys_test_second_effect') && !has(k, 'effect', 'keys_test_first_effect')],
        ['added', () => (write(SE, 'keys_test_effect = {\n\tif = {\n\t\tlimit = { keys_test_condition = yes }\n\t\tadd_prestige = 5\n\t}\n}\n'), [SE]), (k) => has(k, 'trigger', 'keys_test_condition')],
        ['removed', () => (unlinkSync(join(root, EV)), [EV]), (k) => !has(k, 'effect', 'keys_test_second_effect')]
    ];

    for (const [what, change, ok] of steps)
    {
        const rels = change();
        t = performance.now();
        const done = scanner.rescan(files, rels);
        const got = scanner.keys();
        const ms = Math.round(performance.now() - t);
        const want = full();

        if (!done || !ok(got) || sig(got) !== sig(want))
            (console.log(`RESCAN (${what}): ${!done ? 'refused' : !ok(got) ? 'the change is not in the keys' : 'differs from a full scan'}`), problems++);
        else
            console.log(`rescan (${what}): ${ms} ms, same as a full scan`);
    }

    // a vanilla file's path: only a full scan takes it in
    if (scanner.rescan(files, ['common/traits/00_traits.txt']))
        (console.log('RESCAN: a summed-up file was taken in without a full scan'), problems++);

    files.close();
    rmSync(tmp, { recursive: true, force: true });
    console.log(`rescan: ${problems ? problems + ' problems' : 'ok'} (first scan ${ms0} ms)`);
}

// ---------------------------------------------------------------------------
// The menus (picker/model.ts): paths of rows chosen by their labels, and the script they build
// ---------------------------------------------------------------------------

{
    const entry = (name: string, refs = 1, display?: string): RefEntry => ({ name, refs, display });
    const LISTS: Record<string, RefEntry[]> = {
        traits: [entry('brave', 90, 'Brave'), entry('craven', 80, 'Craven'), entry('shy', 70, 'Shy')],
        opinion_modifiers: [entry('respect_opinion', 50, 'Respect')],
        scripted_relations: [entry('friend', 40, 'Friend'), entry('rival', 30, 'Rival')],
        secret_types: [entry('secret_lover', 10, 'Lover')],
        modifiers: [entry('my_modifier', 5)],
        events: [entry('my_events.1', 3)]
    };
    // (stat modifiers and where the game puts them)
    const MODS: ModifierKeyInfo[] = [
        { key: 'diplomacy', label: 'Diplomacy', percent: false, color: 'good', count: 90, kinds: { character: 90 } },
        { key: 'tax_mult', label: 'Tax', percent: true, color: 'good', count: 40, kinds: { landed_title: 30, province: 20, character: 1 } },
        { key: 'fort_level', label: 'Fort level', percent: false, color: 'good', count: 20, kinds: { province: 20 } }
    ];
    const data: PickerData = {
        list: (t) => LISTS[t] ?? [],
        loaded: async () => undefined,
        big: (t) => t === 'characters',
        search: async () => [],
        keys: (k) => scan[k],
        keysLoaded: async () => undefined,
        modifiers: () => MODS,
        modifiersLoaded: async () => undefined,
        // (the values the game writes for a key, the keys a type writes)
        suggestions: (source) =>
            source === 'values:buildings:construction_time'
                ? [{ value: 'slow_construction_time', count: 397, label: '397×' }, { value: '730', count: 4, label: '4×' }]
                : source === 'keys:buildings'
                ? [{ value: 'construction_time', count: 963, label: '963×' }, { value: 'ai_value', count: 12, label: '12×' }]
                : [],
        suggestionsLoaded: async () => undefined,
        activeMod: () => undefined,
        locCodes: () => undefined,
        locCodesLoaded: async () => undefined
    };
    type Step = string | { n: number; } | { input: string; };
    /** a row by its label (exactly, else the first starting with it), a typed number, or the typed text's row */
    const choose = (s: State, p: Step): Next =>
    {
        const m = menuOf(s, data);
        const item: Item | null | undefined = typeof p === 'string'
            ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p)))
            : 'n' in p
            ? m.number?.(p.n, String(p.n))[0]
            : m.input?.(p.input);

        if (!item?.go)
            throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

        return item.go();
    };
    const run = (req: Req, path: Step[]): string =>
    {
        const starts = startStates(req.kind, scopeOf(req.scope), undefined, req.type, req.edit, undefined, undefined, undefined, undefined, { modScope: req.kind === 'modifier' && req.scope ? scopeOf(req.scope) : undefined, elseAfter: req.elseAfter });
        // (a menu further up taking the result — a block's field — is the model's `back`: the state goes on the same)
        let s = starts[starts.length - 1].state;

        for (const p of path)
        {
            const n = choose(s, p);

            if ('finish' in n)
                return resultText(n.state ?? s);

            s = n.state;
        }

        return resultText(s);
    };
    const E = 'Effect on character…';
    const T = 'You (self) are…';
    type Req = { kind: 'effect' | 'trigger' | 'modifier' | 'field'; edit?: string; scope?: string; type?: string; elseAfter?: boolean; };
    const gold = [E, 'You (self)', 'Add…', 'Gold', { n: 100 }];
    const prestige = [E, 'You (self)', 'Add…', 'Prestige', { n: 50 }];
    const scenarios: [string, Req, Step[], string][] = [
        // settings: a trait's opposites (values alone), compatibility (any trait, a number), track levels; a type's own
        // settings with the named values the game writes; "Other setting…"
        ['Trait: an opposite', { kind: 'field', type: 'trait_opposites' }, ['Craven', 'Done'], 'craven'],
        ['Trait: change an opposite', { kind: 'field', type: 'trait_opposites', edit: 'craven' }, ['Shy', 'Done'], 'shy'],
        ['Trait: a compatibility', { kind: 'field', type: 'trait_compatibility' }, ['Brave', { n: 15 }, 'Done'], 'brave = 15'],
        ['Trait: change a compatibility', { kind: 'field', type: 'trait_compatibility', edit: 'brave = @pos_compat_high' }, ['-30', 'Done'], 'brave = -30'],
        ['Trait: a track level', { kind: 'field', type: 'trait_track' }, ['50', 'Done'], '50 = { }'],
        ['Building: construction time by its named value', { kind: 'field', type: 'buildings' }, ['Construction time (days)', 'Slow construction time', 'Done'], 'construction_time = slow_construction_time'],
        ['Building: another setting', { kind: 'field', type: 'buildings' }, ['Other setting…', 'ai_value', { input: '5' }, 'Done'], 'ai_value = 5'],
        ['Character: female', { kind: 'field', type: 'characters' }, ['Female', 'Done'], 'female = yes'],
        ['Character: a name with a space, quoted', { kind: 'field', type: 'characters' }, ['Name…', { input: 'Abu Abdallah' }, 'Done'], 'name = "Abu Abdallah"'],
        ['Character: a name with other letters, quoted', { kind: 'field', type: 'characters' }, ['Name…', { input: 'Þórir' }, 'Done'], 'name = "Þórir"'],
        ['Character: change a written name', { kind: 'field', type: 'characters', edit: 'name = "Harald"' }, [{ input: 'Guðrøðr' }, 'Done'], 'name = "Guðrøðr"'],
        ['Character: change the faith', { kind: 'field', type: 'characters', edit: 'religion = catholic' }, [{ input: 'orthodox' }, 'Done'], 'religion = orthodox'],
        // modifiers: a county's block offers the county modifiers; every one is still reachable
        ['County modifiers', { kind: 'modifier', scope: 'landed_title' }, ['All county modifiers…', 'Tax %', { n: 10 }, 'Done'], 'tax_mult = 0.1'],
        ['County block: diplomacy only under Every modifier', { kind: 'modifier', scope: 'landed_title' }, ['Every modifier…', 'Diplomacy', { n: 2 }, 'Done'], 'diplomacy = 2'],
        ['Province modifiers', { kind: 'modifier', scope: 'province' }, ['All province modifiers…', 'Fort level', { n: 1 }, 'Done'], 'fort_level = 1'],
        ['When… on the last one only', { kind: 'effect' }, [...gold, 'And also…', ...prestige, 'When…', 'Only the last', T, 'Adult', 'Done'], 'add_gold = 100\nif = {\n\tlimit = { is_adult = yes }\n\tadd_prestige = 50\n}'],
        ['When… on everything', { kind: 'effect' }, [...gold, 'And also…', ...prestige, 'When…', 'Everything here', T, 'Adult', 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n\tadd_prestige = 50\n}'],
        ['Otherwise…', { kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}\nelse = { add_prestige = 50 }'],
        ['Otherwise, when…', { kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise, when…', T, 'Male', 'Then…', ...prestige, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}\nelse_if = {\n\tlimit = { is_male = yes }\n\tadd_prestige = 50\n}'],
        ['Random list', { kind: 'effect' }, [...gold, 'One of several outcomes…', 'Weight 75', 'Another outcome…', 'Weight 25', ...prestige, 'Done'], 'random_list = {\n\t75 = { add_gold = 100 }\n\t25 = { add_prestige = 50 }\n}'],
        [
            'Switch',
            { kind: 'effect' },
            [...gold, 'Depending on…', 'Trait (has)', 'Brave', ...prestige, 'Back out', 'Another case…', 'Craven', E, 'You (self)', 'Add…', 'Stress', { n: 10 }, 'Back out', 'In no case (fallback)…', E, 'You (self)', 'Add…', 'Piety', { n: 5 }, 'Done'],
            'add_gold = 100\nswitch = {\n\ttrigger = has_trait\n\tbrave = { add_prestige = 50 }\n\tcraven = { add_stress = 10 }\n\tfallback = { add_piety = 5 }\n}'
        ],
        ['Chance on a part', { kind: 'effect' }, [...gold, 'And also…', ...prestige, 'Chance…', 'Only the last', '50%', 'Done'], 'add_gold = 100\nrandom = { chance = 50 add_prestige = 50 }'],
        ['Only when (trigger_if)', { kind: 'trigger' }, [T, 'Adult', 'Only when…', T, 'Male', 'Done'], 'trigger_if = {\n\tlimit = { is_male = yes }\n\tis_adult = yes\n}'],
        ['Only when, otherwise', { kind: 'trigger' }, [T, 'Adult', 'Only when…', T, 'Male', 'Back out', 'Otherwise…', T, 'AI', 'Done'], 'trigger_if = {\n\tlimit = { is_male = yes }\n\tis_adult = yes\n}\ntrigger_else = { is_ai = yes }'],
        ['At least some (calc_true_if)', { kind: 'trigger' }, [T, 'Adult', 'And also…', T, 'Male', 'And also…', T, 'AI', 'At least some of these…', 'Everything here', 'At least 2 of the 3', 'Done'], 'calc_true_if = { amount >= 2 is_adult = yes is_male = yes is_ai = yes }'],
        ['Every relation of a type', { kind: 'effect' }, [E, 'Every…', 'Every relation…', 'Friend', 'Add…', 'Prestige', { n: 10 }, 'Done'], 'every_relation = { type = friend add_prestige = 10 }'],
        ['Any relation, how many', { kind: 'trigger' }, ['Any of their…', 'Any relation…', 'Rival', 'Adult', 'How many of them…', 'At least 2', 'Done'], 'any_relation = { type = rival count >= 2 is_adult = yes }'],
        ['Any child, all of them', { kind: 'trigger' }, ['Any of their…', 'Any child', 'Adult', 'How many of them…', 'All of them', 'Done'], 'any_child = { count = all is_adult = yes }'],
        ['The child with the highest age', { kind: 'effect' }, [E, 'The one with the highest…', 'The child with the highest…', 'Highest age', 'Add…', 'Prestige', { n: 10 }, 'Done'], 'ordered_child = { order_by = age add_prestige = 10 }'],
        ['Only those who (a typed relation)', { kind: 'effect' }, [E, 'A random…', 'A random relation…', 'Friend', 'Add…', 'Gold', { n: 5 }, 'Only those who…', 'A random friend is…', 'Adult', 'Done'], 'random_relation = {\n\ttype = friend\n\tlimit = { is_adult = yes }\n\tadd_gold = 5\n}'],
        ['Relation with a reason', { kind: 'effect' }, [E, 'You (self)', 'Set / change…', 'Relation…', 'Friend', 'Root', { input: 'friend_saved_my_life' }, 'Done'], 'set_relation_friend = { target = root reason = friend_saved_my_life }'],
        ['Relation without a reason', { kind: 'effect' }, [E, 'You (self)', 'Set / change…', 'Relation…', 'Rival', 'Root', 'No reason given', 'Done'], 'set_relation_rival = root'],
        // changing written statements
        ['Change: an opinion with years', { kind: 'effect', edit: 'add_opinion = { target = root modifier = respect_opinion opinion = 30 years = 5 }' }, ['Keep', 'Keep', 'Keep', '10 years', 'Done'], 'add_opinion = { target = root modifier = respect_opinion opinion = 30 years = 10 }'],
        ['Change: an opinion without a value', { kind: 'effect', edit: 'add_opinion = { modifier = respect_opinion target = liege }' }, ['Keep', 'Root', 'Keep', 'Keep', 'Done'], 'add_opinion = { target = root modifier = respect_opinion }'],
        ['Change: other fields kept', { kind: 'effect', edit: 'add_character_modifier = { modifier = my_modifier years = 5 desc = my_desc }' }, ['Keep', '2 years', 'Done'], 'add_character_modifier = { modifier = my_modifier years = 2 desc = my_desc }'],
        ['Change: a condition in NOT', { kind: 'trigger', edit: 'NOT = { has_trait = brave }' }, ['Craven', 'Done'], 'NOT = { has_trait = craven }'],
        ['Change: OR into NOR', { kind: 'trigger', edit: 'OR = { is_adult = yes is_male = yes }' }, ['None of these', 'Done'], 'NOR = { is_adult = yes is_male = yes }'],
        ['Change: an if, another condition', { kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }' }, ['Another condition…', T, 'Male', 'Done'], 'if = {\n\tlimit = { is_adult = yes is_male = yes }\n\tadd_gold = 5\n}'],
        // (if / else chains stay together: a part never starts at an else; a written chain's member is not wrapped)
        ['Chance on an if and its else', { kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Back out', 'Chance…', '50%', 'Done'], 'random = {\n\tchance = 50\n\tif = {\n\t\tlimit = { is_adult = yes }\n\t\tadd_gold = 100\n\t}\n\telse = { add_prestige = 50 }\n}'],
        [
            'When… from the if on (its else along)',
            { kind: 'effect' },
            [...prestige, 'And also…', ...gold, 'When…', 'Only the last', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Back out', 'When…', 'From “if', T, 'Male', 'Done'],
            'add_prestige = 50\nif = {\n\tlimit = { is_male = yes }\n\tif = {\n\t\tlimit = { is_adult = yes }\n\t\tadd_gold = 100\n\t}\n\telse = { add_prestige = 50 }\n}'
        ],
        ['Change: an else, another effect inside', { kind: 'effect', edit: 'else = { add_gold = 5 }' }, ['Another effect inside…', ...gold, 'Done'], 'else = { add_gold = 5 add_gold = 100 }'],
        ['Change: an if, then otherwise', { kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }' }, ['What next…', 'Otherwise…', E, 'You (self)', 'Add…', 'Gold', { n: 1 }, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 5\n}\nelse = { add_gold = 1 }'],
        ['Change: an iterator, another list', { kind: 'effect', edit: 'every_child = { add_gold = 5 }' }, ['Another list…', 'Every vassal', 'Done'], 'every_vassal = { add_gold = 5 }'],
        // (conversions keep only what the new list / mode takes: its kind, its mode's parameters)
        ['Change: a relation list to children drops its kind', { kind: 'effect', edit: 'every_relation = { type = friend add_gold = 5 }' }, ['Another list…', 'Every child', 'Done'], 'every_child = { add_gold = 5 }'],
        ['Change: a random child with weight to every child', { kind: 'effect', edit: 'random_child = { weight = { base = 1 } add_gold = 5 }' }, ['Every / a random', 'Every child', 'Done'], 'every_child = { add_gold = 5 }'],
        ['Change: the highest child to a random one', { kind: 'effect', edit: 'ordered_child = { order_by = age max = 2 position = 1 add_gold = 5 }' }, ['Every / a random', 'A random child', 'Done'], 'random_child = { add_gold = 5 }'],
        ['Change: an iterator, a random one', { kind: 'effect', edit: 'every_child = { add_gold = 5 }' }, ['Every / a random', 'A random child', 'Done'], 'random_child = { add_gold = 5 }'],
        ['Change: a relation iterator, its kind', { kind: 'trigger', edit: 'any_relation = { type = friend is_adult = yes }' }, ['Which relation', 'Rival', 'How many of them…', 'All of them', 'Done'], 'any_relation = { type = rival count = all is_adult = yes }'],
        ['Change: a scope switch, someone else', { kind: 'effect', edit: 'liege = { add_gold = 5 }' }, ['Someone (something) else instead…', 'Your primary spouse', 'Done'], 'primary_spouse = { add_gold = 5 }'],
        ['Change: a chance', { kind: 'effect', edit: 'random = { chance = 50 add_gold = 5 }' }, ['Another chance', '25%', 'Done'], 'random = { chance = 25 add_gold = 5 }'],
        ['Change: any block, field by field', { kind: 'effect', edit: 'create_character = { age = 16 gender = male }' }, ['age', { input: '18' }, 'Add a field…', { input: 'dynasty' }, { input: 'generate' }, 'Done'], 'create_character = { age = 18 gender = male dynasty = generate }'],
        ['A scripted effect, parameter by parameter', { kind: 'effect' }, ['Other effect…', 'had_sex_with_effect', { input: 'scope:lover' }, 'pregnancy_chance', 'Done'], 'had_sex_with_effect = { CHARACTER = scope:lover PREGNANCY_CHANCE = pregnancy_chance }']
    ];
    let bad = 0;

    for (const [name, req, path, want] of scenarios)
    {
        let got: string;

        try
        {
            got = run(req, path);
        }
        catch (e)
        {
            got = 'ERROR ' + (e as Error).message;
        }

        if (got !== want)
        {
            bad++;
            console.log(`MENUS ${name}:\n${got}\n  wanted:\n${want}`);
        }
    }

    // (typed chains: their type from the links and the saved scopes in reach; a warning where another type is wanted)
    {
        const s0 = startStates('effect', 'character')[0].state;
        const s: State = { ...s0, targets: [{ key: 'scope:my_title', label: 'My title', type: 'landed_title' }, { key: 'scope:friend', label: 'Friend' }] };
        const checks: [string, string | undefined, boolean][] = [
            ['scope:my_title.holder', 'character', false],
            ['scope:my_title', 'landed_title', false],
            ['liege.faith', 'faith', false],
            ['scope:friend.primary_title', 'landed_title', false],
            ['faith.liege', undefined, true],
            ['scope:unknown.liege', undefined, false]
        ];

        for (const [expr, type, problem] of checks)
        {
            const c = chainType(s, expr, 'character');

            if (c.type !== type || !!c.problem !== problem)
                (console.log(`MENUS chain ${expr}: ${JSON.stringify(c)}`), bad++);
        }

        // "Towards whom?" typed a title: written, with a warning
        let st: State = s;

        for (const p of [E, 'You (self)', 'Set / change…', 'Designated heir'])
            st = (choose(st, p) as { state: State; }).state;

        const typed = menuOf(st, data).input?.('scope:my_title');

        if (!typed?.warn || typed.label !== 'Use “scope:my_title”')
            (console.log(`MENUS typed chain warning: ${JSON.stringify(typed)}`), bad++);

        // a typed subject of a known type: its statements
        st = s;

        for (const p of [E, 'Someone else…'])
            st = (choose(st, p) as { state: State; }).state;

        const subject = menuOf(st, data).input?.('scope:my_title');
        const next = subject?.go?.();

        if (!next || 'finish' in next || !menuOf(next.state, data).items.some((i) => i.label === 'County modifier' || i.label.startsWith('Add')))
            (console.log(`MENUS typed title subject: ${next && !('finish' in next) ? menuOf(next.state, data).items.map((i) => i.label).join(' | ') : 'none'}`), bad++);

        // an "Other…" key whose values the game writes are characters: a typed title is flagged, a typed character not
        const key = { key: 'test_key', count: 10, shapes: { scope: 10 }, values: [['root', 5], ['liege', 3], ['primary_spouse', 2]] as [string, number][] };
        const other = menuOf({ ...s, view: { v: 'otherValue', key } }, data);

        if (!other.input?.('primary_title')?.warn || other.input?.('scope:friend')?.warn || other.input?.('yes')?.warn)
            (console.log(`MENUS Other… value check: ${JSON.stringify([other.input?.('primary_title'), other.input?.('scope:friend')])}`), bad++);
    }

    // "＋ New trait…" / "＋ New event…": the key (events: the next free id) and the name asked, the key used, the entry
    // remembered for making (PickResult.creates); only where the caller makes them (PickRequest.newEntries)
    {
        const d2: PickerData = {
            ...data,
            activeMod: () => 'mod/test.mod',
            newPlan: (type) => ({ type, label: type === 'events' ? 'Events' : 'Traits', mod: 'Test', rel: `common/${type}/test_${type}.txt`, key: type === 'events' ? 'test.0001' : undefined, name: true }),
            newPlanLoaded: async () => undefined
        };
        const walk = (newEntries: boolean, path: Step[]): State =>
        {
            let st = startStates('effect', 'character', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { newEntries })[0].state;

            for (const p of path)
            {
                const m = menuOf(st, d2);
                const item = typeof p === 'string' ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p))) : 'n' in p ? m.number?.(p.n, String(p.n))[0] : m.input?.(p.input);

                if (!item?.go)
                    throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

                const n = item.go();

                if ('finish' in n)
                    break;

                st = n.state;
            }

            return st;
        };
        const entry = (st: State, type: string): EntryCreate | undefined => st.creates?.find((c) => c.what === 'entry' && c.fields.some(([k, v]) => k === 'type' && v === type));

        try
        {
            const t = walk(true, [E, 'You (self)', 'Add…', 'Trait', '＋ New trait…', { input: 'my_bold' }, { input: 'Bold' }]);
            const ev = walk(true, ['Trigger an event…', '＋ New event…', 'test.0001', { input: 'A surprise' }, 'Right away']);

            if (resultText(t) !== 'add_trait = my_bold' || entry(t, 'traits')?.key !== 'my_bold' || entry(t, 'traits')?.loc !== 'Bold')
                (console.log(`MENUS new trait: ${resultText(t)} ${JSON.stringify(t.creates)}`), bad++);

            if (resultText(ev) !== 'trigger_event = test.0001' || entry(ev, 'events')?.loc !== 'A surprise')
                (console.log(`MENUS new event: ${resultText(ev)} ${JSON.stringify(ev.creates)}`), bad++);

            // (a new trait inside a statement Ctrl+⏎ then drops, half built: not made)
            const half = walk(true, [E, 'You (self)', 'Add…', 'Gold', { n: 100 }, 'And also…', E, 'You (self)', 'Add…', 'Trait experience', '＋ New trait…', { input: 'my_unused' }, { input: 'Unused' }]);

            if (resultText(half) !== 'add_gold = 100' || usedCreates(half) || usedCreates(t)?.[0]?.key !== 'my_bold')
                (console.log(`MENUS new entry of a dropped statement: ${resultText(half)} ${JSON.stringify(usedCreates(half))}`), bad++);
        }
        catch (e)
        {
            console.log(`MENUS new entries: ${(e as Error).message}`);
            bad++;
        }

        // key presses as the picker takes them (rows.ts: mnemonics, filter, the row selected): "＋ New …" is never the
        // row ⏎ chooses — the docs' key sequences work in the in-place editor (which makes new entries) as documented
        const press = (keys: string[]): string =>
        {
            let st = startStates('effect', 'character', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { newEntries: true })[0].state;
            let filter = '';
            let sel = firstSelectable(rowsOf(menuOf(st, d2), '', undefined));

            for (const k of keys)
            {
                const menu = menuOf(st, d2);
                const rows = rowsOf(menu, filter, undefined);
                let ri = -1;

                if (k === '⏎')
                    ri = sel;
                else if (!menu.typeahead && !filter && rows.some((r) => r.key === k))
                    ri = rows.findIndex((r) => r.key === k);
                else
                {
                    filter += k;
                    sel = firstSelectable(rowsOf(menu, filter, undefined), true);
                    continue;
                }

                const n = rows[ri]?.item.go?.();

                if (!n)
                    return `nothing chosen at “${menu.title}” (${k})`;

                if ('finish' in n)
                    return resultText(n.state ?? st) + (usedCreates(n.state ?? st) ? ' + new entries' : '');

                st = n.state;
                filter = '';
                sel = firstSelectable(rowsOf(menuOf(st, d2), '', undefined));
            }

            return resultText(st);
        };
        const typedKeys = (s: string): string[] => s.split(' ').flatMap((w) => (w === '⏎' || w.length === 1 ? [w] : [...w]));
        const docs = press(typedKeys('c s a o 3 0 ⏎ ⏎ ⏎ w s a u 1 8 ⏎ ⏎'));
        const newTrait = press(['c', 's', 'a', 't', '+', '⏎', ...'my_bold', '⏎', ...'Bold', '⏎', '⏎']);

        if (docs !== 'if = {\n\tlimit = { age < 18 }\n\tadd_opinion = { target = root modifier = respect_opinion opinion = 30 }\n}')
            (console.log(`MENUS the docs' key sequence with new entries offered: ${docs}`), bad++);

        if (newTrait !== 'add_trait = my_bold + new entries')
            (console.log(`MENUS “+ ⏎” for a new trait: ${newTrait}`), bad++);

        // (a caller that does not make them: no such row)
        const plain = walk(false, [E, 'You (self)', 'Add…', 'Trait']);

        if (menuOf(plain, d2).items.some((i) => i.label.startsWith('＋ New')))
            (console.log('MENUS new entries offered to a caller that does not make them'), bad++);
    }

    // (a county's modifiers: no character-only one in its groups)
    {
        const s = startStates('modifier', 'landed_title', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { modScope: 'landed_title' })[0].state;
        const shown = menuOf({ ...s, view: { v: 'modGroup', group: '' } }, data).items.map((i) => i.label);

        if (shown.includes('Diplomacy') || !shown.includes('Tax %'))
            (console.log(`MENUS county modifiers: ${shown.join(' | ')}`), bad++);
    }

    // (if / else: no part starts at an else; a written member of a chain is not wrapped, nothing goes after an if its else follows)
    {
        const labels = (req: Req, path: Step[]): string[] =>
        {
            let s = startStates(req.kind, scopeOf(req.scope), undefined, undefined, req.edit, undefined, undefined, undefined, undefined, { elseAfter: req.elseAfter }).at(-1)!.state;

            for (const p of path)
                s = (choose(s, p) as { state: State; }).state;

            return menuOf(s, data).items.map((i) => i.label);
        };
        const parts = labels({ kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Back out', 'And also…', E, 'You (self)', 'Add…', 'Piety', { n: 5 }, 'When…']);
        const ifHead = labels({ kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }', elseAfter: true }, []);
        const ifNext = labels({ kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }', elseAfter: true }, ['What next…']);
        const elseNext = labels({ kind: 'effect', edit: 'else = { add_gold = 5 }' }, ['What next…']);

        if (parts.some((l) => /else/.test(l)) || parts.length !== 2)
            (console.log(`MENUS if/else parts: ${parts.join(' | ')}`), bad++);

        if (ifHead.some((l) => l.startsWith('Always')) || ifNext.some((l) => ['When…', 'Chance…', 'Hidden (no tooltip)', 'And also…', 'Otherwise…', 'One of several outcomes…'].includes(l)) || !ifNext.includes('Otherwise, when…'))
            (console.log(`MENUS an if its else follows: ${ifHead.join(' | ')} // ${ifNext.join(' | ')}`), bad++);

        if (elseNext.some((l) => ['When…', 'Chance…', 'Hidden (no tooltip)', 'One of several outcomes…'].includes(l)) || !elseNext.includes('And also…'))
            (console.log(`MENUS an else: ${elseNext.join(' | ')}`), bad++);
    }

    // (comments are never lost: a statement with one opens the script editor; so does script the picker would print otherwise)
    {
        const cases: [string, 'effect' | 'trigger', boolean][] = [
            ['add_character_modifier = {\n\tmodifier = my_modifier # the reward\n\tyears = 5\n\tdesc = my_desc\n}', 'effect', false],
            ['NOT = {\n\t# only the brave\n\thas_trait = brave\n}', 'trigger', false],
            ['if = { limit = { always = yes } add_gold = @[x + 1] }', 'effect', false],
            ['if = { limit = { always = yes } color = hsv { 0.1 0.2 0.3 } }', 'effect', false],
            ['if = { limit = { always = yes } custom_tooltip = "50 # of them" }', 'effect', true],
            ['add_character_modifier = { modifier = my_modifier years = 5 desc = my_desc }', 'effect', true],
            ['NOT = { has_trait = brave }', 'trigger', true]
        ];

        // (another list: only lists of the same kind of items)
        let st = startStates('effect', 'character', undefined, undefined, 'every_child = { add_gold = 5 }').at(-1)!.state;
        st = (choose(st, 'Another list…') as { state: State; }).state;
        const lists = menuOf(st, data).items.map((i) => i.label);

        if (lists.some((l) => /title|county|secret|scheme|war|artifact/.test(l)) || !lists.includes('Every vassal'))
            (console.log(`MENUS another list: ${lists.join(' | ')}`), bad++);

        for (const [text, kind, want] of cases)
            if (canPickEdit(kind, text) !== want)
                (console.log(`MENUS canPickEdit ${JSON.stringify(text)}: ${!want}`), bad++);
    }

    console.log(`menus: ${bad ? bad + ' of ' + scenarios.length + ' scenarios wrong' : scenarios.length + ' scenarios ok'}`);
}
