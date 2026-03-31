// ─────────────────────────────────────────────────────────────────────────────
// Flow Executor — Conductor Strategy Execution
// Handles Conductor Protocol execution: collapsed units, convergent mesh,
// and strategy-phase orchestration. Called from the main executor factory.
// ─────────────────────────────────────────────────────────────────────────────

import type { FlowGraph, FlowNode } from './atoms';
import {
  type FlowRunState,
  type NodeExecConfig,
  createNodeRunState,
  getNodeExecConfig,
  collectNodeInput,
} from './executor-atoms';
import {
  parseCollapsedOutput,
  checkConvergence,
  type ExecutionStrategy,
  type ExecutionUnit,
} from './conductor-atoms';
import {
  mergeAtHorizon,
  findCellSinkNode,
  type TesseractStrategy,
  type TesseractExecutionStep,
} from './conductor-tesseract';
import type { FlowExecutorCallbacks } from './executor';

// ── Dependency Interface ───────────────────────────────────────────────────

/** Dependencies injected from the executor closure into conductor functions. */
export interface ConductorDeps {
  getRunState: () => FlowRunState | null;
  isAborted: () => boolean;
  skipNodes: Set<string>;
  callbacks: FlowExecutorCallbacks;
  executeNode: (
    graph: FlowGraph,
    node: FlowNode,
    agentId?: string,
    memoryContextOverride?: string,
  ) => Promise<void>;
  executeAgentStep: (
    graph: FlowGraph,
    node: FlowNode,
    input: string,
    config: NodeExecConfig,
    agentId?: string,
    memoryContextOverride?: string,
  ) => Promise<string>;
  recordEdgeValues: (graph: FlowGraph, nodeId: string) => void;
  /**
   * Search long-term memory for context relevant to a query.
   * Returns pre-formatted memory lines (score-filtered, numbered).
   * Optional — when absent, cell memory falls back to flow-wide context.
   */
  searchMemory?: (query: string, agentId?: string) => Promise<string>;
}

// ── Strategy Execution ─────────────────────────────────────────────────────

/**
 * Execute a compiled Conductor strategy — walk through phases and
 * dispatch each unit (collapsed, mesh, single) accordingly.
 */
export async function runConductorStrategy(
  deps: ConductorDeps,
  graph: FlowGraph,
  strategy: ExecutionStrategy,
  defaultAgentId?: string,
): Promise<void> {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const runState = deps.getRunState();

  for (const phase of strategy.phases) {
    if (deps.isAborted()) {
      if (runState) {
        runState.status = 'error';
        deps.callbacks.onEvent({ type: 'run-aborted', runId: runState.runId });
      }
      break;
    }

    // Execute all units in this phase concurrently (Parallelize primitive)
    if (phase.units.length === 1) {
      await executeConductorUnit(deps, graph, phase.units[0], nodeMap, defaultAgentId);
    } else {
      await Promise.all(
        phase.units.map((unit) => executeConductorUnit(deps, graph, unit, nodeMap, defaultAgentId)),
      );
    }
  }
}

// ── Unit Dispatch ──────────────────────────────────────────────────────────

async function executeConductorUnit(
  deps: ConductorDeps,
  graph: FlowGraph,
  unit: ExecutionUnit,
  nodeMap: Map<string, FlowNode>,
  defaultAgentId?: string,
): Promise<void> {
  if (deps.isAborted()) return;

  switch (unit.type) {
    case 'collapsed-agent':
      await executeCollapsedUnit(deps, graph, unit, nodeMap, defaultAgentId);
      break;
    case 'mesh':
      await executeMeshRounds(deps, graph, unit, nodeMap, defaultAgentId);
      break;
    case 'single-agent':
    case 'single-direct':
    case 'direct-action': {
      for (const nodeId of unit.nodeIds) {
        if (deps.isAborted() || deps.skipNodes.has(nodeId)) continue;
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        await deps.executeNode(graph, node, defaultAgentId);
        deps.recordEdgeValues(graph, nodeId);
      }
      break;
    }
    case 'tesseract':
      if (unit.tesseractStrategy) {
        await executeTesseractUnit(deps, graph, unit.tesseractStrategy, nodeMap, defaultAgentId);
      }
      break;
  }
}

