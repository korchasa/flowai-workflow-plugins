/**
 * @module
 * Scope-based file modification detection for agent nodes (FR-E37).
 * Snapshots modified/untracked files via git before/after agent invocation,
 * then identifies violations against the node's allowed_paths glob patterns.
 */

/**
 * Snapshot the set of modified and untracked files using git.
 *
 * Runs `git diff --name-only HEAD` (modified tracked files) and
 * `git ls-files --others --exclude-standard` (untracked files).
 * Returns a combined Set of repo-relative paths.
 *
 * Why git-based: engine already depends on git; index-based diffing is
 * sub-second for ≤1000 files (AC #6) and correctly excludes staged-only
 * or committed changes.
 */
export async function snapshotModifiedFiles(
  cwd?: string,
): Promise<Set<string>> {
  const run = async (args: string[]): Promise<string> => {
    const cmd = new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "null",
      ...(cwd ? { cwd } : {}),
    });
    const out = await cmd.output();
    return new TextDecoder().decode(out.stdout);
  };

  const [diffOut, untrackedOut] = await Promise.all([
    run(["diff", "--name-only", "HEAD"]),
    run(["ls-files", "--others", "--exclude-standard"]),
  ]);

  const files = new Set<string>();
  for (const line of [...diffOut.split("\n"), ...untrackedOut.split("\n")]) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }
  return files;
}

/**
 * Find files newly modified (after − before) that do not match any allowed_paths glob.
 * Pure function — no I/O, fully unit-testable.
 *
 * Algorithm: compute `newMods = after − before` (set difference — pre-existing
 * modifications excluded per AC #5), then filter paths not matching any glob.
 *
 * @param before - Snapshot taken before agent invocation
 * @param after - Snapshot taken after agent invocation
 * @param allowedPaths - Glob patterns for permitted file modifications
 * @returns Paths in newMods that violate allowedPaths (empty array = no violations)
 */
export function findViolations(
  before: Set<string>,
  after: Set<string>,
  allowedPaths: string[],
): string[] {
  const violations: string[] = [];
  for (const path of after) {
    if (before.has(path)) continue; // pre-existing modification — excluded
    if (!allowedPaths.some((pattern) => globMatch(pattern, path))) {
      violations.push(path);
    }
  }
  return violations;
}

/**
 * Match a file path against a glob pattern.
 *
 * Supported syntax:
 * - `**` — matches any sequence of path segments (including none)
 * - `*` — matches any sequence of characters within a single path segment
 * - `?` — matches a single character (non-separator)
 * - All other characters match literally
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
