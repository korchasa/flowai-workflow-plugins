/**
 * @module
 * Human-in-the-loop (HITL) detection and poll loop.
 * Detects AskUserQuestion requests in Claude CLI output, delivers questions
 * via external ask_script, polls check_script for replies, and resumes the
 * agent session with the human response.
 * Entry points: {@link detectHitlRequest}, {@link runHitlLoop}.
 */

import type {
  CliRunOutput,
  HitlConfig,
  HumanInputRequest,
  NodeConfig,
  NodeSettings,
  ProcessRegistry,
  ReasoningEffort,
  RuntimeId,
  TemplateContext,
} from "./types.ts";
import { interpolate } from "./template.ts";
import { applyBudgetFlags } from "./agent.ts";
import type { AgentResult } from "./agent.ts";
import { getRuntimeAdapter } from "@korchasa/ai-ide-cli/runtime";
import type {
  ExtraArgsMap,
  RuntimeAdapter,
  RuntimeInvokeOptions,
} from "@korchasa/ai-ide-cli/runtime/types";
import { defaultRegistry } from "@korchasa/ai-ide-cli/process-registry";
import { workPath } from "./state.ts";
import { buildHitlMcpServers, createHitlObserver } from "./hitl-injection.ts";
import type { OutputManager } from "./output.ts";

/** Structured question extracted from a runtime-native HITL request. */
export interface HitlQuestion extends HumanInputRequest {}

/** True when workflow HITL scripts are fully configured and runnable. */
export function isHitlConfigured(config?: HitlConfig): config is HitlConfig {
  return Boolean(config?.ask_script && config?.check_script);
}

/** Script runner function signature (injectable for testing). The stderr
 * field surfaces the script's diagnostic output to the engine, which
 * embeds it into the failure message — without it, callers see only an
 * exit code and cannot diagnose what actually broke. */
