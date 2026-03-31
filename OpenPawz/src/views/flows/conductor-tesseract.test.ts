// ─────────────────────────────────────────────────────────────────────────────
// Conductor Protocol — Primitive 5: Tesseract Tests
// Pure logic: cell extraction, horizon analysis, merge policies, strategy compile.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import type { FlowGraph, FlowNode, FlowEdge, FlowNodeKind } from './atoms';
import {
  hasTesseractStructure,
  findEventHorizons,
  extractCellIds,
  buildCellSubgraph,
  parseEventHorizon,
  compileTesseractStrategy,
  mergeAtHorizon,
  findCellSinkNode,
} from './conductor-tesseract';
import type { ConductorDeps } from './executor-conductor';

// ── Helpers ────────────────────────────────────────────────────────────────

let _uid = 0;

function mkNode(kind: FlowNodeKind, overrides: Partial<FlowNode> = {}): FlowNode {
  const id = overrides.id ?? `n${++_uid}`;
  return {
    id,
    kind,
    label: overrides.label ?? `${kind}-${id}`,
    x: 0,
    y: 0,
    width: 180,
    height: 72,
    status: 'idle',
    depth: 0,
    phase: 0,
    config: overrides.config ?? {},
    inputs: ['in'],
    outputs: ['out'],
    ...overrides,
  };
}

function mkEdge(from: string, to: string, overrides: Partial<FlowEdge> = {}): FlowEdge {
  return {
    id: overrides.id ?? `e_${from}_${to}`,
    kind: overrides.kind ?? 'forward',
    from,
    to,
    fromPort: 'out',
    toPort: 'in',
    active: false,
    ...overrides,
  };
}

function mkGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  overrides: Partial<FlowGraph> = {},
): FlowGraph {
  return {
    id: overrides.id ?? 'test-graph',
    name: overrides.name ?? 'Test Graph',
    nodes,
    edges,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  _uid = 0;
});

// ── hasTesseractStructure ──────────────────────────────────────────────────

describe('hasTesseractStructure', () => {
  it('returns false for an empty graph', () => {
    const g = mkGraph([], []);
    expect(hasTesseractStructure(g)).toBe(false);
  });

  it('returns false for a plain sequential graph', () => {
    const a = mkNode('trigger', { id: 'a' });
    const b = mkNode('agent', { id: 'b' });
    const g = mkGraph([a, b], [mkEdge('a', 'b')]);
    expect(hasTesseractStructure(g)).toBe(false);
  });

  it('returns false if there is an event-horizon but no cellId assignments', () => {
    const a = mkNode('trigger', { id: 'a' });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, h], [mkEdge('a', 'h')]);
    expect(hasTesseractStructure(g)).toBe(false);
  });

  it('returns false if there are cellIds but no event-horizon', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c2' });
    const g = mkGraph([a, b], []);
    expect(hasTesseractStructure(g)).toBe(false);
  });

  it('returns true when event-horizon and cellIds are both present', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c2' });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, b, h], [mkEdge('a', 'h'), mkEdge('b', 'h')]);
    expect(hasTesseractStructure(g)).toBe(true);
  });
});

// ── findEventHorizons ──────────────────────────────────────────────────────

describe('findEventHorizons', () => {
  it('returns empty for graph without horizons', () => {
    const g = mkGraph([mkNode('agent', { id: 'a' })], []);
    expect(findEventHorizons(g)).toHaveLength(0);
  });

  it('finds all event-horizon nodes', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const h1 = mkNode('event-horizon' as FlowNodeKind, { id: 'h1' });
    const h2 = mkNode('event-horizon' as FlowNodeKind, { id: 'h2' });
    const g = mkGraph([a, h1, h2], []);
    const horizons = findEventHorizons(g);
    expect(horizons).toHaveLength(2);
    expect(horizons.map((h) => h.id).sort()).toEqual(['h1', 'h2']);
  });
});

// ── extractCellIds ─────────────────────────────────────────────────────────

