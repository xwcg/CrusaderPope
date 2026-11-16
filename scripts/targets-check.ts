// Checks where a saved scope is in reach (docs/picker.md, "Scopes in reach"): the main side's saveSites / reachOf
// (src/main/describe/stories.ts) on parsed snippets, then the renderer's inReach / awayAt / placeOf
// (src/renderer/src/picker/targets.ts) at places marked in the text (`# @name`). Light: no game files are read.
// Usage: node --experimental-strip-types --no-warnings scripts/targets-check.ts
import { parse } from '../src/main/indexer/parser.ts';
import { rootCtx, scopeTypeByUse } from '../src/main/describe/describer.ts';
import { fillParams, reachOf, saveSites, type SaveKind, type SavedName } from '../src/main/describe/stories.ts';
import { awayAt, inReach, inSpan, placeOf, prevOf, scopeGuessOf, setViewTargets, typedScopeWarning, viewTargetsKnown } from '../src/renderer/src/picker/targets.ts';
import type { LineSource, PickPlace, PickTarget } from '../src/shared/api.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const FILE = 'D:/test/events/reach_test.txt';

/**
 * A snippet's first definition as targets: each saved name with its reach, as the builder makes them (`kind`: its
 * scopes, values or lists; `calls`: the lists called scripted effects add).
 */
function targetsOf(text: string, type: string, kind: SaveKind = 'scope', calls?: Map<string, SavedName[]>): { targets: PickTarget[]; at: (m: string) => PickPlace; }
{
    const def = parse(text)[0];
    const ctx = rootCtx(text, { file: FILE, rel: 'events/reach_test.txt', hash: '', start: 0, line: 1, end: text.length });
    ctx.entityType = type;
    const event = type === 'events';
    const sites = saveSites(def, event, type, kind, calls);
    const names = [...new Set(sites.map((s) => s.name))];
    const targets = names.map((n): PickTarget =>
    {
        const reach = reachOf(sites.filter((s) => s.name === n), def, event, ctx);
        return { key: `scope:${n}`, label: n, ...(reach ? { reach } : {}) };
    });
    const at = (m: string): PickPlace =>
    {
        const i = text.search(new RegExp('@' + m + '\\b'));

        if (i < 0)
            throw new Error('no marker ' + m);

        return { file: FILE, offset: i };
    };
    return { targets, at };
}

const has = (targets: PickTarget[], place: PickPlace, key: string): boolean => inReach(targets, place).some((t) => t.key === 'scope:' + key);
const why = (targets: PickTarget[], place: PickPlace, key: string): string | undefined => awayAt(targets, place).find((a) => a.key === 'scope:' + key)?.why;

