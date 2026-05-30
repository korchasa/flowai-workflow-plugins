/**
 * @module
 * Worktree-isolation runtime guardrail (FR-E50).
 *
 * Pure detection logic for files modified by an agent in the **main repo
 * working tree** (outside its assigned worktree and outside the node's
 * `allowed_paths`). Symmetric to `scope-check.ts` (FR-E37), which guards the
 * inside-worktree side. Used by the engine's node dispatcher to detect leaks
 * after each agent run; if leaks are found, the engine rolls them back via
 * `git checkout` / `git clean` and fails the run.
 */

/**
 * Find paths newly modified outside the assigned `workDir` and outside
 * `allowedPaths` globs. Pure function — no I/O.
 *
 * Algorithm:
 * 1. Compute `newMods = after − before` (excludes pre-existing modifications).
 * 2. Filter out paths inside `workDir` (prefix `${workDir}/` — trailing-slash
 *    semantic to avoid sibling-directory false positives).
 * 3. Filter out paths matching any glob in `allowedPaths`.
 * 4. Remaining paths are leaks.
 *
 * Caller contract: skip invocation when `workDir === "."` (no worktree case),
 * since the workDir prefix filter degenerates to a no-op there. Behavior is
 * still deterministic if invoked — only the `allowedPaths` filter applies.
 *
 * @param before Snapshot of modified+untracked files before agent ran
 * @param after Snapshot of modified+untracked files after agent ran
 * @param workDir Repo-relative path of the assigned worktree (or `.`)
 * @param allowedPaths Glob patterns for outside-worktree paths the node may modify
 * @returns Leaked paths (may be empty)
 */
export function detectLeaks(
  before: Set<string>,
  after: Set<string>,
  workDir: string,
  allowedPaths: readonly string[],
): string[] {
  const workDirPrefix = `${workDir}/`;
  const leaks: string[] = [];
  for (const path of after) {
    if (before.has(path)) continue;
    if (path.startsWith(workDirPrefix)) continue;
    if (allowedPaths.some((pattern) => globMatch(pattern, path))) continue;
    leaks.push(path);
  }
  return leaks;
}

/**
 * Format a single-line leak report for the engine log.
 * Format: `"[guardrail] node=<id> leaked <N> file(s): <comma-list> (rolled back)"`.
 */
export function formatLeakMessage(
  nodeId: string,
  leaks: readonly string[],
): string {
  return `[guardrail] node=${nodeId} leaked ${leaks.length} file(s): ${
    leaks.join(", ")
  } (rolled back)`;
}

/**
 * Snapshot the set of modified+untracked paths in the **main repo working
 * tree** (NOT the worktree). Used to detect post-run leaks from agents that
 * wrote outside their assigned `workDir`.
 *
 * Runs `git -c status.showUntrackedFiles=normal status --porcelain
 * --untracked-files=normal` in `repoRoot`. The explicit `-c` override defends
 * against user/global git configs that suppress untracked-file reporting,
 * which would otherwise break leak detection for newly-created files.
 *
 * Fail-CLOSED: throws on git failure. Caller treats this as a node failure.
 */