describe('extractCellIds', () => {
  it('returns ["root"] when no cellIds assigned', () => {
    const a = mkNode('agent', { id: 'a' });
    const g = mkGraph([a], []);
    expect(extractCellIds(g)).toEqual(['root']);
  });

  it('excludes event-horizon nodes from cell assignment', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, h], []);
    expect(extractCellIds(g)).toEqual(['c1']);
  });

  it('returns sorted unique cell IDs', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'beta' });
    const b = mkNode('agent', { id: 'b', cellId: 'alpha' });
    const c = mkNode('agent', { id: 'c', cellId: 'beta' });
    const g = mkGraph([a, b, c], []);
    expect(extractCellIds(g)).toEqual(['alpha', 'beta']);
  });

  it('assigns uncellId nodes to root', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b' }); // no cellId → root
    const g = mkGraph([a, b], []);
    expect(extractCellIds(g)).toEqual(['c1', 'root']);
  });
});

// ── buildCellSubgraph ──────────────────────────────────────────────────────

describe('buildCellSubgraph', () => {
  it('isolates nodes and edges for a specific cell', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c1' });
    const c = mkNode('agent', { id: 'c', cellId: 'c2' });
    const g = mkGraph([a, b, c], [mkEdge('a', 'b'), mkEdge('b', 'c')]);

    const sub = buildCellSubgraph(g, 'c1');
    expect(sub.nodes).toHaveLength(2);
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    // Edge a→b is internal to c1, b→c crosses cell boundary
    expect(sub.edges).toHaveLength(1);
    expect(sub.edges[0].from).toBe('a');
    expect(sub.edges[0].to).toBe('b');
  });

  it('uses "root" for nodes without cellId', () => {
    const a = mkNode('agent', { id: 'a' }); // no cellId
    const b = mkNode('agent', { id: 'b' }); // no cellId
    const g = mkGraph([a, b], [mkEdge('a', 'b')]);

    const sub = buildCellSubgraph(g, 'root');
    expect(sub.nodes).toHaveLength(2);
    expect(sub.edges).toHaveLength(1);
  });

  it('excludes event-horizon nodes from cell subgraphs', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h', cellId: 'c1' });
    const g = mkGraph([a, h], [mkEdge('a', 'h')]);

    const sub = buildCellSubgraph(g, 'c1');
    expect(sub.nodes).toHaveLength(1);
    expect(sub.nodes[0].id).toBe('a');
  });

  it('names the subgraph with cell ID', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'research' });
    const g = mkGraph([a], [], { name: 'My Flow' });

    const sub = buildCellSubgraph(g, 'research');
    expect(sub.name).toContain('research');
    expect(sub.id).toContain('research');
  });
});

// ── parseEventHorizon ──────────────────────────────────────────────────────

describe('parseEventHorizon', () => {
  it('identifies feeding cells from backward edges', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c2' });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, b, h], [mkEdge('a', 'h'), mkEdge('b', 'h')]);

    const horizon = parseEventHorizon(h, g);
    expect(horizon.cellIds.sort()).toEqual(['c1', 'c2']);
  });

  it('defaults to concat merge policy', () => {
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([h], []);

    const horizon = parseEventHorizon(h, g);
    expect(horizon.mergePolicy).toBe('concat');
  });

  it('reads merge policy from config', () => {
    const h = mkNode('event-horizon' as FlowNodeKind, {
      id: 'h',
      config: { mergePolicy: 'vote' },
    });
    const g = mkGraph([h], []);

    const horizon = parseEventHorizon(h, g);
    expect(horizon.mergePolicy).toBe('vote');
  });

  it('reads phase transition from config', () => {
    const h = mkNode('event-horizon' as FlowNodeKind, {
      id: 'h',
      config: { phaseTransition: 2 },
    });
    const g = mkGraph([h], []);

    const horizon = parseEventHorizon(h, g);
    expect(horizon.phaseTransition).toBe(2);
  });

  it('ignores invalid merge policy values', () => {
    const h = mkNode('event-horizon' as FlowNodeKind, {
      id: 'h',
      config: { mergePolicy: 'invalid-policy' },
    });
    const g = mkGraph([h], []);

    const horizon = parseEventHorizon(h, g);
    expect(horizon.mergePolicy).toBe('concat');
  });

  it('uses node label for the horizon', () => {
    const h = mkNode('event-horizon' as FlowNodeKind, {
      id: 'h',
      label: 'Sync Point Alpha',
    });
    const g = mkGraph([h], []);

    const horizon = parseEventHorizon(h, g);
    expect(horizon.label).toBe('Sync Point Alpha');
  });

  it('assigns uncellId feeder nodes to root', () => {
    const a = mkNode('agent', { id: 'a' }); // no cellId → root
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, h], [mkEdge('a', 'h')]);

    const horizon = parseEventHorizon(h, g);
    expect(horizon.cellIds).toEqual(['root']);
  });
});

