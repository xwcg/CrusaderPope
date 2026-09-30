/** Realm cards: subject contracts and their groups, lease contracts, hooks (common/subject_contracts, lease_contracts, hook_types). */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich } from '../../../shared/api.ts';
import { capitalize, formatNumber, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { RealmCard, isBlock, items, join, val, type Block } from './realm-kit.ts';

/** Shares of an obligation level (0..1 of the subject's income, script math allowed), shown as percents. */
const SHARES = new Set(['tax', 'levies', 'herd', 'barter_goods', 'prestige', 'piety', 'min_tax', 'min_levies', 'min_herd', 'min_barter_goods']);

/** Keys of an obligation level only for the contract window's layout. */
const LAYOUT = new Set(['position', 'icon', 'color', 'gui_tags', 'contribution_desc', 'tax_contribution_postfix', 'levies_contribution_postfix', 'herd_contribution_postfix', 'unclamped_contribution_label', 'min_contribution_label']);

/** An obligation level's name: its loc (`<level>`, some start with an icon), else the key made readable. */
function levelName(c: RealmCard, key: string): Rich
{
    const r = c.d.loc(key);
    return r ? r.map((s, i) => (typeof s === 'string' && i === 0 ? s.trimStart() : s)) : [humanize(key)];
}

/**
 * One obligation level (common/subject_contracts/contracts/_subject_contracts.info): what the subject gives (shares
 * as percents), the opinion, modifiers on liege and subject, when it is shown and valid, its other fields.
 */
function obligationLevel(c: RealmCard, lv: Block): Line
{
    const kids: Line[] = [];
    const fields: PNode[] = [];

    for (const n of lv.v)
    {
        // (the default is said in the level's heading, the AI's wishes are the AI section)
        if (!n.k || LAYOUT.has(n.k) || n.k === 'default' || n.k === 'ai_liege_desire' || n.k === 'ai_subject_desire')
            continue;

        if (n.k === 'score' && typeof n.v === 'string')
        {
            // a positive score favours the subject: compared when obligations change (defaults to the order of the levels)
            const v = Number(n.v);
            kids.push({ text: [v > 0 ? `Favours the subject (score ${n.v})` : v < 0 ? `Favours the liege (score ${n.v})` : 'Favours neither side (score 0)'], tip: `score = ${n.v}`, src: c.b.fieldAnchor(n, c.ctx, 'obligation_level') });
        }
        else if (SHARES.has(n.k))
        {
            const label = capitalize(`${n.k.startsWith('min_') ? 'at least ' : ''}${humanize(n.k.replace(/^min_/, ''))}`);
            const src = c.b.fieldAnchor(n, c.ctx, 'obligation_level', isBlock(n));

            if (isBlock(n))
                kids.push({ text: [label + ':'], children: c.value(n), icon: 'gold', src });
            else
            {
                const v = c.num(n.v as string);
                kids.push({ text: rich(label, ': ', v !== undefined ? { text: `${formatNumber(v * 100)}%`, kind: 'value', tip: n.v as string } : c.d.valueSeg(n.v as string, c.ctx)), icon: 'gold', tip: `${n.k} = ${n.v}`, src });
            }
        }
        else if (n.k === 'parent' && typeof n.v === 'string')
        {
            kids.push({ text: rich('Follows ', levelName(c, n.v)), tip: `parent = ${n.v}`, src: c.b.fieldAnchor(n, c.ctx, 'obligation_level') });
        }
        else if ((n.k === 'liege_modifier' || n.k === 'subject_modifier') && isBlock(n))
        {
            kids.push({ text: [n.k === 'liege_modifier' ? 'The liege gets:' : 'The subject gets:'], children: c.d.statsOf(n.v, c.ctx), icon: 'modifier', src: c.anchor(n, 'modifier', true) });
        }
        else if ((n.k === 'is_shown' || n.k === 'is_valid') && isBlock(n))
        {
            kids.push({ text: [n.k === 'is_shown' ? 'Shown when:' : 'Valid when:'], conditions: c.conditions(n), src: c.anchor(n, 'trigger', true) });
        }
        else if (typeof n.v === 'string')
            fields.push(n);
        else if (isBlock(n))
            kids.push({ text: [humanize(n.k) + ':'], children: c.value(n), src: c.anchor(n, 'other') });
    }

    kids.push(...c.fields('obligation_level', fields));
    return { text: rich(levelName(c, lv.k!), val(lv.v, 'default') === 'yes' ? ' — the default' : ''), children: kids, tip: lv.k!, src: c.b.fieldAnchor(lv, c.ctx, 'obligation_level', true) };
}

/** A subject contract (an obligation of vassals or tributaries): its levels, when it is shown or can change, the AI's wishes. */
const contract: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    c.skip('icon');
    const levels = (c.block('obligation_levels')?.v ?? []).filter(isBlock);

    if (levels.length > 1)
        c.fact(`${levels.length} levels`);

    c.section('Levels', levels.map((lv) => obligationLevel(c, lv)));
    c.settings('Settings', 'subject_contracts/contracts');
    c.triggers('is_shown', 'Shown when');
    c.triggers('can_be_changed', 'Can be changed when');

    // the AI's wishes per level
    for (const lv of levels)
    {
        const wishes = lv.v.filter((n) => n.k === 'ai_liege_desire' || n.k === 'ai_subject_desire').map((n) => c.weight(n, n.k === 'ai_liege_desire' ? 'The liege wants it' : 'The subject wants it'));

        if (wishes.length)
            c.aiMore([{ text: levelName(c, lv.k!), children: wishes, tip: lv.k! }]);
    }

    return c.done();
};

