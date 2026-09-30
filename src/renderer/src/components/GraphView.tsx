import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { GraphData, GraphNode } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { typeColor } from '../typeColors';
import { TypeChip } from './common';
import { useRevision } from '../revision';

type Layout = 'flow' | 'concentric' | 'breadthfirst' | 'cose';

/** Types that make up "event flow": what fires what. */
const FLOW_TYPES = [
    'events',
    'on_action',
    'scripted_effects',
    'decisions',
    'character_interactions',
    'story_cycles',
    'activities/activity_types',
    'schemes/scheme_types',
    'activities/pulse_actions',
    'situation/situations'
];

export function GraphView(props: { type: string; name: string; navigate: Navigate; }): React.JSX.Element
{
    const [depth, setDepth] = useState(1);
    const [hideLoc, setHideLoc] = useState(true);
    const [hideImplicit, setHideImplicit] = useState(false);
    const [flowOnly, setFlowOnly] = useState(false);
    const [layout, setLayout] = useState<Layout>('flow');
    const [data, setData] = useState<GraphData | null>(null);
    const [selected, setSelected] = useState<GraphNode | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const navigateRef = useRef(props.navigate);
    navigateRef.current = props.navigate;

    // (an index update: the same graph again — laid out anew only when it changed)
    const revision = useRevision();
    const shown = useRef('');
    useEffect(() =>
    {
        let cancelled = false;
        const exclude = [...(hideLoc ? ['localization'] : []), ...(hideImplicit ? ['flag', 'variable'] : [])];
        void api
            .graph(props.type, props.name, { depth, excludeTypes: exclude, onlyTypes: flowOnly ? FLOW_TYPES : null, maxNodes: depth > 1 ? 220 : 160 })
            .then((d) =>
            {
                if (cancelled)
                    return;

                const key = JSON.stringify(d);

                if (key === shown.current)
                    return;

                shown.current = key;
                setData(d);
                setSelected(null);
            });
        return () =>
        {
            cancelled = true;
        };
    }, [props.type, props.name, depth, hideLoc, hideImplicit, flowOnly, revision]);

    useEffect(() =>
    {
        if (!data || !containerRef.current)
            return;

        const flow = layout === 'flow' ? flowPositions(data) : null;
        const cy = cytoscape({
            container: containerRef.current,
            wheelSensitivity: 0.3,
            minZoom: 0.1,
            maxZoom: 3,
            elements: [
                ...data.nodes.map((n) => ({
                    data: {
                        id: n.id,
                        label: n.name.length > 34 ? n.name.slice(0, 32) + '…' : n.name,
                        color: typeColor(n.type),
                        distance: n.distance,
                        center: n.distance === 0 ? 1 : 0,
                        halign: flow ? flow.halign[n.id] : 'center',
                        valign: flow && n.distance > 0 ? 'center' : 'bottom',
                        node: n
                    },
                    position: flow?.pos[n.id]
                })),
                ...data.edges.map((e, i) => ({ data: { id: 'e' + i, source: e.source, target: e.target, ctx: e.ctx + (e.count > 1 ? ` ×${e.count}` : '') } }))
            ],
            style: [
                {
                    selector: 'node',
                    style: {
                        'background-color': 'data(color)',
                        label: 'data(label)',
                        color: '#d8d3c5',
                        'font-size': 10,
                        'font-family': 'Cascadia Code, Consolas, monospace',
                        'text-valign': 'data(valign)' as 'bottom',
                        'text-halign': 'data(halign)' as 'center',
                        'text-margin-y': (n: cytoscape.NodeSingular) => (n.data('valign') === 'bottom' ? 4 : 0),
                        'text-margin-x': (n: cytoscape.NodeSingular) => (n.data('halign') === 'left' ? -6 : n.data('halign') === 'right' ? 6 : 0),
                        width: 14,
                        height: 14,
                        'text-outline-color': '#131418',
                        'text-outline-width': 2
                    }
                },
                {
                    selector: 'node[center = 1]',
                    style: { width: 28, height: 28, 'border-width': 3, 'border-color': '#c9a45c', 'font-size': 13, color: '#f0dfb4' }
                },
                {
                    selector: 'edge',
                    style: {
                        width: 1.2,
                        'line-color': '#3a3e4a',
                        'target-arrow-color': '#4a4f5c',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'arrow-scale': 0.8
                    }
                },
                {
                    selector: 'edge.hl',
                    style: {
                        'line-color': '#c9a45c',
                        'target-arrow-color': '#c9a45c',
                        width: 2,
                        label: 'data(ctx)',
                        'font-size': 9,
                        color: '#e0c890',
                        'text-rotation': 'autorotate',
                        'text-outline-color': '#131418',
                        'text-outline-width': 2
                    }
                },
                { selector: 'node:selected', style: { 'border-width': 2, 'border-color': '#ffffff' } },
                { selector: '.faded', style: { opacity: 0.18 } }
            ],
            layout: flow
                ? { name: 'preset' }
                : layout === 'concentric'
                ? {
                    name: 'concentric',
                    concentric: (n: cytoscape.NodeSingular) => 10 - (n.data('distance') as number),
                    levelWidth: () => 1,
                    minNodeSpacing: 34,
                    animate: false
                }
                : layout === 'breadthfirst'
                ? { name: 'breadthfirst', directed: false, roots: data.nodes.filter((n) => n.distance === 0).map((n) => '#' + n.id), spacingFactor: 1.15, animate: false }
                : { name: 'cose', animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, numIter: 1500 }
        });

        // small graphs would otherwise be zoomed in until labels are huge
        cy.fit(undefined, 40);

        if (cy.zoom() > 1.1)
        {
            cy.zoom(1.1);
            cy.center();
        }

        const clearHl = (): void =>
        {
            cy.elements().removeClass('faded hl');
        };
        cy.on('tap', 'node', (e) =>
        {
            const n = e.target as cytoscape.NodeSingular;
            clearHl();
            const hood = n.closedNeighborhood();
            cy.elements()
                .not(hood)
                .addClass('faded');
            n.connectedEdges().addClass('hl');
            setSelected(n.data('node') as GraphNode);
        });
        cy.on('dbltap', 'node', (e) =>
        {
            const n = (e.target as cytoscape.NodeSingular).data('node') as GraphNode;
            navigateRef.current({ type: n.type, name: n.name });
        });
        cy.on('tap', (e) =>
        {
            if (e.target === cy)
            {
                clearHl();
                setSelected(null);
            }
        });
        cy.on('mouseover', 'edge', (e) => (e.target as cytoscape.EdgeSingular).addClass('hl'));
        cy.on('mouseout', 'edge', (e) =>
        {
            const edge = e.target as cytoscape.EdgeSingular;

            if (edge.connectedNodes(':selected').length === 0)
                edge.removeClass('hl');
        });
        return () => cy.destroy();
    }, [data, layout]);

    const legend = useMemo(() =>
    {
        const m = new Map<string, number>();

        for (const n of data?.nodes ?? [])
            m.set(n.type, (m.get(n.type) ?? 0) + 1);

        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    }, [data]);

    return (
        <>
            <div className="graph-toolbar">
                <label>
                    Depth
                    <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                    </select>
                </label>
                <label>
                    Layout
                    <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
                        <option value="flow">Flow (in → out)</option>
                        <option value="concentric">Radial</option>
                        <option value="breadthfirst">Tree</option>
                        <option value="cose">Force</option>
                    </select>
                </label>
                <span className="sep" />
                <label>
                    <input type="checkbox" checked={flowOnly} onChange={(e) => setFlowOnly(e.target.checked)} />
                    Event flow only
                </label>
                <label>
                    <input type="checkbox" checked={hideLoc} onChange={(e) => setHideLoc(e.target.checked)} />
                    Hide localization
                </label>
                <label>
                    <input type="checkbox" checked={hideImplicit} onChange={(e) => setHideImplicit(e.target.checked)} />
                    Hide flags/variables
                </label>
                <span className="info">
                    {data ? `${data.nodes.length} nodes · ${data.edges.length} edges${data.truncated ? ' (truncated)' : ''}` : 'Loading…'} · click to highlight, double-click to open
                </span>
            </div>
            <div className="graph-wrap">
                <div className="graph-canvas" ref={containerRef} />
                {legend.length > 0 && (
                    <div className="graph-legend">
                        {legend.map(([t, n]) => <TypeChip key={t} type={t} label={`${t} (${n})`} />)}
                    </div>
                )}
                {selected && (
                    <div className="graph-selected">
                        <TypeChip type={selected.type} label={selected.type} />
                        <div className="n">{selected.name}</div>
                        {selected.display && <div className="d">{selected.display}</div>}
                        <button onClick={() => props.navigate({ type: selected.type, name: selected.name })}>Open</button>
                    </div>
                )}
            </div>
        </>
    );
}

