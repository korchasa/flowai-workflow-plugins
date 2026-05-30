#!/usr/bin/env -S deno run -A
/**
 * @module
 * CLI entry point for the workflow engine.
 * Parses arguments and delegates to the appropriate subcommand:
 *
 * - `flowai-workflow run <workflow> [options]` → DAG workflow engine
 * - `flowai-workflow init [options]` → project scaffolder
 *
 * Run usage (FR-E53):
 *   flowai-workflow run <workflow> [options]
 *
 * Positional:
 *   <workflow>            Path to workflow folder containing workflow.yaml.
 *                         Mandatory; no autodetection.
 *
 * Options:
 *   --prompt <text>       Additional context for PM agent (sets args.prompt)
 *   --resume <run-id>     Resume a previous run from its state
 *   --dry-run             Print execution plan without running
 *   -v, --verbose         Show full streaming output
 *   -s, --semi-verbose    Show text output only (suppress tool calls)
 *   -q, --quiet           Show errors only
 *   --env <KEY=VAL>       Set environment variable (repeatable)
 *   --skip <node-ids>     Comma-separated node IDs to skip
 *   --only <node-ids>     Comma-separated node IDs to run exclusively
 *   --cycles <N>          Run the whole workflow N times sequentially (default 1)
 *   --skip-update-check   Do not check JSR for a newer version on startup
 *   --version / -V        Print version and exit
 */

import type { EngineOptions, Verbosity } from "./types.ts";
import { Engine } from "./engine.ts";
import {
  INTERNAL_HITL_MCP_ARG,
  runFlowaiHitlMcpServer,
} from "./hitl-mcp-server.ts";
import { installSignalHandlers } from "./process-registry.ts";
import { checkForUpdate } from "./version.ts";
import { runMcpServer } from "./mcp-server.ts";

/** Version string embedded at compile time via VERSION env var. Defaults to "dev". */
export const VERSION: string = Deno.env.get("VERSION") ?? "dev";

/** Result of {@link extractCliFlags}: CLI-only flags plus the remaining args. */
export interface CliFlags {
  /** True when user passed `--skip-update-check`. */
  skipUpdateCheck: boolean;
  /**
   * Number of times to run the whole workflow sequentially (`--cycles N`).
   * Defaults to 1. Each cycle is an independent `Engine.run()` with its
   * own auto-generated run-id; on the first non-completed cycle the
   * launcher stops (fail-fast).
   */
  cycles: number;
  /** Remaining args with CLI-only flags stripped; passed to {@link parseArgs}. */
  remaining: string[];
}

/**
 * Extract CLI-only flags (things that never belong on {@link EngineOptions}
 * because they are not domain concerns of the engine). Handles
 * `--skip-update-check` and `--cycles <N>`. Returns both the parsed flags
 * and the remaining args so the caller can forward the rest to
 * {@link parseArgs}.
 */
export function extractCliFlags(args: string[]): CliFlags {
  let skipUpdateCheck = false;
  let cycles = 1;
  const remaining: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--skip-update-check") {
      skipUpdateCheck = true;
      continue;
    }
    if (a === "--cycles") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(
          `Invalid --cycles value: ${raw}. Expected positive integer.`,
        );
      }
      cycles = parsed;
      continue;
    }
    remaining.push(a);
  }
  return { skipUpdateCheck, cycles, remaining };
}

/** Returns the formatted version string for `--version` output. */
export function getVersionString(): string {
  return `flowai-workflow v${VERSION}`;
}

/** Normalise a workflow folder positional argument: strip trailing slashes.
 * Shared between `run` (workflow.yaml path resolution) and `mcp`
 * (workflowDir argument for `runMcpServer`). FR-E73. */
export function normalizeWorkflowDir(arg: string): string {
  return arg.replace(/\/+$/, "");
}

/**
 * Parse CLI arguments into EngineOptions.
 *
 * The first non-flag positional argument is the workflow folder path
 * (FR-E53; mandatory at runtime). Flags may appear before or after the
 * positional. `config_path` is left empty when no positional is supplied
 * — {@link runEngine} enforces presence at the run boundary so unit tests
 * can call `parseArgs([])` to inspect defaults.
 */