// --- an event: saves in immediate, an option, a temporary one in trigger and one inside an iterator
const event = `reach_test.1 = {
	trigger = {
		any_child = { save_temporary_scope_as = kid_temp }
		# @T1 (after the iterator, still the trigger)
	}
	immediate = {
		# @I0 (before the saves)
		random_courtier = { save_scope_as = helper }
		# @I1
		every_vassal = {
			save_temporary_scope_as = vassal_temp
			# @I2
		}
		# @I3 (after the iterator)
	}
	option = {
		name = reach_test.1.a
		trigger = {
			# @AT (the option's trigger, before its save)
		}
		# @A0
		liege = { save_scope_as = boss }
		# @A1
		ai_chance = { base = 1 save_temporary_scope_as = chance_temp }
		# @A2 (after the option's ai_chance)
	}
	option = {
		name = reach_test.1.b
		# @B0
	}
	after = {
		# @AF
	}
}
`;
{
    const { targets, at } = targetsOf(event, 'events');
    // helper: a lasting save in immediate
    check(!has(targets, at('I0'), 'helper') && why(targets, at('I0'), 'helper') === 'later', 'immediate save: not before it in immediate (why: later)');
    check(has(targets, at('I1'), 'helper') && has(targets, at('I3'), 'helper'), 'immediate save: after it in immediate');
    check(has(targets, at('A0'), 'helper') && has(targets, at('AT'), 'helper') && has(targets, at('B0'), 'helper') && has(targets, at('AF'), 'helper'), 'immediate save: in every option (and its trigger) and in after');
    check(!has(targets, at('T1'), 'helper') && why(targets, at('T1'), 'helper') === 'later', 'immediate save: not in the trigger, which runs earlier (why: later)');
    // boss: a lasting save in option A
    check(has(targets, at('A1'), 'boss') && has(targets, at('A2'), 'boss'), 'option save: after it in its option');
    check(!has(targets, at('A0'), 'boss') && why(targets, at('A0'), 'boss') === 'later', 'option save: not before it in its option (why: later)');
    check(!has(targets, at('AT'), 'boss'), 'option save: not in its own option trigger written before it');
    check(!has(targets, at('B0'), 'boss') && why(targets, at('B0'), 'boss') === 'elsewhere', 'option save: not in a sibling option (why: elsewhere)');
    check(has(targets, at('AF'), 'boss'), 'option save: in after');
    check(!has(targets, at('I3'), 'boss') && why(targets, at('I3'), 'boss') === 'later', 'option save: not in immediate (why: later)');
    // vassal_temp: a temporary save inside an iterator of immediate
    check(has(targets, at('I2'), 'vassal_temp') && has(targets, at('I3'), 'vassal_temp'), 'temporary save: the rest of its part, also after its block');
    check(!has(targets, at('A0'), 'vassal_temp') && !has(targets, at('AF'), 'vassal_temp') && why(targets, at('A0'), 'vassal_temp') === 'elsewhere', 'temporary save: not in another part (why: elsewhere)');
    check(!has(targets, at('I1'), 'vassal_temp') && why(targets, at('I1'), 'vassal_temp') === 'later', 'temporary save: not before it (why: later)');
    // kid_temp: a temporary save in the trigger
    check(has(targets, at('T1'), 'kid_temp') && !has(targets, at('I0'), 'kid_temp'), 'temporary save in trigger: the rest of the trigger, not immediate');
    // chance_temp: a temporary save in an option's ai_chance ends with it
    check(!has(targets, at('A2'), 'chance_temp'), "temporary save in an option's ai_chance: not in the rest of the option");
    // no reach, another file, no place
    const all: PickTarget[] = [...targets, { key: 'scope:given', label: 'given' }];
    check(inReach(all, at('T1')).some((t) => t.key === 'scope:given'), 'a target without reach (given, documented): in reach everywhere');
    check(inReach(targets, { file: 'D:/other/file.txt', offset: 5 }).length === targets.length, 'a place in another file (a line of a called script): every target');
    check(inReach(targets, undefined).length === targets.length && awayAt(targets, undefined).length === 0, 'no place: every target, none away');
    check(inReach(targets, { ...at('B0'), file: FILE.toUpperCase() }).some((t) => t.key === 'scope:helper'), 'the file compared without case (Windows paths)');
}

// --- an event without after / immediate: a new block of that key is in reach (ScopeReach.keys)
const noAfter = `reach_test.2 = {
	trigger = { save_scope_as = early }
	option = {
		name = x
		save_scope_as = chosen
	}
	# @END (the definition's end, inside it: where placeOf puts a new block into the definition)
}
`;
{
    const { targets, at } = targetsOf(noAfter, 'events');
    const newAfter = { ...at('END'), section: 'after' };
    const newImmediate = { ...at('END'), section: 'immediate' };
    check(has(targets, newAfter, 'chosen') && has(targets, newAfter, 'early'), "a new after: the option's and the trigger's saves are in reach");
    check(has(targets, newImmediate, 'early') && !has(targets, newImmediate, 'chosen'), "a new immediate: the trigger's save, not the option's");
    check(!has(targets, at('END'), 'chosen'), 'no section key: the range test only');
    const newOption = { ...at('END'), section: 'option' };
    check(has(targets, newOption, 'early') && !has(targets, newOption, 'chosen'), "a new option (one exists already): the trigger's save, not a sibling option's");
}

