#!/usr/bin/env bash
# launch.sh — flowai-workflow plugin launcher (FR-E74).
#
# Bootstraps the engine binary into ${CLAUDE_PLUGIN_DATA} on first call;
# execs the cached binary thereafter. Subsequent calls skip Deno entirely.
#
# Invoked by .mcp.json as `bash $CLAUDE_PLUGIN_ROOT/bin/launch.sh mcp ...`
# and (optionally) by skill SKILL.md bodies for run/init/scaffold so they
# share the same lazy-compile cache.
set -euo pipefail

ENGINE_DIR="${CLAUDE_PLUGIN_ROOT}/engine"
PLUGIN_JSON="${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json"

# Version: read from plugin.json via python3 (universally available on
# macOS/Linux). Fail loud if missing — plugin install is broken.
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN_JSON")"

BIN_DIR="${CLAUDE_PLUGIN_DATA}/bin"
BIN="${BIN_DIR}/flowai-workflow-${VERSION}"

if [[ ! -x "$BIN" ]]; then
  if ! command -v deno >/dev/null 2>&1; then
    printf 'Error: Deno 2.x is required for the flowai-workflow plugin first-launch compile.\n' >&2
    printf 'Install: https://deno.com/\n' >&2
    exit 127
  fi
  mkdir -p "$BIN_DIR"
  # Enumerate bundled workflow files; bash arrays handle spaces cleanly.
  declare -a INCLUDE_ARGS=()
  if [[ -d "${CLAUDE_PLUGIN_ROOT}/.flowai-workflow" ]]; then
    while IFS= read -r -d '' f; do
      INCLUDE_ARGS+=(--include "$f")
    done < <(find "${CLAUDE_PLUGIN_ROOT}/.flowai-workflow" -type f -print0)
  fi
  TMP="${BIN}.tmp.$$"
  # Atomic compile: write to tmp, rename on success.
  # The `${INCLUDE_ARGS[@]+"${INCLUDE_ARGS[@]}"}` form expands to nothing
  # when the array is empty, which is required under `set -u`.
  deno compile --allow-all --no-check \
    ${INCLUDE_ARGS[@]+"${INCLUDE_ARGS[@]}"} \
    --output "$TMP" "${ENGINE_DIR}/cli.ts" >&2
  mv "$TMP" "$BIN"
fi

# Workflow resolution for `mcp` (no-op for other subcommands).
if [[ "${1:-}" == "mcp" ]]; then
  shift
  WF=""
  if [[ -n "${FLOWAI_WORKFLOW:-}" ]]; then
    WF="$FLOWAI_WORKFLOW"
  else
    ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
    if [[ -d "$ROOT/.flowai-workflow" ]]; then
      declare -a CANDIDATES=()
      for d in "$ROOT"/.flowai-workflow/*/; do
        [[ -f "$d/workflow.yaml" ]] && CANDIDATES+=("${d%/}")
      done
      if [[ ${#CANDIDATES[@]} -eq 1 ]]; then
        WF="${CANDIDATES[0]}"
      elif [[ -f "$ROOT/.flowai-workflow/github-inbox/workflow.yaml" ]]; then
        WF="$ROOT/.flowai-workflow/github-inbox"
      fi
    fi
  fi
  if [[ -n "$WF" ]]; then
    exec "$BIN" mcp "$WF" "$@"
  fi
  # No workflow: pass --no-workflow flag (typed contract). cli.ts mcp
  # recognises the flag and starts the server in no-workflow mode so
  # the MCP handshake still completes; tool calls then return a
  # structured "no flowai-workflow folder found" error.
  exec "$BIN" mcp --no-workflow "$@"
fi

exec "$BIN" "$@"
