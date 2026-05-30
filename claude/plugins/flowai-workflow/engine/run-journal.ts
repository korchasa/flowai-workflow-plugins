/**
 * @module
 * Durable run lifecycle journal writer and replayer.
 *
 * `journal.jsonl` is the recovery contract: one append-only JSON object per
 * line, replayed from an empty in-memory model to reconstruct `RunState`.
 */

import type {
  ErrorCategory,
  NodeConfig,
  NodeLifecycleEvent,
  NodeLifecycleJournalEvent,
  RunJournalEvent,
  RunJournalEventBase,
  RunJournalEventKind,
  RunJournalReplayResult,
  RunState,
} from "./types.ts";
import { updateRunCost } from "./state.ts";

/** Event payload accepted by `RunJournalWriter.append()` before enveloping. */
export type NewRunJournalEvent = RunJournalEvent extends infer Event
  ? Event extends RunJournalEvent
    ? Omit<Event, Exclude<keyof RunJournalEventBase, "kind">> & {
      ts?: string;
    }
  : never
  : never;

/** Return the durable lifecycle journal path for a run directory. */
export function getJournalPath(runDir: string): string {
  return `${runDir}/journal.jsonl`;
}

/** Append-only writer for a single run's `journal.jsonl`. */
export class RunJournalWriter {
  #nextSeq: number;

  private constructor(
    readonly runDir: string,
    readonly runId: string,
    nextSeq: number,
  ) {
    this.#nextSeq = nextSeq;
  }

  /** Open a writer, continuing after any valid records already on disk. */
  static async open(runDir: string, runId: string): Promise<RunJournalWriter> {
    await Deno.mkdir(runDir, { recursive: true });
    const parsed = await parseJournal(runDir, { allowMissing: true });
    if (parsed.validByteLength !== undefined) {
      await Deno.truncate(getJournalPath(runDir), parsed.validByteLength);
    }
    const events = parsed.events;
    const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    return new RunJournalWriter(runDir, runId, maxSeq + 1);
  }

  /** Append one fully-enveloped event and return the persisted record. */
  async append(event: NewRunJournalEvent): Promise<RunJournalEvent> {
    const seq = this.#nextSeq++;
    const ts = event.ts ?? new Date().toISOString();
    const kind = event.kind;
    const persisted = {
      ...event,
      schema_version: 1,
      run_id: this.runId,
      seq,
      event_id: buildEventId(this.runId, seq, kind, event),
      ts,
    } as RunJournalEvent;
    await Deno.writeTextFile(
      getJournalPath(this.runDir),
      `${JSON.stringify(persisted)}\n`,
      { append: true, create: true },
    );
    return persisted;
  }

  /** Append the durable counterpart of a live node lifecycle event. */
  async appendNodeLifecycle(event: NodeLifecycleEvent): Promise<void> {
    await this.append({
      kind: nodeLifecycleKind(event.status),
      node_id: event.node_id,
      status: event.status,
      timestamp: event.timestamp,
      ts: event.timestamp,
      node: event.node,
      metadata: event.metadata,
      ...event.metadata,
    });
  }
}

/** Replay `journal.jsonl` under `runDir` into a current run snapshot. */
export async function replayRunJournal(
  runDir: string,
): Promise<RunJournalReplayResult> {
  const parsed = await parseJournal(runDir, { allowMissing: false });
  const unique: RunJournalEvent[] = [];
  const seen = new Set<string>();
  let ignoredDuplicates = 0;

  for (const event of parsed.events) {
    if (seen.has(event.event_id)) {
      ignoredDuplicates++;
      continue;
    }
    seen.add(event.event_id);
    unique.push(event);
  }

  const state = applyJournalEvents(unique);
  return {
    state,
    events: unique,
    ignored_duplicate_event_ids: ignoredDuplicates,
    ignored_partial_tail: parsed.ignoredPartialTail,
  };
}

/** Convenience helper for callers that only need reconstructed `RunState`. */
export async function loadStateFromJournal(runDir: string): Promise<RunState> {
  return (await replayRunJournal(runDir)).state;
}