// --- other entries: a temporary save reaches its own part; a lasting one by the type's phase table (TYPE_PHASE), else everywhere
const decision = `my_decision = {
	is_shown = {
		# @D0
	}
	is_valid = {
		# @DV
	}
	cost = {
		gold = 10 # @DC (not in the table: order not known)
	}
	effect = {
		every_child = { save_temporary_scope_as = kid }
		# @D1
		save_scope_as = me
		# @D2
		liege = { save_scope_as = boss }
	}
	widget = {
		save_scope_as = from_widget
	}
	# @DE (the definition's end: where a new block goes)
}
`;
{
    const { targets, at } = targetsOf(decision, 'decisions');
    check(has(targets, at('D1'), 'kid') && !has(targets, at('D0'), 'kid'), 'decision: a temporary save in effect is in reach after it there, not in is_shown');
    check(!has(targets, at('D0'), 'me') && why(targets, at('D0'), 'me') === 'later' && !has(targets, at('DV'), 'me'), 'decision: an effect save is out of reach in is_shown and is_valid (why: later)');
    check(has(targets, at('D2'), 'me') && !has(targets, at('D1'), 'me') && why(targets, at('D1'), 'me') === 'later', 'decision: an effect save, after it in the effect; not before it there');
    check(has(targets, at('DC'), 'me') && has(targets, at('DE'), 'me') && has(targets, { ...at('DE'), section: 'ai_check_interval_by_tier' }, 'me'), 'decision: an effect save in a part the table does not list (cost) and between / after the parts (a new block of an unlisted key)');
    check(has(targets, at('D0'), 'from_widget') && has(targets, at('D1'), 'from_widget'), 'decision: a save in a part the table does not list (widget) is in reach everywhere');
    check(has(targets, at('DE'), 'boss') && !has(targets, at('D0'), 'boss') && why(targets, at('D2'), 'boss') === 'later', 'decision: a save inside a block of the effect counts as the effect');
    // (a new condition block put at the definition's end, between the parts: ScopeReach.notKeys)
    const newShown = { ...at('DE'), section: 'is_shown' };
    check(!has(targets, newShown, 'me') && why(targets, newShown, 'me') === 'later' && !has(targets, { ...at('DE'), section: 'ai_potential' }, 'me'), "decision: a new is_shown / ai_potential block (at the end) does not get the effect's save (why: later)");
    check(has(targets, newShown, 'from_widget') && has(targets, { ...at('DE'), section: 'effect' }, 'me'), "decision: a new is_shown gets a save of a part the table does not list (widget); a new block of the save's own phase gets it");
}
{
    // (the same name saved in a condition part too: a new is_shown block gets it from there, so it is in reach)
    const both = `two_decision = {
	is_valid = { save_scope_as = both }
	effect = { save_scope_as = both }
	# @BE
}
`;
    const { targets, at } = targetsOf(both, 'decisions');
    check(has(targets, { ...at('BE'), section: 'is_shown' }, 'both') && !targets[0].reach?.notKeys, 'decision: a name saved in is_valid and in the effect: a new is_shown block gets it (no notKeys)');
}

