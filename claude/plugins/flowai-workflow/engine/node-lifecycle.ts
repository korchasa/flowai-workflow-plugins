/**
 * @module
 * Async node lifecycle transitions for embedding hosts (FR-E68).
 *
 * The synchronous state mutators in `state.ts` remain the low-level source of
 * truth. This layer applies one state transition, snapshots the updated node,
 * persists the durable journal fact, then awaits the optional host callback.
 */

import {
  markNodeCompleted,
  markNodeFailed,
  markNodeSkipped,
  markNodeStarted,
  markNodeWaiting,
} from "./state.ts";
import type {
  ErrorCategory,
  NodeLifecycleCallback,
  NodeLifecycleEvent,
  NodeLifecycleMetadata,
  NodeState,
  NodeStatus,
  RunState,
} from "./types.ts";
import type { RunJournalWriter } from "./run-journal.ts";

/** Error thrown when an embedding host's lifecycle callback fails. */
export class NodeLifecycleCallbackError extends Error {
  /** Node ID whose lifecycle event failed to publish. */
  readonly nodeId: string;
  /** Status of the event that failed to publish. */
  readonly status: NodeStatus;

  constructor(nodeId: string, status: NodeStatus, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Node lifecycle callback failed for node '${nodeId}' status '${status}': ${message}`,
      { cause },
    );
    this.name = "NodeLifecycleCallbackError";
    this.nodeId = nodeId;
    this.status = status;
  }
}

/** Return true when `error` is a lifecycle callback failure wrapper. */
export function isNodeLifecycleCallbackError(
  error: unknown,
): error is NodeLifecycleCallbackError {
  return error instanceof NodeLifecycleCallbackError;
}

/** Mark a node as running, then emit the optional lifecycle callback. */
export async function nodeStarted(
  state: RunState,
  nodeId: string,
  callback?: NodeLifecycleCallback,
  journal?: RunJournalWriter,
): Promise<void> {
  markNodeStarted(state, nodeId);
  await emitNodeLifecycle(state, nodeId, callback, journal);
}

/** Mark a node as completed, then emit the optional lifecycle callback. */
export async function nodeCompleted(
  state: RunState,
  nodeId: string,
  costUsd?: number,
  result?: string,
  callback?: NodeLifecycleCallback,
  journal?: RunJournalWriter,
): Promise<void> {
  markNodeCompleted(state, nodeId, costUsd, result);
  await emitNodeLifecycle(state, nodeId, callback, journal);
}

/** Mark a node as failed, then emit the optional lifecycle callback. */
export async function nodeFailed(
  state: RunState,
  nodeId: string,
  error: string,
  errorCategory?: ErrorCategory,
  callback?: NodeLifecycleCallback,
  journal?: RunJournalWriter,
): Promise<void> {
  markNodeFailed(state, nodeId, error, errorCategory);
  await emitNodeLifecycle(state, nodeId, callback, journal);
}

/** Mark a node as waiting for human input, then emit the optional callback. */
export async function nodeWaiting(
  state: RunState,
  nodeId: string,
  sessionId: string,
  questionJson: string,
  callback?: NodeLifecycleCallback,
  journal?: RunJournalWriter,
): Promise<void> {
  markNodeWaiting(state, nodeId, sessionId, questionJson);
  await emitNodeLifecycle(state, nodeId, callback, journal);
}

/** Mark a node as skipped, then emit the optional lifecycle callback. */
export async function nodeSkipped(
  state: RunState,
  nodeId: string,
  callback?: NodeLifecycleCallback,
  journal?: RunJournalWriter,
): Promise<void> {
  markNodeSkipped(state, nodeId);
  await emitNodeLifecycle(state, nodeId, callback, journal);
}

/** Persist and emit a snapshot of the current node state. */
export async function emitNodeLifecycle(
  state: RunState,
  nodeId: string,
  callback?: NodeLifecycleCallback,
  journal?: RunJournalWriter,
): Promise<void> {
  const event = buildNodeLifecycleEvent(state, nodeId);
  await journal?.appendNodeLifecycle(event);
  if (!callback) return;
  try {
    await callback(event);
  } catch (error) {
    throw new NodeLifecycleCallbackError(nodeId, event.status, error);
  }
}

/** Build the stable lifecycle payload from the current state snapshot. */
export function buildNodeLifecycleEvent(
  state: RunState,
  nodeId: string,
): NodeLifecycleEvent {
  const node = state.nodes[nodeId];
  if (!node) {
    throw new Error(`Node '${nodeId}' not found in run state`);
  }
  const nodeSnapshot = { ...node };
  const metadata = buildMetadata(nodeSnapshot);

  return {
    run_id: state.run_id,
    node_id: nodeId,
    status: nodeSnapshot.status,
    timestamp: lifecycleTimestamp(nodeSnapshot),
    node: nodeSnapshot,
    metadata,
    ...metadata,
  };
}

function lifecycleTimestamp(node: NodeState): string {
  if (node.status === "running" && node.started_at) return node.started_at;
  if (
    (node.status === "completed" || node.status === "failed") &&
    node.completed_at
  ) {
    return node.completed_at;
  }
  return new Date().toISOString();
}

function buildMetadata(node: NodeState): NodeLifecycleMetadata {
  const metadata: NodeLifecycleMetadata = {};
  copyDefined(metadata, "error", node.error);
  copyDefined(metadata, "error_category", node.error_category);
  copyDefined(metadata, "duration_ms", node.duration_ms);
  copyDefined(metadata, "cost_usd", node.cost_usd);
  copyDefined(metadata, "result", node.result);
  copyDefined(metadata, "session_id", node.session_id);
  copyDefined(metadata, "question_json", node.question_json);
  copyDefined(metadata, "iteration", node.iteration);
  return metadata;
}

function copyDefined<K extends keyof NodeLifecycleMetadata>(
  target: NodeLifecycleMetadata,
  key: K,
  value: NodeLifecycleMetadata[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
