/**
 * @module
 * Public entry point for `flowai-workflow init`. Dispatched from
 * [`cli.ts`](../cli.ts) when the user runs `flowai-workflow init`.
 *
 * The init command is a verbatim file copy: it locates the requested
 * workflow inside the package's bundled `.flowai-workflow/<workflow>/`
 * directory and copies it into the target project at the same relative
 * path. There is no placeholder substitution and no autodetection —
 * project-specific configuration (test commands, branch names, repo
 * conventions) is the agents' responsibility at first run.
 *
 * **Workflow selection.** When `--workflow <name>` is omitted and stdin
 * is a TTY, init prints a numbered list of bundled workflows and
 * prompts the user to pick one (or accept the default). Non-TTY
 * stdin (CI / piped) falls back to the default workflow silently —
 * scripted callers should pass `--workflow` explicitly to be future-
 * proof.
 *
 * Available workflows are discovered at runtime by reading the package's
 * `.flowai-workflow/` directory (any subfolder containing `workflow.yaml`
 * counts). Compiled binaries embed the workflows via `deno compile
 * --include`; see [`scripts/compile.ts`](../scripts/compile.ts).
 *
 * Exit codes:
 * - `0` — success (help, list, dry-run, or full scaffold completed)
 * - `1` — scaffold or preflight failed
 * - `3` — invalid CLI arguments
 */

import { fromFileUrl, join } from "@std/path";
import { runPreflight, summarizeFailures } from "./preflight.ts";
import { copyTemplate, listTemplateFiles, unwindScaffold } from "./scaffold.ts";

export type { WorkflowName } from "./types.ts";

/** Default workflow shipped under `<package-root>/.flowai-workflow/`. */
const DEFAULT_WORKFLOW = "github-inbox";

/** Options the engine passes down when invoking the init dispatcher. */
export interface RunInitOptions {
  /**
   * Engine version string. Currently informational — surfaced in the
   * post-scaffold success message so users can correlate the scaffolded
   * tree with the engine release that produced it.
   */
  engineVersion?: string;
  /**
   * Working directory the init command operates on. Defaults to
   * `Deno.cwd()`. Integration tests override this to run against
   * isolated temp directories.
   */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Flag parsing — pure, unit-testable. Returns a tagged union so the caller
// can route between help / list / error / run paths without inspecting fields.
// ---------------------------------------------------------------------------

/** Result of flag parsing — one of four shapes. */
export type ParsedInitArgs =
  | { kind: "help" }
  | { kind: "list"; bundleDir?: string }
  | { kind: "error"; message: string }
  | {
    kind: "run";
    workflow: string;
    /**
     * True iff the user passed `--workflow` explicitly. Drives the
     * interactive-picker decision in {@link runInit}: omitted +
     * TTY → prompt; explicit → skip prompt.
     */
    workflowExplicit: boolean;
    dryRun: boolean;
    allowDirty: boolean;
    /**
     * Override for the bundled-workflows lookup root (FR-E70). When
     * set, `listAvailableWorkflows` and the per-workflow source
     * resolution use `<bundleDir>/<name>/` instead of the package-
     * relative `../.flowai-workflow/<name>/`. The plugin launcher
     * skill (`init/SKILL.md`) passes
     * `--bundle-dir "$CLAUDE_PLUGIN_ROOT/.flowai-workflow"` so the
     * plugin-installed engine can find its bundled workflows even
     * though the engine TS source lives elsewhere in the plugin
     * payload. Unset → default behaviour preserved.
     */
    bundleDir?: string;
  };

/**
 * Parse `init`-subcommand flags. Returns a tagged union describing the
 * action to take. Never touches stdin or the filesystem.
 */
export function parseInitArgs(args: string[]): ParsedInitArgs {
  let workflow = DEFAULT_WORKFLOW;
  let workflowExplicit = false;
  let dryRun = false;
  let allowDirty = false;
  let bundleDir: string | undefined;
  let listRequested = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--list":
      case "-l":
        listRequested = true;
        break;
      case "--workflow": {
        const value = args[++i];
        if (value === undefined) {
          return {
            kind: "error",
            message: "--workflow requires a value",
          };
        }
        workflow = value;
        workflowExplicit = true;
        break;
      }
      case "--bundle-dir": {
        const value = args[++i];
        if (value === undefined) {
          return {
            kind: "error",
            message: "--bundle-dir requires a directory path",
          };
        }
        bundleDir = value;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--allow-dirty":
        allowDirty = true;
        break;
      default:
        return {
          kind: "error",
          message:
            `Unknown argument: ${arg}. Run \`flowai-workflow init --help\`.`,
        };
    }
  }