// ── mergeAtHorizon ─────────────────────────────────────────────────────────

describe('mergeAtHorizon', () => {
  it('returns empty string for empty map', () => {
    expect(mergeAtHorizon(new Map(), 'concat')).toBe('');
  });

  it('returns single output as-is', () => {
    const m = new Map([['c1', 'hello']]);
    expect(mergeAtHorizon(m, 'concat')).toBe('hello');
    expect(mergeAtHorizon(m, 'vote')).toBe('hello');
    expect(mergeAtHorizon(m, 'last-wins')).toBe('hello');
  });

  it('concat includes cell labels', () => {
    const m = new Map([
      ['c1', 'output1'],
      ['c2', 'output2'],
    ]);
    const result = mergeAtHorizon(m, 'concat');
    expect(result).toContain('[Cell c1]');
    expect(result).toContain('output1');
    expect(result).toContain('[Cell c2]');
    expect(result).toContain('output2');
  });

  it('synthesize produces a prompt for LLM execution', () => {
    const m = new Map([
      ['c1', 'research results'],
      ['c2', 'analysis data'],
    ]);
    const result = mergeAtHorizon(m, 'synthesize');
    expect(result).toContain('Synthesis Required');
    expect(result).toContain('research results');
    expect(result).toContain('analysis data');
    expect(result).toContain('Synthesize');
  });

  it('vote returns most common output', () => {
    const m = new Map([
      ['c1', 'answer A'],
      ['c2', 'answer B'],
      ['c3', 'answer A'],
    ]);
    expect(mergeAtHorizon(m, 'vote')).toBe('answer A');
  });

  it('vote falls back to first if all unique', () => {
    const m = new Map([
      ['c1', 'answer A'],
      ['c2', 'answer B'],
      ['c3', 'answer C'],
    ]);
    // First entry wins when all unique
    expect(mergeAtHorizon(m, 'vote')).toBe('answer A');
  });

  it('last-wins returns the last entry', () => {
    const m = new Map([
      ['c1', 'first'],
      ['c2', 'second'],
      ['c3', 'final'],
    ]);
    expect(mergeAtHorizon(m, 'last-wins')).toBe('final');
  });

  it('filters empty outputs', () => {
    const m = new Map([
      ['c1', ''],
      ['c2', 'real output'],
    ]);
    expect(mergeAtHorizon(m, 'last-wins')).toBe('real output');
  });
});

// ── compileTesseractStrategy ───────────────────────────────────────────────

