/**
 * Which effect and trigger keys the loaded script uses, how often, and with what values — the statement picker's
 * "Other effect… / Other condition…" list (docs/picker.md). Runs on a thread of its own (scriptKeysWorker.ts): it
 * parses every script file of common/ and events/ once more (≈ 3 s), walking only statement blocks (effect and
 * trigger blocks, their control flow, scope switches and iterators) so parameter keys (`target`, `modifier`) are not
 * taken for statements.
 */
import { parse, type PNode } from '../indexer/parser.ts';
import type { GameFile, GameFiles } from '../mods/gamefiles.ts';
import type { ScriptKeyInfo, ScriptKeys } from '../../shared/api.ts';

/** Blocks holding effects (below the top level of a definition). */
const EFFECT_BLOCKS = new Set([
    'immediate',
    'option',
    'after',
    'effect',
    'hidden_effect',
    'on_accept',
    'on_decline',
    'on_send',
    'on_auto_accept',
    'on_blocked_effect',
    'on_start',
    'on_end',
    'on_complete',
    'on_success',
    'on_failure',
    'on_invalidated',
    'on_monthly',
    'on_yearly',
    'on_enter',
    'on_exit',
    'on_win',
    'on_lose',
    'on_activate',
    'on_deactivate',
    'on_creation',
    'on_destroy',
    'on_phase_start',
    'on_phase_end',
    'on_enter_passive_state',
    'on_leave_passive_state',
    'on_semiyearly',
    'on_select',
    'on_declared',
    'on_victory',
    'on_white_peace',
    'on_defeat',
    'on_invalidated_desc',
    'on_join_war',
    'on_primary_attacker_death',
    'on_primary_defender_death',
    'on_travel_start',
    'on_arrival',
    'on_accepted',
    'on_rejected'
]);

/** Blocks holding triggers. */
export const TRIGGER_BLOCKS = new Set([
    'trigger',
    'limit',
    'potential',
    'is_shown',
    'is_valid',
    'is_valid_showing_failures_only',
    'can_send',
    'allow',
    'is_highlighted',
    'can_be_picked',
    'ai_potential',
    'can_start',
    'can_start_showing_failures_only',
    'is_available',
    'valid',
    'can_pick',
    'is_valid_target',
    'can_be_picked_title',
    'is_shown_to_targets',
    'target_filter_trigger',
    'can_join',
    'is_valid_for',
    'can_start_scheme'
]);

/** Keys that switch scope when they open a block (besides `prefix:x`, `var:x` and dotted chains). */
export const SCOPE_LINK_KEYS = new Set([
    'root',
    'prev',
    'this',
    'from',
    'liege',
    'top_liege',
    'father',
    'mother',
    'real_father',
    'primary_spouse',
    'betrothed',
    'primary_heir',
    'player_heir',
    'designated_heir',
    'employer',
    'host',
    'holder',
    'faith',
    'culture',
    'religion',
    'house',
    'dynasty',
    'primary_title',
    'capital_county',
    'capital_province',
    'capital_barony',
    'location',
    'title_province',
    'county',
    'duchy',
    'kingdom',
    'empire',
    'de_jure_liege',
    'killer',
    'imprisoner',
    'court_owner',
    'domicile',
    'owner',
    'artifact_owner',
    'scheme_owner',
    'scheme_target',
    'scheme_target_character',
    'target',
    'recipient',
    'actor',
    'secondary_actor',
    'secondary_recipient',
    'secret_owner',
    'secret_target',
    'involved_activity',
    'current_travel_plan',
    'activity_host',
    'spouse',
    'councillor',
    'war',
    'army',
    'house_head',
    'dynast',
    'religious_head',
    'head_of_faith',
    'story_owner',
    'task_contract_employer',
    'task_contract_taker',
    'culture_head',
    'primary_attacker',
    'primary_defender',
    'province_owner',
    'barony',
    'dynasty_head',
    'house_confederation'
]);

/** Parameters of iterators (not statements). */
const ITERATOR_PARAMS = new Set([
    'limit',
    'alternative_limit',
    'order_by',
    'max',
    'min',
    'position',
    'check_range_bounds',
    'weight',
    'type',
    'even_if_dead',
    'only_if_dead',
    'include_self',
    'filter',
    'relation',
    'province',
    'count',
    'percent',
    'list',
    'variable',
    'people',
    'check_province',
    'region',
    'custom',
    'vassal_stance',
    'title_tier',
    'name',
    'phase'
]);