  if (listRequested) return { kind: "list", bundleDir };
  return {
    kind: "run",
    workflow,
    workflowExplicit,
    dryRun,
    allowDirty,
    bundleDir,
  };
}

/** Help text printed by `flowai-workflow init --help`. */
export function initHelpText(): string {
  return `flowai-workflow init — copy a bundled workflow into the current project

Usage:
  flowai-workflow init [options]

Options:
  --workflow <name>        Workflow folder under <package>/.flowai-workflow/
                           (default: ${DEFAULT_WORKFLOW}). Omit to be
                           prompted interactively (TTY only).
  --bundle-dir <path>      Override bundled-workflows lookup root
                           (FR-E70). Used by the Claude Code / Codex
                           plugin launcher to pass
                           \`$CLAUDE_PLUGIN_ROOT/.flowai-workflow\`.
  -l, --list               List workflows bundled with this build, exit 0
  --allow-dirty            Skip the clean-git-tree preflight check
  --dry-run                Print files that would be created, exit 0
  -h, --help               Show this help and exit

Exit codes:
  0  success (help, list, dry-run, or full scaffold completed)
  1  preflight or scaffold failed
  3  invalid arguments

After init, run the workflow with a project-context prompt so the agents
can adapt themselves to your repo conventions:
  flowai-workflow run .flowai-workflow/<workflow> --prompt "<context>"

Examples:
  flowai-workflow init                        # interactive workflow picker
  flowai-workflow init --workflow autonomous-sdlc
  flowai-workflow init --list
  flowai-workflow init --workflow github-inbox --dry-run`;
}

// ---------------------------------------------------------------------------
// Workflow discovery
// ---------------------------------------------------------------------------

/**
 * Enumerate every workflow bundled with this build. A directory under
 * `<package-root>/.flowai-workflow/` qualifies iff it contains a
 * `workflow.yaml` at its root — that's the only file the engine
 * absolutely requires, so it doubles as the discriminator that
 * distinguishes a real workflow folder from leftover dirt
 * (e.g. an empty `.template.json` file at the package root).
 *
 * Result is sorted alphabetically. Works in `deno run`, JSR-installed,
 * and `deno compile`d binary modes — the lookup uses
 * `import.meta.url`-relative URLs and `Deno.readDir` traverses both
 * on-disk and embedded virtual filesystems.
 */
export async function listAvailableWorkflows(
  bundleDir?: string,
): Promise<string[]> {
  let rootPath: string;
  if (bundleDir !== undefined) {
    rootPath = bundleDir;
  } else {
    const rootUrl = new URL("../.flowai-workflow/", import.meta.url);
    try {
      rootPath = fromFileUrlCompat(rootUrl);
    } catch {
      return [];
    }
  }

  const names: string[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(rootPath);
  } catch {
    return [];
  }
  for await (const entry of entries) {
    if (!entry.isDirectory) continue;
    try {
      const stat = await Deno.stat(join(rootPath, entry.name, "workflow.yaml"));
      if (stat.isFile) names.push(entry.name);
    } catch {
      // Missing workflow.yaml → not a workflow folder; skip.
    }
  }
  names.sort();
  return names;
}

// ---------------------------------------------------------------------------
// Interactive workflow picker
// ---------------------------------------------------------------------------

/**
 * Result of {@link resolveWorkflowChoice}: either a resolved workflow
 * name or a re-prompt message describing why the input was rejected.
 */