async function parseJournal(
  runDir: string,
  opts: { allowMissing: boolean },
): Promise<{
  events: RunJournalEvent[];
  ignoredPartialTail: boolean;
  validByteLength?: number;
}> {
  let content: string;
  try {
    content = await Deno.readTextFile(getJournalPath(runDir));
  } catch (error) {
    if (opts.allowMissing && error instanceof Deno.errors.NotFound) {
      return { events: [], ignoredPartialTail: false };
    }
    throw error;
  }

  if (content === "") return { events: [], ignoredPartialTail: false };

  const endedWithNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (endedWithNewline) lines.pop();

  const events: RunJournalEvent[] = [];
  let ignoredPartialTail = false;
  let validByteLength: number | undefined;
  let lineStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLineStart = lineStart + line.length + 1;
    if (line.trim() === "") {
      lineStart = nextLineStart;
      continue;
    }
    try {
      events.push(JSON.parse(line) as RunJournalEvent);
    } catch (error) {
      const isPartialTail = i === lines.length - 1 && !endedWithNewline;
      if (isPartialTail) {
        ignoredPartialTail = true;
        validByteLength = new TextEncoder().encode(
          content.slice(0, lineStart),
        ).length;
        continue;
      }
      throw new Error(
        `Malformed journal record at ${getJournalPath(runDir)}:${i + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    lineStart = nextLineStart;
  }
  return { events, ignoredPartialTail, validByteLength };
}

function applyJournalEvents(events: RunJournalEvent[]): RunState {
  let state: RunState | undefined;

  for (const event of events) {
    switch (event.kind) {
      case "run_started": {
        if (state) {
          assertSameRun(state, event);
          if (isTerminalStatus(state.status)) break;
        }
        state = {
          run_id: event.run_id,
          config_path: event.config_path,
          started_at: event.started_at,
          status: "running",
          args: event.args,
          env: event.env,
          nodes: state?.nodes ?? {},
          total_cost_usd: state?.total_cost_usd,
          claude_cli_version: state?.claude_cli_version,
        };
        break;
      }
      case "run_metadata_updated": {
        const current = requireState(state, event);
        assertSameRun(current, event);
        if (event.claude_cli_version !== undefined) {
          current.claude_cli_version = event.claude_cli_version;
        }
        break;
      }
      case "workflow_loaded":
      case "node_directory_declared":
        assertSameRun(requireState(state, event), event);
        break;
      case "node_declared": {
        const current = requireState(state, event);
        assertSameRun(current, event);
        current.nodes[event.node_id] ??= { status: "pending" };
        break;
      }
      case "node_started":
      case "node_completed":
      case "node_failed":
      case "node_waiting":
      case "node_skipped": {
        const current = requireState(state, event);
        assertSameRun(current, event);
        current.nodes[event.node_id] = { ...event.node };
        updateRunCost(current);
        if (current.total_cost_usd === 0) {
          const anyCost = Object.values(current.nodes).some((node) =>
            node.cost_usd !== undefined
          );
          if (!anyCost) delete current.total_cost_usd;
        }
        break;
      }
      case "attempt_started":
      case "attempt_completed":
      case "continuation_exhausted": {
        const current = requireState(state, event);
        assertSameRun(current, event);
        const node = current.nodes[event.node_id] ?? { status: "pending" };
        if (event.session_id !== undefined) node.session_id = event.session_id;
        if (event.continuations !== undefined) {
          node.continuations = event.continuations;
        }
        current.nodes[event.node_id] = node;
        break;
      }
      case "loop_iteration_started":
      case "loop_iteration_completed":
      case "loop_iteration_failed": {
        const current = requireState(state, event);
        assertSameRun(current, event);
        const node = current.nodes[event.loop_node_id] ?? { status: "pending" };
        node.iteration = event.iteration;
        current.nodes[event.loop_node_id] = node;
        break;
      }
      case "run_completed":
      case "run_failed":
      case "run_aborted": {
        const current = requireState(state, event);
        assertSameRun(current, event);
        current.status = event.status;
        current.completed_at = event.completed_at;
        break;
      }
    }
  }

  if (!state) {
    throw new Error("Cannot replay journal: missing run_started event");
  }
  return state;
}

function assertSameRun(state: RunState, event: RunJournalEvent): void {
  if (event.run_id !== state.run_id) {
    throw new Error(
      `Cannot replay mixed-run journal: expected ${state.run_id}, got ${event.run_id}`,
    );
  }
}

function requireState(
  state: RunState | undefined,
  event: RunJournalEvent,
): RunState {
  if (!state) {
    throw new Error(
      `Cannot apply ${event.kind} before run_started in journal replay`,
    );
  }
  return state;
}

function isTerminalStatus(status: RunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function nodeLifecycleKind(status: NodeLifecycleEvent["status"]) {
  return `node_${
    status === "running" ? "started" : status
  }` as NodeLifecycleJournalEvent["kind"];
}

function buildEventId(
  runId: string,
  seq: number,
  kind: RunJournalEventKind,
  event: NewRunJournalEvent,
): string {
  const nodeId = "node_id" in event ? event.node_id : "";
  const loopNodeId = "loop_node_id" in event ? event.loop_node_id : "";
  const iteration = "iteration" in event && event.iteration !== undefined
    ? event.iteration
    : "";
  return [runId, String(seq), kind, nodeId, loopNodeId, String(iteration)]
    .filter((part) => part !== "")
    .join(":");
}

/** Build the compact agent result excerpt persisted in node lifecycle facts. */
export function resultExcerpt(result: string): string {
  return result
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, 3)
    .join(" | ")
    .slice(0, 400);
}

/** Emit an attempt completion fact from an agent result-like payload. */
export async function appendAttemptCompleted(
  journal: RunJournalWriter | undefined,
  nodeId: string,
  result: {
    success: boolean;
    session_id?: string;
    continuations: number;
    output?: { session_id?: string; total_cost_usd?: number; result?: string };
    error?: string;
    error_category?: ErrorCategory;
  } | null,
  iteration?: number,
): Promise<void> {
  if (!journal || !result) return;
  await journal.append({
    kind: result.error_category === "continuations_exhausted"
      ? "continuation_exhausted"
      : "attempt_completed",
    node_id: nodeId,
    iteration,
    session_id: result.session_id ?? result.output?.session_id,
    continuations: result.continuations,
    cost_usd: result.output?.total_cost_usd,
    result: result.output?.result !== undefined
      ? resultExcerpt(result.output.result)
      : undefined,
    success: result.success,
    error: result.error,
    error_category: result.error_category,
  });
}

/** Minimal shape needed from workflow nodes for bootstrap journal facts. */
export function nodeDeclarationPayload(
  nodeId: string,
  node: Pick<NodeConfig, "type" | "label" | "phase">,
): Pick<
  Extract<RunJournalEvent, { kind: "node_declared" }>,
  "kind" | "node_id" | "node_type" | "label" | "phase"
> {
  return {
    kind: "node_declared",
    node_id: nodeId,
    node_type: node.type,
    label: node.label,
    phase: node.phase,
  };
}
