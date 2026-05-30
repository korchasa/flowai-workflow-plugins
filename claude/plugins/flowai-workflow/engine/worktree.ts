/**
 * @module
 * Git worktree lifecycle management for per-run isolation.
 * Each workflow run executes in its own worktree, eliminating destructive
 * `git reset --hard` and enabling future parallel runs.
 *
 * FR-E57 layout: a run's worktree lives at
 * `<workflowDir>/runs/<run-id>/worktree/`, sibling to its `state.json` and
 * per-node artifact directories under the same `runs/<run-id>/` parent.
 */

import { dirname, join, resolve, SEPARATOR } from "@std/path";
import type { OutputManager } from "./output.ts";

/**
 * Get the worktree path for a given run ID under `workflowDir`.
 *
 * Returns `<workflowDir>/runs/<runId>/worktree`. The `workflowDir` parameter
 * mirrors the same value threaded into `getRunDir`/`getNodeDir`/
 * `defaultLockPath` (FR-E54), so all per-run filesystem state lives under
 * one `<workflowDir>/runs/<runId>/` umbrella.
 */
export function getWorktreePath(runId: string, workflowDir: string): string {
  return `${workflowDir}/runs/${runId}/worktree`;
}

/**
 * Create a git worktree for a workflow run.
 * 1. Fetches latest from origin (fail fast on network error).
 * 2. Ensures `<workflowDir>/runs/<runId>/` parent exists (`git worktree add`
 *    only mkdirs the leaf and fails if intermediate directories are
 *    absent).
 * 3. Creates worktree at `getWorktreePath(runId, workflowDir)` from `ref`,
 *    detached.
 * Returns the relative worktree path.
 */
export async function createWorktree(
  runId: string,
  workflowDir: string,
  ref = "origin/main",
): Promise<string> {
  // Fetch latest
  await runGit(["fetch", "origin", "main"], "git fetch origin main failed");

  const worktreePath = getWorktreePath(runId, workflowDir);

  // Ensure parent runs/<runId>/ dir exists; git worktree add creates only
  // the leaf and fails when an intermediate dir is missing.
  await Deno.mkdir(`${workflowDir}/runs/${runId}`, { recursive: true });

  // Create worktree (detached HEAD from ref)
  await runGit(
    ["worktree", "add", "--detach", worktreePath, ref],
    `git worktree add failed for ${worktreePath}`,
  );

  return worktreePath;
}

/**
 * Remove a git worktree. Swallows NotFound errors (idempotent).
 * Uses --force to handle dirty worktrees (artifacts may have been written).
 *
 * After the primary remove, runs `git worktree prune` (idempotent,
 * fail-silent) to clean up stale gitlinks under `.git/worktrees/<runId>/`.
 * Without prune, a worktree directory removed out-of-band (manual rm,
 * crashed cleanup) leaves behind a gitlink that blocks any future
 * `git worktree add` at the same path.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  try {
    await runGit(
      ["worktree", "remove", "--force", worktreePath],
      `git worktree remove failed for ${worktreePath}`,
    );
  } catch (err) {
    // Swallow only the "worktree already gone" case. Anything else (e.g.,
    // a dirty refusal we should never see because of --force) re-throws.
    if (
      !(err instanceof Error &&
        (err.message.includes("is not a working tree") ||
          err.message.includes("No such file or directory")))
    ) {
      throw err;
    }
  }

  // Tail prune. Idempotent; errors swallowed because git binary missing or
  // a transient corruption shouldn't block teardown of the run state.
  try {
    await runGit(["worktree", "prune"], "git worktree prune failed");
  } catch {
    // intentional swallow
  }
}

/**
 * Resolve an existing worktree for a (runId, workflowDir) pair.
 * Returns `{ path }` when the FR-E57 worktree directory exists, otherwise
 * `undefined`.
 */
export function resolveExistingWorktreePath(
  runId: string,
  workflowDir: string,
): { path: string } | undefined {
  const path = getWorktreePath(runId, workflowDir);
  try {
    if (Deno.statSync(path).isDirectory) return { path };
  } catch {
    // not found
  }
  return undefined;
}

/** Check whether a worktree directory exists for the given run ID under
 * `workflowDir`. */
export function worktreeExists(runId: string, workflowDir: string): boolean {
  return resolveExistingWorktreePath(runId, workflowDir) !== undefined;
}

/**
 * Copy a file from workDir to the original repo (relative paths).
 * Used to persist state.json to original repo before worktree removal.
 */