const RANDOM_LIST_PARAMS = new Set(['trigger', 'modifier', 'desc', 'show_chance', 'min', 'max', 'opinion_modifier', 'compare_modifier', 'ai_value_modifier']);
const TEXT_PARAMS = new Set(['text', 'subject', 'object', 'value']);
/** keys of event options, duels and the like found among effects: not effects */
const NOT_EFFECTS = new Set(['name', 'trigger', 'ai_chance', 'flavor', 'reason', 'skill', 'skills', 'trait', 'custom', 'triggered_desc', 'show_as_unavailable', 'fallback', 'exclusive', 'is_cancel_option', 'clicksound', 'highlight_portrait', 'desc', 'first_valid', 'random_valid', 'localization', 'target', 'value']);
const NOT_TRIGGERS = new Set(['name', 'text']);
const NUMERIC = /^-?\d+(\.\d+)?$/;
const SCOPE_VALUE = /^(root|this|prev|from|scope:|[\w-]+\.)/;
/** folders without statements (or huge data files): not scanned */
const SKIP =
    /^common\/(coat_of_arms|dna_data|ethnicities|genes|culture\/name_lists|culture\/name_equivalency|named_colors|landed_titles|flavorization|customizable_localization|defines|modifier_definition_formats|effect_localization|trigger_localization|bookmark_portraits|portrait_modifiers|message_filter_types|graphical_unit_types)\//;

/** distinct values and block examples kept per key (then only those already seen are counted) */
const MAX_DISTINCT = 200;
/** a block's fields whose values are kept, and distinct values per field */
const FIELD_DISTINCT = 24;
const FIELD_VALUES = 60;

interface Tally
{
    count: number;
    shapes: Record<string, number>;
    values: Map<string, number>;
    fields: Map<string, number>;
    /** a block field's scalar values (FIELD_DISTINCT fields, each FIELD_VALUES values at most) */
    fieldValues: Map<string, Map<string, number>>;
    examples: Map<string, number>;
}

function isScopeKey(k: string): boolean
{
    return k.includes(':') || k.includes('.') || SCOPE_LINK_KEYS.has(k);
}

function isIterator(k: string, prefixes: RegExp, scripted: Set<string>): boolean
{
    return prefixes.test(k) && !scripted.has(k) && k !== 'random_list';
}