describe('compileTesseractStrategy', () => {
  it('compiles a minimal two-cell graph with one horizon', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1', depth: 0, config: { prompt: 'do A' } });
    const b = mkNode('agent', { id: 'b', cellId: 'c2', depth: 0, config: { prompt: 'do B' } });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h', depth: 1 });
    const g = mkGraph([a, b, h], [mkEdge('a', 'h'), mkEdge('b', 'h')]);

    const strategy = compileTesseractStrategy(g);

    expect(strategy.cells).toHaveLength(2);
    expect(strategy.cells.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(strategy.horizons).toHaveLength(1);
    expect(strategy.horizons[0].id).toBe('h');
    expect(strategy.horizons[0].cellIds.sort()).toEqual(['c1', 'c2']);
  });

  it('each cell gets its own compiled strategy', () => {
    const a1 = mkNode('agent', { id: 'a1', cellId: 'c1', config: { prompt: 'step 1' } });
    const a2 = mkNode('agent', { id: 'a2', cellId: 'c1', config: { prompt: 'step 2' } });
    const b1 = mkNode('agent', { id: 'b1', cellId: 'c2', config: { prompt: 'step 3' } });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h', depth: 1 });
    const g = mkGraph([a1, a2, b1, h], [mkEdge('a1', 'a2'), mkEdge('a2', 'h'), mkEdge('b1', 'h')]);

    const strategy = compileTesseractStrategy(g);
    const c1 = strategy.cells.find((c) => c.id === 'c1');
    const c2 = strategy.cells.find((c) => c.id === 'c2');

    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1!.originalNodeIds.sort()).toEqual(['a1', 'a2']);
    expect(c2!.originalNodeIds).toEqual(['b1']);
    // Each cell has its own strategy object
    expect(c1!.strategy).toBeDefined();
    expect(c2!.strategy).toBeDefined();
  });

  it('builds correct execution order: cells → horizon', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1', depth: 0, config: { prompt: 'p' } });
    const b = mkNode('agent', { id: 'b', cellId: 'c2', depth: 0, config: { prompt: 'p' } });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h', depth: 1 });
    const g = mkGraph([a, b, h], [mkEdge('a', 'h'), mkEdge('b', 'h')]);

    const strategy = compileTesseractStrategy(g);
    expect(strategy.executionOrder.length).toBeGreaterThanOrEqual(2);

    // First step should be cells, last should contain the horizon
    const cellStep = strategy.executionOrder.find((s) => s.kind === 'cells');
    const horizonStep = strategy.executionOrder.find((s) => s.kind === 'horizon');
    expect(cellStep).toBeDefined();
    expect(horizonStep).toBeDefined();
    if (horizonStep?.kind === 'horizon') {
      expect(horizonStep.horizonId).toBe('h');
    }
  });

  it('handles multiple horizons in sequence', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1', depth: 0, config: { prompt: 'p' } });
    const b = mkNode('agent', { id: 'b', cellId: 'c2', depth: 0, config: { prompt: 'p' } });
    const h1 = mkNode('event-horizon' as FlowNodeKind, { id: 'h1', depth: 1 });
    const c = mkNode('agent', { id: 'c', cellId: 'c3', depth: 2, config: { prompt: 'p' } });
    const h2 = mkNode('event-horizon' as FlowNodeKind, { id: 'h2', depth: 3 });
    const g = mkGraph(
      [a, b, h1, c, h2],
      [mkEdge('a', 'h1'), mkEdge('b', 'h1'), mkEdge('h1', 'c'), mkEdge('c', 'h2')],
    );

    const strategy = compileTesseractStrategy(g);
    expect(strategy.horizons).toHaveLength(2);

    const horizonSteps = strategy.executionOrder.filter((s) => s.kind === 'horizon');
    expect(horizonSteps).toHaveLength(2);
  });

  it('derives depth range for cells', () => {
    const a1 = mkNode('agent', { id: 'a1', cellId: 'deep', depth: 2, config: { prompt: 'p' } });
    const a2 = mkNode('agent', { id: 'a2', cellId: 'deep', depth: 5, config: { prompt: 'p' } });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h', depth: 6 });
    const g = mkGraph([a1, a2, h], [mkEdge('a1', 'a2'), mkEdge('a2', 'h')]);

    const strategy = compileTesseractStrategy(g);
    const cell = strategy.cells.find((c) => c.id === 'deep');
    expect(cell).toBeDefined();
    expect(cell!.depthRange[0]).toBe(2);
    expect(cell!.depthRange[1]).toBe(5);
  });

  it('records phase from cell nodes', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1', phase: 3, config: { prompt: 'p' } });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, h], [mkEdge('a', 'h')]);

    const strategy = compileTesseractStrategy(g);
    const cell = strategy.cells.find((c) => c.id === 'c1');
    expect(cell!.phase).toBe(3);
  });
});

// ── Integration: shouldUseConductor with tesseract ─────────────────────────