// ── Collapsed Unit Execution ───────────────────────────────────────────────

/**
 * Execute a collapsed unit — multiple sequential agent nodes merged into a
 * single LLM call with a combined prompt, then output parsed back out.
 */
async function executeCollapsedUnit(
  deps: ConductorDeps,
  graph: FlowGraph,
  unit: ExecutionUnit,
  nodeMap: Map<string, FlowNode>,
  defaultAgentId?: string,
): Promise<void> {
  const runState = deps.getRunState();
  if (!runState || !unit.mergedPrompt) return;

  // Mark all nodes in the collapse group as running
  for (const nodeId of unit.nodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    node.status = 'running';
    deps.callbacks.onNodeStatusChange(nodeId, 'running');

    const inEdges = graph.edges.filter((e) => e.to === nodeId);
    for (const e of inEdges) {
      e.active = true;
      deps.callbacks.onEdgeActive(e.id, true);
    }
  }

  // Collect upstream input for the first node in the chain
  const firstNodeId = unit.nodeIds[0];
  const upstreamInput = collectNodeInput(graph, firstNodeId, runState.nodeStates);

  // Build combined prompt
  let prompt = unit.mergedPrompt;
  if (upstreamInput) {
    prompt = `[Previous step output]\n${upstreamInput}\n\n${prompt}`;
  }

  deps.callbacks.onEvent({
    type: 'step-start',
    runId: runState.runId,
    stepIndex: runState.currentStep,
    nodeId: firstNodeId,
    nodeLabel: `Collapsed: ${unit.nodeIds.length} steps`,
    nodeKind: 'agent',
  });

  const startTime = Date.now();

  try {
    // Execute as a single LLM call
    const firstNode = nodeMap.get(firstNodeId)!;
    const config = getNodeExecConfig(firstNode);
    const output = await deps.executeAgentStep(
      graph,
      firstNode,
      upstreamInput,
      {
        ...config,
        prompt: prompt,
      },
      defaultAgentId,
    );

    const durationMs = Date.now() - startTime;

    // Parse output back into individual step outputs
    const stepOutputs = parseCollapsedOutput(output, unit.nodeIds.length);

    // Record state for each node in the chain
    for (let i = 0; i < unit.nodeIds.length; i++) {
      const nodeId = unit.nodeIds[i];
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const nodeState = createNodeRunState(nodeId);
      nodeState.startedAt = startTime;
      nodeState.output = stepOutputs[i];
      nodeState.status = 'success';
      nodeState.finishedAt = Date.now();
      nodeState.durationMs = durationMs;
      runState.nodeStates.set(nodeId, nodeState);

      node.status = 'success';
      deps.callbacks.onNodeStatusChange(nodeId, 'success');

      deps.callbacks.onEvent({
        type: 'step-complete',
        runId: runState.runId,
        nodeId,
        output: stepOutputs[i],
        durationMs,
      });

      runState.outputLog.push({
        nodeId,
        nodeLabel: node.label,
        nodeKind: node.kind,
        status: 'success',
        output: stepOutputs[i],
        durationMs,
        timestamp: Date.now(),
      });

      deps.recordEdgeValues(graph, nodeId);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Mark all nodes in the group as error
    for (const nodeId of unit.nodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const nodeState = createNodeRunState(nodeId);
      nodeState.status = 'error';
      nodeState.error = errorMsg;
      nodeState.finishedAt = Date.now();
      nodeState.durationMs = Date.now() - startTime;
      runState.nodeStates.set(nodeId, nodeState);

      node.status = 'error';
      deps.callbacks.onNodeStatusChange(nodeId, 'error');
    }

    deps.callbacks.onEvent({
      type: 'step-error',
      runId: runState.runId,
      nodeId: firstNodeId,
      error: errorMsg,
      durationMs: Date.now() - startTime,
    });
  } finally {
    // Deactivate edges
    for (const nodeId of unit.nodeIds) {
      const inEdges = graph.edges.filter((e) => e.to === nodeId);
      for (const e of inEdges) {
        e.active = false;
        deps.callbacks.onEdgeActive(e.id, false);
      }
    }
  }
}

// ── Convergent Mesh Execution ──────────────────────────────────────────────

/**
 * Execute a mesh unit — multiple agents iterate in rounds until their
 * outputs converge (similarity exceeds threshold) or max iterations.
 */
async function executeMeshRounds(
  deps: ConductorDeps,
  graph: FlowGraph,
  unit: ExecutionUnit,
  nodeMap: Map<string, FlowNode>,
  defaultAgentId?: string,
): Promise<void> {
  const runState = deps.getRunState();
  if (!runState) return;

  const maxIterations = unit.maxIterations ?? 5;
  const convergenceThreshold = 0.85;
  let prevOutputs = new Map<string, string>();
  const meshContext: string[] = [];

  // Mark mesh nodes as running
  for (const nodeId of unit.nodeIds) {
    const node = nodeMap.get(nodeId);
    if (node) {
      node.status = 'running';
      deps.callbacks.onNodeStatusChange(nodeId, 'running');
    }
  }

  for (let round = 1; round <= maxIterations; round++) {
    if (deps.isAborted()) break;

    const currOutputs = new Map<string, string>();

    // Execute each node in the mesh with shared context
    for (const nodeId of unit.nodeIds) {
      if (deps.isAborted()) break;
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const config = getNodeExecConfig(node);

      // Build context: all previous outputs from other mesh members
      const contextParts = [`[Convergent Mesh — Round ${round}/${maxIterations}]`];
      if (meshContext.length > 0) {
        contextParts.push('[Previous round outputs]');
        contextParts.push(meshContext.join('\n---\n'));
      }
      const upstreamInput = contextParts.join('\n\n');

      const output = await deps.executeAgentStep(
        graph,
        node,
        upstreamInput,
        config,
        defaultAgentId,
      );
      currOutputs.set(nodeId, output);

      // Update node state
      const nodeState = createNodeRunState(nodeId);
      nodeState.output = output;
      nodeState.status = 'success';
      nodeState.startedAt = Date.now();
      nodeState.finishedAt = Date.now();
      runState.nodeStates.set(nodeId, nodeState);

      deps.callbacks.onEvent({
        type: 'step-progress',
        runId: runState.runId,
        nodeId,
        delta: `[Round ${round}] ${output.slice(0, 100)}`,
      });
    }

    // Build mesh context for next round
    meshContext.length = 0;
    for (const [nodeId, output] of currOutputs) {
      const node = nodeMap.get(nodeId);
      meshContext.push(`${node?.label ?? nodeId}: ${output}`);
    }

    // Check convergence
    if (checkConvergence(prevOutputs, currOutputs, convergenceThreshold)) {
      console.debug(`[conductor-mesh] Converged at round ${round}`);
      break;
    }

    prevOutputs = currOutputs;
  }

  // Mark mesh nodes as complete
  for (const nodeId of unit.nodeIds) {
    const node = nodeMap.get(nodeId);
    if (node) {
      node.status = 'success';
      deps.callbacks.onNodeStatusChange(nodeId, 'success');

      const nodeState = runState.nodeStates.get(nodeId);
      if (nodeState) {
        deps.callbacks.onEvent({
          type: 'step-complete',
          runId: runState.runId,
          nodeId,
          output: nodeState.output,
          durationMs: nodeState.durationMs,
        });

        runState.outputLog.push({
          nodeId,
          nodeLabel: node.label,
          nodeKind: node.kind,
          status: 'success',
          output: nodeState.output,
          durationMs: nodeState.durationMs,
          timestamp: Date.now(),
        });
      }

      deps.recordEdgeValues(graph, nodeId);
    }
  }
}

// ── Tesseract Unit Execution ───────────────────────────────────────────────

/**
 * Execute a Tesseract unit — 4D hyper-dimensional flow execution.
 *
 * Walks the TesseractStrategy execution order:
 * - **cells** steps: all referenced cells run in parallel (Y dimension),
 *   each using its own pre-compiled Conductor strategy.
 * - **horizon** steps: hard sync barriers that collect outputs from
 *   feeding cells, apply a merge policy, and optionally trigger
 *   a phase transition for downstream cells.
 */
async function executeTesseractUnit(
  deps: ConductorDeps,
  graph: FlowGraph,
  strategy: TesseractStrategy,
  nodeMap: Map<string, FlowNode>,
  defaultAgentId?: string,
): Promise<void> {
  const runState = deps.getRunState();
  if (!runState) return;

  // ── Cell-scoped memory pre-recall ──────────────────────────────────
  // Build a focused memory query per cell from its agent prompts, then
  // resolve it against long-term memory via deps.searchMemory.  Results
  // are stored as immutable strings keyed by cellId — no shared-state
  // mutation, so parallel cells never race on runState.memoryContext.
  const resolvedCellMemory = new Map<string, string>();

  if (deps.searchMemory && strategy.cells.length > 1) {
    // Resolve the primary agent for scoped memory access
    const primaryAgentId = graph.nodes.find((n) => n.kind === 'agent')?.config?.agentId as
      | string
      | undefined;

    // Build queries in parallel, then resolve all at once
    const queries: Array<{ cellId: string; query: string }> = [];
    for (const cell of strategy.cells) {
      const agentNodes = cell.subgraph.nodes.filter((n) => n.kind === 'agent');
      if (agentNodes.length === 0) continue;

      const queryParts = [cell.subgraph.name ?? ''];
      for (const an of agentNodes.slice(0, 3)) {
        const cfg = getNodeExecConfig(an);
        if (cfg.prompt) queryParts.push(cfg.prompt.slice(0, 200));
      }
      const cellQuery = queryParts.join(' ').trim().slice(0, 300);
      if (cellQuery) queries.push({ cellId: cell.id, query: cellQuery });
    }

    // Resolve all cell memory queries concurrently (best-effort)
    await Promise.all(
      queries.map(async ({ cellId, query }) => {
        try {
          const resolved = await deps.searchMemory!(query, primaryAgentId);
          if (resolved) {
            resolvedCellMemory.set(cellId, resolved);
            // Also record in runState for observability/debugging
            runState.cellMemoryContexts.set(cellId, resolved);
          }
        } catch {
          // Cell memory resolution is best-effort — fall back to flow-wide context
        }
      }),
    );
  }

  /** Maps cellId → latest output produced by that cell. */
  const cellOutputs = new Map<string, string>();

  for (const step of strategy.executionOrder) {
    if (deps.isAborted()) break;

    if (step.kind === 'cells') {
      await executeTesseractCellsStep(
        deps,
        graph,
        strategy,
        step,
        nodeMap,
        cellOutputs,
        resolvedCellMemory,
        defaultAgentId,
      );
    } else {
      // step.kind === 'horizon'
      await executeTesseractHorizonStep(
        deps,
        graph,
        strategy,
        step,
        nodeMap,
        cellOutputs,
        defaultAgentId,
      );
    }
  }
}

/** Default per-cell timeout: 5 minutes. Override via node config `cellTimeoutMs`. */
const DEFAULT_CELL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Execute a 'cells' step — launch referenced cells in parallel.
 * Each cell has its own pre-compiled strategy; we reuse
 * `runConductorStrategy` on a cell-scoped subgraph.
 *
 * Cell-scoped memory: instead of mutating the shared `runState.memoryContext`,
 * each cell receives a per-cell `ConductorDeps` wrapper that threads its
 * resolved memory context through `executeNode` / `executeAgentStep` overrides.
 * This eliminates the `Promise.all` race on the shared field.
 *
 * Per-cell timeout: each cell races against a configurable deadline
 * (default 5 min) to prevent a single stalled cell from blocking the horizon.
 */
async function executeTesseractCellsStep(
  deps: ConductorDeps,
  graph: FlowGraph,
  strategy: TesseractStrategy,
  step: TesseractExecutionStep & { kind: 'cells' },
  _nodeMap: Map<string, FlowNode>,
  cellOutputs: Map<string, string>,
  resolvedCellMemory: Map<string, string>,
  defaultAgentId?: string,
): Promise<void> {
  const runState = deps.getRunState();
  if (!runState) return;

  const cellTasks = step.cellIds.map(async (cellId) => {
    if (deps.isAborted()) return;
    const cell = strategy.cells.find((c) => c.id === cellId);
    if (!cell) return;

    // Build a scoped FlowGraph for the cell's subgraph
    const cellGraph: FlowGraph = {
      ...graph,
      nodes: graph.nodes.filter((n) => cell.originalNodeIds.includes(n.id)),
      edges: graph.edges.filter(
        (e) => cell.originalNodeIds.includes(e.from) && cell.originalNodeIds.includes(e.to),
      ),
    };

    // Create per-cell deps with memory override — no shared-state mutation.
    // If this cell has resolved memory, wrap deps to thread it as overrides;
    // otherwise fall through to flow-wide memoryContext via the original deps.
    const cellMemory = resolvedCellMemory.get(cellId);
    const cellDeps: ConductorDeps = cellMemory
      ? {
          ...deps,
          executeNode: (g, n, aid?, _mco?) => deps.executeNode(g, n, aid, cellMemory),
          executeAgentStep: (g, n, i, c, aid?, _mco?) =>
            deps.executeAgentStep(g, n, i, c, aid, cellMemory),
        }
      : deps;

    deps.callbacks.onEvent({
      type: 'step-start',
      runId: runState.runId,
      stepIndex: runState.currentStep,
      nodeId: cell.id,
      nodeLabel: `Tesseract Cell [${cell.id}] phase=${cell.phase}`,
      nodeKind: 'agent',
    });

    const startTime = Date.now();

    // Resolve cell timeout from config or default
    const timeoutMs =
      (cell.subgraph.nodes[0]?.config?.cellTimeoutMs as number) ?? DEFAULT_CELL_TIMEOUT_MS;

    try {
      // Race cell execution against a timeout deadline
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Tesseract cell [${cellId}] timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });

      try {
        await Promise.race([
          runConductorStrategy(cellDeps, cellGraph, cell.strategy, defaultAgentId),
          timeoutPromise,
        ]);
      } finally {
        clearTimeout(timeoutHandle);
      }
    } catch (err) {
      // On timeout or error, record as failed output rather than crashing the flow
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[tesseract] Cell ${cellId} failed: ${errMsg}`);
      cellOutputs.set(cellId, `[Cell error: ${errMsg}]`);

      deps.callbacks.onEvent({
        type: 'step-complete',
        runId: runState.runId,
        nodeId: cell.id,
        output: `[Cell error: ${errMsg.slice(0, 150)}]`,
        durationMs: Date.now() - startTime,
      });

      return;
    }

    // Collect the cell's final output from the sink node (no outgoing edges)
    const sinkNodeId = findCellSinkNode(cell, graph);
    const lastNodeState = runState.nodeStates.get(sinkNodeId);
    const cellOutput = lastNodeState?.output ?? '';
    cellOutputs.set(cellId, cellOutput);

    deps.callbacks.onEvent({
      type: 'step-complete',
      runId: runState.runId,
      nodeId: cell.id,
      output: cellOutput.slice(0, 200),
      durationMs: Date.now() - startTime,
    });
  });

  await Promise.all(cellTasks);
}

/**
 * Execute a 'horizon' step — sync barrier between cells.
 * Collects outputs from feeding cells, applies the merge policy,
 * and records the result on the event-horizon node.
 */
async function executeTesseractHorizonStep(
  deps: ConductorDeps,
  graph: FlowGraph,
  strategy: TesseractStrategy,
  step: TesseractExecutionStep & { kind: 'horizon' },
  nodeMap: Map<string, FlowNode>,
  cellOutputs: Map<string, string>,
  defaultAgentId?: string,
): Promise<void> {
  const runState = deps.getRunState();
  if (!runState) return;

  const horizon = strategy.horizons.find((h) => h.id === step.horizonId);
  if (!horizon) return;

  const horizonNode = nodeMap.get(horizon.id);
  if (horizonNode) {
    horizonNode.status = 'running';
    deps.callbacks.onNodeStatusChange(horizon.id, 'running');
  }

  const startTime = Date.now();

  // Collect outputs from all cells that feed into this horizon
  const feedingOutputMap = new Map<string, string>();
  for (const cellId of horizon.cellIds) {
    const output = cellOutputs.get(cellId);
    if (output) feedingOutputMap.set(cellId, output);
  }

  // Apply merge policy
  let mergedOutput: string;
  if (horizon.mergePolicy === 'synthesize' && feedingOutputMap.size > 0) {
    // Synthesize requires an LLM call — build a synthesis prompt
    const synthPrompt = mergeAtHorizon(feedingOutputMap, 'synthesize');
    const synthNode = horizonNode ?? graph.nodes.find((n) => n.kind === 'agent');
    if (synthNode) {
      const config = getNodeExecConfig(synthNode);
      mergedOutput = await deps.executeAgentStep(
        graph,
        synthNode,
        synthPrompt,
        { ...config, prompt: synthPrompt },
        defaultAgentId,
      );
    } else {
      // Fallback to concat if no agent node available
      mergedOutput = mergeAtHorizon(feedingOutputMap, 'concat');
    }
  } else {
    mergedOutput = mergeAtHorizon(feedingOutputMap, horizon.mergePolicy);
  }

  // Record on the horizon node
  const nodeState = createNodeRunState(horizon.id);
  nodeState.output = mergedOutput;
  nodeState.status = 'success';
  nodeState.startedAt = startTime;
  nodeState.finishedAt = Date.now();
  nodeState.durationMs = nodeState.finishedAt - startTime;
  runState.nodeStates.set(horizon.id, nodeState);

  if (horizonNode) {
    horizonNode.status = 'success';
    deps.callbacks.onNodeStatusChange(horizon.id, 'success');
  }

  // The merged output becomes the upstream input for downstream cells
  // by setting it as the output of the horizon, which downstream nodes read
  deps.callbacks.onEvent({
    type: 'step-complete',
    runId: runState.runId,
    nodeId: horizon.id,
    output: mergedOutput.slice(0, 200),
    durationMs: nodeState.durationMs,
  });

  runState.outputLog.push({
    nodeId: horizon.id,
    nodeLabel: horizonNode?.label ?? `Event Horizon`,
    nodeKind: 'event-horizon',
    status: 'success',
    output: mergedOutput,
    durationMs: nodeState.durationMs,
    timestamp: Date.now(),
  });

  deps.recordEdgeValues(graph, horizon.id);

  // Phase transition — parsed and validated but not yet applied to downstream
  // cells. Behavioral mode switching requires defining semantic meaning for
  // phase numbers (e.g., 0 = explore, 1 = refine). Logged for observability;
  // wire up when phase semantics are stabilized.
  if (horizon.phaseTransition !== undefined) {
    console.debug(
      `[tesseract] Phase transition at horizon ${horizon.id}: phase → ${horizon.phaseTransition}`,
    );
  }
}
