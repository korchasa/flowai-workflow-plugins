/**
 * @module
 * Node executor functions for the engine.
 * Encapsulates all node-type-specific execution logic, keeping engine.ts as a
 * pure orchestrator (config loading, state management, level iteration).
 */
import type { AgentResult } from "./agent.ts";
import { resolveInputArtifacts, runAgent } from "./agent.ts";
import { resolveBudget, resolveToolFilter } from "./config.ts";
import { runWithGuardrail } from "./guardrail.ts";
import { handleAgentHitl } from "./hitl-handler.ts";
import { isHitlConfigured } from "./hitl.ts";
import { runHuman } from "./human.ts";
import { findDirtyMemoryFiles, formatMemoryViolation } from "./memory-check.ts";
import type { UserInput } from "./human.ts";
import { saveAgentLog } from "./log.ts";
import { runLoop } from "./loop.ts";
import type { OutputManager } from "./output.ts";
import { resolveRuntimeConfig } from "@korchasa/ai-ide-cli/runtime";
import {
  appendAttemptCompleted,
  resultExcerpt,
  type RunJournalWriter,
} from "./run-journal.ts";
import {
  getNodeDir,
  getRunDir,
  markRunAborted,
  type PhaseRegistry,
  workPath,
} from "./state.ts";
import type {
  EngineOptions,
  ErrorCategory,
  NodeConfig,
  NodeSettings,
  RunState,
  TemplateContext,
  WorkflowConfig,
} from "./types.ts";

/** Parameter bag passed to every node executor function. */
export interface EngineContext {
  config: WorkflowConfig;
  state: RunState;
  output: OutputManager;
  options: EngineOptions;
  userInput: UserInput;
  /** Build template context for a given node (with optional loop iteration). */
  buildContext: (nodeId: string, loopIteration?: number) => TemplateContext;
  /** Working directory (worktree path or "."). All subprocesses and I/O use this. */
  workDir: string;
  /** Workflow folder (containing `workflow.yaml`). FR-S47/FR-E9: threaded into
   * state-path calls so runs land under `<workflowDir>/runs/<run-id>` regardless
   * of project layout. */
  workflowDir: string;
  /** Per-run phase registry (FR-E59). Threaded to
   * every `getNodeDir`/`buildTaskPaths` call so two back-to-back
   * `Engine.run()` calls in one Deno process keep their mappings isolated. */
  phaseRegistry: PhaseRegistry;
  /** Durable lifecycle journal for this run. */
  journal?: RunJournalWriter;
  /** Mark a node as running and publish optional lifecycle callback. */
  nodeStarted: (nodeId: string) => Promise<void>;
  /** Mark a node as completed and publish optional lifecycle callback. */
  nodeCompleted: (
    nodeId: string,
    costUsd?: number,
    result?: string,
  ) => Promise<void>;
  /** Mark a node as failed and publish optional lifecycle callback. */
  nodeFailed: (
    nodeId: string,
    error: string,
    errorCategory?: ErrorCategory,
  ) => Promise<void>;
  /** Mark a node as waiting and publish optional lifecycle callback. */
  nodeWaiting: (
    nodeId: string,
    sessionId: string,
    questionJson: string,
  ) => Promise<void>;
}

