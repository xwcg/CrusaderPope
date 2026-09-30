import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FamilyAncestor, FamilyDescendant, FamilyPerson, FamilyTree } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { useRevision } from '../revision';

const W = 140; // node width
const H = 58; // node height
const HG = 14; // horizontal gap
const VG = 38; // vertical gap between generations
const MAX_GRANDCHILDREN = 4;

interface Placed
{
    p: FamilyPerson;
    x: number; // centre
    y: number; // top
    kind: 'root' | 'ancestor' | 'spouse' | 'child' | 'grandchild' | 'more';
    note?: string;
}

const year = (d?: string): string => (d ? d.split('.')[0] : '?');

/** Lays out ancestors (pedigree above), spouses (beside) and descendants (below) around the character at x = 0. */
function layout(tree: FamilyTree): { nodes: Placed[]; lines: string[]; minX: number; maxX: number; minY: number; maxY: number; }
{
    const nodes: Placed[] = [];
    const lines: string[] = [];
    const slot = W + HG;
    // ancestors: a compact pedigree — each couple takes only the width its known forebears need (fixed 2^k slots per
    // generation left sparse lines as wide staircases, mostly outside the view); a single known parent sits straight above
    const depthOf = (a: FamilyAncestor | undefined, d: number): number => (a ? Math.max(d, depthOf(a.father, d + 1), depthOf(a.mother, d + 1)) : d - 1);
    const D = Math.max(0, depthOf(tree.root, 0));
    const rootY = D * (H + VG);
    const parentsOf = (a: FamilyAncestor): FamilyAncestor[] => [a.father, a.mother].filter((p): p is FamilyAncestor => !!p);
    const ancestorWidth = (a: FamilyAncestor): number =>
    {
        const ps = parentsOf(a);
        return Math.max(W, ps.reduce((s, p) => s + ancestorWidth(p), 0) + (ps.length - 1) * HG);
    };
    const placeAncestors = (a: FamilyAncestor, k: number, x: number): void =>
    {
        const y = rootY - k * (H + VG);

        if (k > 0)
            nodes.push({ p: a, x, y, kind: 'ancestor' });

        const ps = parentsOf(a);

        if (!ps.length)
            return;

        const widths = ps.map(ancestorWidth);
        let cursor = x - (widths.reduce((s, w) => s + w, 0) + (ps.length - 1) * HG) / 2;
        const xs = widths.map((w) =>
        {
            const px = cursor + w / 2;
            cursor += w + HG;
            return px;
        });
        // bar between the parents, stem down to the child
        const barY = y - VG / 2;
        lines.push(`M${x},${y} V${barY}`);

        if (xs.length === 2)
            lines.push(`M${xs[0]},${barY} H${xs[1]}`);

        ps.forEach((p, i) =>
        {
            lines.push(`M${xs[i]},${barY} V${y - VG}`);
            placeAncestors(p, k + 1, xs[i]);
        });
    };
    placeAncestors(tree.root, 0, 0);
    nodes.push({ p: tree.root, x: 0, y: rootY, kind: 'root' });

    // spouses to the right of the character
    tree.spouses.forEach((s, i) =>
    {
        const x = (i + 1) * slot;
        nodes.push({ p: s, x, y: rootY, kind: 'spouse', note: 'spouse' });
        lines.push(`M${x - slot + W / 2},${rootY + H / 2} H${x - W / 2}`);
    });

    // descendants: subtree widths, children centred under the character
    const kidsOf = (c: FamilyDescendant): FamilyDescendant[] => c.children.slice(0, MAX_GRANDCHILDREN);
    const widthOf = (c: FamilyDescendant, depth: number): number =>
    {
        const kids = depth < 2 ? kidsOf(c) : [];
        const more = depth < 2 && c.children.length > MAX_GRANDCHILDREN ? 1 : 0;
        const inner = kids.reduce((s, k) => s + widthOf(k, depth + 1), 0) + more * W + (kids.length + more - 1) * HG;
        return Math.max(W, kids.length + more ? inner : W);
    };
    const placeKids = (kids: FamilyDescendant[], extra: number, parentX: number, parentBottom: number, depth: number): void =>
    {
        if (!kids.length && !extra)
            return;

        const widths = kids.map((k) => widthOf(k, depth));
        const total = widths.reduce((s, w) => s + w, 0) + extra * W + (kids.length + extra - 1) * HG;
        const y = parentBottom + VG;
        const barY = parentBottom + VG / 2;
        let cursor = parentX - total / 2;
        const xs: number[] = [];
        kids.forEach((k, i) =>
        {
            const x = cursor + widths[i] / 2;
            xs.push(x);
            nodes.push({ p: k, x, y, kind: depth === 1 ? 'child' : 'grandchild', note: depth === 1 && k.otherParent && tree.spouses.length !== 1 ? `with ${k.otherParent.name}` : undefined });

            // grandchildren (more than MAX_GRANDCHILDREN end in a "…" node)
            if (depth < 2)
                placeKids(kidsOf(k), k.children.length > MAX_GRANDCHILDREN ? 1 : 0, x, y + H, depth + 1);

            cursor += widths[i] + HG;
        });

        if (extra)
        {
            const x = cursor + W / 2;
            xs.push(x);
            nodes.push({ p: { id: '', name: '…', female: false }, x, y, kind: 'more', note: 'more' });
        }

        lines.push(`M${parentX},${parentBottom} V${barY}`);

        if (xs.length > 1)
            lines.push(`M${xs[0]},${barY} H${xs[xs.length - 1]}`);
        else
            lines.push(`M${parentX},${barY} H${xs[0]}`);

        for (const x of xs)
            lines.push(`M${x},${barY} V${y}`);
    };
    placeKids(tree.children, 0, 0, rootY + H, 1);

    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const n of nodes)
    {
        minX = Math.min(minX, n.x - W / 2);
        maxX = Math.max(maxX, n.x + W / 2);
        maxY = Math.max(maxY, n.y + H);
    }

    return { nodes, lines, minX, maxX, minY: 0, maxY };
}

