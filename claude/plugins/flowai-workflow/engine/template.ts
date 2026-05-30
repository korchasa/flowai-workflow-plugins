/**
 * @module
 * Template interpolation engine: resolves `{{var}}` placeholders in prompt
 * and hook strings using the provided {@link TemplateContext}.
 * Supports dotted paths (input.*, args.*, env.*, loop.iteration),
 * direct keys (node_dir, run_dir, run_id), file inclusion via
 * `{{file("path")}}` / `{{flow_file("path")}}`, and shell substitution via
 * `{{bash("cmd")}}`.
 * Entry points: {@link interpolate}, {@link validateTemplateVars}.
 */

import type { TemplateContext } from "./types.ts";

/** File inclusion size threshold. Files larger than this emit a console warning. */
export const FILE_INCLUSION_SIZE_WARN_BYTES = 102400;

/**
 * Interpolates `{{var}}` placeholders in a template string using the provided context.
 *
 * Supported patterns:
 * - `{{node_dir}}`, `{{run_dir}}`, `{{run_id}}` — direct context fields
 * - `{{input.<node-id>}}` — predecessor node output directory
 * - `{{args.<key>}}` — CLI arguments
 * - `{{env.<key>}}` — environment variables
 * - `{{loop.iteration}}` — current loop iteration
 * - `{{file("path")}}` — inline file content (single-pass, no re-interpolation),
 *   path resolved against `workDir`
 * - `{{flow_file("path")}}` — same as `file()` but path resolved against the
 *   current workflow directory (`workDir/workflow_dir`)
 * - `{{bash("cmd")}}` — execute shell command via `bash -c`, substitute stdout
 *   (trailing newline trimmed). cwd = `workDir`. Non-zero exit throws with
 *   stderr in the message. Outer regex forbids `}` and newlines in the command.
 *
 * Unresolved placeholders throw an error (fail fast).
 *
 * @param workDir — base directory for resolving relative `{{file()}}` paths.
 *   Defaults to `Deno.cwd()`. When running in a worktree, pass the worktree path.
 *   `{{flow_file()}}` paths resolve against `workDir/ctx.workflow_dir`.
 */
export function interpolate(
  template: string,
  ctx: TemplateContext,
  workDir?: string,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
    const key = expr.trim();
    return resolve(key, ctx, workDir);
  });
}

function readIncludedFile(
  fnName: "file" | "flow_file",
  path: string,
  resolved: string,
): string {
  let content: string;
  try {
    content = Deno.readTextFileSync(resolved);
  } catch {
    throw new Error(`{{${fnName}("${path}")}} — file not found: ${resolved}`);
  }
  if (content.length > FILE_INCLUSION_SIZE_WARN_BYTES) {
    console.warn(
      `{{${fnName}("${path}")}}: large file included (${content.length} bytes, threshold ${FILE_INCLUSION_SIZE_WARN_BYTES}): ${resolved}`,
    );
  }
  return content;
}

