/**
 * @module
 * Agent log persistence: saves JSON output and JSONL session transcripts
 * to the run's logs directory after each node completes.
 * Entry point: {@link saveAgentLog}.
 */

import type { CliRunOutput, RuntimeId } from "./types.ts";

/** Default path where Claude Code stores project session transcripts. */
const DEFAULT_CLAUDE_PROJECTS_DIR = `${
  Deno.env.get("HOME") ?? "~"
}/.claude/projects`;

/**
 * Save agent log files after a successful node execution.
 *
 * Writes two files to `<runDir>/logs/`:
 * 1. `<nodeId>.json`  — full CliRunOutput JSON
 * 2. `<nodeId>.jsonl` — JSONL session transcript (if found)
 *
 * If the JSONL transcript cannot be located, a warning is logged
 * but the function does NOT throw.
 */
export async function saveAgentLog(
  runDir: string,
  nodeId: string,
  output: CliRunOutput,
  runtimeOrProjectsDir?: RuntimeId | string,
  claudeProjectsDir: string = DEFAULT_CLAUDE_PROJECTS_DIR,
): Promise<void> {
  let runtimeId: RuntimeId = output.runtime ?? "claude";
  let projectsDir = claudeProjectsDir;

  if (
    runtimeOrProjectsDir === "claude" ||
    runtimeOrProjectsDir === "opencode" ||
    runtimeOrProjectsDir === "cursor"
  ) {
    runtimeId = runtimeOrProjectsDir;
  } else if (typeof runtimeOrProjectsDir === "string") {
    projectsDir = runtimeOrProjectsDir;
  }

  const logsDir = `${runDir}/logs`;
  await Deno.mkdir(logsDir, { recursive: true });

  // 1. Write JSON log
  const jsonPath = `${logsDir}/${nodeId}.json`;
  await Deno.writeTextFile(
    jsonPath,
    JSON.stringify(output, null, 2) + "\n",
  );

  // 2. Find and copy JSONL transcript
  if (runtimeId !== "claude") {
    return;
  }

  const sessionId = output.session_id;
  if (!sessionId) return;

  const transcriptPath = await findTranscript(projectsDir, sessionId);
  if (transcriptPath) {
    const jsonlPath = `${logsDir}/${nodeId}.jsonl`;
    await Deno.copyFile(transcriptPath, jsonlPath);
  } else {
    console.warn(
      `[log] JSONL transcript not found for session ${sessionId} in ${projectsDir}`,
    );
  }
}

/**
 * Scan claudeProjectsDir for a .jsonl file whose name contains the sessionId.
 * Claude stores transcripts at ~/.claude/projects/<project-hash>/<session-id>.jsonl
 * (filename may contain the session_id as a substring).
 */
async function findTranscript(
  baseDir: string,
  sessionId: string,
): Promise<string | null> {
  try {
    for await (const entry of Deno.readDir(baseDir)) {
      if (!entry.isDirectory) {
        // Check files directly in baseDir
        if (entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
          return `${baseDir}/${entry.name}`;
        }
        continue;
      }
      // Scan subdirectory (project hash level)
      const subDir = `${baseDir}/${entry.name}`;
      try {
        for await (const file of Deno.readDir(subDir)) {
          if (
            file.isFile &&
            file.name.includes(sessionId) &&
            file.name.endsWith(".jsonl")
          ) {
            return `${subDir}/${file.name}`;
          }
        }
      } catch {
        // Subdirectory not readable — skip
      }
    }
  } catch {
    // Base directory doesn't exist — transcript not available
  }
  return null;
}
