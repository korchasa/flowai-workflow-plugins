/**
 * @module
 * Unified HITL orchestration handler for agent nodes.
 * Consolidates two paths: resume-from-waiting (node was persisted as "waiting")
 * and detect-after-run (HITL question found in agent output).
 * Delegates to {@link runHitlLoop} for the actual poll cycle.
 */

import type {
  ErrorCategory,
  HitlConfig,
  NodeConfig,
  NodeSettings,
  ProcessRegistry,
  ReasoningEffort,
  RunState,
  RuntimeId,
  TemplateContext,
} from "./types.ts";
import type {
  ExtraArgsMap,
  RuntimeAdapter,
} from "@korchasa/ai-ide-cli/runtime/types";
import type { AgentResult } from "./agent.ts";
import type { HitlQuestion } from "./hitl.ts";
import { resolve } from "@std/path";
import { runHitlLoop } from "./hitl.ts";
import { getRunDir, markNodeFailed, markNodeWaiting } from "./state.ts";
import { saveAgentLog } from "./log.ts";
import type { OutputManager } from "./output.ts";

/** Shared parameters for both HITL handler modes. */
interface HitlBaseParams {
  nodeId: string;
  hitlConfig: HitlConfig;
  state: RunState;
  /** Workflow folder (e.g., `.flowai-workflow/autonomous-sdlc`). Used to
   * resolve the absolute run-dir path passed to HITL scripts, which run
   * with cwd=workDir under worktree isolation and cannot resolve a
   * workDir-relative path back to the project-root run-dir. */
  workflowDir: string;
  node: NodeConfig;
  ctx: TemplateContext;
  settings: Required<NodeSettings>;
  runtime?: RuntimeId;
  runtimeArgs?: ExtraArgsMap;
  permissionMode?: string;
  model?: string;
  /** Resolved reasoning-effort dial (FR-E42); forwarded to runtime on resume. */
  reasoningEffort?: ReasoningEffort;
  runtimeAdapter?: RuntimeAdapter;
  output: OutputManager;
  /** Working directory for subprocesses (worktree path or undefined for CWD). */
  cwd?: string;
  /** Resolved `budget.max_turns` (FR-E47). */
  maxTurns?: number;
  /** Resolved tool whitelist (FR-E48). */
  allowedTools?: string[];
  /** Resolved tool blacklist (FR-E48). */
  disallowedTools?: string[];
  /** Caller-supplied process tracker scope
   * (FR-E60). Forwarded to the runtime adapter
   * on the resume invocation that delivers the human reply. */
  processRegistry?: ProcessRegistry;
  /** Mark a node as failed and publish optional lifecycle callback. */
  nodeFailed?: (
    nodeId: string,
    error: string,
    errorCategory?: ErrorCategory,
  ) => Promise<void>;
  /** Mark a node as waiting and publish optional lifecycle callback. */
  nodeWaiting?: (
    nodeId: string,
    sessionId: string,
    questionJson: string,
  ) => Promise<void>;
}

/** Resume-from-waiting mode: node was previously set to waiting state. */
export interface HitlResumeParams extends HitlBaseParams {
  mode: "resume";
}

/** Detect-after-run mode: HITL question detected in agent output. */
export interface HitlDetectParams extends HitlBaseParams {
  mode: "detect";
  hitlQuestion: HitlQuestion;
  agentSessionId: string;
}

/**
 * Discriminated union over the two HITL entry points.
 * Use `mode: "resume"` ({@link HitlResumeParams}) when the node was
 * persisted as `waiting` and the engine is rehydrating it from state.
 * Use `mode: "detect"` ({@link HitlDetectParams}) when a HITL question
 * was just detected in fresh agent output and additional fields
 * (`hitlQuestion`, `agentSessionId`) are required.
 */
export type HitlHandlerParams = HitlResumeParams | HitlDetectParams;

/**
 * Unified HITL orchestration handler for agent nodes.
 * Consolidates resume-from-waiting and detect-after-run paths.
 * Mutates state in place (markNodeFailed, markNodeWaiting, session_id update).
 * Returns AgentResult on success, null on failure (state already marked failed).
 */
