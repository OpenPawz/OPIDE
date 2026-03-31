// ─────────────────────────────────────────────────────────────────────────────
// Conductor Protocol — Primitive 5: Tesseract
// Hyper-dimensional flow execution across four axes:
//   X (sequence), Y (parallelism), Z (depth/iteration), W (phase/behavioral mode).
//
// Cells are independent sub-strategies that execute concurrently.
// Event horizons are hard sync barriers where cells converge, context merges,
// and phase transitions occur.
//
// Pure logic, no DOM, no IPC.
// ─────────────────────────────────────────────────────────────────────────────

import type { FlowGraph, FlowNode } from './atoms';
import type { ExecutionStrategy } from './conductor-atoms';
import { buildAdjacency } from './conductor-graph';

// ── Types ──────────────────────────────────────────────────────────────────

/** How outputs from multiple cells merge at an event horizon. */
export type MergePolicy = 'concat' | 'synthesize' | 'vote' | 'last-wins';

/** A single tesseract cell — an independent sub-strategy compiled from a subgraph. */
export interface TesseractCell {
  /** Unique cell ID */
  id: string;
  /** W coordinate — behavioral mode/phase (0 = exploration, 1 = refinement, …) */
  phase: number;
  /** Z range — iteration bounds [min, max] for depth layers within this cell */
  depthRange: [number, number];
  /** The 2D flow subgraph within this cell */
  subgraph: FlowGraph;
  /** Pre-compiled execution strategy for this cell */
  strategy: ExecutionStrategy;
  /** Node IDs from the original graph that belong to this cell */
  originalNodeIds: string[];
}

/** An event horizon — sync barrier where cells converge and phase transitions occur. */
export interface EventHorizon {
  /** The event-horizon node ID from the original graph */
  id: string;
  /** Which cells must converge at this horizon */
  cellIds: string[];
  /** How to merge outputs from converging cells */
  mergePolicy: MergePolicy;
  /** New W value after this horizon (undefined = no phase change) */
  phaseTransition?: number;
  /** Label for the horizon (from the node) */
  label: string;
}

/** The full tesseract execution plan. */
export interface TesseractStrategy {
  /** All cells in the tesseract */
  cells: TesseractCell[];
  /** All event horizons (sync barriers) */
  horizons: EventHorizon[];
  /** Execution groups: alternating cell-groups and horizons.
   *  Cells within a group run concurrently (Promise.all).
   *  Horizons are sequential barriers between groups. */
  executionOrder: TesseractExecutionStep[];
}

export type TesseractExecutionStep =
  | { kind: 'cells'; cellIds: string[] }
  | { kind: 'horizon'; horizonId: string };

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Check whether a graph contains tesseract structures (event-horizon nodes
 * with cellId assignments on other nodes).
 */
export function hasTesseractStructure(graph: FlowGraph): boolean {
  const hasHorizon = graph.nodes.some((n) => n.kind === 'event-horizon');
  const hasCells = graph.nodes.some((n) => n.cellId !== undefined);
  return hasHorizon && hasCells;
}

/**
 * Find all event-horizon nodes in a graph.
 */
export function findEventHorizons(graph: FlowGraph): FlowNode[] {
  return graph.nodes.filter((n) => n.kind === 'event-horizon');
}

// ── Cell Extraction ────────────────────────────────────────────────────────

/**
 * Extract unique cell IDs from node assignments.
 * Nodes without a cellId are split into depth-aware segments:
 * - `_pre` for nodes shallower than the first horizon (triggers, setup)
 * - `_post` for nodes deeper than the last horizon (outputs, finalization)
 * - `root` for any other uncellId nodes between horizons
 *
 * Uses topological depth when explicit node depths are uniform.
 */
export function extractCellIds(graph: FlowGraph, topoDepths?: Map<string, number>): string[] {
  const horizonNodes = graph.nodes.filter((n) => n.kind === 'event-horizon');

  // If no horizons, simple case
  if (horizonNodes.length === 0) {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      ids.add(node.cellId ?? 'root');
    }
    return [...ids].sort();
  }

  // Use pre-computed depths or compute fresh
  const topoDepth = topoDepths ?? computeTopoDepth(graph);

  const horizonDepths = horizonNodes.map((n) => topoDepth.get(n.id) ?? 0);
  const minHorizonDepth = Math.min(...horizonDepths);
  const maxHorizonDepth = Math.max(...horizonDepths);

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === 'event-horizon') continue;
    if (node.cellId) {
      ids.add(node.cellId);
    } else {
      // Split root nodes by position relative to horizons
      const depth = topoDepth.get(node.id) ?? 0;
      if (depth < minHorizonDepth) {
        ids.add('_pre');
      } else if (depth > maxHorizonDepth) {
        ids.add('_post');
      } else {
        ids.add('root');
      }
    }
  }
  return [...ids].sort();
}