/**
 * "Flow" layout: incoming references in columns to the left of the center node, outgoing to the right,
 * one column per BFS distance, nodes grouped by type. Tall columns wrap into sub-columns.
 */
function flowPositions(data: GraphData): { pos: Record<string, { x: number; y: number; }>; halign: Record<string, string>; }
{
    const COL_W = 420;
    const SUB_W = 300;
    const ROW_H = 26;
    const MAX_ROWS = 30;
    const center = data.nodes.find((n) => n.distance === 0);
    const pos: Record<string, { x: number; y: number; }> = {};
    const halign: Record<string, string> = {};

    if (!center)
        return { pos, halign };

    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const side = new Map<string, number>([[center.id, 0]]);
    const maxDist = Math.max(...data.nodes.map((n) => n.distance));
    // A node inherits the side of the node it was reached from; for direct neighbours of the center
    // the edge direction decides (center → n: right, n → center: left). Outgoing wins when both apply.
    const assign = (id: string, s: number): void =>
    {
        if (!side.has(id) || s === 1)
            side.set(id, s);
    };

    for (let d = 1; d <= maxDist; d++)
    {
        for (const e of data.edges)
        {
            const src = byId.get(e.source);
            const tgt = byId.get(e.target);

            if (!src || !tgt)
                continue;

            if (src.distance === d - 1 && tgt.distance === d)
                assign(tgt.id, src.distance === 0 ? 1 : (side.get(src.id) ?? 1));

            if (tgt.distance === d - 1 && src.distance === d)
                assign(src.id, tgt.distance === 0 ? -1 : (side.get(tgt.id) ?? -1));
        }
    }

    const columns = new Map<string, typeof data.nodes>();

    for (const n of data.nodes)
    {
        if (n.distance === 0)
            continue;

        const s = side.get(n.id) ?? 1;
        const key = s + ':' + n.distance;
        const col = columns.get(key) ?? [];
        col.push(n);
        columns.set(key, col);
    }

    pos[center.id] = { x: 0, y: 0 };
    halign[center.id] = 'center';

    for (const [key, col] of columns)
    {
        const [s, d] = key.split(':').map(Number);
        col.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
        const subCols = Math.ceil(col.length / MAX_ROWS);
        const rows = Math.ceil(col.length / subCols);
        col.forEach((n, i) =>
        {
            const sub = Math.floor(i / rows);
            const row = i % rows;
            pos[n.id] = { x: s * (d * COL_W + sub * SUB_W), y: (row - (rows - 1) / 2) * ROW_H };
            halign[n.id] = s < 0 ? 'left' : 'right';
        });
    }

    // push deeper columns beyond the sub-columns of shallower ones
    for (const s of [-1, 1])
    {
        let offset = 0;

        for (let d = 1; d <= maxDist; d++)
        {
            const col = columns.get(s + ':' + d);

            if (!col)
                continue;

            for (const n of col)
                pos[n.id].x += s * offset;

            offset += (Math.ceil(col.length / MAX_ROWS) - 1) * SUB_W;
        }
    }

    return { pos, halign };
}
