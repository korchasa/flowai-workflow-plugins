#!/usr/bin/env bash
# run-dashboard.sh — Wrapper for dashboard generation used as after-hook.
# Runs deno task dashboard; logs a warning on failure but always exits 0
# so the calling node remains "completed" (non-blocking per FR-S36).
#
# Usage: run-dashboard.sh <run-dir>

run_dir="$1"
deno task dashboard --run-dir "$run_dir"
code=$?
if [ "$code" -ne 0 ]; then
  echo "[WARN] dashboard generation failed (exit $code)" >&2
fi
exit 0
