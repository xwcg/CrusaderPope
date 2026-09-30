/**
 * Cards of looks: colours, coats of arms (common/coat_of_arms), genes and DNA (common/genes, dna_data,
 * bookmark_portraits, portrait_types — docs/portraits.md), modifier icons. Compact: the portrait viewer and the
 * pictures show the rest.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { capitalize, formatNumber, humanize, rich } from '../text.ts';
import { colorText, firstValidLines, join, kids, lineComment, note, pictureSeg, str, values, words } from './presentation-util.ts';

// ---------------------------------------------------------------------------
// Coats of arms
// ---------------------------------------------------------------------------

/** A value, or `list "name"` (the next bare value: a random pick from a template list). */
function listed(list: PNode[], i: number): { v?: string; list?: string; }
{
    const c = list[i];

    if (c.v === 'list' && list[i + 1]?.k === null && typeof list[i + 1].v === 'string')
        return { list: list[i + 1].v as string };

    return typeof c.v === 'string' ? { v: c.v } : {};
}

/** A coat of arms colour: a named colour (common/named_colors), another slot (`color3` in templates), a list pick, a colour block. */
function colorSeg(b: StoryBuilder, list: PNode[], i: number, src: string): Rich
{
    const c = list[i];

    if (Array.isArray(c.v))
        return colorText(c, src) ?? ['?'];

    const x = listed(list, i);

    if (x.list)
        return [note(`one of “${humanize(x.list)}”`, `list "${x.list}"`)];

    const slot = /^color(\d)$/.exec(x.v ?? '');

    if (slot)
        return [note(`colour ${slot[1]}`, x.v)];

    const e = x.v ? b.idx.get('named_colors', x.v) : undefined;
    return [e ? { text: humanize(x.v!), kind: 'entity', ref: { type: e.type, name: e.name }, tip: x.v } : { text: humanize(x.v ?? '?'), kind: 'value' }];
}

/** The colours of a block (`color1` … `color5`), each once: "red, white and blue". */
function colors(b: StoryBuilder, list: PNode[], src: string): Rich | undefined
{
    const parts: Rich[] = [];
    list.forEach((c, i) =>
    {
        const p = c.k && /^color\d$/.test(c.k) ? colorSeg(b, list, i, src) : undefined;

        if (p && !parts.some((x) => b.d.richString(x) === b.d.richString(p)))
            parts.push(p);
    });
    return parts.length ? join(parts) : undefined;
}

/** A picture of the coat of arms folders, or `list "name"`. */
function coaPicture(b: StoryBuilder, list: PNode[], key: string, type: string): Rich | undefined
{
    const i = list.findIndex((c) => c.k === key);

    if (i < 0)
        return undefined;

    const x = listed(list, i);

    if (x.list)
        return [note(`one of “${humanize(x.list)}”`, `list "${x.list}"`)];

    return x.v ? [pictureSeg(b, x.v, type, /^(pattern|ce|te)_/)] : undefined;
}

/** A coat of arms in words: pattern and its colours, each emblem with its colours and how often it is placed, sub-arms. */
function coaLines(b: StoryBuilder, list: PNode[], ctx: Ctx, type: string): Line[]
{
    const out: Line[] = [];
    const at = (n: PNode, l: Line): Line => (ctx.file ? { ...l, src: b.d.anchor(n, ctx, 'other', Array.isArray(n.v)) } : l);
    const pattern = coaPicture(b, list, 'pattern', type);
    const cols = colors(b, list, ctx.src);

    if (pattern || cols)
        out.push({ text: rich('Field: ', pattern ?? 'plain', cols ? rich(' in ', cols) : ''), icon: 'note' });

    const parent = str(list, 'parent');

    if (parent)
        out.push({ text: rich('Based on ', b.d.ref(parent, ['coat_of_arms/coat_of_arms'])) });

    for (const n of list)
    {
        if (!Array.isArray(n.v))
            continue;

        const inner = n.v;

        if (n.k === 'colored_emblem' || n.k === 'textured_emblem')
        {
            const times = inner.filter((c) => c.k === 'instance').length;
            const ecols = n.k === 'colored_emblem' ? colors(b, inner, ctx.src) : undefined;
            out.push(at(n, { text: rich('Emblem: ', coaPicture(b, inner, 'texture', type) ?? '?', ecols ? rich(' in ', ecols) : '', times > 1 ? ` ×${times}` : '', inner.some((c) => c.k === 'mask') ? ' (masked)' : ''), icon: 'note', tip: n.k }));
        }
        else if (n.k === 'sub')
        {
            // (another coat of arms drawn into a part of this one)
            const p = str(inner, 'parent');
            out.push(at(n, { text: rich('Part: ', p ? b.d.ref(p, ['coat_of_arms/coat_of_arms']) : 'its own'), children: coaLines(b, inner.filter((c) => c.k !== 'parent'), ctx, type), tip: 'sub' }));
        }
    }

    return out;
}