const interaction = `my_interaction = {
	is_shown = {
		# @X0
	}
	can_send = {
		# @XS
	}
	send_option = {
		is_valid = { always = yes } # @XO
		flag = x
	}
	ai_accept = {
		base = 0 # @XA (not in the table)
	}
	on_send = {
		# @X1
	}
	on_accept = {
		save_scope_as = accepted
		recipient = { save_scope_as = their_liege }
	}
	on_decline = {
		# @X2
	}
}
`;
{
    const { targets, at } = targetsOf(interaction, 'character_interactions');
    check(!has(targets, at('X0'), 'accepted') && !has(targets, at('XS'), 'accepted') && !has(targets, at('XO'), 'accepted'), 'interaction: an on_accept save is out of reach in is_shown, can_send and a send_option');
    check(has(targets, at('X1'), 'accepted') && has(targets, at('X2'), 'accepted'), 'interaction: an on_accept save is in reach in the other effects (on_send, on_decline: their order among themselves not taken)');
    check(has(targets, at('XA'), 'accepted'), 'interaction: an on_accept save is in reach in ai_accept (not in the table)');
}

const scheme = `my_scheme = {
	allow = {
		# @Y0
	}
	on_ready = {
		save_scope_as = done
	}
}
`;
{
    const { targets, at } = targetsOf(scheme, 'schemes');
    check(!targets.find((t) => t.key === 'scope:done')?.reach && has(targets, at('Y0'), 'done'), 'a type without a phase table: a lasting save has no reach (in reach everywhere)');
}

// (schemes, casus belli and activities: the conditions before the start or the declaration, then the effects; the
// parts checked while it runs are not listed)
for (const [type, text, cond, eff, open] of [
    ['schemes/scheme_types', 'p_scheme = {\n\tallow = {\n\t\t# @P0\n\t}\n\tvalid = {\n\t\t# @PV\n\t}\n\ton_start = {\n\t\tsave_scope_as = started\n\t}\n\ton_monthly = {\n\t\t# @P1\n\t}\n}\n', 'P0', 'P1', 'PV'],
    ['casus_belli_types', 'p_cb = {\n\tvalid_to_start = {\n\t\t# @P0\n\t}\n\tshould_invalidate = {\n\t\t# @PV\n\t}\n\ton_declaration = {\n\t\tsave_scope_as = started\n\t}\n\ton_victory = {\n\t\t# @P1\n\t}\n}\n', 'P0', 'P1', 'PV'],
    ['activities/activity_types', 'p_activity = {\n\tcan_start = {\n\t\t# @P0\n\t}\n\tis_valid = {\n\t\t# @PV\n\t}\n\ton_start = {\n\t\tsave_scope_as = started\n\t}\n\ton_complete = {\n\t\t# @P1\n\t}\n}\n', 'P0', 'P1', 'PV']
] as const)
{
    const { targets, at } = targetsOf(text, type);
    check(!has(targets, at(cond), 'started') && why(targets, at(cond), 'started') === 'later', `${type}: a save in the first effect is out of reach in the condition before the start (why: later)`);
    check(has(targets, at(eff), 'started') && has(targets, at(open), 'started'), `${type}: that save is in reach in a later effect and in a part checked while it runs (not listed)`);
}