/** The whole block as one line, when short: `{ target = root modifier = x }` */
function blockText(src: string, n: PNode): string | undefined
{
    if (n.e - n.vs > 160)
        return undefined;

    const t = src.slice(n.vs, n.e)
        .replace(/#[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length <= 120 ? t : undefined;
}

/** A file's (or the base files') tallies per key. */
interface Bucket
{
    effect: Map<string, Tally>;
    trigger: Map<string, Tally>;
    /** the scripted effects / triggers defined there, with the `$PARAM$`s each uses (in the order written) */
    defined: { effect: Map<string, string[]>; trigger: Map<string, string[]>; };
}

const newBucket = (): Bucket => ({ effect: new Map(), trigger: new Map(), defined: { effect: new Map(), trigger: new Map() } });

/** Script files the scan reads: `.txt` of common/ and events/, not the data-only folders. */
export const scannedPath = (rel: string): boolean => /^(common|events)\/.*\.txt$/i.test(rel) && !SKIP.test(rel);

export class ScriptKeyScanner
{
    /** the files that don't change while the app runs (the game, packed and Workshop mods) — summed up */
    private base = newBucket();
    /** their paths (lower case): a change there needs a full scan */
    private baseRels = new Set<string>();
    /** the files that may change (an editable mod's, and whatever replaced a base file since): per path */
    private perFile = new Map<string, Bucket>();
    private tallies = this.base;
    private scripted = { effect: new Set<string>(), trigger: new Set<string>() };
    private src = '';

    /**
     * Scans the script files of common/ and events/ as the game loads them (with the mods' files layered in). Files
     * `own` says may change (an editable mod's) are kept per file: `rescan` then takes their changes in.
     */
    scan(files: GameFiles, progress?: (done: number, total: number) => void, own?: (f: GameFile) => boolean): ScriptKeys
    {
        const list = [...files.list('common', { ext: /\.txt$/i }), ...files.list('events', { ext: /\.txt$/i })].filter((f) => !SKIP.test(f.rel));
        // scripted effects and triggers first: their names tell them from iterators (`random_x` may be scripted)
        const order = (rel: string): number => (/^common\/scripted_(effects|triggers)\//.test(rel) ? 0 : 1);
        list.sort((a, b) => order(a.rel) - order(b.rel));
        let done = 0;

        for (const f of list)
        {
            const text = files.readText(f);
            const mine = own?.(f);

            if (mine)
                this.perFile.set(f.rel.toLowerCase(), this.tallies = newBucket());
            else
                this.baseRels.add(f.rel.toLowerCase());

            if (text)
                this.file(f.rel, text);

            this.tallies = this.base;

            if (++done % 200 === 0)
                progress?.(done, list.length);
        }

        return this.keys();
    }

    /** the keys as scanned (and rescanned) so far */
    keys(): ScriptKeys
    {
        return { effect: this.result('effect'), trigger: this.result('trigger') };
    }

    /**
     * Takes changed files in (game-relative paths): each one's tallies are made again from the file the game loads
     * now (none when it is gone). False when a path belongs to the summed-up files — only a full scan can take it in.
     */
    rescan(files: GameFiles, rels: string[]): boolean
    {
        const paths = [...new Set(rels.filter(scannedPath))];

        if (paths.some((r) => this.baseRels.has(r.toLowerCase())))
            return false;

        files.refresh();

        for (const rel of paths)
        {
            this.perFile.delete(rel.toLowerCase());
            const f = files.get(rel);
            const text = f && files.readText(f);

            if (!f || text === undefined)
                continue;

            this.perFile.set(rel.toLowerCase(), this.tallies = newBucket());
            this.file(f.rel, text);
            this.tallies = this.base;
        }

        return true;
    }

    file(rel: string, text: string): void
    {
        this.src = text;
        let nodes: PNode[];

        try
        {
            nodes = parse(text);
        }
        catch
        {
            return;
        }

        const se = /^common\/scripted_effects\//.test(rel);
        const st = /^common\/scripted_triggers\//.test(rel);

        if (se || st)
        {
            for (const n of nodes)
            {
                if (!n.k || !Array.isArray(n.v))
                    continue;

                this.scripted[se ? 'effect' : 'trigger'].add(n.k);
                // (its parameters: the `$NAME$`s its text uses — a call passes `NAME = value`)
                const params = [...new Set([...text.slice(n.vs, n.e).matchAll(/\$([A-Za-z_]\w*)\$/g)].map((m) => m[1]))];
                this.tallies.defined[se ? 'effect' : 'trigger'].set(n.k, params);

                if (se)
                    this.effects(n.v);
                else
                    this.triggers(n.v);
            }

            return;
        }

        this.outside(nodes, true);
    }

    /** definitions: looks for effect and trigger blocks at any depth below the top level */
    private outside(nodes: PNode[], top: boolean): void
    {
        for (const n of nodes)
        {
            if (!Array.isArray(n.v))
                continue;

            if (!top && n.k && EFFECT_BLOCKS.has(n.k))
                this.effects(n.v);
            else if (!top && n.k && TRIGGER_BLOCKS.has(n.k))
                this.triggers(n.v);
            else
                this.outside(n.v, false);
        }
    }

    private record(kind: 'effect' | 'trigger', n: PNode): void
    {
        const k = n.k!;
        const m = this.tallies[kind];
        let t = m.get(k);

        if (!t)
            m.set(k, t = { count: 0, shapes: {}, values: new Map(), fields: new Map(), fieldValues: new Map(), examples: new Map() });

        t.count++;
        const bump = (map: Map<string, number>, key: string): void =>
        {
            const c = map.get(key);

            if (c !== undefined)
                map.set(key, c + 1);
            else if (map.size < MAX_DISTINCT)
                map.set(key, 1);
        };

        if (Array.isArray(n.v))
        {
            t.shapes.block = (t.shapes.block ?? 0) + 1;
            const seen = new Set<string>();

            for (const c of n.v)
            {
                if (c.k && !seen.has(c.k))
                    (seen.add(c.k), bump(t.fields, c.k));

                // (what is written for the field: a scripted effect's parameters, a relation's reason)
                if (c.k && typeof c.v === 'string')
                {
                    let fv = t.fieldValues.get(c.k);

                    if (!fv && t.fieldValues.size < FIELD_DISTINCT)
                        t.fieldValues.set(c.k, fv = new Map());

                    if (fv)
                    {
                        const v = c.op && c.op !== '=' && c.op !== '?=' ? `${c.op} ${c.v}` : c.v;
                        const x = fv.get(v);

                        if (x !== undefined)
                            fv.set(v, x + 1);
                        else if (fv.size < FIELD_VALUES)
                            fv.set(v, 1);
                    }
                }
            }

            const ex = blockText(this.src, n);

            if (ex)
                bump(t.examples, ex);

            return;
        }

        const v = n.v;
        const op = n.op && n.op !== '=' && n.op !== '?=' ? n.op : '';
        const shape = op ? 'compare' : v === 'yes' || v === 'no' ? 'bool' : NUMERIC.test(v) ? 'number' : SCOPE_VALUE.test(v) ? 'scope' : /^\w+:/.test(v) ? 'link' : 'name';
        t.shapes[shape] = (t.shapes[shape] ?? 0) + 1;
        bump(t.values, op ? `${op} ${v}` : v);
    }

    private skipKey(k: string | null): boolean
    {
        return !k || k.includes('$') || NUMERIC.test(k);
    }

    /** scope comparisons (`scope:a = scope:b`, `root.faith = …`) are not listed */
    private listed(k: string, kind: 'effect' | 'trigger'): boolean
    {
        return !k.includes(':') && !k.includes('.') && !(kind === 'effect' ? NOT_EFFECTS : NOT_TRIGGERS).has(k);
    }

    effects(nodes: PNode[]): void
    {
        for (const n of nodes)
        {
            const k = n.k;

            if (this.skipKey(k) || k === 'limit')
                continue;

            const block = Array.isArray(n.v) ? n.v : null;

            if (block && isScopeKey(k!))
            {
                this.effects(block);
                continue;
            }

            if (this.listed(k!, 'effect'))
                this.record('effect', n);

            if (!block)
                continue;

            switch (k)
            {
                case 'if':
                case 'else_if':
                case 'else':
                case 'while':
                    for (const c of block)
                        if (c.k === 'limit' && Array.isArray(c.v))
                            this.triggers(c.v);

                    this.effects(block.filter((c) => c.k !== 'limit' && c.k !== 'count'));
                    continue;
                case 'hidden_effect':
                case 'show_as_tooltip':
                    this.effects(block);
                    continue;
                case 'custom_tooltip':
                case 'custom_description':
                case 'custom_description_no_bullet':
                    this.effects(block.filter((c) => !TEXT_PARAMS.has(c.k ?? '')));
                    continue;
                case 'random':
                    this.effects(block.filter((c) => c.k !== 'chance' && c.k !== 'modifier'));
                    continue;
                case 'random_list':
                case 'duel':
                    for (const c of block)
                    {
                        if (!Array.isArray(c.v) || RANDOM_LIST_PARAMS.has(c.k ?? ''))
                            continue;

                        for (const x of c.v)
                            if (x.k === 'trigger' && Array.isArray(x.v))
                                this.triggers(x.v);

                        this.effects(c.v.filter((x) => !RANDOM_LIST_PARAMS.has(x.k ?? '')));
                    }

                    continue;
                case 'switch':
                    for (const c of block)
                        if (c.k !== 'trigger' && Array.isArray(c.v))
                            this.effects(c.v);

                    continue;
            }

            if (isIterator(k!, /^(every|random|ordered)_/, this.scripted.effect))
            {
                for (const c of block)
                    if ((c.k === 'limit' || c.k === 'alternative_limit') && Array.isArray(c.v))
                        this.triggers(c.v);

                this.effects(block.filter((c) => !ITERATOR_PARAMS.has(c.k ?? '')));
            }
        }
    }

    triggers(nodes: PNode[]): void
    {
        for (const n of nodes)
        {
            const k = n.k;

            if (this.skipKey(k))
                continue;

            const block = Array.isArray(n.v) ? n.v : null;

            if (block && isScopeKey(k!))
            {
                this.triggers(block);
                continue;
            }

            if (this.listed(k!, 'trigger'))
                this.record('trigger', n);

            if (!block)
                continue;

            switch (k)
            {
                case 'AND':
                case 'OR':
                case 'NOT':
                case 'NOR':
                case 'NAND':
                    this.triggers(block);
                    continue;
                case 'trigger_if':
                case 'trigger_else_if':
                case 'trigger_else':
                    for (const c of block)
                        if (c.k === 'limit' && Array.isArray(c.v))
                            this.triggers(c.v);

                    this.triggers(block.filter((c) => c.k !== 'limit'));
                    continue;
                case 'calc_true_if':
                    this.triggers(block.filter((c) => c.k !== 'amount'));
                    continue;
                case 'custom_description':
                case 'custom_tooltip':
                case 'custom_description_no_bullet':
                    this.triggers(block.filter((c) => !TEXT_PARAMS.has(c.k ?? '')));
                    continue;
            }

            if (isIterator(k!, /^any_/, this.scripted.trigger))
                this.triggers(block.filter((c) => !ITERATOR_PARAMS.has(c.k ?? '')));
        }
    }

    /** the base tallies with the per-file ones added (a key some file uses: a merged copy) */
    private merged(kind: 'effect' | 'trigger'): Map<string, Tally>
    {
        if (!this.perFile.size)
            return this.base[kind];

        const out = new Map(this.base[kind]);
        const add = (into: Map<string, number>, from: Map<string, number>): void =>
        {
            for (const [k, n] of from)
                into.set(k, (into.get(k) ?? 0) + n);
        };

        for (const b of this.perFile.values())
        {
            for (const [key, t] of b[kind])
            {
                const have = out.get(key);
                const m: Tally = have && have !== this.base[kind].get(key)
                    ? have
                    : { count: have?.count ?? 0, shapes: { ...have?.shapes }, values: new Map(have?.values), fields: new Map(have?.fields), fieldValues: new Map([...(have?.fieldValues ?? [])].map(([k, v]) => [k, new Map(v)])), examples: new Map(have?.examples) };
                m.count += t.count;

                for (const [s, n] of Object.entries(t.shapes))
                    m.shapes[s] = (m.shapes[s] ?? 0) + n;

                add(m.values, t.values);
                add(m.fields, t.fields);

                for (const [field, vals] of t.fieldValues)
                    add(m.fieldValues.get(field) ?? m.fieldValues.set(field, new Map()).get(field)!, vals);

                add(m.examples, t.examples);
                out.set(key, m);
            }
        }

        return out;
    }

    private result(kind: 'effect' | 'trigger'): ScriptKeyInfo[]
    {
        const top = (m: Map<string, number>, n: number): [string, number][] => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
        const out: ScriptKeyInfo[] = [];
        // (a definition in a file read again replaces the summed-up one)
        const defined = new Map(this.base.defined[kind]);

        for (const b of this.perFile.values())
            for (const [key, params] of b.defined[kind])
                defined.set(key, params);

        for (const [key, t] of this.merged(kind))
        {
            const info: ScriptKeyInfo = { key, count: t.count, shapes: t.shapes, values: top(t.values, 16) };

            if (t.fields.size)
                info.fields = top(t.fields, 10);

            if (t.fieldValues.size)
                info.fieldValues = Object.fromEntries([...t.fieldValues].map(([field, vals]) => [field, top(vals, 12)]));

            if (t.examples.size)
                info.examples = top(t.examples, 4);

            if (this.scripted[kind].has(key))
                info.scripted = true;

            const params = defined.get(key);

            if (params?.length)
                info.params = params;

            out.push(info);
        }

        // (scripted ones nothing uses yet — a mod's new one: listed too)
        const listed = new Set(out.map((x) => x.key));

        for (const [key, params] of defined)
            if (!listed.has(key))
                out.push({ key, count: 0, shapes: {}, values: [], scripted: true, ...(params.length ? { params } : {}) });

        return out.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
    }
}
