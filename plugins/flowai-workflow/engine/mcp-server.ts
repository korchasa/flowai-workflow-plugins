/**
 * @module
 * Embedded MCP server exposing seven engine-control tools over a generic
 * transport (default stdio). Built on `@modelcontextprotocol/sdk`. The
 * server is transport-agnostic — the `mcp` CLI subcommand wires
 * `StdioServerTransport`; future HTTP/SSE consumers swap the transport
 * with zero changes to tool handlers (FR-E73).
 *
 * Tools (generic workflow primitives; no domain awareness):
 *   - get_workflow         — `loadConfig` → WorkflowConfig JSON
 *   - get_state            — `replayRunJournal` → RunState JSON
 *   - list_runs            — walk `runs/`, replay each → summary array
 *   - tail_artifacts       — read artifact file → last N lines
 *   - resume_node          — construct `Engine({resume})` and `await run()`
 *   - cancel_run           — read lock → SIGTERM lock owner
 *   - apply_workflow_patch — apply add/replace/remove ops to workflow.yaml
 *
 * Constraints (FR-E59/E60/E61):
 *   - No OS signal handlers installed here (CLI owns signal routing).
 *   - Per-run PhaseRegistry — each `resume_node` builds its own `Engine`.
 *   - Concurrent `resume_node` for the same workflow folder is serialised
 *     by the existing per-workflow run lock; the tool never adds a second
 *     lock layer.
 *   - Read-only tools never acquire the run lock.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

import { loadConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { defaultLockPath, readLockInfo } from "./lock.ts";
import { replayRunJournal } from "./run-journal.ts";
import { getNodeDir, getRunDir } from "./state.ts";
import { VERSION } from "./version.ts";

/** Options for {@link runMcpServer}. */
export interface RunMcpServerOptions {
  /** Transport to attach. Defaults to `StdioServerTransport`. */
  transport?: Transport;
  /**
   * No-workflow mode (FR-E74). Set true when the plugin launcher cannot
   * resolve a `.flowai-workflow/<name>/` folder in the project; the
   * server still completes the MCP handshake and advertises all seven
   * tools so Claude Code shows the server as up, but every tool handler
   * short-circuits with a structured missing-workflow diagnostic so the
   * user sees an actionable "run init" error rather than an opaque
   * spawn failure. When true, `workflowDir` is ignored.
   */
  noWorkflow?: boolean;
}

/** Sentinel error text surfaced by every tool in no-workflow mode. */
const NO_WORKFLOW_ERROR = "No flowai-workflow folder found in this project. " +
  "Run /flowai-workflow:init <name> to scaffold one, or set " +
  "FLOWAI_WORKFLOW=<path> to point at an existing workflow.";

/** Shape of a single response to an MCP tool call. */
type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Run the embedded MCP server. Returns when the transport closes (e.g. stdin
 * EOF for `StdioServerTransport`).
 *
 * @param workflowDir Directory containing `workflow.yaml`. All tool handlers
 *   resolve paths relative to this folder; no per-call `workflowDir` argument.
 * @param options Transport override; defaults to stdio.
 */
export async function runMcpServer(
  workflowDir: string | undefined,
  options: RunMcpServerOptions = {},
): Promise<void> {
  const server = new McpServer({
    name: "flowai-workflow",
    version: VERSION,
  });

  if (options.noWorkflow) {
    registerAllToolsNoWorkflow(server);
  } else {
    if (workflowDir === undefined) {
      throw new Error(
        "runMcpServer: workflowDir is required unless options.noWorkflow is true",
      );
    }
    registerGetWorkflow(server, workflowDir);
    registerGetState(server, workflowDir);
    registerListRuns(server, workflowDir);
    registerTailArtifacts(server, workflowDir);
    registerResumeNode(server, workflowDir);
    registerCancelRun(server, workflowDir);
    registerApplyWorkflowPatch(server, workflowDir);
  }

  if (options.transport) {
    // Caller owns the transport lifecycle (e.g. tests using
    // InMemoryTransport). Return after the protocol handshake so the
    // caller can drive requests and close on its own schedule.
    await server.connect(options.transport);
    return;
  }
  // Default: stdio transport. The transport keeps the event loop alive
  // while stdin is open; we resolve the outer promise on stdin EOF.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const prev = transport.onclose;
    transport.onclose = () => {
      prev?.();
      resolve();
    };
  });
}

// --- Tool registrations ---