/** Compute BFS topological depth for all nodes. */
function computeTopoDepth(graph: FlowGraph): Map<string, number> {
  const { forward, backward } = buildAdjacency(graph);
  const depths = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const n of graph.nodes) {
    inDeg.set(n.id, (backward.get(n.id) ?? []).length);
  }
  const queue: string[] = [];
  for (const n of graph.nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) {
      queue.push(n.id);
      depths.set(n.id, 0);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depths.get(id) ?? 0;
    for (const child of forward.get(id) ?? []) {
      const existing = depths.get(child) ?? 0;
      depths.set(child, Math.max(existing, d + 1));
      const deg = (inDeg.get(child) ?? 1) - 1;
      inDeg.set(child, deg);
      if (deg === 0) queue.push(child);
    }
  }
  return depths;
}

/**
 * Build a subgraph for a single cell — extract the nodes assigned to this cell
 * and the edges between them.
 */
export function buildCellSubgraph(
  graph: FlowGraph,
  cellId: string,
  topoDepths?: Map<string, number>,
): FlowGraph {
  const horizonNodes = graph.nodes.filter((n) => n.kind === 'event-horizon');

  let cellNodes: FlowNode[];

  if (horizonNodes.length === 0) {
    // No horizons — simple cellId matching (or 'root' for uncellId nodes)
    cellNodes = graph.nodes.filter((n) => {
      if (n.kind === 'event-horizon') return false;
      return (n.cellId ?? 'root') === cellId;
    });
  } else {
    // Use pre-computed depths or compute fresh
    const topoDepth = topoDepths ?? computeTopoDepth(graph);
    const horizonDepths = horizonNodes.map((n) => topoDepth.get(n.id) ?? 0);
    const minHorizonDepth = Math.min(...horizonDepths);
    const maxHorizonDepth = Math.max(...horizonDepths);

    cellNodes = graph.nodes.filter((n) => {
      if (n.kind === 'event-horizon') return false;
      if (n.cellId) return n.cellId === cellId;

      // Node has no cellId — determine which virtual cell it belongs to
      const depth = topoDepth.get(n.id) ?? 0;
      if (cellId === '_pre') return depth < minHorizonDepth;
      if (cellId === '_post') return depth > maxHorizonDepth;
      if (cellId === 'root') return depth >= minHorizonDepth && depth <= maxHorizonDepth;
      return false;
    });
  }

  const cellNodeIds = new Set(cellNodes.map((n) => n.id));

  // Include edges where both endpoints are in this cell
  const cellEdges = graph.edges.filter((e) => cellNodeIds.has(e.from) && cellNodeIds.has(e.to));

  return {
    id: `${graph.id}_cell_${cellId}`,
    name: `${graph.name} [Cell ${cellId}]`,
    description: graph.description,
    nodes: cellNodes,
    edges: cellEdges,
    variables: graph.variables,
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
  };
}

// ── Horizon Analysis ───────────────────────────────────────────────────────

/**
 * Parse an event-horizon node's config into an EventHorizon descriptor.
 */
export function parseEventHorizon(node: FlowNode, graph: FlowGraph): EventHorizon {
  const { backward } = buildAdjacency(graph);

  // Determine which cells feed into this horizon by looking at incoming edges
  const incomingNodeIds = backward.get(node.id) ?? [];
  const feedingCellIds = new Set<string>();
  for (const srcId of incomingNodeIds) {
    const srcNode = graph.nodes.find((n) => n.id === srcId);
    if (srcNode) {
      feedingCellIds.add(srcNode.cellId ?? 'root');
    }
  }

  const config = node.config ?? {};
  const mergePolicy: MergePolicy = (
    ['concat', 'synthesize', 'vote', 'last-wins'] as MergePolicy[]
  ).includes(config.mergePolicy as MergePolicy)
    ? (config.mergePolicy as MergePolicy)
    : 'concat';

  const phaseTransition =
    typeof config.phaseTransition === 'number' ? config.phaseTransition : undefined;

  return {
    id: node.id,
    cellIds: [...feedingCellIds],
    mergePolicy,
    phaseTransition,
    label: node.label ?? 'Event Horizon',
  };
}

