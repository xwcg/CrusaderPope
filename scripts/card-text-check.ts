// Readable cards: text that must never leak into a card, and the cards that must read what 1.20 writes.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/card-text-check.ts
// Scans the cards of every entry of TYPES (or of the types named as arguments) for leaks ("NaN", "[object …]",
// "undefined", an unfilled `$ARG|0$` template argument) and checks a few cards
// whose 1.20 script the describer once read as empty or wrong (bare `parameters = { name }`, named `percent`, an
// opinion compared with a value block, nested loc calls, the casus belli trigger blocks). Exit code 1 on any failure.
// GAME=<install dir> (default: the development install).
// The index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew).
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { humanizeDataFunction, locToRich, rich, richToString } from '../src/main/describe/text.ts';
import { historyFaith, riteHistory } from '../src/main/indexer/layouts.ts';
import { BOOKMARK_DATE } from '../src/main/portraits/modifiers.ts';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { rootCtx } from '../src/main/describe/describer.ts';
import { createCharacterLine } from '../src/main/describe/cards/scripted-templates.ts';
import { modifierScopeOf } from '../src/shared/scriptCatalog.ts';
import type { EntityCard, Line, Rich } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const TYPES = ['decisions', 'casus_belli_types', 'character_interactions', 'religion/doctrine_types', 'religion/tenet_types', 'scripted_triggers', 'scripted_effects', 'script_values', 'great_projects', 'culture/traditions', 'story_cycles', 'effect_localization', 'characters', 'buildings', 'dynasty_perks', 'artifacts/features'];
const LEAKS: [RegExp, string][] = [
    [/\bNaN\b/, 'NaN'],
    [/\[object /i, '[object …]'],
    [/\bundefined\b/, 'undefined'],
    // (a loc template argument with a format, `$NUM|V0$`; `$name$` alone is also a script macro parameter, which cards show as written)
    [/\$[A-Za-z_]\w*\|[^$\s]*\$/, 'unfilled $ARG|fmt$'],
    // (a data function left as written: the description path resolves them)
    [/\[Get[A-Z]\w*\(/, 'raw [GetX(…)] data function'],
    // (loc helpers and data functions read as the words of their names)
    [/\bconcat if\b|\bchar (you|your|my|me|yours) \w+|\bget \w+ (she|her) (he|him|his)\b|\bname no tier\b|\badd localization if\b|\bcustom \w+ get\b/i, 'a loc function read as words'],
    // (values: file constants, formulas, defines and dates are worked out, never shown as a name or read as a scope chain)
    [/: @\w+$|(least|than) @\w+ |@\[|\bdefine:/, 'an unresolved @constant / @[formula] / define:'],
    [/’s \d+’s \d+|’s yes\b|Variable “”/, 'a date or yes read as a scope, an empty variable name'],
    [/ \b(tax|fort level|siege value|toughness|damage|advantage) tier \d\b/i, 'a building tier value left as its name'],
    [/\bthe in the list\b/, 'an iterator over a list read as "the in the list"'],
    // (House House: the game's own concept names, "Leading House" + "House Head")
    [/\b(Building|Law|Title|Culture|Gold|Faith|Regiment) \1\b/, 'a name followed by its own concept word'],
    [/ for −\d+ years|\b1–1 |\b1 (days|months|weeks)\b/, 'a duration: negative, degenerate range or "1 days"'],
    // (not an artifact feature's description: its custom loc functions are read as words, its own wart)
    [/^(?!Has artifact feature).*\b[Aa] (?!Uni|Use|Usu|Eu|One|Once|Ur)[AEIOU]\w+/, 'a before a vowel'],
    [/Gains −\d/, 'a negative amount with the plain "Gains" wording'],
    [/Trigger '' /, 'a catalyst effect without the catalyst']
];
// (the types with very many entries are read at every STEP-th entry)
const STEP: Record<string, number> = { characters: 40 };

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
{
    throw new Error('No CK3 game dir at ' + install);
}

const idx = await fastIndex(gameDir, { cache: true });
const sb = new StoryBuilder(idx);
// (every caller of a scripted effect / trigger read, not as many as a time budget allows: the cards do not depend on
// the machine's load, and the two builders compared below read the same callers)
sb.callerBudget = Infinity;
const text =(r: Rich): string => r.map((s) => (typeof s === 'string' ? s : s.text)).join('');
const flat = (ls: Line[]): string[] => ls.flatMap((l) => [text(l.text), ...flat(l.conditions ?? []), ...flat(l.children ?? [])]);
// (an "Otherwise:" or "If …::" with nothing under it, in the trigger sections; the weight readers of the script values and costs keep theirs)
const emptyHeads = (ls: Line[]): string[] => ls.flatMap((l) => [...(/^Otherwise:$|::$/.test(text(l.text)) && !l.children?.length && !l.conditions?.length && !l.src?.mod ? [text(l.text)] : []), ...emptyHeads(l.conditions ?? []), ...emptyHeads(l.children ?? [])]);
const cardLines = (c: EntityCard): string[] => [...c.facts.map(text), ...c.sections.flatMap((s) => flat(s.lines))];
let failed = 0;
const fail = (what: string): void =>
{
    failed++;
    console.log('FAIL ' + what);
};
const cardOf = (type: string, name: string): EntityCard | undefined =>
{
    const e = idx.get(type, name);
    return e ? sb.card(e) : undefined;
};

// 1. leaks, over every entry of the types
const only = process.argv.slice(2);
const seen = new Map<string, string[]>();

for (const type of only.length ? only : TYPES)
{
    for (const [i, name] of idx.names(type).entries())
    {
        if (STEP[type] && i % STEP[type])
            continue;

        let card: EntityCard;

        try
        {
            card = sb.card(idx.get(type, name)!);
        }
        catch (err)
        {
            fail(`${type}:${name} card failed: ${err}`);
            continue;
        }

        for (const line of cardLines(card))
            for (const [re, label] of LEAKS)
                if (re.test(line))
                {
                    const list = seen.get(label) ?? [];
                    list.push(`${type}:${name}: ${line.slice(0, 110)}`);
                    seen.set(label, list);
                }

        // (a heading with nothing under it: a scope that only saves scopes, an empty "Otherwise:")
        for (const line of card.sections.filter((x) => x.title === 'What it checks' || x.title === 'Conditions').flatMap((x) => emptyHeads(x.lines)))
        {
            const list = seen.get('a heading with no lines under it') ?? [];
            list.push(`${type}:${name}: ${line.slice(0, 110)}`);
            seen.set('a heading with no lines under it', list);
        }
    }
}

for (const [label, list] of seen)
{
    fail(`${label} in ${list.length} lines, e.g.`);

    for (const l of list.slice(0, 5))
        console.log('    ' + l);
}

// 2. the known cases
if (!only.length)
{
    const doctrine = cardOf('religion/doctrine_types', 'doctrine_polygamy');
    const does = doctrine?.sections.find((s) => s.title === 'What it does');

    if (!does || !does.lines.length)
        fail('doctrine_polygamy: "What it does" is empty (bare parameters not read)');

    // 1.20 numbers and hostility sit in `special_parameters`
    const concubines = cardOf('religion/doctrine_types', 'doctrine_concubines');

    if (!concubines || !cardLines(concubines).some((l) => /\b3\b/.test(l) && /concubine/i.test(l)))
        fail('doctrine_concubines: number_of_consorts (special_parameters) not shown');

    // (round 13 wave 11: special_parameters in a section of its own, "Special values"; its blocks as rows, entries under them)
    const hostile = cardOf('religion/doctrine_types', 'abrahamic_hostility_doctrine');
    const hostileRow = hostile?.sections.find((s) => s.title === 'Special values')?.lines.find((l) => l.tip === 'hostility_levels');

    if (hostileRow?.children?.length !== 3)
        fail('abrahamic_hostility_doctrine: "Special values" has no hostility_levels row with its three relations (special_parameters not read)');

    // every doctrine and tenet: "What it does" holds only `parameters`, "Special values" only `special_parameters`, each of
    // its lines (rows and entries) anchored with a field set (the picker changes it), none as plain script
    {
        const flat = (ls: Line[]): Line[] => ls.flatMap((l) => [l, ...flat(l.children ?? [])]);
        const counts = { cards: 0, special: 0, lines: 0, rows: 0, plusRows: 0, sets: new Map<string, number>(), inner: new Map<string, number>() };

        for (const type of ['religion/doctrine_types', 'religion/tenet_types'])
        {
            for (const name of idx.names(type))
            {
                const card = cardOf(type, name);

                if (!card)
                    continue;

                counts.cards++;
                const does = card.sections.find((s) => s.title === 'What it does');
                const special = card.sections.find((s) => s.title === 'Special values');

                for (const l of flat(does?.lines ?? []))
                    if (l.src && l.src.fields !== 'doctrine_parameters')
                        fail(`${name}: a line of "What it does" is not a parameter: ${l.tip} (${l.src.fields ?? l.src.kind})`);

                if (!special)
                    continue;

                counts.special++;

                if (special.src?.src?.fields !== 'special_parameters' || special.addLabel !== 'setting')
                    fail(`${name}: "Special values" does not add into special_parameters (${special.src?.src?.fields} ${special.addLabel})`);

                for (const l of flat(special.lines))
                {
                    counts.lines++;

                    if (l.children)
                    {
                        counts.rows++;

                        if (l.src?.inner)
                        {
                            counts.plusRows++;
                            counts.inner.set(l.src.innerFields ?? '-', (counts.inner.get(l.src.innerFields ?? '-') ?? 0) + 1);

                            // (the row is a setting of special_parameters, ＋ after it adds one; its ⤷＋ the block's set)
                            if (l.src.fields !== 'special_parameters' || !l.src.innerFields)
                                fail(`${name}: the block row ${l.tip} is not a setting of special_parameters with its block's set inside (${l.src.fields} ${l.src.innerFields})`);
                        }
                    }

                    if (!l.src || l.src.kind !== 'field' || !l.src.fields)
                        fail(`${name}: a line of "Special values" is not a field (${l.tip}: ${l.src?.kind ?? 'no anchor'})`);
                    else
                        counts.sets.set(l.src.fields, (counts.sets.get(l.src.fields) ?? 0) + 1);
                }
            }
        }

        console.log(`doctrines and tenets: ${counts.cards} cards, ${counts.special} with "Special values": ${counts.lines} lines (${counts.rows} block rows, ${counts.plusRows} with ⤷＋), by field set: ${[...counts.sets].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}; ⤷＋ by set: ${[...counts.inner].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    }

    // auto_accept = { trigger } reads as conditions, not key by key
    const ally = cardOf('character_interactions', 'call_ally_interaction');

    if (!ally)
        fail('call_ally_interaction: no card');
    else if (cardLines(ally).some((l) => /^Custom description:/.test(l) || /^Or:/.test(l)))
        fail('call_ally_interaction: auto_accept still dumped key by key');

    // a bookmark character's `religion = hanafi` (a 1.20 rite) links its faith, not the rite
    const rites = riteHistory(idx);

    if (!rites.faithOf('hanafi', BOOKMARK_DATE))
        fail('riteHistory: hanafi has no faith');

    let rawRites = 0;

    for (const name of idx.names('bookmarks/bookmarks'))
    {
        const bm = cardOf('bookmarks/bookmarks', name);
        const segs = bm ? [...bm.facts, ...bm.sections.flatMap((s) => s.lines.map((l) => l.text))].flat() : [];

        rawRites += segs.filter((x) => typeof x !== 'string' && x.ref?.type === 'religion/rite_types').length;
    }

    if (rawRites)
        fail('bookmark cards: ' + rawRites + ' links point at a rite instead of its faith');

    const histHanafi = historyFaith(idx, { k: 'religion', v: 'hanafi' } as PNode, BOOKMARK_DATE);

    if (!histHanafi || histHanafi === 'hanafi')
        fail('historyFaith: religion = hanafi is not turned into its faith');

    const tenet = cardOf('religion/tenet_types', 'tenet_carnal_exaltation');

    if (!tenet?.sections.find((s) => s.title === 'What it does')?.lines.length)
        fail('tenet_carnal_exaltation: "What it does" is empty');

    const witch = cardOf('decisions', 'found_witch_coven_decision');

    if (witch && !cardLines(witch).some((l) => /^At least \d+(\.\d+)?% of adult house members/.test(l)))
        fail('found_witch_coven_decision: the named percent is not worked out');

    const cb = cardOf('casus_belli_types', 'county_conquest_cb');

    for (const title of ['Attacker may use it when', 'To start the war', 'The war ends when'])
        if (!cb?.sections.find((s) => s.title === title)?.lines.length)
            fail(`county_conquest_cb: no section "${title}"`);

    if (cb?.sections.find((s) => s.title === 'Settings')?.lines.some((l) => /^(Allowed for character|Valid to start|Should invalidate)\b/.test(text(l.text))))
        fail('county_conquest_cb: trigger blocks still in Settings');

    // 1.20 modifier names: faith_character_modifier (traditions, perks) says which doctrine; the block keys have their scopes
    const equal = cardOf('culture/traditions', 'tradition_equal_inheritance');

    if (!equal?.sections.find((s) => s.title === 'With a doctrine')?.lines.some((l) => /^If their faith has /.test(text(l.text))))
        fail('tradition_equal_inheritance: faith_character_modifier lost its doctrine');

    const legacy = cardOf('dynasty_perks', 'erudition_legacy_4');

    if (!legacy || !cardLines(legacy).some((l) => /^If their faith has /.test(l)))
        fail('erudition_legacy_4: missing, or faith_character_modifier lost its doctrine');

    const scopes: [string, string | undefined][] = [
        ['rite_modifier', 'character'], ['personal_tenet_modifier', 'character'], ['clergy_modifier', 'character'], ['faith_character_modifier', 'character'],
        ['county_holder_character_modifier', 'character'], ['county_rite_modifier', 'landed_title'], ['duchy_capital_county_rite_modifier', 'landed_title'],
        ['province_rite_modifier', 'province'], ['county_holding_modifier', 'landed_title'], ['opinion_modifier', undefined]
    ];

    for (const [key, scope] of scopes)
        if (modifierScopeOf(key) !== scope)
            fail(`modifierScopeOf(${key}) is ${modifierScopeOf(key)}, expected ${scope}`);

    // the game's own words: a family's religions, a pronoun helper, the building a replace_building_effect replaces
    const family = humanizeDataFunction("GetReligionFamily('rf_abrahamic').GetReligions", (k) => (k === 'rf_abrahamic' ? 'Abrahamic' : undefined));

    if (!/Abrahamic/.test(family) || /Get/.test(family))
        fail('GetReligions not resolved: ' + family);

    if (humanizeDataFunction('CharYourHerHis( TARGET_CHARACTER )', () => undefined) !== 'their')
        fail('CharYourHerHis is not "their"');

    // the loc helpers and data functions of the game's text (survey of 1.20.1.2 english: every Char… helper, Custom pronouns, NoTier)
    const words = (expr: string, k?: Record<string, string>): string => humanizeDataFunction(expr, (key) => k?.[key]);
    const cases: [string, string][] = [
        ["ConcatIfNeitherEmpty('$ORDER|q$', ' ')", ''],
        ["AddLocalizationIf( Not( StringIsEmpty( X.Get ) ), 'KEY' )", ''],
        ['CharYouSheHe(ROOT.Char)', 'they'],
        ['CharYouThey(CHARACTER)', 'they'],
        ['CharYouHerHim(CHARACTER)', 'them'],
        ['CharYourHerHimself( CHARACTER )', 'themselves'],
        ['CharYoursHerHis(CHARACTER)', 'theirs'],
        ['CharMyFirstNames(child)', 'their'],
        ['CharMyHerHis(x)', 'their'],
        ['CharDontDoesnt(x)', "doesn't"],
        ['CharAreIs(x)', 'is'],
        ['CharWereWas(x)', 'was'],
        ["ROOT.Char.Custom('GetDragonSheHe')", 'they'],
        ["x.Custom('GetDragonHerHim')", 'them'],
        ["x.Custom('CatStoryHerHisAll')", 'their'],
        ["TARGET_CHARACTER.Custom('AGOTCustomGetShortUINameOrMe')", 'Target Character'],
        ["SCOPE.sC('liege').Custom2('RelationToMeShort', ROOT.Char)", 'Liege’s relation to me short'],
        ["SCOPE.sC('hunter').Custom('DogStoryName')", 'Hunter'],
        ["Artifact.GetOwner.Custom('PredeterminedSaintName')", 'Owner'],
        ["SCOPE.sC('liege').GetFirstName", 'Liege'],
        ["x.Custom('GetOtherHer')", 'them'],
        ["Target.GetTitle.GetNameNoTier", 'Target’s title'],
        ['SiegingLocation.GetTitle.GetNameNoTierNoTooltip', 'Sieging Location’s title'],
        ['CHARACTER.GetPrimaryTitle.GetBaseNameNoTier', 'Character’s primary title']
    ];

    for (const [expr, want] of cases)
        if (words(expr) !== want)
            fail(`${expr} reads "${words(expr)}", expected "${want}"`);

    const trait = words("GetTrait('ill').GetName( CHARACTER.Self )", { ill: 'Ill' });

    if (trait !== 'Ill')
        fail('death reason trait name: ' + trait);

    // template arguments: the colon and the space before a [bracket] stay, a trailing label argument loses its colon
    const argText = (t: string): string => richToString(locToRich(t, () => undefined));

    for (const [t, want] of [['Cost: $COST|0$ [gold|E]', 'Cost: … gold'], ['[levies|E]: $VALUE|0V$ [soldiers|E]', 'levies: … soldiers'], ['Number: $NUM|V0$', 'Number']])
        if (argText(t) !== want)
            fail(`template argument in "${t}" reads "${argText(t)}", expected "${want}"`);

    // wording: a repeat is dropped only for a name or concept word, a/an by sound, a number keeps the article
    for (const [parts, want] of [
        [[{ text: 'Hit' }, ' hit points'], 'Hit hit points'],
        [[{ text: 'Major Gold' }, ' Gold to'], 'Major Gold to'],
        [['Gains a ', { text: 'Utopia' }], 'Gains a Utopia'],
        [['Gains a ', { text: 'Ukrainian' }], 'Gains a Ukrainian'],
        [['Gains a ', { text: '3 Archers' }], 'Gains a 3 Archers'],
        [['Gains a ', { text: 'Indebted' }], 'Gains an Indebted']
    ] as [Parameters<typeof rich>, string][])
        if (richToString(rich(...parts)) !== want)
            fail(`rich(${JSON.stringify(parts)}) reads "${richToString(rich(...parts))}", expected "${want}"`);

    const barracks =cardOf('great_projects/types', 'construct_great_barracks');

    if (!barracks || !cardLines(barracks).some((l) => /replaces the existing building with Great Barracks$/.test(l)))
        fail('construct_great_barracks: missing, or replace_building_effect does not name the building');

    // government flags: government_has_influence reads "has", not "is has"
    const claim = cardOf('casus_belli_types', 'claim_cb');

    if (!claim)
        fail('claim_cb: missing');

    if (claim && cardLines(claim).some((l) => /[Gg]overnment is (has|uses|can|enables)\b/.test(l)))
        fail('claim_cb: a government_has_… flag reads "Government is has …"');

    // values: a doctrine named with its descriptive name, script values / constants / formulas worked out, a negative literal with the _neg text
    const perk = cardOf('dynasty_perks', 'erudition_legacy_4');

    if (!perk || cardLines(perk).some((l) => /faith has (None|Spiritual|Temporal):/.test(l)) || !cardLines(perk).some((l) => /faith has No Head of Faith/.test(l)))
        fail('erudition_legacy_4: a doctrine of faith_character_modifier is not named by its descriptive name');

    const bureau = cardOf('buildings', 'capital_bureau_01');

    if (!bureau || !cardLines(bureau).some((l) => /^Construction time \(days\): 1095$/.test(l)))
        fail('capital_bureau_01: construction_time = standard_construction_time (@const in the script value file) is not worked out');

    const claimCb = cardOf('casus_belli_types', 'claim_cb');

    if (!claimCb || !cardLines(claimCb).some((l) => /^Max: 1,?000$/.test(l)))
        fail('claim_cb: max = @maximum_prestige_loser_ally (a constant of an inlined scripted effect\'s file) is not worked out');

    const civil = cardOf('casus_belli_types', 'debug_war');

    if (!civil || cardLines(civil).some((l) => /^Gains −1\b/.test(l)) || !cardLines(civil).some((l) => /^Loses 1 Levels? of Fame/.test(l)))
        fail('debug_war: add_prestige_level = -1 does not read with the _neg text');

    const canals = cardOf('great_projects/types', 'grand_canals');

    if (!canals || cardLines(canals).some((l) => /^Left icon: (root|scope:)/.test(l)))
        fail('grand_canals: left_icon = root is shown as a picture path, not a scope');

    const nested = humanizeDataFunction("GetCurrentDateWithDiff( GetVarTimeRemaining( recipient.MakeScope, 'cannot_be_converted_by_value') )", () => undefined);

    if (/[()]/.test(nested))
        fail('nested call arguments left parentheses: ' + nested);

    // the timeline: who fires an event, and the on_action lists (_on_actions.info)
    const oa = (name: string) => { const e = idx.get('on_action', name); return e ? sb.onActionStory(e) : undefined; };
    const ev = (name: string) => { const e = idx.get('events', name); return e ? sb.eventStory(e) : undefined; };

    // an event named as an argument in the body of a scripted effect (OUTPUT_EVENT = …) has that effect as its origin
    // (1.20.1.2: seduce_scheme_prep_effect passes OUTPUT_EVENT = scheme_critical_moments.1011 on; the effects that take $OUTPUT_EVENT$
    // never name an event themselves, and no scripted effect names hold_court.6101: only the event hold_court.6100 does)
    const argFired = ev('scheme_critical_moments.1011');

    if (!argFired?.origins.length)
        fail('scheme_critical_moments.1011: no origins (fired through OUTPUT_EVENT in seduce_scheme_prep_effect)');

    // (a title or a text that holds an event's name is no origin: only the effect-argument keys count in a scripted effect)
    const argSrc = argFired?.origins.find((o) => o.ref.type === 'scripted_effects' && o.ref.name === 'seduce_scheme_prep_effect');

    if (argFired && !argSrc)
        fail('scheme_critical_moments.1011: the scripted effect that names it as OUTPUT_EVENT is no origin');

    // an event named as an argument of an effect call in an event (OUTPUT_EVENT = hold_court.6101) has that event as its origin
    const argCaller = ev('hold_court.6101');

    if (!argCaller?.origins.some((o) => o.ref.type === 'events' && o.ref.name === 'hold_court.6100'))
        fail('hold_court.6101: hold_court.6100 (OUTPUT_EVENT argument) is no origin');

    // and the caller leads to it
    const caller = ev('hold_court.6100');

    if (!caller)
        fail('hold_court.6100: missing');

    if (caller && !caller.options.some((o) => o.followUps.some((f) => f.target.name === 'hold_court.6101')))
        fail('hold_court.6100: no follow-up to hold_court.6101 (OUTPUT_EVENT argument)');

    // fallback = on_action (the scalar form)
    const rare = oa('diplomacy_lifestyle_rare_events');

    // (the pool "If nothing else fires", not "Also triggers", since round 13 wave 6)
    if (!rare?.fallbacks.some((f) => /_uncommon_events$/.test(f.target.name)) || rare.onActions.length)
        fail('diplomacy_lifestyle_rare_events: fallback = … not in the fallbacks pool');

    // chance_to_happen and the chance of no event are both kept: rows of the random list (also in the read-only view, a
    // game definition's rows unanchored), not in the note (since round 13 wave 9)
    const pool = oa('three_year_pool_pulse');
    const poolRows = (pool?.lists?.random_events?.lines ?? []).map((l) => l.text.map((p) => (typeof p === 'string' ? p : p.text)).join(''));

    if (!poolRows.some((t) => /Only happens/.test(t)) || !poolRows.some((t) => /nothing/i.test(t)) || (pool?.notes ?? []).some((t) => /Only happens/.test(t)))
        fail('three_year_pool_pulse: chance_to_happen or chance_of_no_event not rows of random_events: ' + JSON.stringify({ rows: poolRows, notes: pool?.notes }));

    console.log(`three_year_pool_pulse: random_events rows [${poolRows.join(' | ')}], notes [${(pool?.notes ?? []).join(' | ')}]`);

    // a delay inside on_actions = { }: the one at the list's start is its row, the later ones the chips of the entries
    // after them (the first entry has none)
    const health = oa('yearly_health_pulse');
    const healthRows = (health?.lists?.on_actions?.lines ?? []).map((l) => l.text.map((p) => (typeof p === 'string' ? p : p.text)).join(''));

    if (!health?.onActions.length || health.onActions[0].delay || !health.onActions.slice(1).every((f) => f.delay) || healthRows.length !== 1 || !/^Delay/.test(healthRows[0]))
        fail('yearly_health_pulse: start delay not a row, or later delays not chips: ' + JSON.stringify({ rows: healthRows, chips: health?.onActions.map((f) => f.delay ?? '-') }));

    console.log(`yearly_health_pulse: on_actions rows [${healthRows.join(' | ')}], chips [${health?.onActions.map((f) => f.delay ?? '-').join(' | ')}]`);

    // an artifact's name and description (set_artifact_name / _description, 00_artifact_badge_scripted_effects.txt:180):
    // hidden lines carrying their text keys (since round 13 wave 9; before, no line)
    const lineTree = (ls: Line[]): Line[] => ls.flatMap((l) => [l, ...lineTree(l.conditions ?? []), ...lineTree(l.children ?? [])]);
    const badge = cardOf('scripted_effects', 'create_artifact_badge_generic_effect');
    const badgeLines = badge ? badge.sections.flatMap((s) => lineTree(s.lines)) : [];
    const named = badgeLines.find((l) => l.locKey === 'generic_badge_name_1');
    const described = badgeLines.find((l) => l.locKey === 'generic_badge_protection_desc');

    if (!named?.hidden || !/^Names the artifact “/.test(text(named.text)) || !described?.hidden || !/^Describes the artifact: “/.test(text(described.text)))
        fail('create_artifact_badge_generic_effect: set_artifact_name / _description lines with their keys missing: ' + JSON.stringify({ named: named && text(named.text), described: described && text(described.text) }));

    console.log(`create_artifact_badge_generic_effect: ${named && text(named.text)} | ${described && text(described.text)}`);
    // create_artifact's own name / description (since 2026-11-15): the line names the artifact, the two keys are lines
    // of their own carrying their keys ("✎ text" in a mod's entry), the other fields stay lines
    const santiago = cardOf('scripted_effects', 'create_artifact_badge_santiago_effect');
    const santiagoLines = santiago ? santiago.sections.flatMap((s) => lineTree(s.lines)) : [];
    const created = santiagoLines.find((l) => /^Creates an artifact “/.test(text(l.text)));
    const createdName = created?.children?.find((l) => l.locKey === 'santiago_badge_name');
    const createdDesc = created?.children?.find((l) => l.locKey === 'santiago_badge_description');

    if (!created || !createdName || !/^Name: “/.test(text(createdName.text)) || !createdDesc || !/^Description: “/.test(text(createdDesc.text)) || !created.children?.some((l) => /^Template: /.test(text(l.text))))
        fail('create_artifact_badge_santiago_effect: create_artifact\'s name / description lines with their keys missing: ' + JSON.stringify({ created: created && text(created.text), kids: created?.children?.map((l) => text(l.text)) }));

    console.log(`create_artifact_badge_santiago_effect: ${created && text(created.text)} | ${createdName && text(createdName.text)} | ${createdDesc && text(createdDesc.text).slice(0, 60)}`);

    // a $PARAM_%$ macro name (SUCCESS_% = 90): the random_list is read, its outcomes lead on
    const duel = ev('ep3_laamp_flavour_ewan.4062');

    if (!duel)
        fail('ep3_laamp_flavour_ewan.4062: missing (the case needs another event with a $PARAM_%$ random_list if the id changed)');

    if (duel && !duel.options.some((o) => o.followUps.some((f) => /^health\./.test(f.target.name))))
        fail('ep3_laamp_flavour_ewan.4062: random_list under $SUCCESS_%$ gives no follow-ups');

    // create_character: an event fired inside after_creation is a follow-up of the caller (no vanilla event does it: a snippet)
    const made = parse('create_character = { template = x save_scope_as = y after_creation = { trigger_event = hold_court.6101 } }')[0];
    const madeCtx = rootCtx('');
    createCharacterLine(sb, made, madeCtx);

    if (!madeCtx.followUps.some((f) => f.target.name === 'hold_court.6101'))
        fail('create_character: an event fired in after_creation is no follow-up');

    // the size of cards: a scripted effect read once stands for its calls (same words as reading every call again), and
    // a list of effects past the budget names what it leaves out
    const sbEach = new StoryBuilder(idx);
    sbEach.callerBudget = Infinity;
    sbEach.d.shareExpansions = false;
    sbEach.d.lineBudget = Infinity;
    sb.d.lineBudget = Infinity;
    // (each follow-up once: a shared expansion lists the same ones, and the view merges equal ones anyway)
    const norm = (x: unknown): string => JSON.stringify(x, (k, v) => (/ollowUps$/.test(k) && Array.isArray(v) ? [...new Set(v.map((f) => JSON.stringify(f)))] : v));
    const sameBoth = (what: string, make: (b: StoryBuilder) => unknown): void =>
    {
        if (norm(make(sb)) !== norm(make(sbEach)))
            fail(`${what}: a shared scripted effect reads other than the call read again`);
    };

    for (const [type, name] of [['decisions', 'convert_to_feudalism_liege_converted_decision'], ['decisions', 'settle_people_decision'], ['scripted_effects', 'chance_for_knight_appearance_effect'], ['scripted_effects', 'ep3_laamp_flavour_ewan_4062_animal_duel_loss_effect'], ['character_interactions', 'release_from_prison_interaction']])
        sameBoth(`${type}:${name}`, (b) => b.card(idx.get(type, name)!));

    for (const name of ['on_rite_change', 'on_birth_mother', 'yearly_global_pulse'])
        sameBoth('on_action ' + name, (b) => b.onActionStory(idx.get('on_action', name)!));

    for (const name of ['ep3_laamp_flavour_ewan.4062', 'hold_court.6100', 'yearly.0002'])
        sameBoth('event ' + name, (b) => b.eventStory(idx.get('events', name)!));

    sb.d.lineBudget = 5000;

    // an ordinary card reads whole under the budget
    if (norm(sb.eventStory(idx.get('events', 'yearly.0002')!)) !== norm(sbEach.eventStory(idx.get('events', 'yearly.0002')!)))
        fail('yearly.0002: the line budget changed an ordinary event');

    // the explosive ones: bounded, and every cut group names its effect (a link) with its size
    const big = ev('mpo_greatest_of_khans.0030');
    const bigLines = (ls: Line[]): number => ls.reduce((n, l) => n + 1 + bigLines(l.children ?? []) + bigLines(l.conditions ?? []), 0);
    const worst = Math.max(0, ...(big?.options ?? []).map((o) => bigLines(o.effects)));

    if (!big || worst > 5000 + 2000)
        fail('mpo_greatest_of_khans.0030: an option lists ' + worst + ' lines (the budget is 5000, the script\'s own lines come on top)');

    const notes: Line[] = [];
    const findNotes = (ls: Line[]): void =>
    {
        for (const l of ls)
        {
            if (l.icon === 'note' && /more lines, not listed here/.test(text(l.text)))
                notes.push(l);

            findNotes(l.children ?? []);
        }
    };

    for (const o of big?.options ?? [])
        findNotes(o.effects);

    if (!notes.length || notes.some((n) => !n.text.some((s) => typeof s !== 'string' && s.kind === 'entity' && s.ref?.type === 'scripted_effects')))
        fail('mpo_greatest_of_khans.0030: the groups left out are not named with a link to their effect (' + notes.length + ' notes)');

    // the same scripted effect called in two scopes: its follow-ups say whom they are for, so each scope reads it again
    const twoScopes = (b: StoryBuilder): string[] =>
    {
        const c = rootCtx('');
        b.d.effects(parse('random_vassal = { assign_random_nickname_effect = yes } random_courtier = { assign_random_nickname_effect = yes }'), c);
        return [...new Set(c.followUps.map((f) => f.who ?? ''))].sort();
    };
    const whos = twoScopes(sb);

    if (whos.length < 2 || whos.join('|') !== twoScopes(sbEach).join('|'))
        fail('a scripted effect called in two scopes: the follow-ups are for ' + whos.join(', ') + ' (read again: ' + twoScopes(sbEach).join(', ') + ')');

    // a list holds equal follow-ups once (this event's immediate effect gave 5040, the same 49 paths over and over)
    const nick = ev('ep3_laamp_flavour_ewan.3001');
    const nickKeys = new Set((nick?.immediateFollowUps ?? []).map((f) => JSON.stringify(f)));

    if (!nick || nick.immediateFollowUps.length !== nickKeys.size || nickKeys.size > 400)
        fail('ep3_laamp_flavour_ewan.3001: ' + nick?.immediateFollowUps.length + ' follow-ups listed, ' + nickKeys.size + ' of them different');

    // the events a cut group led to stay in the option's follow-ups
    sb.d.lineBudget = Infinity;
    const whole = sb.eventStory(idx.get('events', 'mpo_greatest_of_khans.0030')!);
    sb.d.lineBudget = 5000;
    const key = (f: { target: { type: string; name: string; }; who?: string; }): string => f.target.type + ':' + f.target.name + ':' + (f.who ?? '');

    if (big && whole && norm(big.options.map((o) => [...new Set(o.followUps.map(key))])) !== norm(whole.options.map((o) => [...new Set(o.followUps.map(key))])))
        fail('mpo_greatest_of_khans.0030: the line budget lost follow-ups of the groups it cut');

    // an effect read for a deep call and again for a shallow one (or the other way round) reads as it does alone: its
    // scripted modifiers in weight blocks (a random_list's modifier) expand by the depth left, and the shared reading knows
    const readAt = (b: StoryBuilder, name: string, expand: number): string => JSON.stringify(b.d.effects(parse(`${name} = yes`), { ...rootCtx(''), expand }));

    for (const name of ['tournament_contest_winner_captain_effect', 'hunt_save_hostile_accomplice_effect', 'tournament_save_contest_winner_scopes_effect'])
    {
        if (!idx.get('scripted_effects', name))
        {
            fail(`${name}: missing (the depth case needs it)`);
            continue;
        }

        for (const [first, second] of [[1, 4], [4, 1], [2, 4], [4, 2]])
        {
            const one = new StoryBuilder(idx);
            readAt(one, name, first);

            if (readAt(one, name, second) !== readAt(new StoryBuilder(idx), name, second))
                fail(`${name}: read at depth ${second} after depth ${first} reads other than on its own`);
        }
    }

    // scripted effects and triggers made up for the cases below (the first names of the game's lists, their text replaced)
    const withDefs = (bodies: Record<string, string>, run: () => void): void =>
    {
        const orig = idx.defNode.bind(idx);
        (idx as any).defNode = (ent: { name: string; }, args: Record<string, string> | undefined) => (bodies[ent.name] ? { node: parse(bodies[ent.name])[0], src: bodies[ent.name] } : orig(ent as never, args));

        try
        {
            run();
        }
        finally
        {
            (idx as any).defNode = orig;
        }
    };
    const effectNames = idx.names('scripted_effects');
    const triggerNames = idx.names('scripted_triggers');

    // create_character inside a scripted effect: its after_creation event is a follow-up of every card that calls the effect,
    // not only of the first one read (the later ones are served from the kept reading)
    withDefs({ [effectNames[0]]: `${effectNames[0]} = { create_character = { template = x save_scope_as = y after_creation = { trigger_event = hold_court.6101 } } }` }, () =>
    {
        const b = new StoryBuilder(idx);
        const lists = [rootCtx(''), rootCtx('')];

        for (const c of lists)
            b.d.effects(parse(`${effectNames[0]} = yes`), c);

        if (lists.some((c) => !c.followUps.some((f) => f.target.name === 'hold_court.6101')))
            fail('create_character in a scripted effect: ' + lists.map((c) => c.followUps.length).join(' and ') + ' follow-ups in the lists of two calls');
    });

    // conditions that read the same but name other entities (two game rule options, both "Always Administrative"): the
    // follow-ups of a shared effect keep the conditions of their own call
    withDefs({ [effectNames[0]]: `${effectNames[0]} = { trigger_event = hold_court.6101 }` }, () =>
    {
        for (const share of [true, false])
        {
            const b = new StoryBuilder(idx);
            b.d.shareExpansions = share;
            const c = rootCtx('');
            const options = ['historicity_extra_admin_ghana_historic_always', 'historicity_extra_admin_egypt_historic_always'];
            b.d.effects(parse(options.map((o) => `if = { limit = { has_game_rule = ${o} } ${effectNames[0]} = yes }`).join(' ')), c);
            // (the options' links: the condition names its rule too, "Game rule ‹X› is ‹option›")
            const refs = c.followUps.map((f) => f.when.flatMap((r) => r.flatMap((s) => (typeof s !== 'string' && s.ref?.type === 'game_rule_options' ? [s.ref.name] : []))).join());

            if (refs.length !== 2 || refs[0] !== options[0] || refs[1] !== options[1])
                fail(`a scripted effect called under two game rule options (sharing ${share ? 'on' : 'off'}): the follow-ups' conditions link to ${refs.join(' and ')}`);
        }
    });

    // past the budget a small collapsed group stays whole (its note would cost as much), a big one becomes a note that
    // names what it is read in: an effect or a trigger
    withDefs(
        {
            [effectNames[0]]: `${effectNames[0]} = { ${'add_gold = 1 '.repeat(60)} }`,
            [triggerNames[0]]: `${triggerNames[0]} = { has_trait = brave has_trait = brave has_trait = brave }`,
            [triggerNames[1]]: `${triggerNames[1]} = { ${'has_trait = craven '.repeat(40)} }`
        },
        () =>
        {
            const b = new StoryBuilder(idx);
            b.d.lineBudget = 6;
            const lines = b.d.effects(parse(`${effectNames[0]} = yes if = { limit = { ${triggerNames[0]} = yes ${triggerNames[1]} = yes } add_gold = 1 }`), rootCtx(''));
            const all: Line[] = [];
            const collect = (ls: Line[]): void =>
            {
                for (const l of ls)
                {
                    all.push(l);
                    collect(l.conditions ?? []);
                    collect(l.children ?? []);
                }
            };
            collect(lines);
            const notes = all.filter((l) => l.icon === 'note' && /more lines, not listed here/.test(text(l.text)));
            const small = all.find((l) => l.group?.name === triggerNames[0]);
            const bigTrigger = all.find((l) => l.group?.name === triggerNames[1]);

            if (!small || small.children?.length !== 3 || !small.children.every((c) => !notes.includes(c)))
                fail('a small scripted trigger group past the budget was cut to a note');

            if (!bigTrigger || !/read them in the trigger itself/.test(text(bigTrigger.children?.[0]?.text ?? [])))
                fail('a big scripted trigger group past the budget: ' + text(bigTrigger?.children?.[0]?.text ?? []));

            if (!notes.some((n) => /read them in the effect itself/.test(text(n.text))))
                fail('a big scripted effect group past the budget has no note naming the effect');

            // ("Show them here": the note keeps the lines it stands for, given back cut by the same budget)
            const big = bigTrigger?.children?.[0];
            const back = big?.more !== undefined ? b.d.moreLines(big.more) : null;

            if (!back?.length || back.length > 40 || !back.some((l) => /Craven/.test(text(l.text))))
                fail(`a cut group's note gives back ${back ? back.length + ' lines' : 'nothing'} (its trigger has 40)`);
        }
    );

    // values the script names never read "?": a statement's keys in capitals (the game reads them in any case), a
    // scheme's target kind passed as a parameter, a range given one script value at both ends, an amount passed in
    {
        const said = (src: string): string => flat(sb.d.effects(parse(src), rootCtx(''))).join(' | ');
        const cases: [string, RegExp][] = [
            ['set_relation_friend = { REASON = friend_joined_game TARGET = scope:other_child }', /^Gets Other Child as a Friend$/],
            ['pay_short_term_gold = { GOLD = 100 TARGET = scope:local_ruler }', /^Pays 100 Gold to Local Ruler$/],
            ['add_trait_xp = { trait = gallowsbait track = bandit VALUE = -25 }', /^−25 experience in Gallowsbait \(bandit\)$/],
            ['start_scheme = { type = $SCHEME_TYPE$ $TARGET_TYPE$ = $TARGET_SCOPE$ }', /scheme against the target scope$/],
            ['add_trait_xp = { trait = gallowsbait value = { integer_range = { min = gallowsbait_xp_medium_gain max = gallowsbait_xp_medium_gain } } }', /^[^–]+ experience in Gallowsbait$/],
            ['add_trait_xp = { trait = gallowsbait VALUE = $VALUE$ }', /^“Value” experience in Gallowsbait$/],
            ['add_trait_xp = { trait = gallowsbait value = { value = 5 if = { limit = { is_adult = yes } add = 5 } } }', /^A calculated amount of experience in Gallowsbait$/]
        ];

        for (const [src, want] of cases)
        {
            const got = said(src);

            if (!want.test(got))
                fail(`\`${src}\` reads "${got}", expected ${want}`);
        }

        // (vanilla's: a range end worked out of a scope; a list check that names no target)
        const ends: [string, string, string][] = [
            ['scripted_effects', 'ep3_laamp_flavour_ewan_9521_apply_ethos_skill_bonuses_effect', 'Random whole number between Skill 2 + 1 and 6'],
            ['script_values', 'spread_chance_epidemics_default_value', 'If (no target written) is in list “epidemic cooldown”:']
        ];

        for (const [type, name, want] of ends)
        {
            const c = cardOf(type, name);

            if (!c)
                fail(`${type}:${name}: missing (a "?" case needs it)`);
            else if (!cardLines(c).includes(want))
                fail(`${type}:${name}: no line "${want}"`);
        }
    }

    // no card fails to build, and the biggest are quick (they took 14 s and a 110 MB structure)
    for (const [type, name] of [['decisions', 'convert_to_administrative_decision'], ['decisions', 'recruit_from_nomadic_capital_decision'], ['on_action', 'on_game_start_after_lobby']])
    {
        const t0 = Date.now();
        const e = idx.get(type, name);

        try
        {
            const n = e ? (type === 'on_action' ? bigLines(sb.onActionStory(e).effects) : cardLines(sb.card(e)).length) : -1;

            if (n < 0)
                fail(`${type}:${name}: missing`);
            else if (n > 40000)
                fail(`${type}:${name}: ${n} lines in the card`);
        }
        catch (err)
        {
            fail(`${type}:${name}: ${err}`);
        }

        if (Date.now() - t0 > 4000)
            fail(`${type}:${name}: took ${Date.now() - t0} ms`);
    }
}

// 3. the written keys a per-type card does not read (StoryBuilder.unknownSettings, round 13 lane H1): over every builder
// type (at most UNKNOWN_MAX entries each, spread), the card with them equals the card without them but for field lines of
// the type's set added at the end of a section (or a new Settings section of only such lines); the added keys are listed
if (!only.length || process.env.UNKNOWN)
{
    const { TYPE_CARDS } = await import('../src/main/describe/cards/index.ts');
    const MAX = Number(process.env.UNKNOWN_MAX ?? 400);
    const added = new Map<string, Map<string, number>>();
    let cards = 0;
    let t0 = 0;
    let t1 = 0;
    const plain = (ls: Line[]): string => JSON.stringify(ls);

    for (const type of process.env.UNKNOWN ? process.env.UNKNOWN.split(',') : Object.keys(TYPE_CARDS))
    {
        const names = idx.names(type);
        const step = Math.max(1, Math.ceil(names.length / MAX));

        for (let i = 0; i < names.length; i += step)
        {
            const e = idx.get(type, names[i]);

            if (!e)
                continue;

            cards++;
            // (built both ways, the order alternating per card: the second build runs on warm caches, so the totals are
            // no measure of the pass's cost when one way always comes first)
            const build = (pass: boolean): [EntityCard, number] =>
            {
                sb.unknownKeys = pass;
                const t = performance.now();
                const c = sb.card(e);
                sb.unknownKeys = true;
                return [c, performance.now() - t];
            };
            const first = cards % 2 === 0;
            const [a, ta] = build(first);
            const [b, tb] = build(!first);
            const [card, without] = first ? [a, b] : [b, a];
            t0 += first ? tb : ta;
            t1 += first ? ta : tb;
            const extra: Line[] = [];
            let ok = card.sections.length >= without.sections.length && JSON.stringify({ ...card, sections: [] }) === JSON.stringify({ ...without, sections: [] });

            for (const [j, s] of card.sections.entries())
            {
                const w = without.sections[j];
                const more = w ? s.lines.slice(w.lines.length) : s.lines;

                if (w && (plain(s.lines.slice(0, w.lines.length)) !== plain(w.lines) || JSON.stringify({ ...s, lines: [] }) !== JSON.stringify({ ...w, lines: [] })))
                    ok = false;

                // (a new section is a Settings section, and only when the card has none: not a second one)
                if (!w && (s.title !== 'Settings' || without.sections.some((x) => x.title === s.title)))
                    ok = false;

                if (more.some((l) => l.src?.kind !== 'field' || l.src.fields !== type))
                    ok = false;

                extra.push(...more);
            }

            if (!ok)
                fail(`${type}:${names[i]}: the card with the unknown keys' lines differs beyond them`);

            const keys = added.get(type) ?? added.set(type, new Map()).get(type)!;

            for (const l of extra)
            {
                const k = /^([\w.@-]+)/.exec(l.tip ?? '')?.[1] ?? '?';
                keys.set(k, (keys.get(k) ?? 0) + 1);
            }
        }
    }

    for (const [type, keys] of added)
        if (keys.size)
            console.log(`unknown keys ${type}: ${[...keys].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ')}`);

    console.log(`unknown keys: ${cards} cards of ${added.size} builder types; built in ${Math.round(t0)} ms without the pass, ${Math.round(t1)} ms with it (each card both ways, the order alternating)`);
}

console.log(failed ? `${failed} failure(s)` : 'card-text-check: ok');
process.exit(failed ? 1 : 0);
