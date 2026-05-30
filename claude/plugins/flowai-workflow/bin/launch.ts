#!/usr/bin/env -S deno run -A
/**
 * @module
 * flowai-workflow plugin launcher (FR-E74).
 *
 * Invoked by host-specific MCP config as:
 *   `deno run -A "<plugin-root>/bin/launch.ts" mcp`
 *   `deno run -A "./bin/launch.ts" mcp`
 *
 * Bootstraps the engine binary into `$CLAUDE_PLUGIN_DATA/bin/` on first
 * call (via `deno compile`, atomic via tmp→rename), then spawns the
 * cached binary with forwarded stdio + signals. Subsequent calls skip
 * compile. For the `mcp` subcommand, resolves the active workflow dir
 * from `$FLOWAI_WORKFLOW` → `$CLAUDE_PROJECT_DIR/.flowai-workflow/`
 * (single-candidate or `github-inbox` default) → `--no-workflow`.
 *
 * Zero non-`@std` imports — keeps the launcher offline-resilient and
 * keeps Deno cold-start as short as possible.
 *
 * The four pure helpers (`readPluginVersion`, `enumerateBundledWorkflowFiles`,
 * `resolveWorkflowDir`, `buildCompileArgs`) are exported solely so
 * `scripts/launch_test.ts` can unit-test them. They are not part of any
 * public plugin API — downstream code MUST NOT depend on this module.
 */

// Inline tiny path helpers (no `@std/path` import) so launch.ts resolves stand-
// alone without a sibling `deno.json`. The plugin payload puts
// `engine/deno.json` alongside this file but Deno walks UP for config
// and finds nothing useful from `bin/`. Our path inputs are always
// absolute and we never need normalization, `..`, or symlink
// resolution; POSIX-style join is all that's needed. Deno accepts
// forward slashes on Windows for these APIs.
function join(...parts: string[]): string {
  return parts.join("/");
}

function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function fromFileUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") {
    throw new Error(`Expected file: URL for launcher import, got ${url}`);
  }
  return decodeURIComponent(parsed.pathname);
}

const HOST_PLUGIN_ROOT_ENV = ["CLAUDE", "PLUGIN", "ROOT"].join("_");

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

/**
 * Read the `version` field from the host-specific plugin manifest.
 * Throws on missing file, malformed JSON, or missing `version` field —
 * these all indicate a broken plugin install, never a user error.
 */