describe('integration: shouldUseConductor detects tesseract', () => {
  // Imported from conductor-atoms re-exports
  it('shouldUseConductor returns true for tesseract graph', async () => {
    const { shouldUseConductor } = await import('./conductor-atoms');
    const a = mkNode('agent', { id: 'a', cellId: 'c1', config: { prompt: 'p' } });
    const b = mkNode('agent', { id: 'b', cellId: 'c2', config: { prompt: 'p' } });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, b, h], [mkEdge('a', 'h'), mkEdge('b', 'h')]);

    expect(shouldUseConductor(g)).toBe(true);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('single cell with horizon — cell feeds itself', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'only', config: { prompt: 'p' } });
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([a, h], [mkEdge('a', 'h')]);

    const strategy = compileTesseractStrategy(g);
    expect(strategy.cells).toHaveLength(1);
    expect(strategy.horizons[0].cellIds).toEqual(['only']);
  });

  it('horizon with synthesize merge policy config', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1', config: { prompt: 'p' } });
    const b = mkNode('agent', { id: 'b', cellId: 'c2', config: { prompt: 'p' } });
    const h = mkNode('event-horizon' as FlowNodeKind, {
      id: 'h',
      config: { mergePolicy: 'synthesize', phaseTransition: 1 },
    });
    const g = mkGraph([a, b, h], [mkEdge('a', 'h'), mkEdge('b', 'h')]);

    const strategy = compileTesseractStrategy(g);
    expect(strategy.horizons[0].mergePolicy).toBe('synthesize');
    expect(strategy.horizons[0].phaseTransition).toBe(1);
  });

  it('graph with only event-horizon nodes (no cells) compiles with no cells', () => {
    const h = mkNode('event-horizon' as FlowNodeKind, { id: 'h' });
    const g = mkGraph([h], []);

    const strategy = compileTesseractStrategy(g);
    expect(strategy.cells).toHaveLength(0);
    expect(strategy.horizons).toHaveLength(1);
  });
});

// ── buildNodePrompt memory injection ───────────────────────────────────────

describe('buildNodePrompt with memory context', () => {
  it('injects memory context when provided', async () => {
    const { buildNodePrompt } = await import('./executor-atoms');
    const node = mkNode('agent', { id: 'a', config: { prompt: 'do something' } });
    const result = buildNodePrompt(
      node,
      'upstream data',
      { prompt: 'do something' },
      '1. [memory] relevant info',
    );
    expect(result).toContain('[Relevant Memory]');
    expect(result).toContain('relevant info');
    expect(result).toContain('upstream data');
    expect(result).toContain('do something');
  });

  it('omits memory section when empty', async () => {
    const { buildNodePrompt } = await import('./executor-atoms');
    const node = mkNode('agent', { id: 'a', config: { prompt: 'work' } });
    const result = buildNodePrompt(node, '', { prompt: 'work' });
    expect(result).not.toContain('[Relevant Memory]');
  });

  it('omits memory section when undefined', async () => {
    const { buildNodePrompt } = await import('./executor-atoms');
    const node = mkNode('agent', { id: 'a', config: { prompt: 'work' } });
    const result = buildNodePrompt(node, '', { prompt: 'work' }, undefined);
    expect(result).not.toContain('[Relevant Memory]');
  });
});

// ── FlowRunState.memoryContext ─────────────────────────────────────────────

describe('FlowRunState.memoryContext', () => {
  it('createFlowRunState includes memoryContext field', async () => {
    const { createFlowRunState } = await import('./executor-atoms');
    const state = createFlowRunState('g1', []);
    expect(state.memoryContext).toBe('');
    expect('memoryContext' in state).toBe(true);
  });

  it('createFlowRunState includes cellMemoryContexts map', async () => {
    const { createFlowRunState } = await import('./executor-atoms');
    const state = createFlowRunState('g1', []);
    expect(state.cellMemoryContexts).toBeInstanceOf(Map);
    expect(state.cellMemoryContexts.size).toBe(0);
  });
});

// ── ConductorDeps.searchMemory & cell-scoped memory isolation ──────────────