// ── Strategy Compilation ───────────────────────────────────────────────────

/**
 * Compile a tesseract strategy from a graph containing event-horizon nodes
 * and cell-assigned nodes.
 *
 * Pipeline:
 * 1. Identify event horizons
 * 2. Extract cell subgraphs
 * 3. Compile each cell independently (Collapse/Extract/Parallelize/Converge apply within)
 * 4. Build execution order: cells → horizon → cells → horizon → …
 */
export function compileTesseractStrategy(
  graph: FlowGraph,
  compileSubgraph?: (g: FlowGraph) => ExecutionStrategy,
): TesseractStrategy {
  // Compute topological depths once for the entire graph (avoids redundant BFS)
  const topoDepths = computeTopoDepth(graph);

  const horizonNodes = findEventHorizons(graph);
  const cellIds = extractCellIds(graph, topoDepths);

  // 1. Parse all horizons
  const horizons: EventHorizon[] = horizonNodes.map((n) => parseEventHorizon(n, graph));

  // Resolve compiler: caller-provided (breaks circular dep) or sequential fallback
  const compile = compileSubgraph ?? buildSequentialFallback;

  // 2. Build cells with compiled sub-strategies
  const cells: TesseractCell[] = cellIds.map((cellId) => {
    const subgraph = buildCellSubgraph(graph, cellId, topoDepths);
    const strategy = compile(subgraph);

    // Derive phase and depth range from nodes in this cell
    const cellNodes = subgraph.nodes;
    const phase = cellNodes.length > 0 ? (cellNodes[0].phase ?? 0) : 0;
    const depths = cellNodes.map((n) => n.depth ?? 0);
    const depthRange: [number, number] =
      depths.length > 0 ? [Math.min(...depths), Math.max(...depths)] : [0, 0];

    return {
      id: cellId,
      phase,
      depthRange,
      subgraph,
      strategy,
      originalNodeIds: cellNodes.map((n) => n.id),
    };
  });

  // 3. Build execution order
  //    Topologically order horizons, then interleave cell groups between them.
  //    A cell group is "all cells that feed into the next horizon."
  const executionOrder = buildExecutionOrder(cells, horizons, graph, topoDepths);

  return { cells, horizons, executionOrder };
}

/**
 * Sequential fallback strategy compiler — used when no external compiler is
 * provided, breaking the circular dependency with conductor-atoms. Produces a
 * minimal sequential plan sufficient for tests and standalone usage.
 */
function buildSequentialFallback(g: FlowGraph): ExecutionStrategy {
  return {
    graphId: g.id,
    phases: [
      {
        index: 0,
        units: g.nodes.map((n, i) => ({
          id: `fb_${i}`,
          type: 'single-agent' as const,
          nodeIds: [n.id],
          dependsOn: [],
        })),
      },
    ],
    totalNodes: g.nodes.length,
    estimatedLlmCalls: g.nodes.length,
    estimatedDirectActions: 0,
    conductorUsed: false,
    meta: {
      collapseGroups: 0,
      parallelPhases: 0,
      meshCount: 0,
      extractedNodes: 0,
      tesseractCells: 0,
    },
  };
}

/**
 * Build the interleaved execution order: [cells] → horizon → [cells] → horizon → …
 *
 * Algorithm:
 * - Topologically order horizons by graph position (depth)
 * - For each horizon, find which cells must complete before it
 * - Cells not feeding any horizon go into the first group
 */