function runBash(cmd: string, cwd: string): string {
  let result;
  try {
    result = new Deno.Command("bash", {
      args: ["-c", cmd],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
  } catch (err) {
    throw new Error(
      `{{bash("${cmd}")}} — failed to spawn: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `{{bash("${cmd}")}} — exit ${result.code}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  const stdout = new TextDecoder().decode(result.stdout);
  if (stdout.length > FILE_INCLUSION_SIZE_WARN_BYTES) {
    console.warn(
      `{{bash("${cmd}")}}: large output (${stdout.length} bytes, threshold ${FILE_INCLUSION_SIZE_WARN_BYTES})`,
    );
  }
  return stdout.replace(/\n$/, "");
}

function resolve(
  key: string,
  ctx: TemplateContext,
  workDir?: string,
): string {
  // Direct fields
  if (key === "node_dir") return ctx.node_dir;
  if (key === "run_dir") return ctx.run_dir;
  if (key === "run_id") return ctx.run_id;

  // file() function: {{file("path")}}
  const fileMatch = key.match(/^file\("(.+)"\)$/);
  if (fileMatch) {
    const path = fileMatch[1];
    const base = workDir ?? Deno.cwd();
    const resolved = path.startsWith("/") ? path : `${base}/${path}`;
    return readIncludedFile("file", path, resolved);
  }

  // flow_file() function: {{flow_file("path")}}
  // Resolves path relative to the current workflow directory
  // (workDir/ctx.workflow_dir). Absolute paths used as-is.
  const flowFileMatch = key.match(/^flow_file\("(.+)"\)$/);
  if (flowFileMatch) {
    const path = flowFileMatch[1];
    const base = workDir ?? Deno.cwd();
    const wfDir = ctx.workflow_dir ?? "";
    const resolved = path.startsWith("/")
      ? path
      : wfDir === ""
      ? `${base}/${path}`
      : `${base}/${wfDir}/${path}`;
    return readIncludedFile("flow_file", path, resolved);
  }

  // bash() function: {{bash("cmd")}}
  const bashMatch = key.match(/^bash\("(.+)"\)$/);
  if (bashMatch) {
    const cmd = bashMatch[1];
    const cwd = workDir ?? Deno.cwd();
    return runBash(cmd, cwd);
  }

  // Dotted paths
  const dotIdx = key.indexOf(".");
  if (dotIdx === -1) {
    throw new Error(`Unknown template variable: {{${key}}}`);
  }

  const prefix = key.substring(0, dotIdx);
  const suffix = key.substring(dotIdx + 1);

  if (!suffix) {
    throw new Error(`Empty key after prefix in template variable: {{${key}}}`);
  }

  switch (prefix) {
    case "input":
      if (!(suffix in ctx.input)) {
        throw new Error(
          `Unknown input node in template variable: {{${key}}}. Available: ${
            Object.keys(ctx.input).join(", ") || "(none)"
          }`,
        );
      }
      return ctx.input[suffix];

    case "args":
      if (!(suffix in ctx.args)) {
        throw new Error(
          `Unknown CLI argument in template variable: {{${key}}}. Available: ${
            Object.keys(ctx.args).join(", ") || "(none)"
          }`,
        );
      }
      return ctx.args[suffix];

    case "env":
      if (!(suffix in ctx.env)) {
        throw new Error(
          `Unknown env variable in template variable: {{${key}}}. Available: ${
            Object.keys(ctx.env).join(", ") || "(none)"
          }`,
        );
      }
      return ctx.env[suffix];

    case "loop":
      if (suffix !== "iteration") {
        throw new Error(
          `Unknown loop property in template variable: {{${key}}}. Only 'loop.iteration' is supported.`,
        );
      }
      if (!ctx.loop) {
        throw new Error(
          `Template variable {{loop.iteration}} used outside a loop context.`,
        );
      }
      return String(ctx.loop.iteration);

    default:
      throw new Error(`Unknown template variable prefix: {{${key}}}`);
  }
}

/**
 * Validate all `{{...}}` template variables in a string against known inputs.
 *
 * Pure function — no I/O. Returns an array of error descriptions; empty = valid.
 * Known prefixes: `input` (suffix must be in knownInputs), `env`, `args`,
 * `loop` (only `loop.iteration`). Known direct keys: `run_dir`, `run_id`,
 * `node_dir`. `file("...")` and `flow_file("...")` patterns are always accepted.
 */
export function validateTemplateVars(
  template: string,
  knownInputs: string[],
): string[] {
  const errors: string[] = [];

  for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
    const key = match[1].trim();

    // Direct fields
    if (key === "node_dir" || key === "run_dir" || key === "run_id") continue;

    // file() / flow_file() functions: {{file("path")}}, {{flow_file("path")}}
    if (/^file\(".*"\)$/.test(key)) continue;
    if (/^flow_file\(".*"\)$/.test(key)) continue;
    if (/^bash\(".*"\)$/.test(key)) continue;

    // Dotted paths
    const dotIdx = key.indexOf(".");
    if (dotIdx === -1) {
      errors.push(`Unknown template variable: {{${key}}}`);
      continue;
    }

    const prefix = key.substring(0, dotIdx);
    const suffix = key.substring(dotIdx + 1);

    if (!suffix) {
      errors.push(`Empty key after prefix in template variable: {{${key}}}`);
      continue;
    }

    switch (prefix) {
      case "input":
        if (!knownInputs.includes(suffix)) {
          errors.push(
            `Unknown input node in template variable: {{${key}}}. Available: ${
              knownInputs.join(", ") || "(none)"
            }`,
          );
        }
        break;

      case "args":
      case "env":
        // Any suffix is valid — resolved at runtime from CLI args / environment
        break;

      case "loop":
        if (suffix !== "iteration") {
          errors.push(
            `Unknown loop property in template variable: {{${key}}}. Only 'loop.iteration' is supported.`,
          );
        }
        break;

      default:
        errors.push(`Unknown template variable prefix: {{${key}}}`);
    }
  }

  return errors;
}