/** Run an agent node: invoke Claude CLI, handle HITL if triggered, save logs. */
export async function executeAgentNode(
  eng: EngineContext,
  nodeId: string,
  node: NodeConfig,
  wasWaiting = false,
): Promise<AgentResult | null> {
  const ctx = eng.buildContext(nodeId);
  const settings = node.settings as Required<NodeSettings>;
  const hitlConfig = isHitlConfigured(eng.config.defaults?.hitl)
    ? eng.config.defaults.hitl
    : undefined;
  const runtimeConfig = resolveRuntimeConfig({
    defaults: eng.config.defaults,
    node,
  });
  const toolFilter = resolveToolFilter(node, eng.config.defaults);
  const cwd = eng.workDir !== "." ? eng.workDir : undefined;

  // Resume path: node was waiting for human reply
  if (wasWaiting) {
    await eng.journal?.append({ kind: "attempt_started", node_id: nodeId });
    if (!hitlConfig) {
      await eng.nodeFailed(
        nodeId,
        "HITL detected but defaults.hitl not configured in workflow.yaml",
        "unknown",
      );
      return null;
    }
    const result = await handleAgentHitl({
      mode: "resume",
      nodeId,
      hitlConfig,
      state: eng.state,
      workflowDir: eng.workflowDir,
      node,
      ctx,
      settings,
      runtime: runtimeConfig.runtime,
      runtimeArgs: runtimeConfig.args,
      permissionMode: runtimeConfig.permissionMode,
      model: runtimeConfig.model,
      reasoningEffort: runtimeConfig.reasoningEffort,
      allowedTools: toolFilter.allowedTools,
      disallowedTools: toolFilter.disallowedTools,
      output: eng.output,
      cwd,
      maxTurns: resolveBudget(node, eng.config.defaults)?.max_turns,
      processRegistry: eng.options.processRegistry,
      nodeFailed: eng.nodeFailed,
      nodeWaiting: eng.nodeWaiting,
    });
    await appendAttemptCompleted(eng.journal, nodeId, result);
    return result;
  }

  // Normal path: run agent
  // Verbose: resolve and show input artifacts
  const inputArtifacts = await resolveInputArtifacts(ctx.input, eng.workDir);
  eng.output.verboseInputs(nodeId, inputArtifacts);

  const streamLogPath = `${workPath(ctx.workDir, ctx.node_dir)}/stream.log`;

  // FR-E50: wrap runAgent in worktree-isolation guardrail. Snapshots main
  // tree before/after; if the agent wrote files outside workDir and outside
  // node.allowed_paths, roll them back and fail the node.
  await eng.journal?.append({ kind: "attempt_started", node_id: nodeId });
  const { result, leak } = await runWithGuardrail(
    {
      repoRoot: Deno.cwd(),
      workDir: eng.workDir,
      allowedPaths: node.allowed_paths ?? [],
      nodeId,
      log: (m) => eng.output.warn(m),
    },
    () =>
      runAgent({
        node,
        ctx,
        settings,
        runtime: runtimeConfig.runtime,
        runtimeArgs: runtimeConfig.args,
        permissionMode: runtimeConfig.permissionMode,
        model: runtimeConfig.model,
        reasoningEffort: runtimeConfig.reasoningEffort,
        allowedTools: toolFilter.allowedTools,
        disallowedTools: toolFilter.disallowedTools,
        hitlConfig,
        output: eng.output,
        nodeId,
        streamLogPath,
        verbosity: eng.options.verbosity,
        cwd,
        maxTurns: resolveBudget(node, eng.config.defaults)?.max_turns,
        processRegistry: eng.options.processRegistry,
      }),
  );

  if (leak !== undefined) {
    await eng.nodeFailed(nodeId, leak.message, "scope_violation");
    const failed: AgentResult = {
      ...result,
      success: false,
      error: leak.message,
      error_category: "scope_violation",
    };
    await appendAttemptCompleted(eng.journal, nodeId, failed);
    return failed;
  }

  if (!result.success) {
    await eng.nodeFailed(
      nodeId,
      result.error ?? "Agent failed",
      result.error_category ?? "unknown",
    );
    await appendAttemptCompleted(eng.journal, nodeId, result);
    return result;
  }

  // FR-S28: per-agent reflection-memory commit-step enforcement. After a
  // successful agent run inside a worktree, any path matching the
  // configured `defaults.memory_paths` globs MUST be either unchanged or
  // committed by the agent itself. Loop-body agents may opt out via
  // `memory_commit_deferred: true` on the node.
  const memoryPaths = eng.config.defaults?.memory_paths ?? [];
  if (
    eng.workDir !== "." &&
    memoryPaths.length > 0 &&
    node.memory_commit_deferred !== true
  ) {
    const dirtyMemory = await findDirtyMemoryFiles(eng.workDir, memoryPaths);
    if (dirtyMemory.length > 0) {
      const msg = formatMemoryViolation(nodeId, dirtyMemory);
      eng.output.warn(msg);
      await eng.nodeFailed(nodeId, msg, "scope_violation");
      const failed: AgentResult = {
        ...result,
        success: false,
        error: msg,
        error_category: "scope_violation",
      };
      await appendAttemptCompleted(eng.journal, nodeId, failed);
      return failed;
    }
  }

  // FR-L35 / hitl-via-engine-mcp: HITL request was captured by the engine's
  // `onToolUseObserved` observer in agent.ts (replaces the legacy
  // `permission_denials` AskUserQuestion path). Route to the handler when
  // present.
  if (result.hitl_question && result.output) {
    if (!hitlConfig) {
      await eng.nodeFailed(
        nodeId,
        "Agent called request_human_input but defaults.hitl not configured in workflow.yaml",
        "unknown",
      );
      return null;
    }
    const hitlResult = await handleAgentHitl({
      mode: "detect",
      nodeId,
      hitlQuestion: result.hitl_question,
      agentSessionId: result.output.session_id,
      hitlConfig,
      state: eng.state,
      workflowDir: eng.workflowDir,
      node,
      ctx,
      settings,
      runtime: runtimeConfig.runtime,
      runtimeArgs: runtimeConfig.args,
      permissionMode: runtimeConfig.permissionMode,
      model: runtimeConfig.model,
      reasoningEffort: runtimeConfig.reasoningEffort,
      allowedTools: toolFilter.allowedTools,
      disallowedTools: toolFilter.disallowedTools,
      output: eng.output,
      cwd,
      maxTurns: resolveBudget(node, eng.config.defaults)?.max_turns,
      processRegistry: eng.options.processRegistry,
      nodeFailed: eng.nodeFailed,
      nodeWaiting: eng.nodeWaiting,
    });
    await appendAttemptCompleted(eng.journal, nodeId, hitlResult);
    return hitlResult;
  }

  if (result.session_id) {
    eng.state.nodes[nodeId].session_id = result.session_id;
  }
  eng.state.nodes[nodeId].continuations = result.continuations;

  // Save agent log (JSON output + JSONL transcript)
  if (result.output) {
    const runDir = workPath(
      eng.workDir,
      getRunDir(eng.state.run_id, eng.workflowDir),
    );
    await saveAgentLog(runDir, nodeId, result.output);
  }

  await appendAttemptCompleted(eng.journal, nodeId, result);
  return result;
}

