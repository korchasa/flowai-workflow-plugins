/**
 * @module
 * Verbatim file-copy core. No placeholder substitution, no template
 * variables — files are streamed from the package's bundled
 * `.flowai-workflow/<workflow>/` into the target project's
 * `.flowai-workflow/<workflow>/`. Project-specific configuration (test
 * commands, branch names, repo conventions) is the agents' responsibility
 * at first run, not the scaffolder's.
 */

import { dirname, join, relative } from "@std/path";

/**
 * Recursively walk a directory tree and return relative file paths
 * (with forward slashes, regardless of platform). Hidden entries that
 * start with `.` are included — `.gitignore` inside the workflow tree
 * is a valid asset to copy.
 */
export async function listTemplateFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const full = join(current, entry.name);
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile) {
        result.push(relative(root, full));
      }
    }
  }
  await walk(root);
  return result;
}

/**
 * Copy a workflow directory verbatim into the target project. Walks the
 * source tree under `sourceDir`, mirrors it under `targetDir`.
 *
 * Invariants:
 * - Never overwrites existing files — throws if a target path already
 *   exists. Preflight is expected to have verified absence of the target,
 *   but we defend in depth here.
 * - Every written path is appended to `createdPaths` BEFORE the write
 *   completes, so unwind-on-error can delete exactly the files that were
 *   touched (see {@link unwindScaffold}).
 *
 * Returns the list of absolute paths written — used by the caller to
 * unwind on error.
 */
export async function copyTemplate(
  sourceDir: string,
  targetDir: string,
): Promise<string[]> {
  const createdPaths: string[] = [];

  let srcInfo: Deno.FileInfo;
  try {
    srcInfo = await Deno.stat(sourceDir);
  } catch (err) {
    throw new Error(
      `Workflow source missing: ${sourceDir}`,
      { cause: err },
    );
  }
  if (!srcInfo.isDirectory) {
    throw new Error(`Workflow source must be a directory: ${sourceDir}`);
  }

  const relFiles = await listTemplateFiles(sourceDir);
  for (const relFile of relFiles) {
    const srcFile = join(sourceDir, relFile);
    const dstFile = join(targetDir, relFile);

    try {
      await Deno.stat(dstFile);
      throw new Error(
        `Target file already exists: ${dstFile}. Remove it manually ` +
          `or delete the parent directory to re-init.`,
      );
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    const data = await Deno.readFile(srcFile);
    await Deno.mkdir(dirname(dstFile), { recursive: true });
    await Deno.writeFile(dstFile, data);
    createdPaths.push(dstFile);
  }

  return createdPaths;
}

/**
 * Best-effort removal of paths created by {@link copyTemplate}. Walks the
 * list in reverse order, silently ignoring `NotFound` errors (the path
 * may have been removed by the user between scaffold and unwind).
 *
 * Only file paths are removed — parent directories that become empty are
 * left on disk so we never accidentally delete a user directory we didn't
 * create.
 */
export async function unwindScaffold(createdPaths: string[]): Promise<void> {
  for (const path of [...createdPaths].reverse()) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      console.error(
        `unwind: failed to remove ${path}: ${(err as Error).message}`,
      );
    }
  }
}
