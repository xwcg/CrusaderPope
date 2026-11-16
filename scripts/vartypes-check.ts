// Checks the scope hints the story builder gives lines over a small made-up game folder in TEMP (light: no game files
// are read, the index of a few files is built in well under a second):
// - an on_action's `var:x = { … }` block in its effect is typed by its own `set_variable` (Ctx.varTypes per
//   definition, stories.ts onActionStory);
// - a variable set in another file is typed when every setter agrees (StoryBuilder.globalVarTypes; local_var never);
// - a scope something passes in (an event's caller, a card's untyped known target) is never guessed from its block's
//   use, and a character use of a scope nothing gives is marked as a guess too (Ctx.knownScopes; Describer.switched).
// Usage: node --experimental-strip-types --no-warnings scripts/vartypes-check.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import type { Line } from '../src/shared/api.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};
const T = '\t';
const lines = (...l: string[]): string => l.join('\n') + '\n';
const flat = (ls: Line[]): Line[] => ls.flatMap((l) => [l, ...flat(l.children ?? [])]);
/** the first line whose statement (its tip) starts with `head`: its own scope and its block's (innerScope, `?`: guessed) */
const scopes = (ls: Line[], head: string): string =>
{
    const l = flat(ls).find((x) => (x.tip ?? '').startsWith(head));
    return l ? `${l.src?.scope ?? '-'}/${l.src?.innerScope ?? '-'}${l.src?.innerGuessed ? '?' : ''}` : 'no line';
};

const dir = mkdtempSync(join(tmpdir(), 'ckp-vartypes-'));