export type ScriptRunner = (
  path: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;

/** Claude CLI runner function signature (injectable for testing). */
export type ClaudeRunner = (
  opts: RuntimeInvokeOptions,
) => Promise<{ output?: CliRunOutput; error?: string }>;

/** Options for running the HITL poll loop. */
export interface HitlRunOptions {
  /** HITL configuration (scripts, timeouts, polling). */
  config: HitlConfig;
  /** ID of the node awaiting human input. */
  nodeId: string;
  /** Current workflow run identifier. */
  runId: string;
  /** Filesystem path to the run's root directory. */
  runDir: string;
  /** Environment variables passed to scripts. */
  env: Record<string, string>;
  /** Claude CLI session ID to resume after receiving a reply. */
  sessionId: string;
  /** The question extracted from the agent's permission denial. */
  question: HitlQuestion;
  /** Node configuration for the agent being paused. */
  node: NodeConfig;
  /** Template context for artifact resolution. */
  ctx: TemplateContext;
  /** Resolved node settings (timeouts, retries). */
  settings: Required<NodeSettings>;
  /** Runtime used for HITL resume. Defaults to claude for backward compatibility. */
  runtime?: RuntimeId;
  /** Extra CLI flags forwarded to the selected runtime on resume. Map-shape. */
  runtimeArgs?: ExtraArgsMap;
  /** Permission mode forwarded to Claude on resume. */
  permissionMode?: string;
  /** Claude model override. Forwarded to invokeClaudeCli on resume. */
  model?: string;
  /** Resolved reasoning-effort dial (FR-E42); forwarded on resume. The
   * library skips emission when `resumeSessionId` is set (Claude). */
  reasoningEffort?: ReasoningEffort;
  /** Resolved tool whitelist (FR-E48); forwarded on resume. */
  allowedTools?: string[];
  /** Resolved tool blacklist (FR-E48); forwarded on resume. */
  disallowedTools?: string[];
  /** Injected runtime adapter for unit testing. */
  runtimeAdapter?: RuntimeAdapter;
  /** Output manager for status/progress messages. */
  output?: OutputManager;
  /** Injected script runner — defaults to real shell; override in tests. */
  scriptRunner?: ScriptRunner;
  /** Injected claude CLI runner — defaults to real invokeClaudeCli; override in tests. */
  claudeRunner?: ClaudeRunner;
  /** Working directory for subprocesses (worktree path or undefined for CWD). */
  cwd?: string;
  /** Resolved `budget.max_turns` (FR-E47) forwarded to the runtime on resume. */
  maxTurns?: number;
  /** Caller-supplied process tracker scope
   * (FR-E60). Forwarded to the runtime adapter
   * on the resume invocation that delivers the human reply. */
  processRegistry?: ProcessRegistry;
}

/**
 * Run the HITL poll loop: deliver question, poll for reply, resume agent.
 *
 * Flow:
 * 1. If !skipAsk: invoke ask_script to deliver question
 * 2. Poll: sleep(poll_interval) → check_script → exit 0 = reply in stdout
 * 3. On reply: resume agent via claude --resume <sessionId> -p "<reply>"
 * 4. On timeout: return failure
 */
export async function runHitlLoop(
  opts: HitlRunOptions,
  skipAsk = false,
): Promise<AgentResult> {
  const {
    config,
    ctx,
    nodeId,
    runId,
    runDir,
    sessionId,
    question,
    settings,
    runtime = "claude",
    runtimeArgs,
    output,
    maxTurns,
  } = opts;

  const cwdOpt = opts.cwd;
  const runner = opts.scriptRunner ??
    ((path: string, args: string[]) => defaultScriptRunner(path, args, cwdOpt));
  const adapter = opts.runtimeAdapter ?? getRuntimeAdapter(runtime);
  const runtimeRun = opts.claudeRunner ??
    ((invokeOpts: RuntimeInvokeOptions) => adapter.invoke(invokeOpts));

  if (!isHitlConfigured(config)) {
    return {
      success: false,
      continuations: 0,
      error: "defaults.hitl requires non-empty ask_script and check_script",
      error_category: "unknown",
    };
  }

  if (!adapter.capabilities.mcpInjection) {
    return {
      success: false,
      continuations: 0,
      error:
        `Runtime '${runtime}' does not support per-invocation MCP injection (capabilities.mcpInjection === false). HITL requires it.`,
      error_category: "unknown",
    };
  }

  // Step 1: Deliver question (unless resuming)
  if (!skipAsk) {
    const askArgs = buildScriptArgs(
      "ask",
      runDir,
      runId,
      nodeId,
      config,
      opts.ctx,
      question,
    );

    const askResult = await runner(config.ask_script, askArgs);
    if (askResult.exitCode !== 0) {
      return {
        success: false,
        continuations: 0,
        error: formatScriptFailure("ask_script", askResult),
        error_category: "unknown",
      };
    }
  }

  // Step 2: Poll for reply
  const deadline = Date.now() + config.timeout * 1000;

  while (Date.now() < deadline) {
    // Sleep first (give human time to respond)
    await sleep(config.poll_interval * 1000);

    if (Date.now() >= deadline) break;

    // Status update
    const elapsed = Math.round(
      (Date.now() - (deadline - config.timeout * 1000)) / 1000,
    );
    if (output) {
      output.status(nodeId, `WAITING for human reply (${elapsed}s elapsed)`);
    }

    const checkArgs = buildScriptArgs(
      "check",
      runDir,
      runId,
      nodeId,
      config,
      opts.ctx,
    );

    const checkResult = await runner(config.check_script, checkArgs);

    if (checkResult.exitCode === 0 && checkResult.stdout.trim()) {
      // Reply received — append Q+A audit artefact (FR-E64) before resume,
      // so a crash mid-resume still leaves the question on disk for the
      // post-mortem dashboard. Use ctx.node_dir wrapped with workPath
      // (FR-E52 convention) so the artefact lands in the same per-node
      // directory the engine uses for every other artefact.
      const reply = checkResult.stdout.trim();
      const nodeDirAbs = workPath(ctx.workDir, ctx.node_dir);
      await appendHitlAuditRecord(nodeDirAbs, question, reply);

      // Re-register the HITL MCP server on resume so the agent can raise
      // another HITL request inside the same session if needed (a single
      // run may legitimately HITL multiple rounds; the per-round audit
      // artefact records each).
      const resumeObserver = createHitlObserver(runtime);
      const result = await runtimeRun({
        resumeSessionId: sessionId,
        taskPrompt: reply,
        extraArgs: applyBudgetFlags(runtimeArgs, runtime, maxTurns),
        permissionMode: opts.permissionMode,
        model: opts.model,
        // FR-E42: forward effort; library filters --effort on resume.
        reasoningEffort: opts.reasoningEffort,
        allowedTools: opts.allowedTools,
        disallowedTools: opts.disallowedTools,
        mcpServers: buildHitlMcpServers(),
        onToolUseObserved: resumeObserver.observer,
        timeoutSeconds: settings.timeout_seconds,
        maxRetries: settings.max_retries,
        retryDelaySeconds: settings.retry_delay_seconds,
        cwd: cwdOpt,
        processRegistry: opts.processRegistry ?? defaultRegistry,
      });

      if (result.error) {
        return {
          success: false,
          session_id: result.output?.session_id,
          output: result.output,
          continuations: 0,
          error: result.error,
          error_category: "cli_crash",
        };
      }

      return {
        success: true,
        session_id: result.output?.session_id,
        output: result.output,
        continuations: 0,
        permission_denials: result.output?.permission_denials,
        hitl_question: resumeObserver.getQuestion() ?? undefined,
      };
    }

    // exit 1 = no reply yet; other codes = transient error, continue
    if (checkResult.exitCode !== 1 && checkResult.exitCode !== 0) {
      if (output) {
        const detail = (checkResult.stderr ?? "").trim().slice(0, 500);
        output.warn(
          `check_script returned exit code ${checkResult.exitCode} (transient error, retrying)${
            detail ? `: ${detail}` : ""
          }`,
        );
      }
    }
  }

  // Timeout
  return {
    success: false,
    continuations: 0,
    error: `HITL timeout after ${config.timeout}s waiting for human reply`,
    error_category: "hitl_timeout",
  };
}

// --- Internal helpers ---

/**
 * Append one HITL Q+A round to `<nodeDirAbs>/hitl.jsonl` (FR-E64).
 * Round counter is reconstructed from existing line count so resume after
 * crash continues numbering correctly. Atomic on POSIX append (single
 * `writeTextFile` call with `append: true`).
 *
 * Caller wraps `ctx.node_dir` with {@link workPath} before passing —
 * keeps FS I/O cwd-correct under worktree isolation (FR-E52).
 */
async function appendHitlAuditRecord(
  nodeDirAbs: string,
  question: HitlQuestion,
  reply: string,
): Promise<void> {
  await Deno.mkdir(nodeDirAbs, { recursive: true });
  const path = `${nodeDirAbs}/hitl.jsonl`;

  let round = 0;
  try {
    const existing = await Deno.readTextFile(path);
    round = existing.split("\n").filter((l) => l.trim()).length;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const record = {
    ts: new Date().toISOString(),
    round,
    question,
    reply,
  };
  await Deno.writeTextFile(path, JSON.stringify(record) + "\n", {
    append: true,
    create: true,
  });
}

/** Build args array for ask/check scripts. */
function buildScriptArgs(
  type: "ask" | "check",
  runDir: string,
  runId: string,
  nodeId: string,
  config: HitlConfig,
  ctx: TemplateContext,
  question?: HitlQuestion,
): string[] {
  const args = [
    "--run-dir",
    runDir,
    "--artifact-source",
    interpolate(config.artifact_source ?? "", ctx),
    "--run-id",
    runId,
    "--node-id",
    nodeId,
  ];

  if (type === "ask" && question) {
    args.push("--question-json", JSON.stringify(question));
  }

  if (type === "check" && config.exclude_login) {
    args.push("--exclude-login", config.exclude_login);
  }

  return args;
}

/** Default script runner — executes shell script via sh. */
async function defaultScriptRunner(
  path: string,
  args: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("sh", {
    args: [path, ...args],
    stdout: "piped",
    stderr: "piped",
    ...(cwd ? { cwd } : {}),
  });
  const output = await cmd.output();
  return {
    exitCode: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/** Format a non-zero script exit into an error message that includes the
 * trimmed stderr (capped at 500 chars to keep engine logs/state.json
 * compact). Without this, callers see only the exit code and cannot
 * diagnose the cause. */
function formatScriptFailure(
  scriptName: string,
  result: { exitCode: number; stderr?: string },
): string {
  const stderr = (result.stderr ?? "").trim();
  if (!stderr) return `${scriptName} failed with exit code ${result.exitCode}`;
  const truncated = stderr.length > 500 ? `${stderr.slice(0, 500)}…` : stderr;
  return `${scriptName} failed with exit code ${result.exitCode}: ${truncated}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