export function parseArgs(args: string[]): EngineOptions {
  let configPath = "";
  let runId: string | undefined;
  let resume = false;
  let dryRun = false;
  let verbosity: Verbosity = "normal";
  const cliArgs: Record<string, string> = {};
  const envOverrides: Record<string, string> = {};
  let skipNodes: string[] | undefined;
  let onlyNodes: string[] | undefined;
  let budgetUsd: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--config":
        throw new Error(
          "Unknown flag: --config (removed in FR-E53). " +
            "Pass the workflow folder as a positional argument: " +
            "`flowai-workflow run <workflow> [options]`.",
        );
      case "--workflow":
        throw new Error(
          "Unknown flag: --workflow (removed in FR-E53). " +
            "Pass the workflow folder as a positional argument: " +
            "`flowai-workflow run <workflow> [options]`.",
        );
      case "--prompt":
        cliArgs.prompt = args[++i];
        break;
      case "--resume":
        resume = true;
        runId = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "-v":
      case "--verbose":
        verbosity = "verbose";
        break;
      case "-s":
      case "--semi-verbose":
        verbosity = "semi-verbose";
        break;
      case "-q":
      case "--quiet":
        verbosity = "quiet";
        break;
      case "--env": {
        const val = args[++i];
        const eqIdx = val.indexOf("=");
        if (eqIdx === -1) {
          throw new Error(`Invalid --env format: ${val}. Expected KEY=VALUE`);
        }
        envOverrides[val.substring(0, eqIdx)] = val.substring(eqIdx + 1);
        break;
      }
      case "--skip":
        skipNodes = args[++i].split(",").map((s) => s.trim());
        break;
      case "--only":
        onlyNodes = args[++i].split(",").map((s) => s.trim());
        break;
      case "--budget": {
        const raw = args[++i];
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(
            `Invalid --budget value: ${raw}. Expected positive number of USD.`,
          );
        }
        budgetUsd = parsed;
        break;
      }
      case "--version":
      case "-V":
        handleVersion();
        break;
      case "--help":
      case "-h":
        printUsage();
        Deno.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          // Generic --key value passthrough.
          const key = arg.substring(2);
          cliArgs[key] = args[++i] ?? "";
        } else if (configPath === "") {
          // First positional → workflow folder path.
          configPath = `${normalizeWorkflowDir(arg)}/workflow.yaml`;
        } else {
          throw new Error(
            `Unexpected positional argument: ${arg}. ` +
              `Only one workflow folder is accepted.`,
          );
        }
    }
  }

  return {
    config_path: configPath,
    run_id: runId,
    resume,
    dry_run: dryRun,
    verbosity,
    args: cliArgs,
    env_overrides: envOverrides,
    skip_nodes: skipNodes,
    only_nodes: onlyNodes,
    budget_usd: budgetUsd,
  };
}

function handleVersion(): never {
  console.log(getVersionString());
  Deno.exit(0);
}