// --- saved values and lists (EntityCard.values / lists): the same reach as scopes
const valuesEvent = `reach_test.5 = {
	immediate = {
		add_to_temporary_list = temp_list
		# @V0
	}
	option = {
		name = a
		save_scope_value_as = { name = v value = 5 }
		save_temporary_scope_value_as = { name = tv value = yes }
		add_to_list = picked_list
		# @VA
		my_list_effect = yes
		# @VB
	}
	option = {
		name = b
		# @VC
	}
	after = {
		# @VF
	}
}
`;
{
    const { targets: vals, at } = targetsOf(valuesEvent, 'events', 'value');
    check(vals.map((t) => t.key).join() === 'scope:v,scope:tv', `values: save_scope_value_as and the temporary one, by their name → ${vals.map((t) => t.key).join()}`);
    check(has(vals, at('VA'), 'v') && !has(vals, at('VC'), 'v') && why(vals, at('VC'), 'v') === 'elsewhere' && has(vals, at('VF'), 'v'), 'a value saved in option a: in reach after it, not in option b (elsewhere), in after');
    check(has(vals, at('VA'), 'tv') && !has(vals, at('VF'), 'tv'), 'a temporary value: the rest of its option, not after');
    const calls = new Map<string, SavedName[]>([['my_list_effect', [{ name: 'effect_list', temporary: false }]]]);
    const { targets: lists } = targetsOf(valuesEvent, 'events', 'list', calls);
    const l = (k: string): PickTarget[] => lists.filter((t) => t.key === 'scope:' + k);
    check(lists.map((t) => t.key.slice(6)).join() === 'temp_list,picked_list,effect_list', `lists: add_to_temporary_list, add_to_list, a called effect's → ${lists.map((t) => t.key.slice(6)).join()}`);
    check(has(l('picked_list'), at('VA'), 'picked_list') && !has(l('picked_list'), at('VC'), 'picked_list') && has(l('picked_list'), at('VF'), 'picked_list'), 'a list added in option a: not in option b, in after');
    check(has(l('temp_list'), at('V0'), 'temp_list') && !has(l('temp_list'), at('VA'), 'temp_list'), 'a temporary list: the rest of immediate, not an option');
    check(!has(l('effect_list'), at('VA'), 'effect_list') && why(l('effect_list'), at('VA'), 'effect_list') === 'later' && has(l('effect_list'), at('VB'), 'effect_list') && !has(l('effect_list'), at('VC'), 'effect_list'), 'a list a called effect adds: from the call on in its option (before it: later), not in option b');
}

// --- a called scripted effect's list written with a parameter (`add_to_list = $LIST$`): the call's value, or nothing
{
    const params = `reach_test.5 = {
	immediate = {
		param_list_effect = { LIST = given_list OTHER = x }
		param_list_effect = yes
		param_list_effect = { OTHER = x }
		param_list_effect = { LIST = { a = b } }
	}
}
`;
    const adds: SavedName[] = [{ name: '$LIST$', temporary: false, by: 'param_list_effect' }, { name: 'temp$LIST$', temporary: true, by: 'param_list_effect' }, { name: 'plain_list', temporary: false, by: 'param_list_effect' }];
    const calls = new Map<string, SavedName[]>([['param_list_effect', adds]]);
    const { targets: lists } = targetsOf(params, 'events', 'list', calls);
    const names = lists.map((t) => t.key.slice(6)).join();
    check(names === 'given_list,tempgiven_list,plain_list', `a parameter list: the call's value filled in (LIST = given_list), \`yes\` / no LIST / a block give none of them, a plain name stays → ${names}`);
    check(!lists.some((t) => t.key.includes('$')), 'a parameter list: no row with a $');
    const sites = saveSites(parse(params)[0], true, 'events', 'list', calls);
    check(sites.every((x) => x.by === 'param_list_effect'), 'a parameter list: each site says who adds it (SaveSite.by)');
    const chained = fillParams(adds, parse('call = { LIST = $OUTER$ }')[0]);
    check(chained.map((a) => a.name).join() === '$OUTER$,temp$OUTER$,plain_list', `a parameter passed on by a scripted effect stays one, for its own caller → ${chained.map((a) => a.name).join()}`);
    const own = saveSites(parse('my_param_effect = { add_to_list = $LIST$ }')[0], false, 'scripted_effects', 'list');
    check(own.map((x) => x.name).join() === '$LIST$', "a scripted effect's own `add_to_list = $LIST$` is one of its sites (its own card keeps it; StoryBuilder.savedNames drops it on other types)");
}

const effect = `my_effect = {
	if = {
		limit = { always = yes }
		random_child = { save_temporary_scope_as = pick }
	}
	# @S1 (after the if: still the one script)
}
`;
{
    const { targets, at } = targetsOf(effect, 'scripted_effects');
    check(has(targets, at('S1'), 'pick'), 'scripted effect: a temporary save reaches the rest of the definition');
}

