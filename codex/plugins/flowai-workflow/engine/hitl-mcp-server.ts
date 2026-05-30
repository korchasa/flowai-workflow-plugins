/**
 * @module
 * Stdio MCP server exposing a single `request_human_input` tool. Spawned per
 * agent invocation by every MCP-capable runtime adapter (Claude via
 * `--mcp-config`, OpenCode via `OPENCODE_CONFIG_CONTENT`, Codex via
 * `--config mcp_servers.<name>.command/args`).
 *
 * Transport: one JSON-RPC message per line over stdin/stdout (NDJSON
 * framing). Compatible with every runtime's local-MCP transport.
 *
 * Why the tool returns immediately: the agent runtime emits a `tool_use`
 * event the engine intercepts via `onToolUseObserved`. The engine aborts
 * the run, captures the question, delivers it via `ask_script`, polls
 * `check_script` for the reply, then resumes the same session with the
 * reply. The MCP tool only needs to surface the typed request.
 *
 * Absorbed from `@korchasa/ai-ide-cli/hitl-mcp.ts` (deleted in library
 * v0.8.0; HITL pushed entirely to consumer per hitl-via-engine-mcp here and the
 * library's own removal ADR `2026-05-02-remove-hitl.md`).
 */

import { basename, fromFileUrl } from "@std/path";
import type { HumanInputOption, HumanInputRequest } from "./types.ts";

/** CLI dispatch flag that runs the MCP server in-process. */
export const INTERNAL_HITL_MCP_ARG: string = "--internal-hitl-mcp";

/** MCP server name advertised in `serverInfo` and used by every runtime
 * adapter as the registration key. Tool calls surface to the agent under
 * runtime-specific prefixes derived from this constant. */
export const HITL_MCP_SERVER_NAME: string = "flowai-workflow-hitl";

/** MCP tool name. Stable cross-runtime contract — agents see it as
 * `mcp__<server>__request_human_input` (Claude),
 * `<server>_request_human_input` (OpenCode), or
 * `<server>.request_human_input` (Codex). */
export const HITL_TOOL_NAME: string = "request_human_input";

/**
 * Schema of the `request_human_input` MCP tool exposed to the runtime.
 * Identical contract on every runtime.
 */
export const REQUEST_HUMAN_INPUT_TOOL: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
} = {
  name: HITL_TOOL_NAME,
  description: "Ask a human a structured question and wait outside the model.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      header: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["label"],
        },
      },
      multiSelect: { type: "boolean" },
    },
    required: ["question"],
  },
};

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    arguments?: Record<string, unknown>;
  };
}

/**
 * Run the stdio HITL MCP server until stdin closes.
 *
 * Dispatched from `cli.ts` when {@link INTERNAL_HITL_MCP_ARG} is the first
 * argv element.
 */
export async function runFlowaiHitlMcpServer(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      const message = JSON.parse(line) as JsonRpcMessage;
      await handleMessage(message);
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const message = JSON.parse(trailing) as JsonRpcMessage;
    await handleMessage(message);
  }
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  if (message.method === "initialize") {
    await sendResponse(message.id ?? 0, {
      protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: HITL_MCP_SERVER_NAME,
        version: "1",
      },
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "tools/list") {
    await sendResponse(message.id ?? 0, {
      tools: [REQUEST_HUMAN_INPUT_TOOL],
    });
    return;
  }

  if (message.method === "tools/call") {
    const request = normalizeHumanInputRequest(message.params?.arguments ?? {});
    await sendResponse(message.id ?? 0, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            question: request.question,
            header: request.header ?? "",
          }),
        },
      ],
    });
    return;
  }

  if (message.id !== undefined) {
    await sendResponse(message.id, {
      content: [
        {
          type: "text",
          text: `Unhandled method: ${message.method ?? "unknown"}`,
        },
      ],
    });
  }
}

/**
 * Normalise a raw `tools/call` arguments object into a {@link HumanInputRequest}.
 * Throws when the `question` field is missing or empty. Reused by the
 * tool-use observer that intercepts MCP calls in agent event streams.
 */
export function normalizeHumanInputRequest(
  input: Record<string, unknown>,
): HumanInputRequest {
  const question = String(input.question ?? "").trim();
  if (!question) {
    throw new Error("request_human_input requires a non-empty question");
  }

  const options = Array.isArray(input.options)
    ? input.options
      .filter((entry) => typeof entry === "object" && entry !== null)
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
          label: String(record.label ?? ""),
          description: typeof record.description === "string"
            ? record.description
            : undefined,
        } as HumanInputOption;
      })
      .filter((entry: HumanInputOption) => entry.label)
    : undefined;

  return {
    question,
    header: typeof input.header === "string" ? input.header : undefined,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: typeof input.multiSelect === "boolean"
      ? input.multiSelect
      : undefined,
  };
}

async function sendResponse(
  id: number | string | null,
  result: Record<string, unknown>,
): Promise<void> {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  });
  const data = new TextEncoder().encode(`${payload}\n`);
  await Deno.stdout.write(data);
}

/**
 * Build the `argv` for spawning the HITL MCP sub-process. Matches the
 * runtime's expected `mcp_servers.<name>.command` / `args` shape.
 *
 * In dev mode (`deno run …`) the argv prepends `deno run -A` and points
 * at this package's `./cli.ts`; in compiled-binary mode it spawns the
 * binary directly with {@link INTERNAL_HITL_MCP_ARG}.
 */
export function buildHitlMcpServerArgv(): string[] {
  const execPath = Deno.execPath();
  const execName = basename(execPath).toLowerCase();

  if (execName === "deno" || execName.startsWith("deno.")) {
    return [
      execPath,
      "run",
      "-A",
      fromFileUrl(new URL("./cli.ts", import.meta.url)),
      INTERNAL_HITL_MCP_ARG,
    ];
  }

  return [execPath, INTERNAL_HITL_MCP_ARG];
}
