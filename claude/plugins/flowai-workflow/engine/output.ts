/**
 * @module
 * Terminal output management for workflow execution.
 * {@link OutputManager} centralises all stderr writes and enforces verbosity
 * levels (quiet / normal / semi-verbose / verbose) so callers never need to
 * check verbosity themselves.
 */

import type { CliRunOutput, Verbosity } from "./types.ts";

/** Input artifact descriptor for verbose output. */
export interface VerboseInput {
  /** Absolute path to the input artifact file. */
  path: string;
  /** File size in bytes for display. */
  sizeBytes: number;
}

/** Validation result descriptor for verbose output. */
export interface VerboseValidationResult {
  /** Validation rule name or identifier. */
  rule: string;
  /** Whether the rule check passed. */
  passed: boolean;
  /** Optional failure detail or context message. */
  detail?: string;
}

/** Terminal output manager with configurable verbosity levels. */
export class OutputManager {
  private verbosity: Verbosity;
  private encoder = new TextEncoder();
  private customWriter?: (text: string) => void;

  /** Create an OutputManager with the given verbosity and optional custom writer. */
  constructor(
    verbosity: Verbosity = "normal",
    writer?: (text: string) => void,
  ) {
    this.verbosity = verbosity;
    this.customWriter = writer;
  }

  /** Log a status line (shown in normal and verbose modes). */
  status(nodeId: string, message: string): void {
    if (this.verbosity === "quiet") return;
    const time = this.timestamp();
    const paddedId = nodeId.padEnd(16);
    this.write(`[${time}] ${paddedId}${message}\n`);
  }

  /** Log a node start event. */
  nodeStarted(nodeId: string, extra?: string): void {
    const suffix = extra ? ` (${extra})` : "";
    this.status(nodeId, `STARTED${suffix}`);
  }

  /** Log a node completion event. */
  nodeCompleted(nodeId: string, durationMs: number, extra?: string): void {
    const duration = this.formatDuration(durationMs);
    const suffix = extra ? `, ${extra}` : "";
    this.status(nodeId, `COMPLETED (${duration}${suffix})`);
  }

  /** Log a node failure event. */
  nodeFailed(nodeId: string, error: string): void {
    const time = this.timestamp();
    const paddedId = nodeId.padEnd(16);
    // Always show failures, even in quiet mode
    this.write(`[${time}] ${paddedId}FAILED: ${error}\n`);
  }

  /** Log a node skip event. */
  nodeSkipped(nodeId: string, reason: string): void {
    this.status(nodeId, `SKIPPED (${reason})`);
  }

  /** Log a loop iteration event. */
  loopIteration(
    nodeId: string,
    iteration: number,
    maxIterations: number,
  ): void {
    this.status(nodeId, `ITERATION ${iteration}/${maxIterations}`);
  }

  /** Expose verbosity level for callers that need to thread it downstream. */
  get verbosityLevel(): Verbosity {
    return this.verbosity;
  }

  /** Log streaming output from a node (verbose and semi-verbose). */
  nodeOutput(nodeId: string, line: string): void {
    if (this.verbosity !== "verbose" && this.verbosity !== "semi-verbose") {
      return;
    }
    const paddedId = `[${nodeId}]`.padEnd(18);
    this.write(`${paddedId} ${line}\n`);
  }

  /** Log an error message (always shown). */
  error(message: string): void {
    this.write(`ERROR: ${message}\n`);
  }

  /** Log a warning message (shown in normal and verbose). */
  warn(message: string): void {
    if (this.verbosity === "quiet") return;
    this.write(`WARN: ${message}\n`);
  }

  /** Print a summary at the end of a run. */
  summary(stats: RunSummary): void {
    this.write("\n");
    this.write(`${"=".repeat(60)}\n`);
    this.write(`Workflow: ${stats.name}\n`);
    this.write(`Run ID:   ${stats.runId}\n`);
    this.write(`Status:   ${stats.status}\n`);
    this.write(`Duration: ${this.formatDuration(stats.durationMs)}\n`);
    this.write(`Nodes:    ${stats.completed}/${stats.total} completed`);
    if (stats.failed > 0) this.write(`, ${stats.failed} failed`);
    if (stats.skipped > 0) this.write(`, ${stats.skipped} skipped`);
    this.write("\n");
    if (stats.nodeResults) {
      for (const [nodeId, excerpt] of Object.entries(stats.nodeResults)) {
        this.write(`  ${nodeId.padEnd(16)}  ${excerpt}\n`);
      }
    }
    this.write(`${"=".repeat(60)}\n`);
  }

  // --- Verbose methods (no-op when verbosity !== "verbose") ---

