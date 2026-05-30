/**
 * @module
 * Signal-handler wiring for the standalone engine binary. Delegates process
 * tracking and shutdown callback management to
 * `@korchasa/ai-ide-cli/process-registry`; owns only the OS-level
 * SIGINT/SIGTERM plumbing that translates signals into a graceful
 * `killAll()` + `Deno.exit(130|143)` sequence.
 *
 * **Library boundary (FR-E61).**
 * {@link installSignalHandlers} is intended exclusively for autonomous bin
 * entry points (`cli.ts`, `scripts/self-runner.ts`). The {@link Engine}
 * class itself MUST NOT call it — neither directly nor transitively — so a
 * library host that embeds `Engine.run()` in its own Deno process keeps full
 * control over signal routing, log handling, and shutdown sequencing.
 */

import {
  _getProcesses,
  _getShutdownCallbacks,
  _reset as _resetLib,
  killAll,
  onShutdown,
  ProcessRegistry,
  register,
  unregister,
} from "@korchasa/ai-ide-cli/process-registry";

// Re-export the pure library API so existing engine callers keep working
// through `engine/process-registry.ts`.
export {
  _getProcesses,
  _getShutdownCallbacks,
  killAll,
  onShutdown,
  ProcessRegistry,
  register,
  unregister,
};

// Signal-listener state is engine-local because installation/removal of
// OS signal listeners is a host-process concern the library doesn't own.
let sigintListener: (() => void) | null = null;
let sigtermListener: (() => void) | null = null;
let handlersInstalled = false;
let shuttingDown = false;

/**
 * Install SIGINT + SIGTERM handlers. Idempotent — only installs once.
 * On signal: calls {@link killAll}, then `Deno.exit(130 for SIGINT, 143 for SIGTERM)`.
 */
export function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const handler = (signal: Deno.Signal) => {
    if (shuttingDown) return; // Prevent re-entrant shutdown
    shuttingDown = true;
    const code = signal === "SIGINT" ? 130 : 143;
    killAll().finally(() => {
      Deno.exit(code);
    });
  };

  sigintListener = () => handler("SIGINT");
  sigtermListener = () => handler("SIGTERM");

  try {
    Deno.addSignalListener("SIGINT", sigintListener);
  } catch {
    // Signal may not be available (e.g. Windows)
  }
  try {
    Deno.addSignalListener("SIGTERM", sigtermListener);
  } catch {
    // Signal may not be available
  }
}

// --- Test helpers (prefixed with _ to indicate internal use) ---

/** Inspect whether OS signal handlers have been installed. For test
 * assertions only — used by FR-E61 to verify
 * `Engine.run()` does not transitively wire SIGINT/SIGTERM. */
export function _isHandlersInstalled(): boolean {
  return handlersInstalled;
}

/** Reset all state including signal listeners. For test isolation only. */
export function _reset(): void {
  _resetLib();
  if (sigintListener) {
    try {
      Deno.removeSignalListener("SIGINT", sigintListener);
    } catch { /* ignore */ }
    sigintListener = null;
  }
  if (sigtermListener) {
    try {
      Deno.removeSignalListener("SIGTERM", sigtermListener);
    } catch { /* ignore */ }
    sigtermListener = null;
  }
  handlersInstalled = false;
  shuttingDown = false;
}