function ok(payload: unknown): ToolResponse {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function err(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function configPathOf(workflowDir: string): string {
  return join(workflowDir, "workflow.yaml");
}

/**
 * No-workflow mode (FR-E74): register the same seven tool names so
 * `tools/list` matches the full surface, but every handler returns the
 * structured missing-workflow diagnostic. The MCP handshake completes
 * normally so Claude Code reports the server as up; the user sees the
 * actionable error only when they actually invoke a tool.
 */
function registerAllToolsNoWorkflow(server: McpServer): void {
  const names = [
    "get_workflow",
    "get_state",
    "list_runs",
    "tail_artifacts",
    "resume_node",
    "cancel_run",
    "apply_workflow_patch",
  ] as const;
  for (const name of names) {
    server.tool(
      name,
      "Unavailable: no flowai-workflow folder resolved at server startup.",
      {},
      () => Promise.resolve(err(NO_WORKFLOW_ERROR)),
    );
  }
}

function registerGetWorkflow(server: McpServer, workflowDir: string): void {
  server.tool(
    "get_workflow",
    "Return the parsed workflow.yaml as JSON.",
    {},
    async () => {
      try {
        const config = await loadConfig(configPathOf(workflowDir));
        return ok(config);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

function registerGetState(server: McpServer, workflowDir: string): void {
  server.tool(
    "get_state",
    "Replay a run's journal and return the resulting RunState as JSON.",
    { run_id: z.string() },
    async ({ run_id }: { run_id: string }) => {
      try {
        const runDir = getRunDir(run_id, workflowDir);
        const { state } = await replayRunJournal(runDir);
        return ok(state);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

function registerListRuns(server: McpServer, workflowDir: string): void {
  server.tool(
    "list_runs",
    "List all runs under <workflowDir>/runs/, one entry per subdirectory.",
    {},
    async () => {
      try {
        const runsDir = join(workflowDir, "runs");
        const entries: Array<
          | {
            run_id: string;
            status: string;
            total_cost_usd?: number;
            node_count: number;
          }
          | { run_id: string; error: string }
        > = [];
        try {
          for await (const entry of Deno.readDir(runsDir)) {
            if (!entry.isDirectory) continue;
            if (entry.name.startsWith(".")) continue;
            const runDir = join(runsDir, entry.name);
            try {
              const { state } = await replayRunJournal(runDir);
              entries.push({
                run_id: state.run_id,
                status: state.status,
                total_cost_usd: state.total_cost_usd,
                node_count: Object.keys(state.nodes).length,
              });
            } catch (perRunErr) {
              entries.push({
                run_id: entry.name,
                error: (perRunErr as Error).message,
              });
            }
          }
        } catch (readErr) {
          if (!(readErr instanceof Deno.errors.NotFound)) throw readErr;
          // No runs/ directory yet — empty list is valid output.
        }
        return ok(entries);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

function registerTailArtifacts(server: McpServer, workflowDir: string): void {
  server.tool(
    "tail_artifacts",
    "Read the last N lines of a node artifact file (default 50).",
    {
      run_id: z.string(),
      node_id: z.string(),
      filename: z.string(),
      lines: z.number().int().positive().default(50),
    },
    async (
      { run_id, node_id, filename, lines }: {
        run_id: string;
        node_id: string;
        filename: string;
        lines: number;
      },
    ) => {
      try {
        const nodeDir = getNodeDir(run_id, node_id, workflowDir);
        const path = join(nodeDir, filename);
        const text = await Deno.readTextFile(path);
        const allLines = text.split("\n");
        // If the file ends with a trailing newline, split yields one trailing
        // empty entry that should be ignored for the "last N lines" contract.
        const trimmed =
          allLines.length > 0 && allLines[allLines.length - 1] === ""
            ? allLines.slice(0, -1)
            : allLines;
        const tail = trimmed.slice(-lines);
        return ok({ path, lines: tail });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

function registerResumeNode(server: McpServer, workflowDir: string): void {
  server.tool(
    "resume_node",
    "Resume a previously-started run from its journal state. " +
      "Blocks until the engine run completes (may take minutes).",
    { run_id: z.string() },
    async ({ run_id }: { run_id: string }) => {
      try {
        const engine = new Engine({
          config_path: configPathOf(workflowDir),
          run_id,
          resume: true,
          dry_run: false,
          verbosity: "quiet",
          args: {},
          env_overrides: {},
        });
        const state = await engine.run();
        return ok({
          run_id: state.run_id,
          status: state.status,
          total_cost_usd: state.total_cost_usd,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

function registerCancelRun(server: McpServer, workflowDir: string): void {
  server.tool(
    "cancel_run",
    "Send SIGTERM to the process holding the workflow lock, if any. " +
      "Rejects when the lock's run_id does not match the requested one.",
    { run_id: z.string() },
    async ({ run_id }: { run_id: string }) => {
      try {
        const lockPath = defaultLockPath(workflowDir);
        const info = await readLockInfo(lockPath);
        if (info.run_id !== run_id) {
          return err(
            `no matching active run: lock holds run_id=${info.run_id}, ` +
              `requested run_id=${run_id}`,
          );
        }
        try {
          Deno.kill(info.pid, "SIGTERM");
        } catch (killErr) {
          // Race: holder released between readLockInfo and kill. The lock's
          // PID either no longer exists (Deno.errors.NotFound) or is owned
          // by a different process now (PermissionDenied on some OSes).
          // Treat as a benign no-op — the run is gone.
          if (
            killErr instanceof Deno.errors.NotFound ||
            killErr instanceof Deno.errors.PermissionDenied
          ) {
            return ok({
              cancelled: false,
              pid: info.pid,
              reason: "process already gone",
            });
          }
          throw killErr;
        }
        return ok({ cancelled: true, pid: info.pid });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

function registerApplyWorkflowPatch(
  server: McpServer,
  workflowDir: string,
): void {
  const operationSchema = z.object({
    op: z.enum(["add", "replace", "remove"]),
    path: z.string(),
    value: z.unknown().optional(),
  });
  server.tool(
    "apply_workflow_patch",
    "Apply add/replace/remove ops (JSON Pointer paths, RFC 6901) to " +
      "workflow.yaml. Rejects ops targeting the root or the `version` key. " +
      "Caveat: @std/yaml round-trip drops comments and may normalise quoting.",
    { operations: z.array(operationSchema) },
    async (
      { operations }: { operations: JsonPointerOp[] },
    ) => {
      try {
        const path = configPathOf(workflowDir);
        const text = await Deno.readTextFile(path);
        const doc = parseYaml(text) as Record<string, unknown>;
        for (const op of operations) {
          applyJsonPointerOp(doc, op);
        }
        const next = stringifyYaml(doc);
        await Deno.writeTextFile(path, next);
        return ok({ applied: operations.length });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );
}

// --- JSON Pointer walker (RFC 6901, subset: add / replace / remove) ---

/** Single JSON-Patch-style operation accepted by `apply_workflow_patch`. */
export interface JsonPointerOp {
  /** Mutation kind. RFC 6902 subset — only add / replace / remove are accepted. */
  op: "add" | "replace" | "remove";
  /** RFC 6901 JSON Pointer path into the parsed workflow document. */
  path: string;
  /** New value for add/replace ops; ignored for remove. */
  value?: unknown;
}

/** Apply a single add/replace/remove op to `doc` in place. Rejects ops that
 * target the root pointer (`/` or empty string) or the `/version` key — both
 * would corrupt the workflow schema invariants. */
export function applyJsonPointerOp(
  doc: Record<string, unknown>,
  op: JsonPointerOp,
): void {
  if (op.path === "" || op.path === "/") {
    throw new Error("root pointer is not patchable");
  }
  if (op.path === "/version") {
    throw new Error("`version` field is not patchable");
  }
  if (!op.path.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${op.path}`);
  }
  const tokens = op.path.slice(1).split("/").map(decodePointerToken);
  const lastToken = tokens.pop();
  if (lastToken === undefined) {
    throw new Error("empty JSON pointer path");
  }
  let parent: unknown = doc;
  for (const token of tokens) {
    parent = step(parent, token);
  }
  applyAt(parent, lastToken, op);
}

function step(node: unknown, token: string): unknown {
  if (Array.isArray(node)) {
    const idx = parseArrayIndex(token, node.length);
    return node[idx];
  }
  if (node && typeof node === "object") {
    return (node as Record<string, unknown>)[token];
  }
  throw new Error(`cannot descend through non-container at "${token}"`);
}

function applyAt(parent: unknown, token: string, op: JsonPointerOp): void {
  if (Array.isArray(parent)) {
    const isAppend = op.op === "add" && token === "-";
    const idx = isAppend
      ? parent.length
      : parseArrayIndex(token, parent.length + (op.op === "add" ? 1 : 0));
    if (op.op === "remove") parent.splice(idx, 1);
    else if (op.op === "replace") parent[idx] = op.value;
    else parent.splice(idx, 0, op.value); // add
    return;
  }
  if (parent && typeof parent === "object") {
    const record = parent as Record<string, unknown>;
    if (op.op === "remove") {
      if (!(token in record)) {
        throw new Error(`remove target missing: ${token}`);
      }
      delete record[token];
    } else if (op.op === "replace") {
      if (!(token in record)) {
        throw new Error(`replace target missing: ${token}`);
      }
      record[token] = op.value;
    } else {
      record[token] = op.value;
    }
    return;
  }
  throw new Error(`cannot apply op at non-container parent for "${token}"`);
}

function decodePointerToken(token: string): string {
  // RFC 6901: "~1" → "/", "~0" → "~"; order matters (escape "~1" first).
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseArrayIndex(token: string, length: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) {
    throw new Error(`invalid array index: ${token}`);
  }
  const idx = Number(token);
  if (idx < 0 || idx > length) {
    throw new Error(`array index out of range: ${idx} (length ${length})`);
  }
  return idx;
}