function buildExecutionOrder(
  cells: TesseractCell[],
  horizons: EventHorizon[],
  graph: FlowGraph,
  topoDepths?: Map<string, number>,
): TesseractExecutionStep[] {
  if (horizons.length === 0) {
    // No horizons — all cells run in parallel
    return [{ kind: 'cells', cellIds: cells.map((c) => c.id) }];
  }

  // Use pre-computed depths or compute fresh
  const nodeDepths = topoDepths ?? computeTopoDepth(graph);

  // Sort horizons by depth
  const sortedHorizons = [...horizons].sort((a, b) => {
    return (nodeDepths.get(a.id) ?? 0) - (nodeDepths.get(b.id) ?? 0);
  });

  const steps: TesseractExecutionStep[] = [];
  const scheduledCells = new Set<string>();

  // Schedule _pre cells first (triggers, setup — shallower than all horizons)
  const preCells = cells.filter((c) => c.id === '_pre');
  if (preCells.length > 0) {
    steps.push({ kind: 'cells', cellIds: preCells.map((c) => c.id) });
    for (const c of preCells) scheduledCells.add(c.id);
  }

  for (const horizon of sortedHorizons) {
    // Cells that feed this horizon and haven't been scheduled yet
    const cellGroup = horizon.cellIds.filter((id) => !scheduledCells.has(id));
    if (cellGroup.length > 0) {
      steps.push({ kind: 'cells', cellIds: cellGroup });
      for (const id of cellGroup) scheduledCells.add(id);
    }
    steps.push({ kind: 'horizon', horizonId: horizon.id });
  }

  // Any remaining cells that don't feed any horizon (except _post)
  const remaining = cells
    .map((c) => c.id)
    .filter((id) => !scheduledCells.has(id) && id !== '_post');
  if (remaining.length > 0) {
    steps.push({ kind: 'cells', cellIds: remaining });
  }

  // Schedule _post cells last (outputs, finalization — deeper than all horizons)
  const postCells = cells.filter((c) => c.id === '_post' && !scheduledCells.has(c.id));
  if (postCells.length > 0) {
    steps.push({ kind: 'cells', cellIds: postCells.map((c) => c.id) });
  }

  return steps;
}

// ── Cell Utilities ─────────────────────────────────────────────────────────

/**
 * Find the sink node in a tesseract cell — the node with no outgoing edges
 * within the cell. Used to collect the cell's final output reliably
 * regardless of node insertion order in the graph.
 */
export function findCellSinkNode(cell: TesseractCell, graph: FlowGraph): string {
  const cellNodeSet = new Set(cell.originalNodeIds);
  const hasOutgoing = new Set<string>();
  for (const e of graph.edges) {
    if (cellNodeSet.has(e.from) && cellNodeSet.has(e.to) && e.kind !== 'reverse') {
      hasOutgoing.add(e.from);
    }
  }
  const sinks = cell.originalNodeIds.filter((id) => !hasOutgoing.has(id));
  return sinks.length > 0 ? sinks[0] : cell.originalNodeIds[cell.originalNodeIds.length - 1];
}

// ── Merge Policies ─────────────────────────────────────────────────────────

/**
 * Merge outputs from multiple cells at an event horizon according to the
 * specified merge policy.
 */
export function mergeAtHorizon(cellOutputs: Map<string, string>, policy: MergePolicy): string {
  const outputs = [...cellOutputs.values()].filter(Boolean);
  if (outputs.length === 0) return '';
  if (outputs.length === 1) return outputs[0];

  switch (policy) {
    case 'concat':
      // Simple concatenation with cell labels
      return [...cellOutputs.entries()]
        .map(([cellId, output]) => `[Cell ${cellId}]\n${output}`)
        .join('\n\n---\n\n');

    case 'synthesize':
      // Build a synthesis prompt (the LLM will execute this in the executor)
      return [
        '[Event Horizon — Synthesis Required]',
        'The following outputs from independent workflow cells need to be synthesized into a unified result:',
        '',
        ...outputs.map((o, i) => `## Source ${i + 1}\n${o}`),
        '',
        'Synthesize these into a single coherent output that preserves all key information.',
      ].join('\n');

    case 'vote': {
      // Simple majority: pick the most common output, or first if all unique
      const counts = new Map<string, number>();
      for (const o of outputs) {
        counts.set(o, (counts.get(o) ?? 0) + 1);
      }
      let best = outputs[0];
      let bestCount = 0;
      for (const [text, count] of counts) {
        if (count > bestCount) {
          best = text;
          bestCount = count;
        }
      }
      return best;
    }

    case 'last-wins':
      return outputs[outputs.length - 1];

    default:
      return outputs.join('\n\n');
  }
}
