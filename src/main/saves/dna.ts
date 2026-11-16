/**
 * A save character's DNA (docs/saves.md, "Portraits"): `dna = "<base64>"`, 4 bytes per gene: the first pair's template
 * (its `index` in common/genes) and value, the second pair's; a colour gene: the two palette points (x y x y). The genes
 * come in the order of the save's own `meta_data.meta_main_portrait.genes` (checked on the owner's AGOT save: its first
 * 177 genes match the DNA's 708 bytes; the genes after them (clothes, hairstyles …) are the portrait modifiers').
 */
import type { DnaGene } from '../../shared/api.ts';
import { tr } from '../../shared/i18n.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { entries, type Entry, type Gamestate } from './gamestate.ts';

export interface GeneCatalog
{
    /** the genes in the DNA's order */
    order: string[];
    /** colour genes */
    color: Set<string>;
    /** per gene: its templates by `index` */
    templates: Map<string, string[]>;
}

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);

/**
 * The DNA's gene order (the save's own portrait in its metadata: the gamestate's `meta_data`, or the metadata before it:
 * an uncompressed save, as rakaly writes one, doesn't repeat it in the gamestate) and the templates of the loaded files.
 */
export function geneCatalog(idx: GameIndex, g: Gamestate, metaBytes?: Buffer): GeneCatalog
{
    const order: string[] = [];
    const sources: { buf: Buffer; meta: Entry | undefined; }[] = [{ buf: g.buf, meta: g.section('meta_data') }];

    if (metaBytes?.length)
        sources.push({ buf: metaBytes, meta: [...entries(metaBytes, 0)].find((e) => e.key === 'meta_data') });

    const sub = (buf: Buffer, e: Entry | undefined, key: string): Entry | undefined => (e?.block ? [...entries(buf, e.vs, e.ve)].find((x) => x.key === key) : undefined);

    for (const { buf, meta } of sources)
    {
        for (const k of ['meta_main_portrait', 'meta_heir_portrait'])
        {
            const genes = sub(buf, sub(buf, meta, k), 'genes');

            if (genes?.block)
            {
                for (const x of entries(buf, genes.vs, genes.ve))
                    if (x.key)
                        order.push(x.key);

                break;
            }
        }

        if (order.length)
            break;
    }

    const color = new Set<string>();
    const templates = new Map<string, string[]>();

    for (const gene of idx.names('genes'))
    {
        const e = idx.get('genes', gene);
        const body = kids(e && idx.defNode(e)?.node);

        if (body.some((c) => c.k === 'color'))
            color.add(gene);

        const list: string[] = [];

        for (const c of body)
        {
            const i = kids(c).find((x) => x.k === 'index');

            if (c.k && i && typeof i.v === 'string')
                list[Number(i.v)] = c.k;
        }

        templates.set(gene, list);
    }

    return { order, color, templates };
}

/** The genes of a save DNA. */
export function decodeDna(b64: string, cat: GeneCatalog): DnaGene[]
{
    const b = Buffer.from(b64, 'base64');
    const out: DnaGene[] = [];

    for (let i = 0; i < cat.order.length && i * 4 + 3 < b.length; i++)
    {
        const gene = cat.order[i];
        const [t, v, t2, v2] = b.subarray(i * 4, i * 4 + 4);

        if (cat.color.has(gene))
            out.push({ gene, value: 0, xy: [t, v], xy2: [t2, v2] });
        else
        {
            const names = cat.templates.get(gene) ?? [];

            if (names[t])
                out.push({ gene, template: names[t], value: v, template2: names[t2] ?? names[t], value2: v2 });
        }
    }

    return out;
}

/** A save DNA with these genes changed (the rest as it was). Throws for a template the gene doesn't have. */
export function encodeDna(base: string, genes: DnaGene[], cat: GeneCatalog): string
{
    const b = Buffer.from(base, 'base64');
    const at = new Map(cat.order.map((g, i) => [g, i]));

    for (const x of genes)
    {
        const i = at.get(x.gene);

        if (i === undefined || i * 4 + 3 >= b.length)
            continue;

        const byte = (n: number | undefined): number => Math.max(0, Math.min(255, Math.round(n ?? 0)));

        if (x.xy)
        {
            b[i * 4] = byte(x.xy[0]);
            b[i * 4 + 1] = byte(x.xy[1]);
            b[i * 4 + 2] = byte((x.xy2 ?? x.xy)[0]);
            b[i * 4 + 3] = byte((x.xy2 ?? x.xy)[1]);
            continue;
        }

        const names = cat.templates.get(x.gene) ?? [];
        const t = x.template ? names.indexOf(x.template) : b[i * 4];
        const t2 = x.template2 ? names.indexOf(x.template2) : b[i * 4 + 2];

        if (t < 0 || t2 < 0)
            throw new Error(tr('{gene} has no template {template}', { gene: x.gene, template: (t < 0 ? x.template : x.template2) ?? '' }));

        b[i * 4] = t;
        b[i * 4 + 1] = byte(x.value);
        b[i * 4 + 2] = t2;
        b[i * 4 + 3] = byte(x.value2 ?? x.value);
    }

    return b.toString('base64');
}

/** Genes as the script's `genes = { … }` nodes (what the portrait reads). */
export function genesNodes(genes: DnaGene[]): PNode[]
{
    const line = (x: DnaGene): string => (x.xy ? `${x.gene} = { ${x.xy[0]} ${x.xy[1]} ${(x.xy2 ?? x.xy)[0]} ${(x.xy2 ?? x.xy)[1]} }` : `${x.gene} = { "${x.template}" ${x.value} "${x.template2 ?? x.template}" ${x.value2 ?? x.value} }`);
    return kids(parse(`genes = { ${genes.map(line).join(' ')} }`)[0]);
}
