/**
 * @module
 * Post-workflow node execution: nodes with `run_on` (always/success/failure)
 * execute after all DAG levels complete. Also runs the on_failure_script hook.
 * Entry point: {@link executePostWorkflow}.
 */

import type { NodeConfig, RunState } from "./types.ts";
import type { OutputManager } from "./output.ts";
import { topoSort } from "./dag.ts";
import { isNodeCompleted, markNodeSkipped } from "./state.ts";

/**
 * Collect node IDs with `run_on` set from workflow config.
 * These nodes execute in a final post-workflow step after all DAG levels complete.
 */
export function collectPostWorkflowNodes(
  nodes: Record<string, NodeConfig>,
): string[] {
  return Object.entries(nodes)
    .filter(([_, node]) => node.run_on !== undefined)
    .map(([id]) => id);
}

/**
 * Sort post-workflow nodes topologically using their `inputs` field.
 * Only considers dependencies within the post-workflow subset.
 * Guarantees e.g. post-B (inputs: [post-A]) runs after post-A.
 */
export function sortPostWorkflowNodes(
  postWorkflowIds: string[],
  nodes: Record<string, NodeConfig>,
): string[] {
  const subset = new Set(postWorkflowIds);
  const deps = new Map<string, Set<string>>();
  for (const id of postWorkflowIds) {
    const node = nodes[id];
    const internalInputs = (node.inputs ?? []).filter((inp) => subset.has(inp));
    deps.set(id, new Set(internalInputs));
  }
  const levels = topoSort(deps);
  return levels.flat();
}

/**
 * Execute the on_failure_script hook (domain-agnostic).
 * Swallows errors — failure hook must not crash the engine.
 */
export async function runFailureHook(
  script: string | undefined,
  output: OutputManager,
  cwd?: string,
): Promise<void> {
  if (!script) return;
  try {
    const cmd = new Deno.Command(script, {
      stdout: "piped",
      stderr: "piped",
      ...(cwd ? { cwd } : {}),
    });
    const result = await cmd.output();
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (stdout) output.status("engine", `Hook stdout: ${stdout}`);
    if (stderr) output.warn(`Hook stderr: ${stderr}`);
    if (!result.success) {
      output.warn(`Failure hook exited with code ${result.code}`);
    } else {
      output.status("engine", "Failure hook completed");
    }
  } catch (err) {
    output.warn(`Failure hook error: ${(err as Error).message}`);
  }
}

/** Options for executePostWorkflow. */
export interface PostWorkflowOptions {
  nodeIds: string[];
  nodes: Record<string, NodeConfig>;
  state: RunState;
  workflowSuccess: boolean;
  failureScript?: string;
  output: OutputManager;
  /** Execute a single node by ID. Errors are swallowed by executePostWorkflow. */
  executeNode: (nodeId: string) => Promise<boolean>;
  /** Mark a filtered post-workflow node as skipped. */
  nodeSkipped?: (nodeId: string) => Promise<void>;
  /** Working directory for hooks (worktree path or undefined for CWD). */
  cwd?: string;
}

/**
 * Execute post-workflow nodes (those with `run_on` set).
 * Runs failure hook if workflow failed, then executes each node filtered by run_on condition.
 * Node errors are swallowed — post-workflow failures must not block finalization.
 */
export async function executePostWorkflow(
  opts: PostWorkflowOptions,
): Promise<void> {
  const {
    nodeIds,
    nodes,
    state,
    workflowSuccess,
    failureScript,
    output,
    executeNode,
    nodeSkipped: skipNode,
    cwd,
  } = opts;

  if (nodeIds.length === 0) return;

  if (!workflowSuccess) {
    await runFailureHook(failureScript, output, cwd);
  }

  for (const nodeId of nodeIds) {
    if (isNodeCompleted(state, nodeId)) continue;

    const nodeRunOn = nodes[nodeId].run_on;
    if (nodeRunOn === "success" && !workflowSuccess) {
      if (skipNode) {
        await skipNode(nodeId);
      } else {
        markNodeSkipped(state, nodeId);
      }
      output.nodeSkipped(nodeId, "skipped: run_on=success but workflow failed");
      continue;
    }
    if (nodeRunOn === "failure" && workflowSuccess) {
      if (skipNode) {
        await skipNode(nodeId);
      } else {
        markNodeSkipped(state, nodeId);
      }
      output.nodeSkipped(
        nodeId,
        "skipped: run_on=failure but workflow succeeded",
      );
      continue;
    }

    try {
      await executeNode(nodeId);
    } catch (err) {
      output.warn(
        `Post-workflow node ${nodeId} failed: ${(err as Error).message}`,
      );
    }
  }
}