export async function copyToOriginalRepo(
  workDir: string,
  relativePath: string,
): Promise<void> {
  const src = `${workDir}/${relativePath}`;
  // Ensure destination directory exists
  const destDir = relativePath.substring(0, relativePath.lastIndexOf("/"));
  if (destDir) {
    await Deno.mkdir(destDir, { recursive: true });
  }
  await Deno.copyFile(src, relativePath);
}

/**
 * Pin a detached HEAD in `workDir` to a fresh rescue branch (FR-E51).
 *
 * Worktrees are created with `--detach` (FR-E24), so commits made during a
 * run are reachable only via the worktree's HEAD. After `removeWorktree`
 * those commits become unreachable and eligible for git gc. This function
 * snapshots HEAD into a named branch BEFORE removal so the work survives.
 *
 * Returns the rescue branch name, or `undefined` when HEAD is already on a
 * named branch (no rescue needed). Branch name is
 * `flowai/run-<runId>-orphan-rescue`; if that name already exists (resume
 * of the same run-id, repeat invocation), a counter suffix `-2`, `-3`, …
 * is appended until a free name is found.
 *
 * Non-destructive: uses `git branch <name> HEAD` (cannot overwrite an
 * existing branch) — failure to find a free name within 1000 attempts
 * surfaces as an error to the caller.
 */