export type WorkflowChoiceResult =
  | { ok: true; workflow: string }
  | { ok: false; message: string };

/**
 * Pure interpretation of one user input line at the workflow-picker
 * prompt. Accepts: empty (use default), 1-based index into the sorted
 * list, or an exact workflow name. Anything else is rejected with a
 * caller-displayable message — the interactive loop re-prompts.
 *
 * Factored out of the I/O loop so the dispatch table stays unit-
 * testable without mocking stdin.
 */
export function resolveWorkflowChoice(
  rawInput: string,
  available: readonly string[],
  defaultName: string,
): WorkflowChoiceResult {
  const input = rawInput.trim();

  if (input === "") {
    if (available.includes(defaultName)) {
      return { ok: true, workflow: defaultName };
    }
    return {
      ok: false,
      message:
        `default workflow "${defaultName}" is not bundled with this build; ` +
        `pick one from the list above`,
    };
  }

  if (/^[0-9]+$/.test(input)) {
    const idx = Number(input);
    if (idx < 1 || idx > available.length) {
      return {
        ok: false,
        message:
          `${idx} is out of range; pick a number between 1 and ${available.length}`,
      };
    }
    return { ok: true, workflow: available[idx - 1] };
  }

  if (available.includes(input)) {
    return { ok: true, workflow: input };
  }
  return {
    ok: false,
    message: `unknown workflow "${input}"; pick one from the list above`,
  };
}

/**
 * Drive the interactive workflow-picker loop on stdin/stderr. Prints
 * the numbered list once, then keeps re-prompting until the user
 * supplies a valid choice or sends EOF (treated as cancellation,
 * surfaces as a thrown error so the caller can exit non-zero).
 *
 * Caller is responsible for deciding whether to invoke this — usually
 * gated on `Deno.stdin.isTerminal()` and the absence of an explicit
 * `--workflow`. Output goes to stderr so a piped `--dry-run` keeps
 * stdout machine-parseable.
 */
async function promptForWorkflow(
  available: readonly string[],
  defaultName: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const write = (s: string) => Deno.stderr.writeSync(encoder.encode(s));

  write("Available workflows:\n");
  for (let i = 0; i < available.length; i++) {
    const marker = available[i] === defaultName ? " (default)" : "";
    write(`  ${i + 1}) ${available[i]}${marker}\n`);
  }

  while (true) {
    const defaultIdx = available.indexOf(defaultName);
    const promptDefault = defaultIdx >= 0 ? `, default ${defaultIdx + 1}` : "";
    write(`Choose [1-${available.length}${promptDefault}]: `);
    const line = await readLine();
    if (line === null) {
      throw new Error("workflow selection cancelled (stdin closed)");
    }
    const result = resolveWorkflowChoice(line, available, defaultName);
    if (result.ok) return result.workflow;
    write(`  ${result.message}.\n`);
  }
}

/**
 * Read one line from stdin. Returns `null` on EOF (no bytes) so the
 * caller can distinguish "user pressed Enter" (empty string) from
 * "stdin closed". Strips the trailing newline.
 */
async function readLine(): Promise<string | null> {
  const buf = new Uint8Array(4096);
  const n = await Deno.stdin.read(buf);
  if (n === null || n === 0) return null;
  return new TextDecoder().decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
}

// ---------------------------------------------------------------------------
// Adaptation prompt — printed at the end of a successful scaffold so the
// user can immediately feed it to the agents and have them tune the
// workflow to the concrete project (test commands, default branch, repo
// conventions, etc.).
// ---------------------------------------------------------------------------

/**
 * Render the ready-to-paste adaptation prompt that init prints after a
 * successful scaffold. The prompt instructs the agents to inspect the
 * project, detect language/runtime/test/lint/branch conventions, and
 * patch the freshly copied workflow files (`workflow.yaml` and
 * `agents/agent-*.md`) so subsequent runs carry project-specific
 * guidance.
 *
 * Returned as plain text without surrounding shell quotes — the printed
 * UX wraps it in clear delimiters and tells the user how to paste it
 * into `flowai-workflow run --prompt`. This keeps the prompt safe to
 * copy regardless of the user's shell or quoting style.
 */