export function FamilyTreeView(props: { id: string; navigate: Navigate; }): React.JSX.Element | null
{
    const [tree, setTree] = useState<FamilyTree | null | undefined>(undefined);
    const scroller = useRef<HTMLDivElement>(null);

    // again after an index update (the tree stays — and keeps its scroll — when it is the same)
    const revision = useRevision();
    useEffect(() => setTree(undefined), [props.id]);
    useEffect(() =>
    {
        let cancelled = false;
        void api.familyTree(props.id).then((t) => !cancelled && setTree((old) => (old && t && JSON.stringify(old) === JSON.stringify(t) ? old : t)));
        return () =>
        {
            cancelled = true;
        };
    }, [props.id, revision]);

    const lay = useMemo(() => (tree ? layout(tree) : null), [tree]);

    // start centred on the character
    useLayoutEffect(() =>
    {
        const el = scroller.current;

        if (el && lay)
            el.scrollLeft = -lay.minX + W / 2 - el.clientWidth / 2 + 16;
    }, [lay]);

    if (tree === undefined)
        return <div className="family-tree loading">Tracing the bloodline…</div>;

    if (!tree || !lay)
        return null;

    const alone = !tree.root.father && !tree.root.mother && !tree.spouses.length && !tree.children.length && !tree.siblings.length;

    if (alone)
        return null;

    const pad = 16;
    const width = lay.maxX - lay.minX + pad * 2;
    const height = lay.maxY - lay.minY + pad * 2;
    const ox = -lay.minX + pad;
    const oy = pad;

    const node = (n: Placed, i: number): React.JSX.Element =>
    {
        const clickable = n.kind !== 'root' && n.kind !== 'more' && n.p.id;
        const style = { left: ox + n.x - W / 2, top: oy + n.y, width: W, height: H };

        if (n.kind === 'more')
        {
            return (
                <div key={i} className="ft-node more" style={style}>
                    …
                </div>
            );
        }

        return (
            <div
                key={i}
                className={`ft-node ${n.p.female ? 'f' : 'm'} ${n.kind}` + (clickable ? ' link' : '')}
                style={style}
                data-ref-type={clickable ? 'characters' : undefined}
                data-ref-name={clickable ? n.p.id : undefined}
                onClick={clickable ? () => props.navigate({ type: 'characters', name: n.p.id }) : undefined}
            >
                <div className="ft-name">{n.p.name}</div>
                <div className="ft-house">{n.p.house ?? ' '}</div>
                <div className="ft-meta">
                    <span>
                        {year(n.p.birth)}–{n.p.death ? year(n.p.death) : ''}
                    </span>
                    {n.p.title && <span className="ft-title">{n.p.title}</span>}
                    {n.note && <span className="ft-note">{n.note}</span>}
                </div>
            </div>
        );
    };

    return (
        <div className="family-tree">
            <div className="family-title">Family</div>
            <div className="ft-scroll" ref={scroller}>
                <div className="ft-canvas" style={{ width, height }}>
                    <svg className="ft-lines" width={width} height={height}>
                        <g transform={`translate(${ox},${oy})`}>
                            {lay.lines.map((d, i) => <path key={i} d={d} />)}
                        </g>
                    </svg>
                    {lay.nodes.map(node)}
                </div>
            </div>
            {tree.siblings.length > 0 && (
                <div className="ft-siblings">
                    <span className="ft-sib-label">Siblings</span>
                    {tree.siblings.map((s) => (
                        <span
                            key={s.id}
                            className={'ft-sib rt-link ' + (s.female ? 'f' : 'm')}
                            data-ref-type="characters"
                            data-ref-name={s.id}
                            onClick={() => props.navigate({ type: 'characters', name: s.id })}
                        >
                            {s.name}
                            <span className="ft-sib-meta">
                                {' '}
                                {year(s.birth)}–{s.death ? year(s.death) : ''}
                                {s.half ? ' · half' : ''}
                            </span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