export async function handleAgentHitl(
  params: HitlHandlerParams,
): Promise<AgentResult | null> {
  const {
    nodeId,
    hitlConfig,
    state,
    node,
    ctx,
    settings,
    runtime,
    runtimeArgs,
    permissionMode,
    model,
    reasoningEffort,
    runtimeAdapter,
    output,
    cwd,
    maxTurns,
    allowedTools,
    disallowedTools,
    processRegistry,
    workflowDir,
  } = params;
  // HITL scripts run with cwd=workDir (worktree under isolation) and write
  // bookkeeping files (`.tg_baseline`, `hitl.jsonl`) into the run-dir at
  // project root. Resolve the run-dir to an ABSOLUTE path so the script
  // finds it regardless of its own cwd — workDir-relative path would
  // resolve into the worktree (where the run-dir does not exist) and
  // ask_script would fail with "run-dir not writable". Computed via
  // getRunDir(runId, workflowDir) (engine state, no ctx coupling) so the
  // FR-E52 workPath convention stays scoped to engine FS access.
  const runDir = resolve(getRunDir(state.run_id, workflowDir));

  if (params.mode === "resume") {
    const nodeState = state.nodes[nodeId];
    if (!nodeState.session_id || !nodeState.question_json) {
      await failNode(
        params,
        nodeId,
        "Waiting node missing session_id or question_json",
        "unknown",
      );
      return null;
    }

    const question = JSON.parse(nodeState.question_json);
    const hitlResult = await runHitlLoop(
      {
        config: hitlConfig,
        nodeId,
        runId: state.run_id,
        runDir,
        env: state.env,
        sessionId: nodeState.session_id,
        question,
        node,
        ctx,
        settings,
        runtime,
        runtimeArgs,
        permissionMode,
        model,
        reasoningEffort,
        runtimeAdapter,
        output,
        cwd,
        maxTurns,
        allowedTools,
        disallowedTools,
        processRegistry,
      },
      true, /* skipAsk — question already delivered */
    );

    if (!hitlResult.success) {
      await failNode(
        params,
        nodeId,
        hitlResult.error ?? "HITL resume failed",
        hitlResult.error_category ?? "unknown",
      );
      return null;
    }

    if (hitlResult.session_id) {
      state.nodes[nodeId].session_id = hitlResult.session_id;
    }
    if (hitlResult.output) {
      await saveAgentLog(runDir, nodeId, hitlResult.output);
    }
    return hitlResult;
  }

  // mode === "detect": question detected in agent output
  const { hitlQuestion, agentSessionId } = params;
  const questionJson = JSON.stringify(hitlQuestion);

  await waitNode(params, nodeId, agentSessionId, questionJson);

  const hitlResult = await runHitlLoop(
    {
      config: hitlConfig,
      nodeId,
      runId: state.run_id,
      runDir,
      env: state.env,
      sessionId: agentSessionId,
      question: hitlQuestion,
      node,
      ctx,
      settings,
      runtime,
      runtimeArgs,
      permissionMode,
      model,
      reasoningEffort,
      runtimeAdapter,
      output,
      cwd,
      maxTurns,
      allowedTools,
      disallowedTools,
      processRegistry,
    },
    false, /* skipAsk=false — deliver question */
  );

  if (!hitlResult.success) {
    await failNode(
      params,
      nodeId,
      hitlResult.error ?? "HITL failed",
      hitlResult.error_category ?? "unknown",
    );
    return null;
  }

  if (hitlResult.session_id) {
    state.nodes[nodeId].session_id = hitlResult.session_id;
  }
  if (hitlResult.output) {
    await saveAgentLog(runDir, nodeId, hitlResult.output);
  }
  return hitlResult;
}

async function failNode(
  params: HitlHandlerParams,
  nodeId: string,
  error: string,
  errorCategory?: ErrorCategory,
): Promise<void> {
  if (params.nodeFailed) {
    await params.nodeFailed(nodeId, error, errorCategory);
    return;
  }
  markNodeFailed(params.state, nodeId, error, errorCategory);
}

async function waitNode(
  params: HitlHandlerParams,
  nodeId: string,
  sessionId: string,
  questionJson: string,
): Promise<void> {
  if (params.nodeWaiting) {
    await params.nodeWaiting(nodeId, sessionId, questionJson);
    return;
  }
  markNodeWaiting(params.state, nodeId, sessionId, questionJson);
}