export async function pinDetachedHead(
  workDir: string,
  runId: string,
): Promise<string | undefined> {
  const symRef = await new Deno.Command("git", {
    args: ["-C", workDir, "symbolic-ref", "-q", "HEAD"],
    stdout: "null",
    stderr: "null",
  }).output();
  if (symRef.success) return undefined;

  const baseName = `flowai/run-${runId}-orphan-rescue`;
  let name = baseName;
  for (let counter = 2; await branchExists(workDir, name); counter++) {
    if (counter > 1000) {
      throw new Error(
        `Could not find free rescue branch name after 1000 attempts (base: ${baseName})`,
      );
    }
    name = `${baseName}-${counter}`;
  }

  const create = await new Deno.Command("git", {
    args: ["-C", workDir, "branch", name, "HEAD"],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!create.success) {
    const stderr = new TextDecoder().decode(create.stderr).trim();
    throw new Error(`git branch ${name} failed: ${stderr}`);
  }
  return name;
}

/** Check whether a local branch ref exists in `workDir`. */
async function branchExists(workDir: string, name: string): Promise<boolean> {
  const out = await new Deno.Command("git", {
    args: [
      "-C",
      workDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  return out.success;
}

/**
 * Copy gitignored files from `origRepo` into a freshly-created `workDir`
 * (FR-E58). Enumerates paths via
 * `git ls-files --others --ignored --exclude-standard --directory -z` and
 * mirrors each entry preserving the relative layout, file mode (where the
 * platform supports it), and symlinks (as symlinks, not their targets).
 *
 * - Untracked-but-not-ignored files are NOT copied — committing/stashing
 *   them is the operator's responsibility (FR-E50 safety check).
 * - Tracked files are NOT copied — they already exist in the worktree
 *   from the underlying ref checkout.
 * - Special files (sockets, FIFOs, devices) are skipped with a warning.
 * - Cross-platform: only Deno FS APIs, no shell `cp`. No filesystem-level
 *   cloning (reflink/clonefile) — every byte is physically duplicated.
 *
 * Progress is logged via `output.status("engine", …)` per top-level entry
 * plus a leading "Copying ignored files..." line and a trailing summary.
 *
 * @param workDir       Destination worktree directory.
 * @param output        OutputManager for status/warn lines.
 * @param origRepo      Source repo root. Defaults to `.` (engine CWD).
 * @param workflowDir   Engine's workflow directory. When supplied, the entire
 *                      `<workflowDir>/runs/` subtree is excluded from
 *                      mirroring — it is the engine's own runtime state
 *                      (worktrees of other live runs, their `state.json`,
 *                      per-node artefacts), not project data the new run
 *                      should see. Without this skip, sibling worktrees
 *                      registered for the same repo would be copied into
 *                      the new worktree (carrying their own mirrored
 *                      `runs/` snapshots), producing exponentially-nested
 *                      `runs/<id>/worktree/.flowai-workflow/<wf>/runs/<id>/
 *                      worktree/...` trees that quickly hit ENAMETOOLONG.
 *                      When omitted, only the destination `workDir` itself
 *                      is guarded against self-copy (legacy behavior used
 *                      by isolated unit tests that don't model the engine
 *                      runs/ layout).
 * @returns             Aggregate counters: total files copied, total bytes.
 */
export async function copyIgnoredIntoWorktree(
  workDir: string,
  output: OutputManager,
  origRepo: string = ".",
  workflowDir?: string,
): Promise<{ files: number; bytes: number }> {
  output.status("engine", "Copying ignored files...");

  const absWorkDir = resolve(workDir);
  const skipPrefixes: string[] = [absWorkDir];
  if (workflowDir !== undefined) {
    skipPrefixes.push(resolve(workflowDir, "runs"));
  }
  const paths = await listIgnoredPaths(origRepo);
  let totalFiles = 0;
  let totalBytes = 0;

  for (const rawPath of paths) {
    const relPath = rawPath.replace(/\/+$/, "");
    if (relPath === "") continue;
    const src = join(origRepo, relPath);
    const dst = join(workDir, relPath);
    const result = await classifyAndCopy(src, dst, output, skipPrefixes);
    totalFiles += result.files;
    totalBytes += result.bytes;
    output.status(
      "engine",
      `Copied ${relPath}: ${result.files} files, ${formatSize(result.bytes)}`,
    );
  }

  output.status(
    "engine",
    `Ignored files copied: ${totalFiles} files, ${formatSize(totalBytes)}`,
  );

  return { files: totalFiles, bytes: totalBytes };
}

/**
 * Enumerate gitignored entries in `origRepo`. Uses `-z` so paths with
 * embedded newlines or quotes survive intact. Trailing `/` on entries
 * indicates a wholly-ignored directory (`--directory` collapse).
 */
async function listIgnoredPaths(origRepo: string): Promise<string[]> {
  const result = await new Deno.Command("git", {
    args: [
      "-C",
      origRepo,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `git ls-files (ignored) failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
  const out = new TextDecoder().decode(result.stdout);
  return out.split("\0").filter((s) => s !== "");
}

/**
 * Classify `src` via `lstat` and copy it to `dst`, recursing into
 * directories. Returns counters for the entry (and its descendants).
 *
 * `skipPrefixes` lists absolute paths that must NOT be entered or copied:
 * the destination worktree itself (always present, prevents self-copy when
 * `workDir` lives under an ignored ancestor in `origRepo`) and, when
 * provided, the engine's `<workflowDir>/runs/` root (excludes sibling
 * worktrees of other live runs and their per-run state — see
 * `copyIgnoredIntoWorktree` for the multi-worktree exponential-nesting
 * trigger this guards against).
 */
async function classifyAndCopy(
  src: string,
  dst: string,
  output: OutputManager,
  skipPrefixes: string[],
): Promise<{ files: number; bytes: number }> {
  const srcAbs = resolve(src);
  for (const prefix of skipPrefixes) {
    if (srcAbs === prefix || srcAbs.startsWith(prefix + SEPARATOR)) {
      return { files: 0, bytes: 0 };
    }
  }

  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(src);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      output.warn(`Ignored path missing on disk, skipping: ${src}`);
      return { files: 0, bytes: 0 };
    }
    throw err;
  }

  if (stat.isSymlink) {
    const target = await Deno.readLink(src);
    await Deno.mkdir(dirname(dst), { recursive: true });
    await Deno.symlink(target, dst);
    return { files: 1, bytes: 0 };
  }

  if (stat.isFile) {
    await Deno.mkdir(dirname(dst), { recursive: true });
    await Deno.copyFile(src, dst);
    return { files: 1, bytes: stat.size };
  }

  if (stat.isDirectory) {
    await Deno.mkdir(dst, { recursive: true });
    let files = 0;
    let bytes = 0;
    for await (const entry of Deno.readDir(src)) {
      const r = await classifyAndCopy(
        join(src, entry.name),
        join(dst, entry.name),
        output,
        skipPrefixes,
      );
      files += r.files;
      bytes += r.bytes;
    }
    return { files, bytes };
  }

  output.warn(`Skipping special file (not regular/dir/symlink): ${src}`);
  return { files: 0, bytes: 0 };
}

/** Human-readable size formatter for progress messages (B/KB/MB/GB). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Run a git command, throw with context on failure. */
async function runGit(args: string[], errorContext: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${errorContext}${stderr ? `: ${stderr}` : ""}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}