function printUsage(): void {
  console.log(`
Workflow Engine — Configurable multi-agent workflow runner

Usage:
  flowai-workflow run <workflow> [options]  Execute DAG workflow
  flowai-workflow init [options]            Scaffold .flowai-workflow/ directory
  flowai-workflow mcp <workflow>            Start embedded MCP server (FR-E73)

Subcommands:
  run                   Execute DAG workflow engine
  init                  Scaffold .flowai-workflow/ directory (run init --help for details)
  mcp <workflow>        Start embedded MCP server exposing 7 engine-control tools over stdio

Run positional:
  <workflow>            Path to workflow folder containing workflow.yaml (mandatory).

Run options:
  --prompt <text>       Additional context for PM agent (optional)
  --resume <run-id>     Resume a previous run
  --dry-run             Print execution plan without running
  -v, --verbose         Show full streaming output from agents
  -s, --semi-verbose    Show text output only (suppress tool calls)
  -q, --quiet           Show errors only
  --env <KEY=VAL>       Set environment variable (repeatable)
  --skip <node-ids>     Comma-separated node IDs to skip
  --only <node-ids>     Comma-separated node IDs to run exclusively
  --budget <USD>        Workflow-wide cost cap (positive USD; strict >)
  --cycles <N>          Run the whole workflow N times sequentially (default 1;
                        stops on the first non-completed cycle; not compatible
                        with --resume)
  --skip-update-check   Do not check JSR for a newer version on startup

Global options:
  -V, --version         Print version and exit
  -h, --help            Show this help

Examples:
  flowai-workflow run .flowai-workflow/github-inbox
  flowai-workflow run .flowai-workflow/github-inbox --prompt "Focus on the login bug"
  flowai-workflow run .flowai-workflow/github-inbox --resume 20260308T143022 -v
  flowai-workflow run .flowai-workflow/github-inbox --dry-run
  flowai-workflow mcp .flowai-workflow/github-inbox
`);
}

// --- Main ---

/**
 * Run the DAG workflow engine with the given args (after `run` is stripped).
 * Shared between the `run` subcommand and the backward-compat shim.
 */
