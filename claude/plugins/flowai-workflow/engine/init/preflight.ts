/**
 * @module
 * Environment precondition checks for `flowai-workflow init`. All checks
 * are collected up-front, so one run surfaces every misconfig instead of
 * failing one at a time.
 *
 * Checks performed:
 * - Current working directory is inside a git worktree.
 * - The target `.flowai-workflow/<workflow>/` directory does not already
 *   exist.
 * - (Unless `allowDirty: true`) the git worktree has no uncommitted
 *   changes.
 *
 * Workflow-specific dependencies (GitHub remote, `gh` CLI, branch
 * conventions, lint/test commands) are NOT checked here — workflows are
 * self-describing, and any missing dep surfaces at first run.
 */

/** Single preflight check outcome. */
export interface PreflightResult {
  /** Human-readable failure messages. Empty on success. */
  failures: string[];
}

/** Options passed to {@link runPreflight}. */
export interface PreflightOptions {
  /** Project root directory (usually `Deno.cwd()`). */
  cwd: string;
  /** Path that MUST NOT exist (the workflow target dir). */
  targetDir: string;
  /** When true, skip the clean-git-tree check. */
  allowDirty: boolean;
}

/**
 * Render a list of preflight failures as a multi-line human-readable
 * error for stderr. The first line is a summary header; each failure is
 * a bullet.
 */
export function summarizeFailures(failures: string[]): string {
  if (failures.length === 0) return "";
  const header = failures.length === 1
    ? "Preflight check failed:"
    : `${failures.length} preflight checks failed:`;
  return [header, ...failures.map((f) => `  - ${f}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers — small subprocess wrappers.
// ---------------------------------------------------------------------------

async function gitOutput(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = new Deno.Command("git", {
      cwd,
      args,
      stdout: "piped",
      stderr: "null",
    });
    const { success, stdout } = await proc.output();
    return { ok: success, stdout: new TextDecoder().decode(stdout).trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { ok, stdout } = await gitOutput(cwd, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  return ok && stdout === "true";
}

async function isGitTreeClean(cwd: string): Promise<boolean> {
  const { ok, stdout } = await gitOutput(cwd, ["status", "--porcelain"]);
  return ok && stdout.length === 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public entry point — runs all checks, collects failures, returns
// structured result. Caller decides whether to exit/print.
// ---------------------------------------------------------------------------

/**
 * Run every preflight check against the options. Returns a result with a
 * (possibly empty) list of failure messages; the caller decides whether
 * to exit.
 */
export async function runPreflight(
  opts: PreflightOptions,
): Promise<PreflightResult> {
  const failures: string[] = [];

  if (!await isGitRepo(opts.cwd)) {
    failures.push(
      `${opts.cwd} is not a git repo — run \`git init\` first`,
    );
  } else if (!opts.allowDirty && !await isGitTreeClean(opts.cwd)) {
    failures.push(
      "git working tree has uncommitted changes — commit, stash, or " +
        "pass --allow-dirty",
    );
  }

  if (await pathExists(opts.targetDir)) {
    failures.push(
      `${opts.targetDir} already exists — remove it manually to re-init`,
    );
  }

  return { failures };
}
