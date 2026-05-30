/**
 * @module
 * DAG construction and topological sorting for workflow execution ordering.
 * Builds execution levels from node dependencies: each level is a set of
 * node IDs that can run in parallel. Loop body nodes are excluded from the
 * main DAG — managed by the loop executor internally.
 * Entry points: {@link buildLevels}, {@link buildLoopBodyOrder}.
 */

import type { WorkflowConfig } from "./types.ts";

/** Nodes grouped into parallel execution levels. */
export type ExecutionLevels = string[][];

/** Build execution levels from workflow config via topological sort. */
export function buildLevels(config: WorkflowConfig): ExecutionLevels {
  const loopBodyNodes = collectLoopBodyNodes(config);
  const nodeIds = Object.keys(config.nodes).filter(
    (id) => !loopBodyNodes.has(id),
  );

  // Build adjacency: node → set of nodes it depends on (inputs)
  const deps = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    const node = config.nodes[id];
    const inputs = (node.inputs ?? []).filter((inp) => !loopBodyNodes.has(inp));
    deps.set(id, new Set(inputs));
  }

  detectCycles(deps);
  return topoSort(deps);
}

/** Collect all node IDs defined inline in any loop's `nodes` sub-object. */
function collectLoopBodyNodes(config: WorkflowConfig): Set<string> {
  const bodyNodes = new Set<string>();
  for (const node of Object.values(config.nodes)) {
    if (node.type === "loop" && node.nodes) {
      for (const bodyId of Object.keys(node.nodes)) {
        bodyNodes.add(bodyId);
      }
    }
  }
  return bodyNodes;
}

/** Detect cycles using DFS. Throws on cycle detection. */
function detectCycles(deps: Map<string, Set<string>>): void {
  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;

  const state = new Map<string, number>();
  for (const id of deps.keys()) {
    state.set(id, UNVISITED);
  }

  const path: string[] = [];

  function dfs(node: string): void {
    state.set(node, IN_PROGRESS);
    path.push(node);

    for (const dep of deps.get(node) ?? []) {
      const s = state.get(dep);
      if (s === IN_PROGRESS) {
        const cycleStart = path.indexOf(dep);
        const cycle = path.slice(cycleStart).concat(dep);
        throw new Error(
          `Cycle detected in workflow DAG: ${cycle.join(" → ")}`,
        );
      }
      if (s === UNVISITED) {
        dfs(dep);
      }
    }

    path.pop();
    state.set(node, DONE);
  }

  for (const id of deps.keys()) {
    if (state.get(id) === UNVISITED) {
      dfs(id);
    }
  }
}

/**
 * Topological sort into levels (Kahn's algorithm variant).
 * Level 0: nodes with no dependencies.
 * Level N: nodes whose dependencies are all in levels < N.
 */
export function topoSort(deps: Map<string, Set<string>>): ExecutionLevels {
  const levels: ExecutionLevels = [];
  const remaining = new Map<string, Set<string>>();

  for (const [id, d] of deps) {
    remaining.set(id, new Set(d));
  }

  while (remaining.size > 0) {
    // Find nodes with no remaining dependencies
    const level: string[] = [];
    for (const [id, d] of remaining) {
      if (d.size === 0) {
        level.push(id);
      }
    }

    if (level.length === 0) {
      // Should not happen after cycle detection, but defensive
      throw new Error(
        `Cannot resolve dependencies for nodes: ${
          [...remaining.keys()].join(", ")
        }`,
      );
    }

    // Sort within level for deterministic ordering
    level.sort();
    levels.push(level);

    // Remove resolved nodes from remaining and from other nodes' deps
    const resolved = new Set(level);
    for (const id of level) {
      remaining.delete(id);
    }
    for (const d of remaining.values()) {
      for (const r of resolved) {
        d.delete(r);
      }
    }
  }

  return levels;
}

/** Get the order of body nodes for a loop, resolving internal dependencies.
 * Reads from the loop's inline `nodes` sub-object, topo-sorts by `inputs`. */
export function buildLoopBodyOrder(
  config: WorkflowConfig,
  loopNodeId: string,
): string[] {
  const loopNode = config.nodes[loopNodeId];
  if (loopNode.type !== "loop" || !loopNode.nodes) {
    throw new Error(`Node '${loopNodeId}' is not a loop node`);
  }

  const bodyNodeIds = Object.keys(loopNode.nodes);
  const bodySet = new Set(bodyNodeIds);
  const deps = new Map<string, Set<string>>();

  for (const id of bodyNodeIds) {
    const node = loopNode.nodes[id];
    // Only consider inputs that are within the loop body for ordering
    const internalInputs = (node.inputs ?? []).filter((inp) =>
      bodySet.has(inp)
    );
    deps.set(id, new Set(internalInputs));
  }

  // Use the same topo sort, but flatten into a single ordered list
  const levels = topoSort(deps);
  return levels.flat();
}