async function runEngine(args: string[]): Promise<never> {
  // Signal handlers are installed once at the top of `if (import.meta.main)`
  // so every subcommand shares the same routing (FR-E61: engine never
  // installs handlers — CLI is the sole owner).
  try {
    const { skipUpdateCheck, cycles, remaining } = extractCliFlags(args);
    const options = parseArgs(remaining);

    // FR-E53: workflow path is mandatory and positional.
    if (!options.config_path) {
      throw new Error(
        "Missing workflow argument. " +
          "Usage: flowai-workflow run <workflow> [options]",
      );
    }

    // `--cycles N` repeats the whole workflow; resuming a specific run
    // is incompatible with that semantics.
    if (cycles > 1 && options.resume) {
      throw new Error(
        "--cycles cannot be combined with --resume: resume targets a " +
          "single run-id, while --cycles starts fresh runs.",
      );
    }

    // Notify the user if a newer version is on JSR. Fail-open: any network
    // or parse error returns null and we silently continue. Skipped when
    // the binary was built without a real VERSION (local `deno run`) or
    // when the user explicitly opted out.
    if (!skipUpdateCheck && VERSION !== "dev") {
      const update = await checkForUpdate(VERSION);
      if (update?.updateAvailable) {
        console.error(
          `Update available: ${update.currentVersion} → ${update.latestVersion}\n` +
            `Run: ${update.updateCommand}\n`,
        );
      }
    }

    // Load .env file if it exists
    try {
      const envFile = await Deno.readTextFile(".env");
      for (const line of envFile.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim().replace(
          /^['"]|['"]$/g,
          "",
        );
        // Don't override explicit --env values
        if (!(key in options.env_overrides)) {
          options.env_overrides[key] = value;
        }
      }
    } catch {
      // .env file is optional
    }

    for (let cycle = 1; cycle <= cycles; cycle++) {
      if (cycles > 1 && options.verbosity !== "quiet") {
        console.error(`\n=== Cycle ${cycle}/${cycles} ===\n`);
      }
      const engine = new Engine(options);
      const state = await engine.run();
      if (state.status !== "completed") {
        Deno.exit(1);
      }
    }
    Deno.exit(0);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    Deno.exit(2);
  }
}

/**
 * Print a one-line deprecation banner for users who installed the engine
 * via JSR or a prebuilt binary (FR-E70 plugin-first distribution). The
 * banner is suppressed when:
 *
 *  - `FLOWAI_SUPPRESS_DEPRECATION=1` is set (CI, plugin launcher,
 *    long-running embeddings),
 *  - the engine is invoked as the HITL MCP server (internal subprocess,
 *    `INTERNAL_HITL_MCP_ARG`),
 *  - or `VERSION === "dev"` (local `deno run` against source — no JSR
 *    install to migrate from).
 *
 * The plugin launcher skills (`run/SKILL.md`, `init/SKILL.md`) export
 * `FLOWAI_SUPPRESS_DEPRECATION=1` before invoking the bundled engine so
 * plugin-installed users do not see it — only standalone JSR/binary
 * users do, telling them to migrate.
 */
function maybePrintDeprecationBanner(): void {
  if (Deno.env.get("FLOWAI_SUPPRESS_DEPRECATION") === "1") return;
  if (VERSION === "dev") return;
  console.error(
    "[DEPRECATION] Standalone JSR / binary distribution of flowai-workflow " +
      "is being retired. Migrate to the Claude Code / Codex plugin: " +
      "see https://github.com/korchasa/flowai-workflow#install. " +
      "Set FLOWAI_SUPPRESS_DEPRECATION=1 to silence this notice.",
  );
}

if (import.meta.main) {
  // Internal dispatch: engine-owned HITL MCP server. Every MCP-capable
  // runtime adapter (Claude / OpenCode / Codex) spawns the engine binary
  // with this flag via the `mcpServers` invoke option (FR-L35; hitl-via-engine-mcp).
  if (Deno.args[0] === INTERNAL_HITL_MCP_ARG) {
    await runFlowaiHitlMcpServer();
    Deno.exit(0);
  }

  maybePrintDeprecationBanner();

  // Single signal-handler install for the whole process (FR-E61). All
  // subcommands inherit the same routing; the engine never installs its own.
  installSignalHandlers();

  const subcommand = Deno.args[0];

  // Global flags handled before subcommand dispatch
  if (subcommand === "--version" || subcommand === "-V") {
    handleVersion();
  }
  if (subcommand === "--help" || subcommand === "-h") {
    printUsage();
    Deno.exit(0);
  }

  // Subcommand: `run` → DAG workflow engine
  if (subcommand === "run") {
    await runEngine(Deno.args.slice(1));
  }

  // Subcommand: `init` → verbatim copy of a bundled workflow folder.
  if (subcommand === "init") {
    const { runInit } = await import("./init/mod.ts");
    const exitCode = await runInit(Deno.args.slice(1), {
      engineVersion: VERSION,
    });
    Deno.exit(exitCode);
  }

  // Subcommand: `mcp <workflow>` or `mcp --no-workflow` (FR-E73, FR-E74).
  // `runMcpServer` is imported statically: a dynamic `await import()` here
  // deadlocks in Deno 2.8 when the static graph (Engine → ai-ide-cli) already
  // pulled @modelcontextprotocol/sdk + zod, leaving the MCP handshake stuck
  // and Claude Code reporting the server as "connecting".
  if (subcommand === "mcp") {
    const rest = Deno.args.slice(1);
    if (rest.includes("--no-workflow")) {
      // Plugin launcher passes this when no .flowai-workflow/<name>/
      // folder is resolvable in the current project (FR-E74). The
      // server still completes the MCP handshake; tool calls return a
      // structured missing-workflow error.
      await runMcpServer(undefined, { noWorkflow: true });
      Deno.exit(0);
    }
    const positional = rest[0];
    if (!positional) {
      console.error(
        "Error: missing workflow argument. " +
          "Usage: flowai-workflow mcp <workflow> | --no-workflow",
      );
      Deno.exit(1);
    }
    const workflowDir = normalizeWorkflowDir(positional);
    await runMcpServer(workflowDir);
    Deno.exit(0);
  }

  // Backward-compat shim: bare `--` flags without `run` prefix.
  // Treat as `run <args>` with a deprecation warning. Remove after 2 minor releases.
  if (subcommand && subcommand.startsWith("--")) {
    console.error(
      "[DEPRECATED] Running engine with bare flags is deprecated. " +
        "Use `flowai-workflow run <workflow> [options]` instead.\n",
    );
    await runEngine(Deno.args);
  }

  // Default (no args or unknown subcommand): print usage and exit non-zero.
  if (!subcommand) {
    printUsage();
    Deno.exit(1);
  }
  console.error(`Error: unknown subcommand: ${subcommand}`);
  printUsage();
  Deno.exit(1);
}