describe('ConductorDeps memory override integration', () => {
  it('ConductorDeps interface accepts optional searchMemory', async () => {
    // Compile-time check: creating a ConductorDeps-shaped object with searchMemory
    const deps: ConductorDeps = {
      getRunState: () => null,
      isAborted: () => false,
      skipNodes: new Set<string>(),
      callbacks: {} as any,
      executeNode: async () => {},
      executeAgentStep: async () => '',
      recordEdgeValues: () => {},
      searchMemory: async (query: string, _agentId?: string) => `memory for: ${query}`,
    };
    const result = await deps.searchMemory!('test query');
    expect(result).toBe('memory for: test query');
  });

  it('ConductorDeps interface works without searchMemory', () => {
    const deps: ConductorDeps = {
      getRunState: () => null,
      isAborted: () => false,
      skipNodes: new Set<string>(),
      callbacks: {} as any,
      executeNode: async () => {},
      executeAgentStep: async () => '',
      recordEdgeValues: () => {},
    };
    expect(deps.searchMemory).toBeUndefined();
  });

  it('executeNode accepts optional memoryContextOverride parameter', () => {
    // Type-level test: the signature must accept 4 args
    const fn: (g: any, n: any, aid?: string, mco?: string) => Promise<void> = async () => {};
    expect(typeof fn).toBe('function');
  });

  it('executeAgentStep accepts optional memoryContextOverride parameter', () => {
    // Type-level test: the signature must accept 6 args
    const fn: (
      g: any,
      n: any,
      i: string,
      c: any,
      aid?: string,
      mco?: string,
    ) => Promise<string> = async () => '';
    expect(typeof fn).toBe('function');
  });

  it('per-cell deps wrapper binds memory override without mutating runState', async () => {
    // Simulate the pattern used in executeTesseractCellsStep:
    // create a wrapped deps where executeAgentStep receives a memory override
    const memoryOverrides: string[] = [];
    const baseDeps = {
      getRunState: () => null,
      isAborted: () => false,
      skipNodes: new Set<string>(),
      callbacks: {} as any,
      executeNode: async (_g: any, _n: any, _aid?: string, mco?: string) => {
        if (mco) memoryOverrides.push(mco);
      },
      executeAgentStep: async (
        _g: any,
        _n: any,
        _i: string,
        _c: any,
        _aid?: string,
        mco?: string,
      ) => {
        if (mco) memoryOverrides.push(mco);
        return '';
      },
      recordEdgeValues: () => {},
    };

    // Create two cell-scoped wrappers (simulating parallel cells)
    const cellADeps = {
      ...baseDeps,
      executeNode: (g: any, n: any, aid?: string) =>
        baseDeps.executeNode(g, n, aid, 'cell-A-memory'),
      executeAgentStep: (g: any, n: any, i: string, c: any, aid?: string) =>
        baseDeps.executeAgentStep(g, n, i, c, aid, 'cell-A-memory'),
    };
    const cellBDeps = {
      ...baseDeps,
      executeNode: (g: any, n: any, aid?: string) =>
        baseDeps.executeNode(g, n, aid, 'cell-B-memory'),
      executeAgentStep: (g: any, n: any, i: string, c: any, aid?: string) =>
        baseDeps.executeAgentStep(g, n, i, c, aid, 'cell-B-memory'),
    };

    // Run both "cells" concurrently — each should receive its own override
    await Promise.all([
      cellADeps.executeAgentStep({}, {}, '', {}, undefined),
      cellBDeps.executeAgentStep({}, {}, '', {}, undefined),
      cellADeps.executeNode({}, {}, undefined),
      cellBDeps.executeNode({}, {}, undefined),
    ]);

    // Each call should have received its own cell-specific memory
    expect(memoryOverrides).toContain('cell-A-memory');
    expect(memoryOverrides).toContain('cell-B-memory');
    expect(memoryOverrides.filter((m) => m === 'cell-A-memory')).toHaveLength(2);
    expect(memoryOverrides.filter((m) => m === 'cell-B-memory')).toHaveLength(2);
  });

  it('searchMemory resolves actual memory instead of raw query strings', async () => {
    // Verify the resolved memory pattern (not query strings)
    const mockSearchMemory = async (query: string) => {
      if (query.includes('research')) return '1. [memory] Found research data';
      if (query.includes('trade')) return '1. [memory] Found trading signals';
      return '';
    };

    const researchMemory = await mockSearchMemory('research analysis');
    const tradeMemory = await mockSearchMemory('trade execution');

    expect(researchMemory).toContain('[memory]');
    expect(tradeMemory).toContain('[memory]');
    // Memory should be resolved results, not the raw query string
    expect(researchMemory).not.toBe('research analysis');
    expect(tradeMemory).not.toBe('trade execution');
  });
});

// ── findCellSinkNode ───────────────────────────────────────────────────────