  /** Show the full interpolated prompt sent to an agent. */
  verbosePrompt(nodeId: string, prompt: string): void {
    if (this.verbosity !== "verbose") return;
    this.write(`── ${nodeId}: PROMPT ──\n`);
    this.write(`${prompt}\n`);
    this.write(`── end prompt ──\n`);
  }

  /** Show resolved input artifacts with file paths and sizes. */
  verboseInputs(nodeId: string, inputs: VerboseInput[]): void {
    if (this.verbosity !== "verbose") return;
    this.write(`── ${nodeId}: INPUTS (${inputs.length} files) ──\n`);
    for (const input of inputs) {
      this.write(`  ${input.path} (${input.sizeBytes} bytes)\n`);
    }
  }

  /** Show validation rule results (pass/fail per rule). */
  verboseValidation(
    nodeId: string,
    results: VerboseValidationResult[],
  ): void {
    if (this.verbosity !== "verbose") return;
    this.write(`── ${nodeId}: VALIDATION ──\n`);
    for (const r of results) {
      const status = r.passed ? "PASS" : "FAIL";
      const detail = r.detail ? ` — ${r.detail}` : "";
      this.write(`  [${status}] ${r.rule}${detail}\n`);
    }
  }

  /** Show continuation trigger context. */
  verboseContinuation(
    nodeId: string,
    attempt: number,
    max: number,
    failures: string[],
  ): void {
    if (this.verbosity !== "verbose") return;
    this.write(`── ${nodeId}: CONTINUATION ${attempt}/${max} ──\n`);
    for (const f of failures) {
      this.write(`  ${f}\n`);
    }
  }

  /**
   * Show multi-line agent result after node completion (FR-E15).
   * Suppressed in quiet mode. Format:
   *   [HH:MM:SS] <nodeId padded>  RESULT:
   *     <each non-empty line of output.result indented 2 spaces>
   *     cost=$0.0050 | duration=3s | turns=N
   */
  nodeResult(nodeId: string, output: CliRunOutput): void {
    if (this.verbosity === "quiet") return;
    const time = this.timestamp();
    const paddedId = nodeId.padEnd(16);
    this.write(`[${time}] ${paddedId}  RESULT:\n`);
    for (const line of (output.result ?? "").split("\n")) {
      if (line.trim()) this.write(`  ${line}\n`);
    }
    const cost = (output.total_cost_usd ?? 0).toFixed(4);
    const durationS = Math.round((output.duration_ms ?? 0) / 1000);
    this.write(
      `  cost=$${cost} | duration=${durationS}s | turns=${output.num_turns}\n`,
    );
  }

  /** Print the dry-run execution plan. */
  dryRunPlan(
    levels: string[][],
    labels: Record<string, string>,
    postWorkflowNodeIds?: string[],
    runOnMap?: Record<string, string>,
  ): void {
    this.write("\nExecution Plan (dry run):\n");
    this.write(`${"─".repeat(40)}\n`);
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const parallel = level.length > 1 ? " (parallel)" : "";
      this.write(`Level ${i + 1}${parallel}:\n`);
      for (const nodeId of level) {
        const label = labels[nodeId] ?? nodeId;
        this.write(`  - ${nodeId}: ${label}\n`);
      }
    }
    if (postWorkflowNodeIds && postWorkflowNodeIds.length > 0) {
      this.write(`Post-workflow:\n`);
      for (const nodeId of postWorkflowNodeIds) {
        const label = labels[nodeId] ?? nodeId;
        const condition = runOnMap?.[nodeId] ?? "always";
        this.write(`  - ${nodeId}: ${label} (run_on: ${condition})\n`);
      }
    }
    this.write(`${"─".repeat(40)}\n`);
  }

  /** Format current time as HH:MM:SS for status line prefix. */
  private timestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${
      pad(now.getSeconds())
    }`;
  }

  /** Convert milliseconds to human-readable duration (e.g. "2m30s"). */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m${remainingSeconds > 0 ? `${remainingSeconds}s` : ""}`;
  }

  /** Write text to custom writer or stderr. */
  private write(text: string): void {
    if (this.customWriter) {
      this.customWriter(text);
    } else {
      Deno.stderr.writeSync(this.encoder.encode(text));
    }
  }
}

/** Summary statistics for a workflow run. */
export interface RunSummary {
  /** Workflow name from config. */
  name: string;
  /** Unique run identifier (timestamp-based). */
  runId: string;
  /** Final run outcome (e.g. "success", "failed"). */
  status: string;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  /** Total number of nodes in the workflow. */
  total: number;
  /** Count of successfully completed nodes. */
  completed: number;
  /** Count of nodes that failed during execution. */
  failed: number;
  /** Count of nodes skipped (e.g. via resume). */
  skipped: number;
  /** Per-node result excerpts for display in run summary (FR-E22). */
  nodeResults?: Record<string, string>;
}
