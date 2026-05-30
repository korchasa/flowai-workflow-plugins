/**
 * @module
 * Self-update check against JSR meta.json.
 *
 * Queries https://jsr.io/@korchasa/flowai-workflow/meta.json for the latest
 * published version and compares it to the currently running binary version.
 * Designed to be fail-open: any network, parse, or version-format error
 * returns `null` so the caller never blocks on the check.
 */

import { greaterThan, parse } from "@std/semver";
import { VERSION } from "./cli.ts";

export { VERSION };

/** JSR registry meta endpoint for this package. */
const JSR_META_URL = "https://jsr.io/@korchasa/flowai-workflow/meta.json";
/** Default abort timeout for the meta.json request (ms). */
const DEFAULT_TIMEOUT_MS = 5000;
/** Fully-qualified JSR package identifier used in the install command. */
const JSR_PACKAGE = "jsr:@korchasa/flowai-workflow";

/** Result of a successful update check. */
export interface VersionCheckResult {
  /** Version running right now. */
  currentVersion: string;
  /** Latest version published to JSR. */
  latestVersion: string;
  /** True when `latestVersion > currentVersion` by semver. */
  updateAvailable: boolean;
  /** Shell command the user should run to upgrade. */
  updateCommand: string;
}

/** Injectable dependencies for {@link checkForUpdate}. */
export interface CheckForUpdateOptions {
  /** Override fetch implementation (for tests). */
  fetch?: typeof globalThis.fetch;
  /** Abort timeout in milliseconds (default 5000). */
  timeoutMs?: number;
}

/**
 * Build the `deno install` command for a specific published version.
 * Embeds the explicit version so a stale deno.lock cannot pin an older
 * release during reinstall.
 */
export function buildUpdateCommand(version: string): string {
  return `deno install -g -A -f ${JSR_PACKAGE}@${version}`;
}

/**
 * Check JSR for a newer published version of flowai-workflow.
 *
 * Fail-open contract: returns `null` on any of — network error, timeout,
 * non-200 response, unparseable JSON, missing `latest` field, or an
 * unparseable current version (e.g. the literal `"dev"`). Callers should
 * treat `null` as "no update info available" and continue normally.
 */
export async function checkForUpdate(
  currentVersion: string,
  options?: CheckForUpdateOptions,
): Promise<VersionCheckResult | null> {
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchFn(JSR_META_URL, { signal: controller.signal });
      if (!resp.ok) return null;

      let data: unknown;
      try {
        data = await resp.json();
      } catch {
        return null;
      }

      const latestVersion = (data as { latest?: unknown })?.latest;
      if (typeof latestVersion !== "string") return null;

      const current = parse(currentVersion);
      const latest = parse(latestVersion);

      return {
        currentVersion,
        latestVersion,
        updateAvailable: greaterThan(latest, current),
        updateCommand: buildUpdateCommand(latestVersion),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