// ---------------------------------------------------------------------------
// Genes and DNA
// ---------------------------------------------------------------------------

/** A DNA's face and body genes (the others are the colours `*_color` and accessories: hairstyles, clothes …). */
const MORPH = /^(gene_|face_detail_|expression_|complexion)/;

/**
 * A DNA's `genes = { hair_color = { x y x y } gene_chin_forward = { "chin_forward_neg" 98 … } hairstyles = { … } }`:
 * the accessories it wears (dominant template, the recessive when it differs; the usual eyes, teeth and eyelashes
 * left out) and how many face genes it sets.
 */
function dnaLines(b: StoryBuilder, genes: PNode[], ctx: Ctx): { lines: Line[]; morphs: number; }
{
    const lines: Line[] = [];
    let morphs = 0;

    for (const g of genes)
    {
        if (!g.k || !Array.isArray(g.v))
            continue;

        if (MORPH.test(g.k))
            morphs++;

        if (MORPH.test(g.k) || /_color$/.test(g.k))
            continue;

        const [dom, , rec] = values(g);

        if (!dom || (/^(eye|teeth|eyelashes)_accessory$/.test(g.k) && /^normal_/.test(dom) && (!rec || rec === dom)))
            continue;

        const l: Line = { text: rich(b.d.ref(g.k, ['genes']), ': ', { text: words(dom), kind: 'value', tip: dom }, rec && rec !== dom ? rich(' ', note(`(recessive: ${words(rec).toLowerCase()})`)) : ''), tip: `${g.k} = { ${values(g).join(' ')} }` };

        if (ctx.file)
            l.src = b.d.anchor(g, ctx, 'other', false);

        lines.push(l);
    }

    return { lines, morphs };
}

const PEOPLE: Record<string, string> = { male: 'men', female: 'women', boy: 'boys', girl: 'girls' };

/**
 * A gene template's detail: the attributes a morph changes, or the accessories per sex (`boy = male`: boys use the
 * men's — said only when not the usual boys as men, girls as women).
 */
function templateDetail(t: PNode[]): string
{
    const attrs = new Set<string>();
    const sexes: string[] = [];

    for (const s of t)
    {
        if (!s.k || !PEOPLE[s.k])
            continue;

        if (typeof s.v === 'string')
        {
            if (!(s.k === 'boy' && s.v === 'male') && !(s.k === 'girl' && s.v === 'female'))
                sexes.push(`${PEOPLE[s.k]} as ${PEOPLE[s.v] ?? s.v}`);

            continue;
        }

        const acc = s.v.filter((x) => x.k && /^\d+$/.test(x.k)).length;

        if (acc)
            sexes.push(`${acc} for ${PEOPLE[s.k]}`);

        for (const x of s.v)
            if (x.k === 'setting')
            {
                for (const a of kids(x))
                    if (a.k === 'attribute' && typeof a.v === 'string')
                        attrs.add(humanize(a.v));
            }
    }

    return attrs.size ? `changes ${[...attrs].join(', ')}` : sexes.join(', ');
}

const SEX: Record<string, string> = { male: 'Man', female: 'Woman', boy: 'Boy', girl: 'Girl' };

