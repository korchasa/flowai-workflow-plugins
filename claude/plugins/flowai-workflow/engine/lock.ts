/**
 * @module
 * Per-workflow run lock (FR-E54). Serializes concurrent runs against the
 * same workflow folder; distinct workflow folders run in parallel.
 * Lock file lives at `<workflowDir>/runs/.lock` and contains JSON with
 * PID, hostname, run_id, and timestamp.
 * Stale detection: always PID check. Hostname stored for diagnostics only.
 * Rationale: lock file lives on local FS, so if readable — PID is checkable.
 */

/** Lock file content structure. */
export interface LockInfo {
  pid: number;
  hostname: string;
  run_id: string;
  started_at: string;
}

/** Default lock file path for the given workflow folder (FR-E54).
 * `workflowDir` is the directory containing `workflow.yaml`
 * (typically `.flowai-workflow/<name>` under the multi-workflow layout, or
 * `.` for a bare top-level config). */
export function defaultLockPath(workflowDir: string): string {
  return `${workflowDir}/runs/.lock`;
}

/** Check if a process with given PID is alive on this host. */
function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/** Read lock info from lock file. Throws if file doesn't exist. */
export async function readLockInfo(lockPath: string): Promise<LockInfo> {
  const text = await Deno.readTextFile(lockPath);
  return JSON.parse(text) as LockInfo;
}

/** Check if an existing lock is still held by a live process.
 * Always checks PID directly — lock file on local FS guarantees
 * PID namespace is shared. Hostname stored for diagnostics only. */
function isLockAlive(existing: LockInfo): boolean {
  return isProcessAlive(existing.pid);
}

/** Acquire workflow lock. Throws if another live process holds it.
 * Reclaims stale locks (dead PID on same host) automatically. */
export async function acquireLock(
  lockPath: string,
  runId: string,
): Promise<void> {
  // Check existing lock
  try {
    const existing = await readLockInfo(lockPath);
    if (isLockAlive(existing)) {
      throw new Error(
        `Workflow is already running (run_id: ${existing.run_id}, pid: ${existing.pid}, host: ${existing.hostname}). ` +
          `Remove ${lockPath} manually if the process is stuck.`,
      );
    }
    // Stale lock — reclaim it
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // No lock file — proceed
    } else if (
      err instanceof Error && err.message.includes("already running")
    ) {
      throw err;
    } else if (err instanceof SyntaxError) {
      // Corrupted lock file — overwrite
    }
    // For NotFound and SyntaxError, fall through to create new lock
  }

  const info: LockInfo = {
    pid: Deno.pid,
    hostname: Deno.hostname(),
    run_id: runId,
    started_at: new Date().toISOString(),
  };

  // Ensure parent directory exists
  const dir = lockPath.substring(0, lockPath.lastIndexOf("/"));
  if (dir) {
    await Deno.mkdir(dir, { recursive: true });
  }

  await Deno.writeTextFile(lockPath, JSON.stringify(info, null, 2) + "\n");
}

/** Release workflow lock. No-op if lock file doesn't exist. */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await Deno.remove(lockPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
}