/** Merge inputs by copying each input directory into the merge node's output dir. */
export async function executeMergeNode(
  eng: EngineContext,
  nodeId: string,
  node: NodeConfig,
): Promise<boolean> {
  const nodeDir = workPath(
    eng.workDir,
    getNodeDir(eng.state.run_id, nodeId, eng.workflowDir, eng.phaseRegistry),
  );
  await Deno.mkdir(nodeDir, { recursive: true });

  // Copy input directories as subdirectories
  for (const inputId of node.inputs ?? []) {
    const inputDir = workPath(
      eng.workDir,
      getNodeDir(
        eng.state.run_id,
        inputId,
        eng.workflowDir,
        eng.phaseRegistry,
      ),
    );
    const targetDir = `${nodeDir}/${inputId}`;
    try {
      await copyDir(inputDir, targetDir);
    } catch {
      // Input may not have produced files
    }
  }

  return true;
}

/** Delegate to runLoop(), then record iteration count and failure state. */
export async function executeLoopNode(
  eng: EngineContext,
  nodeId: string,
  _node: NodeConfig,
): Promise<boolean> {
  const result = await runLoop({
    loopNodeId: nodeId,
    config: eng.config,
    state: eng.state,
    budgetUsd: eng.options.budget_usd,
    buildCtx: (bodyNodeId, iteration) =>
      eng.buildContext(bodyNodeId, iteration),
    onNodeStart: (id, iteration) =>
      eng.output.status(id, `STARTED (iteration ${iteration})`),
    onNodeComplete: (id, iteration, result) => {
      if (result.success) {
        eng.output.status(id, "COMPLETED");
        if (result.output) {
          eng.output.nodeResult(id, result.output);
          if (id in eng.state.nodes) {
            eng.state.nodes[id].result = resultExcerpt(
              result.output.result ?? "",
            );
          }
        }
      } else {
        eng.output.nodeFailed(id, result.error ?? "Failed");
      }

      // Save agent log for successful loop body nodes (iteration-qualified)
      if (result.success && result.output) {
        const runDir = workPath(
          eng.workDir,
          getRunDir(eng.state.run_id, eng.workflowDir),
        );
        const iterNodeId = `${id}-iter-${iteration}`;
        saveAgentLog(runDir, iterNodeId, result.output).catch((err) => {
          eng.output.warn(
            `Failed to save log for ${iterNodeId}: ${(err as Error).message}`,
          );
        });
      }
    },
    onIteration: (iteration, maxIterations) =>
      eng.output.loopIteration(nodeId, iteration, maxIterations),
    output: eng.output,
    verbosity: eng.options.verbosity,
    cwd: eng.workDir !== "." ? eng.workDir : undefined,
    nodeStarted: async (id) => {
      await eng.nodeStarted(id);
    },
    nodeCompleted: async (id, costUsd, result) => {
      await eng.nodeCompleted(id, costUsd, result);
    },
    nodeFailed: async (id, error, errorCategory) => {
      await eng.nodeFailed(id, error, errorCategory);
    },
    onIterationStarted: async (iteration, maxIterations) => {
      await eng.journal?.append({
        kind: "loop_iteration_started",
        loop_node_id: nodeId,
        iteration,
        max_iterations: maxIterations,
      });
    },
    onIterationCompleted: async (iteration) => {
      await eng.journal?.append({
        kind: "loop_iteration_completed",
        loop_node_id: nodeId,
        iteration,
      });
    },
    onIterationFailed: async (iteration, error, errorCategory) => {
      await eng.journal?.append({
        kind: "loop_iteration_failed",
        loop_node_id: nodeId,
        iteration,
        error,
        error_category: errorCategory,
      });
    },
    onAttemptStarted: async (id, iteration) => {
      await eng.journal?.append({
        kind: "attempt_started",
        node_id: id,
        iteration,
      });
    },
    onAttemptCompleted: async (id, iteration, result) => {
      await appendAttemptCompleted(eng.journal, id, result, iteration);
    },
  });

  if (!result.success) {
    await eng.nodeFailed(
      nodeId,
      result.error ?? "Loop failed",
      result.error_category ?? "unknown",
    );
  }
  eng.state.nodes[nodeId].iteration = result.iterations;

  return result.success;
}

/** Prompt the user for input and abort the run if response matches abort_on. */
export async function executeHumanNode(
  eng: EngineContext,
  nodeId: string,
  node: NodeConfig,
): Promise<boolean> {
  const ctx = eng.buildContext(nodeId);
  const result = await runHuman(node, ctx, eng.userInput);

  if (result.aborted) {
    markRunAborted(eng.state);
    await eng.nodeFailed(
      nodeId,
      `Aborted by user (response: ${result.response})`,
      "aborted",
    );
    return false;
  }

  return result.success;
}

/** Recursively copy a directory. */
export async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const srcPath = `${src}/${entry.name}`;
    const destPath = `${dest}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDir(srcPath, destPath);
    } else {
      await Deno.copyFile(srcPath, destPath);
    }
  }
}