// --- a second definition of the same file (a follow-up event shown nested in the timeline): every target there
const chain = `reach_test.3 = {
	immediate = {
		save_scope_as = passed_on
		every_vassal = { save_temporary_scope_as = vassal_temp }
	}
	option = {
		name = a
		save_scope_as = picked
		trigger_event = reach_test.4
	}
	option = {
		name = b
		# @C0 (a sibling option of the first definition)
	}
}

reach_test.4 = {
	immediate = {
		# @F0 (the follow-up's immediate, before any of its own saves)
	}
	option = {
		name = c
		# @F1
	}
}
`;
{
    const { targets, at } = targetsOf(chain, 'events');
    check(!has(targets, at('C0'), 'picked') && why(targets, at('C0'), 'picked') === 'elsewhere', 'two definitions: a sibling option of the first still does not get its save');
    check(inReach(targets, at('F0')).length === targets.length && inReach(targets, at('F1')).length === targets.length, 'two definitions: a place in the second gets every target of the first');
    check(awayAt(targets, at('F0')).length === 0 && awayAt(targets, at('F1')).length === 0, 'two definitions: none away in the second (no warning for a typed one)');
}

// --- known only inside the shown definition (setViewTargets' span; a follow-up shown nested is not known)
{
    const span = { file: FILE, s: 0, e: chain.indexOf('reach_test.4 = {') - 2 };
    const inFirst = { file: FILE, offset: chain.indexOf('@C0') };
    const inSecond = { file: FILE, offset: chain.indexOf('@F1') };
    setViewTargets([], true, span);
    check(viewTargetsKnown() && viewTargetsKnown(inFirst) && viewTargetsKnown({ ...inFirst, file: FILE.toUpperCase() }), 'known: no place, and a place inside the shown definition (file without case)');
    check(!viewTargetsKnown(inSecond) && !viewTargetsKnown({ file: 'D:/other/file.txt', offset: 5 }), 'not known: a place in another definition of the file (a nested follow-up), or in another file');
    check(!inSpan(span, { file: FILE, offset: span.e }) && inSpan(span, { file: FILE, offset: span.e - 1 }), 'inSpan: the end excluded');
    setViewTargets([], true);
    check(viewTargetsKnown(inSecond), 'no span given: known everywhere (as before)');
    setViewTargets([], false, span);
    check(!viewTargetsKnown(inFirst), 'not known stays not known inside the span');
    setViewTargets([]);
}

// --- placeOf: where the in-place editor's statement goes
{
    const src: LineSource = { file: FILE, rel: 'events/reach_test.txt', line: 3, s: 100, e: 140, inner: [110, 139], kind: 'effect', hash: '' };
    const p = (x: PickPlace): string => `${x.offset}${x.section ? ':' + x.section : ''}`;
    check(p(placeOf({ op: 'replace', at: src })) === '100', 'placeOf: a change at the statement');
    check(p(placeOf({ op: 'insert', at: src, where: 'after' })) === '140', 'placeOf: an add after the line, right after it');
    check(p(placeOf({ op: 'insert', at: src, where: 'inside' })) === '139', 'placeOf: an add into a block, at its end');
    check(p(placeOf({ op: 'insert', at: src, where: 'before', wrap: 'immediate' })) === '100:immediate', 'placeOf: a new block before a statement, named');
    check(p(placeOf({ op: 'insert', at: src, where: 'inside', wrap: 'after' })) === '139:after', 'placeOf: a new block at the end, named');
}