export async function readPluginVersion(pluginRoot: string): Promise<string> {
  const candidates = [
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    join(pluginRoot, ".codex-plugin", "plugin.json"),
  ];
  let path = "";
  let text = "";
  for (const candidate of candidates) {
    try {
      text = await Deno.readTextFile(candidate);
      path = candidate;
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (!path) {
    throw new Error(
      `Missing plugin manifest. Tried: ${candidates.join(", ")}`,
    );
  }
  const obj = JSON.parse(text) as { version?: unknown };
  if (typeof obj.version !== "string" || obj.version.length === 0) {
    throw new Error(
      `plugin.json at ${path} is missing a "version" string`,
    );
  }
  return obj.version;
}

/**
 * Recursively enumerate files under `<pluginRoot>/.flowai-workflow/`.
 * Returns sorted absolute paths suitable for `deno compile --include`.
 * Returns `[]` when the bundle dir does not exist (degraded mode — the
 * compiled binary will simply have no bundled workflows).
 */
export async function enumerateBundledWorkflowFiles(
  pluginRoot: string,
): Promise<string[]> {
  const root = join(pluginRoot, ".flowai-workflow");
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    // Deno.readDir's NotFound surfaces at the first iteration, not at
    // the call; the try/catch must wrap the for-await.
    try {
      for await (const entry of Deno.readDir(dir)) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory) {
          await walk(abs);
        } else if (entry.isFile) {
          out.push(abs);
        }
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/** Options for {@link resolveWorkflowDir}. */
export interface ResolveOptions {
  /** Process environment. `FLOWAI_WORKFLOW` and `CLAUDE_PROJECT_DIR` are
   * read from here so the function stays pure for tests. */
  env: Record<string, string | undefined>;
  /** Project root. Defaults to `env.CLAUDE_PROJECT_DIR ?? Deno.cwd()`. */
  projectRoot?: string;
}

/**
 * Resolve which workflow folder the `mcp` subcommand should target.
 *
 * Priority:
 *  1. `env.FLOWAI_WORKFLOW` — explicit user override (treated as-is,
 *     even if it doesn't exist; the engine surfaces a clear error).
 *  2. Exactly one subdir of `<projectRoot>/.flowai-workflow/` that
 *     contains a `workflow.yaml`.
 *  3. `<projectRoot>/.flowai-workflow/github-inbox/` if present
 *     (default fallback on ambiguity).
 *  4. `null` — caller passes `--no-workflow` to the engine so the
 *     MCP handshake still completes with a structured diagnostic.
 */
export async function resolveWorkflowDir(
  opts: ResolveOptions,
): Promise<string | null> {
  if (opts.env.FLOWAI_WORKFLOW) return opts.env.FLOWAI_WORKFLOW;
  const projectRoot = opts.projectRoot ??
    opts.env.CLAUDE_PROJECT_DIR ?? Deno.cwd();
  const bundleDir = join(projectRoot, ".flowai-workflow");
  const candidates: string[] = [];
  try {
    for await (const entry of Deno.readDir(bundleDir)) {
      if (!entry.isDirectory) continue;
      const child = join(bundleDir, entry.name);
      try {
        const stat = await Deno.stat(join(child, "workflow.yaml"));
        if (stat.isFile) candidates.push(child);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  if (candidates.length === 1) return candidates[0];
  const gh = join(bundleDir, "github-inbox");
  if (candidates.includes(gh)) return gh;
  return null;
}

/**
 * Compose the args for `deno compile`. Pure — testable in isolation.
 * The launcher passes the result to `Deno.Command("deno", { args })`.
 */
export function buildCompileArgs(
  cliEntry: string,
  includes: string[],
  outputTmp: string,
): string[] {
  const args = ["compile", "--allow-all", "--no-check"];
  for (const f of includes) {
    args.push("--include", f);
  }
  args.push("--output", outputTmp, cliEntry);
  return args;
}

/** Resolve the plugin root from host env or this launcher's import URL. */
export function resolvePluginRoot(
  env: Record<string, string | undefined>,
  importMetaUrl: string,
): string {
  return env[HOST_PLUGIN_ROOT_ENV] ??
    dirname(dirname(fromFileUrl(importMetaUrl)));
}

/** Deterministic writable data dir used when Claude-specific env is absent. */
export function codexDataDir(env: Record<string, string | undefined>): string {
  if (env.FLOWAI_PLUGIN_DATA) return env.FLOWAI_PLUGIN_DATA;
  if (env.CODEX_HOME) {
    return join(env.CODEX_HOME, "plugins/data/flowai-workflow");
  }
  if (env.HOME) return join(env.HOME, ".codex/plugins/data/flowai-workflow");
  throw new Error(
    "Cannot resolve flowai-workflow plugin data directory: set " +
      "FLOWAI_PLUGIN_DATA, CODEX_HOME, or HOME.",
  );
}

/** Resolve host data dir while preserving Claude Code's explicit location. */
export function resolvePluginData(
  env: Record<string, string | undefined>,
): string {
  return env.CLAUDE_PLUGIN_DATA ?? codexDataDir(env);
}

// ---------------------------------------------------------------------------
// Main launcher (entry point).
// ---------------------------------------------------------------------------

async function ensureBinary(
  pluginRoot: string,
  pluginData: string,
  version: string,
): Promise<string> {
  const binDir = join(pluginData, "bin");
  const bin = join(binDir, `flowai-workflow-${version}`);
  try {
    const stat = await Deno.stat(bin);
    if (stat.isFile) return bin;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  await Deno.mkdir(binDir, { recursive: true });
  const includes = await enumerateBundledWorkflowFiles(pluginRoot);
  const cliEntry = join(pluginRoot, "engine", "cli.ts");
  const tmp = `${bin}.tmp.${Deno.pid}`;
  const args = buildCompileArgs(cliEntry, includes, tmp);

  // PATH-lookup `deno` (NOT Deno.execPath) so test fixtures can shim
  // the compile step. In production both resolve to the same binary.
  const compileResult = await new Deno.Command("deno", {
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!compileResult.success) {
    Deno.exit(compileResult.code);
  }
  await Deno.rename(tmp, bin);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(bin, 0o755);
  }
  return bin;
}

async function main(): Promise<never> {
  // Install signal handlers FIRST — before any `await`. Deno's default
  // kernel handler terminates the process on SIGTERM until JS registers
  // a listener. Even sub-second `await`s open a race window where a
  // SIGTERM from the parent (Claude Code shutdown, test harness, user
  // Ctrl+C) kills the launcher before the child is forwarded. The
  // closure keeps a `let` reference that becomes non-null once the
  // child is spawned. On Windows `addSignalListener("SIGTERM", ...)`
  // throws TypeError; swallow it so SIGINT (always supported via
  // Deno's console handling) still works.
  let child: Deno.ChildProcess | null = null;
  const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];
  for (const sig of signals) {
    try {
      Deno.addSignalListener(sig, () => {
        if (child) {
          try {
            child.kill(sig);
          } catch {
            // Child already exited — race between status resolution
            // and signal delivery. Safe to ignore.
          }
        } else {
          // Signal arrived before spawn — exit with conventional code.
          Deno.exit(sig === "SIGTERM" ? 143 : 130);
        }
      });
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
  }

  const env = Deno.env.toObject();
  const pluginRoot = resolvePluginRoot(env, import.meta.url);
  const pluginData = resolvePluginData(env);
  try {
    const stat = await Deno.stat(pluginRoot);
    if (!stat.isDirectory) {
      throw new Error(`${pluginRoot} is not a directory`);
    }
  } catch (error) {
    console.error(
      `Error: flowai-workflow plugin root is missing (${pluginRoot}) ` +
        `resolved from ${import.meta.url}: ${(error as Error).message}`,
    );
    Deno.exit(2);
  }
  const version = await readPluginVersion(pluginRoot);
  const bin = await ensureBinary(pluginRoot, pluginData, version);

  // Resolve subcommand: only `mcp` needs workflow-dir injection; every
  // other subcommand is forwarded verbatim.
  const rawArgs = [...Deno.args];
  let binArgs: string[];
  if (rawArgs[0] === "mcp") {
    const rest = rawArgs.slice(1);
    const wf = await resolveWorkflowDir({ env: Deno.env.toObject() });
    binArgs = wf !== null
      ? ["mcp", wf, ...rest]
      : ["mcp", "--no-workflow", ...rest];
  } else {
    binArgs = rawArgs;
  }

  child = new Deno.Command(bin, {
    args: binArgs,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const { code } = await child.status;
  // code === null when the child was killed by a signal. Map to a
  // non-zero exit so Claude Code reports the spawn as failed.
  Deno.exit(code ?? 1);
}

if (import.meta.main) {
  await main();
}