export async function snapshotMainTree(
  repoRoot: string,
): Promise<Set<string>> {
  const cmd = new Deno.Command("git", {
    args: [
      "-c",
      "status.showUntrackedFiles=normal",
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(
      `[guardrail] git status failed (exit ${out.code}): ${stderr}`,
    );
  }
  const text = new TextDecoder().decode(out.stdout);
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    // Porcelain v1 format: "XY <path>" or "XY <orig> -> <newpath>".
    const rest = line.slice(3);
    const renameIdx = rest.indexOf(" -> ");
    paths.add(renameIdx >= 0 ? rest.slice(renameIdx + 4) : rest);
  }
  return paths;
}

/**
 * Restore the listed paths in `repoRoot` to their HEAD state. For paths that
 * exist in HEAD: `git checkout HEAD -- <path>`. For paths that don't (newly
 * created files): unlink directly. Errors per-file are swallowed so a single
 * problem path doesn't abort rollback for the rest.
 */
export async function rollbackLeaks(
  repoRoot: string,
  paths: readonly string[],
): Promise<void> {
  for (const p of paths) {
    const inHead = await new Deno.Command("git", {
      args: ["cat-file", "-e", `HEAD:${p}`],
      cwd: repoRoot,
      stdout: "null",
      stderr: "null",
    }).output();
    if (inHead.success) {
      await new Deno.Command("git", {
        args: ["checkout", "HEAD", "--", p],
        cwd: repoRoot,
        stdout: "null",
        stderr: "null",
      }).output();
    } else {
      try {
        await Deno.remove(`${repoRoot}/${p}`);
      } catch {
        // file gone or never created — nothing to roll back
      }
    }
  }
}

/** Result returned by {@linkcode runWithGuardrail} when a leak is detected. */
export interface GuardrailLeak {
  /** Repo-relative paths that leaked outside `workDir` and `allowedPaths`. */
  paths: string[];
  /** Pre-formatted single-line message for logs / failure reporting. */
  message: string;
}

/** Inputs to {@linkcode runWithGuardrail}. */
export interface GuardrailOptions {
  /** Absolute path to the main repo (where `git status` runs). */
  repoRoot: string;
  /** Repo-relative path to the assigned worktree, or `.` to disable. */
  workDir: string;
  /** Glob patterns for outside-worktree paths the node may modify. */
  allowedPaths: readonly string[];
  /** Node id for log-message attribution. */
  nodeId: string;
  /** Optional sink for the leak message (called only when a leak fires). */
  log?: (message: string) => void;
}

/** Outcome of {@linkcode runWithGuardrail}. */
export interface GuardrailOutcome<T> {
  /** Value returned by the wrapped `fn`. */
  result: T;
  /** Populated only if a leak was detected and rolled back. */
  leak: GuardrailLeak | undefined;
}

/**
 * Run `fn` with a worktree-isolation guardrail (FR-E50).
 *
 * Snapshots the main repo tree before/after `fn`, detects files that appeared
 * outside `workDir` and outside `allowedPaths`, rolls them back, and returns
 * the leak record. The wrapped `fn` is always awaited even when a leak is
 * detected — the leak post-processing runs after `fn` resolves.
 *
 * No-op fast path: when `workDir === "."` the guardrail is fully disabled
 * (no git invocation, no rollback, no log) — the no-worktree mode runs
 * directly in main and has no isolation contract to enforce.
 */
export async function runWithGuardrail<T>(
  opts: GuardrailOptions,
  fn: () => Promise<T>,
): Promise<GuardrailOutcome<T>> {
  if (opts.workDir === ".") {
    return { result: await fn(), leak: undefined };
  }
  const before = await snapshotMainTree(opts.repoRoot);
  const result = await fn();
  const after = await snapshotMainTree(opts.repoRoot);
  const leakedPaths = detectLeaks(
    before,
    after,
    opts.workDir,
    opts.allowedPaths,
  );
  if (leakedPaths.length === 0) {
    return { result, leak: undefined };
  }
  await rollbackLeaks(opts.repoRoot, leakedPaths);
  const message = formatLeakMessage(opts.nodeId, leakedPaths);
  opts.log?.(message);
  return { result, leak: { paths: leakedPaths, message } };
}

/**
 * Glob match supporting `**`, `*`, `?`. Mirrors `scope-check.ts::globMatch`.
 */
function globMatch(pattern: string, filePath: string): boolean {
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    if (
      pattern[i] === "*" && i + 1 < pattern.length &&
      pattern[i + 1] === "*"
    ) {
      regexStr += ".*";
      i += 2;
      if (i < pattern.length && pattern[i] === "/") i++;
    } else if (pattern[i] === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (pattern[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      regexStr += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`).test(filePath);
}