// --- round 13 wave 11 (lane T): an inlined line's place is its call (LineSource.via); the prev stack and the guess
// into the pick request; the typed scope warning of the picker and the value editor
{
    const src: LineSource = { file: FILE, rel: 'events/reach_test.txt', line: 3, s: 100, e: 140, inner: [110, 139], kind: 'effect', hash: '' };
    const inl: LineSource = { ...src, file: 'D:/test/common/scripted_effects/fx.txt', owner: { type: 'scripted_effects', name: 'fx' }, via: { file: FILE, offset: 777 } };
    const viaReplace = placeOf({ op: 'replace', at: inl });
    const viaInside = placeOf({ op: 'insert', at: inl, where: 'inside', wrap: 'limit' });
    check(viaReplace.file === FILE && viaReplace.offset === 777 && viaReplace.inlined === true && !viaReplace.section, 'placeOf: an inlined line (owner + via) is placed at its call, marked inlined');
    check(viaInside.offset === 777 && !viaInside.section, 'placeOf: an add into an inlined block too (no section of the shown entry)');
    check(placeOf({ op: 'replace', at: { ...inl, via: undefined } }).file === inl.file, 'placeOf: an inlined line without via stays at its own file (as before)');
    check(placeOf({ op: 'replace', at: { ...src, via: { file: FILE, offset: 5 } } }).offset === 100, 'placeOf: via without owner is ignored');
    // (known inside the span, but not at an inlined line's call: the effect may save scopes of its own)
    setViewTargets([], true, { file: FILE, s: 0, e: 1000 });
    check(viewTargetsKnown({ file: FILE, offset: 777 }) && !viewTargetsKnown(viaReplace), 'known: a plain place in the span, not an inlined line placed at its call');
    setViewTargets([]);

    // the event's targets at the call's place: option b's line (inlined) does not get option a's save
    const { targets, at } = targetsOf(event, 'events');
    const callInB: LineSource = { ...inl, via: { file: FILE, offset: at('B0').offset } };
    check(!inReach(targets, placeOf({ op: 'replace', at: callInB })).some((t) => t.key === 'scope:boss'), "an inlined line called in option b: option a's save is not in reach");

    // prevOf / scopeGuessOf
    const sw: LineSource = { ...src, scope: 'character', innerScope: 'landed_title', prev: ['character'], prevInside: ['character', 'character'], scopeGuessed: false, innerGuessed: true };
    check(JSON.stringify(prevOf({ op: 'insert', at: sw, where: 'inside' })) === '["character","character"]', 'prevOf: into a scope switch, the stack inside');
    check(JSON.stringify(prevOf({ op: 'insert', at: sw, where: 'after' })) === '["character"]' && JSON.stringify(prevOf({ op: 'replace', at: sw })) === '["character"]', "prevOf: after it or changing it, the line's stack");
    check(JSON.stringify(prevOf({ op: 'insert', at: { ...sw, prevInside: undefined }, where: 'inside' })) === '["character"]', 'prevOf: into a block that switches nothing (if), the same stack');
    check(prevOf({ op: 'insert', at: src, where: 'inside' }) === undefined, 'prevOf: nothing switched yet: none');
    check(scopeGuessOf({ op: 'insert', at: sw, where: 'inside' }) && !scopeGuessOf({ op: 'replace', at: sw }), 'scopeGuessOf: inside a guessed block, not the line itself');

    // typedScopeWarning: later, elsewhere, known and unknown, a chain head
    const inA1 = inReach(targets, at('A0'));
    const awayA0 = awayAt(targets, at('A0'));
    const awayB0 = awayAt(targets, at('B0'));
    check(/saved only later/.test(typedScopeWarning('scope:boss', inA1, awayA0, true) ?? ''), 'typedScopeWarning: saved later in the same option');
    check(/only in another part/.test(typedScopeWarning('scope:boss', inReach(targets, at('B0')), awayB0, false) ?? ''), 'typedScopeWarning: saved in another option (also when not all known)');
    check(/only in another part/.test(typedScopeWarning('scope:boss.liege', inReach(targets, at('B0')), awayB0, false) ?? ''), 'typedScopeWarning: a chain from it is judged by its head');
    check(/not saved or given here/.test(typedScopeWarning('scope:nobody', inA1, awayA0, true) ?? ''), 'typedScopeWarning: unknown name, all known: not saved here');
    check(typedScopeWarning('scope:nobody', inA1, awayA0, false) === undefined, 'typedScopeWarning: unknown name, nothing known: no warning');
    check(typedScopeWarning('scope:helper', inReach(targets, at('B0')), awayB0, true) === undefined, 'typedScopeWarning: in reach: no warning');
    check(typedScopeWarning('100', inA1, awayA0, true) === undefined && typedScopeWarning('liege', inA1, awayA0, true) === undefined && typedScopeWarning('', inA1, awayA0, true) === undefined, 'typedScopeWarning: a number, a link, nothing: no warning');

    // (2026-11-15) a called effect's own saves (EntityCard.calledSaves, PickTarget.inside): on its lines read inlined
    // only, by their reach at the line's own place (PickPlace.own); never offered or warned about elsewhere
    const fx = 'D:/test/common/scripted_effects/fx.txt';
    const own: PickTarget[] = [
        { key: 'scope:found', label: 'Found', inside: { file: fx, def: [50, 400] } },
        { key: 'scope:moment', label: 'Moment', inside: { file: fx, def: [50, 400] }, reach: { file: fx, def: [50, 400], ranges: [[200, 300]] } }
    ];
    const line = (s: number): LineSource => ({ ...inl, s, e: s + 10 });
    const keys = (ts: PickTarget[]): string => ts.map((t) => t.key).join(',');
    check(placeOf({ op: 'replace', at: line(120) }).own?.offset === 120 && placeOf({ op: 'insert', at: line(120), where: 'after' }).own?.offset === 130, "placeOf: an inlined line's own place (its start; an add after it at its end)");
    check(keys(inReach([...targets, ...own], placeOf({ op: 'replace', at: line(120) })).filter((t) => t.inside)) === 'scope:found', 'an inlined line inside the effect: its lasting save in reach, the temporary one outside its range not');
    check(keys(inReach(own, placeOf({ op: 'replace', at: line(250) }))) === 'scope:found,scope:moment', 'an inlined line in the temporary save\'s range: both');
    check(keys(inReach(own, placeOf({ op: 'replace', at: { ...line(120), file: 'D:/test/common/scripted_effects/other.txt' } }))) === '' && keys(inReach(own, at('B0'))) === '' && keys(inReach(own, undefined)) === '', 'elsewhere (another definition, the shown entry\'s own lines, no place): none of them');
    check(awayAt(own, at('B0')).length === 0 && awayAt(own, placeOf({ op: 'replace', at: line(120) })).length === 0, 'a called effect\'s own saves are never "saved only later / elsewhere"');
}

// --- scopeTypeByUse (round 13, the owner's E5r(e) decision): a saved scope nothing saves typed by its block's statements
{
    const use = (text: string): string | undefined => scopeTypeByUse(parse(text));
    check(use('set_county_culture = root.culture change_county_control = 10') === 'landed_title', 'by use: county statements give a title');
    check(use('if = { limit = { county_control >= 50 } set_county_faith = root.faith }') === 'landed_title', 'by use: statements inside if / limit count');
    check(use('holder = { add_gold = 5 } set_county_faith = root.faith') === 'landed_title', "by use: a link (holder, from a title) counts by its from, not what is inside it");
    check(use('every_vassal = { add_gold = 5 }') === 'character', "by use: an iterator counts by its from");
    check(use('add_gold = 10 add_prestige = 5') === 'character', 'by use: character statements give a character');
    check(use('save_scope_as = x') === undefined, 'by use: statements of any scope say nothing');
    check(use('add_gold = 10 change_county_control = 10') === undefined, 'by use: statements of two types fit none: not typed');
    check(use('some_unknown_key = yes') === undefined, 'by use: keys the catalog does not know say nothing');
}

console.log(failures ? `targets: ${failures} wrong` : 'targets: ok');
process.exit(failures ? 1 : 0);