export const LOOK_CARDS: Record<string, CardFn> = {
    // common/named_colors: `name = { r g b }` (0–1, or 0–255), `hsv { }`, `hsv360 { }` — coats of arms and cultures use them by name
    named_colors: (b, { node, card, ctx }) =>
    {
        if (typeof node.v === 'string')
        {
            card.facts.push(rich('Same as ', b.d.ref(node.v, ['named_colors'])));
            return true;
        }

        const t = colorText(node, ctx.src);
        card.facts.push(t ? rich('Colour ', t) : ['Not a colour']);
        card.facts.push([{ text: `${node.tag ?? (values(node).some((v) => Number(v) > 1) ? 'rgb 0–255' : 'rgb 0–1')}: ${values(node).join(' ')}`, kind: 'code', tip: 'As written' }]);
        return true;
    },
    // common/coat_of_arms/coat_of_arms: pattern + color1–5, colored_emblem / textured_emblem { texture color1–3 instance mask }, sub, parent
    'coat_of_arms/coat_of_arms': (b, { e, body, node, card, ctx, own }) =>
    {
        const of = b.idx.get('landed_titles', e.name) ?? b.idx.get('dynasties', e.name) ?? b.idx.get('dynasty_houses', e.name);
        let seg = of && (b.d.entitySeg(of) as Exclude<RichSeg, string>);

        if (of && seg)
        {
            // (dynasties and houses are named by their `name` loc key: dynasty 79 is "Thouars")
            const d = of.type === 'landed_titles' ? undefined : b.idx.defNode(of);
            const key = d && str(kids(d.node), 'name');
            const name = key && b.idx.plainLoc(key);

            if (name)
                seg = { ...seg, text: name };

            card.facts.push(rich(of.type === 'dynasties' ? 'Arms of the dynasty ' : of.type === 'dynasty_houses' ? 'Arms of the house ' : 'Arms of ', seg));
        }

        // (`79 = { # Thouars`)
        const label = lineComment(ctx.src, node);

        if (label && label !== seg?.text)
            card.facts.push([note(label)]);

        // `template = { name = { … } … }`: several arms (random templates, the designer's)
        const inner = body.filter((c) => c.k && Array.isArray(c.v) && kids(c).some((x) => x.k === 'pattern' || x.k === 'colored_emblem'));

        if (!str(body, 'pattern') && inner.length)
        {
            card.facts.push([`${inner.length} template${inner.length === 1 ? '' : 's'}`]);
            const lines = inner.map((t): Line => ({ text: [words(t.k!)], children: coaLines(b, kids(t), ctx, e.type), collapsed: true, src: b.d.anchor(t, ctx, 'other', true), tip: t.k! }));
            card.sections.push({ title: 'Templates', lines, src: own('other') });
            return true;
        }

        card.sections.push({ title: 'Coat of arms', lines: coaLines(b, body, ctx, e.type), src: own('other') });
        return true;
    },
    // common/coat_of_arms/dynamic_definitions: a title's `item = { trigger coat_of_arms }`, the first that fits (root: the title)
    'coat_of_arms/dynamic_definitions': (b, { e, body, card, ctx, own }) =>
    {
        const t = b.idx.get('landed_titles', e.name);

        if (t)
            card.facts.push(rich('Arms of ', b.d.entitySeg(t)));

        const items = body.filter((c) => c.k === 'item' && Array.isArray(c.v));
        const lines = firstValidLines(b, items, { ...ctx, scopeType: 'landed_title', scope: 'the title' }, (list) =>
        {
            const coa = str(list, 'coat_of_arms');
            return { text: [coa ? b.d.ref(coa, ['coat_of_arms/coat_of_arms']) : '(none set)'] };
        });
        card.sections.push({ title: 'Coat of arms — the first that fits, else its own', lines, src: own('other') });
        return true;
    },
    // common/coat_of_arms/template_lists: weighted picks (`10 = "red"`), `special_selection = { trigger … }` for some
    'coat_of_arms/template_lists': (b, { e, body, card, ctx, own }) =>
    {
        const picks = (list: PNode[]): Rich =>
        {
            const w = list.filter((c) => c.k && /^\d+$/.test(c.k) && typeof c.v === 'string');
            const shown = w.slice(0, 12).map((c): Rich => rich({ text: words(c.v as string, /^(pattern|ce|te)_/).toLowerCase(), kind: 'value', tip: c.v as string }, ` ${c.k}`));
            return rich(join(shown, ', '), w.length > 12 ? ` … ${w.length - 12} more` : '');
        };
        const lines = body
            .filter((c) => c.k && Array.isArray(c.v))
            .map((l): Line =>
            {
                const specials = kids(l).filter((c) => c.k === 'special_selection' && Array.isArray(c.v));
                const children = firstValidLines(b, specials, ctx, (list) => ({ text: rich('Instead: ', picks(list)) }));
                return { text: rich(capitalize(humanize(l.k!)), ': ', picks(kids(l))), children, collapsed: children.length > 0, src: b.d.anchor(l, ctx, 'other', true), tip: 'weight = pick' };
            });
        card.facts.push([`${lines.length} lists`]);
        card.sections.push({ title: 'Lists (pick and weight)', lines, src: own('other') });
        return true;
    },
    // common/coat_of_arms/options: `atlas = { tile_size nr_of_tiles actual_size fallback }` (the last one written counts here)
    'coat_of_arms/options': (b, { body, card, ctx, own }) =>
    {
        const pair = (n: PNode | undefined): string => values(n).join(' × ');
        const tile = body.find((c) => c.k === 'tile_size');
        const n = str(body, 'nr_of_tiles');
        card.facts.push([`${n ?? '?'} tiles of ${pair(tile)} pixels`]);
        const lines = body
            .filter((c) => c.k === 'actual_size' || c.k === 'fallback')
            .map((c): Line => ({ text: rich(c.k === 'fallback' ? 'Fallback sizes: ' : 'Sizes drawn: ', kids(c).map(pair).join(', ')), src: b.d.anchor(c, ctx, 'other', false) }));
        card.sections.push({ title: 'Atlas', lines, src: own('other') });
        return true;
    },
    // common/genes: colour genes (color, blend_range), age presets (mode, curve), morph and accessory genes (templates by index)
    genes: (b, { e, body, node, card, ctx, own }) =>
    {
        const color = str(body, 'color');
        const lines: Line[] = [];

        if (color)
        {
            card.facts.push([`Colour gene: ${color}`]);
            const [lo, hi] = values(body.find((c) => c.k === 'blend_range')).map(Number);

            if (lo !== undefined)
                lines.push({ text: [!lo && !hi ? 'Children get the dominant parent’s colour' : `Children get a colour ${Math.round(lo * 100)}–${Math.round(hi * 100)}% of the way from the dominant to the other parent’s`], tip: 'blend_range' });

            const sync = str(body, 'sync_inheritance_with');

            if (sync)
                lines.push({ text: rich('Inherited together with ', b.d.ref(sync, ['genes'])) });
        }
        else if (body.some((c) => c.k === 'curve'))
        {
            const mode = str(body, 'mode');
            card.facts.push([`Age curve: ${mode === 'add' ? 'adds to' : 'multiplies'} the gene`]);
            const pts = kids(body.find((c) => c.k === 'curve')).map((p) => values(p).map(Number));
            lines.push({ text: rich('By age: ', join(pts.map(([x, y]) => rich(`${Math.round(x * 100)} → `, { text: formatNumber(y), kind: 'value' })), ', ')), tip: 'curve: { age/100 value }' });
        }
        else
        {
            const templates = body.filter((c) => c.k && Array.isArray(c.v) && kids(c).some((x) => x.k === 'index'));
            const group = str(body, 'group');
            card.facts.push([`${templates.length} template${templates.length === 1 ? '' : 's'}${group ? ` · ${group}` : ''}`]);
            // (`pose = { # Keeping this gene because the game expects it to be there`)
            const why = lineComment(ctx.src, node);

            if (why)
                card.facts.push([note(why)]);

            if (str(body, 'inheritable') === 'no')
                card.facts.push(['Not inherited']);

            const ugly = values(body.find((c) => c.k === 'ugliness_feature_categories'));

            if (ugly.length)
                card.facts.push([`Ugliness shows on the ${ugly.map(humanize).join(', ')}`]);

            for (const t of templates.slice(0, 60))
            {
                const d = templateDetail(kids(t));
                const l: Line = { text: rich(words(t.k!), str(kids(t), 'visible') === 'no' ? rich(' ', note('(hidden)')) : '', d ? rich(' ', note(`— ${d}`)) : ''), tip: `${t.k} (index ${str(kids(t), 'index')})` };

                if (ctx.file)
                    l.src = b.d.anchor(t, ctx, 'other', true);

                lines.push(l);
            }

            if (templates.length > 60)
                lines.push({ text: [`… and ${templates.length - 60} more`] });
        }

        if (lines.length)
            card.sections.push({ title: color || body.some((c) => c.k === 'curve') ? 'How it works' : 'Templates', lines, src: own('other') });

        return true;
    },
    // common/dna_data: `dna = "<string>"` or `portrait_info = { genes = { … } }`; history characters use it by `dna = key`
    dna_data: (b, { body, node, card, ctx }) =>
    {
        const label = lineComment(ctx.src, node);

        if (label)
            card.facts.push([note(label)]);

        if (str(body, 'enabled') === 'no')
            card.facts.push(['Switched off']);

        if (str(body, 'dna'))
            card.facts.push(['Written as a DNA string']);

        const genes = kids(kids(body.find((c) => c.k === 'portrait_info')).find((c) => c.k === 'genes'));
        const { lines, morphs } = dnaLines(b, genes, ctx);

        if (genes.length)
            card.facts.push([`${morphs} face and body genes`]);

        if (lines.length)
            card.sections.push({ title: 'Wears', lines });

        return true;
    },
    // common/bookmark_portraits: dumped by `dump_bookmark_portraits` (comment "History database id:<id>"): type, age (/100), genes
    bookmark_portraits: (b, { e, body, card, ctx }) =>
    {
        const id = /History database id:\s*(\d+)/.exec(b.idx.winningDef(e)?.doc ?? '')?.[1];

        if (id)
            card.facts.push(rich('Portrait of ', b.d.ref(id, ['characters'])));

        const type = str(body, 'type');
        const age = Number(str(body, 'age'));
        card.facts.push([[type ? (SEX[type] ?? capitalize(type)) : '', Number.isFinite(age) ? `age ${Math.round(age * 100)}` : ''].filter(Boolean).join(', ')]);
        const { lines, morphs } = dnaLines(b, kids(body.find((c) => c.k === 'genes')), ctx);
        card.facts.push([`${morphs} face and body genes`]);

        if (lines.length)
            card.sections.push({ title: 'Wears', lines });

        return true;
    },
    // common/portrait_types: palettes, male / female / boy / girl { sex minimum_age maximum_age head torso }, attach
    portrait_types: (b, { e, body, card, ctx, own }) =>
    {
        const lines: Line[] = [];

        for (const k of ['colors', 'properties'])
        {
            const n = body.find((c) => c.k === k);
            const pics = kids(n)
                .filter((c) => c.k && typeof c.v === 'string')
                .map((c) => rich(`${c.k} `, pictureSeg(b, c.v as string, e.type)));

            if (pics.length)
                lines.push({ text: rich(k === 'colors' ? 'Colour palettes: ' : 'Material palettes: ', join(pics)), src: n && b.d.anchor(n, ctx, 'other', true) });
        }

        for (const [k, label] of Object.entries(SEX))
        {
            const n = body.find((c) => c.k === k && Array.isArray(c.v));

            if (!n)
                continue;

            const l = kids(n);
            const min = str(l, 'minimum_age');
            const max = str(l, 'maximum_age');
            const code = (v: string | undefined): RichSeg => ({ text: v ? words(v) : '?', kind: 'code', tip: v });
            lines.push({ text: rich(`${label}${min ? ` (${min} and older)` : max ? ` (under ${max})` : ''}: head `, code(str(l, 'head')), ', body ', code(str(l, 'torso'))), src: b.d.anchor(n, ctx, 'other', true) });
        }

        const attach = body.find((c) => c.k === 'attach');

        if (attach)
        {
            const joints = kids(attach)
                .filter((c) => c.k === 'joint_attachment')
                .map((j) => `${str(kids(j), 'child_joint')} → ${str(kids(j), 'parent_joint')}`);
            lines.push({ text: rich(`The ${str(kids(attach), 'what') ?? '?'} is attached to the ${str(kids(attach), 'where') ?? '?'}: `, { text: joints.join(', '), kind: 'code' }), src: b.d.anchor(attach, ctx, 'other', true) });
        }

        card.sections.push({ title: 'Portrait', lines, src: own('other') });
        return true;
    },
    // common/modifier_icons: `positive` (also for 0, and without `negative`), `negative`; `default = yes`: the fallback icon
    modifier_icons: (b, { e, body, card, ctx, own }) =>
    {
        if (str(body, 'default') === 'yes')
            card.facts.push(['The default icon']);

        const lines: Line[] = [];

        for (const c of body)
        {
            if ((c.k !== 'positive' && c.k !== 'negative') || typeof c.v !== 'string')
                continue;

            lines.push({ text: rich(c.k === 'positive' ? 'For positive values: ' : 'For negative values: ', pictureSeg(b, c.v, e.type)), src: b.d.anchor(c, ctx, 'other', false), tip: `${c.k} = ${c.v}` });
        }

        card.sections.push({ title: 'Icons', lines, src: own('other') });
        return true;
    }
};