try
{
    const game = join(dir, 'game');
    const put = (rel: string, text: string): void => (mkdirSync(join(game, rel, '..'), { recursive: true }), writeFileSync(join(game, rel), text));
    // (E5r(c): an on_action's effect sets a variable to a title and reads it in a block)
    put('common/on_action/vt.txt', lines(
        'on_vt_test = {',
        T + 'effect = {',
        T + T + 'set_variable = { name = vt_title value = primary_title }',
        T + T + 'var:vt_title = {',
        T + T + T + 'set_county_faith = root.faith',
        T + T + '}',
        T + '}',
        '}'
    ));
    // (E5r(e), the owner's D1: vt.1 saves a character and an untyped scope and fires vt.2, which uses both in blocks that
    // read as a title; vt.3 is fired by nothing; vt_effect is called from vt.1 inside the untyped scope's save)
    put('events/vt.txt', lines(
        'namespace = vt',
        'vt.1 = {',
        T + 'type = character_event',
        T + 'immediate = {',
        T + T + 'save_scope_as = vt_friend',
        T + T + 'var:vt_nothing = { save_scope_as = vt_untyped }',
        T + T + 'vt_effect = yes',
        T + T + 'trigger_event = vt.2',
        T + '}',
        '}',
        'vt.2 = {',
        T + 'type = character_event',
        T + 'immediate = {',
        T + T + 'scope:vt_friend = { set_county_faith = root.faith }',
        T + T + 'scope:vt_untyped = { set_county_faith = root.faith }',
        T + T + 'scope:vt_strange = { set_county_faith = root.faith }',
        T + '}',
        '}',
        'vt.3 = {',
        T + 'type = character_event',
        T + 'immediate = {',
        T + T + 'scope:vt_nobody = { add_gold = 5 }',
        T + T + 'scope:vt_nobody_land = { set_county_faith = root.faith }',
        T + T + 'scope:vt_quiet = { save_scope_as = vt_other }',
        T + '}',
        '}'
    ));
    put('common/scripted_effects/vt.txt', lines(
        'vt_effect = {',
        T + 'scope:vt_untyped = { set_county_faith = root.faith }',
        T + 'scope:vt_unknown_here = { set_county_faith = root.faith }',
        '}'
    ));
    // (E5r(d): variables set in other files: vt.4 reads them, the setters are an effect and two events elsewhere)
    put('events/vt_read.txt', lines(
        'namespace = vt',
        'vt.4 = {',
        T + 'type = character_event',
        T + 'immediate = {',
        T + T + 'var:vt_cross = { set_county_faith = root.faith }',
        T + T + 'var:vt_mixed = { set_county_faith = root.faith }',
        T + T + 'var:vt_num = { set_county_faith = root.faith }',
        T + T + 'var:vt_short = { set_county_faith = root.faith }',
        T + T + 'local_var:vt_loc = { set_county_faith = root.faith }',
        T + T + 'global_var:vt_glob = { set_county_faith = root.faith }',
        T + T + 'var:vt_none = { set_county_faith = root.faith }',
        T + T + 'set_variable = { name = vt_own value = liege }',
        T + T + 'var:vt_own = { add_gold = 5 }',
        T + '}',
        '}'
    ));
    put('events/vt_set.txt', lines(
        'namespace = vt',
        'vt.5 = {',
        T + 'type = character_event',
        T + 'immediate = {',
        T + T + 'primary_title = { save_scope_as = vt_land }',
        T + T + 'set_variable = { name = vt_cross value = scope:vt_land }',
        T + T + 'set_variable = { name = vt_mixed value = liege }',
        T + T + 'set_variable = { name = vt_num value = 5 }',
        T + T + 'set_variable = vt_short',
        T + T + 'set_local_variable = { name = vt_loc value = primary_title }',
        T + T + 'set_global_variable = { name = vt_glob value = primary_title }',
        T + T + 'set_variable = { name = vt_own value = primary_title }',
        T + '}',
        '}'
    ));
    put('common/scripted_effects/vt_set.txt', lines(
        'vt_setter = {',
        T + 'set_variable = { name = vt_cross value = primary_title }',
        T + 'set_variable = { name = vt_mixed value = primary_title }',
        T + 'set_variable = { name = vt_num value = primary_title }',
        T + 'set_variable = { name = vt_short value = primary_title }',
        '}'
    ));
    const idx = new GameIndex(new GameFiles(game, []), 'english');
    idx.build();
    const sb = new StoryBuilder(idx);

    // --- E5r(d): a variable set in another file, typed when every setter agrees
    {
        const e = idx.get('events', 'vt.4');
        const st = e && sb.eventStory(e);
        const ls = st ? st.immediate : [];
        const want: [string, string, string][] = [
            ['var:vt_cross', 'character/landed_title', 'two setters in other files agree (a title; one through its own saved scope)'],
            ['var:vt_mixed', 'character/-', 'setters disagree (a title and a character): not typed'],
            ['var:vt_num', 'character/-', 'one setter sets a number: not typed'],
            ['var:vt_short', 'character/-', "one setter is the short form (no scope): not typed"],
            ['local_var:vt_loc', 'character/-', 'local_var set in another file: not typed (local by the rules)'],
            ['global_var:vt_glob', 'character/landed_title', 'global_var set in another file: typed'],
            ['var:vt_none', 'character/-', 'no setter: not typed'],
            ['var:vt_own', 'character/character', "a variable the definition sets itself keeps its own type (another file's title set is not read)"]
        ];

        for (const [head, exp, what] of want)
            check(scopes(ls, head) === exp, `variables: ${what} (got ${scopes(ls, head)})`);

        check(sb.varStats.keys === 6, `variables: globalVarType looked up the six keys read without an own set (got ${sb.varStats.keys})`);
    }

    // --- E5r(e) to D1's letter: a scope something passes in is never guessed; a character use is a guess too
    {
        const ev = (name: string): Line[] =>
        {
            const e = idx.get('events', name);
            const st = e && sb.eventStory(e);
            return st ? st.immediate : [];
        };
        const at2 = (head: string): string => scopes(ev('vt.2'), head);
        const at3 = (head: string): string => scopes(ev('vt.3'), head);
        check(at2('scope:vt_friend') === 'character/character', `event: a character its caller passes in is typed so, not guessed from a title block (got ${at2('scope:vt_friend')})`);
        check(at2('scope:vt_untyped') === 'character/character', `event: an untyped scope its caller passes in is not guessed (got ${at2('scope:vt_untyped')})`);
        check(at2('scope:vt_strange') === 'character/landed_title?', `event: a scope nobody passes in is still guessed from its block (got ${at2('scope:vt_strange')})`);
        check(at3('scope:vt_nobody =') === 'character/character?', `event: a character use of a scope nobody gives is marked as a guess (got ${at3('scope:vt_nobody =')})`);
        check(at3('scope:vt_nobody_land') === 'character/landed_title?', `event: a title use of a scope nobody gives is a guess (got ${at3('scope:vt_nobody_land')})`);
        check(at3('scope:vt_quiet') === 'character/character', `event: a block that says nothing stays a character, unmarked (got ${at3('scope:vt_quiet')})`);
        const fx = idx.get('scripted_effects', 'vt_effect');
        const card = fx && sb.card(fx);
        const fl = (card?.sections ?? []).flatMap((s) => s.lines);
        check(scopes(fl, 'scope:vt_untyped') === '-/character', `card: an untyped target its caller saved is not guessed (got ${scopes(fl, 'scope:vt_untyped')})`);
        check(scopes(fl, 'scope:vt_unknown_here') === '-/landed_title?', `card: a name no caller gives is guessed (got ${scopes(fl, 'scope:vt_unknown_here')})`);
    }

    // --- E5r(c): an on_action's var:x block
    {
        const oa = idx.get('on_action', 'on_vt_test');
        const story = oa && sb.onActionStory(oa);
        const got = story ? scopes(story.effects, 'var:vt_title') : 'no on_action';
        const inner = story ? scopes(story.effects, 'set_county_faith') : 'no on_action';
        check(got === 'character/landed_title' && inner === 'landed_title/-', `on_action: the var:vt_title block's inside is a title (got ${got}, its line ${inner})`);
    }
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `vartypes: ${failures} wrong` : 'vartypes: ok');
process.exit(failures ? 1 : 0);