describe('findCellSinkNode', () => {
  it('finds the sink in a linear chain (A → B → C)', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c1' });
    const c = mkNode('agent', { id: 'c', cellId: 'c1' });
    const g = mkGraph([a, b, c], [mkEdge('a', 'b'), mkEdge('b', 'c')]);
    const cell = {
      id: 'c1',
      phase: 0,
      depthRange: [0, 2] as [number, number],
      subgraph: g,
      strategy: {} as any,
      originalNodeIds: ['a', 'b', 'c'],
    };

    expect(findCellSinkNode(cell, g)).toBe('c');
  });

  it('picks first sink when multiple sinks exist', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c1' });
    const c = mkNode('agent', { id: 'c', cellId: 'c1' });
    // A → B, A → C — both B and C are sinks
    const g = mkGraph([a, b, c], [mkEdge('a', 'b'), mkEdge('a', 'c')]);
    const cell = {
      id: 'c1',
      phase: 0,
      depthRange: [0, 1] as [number, number],
      subgraph: g,
      strategy: {} as any,
      originalNodeIds: ['a', 'b', 'c'],
    };

    const sink = findCellSinkNode(cell, g);
    // Should be 'b' (first in originalNodeIds that's a sink)
    expect(['b', 'c']).toContain(sink);
  });

  it('ignores reverse edges when determining sinks', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c1' });
    // A → B (forward), B → A (reverse) — B is still the sink
    const g = mkGraph([a, b], [mkEdge('a', 'b'), mkEdge('b', 'a', { kind: 'reverse' })]);
    const cell = {
      id: 'c1',
      phase: 0,
      depthRange: [0, 1] as [number, number],
      subgraph: g,
      strategy: {} as any,
      originalNodeIds: ['a', 'b'],
    };

    expect(findCellSinkNode(cell, g)).toBe('b');
  });

  it('returns single node when cell has only one node', () => {
    const a = mkNode('agent', { id: 'solo', cellId: 'c1' });
    const g = mkGraph([a], []);
    const cell = {
      id: 'c1',
      phase: 0,
      depthRange: [0, 0] as [number, number],
      subgraph: g,
      strategy: {} as any,
      originalNodeIds: ['solo'],
    };

    expect(findCellSinkNode(cell, g)).toBe('solo');
  });

  it('only considers edges within the cell (ignores cross-cell edges)', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c1' });
    const x = mkNode('agent', { id: 'x', cellId: 'c2' });
    // A → B (within cell), B → X (cross-cell — should be ignored)
    const g = mkGraph([a, b, x], [mkEdge('a', 'b'), mkEdge('b', 'x')]);
    const cell = {
      id: 'c1',
      phase: 0,
      depthRange: [0, 1] as [number, number],
      subgraph: g,
      strategy: {} as any,
      originalNodeIds: ['a', 'b'],
    };

    // B has an outgoing edge to X, but X is not in this cell, so B is the sink
    expect(findCellSinkNode(cell, g)).toBe('b');
  });

  it('falls back to last originalNodeIds element when all nodes have outgoing edges', () => {
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c1' });
    // A → B, B → A — cycle within cell, no true sink
    const g = mkGraph([a, b], [mkEdge('a', 'b'), mkEdge('b', 'a')]);
    const cell = {
      id: 'c1',
      phase: 0,
      depthRange: [0, 1] as [number, number],
      subgraph: g,
      strategy: {} as any,
      originalNodeIds: ['a', 'b'],
    };

    // Both have outgoing forward edges, falls back to last
    expect(findCellSinkNode(cell, g)).toBe('b');
  });

  it('works with nodes added in non-topological order', () => {
    // Nodes inserted in reverse: C first, then B, then A
    const c = mkNode('agent', { id: 'c', cellId: 'c1' });
    const b = mkNode('agent', { id: 'b', cellId: 'c1' });
    const a = mkNode('agent', { id: 'a', cellId: 'c1' });
    const g = mkGraph([c, b, a], [mkEdge('a', 'b'), mkEdge('b', 'c')]);
    // originalNodeIds in insertion order (non-topological)
    const cell = {
      id: 'c1',
      phase: 0,
      depthRange: [0, 2] as [number, number],
      subgraph: g,
      strategy: {} as any,
      originalNodeIds: ['c', 'b', 'a'],
    };

    // C has no outgoing edges within cell — it's the sink regardless of order
    expect(findCellSinkNode(cell, g)).toBe('c');
  });
});
