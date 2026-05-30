/**
 * @module
 * Engine-side HITL plumbing on top of the library's generic
 * `mcpServers` + `onToolUseObserved` primitives (FR-L35).
 *
 * Two responsibilities, both runtime-agnostic from the caller's view:
 *
 * - {@link buildHitlMcpServers} returns the {@link McpServers} entry that
 *   registers the engine's `request_human_input` MCP server for one
 *   invocation. Each adapter renders it natively (Claude `--mcp-config`,
 *   OpenCode `OPENCODE_CONFIG_CONTENT`, Codex `--config mcp_servers.*`);
 *   Cursor warns and drops it.
 *
 * - {@link createHitlObserver} returns a closure-based capture of the
 *   first HITL tool call observed via `onToolUseObserved`. The observer
 *   matches the runtime-native tool name (`mcp__<srv>__<tool>` for
 *   Claude, `<srv>_<tool>` for OpenCode, `<srv>.<tool>` for Codex) and
 *   returns `"abort"` on match so the run stops cleanly with the
 *   question stashed for the engine to handle.
 */

import type { McpServers } from "@korchasa/ai-ide-cli";
import type {
  OnRuntimeToolUseObservedCallback,
  RuntimeToolUseInfo,
} from "@korchasa/ai-ide-cli/runtime/types";
import type { HumanInputRequest, RuntimeId } from "./types.ts";
import {
  buildHitlMcpServerArgv,
  HITL_MCP_SERVER_NAME,
  HITL_TOOL_NAME,
  normalizeHumanInputRequest,
} from "./hitl-mcp-server.ts";

/**
 * Build the {@link McpServers} record that registers the engine's HITL MCP
 * server for the duration of one runtime invocation. Stdio transport — the
 * engine binary spawned with the `--internal-hitl-mcp` flag.
 */
export function buildHitlMcpServers(): McpServers {
  const argv = buildHitlMcpServerArgv();
  return {
    [HITL_MCP_SERVER_NAME]: {
      type: "stdio",
      command: argv[0],
      args: argv.slice(1),
    },
  };
}

/**
 * Compute the runtime-native tool-use event name the observer should match.
 * Each runtime prefixes MCP tools differently in its `tool_use` stream.
 */
export function hitlToolNameFor(runtime: RuntimeId): string {
  switch (runtime) {
    case "claude":
      return `mcp__${HITL_MCP_SERVER_NAME}__${HITL_TOOL_NAME}`;
    case "opencode":
      return `${HITL_MCP_SERVER_NAME}_${HITL_TOOL_NAME}`;
    case "codex":
      return `${HITL_MCP_SERVER_NAME}.${HITL_TOOL_NAME}`;
    case "cursor":
      // Cursor lacks per-invocation MCP injection (capabilities.mcpInjection
      // === false). The observer never fires for HITL on Cursor; this branch
      // exists only so the switch is exhaustive.
      return `${HITL_MCP_SERVER_NAME}.${HITL_TOOL_NAME}`;
    default: {
      const _exhaustive: never = runtime;
      return `${HITL_MCP_SERVER_NAME}.${HITL_TOOL_NAME}`;
    }
  }
}

/**
 * Closure-based HITL question capture via the runtime-neutral
 * `onToolUseObserved` hook. Stashes the FIRST captured question per
 * observer instance.
 */
export interface HitlObserver {
  /** Pass into `RuntimeInvokeOptions.onToolUseObserved`. */
  observer: OnRuntimeToolUseObservedCallback;
  /** Returns the captured question, or `null` if none observed yet. */
  getQuestion(): HumanInputRequest | null;
  /** Reset capture state — useful between continuation invocations. */
  reset(): void;
}

/** Create a fresh {@link HitlObserver} for a single runtime invocation. */
export function createHitlObserver(runtime: RuntimeId): HitlObserver {
  const expected = hitlToolNameFor(runtime);
  let captured: HumanInputRequest | null = null;
  return {
    observer: (info: RuntimeToolUseInfo) => {
      if (captured !== null) return "allow";
      if (info.name !== expected) return "allow";
      try {
        captured = normalizeHumanInputRequest(info.input ?? {});
        return "abort";
      } catch {
        // Malformed tool input — let the run continue, agent will see
        // the MCP server's error response and may retry with valid input.
        return "allow";
      }
    },
    getQuestion: () => captured,
    reset: () => {
      captured = null;
    },
  };
}
