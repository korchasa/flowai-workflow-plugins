/**
 * @module
 * Human node execution: prompt the operator for input via terminal,
 * save the response as an artifact, and check abort conditions.
 * Entry point: {@link runHuman}.
 */

import type { NodeConfig, TemplateContext } from "./types.ts";
import { interpolate } from "./template.ts";
import { workPath } from "./state.ts";

/** Result of a human node interaction. */
export interface HumanResult {
  /** Whether the interaction completed without triggering an abort condition. */
  success: boolean;
  /** The user's text response (or resolved option label). */
  response: string;
  /** True if the response matched one of the node's abort_on values. */
  aborted: boolean;
}

/** Interface for user input (injectable for testing). */
export interface UserInput {
  /** Display a message and return the user's text response. */
  prompt(message: string): Promise<string>;
}

/** Default terminal-based user input. */
export const terminalInput: UserInput = {
  async prompt(message: string): Promise<string> {
    const buf = new Uint8Array(1024);
    await Deno.stdout.write(new TextEncoder().encode(message));
    const n = await Deno.stdin.read(buf);
    if (n === null) return "";
    return new TextDecoder().decode(buf.subarray(0, n)).trim();
  },
};

/**
 * Execute a human node: display question, collect input, check abort conditions.
 *
 * - Displays the question (with template variables resolved)
 * - Shows numbered options if configured
 * - Waits for user input
 * - Saves response to node_dir/response.txt
 * - Returns abort=true if response matches abort_on values
 */
export async function runHuman(
  node: NodeConfig,
  ctx: TemplateContext,
  input: UserInput = terminalInput,
): Promise<HumanResult> {
  if (node.type !== "human") {
    throw new Error(`Node is not a human node (type: ${node.type})`);
  }

  const question = interpolate(node.question!, ctx);

  // Build the prompt message
  let message = `\n${"=".repeat(60)}\n`;
  message += `HUMAN INPUT REQUIRED\n`;
  message += `${"=".repeat(60)}\n\n`;
  message += `${question}\n\n`;

  if (node.options && node.options.length > 0) {
    message += `Options:\n`;
    for (let i = 0; i < node.options.length; i++) {
      message += `  ${i + 1}. ${node.options[i]}\n`;
    }
    message += `\nEnter option number or type your response: `;
  } else {
    message += `Enter your response: `;
  }

  const rawResponse = await input.prompt(message);

  // Resolve option number to option text
  let response = rawResponse;
  if (node.options && node.options.length > 0) {
    const optIdx = parseInt(rawResponse, 10);
    if (!isNaN(optIdx) && optIdx >= 1 && optIdx <= node.options.length) {
      response = node.options[optIdx - 1];
    }
  }

  // Save response to artifact file. ctx.node_dir is workDir-relative
  // (see TemplateContext) — reconstruct cwd-correct path for FS access.
  const nodeDir = workPath(ctx.workDir, ctx.node_dir);
  try {
    await Deno.mkdir(nodeDir, { recursive: true });
    await Deno.writeTextFile(`${nodeDir}/response.txt`, response + "\n");
  } catch {
    // Best effort — directory might not be writable in tests
  }

  // Check abort conditions
  const aborted = (node.abort_on ?? []).includes(response);

  return {
    success: !aborted,
    response,
    aborted,
  };
}