/** A group of subject contracts (what a government's vassals or tributaries owe): its contracts, the tributary rules. */
const contractGroup: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const list = c.block('contracts');
    c.section('Contracts', items(list).map((n): Line => ({ text: [b.d.ref(n.v as string, ['subject_contracts/contracts'])], tip: n.v as string, src: c.anchor(n, 'other') })));
    c.settings('Settings', 'subject_contracts/groups');
    c.triggers('is_valid_tributary_contract', 'Valid for a tributary when', 'character');
    c.triggers('tributary_can_break_free', 'The tributary can break free when', 'character');
    return c.done();
};

/** How a lease's tax or levy is split (common/lease_contracts/_lease_contracts.info): the lease liege's share, the rest. */
function leaseSplit(c: RealmCard, n: Block): Line[]
{
    const out: Line[] = [];

    for (const s of n.v)
    {
        if (s.k === 'lease_liege' && typeof s.v === 'string')
            out.push({ text: [`${s.v}% to the lease liege`], icon: 'gold', tip: `lease_liege = ${s.v}`, src: c.anchor(s, 'other') });
        else if (s.k === 'rest' && typeof s.v === 'string')
            out.push({ text: [`The rest to the ${s.v}`], icon: 'gold', tip: `rest = ${s.v}`, src: c.anchor(s, 'other') });
        else if (s.k === 'rest' && isBlock(s))
        {
            const who = val(s.v, 'beneficiary') ?? 'lessee';
            const other = val(s.v, 'rest') ?? (who === 'ruler' ? 'lessee' : 'ruler');
            const max = val(s.v, 'max');
            const weight = s.v.find((w) => w.k === 'weight');
            out.push({
                text: [`Of the rest, the ${who} gets a share${max ? ` of up to ${max}%` : ''}, the ${other} the remainder`],
                icon: 'gold',
                children: weight ? [c.weight(weight, `The ${who}’s share`)] : undefined,
                src: c.anchor(s, 'other')
            });
        }
    }

    return out;
}

/** A lease contract (holdings leased out by their ruler): who takes part, which baronies, how income and levies are split. */
const lease: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const holdings = c.block('valid_holdings');
    const lines: Line[] = [];

    if (holdings)
        lines.push({ text: rich('No penalty for the wrong holding type: ', join(items(holdings).map((n) => b.d.ref(n.v as string, ['holdings'])))), tip: 'valid_holdings', src: c.anchor(holdings, 'other') });

    c.settings('Settings', 'lease_contracts', lines);
    const h = c.block('hierarchy');

    if (h)
    {
        const rows: Line[] = [];

        for (const n of h.v)
        {
            if (n.k === 'lessee' && typeof n.v === 'string')
                rows.push({ text: rich('The lessee: ', b.d.valueSeg(n.v, c.ctx)), icon: 'scope', tip: `lessee = ${n.v}`, src: c.anchor(n, 'other') });
            else if (n.k === 'ruler_valid')
                rows.push({ text: ['Rulers who use it:'], conditions: c.conditions(n, 'character'), src: c.anchor(n, 'trigger', true) });
            else if (n.k === 'liege_or_vassal_valid')
                rows.push({ text: ['Rulers stay in one hierarchy (with the target) when:'], conditions: c.conditions(n, 'character'), src: c.anchor(n, 'trigger', true) });
            else if (n.k === 'barony_valid')
                rows.push({ text: ['Baronies leased out automatically:'], conditions: c.conditions(n, 'landed_title'), src: c.anchor(n, 'trigger', true) });
        }

        c.section('Hierarchy', rows);
    }

    for (const [k, title] of [['tax', 'Taxes'], ['levy', 'Levies']])
    {
        const n = c.block(k);

        if (n)
            c.section(title, leaseSplit(c, n));
    }

    return c.done();
};

/** A hook type (common/hook_types/_hooks.info): strong or weak, how long it lasts, whether it needs a secret, what using it does. */
const hook: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    c.fact(val(x.body, 'strong') === 'yes' ? 'Strong hook' : 'Weak hook');
    const exp = c.node('expiration_days');
    const days = typeof exp?.v === 'string' ? Number(exp.v) : -1;

    if (days < 0)
        c.fact('Never expires');

    const lines: Line[] = [];

    if (exp)
    {
        // (-1: never)
        const l = c.field('hook_types', exp);

        if (days < 0)
            l.text = ['Never expires'];
        else if (days > 0 && days % 365 === 0)
            l.text = rich(l.text, ` (${days / 365} year${days === 365 ? '' : 's'})`);

        lines.push(l);
    }

    c.settings('Settings', 'hook_types', lines);
    c.effects('on_used', 'When used', 'character');
    return c.done();
};

export const CONTRACT_CARDS: Record<string, CardFn> = {
    'subject_contracts/contracts': contract,
    'subject_contracts/groups': contractGroup,
    lease_contracts: lease,
    hook_types: hook
};