export function adaptationPrompt(workflowDir: string): string {
  return `Adapt the freshly scaffolded workflow at ${workflowDir} to this
project. Read-only inspection first, then targeted edits.

Detect from the repository:
  - Language and runtime (deno.json / package.json / Cargo.toml / go.mod /
    pyproject.toml — pick whichever is present).
  - Test command and lint/format/check command. Prefer existing
    \`tasks\` / \`scripts\` entries; otherwise the runtime's idiomatic
    default (e.g. \`deno task test\`, \`npm test\`, \`cargo test\`,
    \`go test ./...\`, \`pytest\`).
  - Default branch — \`git symbolic-ref refs/remotes/origin/HEAD\`,
    fall back to \`main\`.
  - Repo slug if origin is on github.com (\`gh repo view --json
    nameWithOwner -q .nameWithOwner\` if available, otherwise parse
    \`git remote get-url origin\`).
  - Code-style guide: AGENTS.md / CLAUDE.md / CONTRIBUTING.md / .editorconfig
    / eslint or biome configs / pre-commit hooks. Note any hard rules
    (TDD-only, "no Edit on main", PR-template requirements, etc.).
  - Existing CI gates (.github/workflows/*.yml, .gitlab-ci.yml) — what
    must pass before merge.

Then update files in place:
  - ${workflowDir}/workflow.yaml — replace any hardcoded test/lint
    invocations or branch names with the detected values. Do not
    rename nodes; only touch the values that actually need to differ.
  - ${workflowDir}/agents/agent-*.md — append a clearly delimited
    \`## Project Context\` section to each agent prompt, listing the
    detected facts and any non-obvious project conventions the role
    needs to know. Keep it concise — this section is read on every
    invocation and burns context.

Project parameters you should fill in if detection is ambiguous (ask
before guessing):
  - Project name:
  - Default branch:
  - Test command:
  - Lint/format/check command:
  - Repo slug (owner/repo, GitHub):
  - Hard code-style rules:
  - CI gates required before merge:

When done: print a one-paragraph summary of what changed and why.
Do NOT commit, push, or open a PR. Leave the diff for the user to review.`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Entry point invoked by the engine dispatcher. Accepts the raw `argv`
 * (after the `init` subcommand is stripped) and returns an exit code.
 */
export async function runInit(
  argv: string[],
  opts: RunInitOptions = {},
): Promise<number> {
  const parsed = parseInitArgs(argv);
  if (parsed.kind === "help") {
    console.log(initHelpText());
    return 0;
  }
  if (parsed.kind === "list") {
    const workflows = await listAvailableWorkflows(parsed.bundleDir);
    if (workflows.length === 0) {
      console.error(
        "No bundled workflows found. This build is missing the " +
          "`.flowai-workflow/` directory — please report a bug.",
      );
      return 1;
    }
    console.log("Bundled workflows (use --workflow <name>):");
    for (const name of workflows) {
      const marker = name === DEFAULT_WORKFLOW ? " (default)" : "";
      console.log(`  ${name}${marker}`);
    }
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`Error: ${parsed.message}`);
    return 3;
  }

  const cwd = opts.cwd ?? Deno.cwd();
  const engineVersion = opts.engineVersion ?? "dev";

  // --- Resolve workflow: explicit flag wins; otherwise prompt on TTY ---
  let workflow = parsed.workflow;
  if (!parsed.workflowExplicit && Deno.stdin.isTerminal()) {
    const available = await listAvailableWorkflows(parsed.bundleDir);
    if (available.length === 0) {
      console.error(
        "No bundled workflows found. This build is missing the " +
          "`.flowai-workflow/` directory — please report a bug.",
      );
      return 1;
    }
    if (available.length === 1) {
      // Single choice — skip the prompt.
      workflow = available[0];
    } else {
      try {
        workflow = await promptForWorkflow(available, DEFAULT_WORKFLOW);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        return 1;
      }
    }
  }

  const targetWorkflowDir = join(cwd, ".flowai-workflow", workflow);

  // --- Resolve workflow source from the package's bundled tree ----------
  let sourceDir: string;
  try {
    if (parsed.bundleDir !== undefined) {
      sourceDir = join(parsed.bundleDir, workflow);
    } else {
      sourceDir = fromFileUrlCompat(resolveWorkflowSource(workflow));
    }
    const stat = await Deno.stat(sourceDir);
    if (!stat.isDirectory) throw new Error("not a directory");
  } catch (_err) {
    const available = await listAvailableWorkflows(parsed.bundleDir);
    const list = available.length > 0
      ? `Available workflows: ${available.join(", ")}.`
      : `This build has no bundled workflows.`;
    console.error(
      `Error: workflow "${workflow}" is not bundled with this build. ${list}`,
    );
    return 1;
  }

  // --- Preflight ---------------------------------------------------------
  const preflight = await runPreflight({
    cwd,
    targetDir: targetWorkflowDir,
    allowDirty: parsed.allowDirty,
  });
  if (preflight.failures.length > 0) {
    console.error(summarizeFailures(preflight.failures));
    return 1;
  }

  // --- Dry-run short-circuit --------------------------------------------
  if (parsed.dryRun) {
    console.log(
      `\nDry run — the following files would be written into ` +
        `${targetWorkflowDir}:`,
    );
    const files = (await listTemplateFiles(sourceDir)).sort();
    for (const path of files) {
      console.log(`  ${join(targetWorkflowDir, path)}`);
    }
    console.log(`\nTotal: ${files.length} files. No changes applied.`);
    return 0;
  }

  // --- Scaffold ----------------------------------------------------------
  let createdPaths: string[] = [];
  try {
    createdPaths = await copyTemplate(sourceDir, targetWorkflowDir);
  } catch (err) {
    console.error(`Error: scaffold failed: ${(err as Error).message}`);
    await unwindScaffold(createdPaths);
    return 1;
  }

  // --- Success message + adaptation prompt ------------------------------
  const prompt = adaptationPrompt(targetWorkflowDir);
  console.log(
    `\n✓ Initialized ${targetWorkflowDir} (engine ${engineVersion})\n\n` +
      `NEXT — adapt the workflow to your project. Pass the prompt below to:\n` +
      `  flowai-workflow run ${targetWorkflowDir} --prompt "<paste prompt>"\n` +
      `or, with a heredoc:\n` +
      `  flowai-workflow run ${targetWorkflowDir} --prompt "$(cat <<'EOF'\n` +
      `  …prompt body…\n` +
      `  EOF\n` +
      `  )"\n\n` +
      `--- ADAPTATION PROMPT (start) ---\n` +
      `${prompt}\n` +
      `--- ADAPTATION PROMPT (end) ---\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate a bundled workflow inside the package. Workflows ship under
 * `<package-root>/.flowai-workflow/<name>/`; relative to this module
 * (`init/mod.ts`) that's `../.flowai-workflow/<name>/`. Using
 * `import.meta.url` keeps the lookup runtime-agnostic — works for local
 * `deno run`, JSR install, and `deno compile` binaries alike.
 */
function resolveWorkflowSource(workflow: string): URL {
  return new URL(`../.flowai-workflow/${workflow}/`, import.meta.url);
}

/**
 * Convert a `file://` URL to a plain path for `copyTemplate`. JSR-shipped
 * workflows are reachable via `file:` URLs once the package is on disk;
 * this helper narrows the URL→path conversion and throws for any other
 * scheme (a future remote-fetch path would need its own logic).
 */
function fromFileUrlCompat(url: URL): string {
  if (url.protocol !== "file:") {
    throw new Error(
      `Workflow source must be a file:// URL (got ${url.href}).`,
    );
  }
  return fromFileUrl(url);
}
