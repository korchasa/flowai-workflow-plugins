#!/usr/bin/env bash
set -euo pipefail

# hitl-check.sh — Poll Telegram for a reply to the HITL question.
# Called by engine via defaults.hitl.check_script.
# Args (engine contract):
#   --run-dir DIR --artifact-source PATH --run-id ID --node-id ID [--exclude-login LOGIN]
# Exit 0 + reply text on stdout = reply found.
# Exit 1 = no reply yet.
# Env (from <project>/.env):
#   FLOWAI_TELEGRAM_BOT_TOKEN, FLOWAI_TELEGRAM_CHAT_ID

RUN_DIR="" NODE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir)          RUN_DIR="$2"; shift 2 ;;
    --artifact-source)  shift 2 ;; # unused in Telegram transport
    --run-id)           shift 2 ;; # unused (baseline is per-node)
    --node-id)          NODE_ID="$2"; shift 2 ;;
    --exclude-login)    shift 2 ;; # unused in Telegram transport
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$RUN_DIR" || -z "$NODE_ID" ]]; then
  echo "ERROR: --run-dir and --node-id are required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

: "${FLOWAI_TELEGRAM_BOT_TOKEN:?FLOWAI_TELEGRAM_BOT_TOKEN not set (expected in $PROJECT_ROOT/.env)}"
: "${FLOWAI_TELEGRAM_CHAT_ID:?FLOWAI_TELEGRAM_CHAT_ID not set (expected in $PROJECT_ROOT/.env)}"

API="https://api.telegram.org/bot${FLOWAI_TELEGRAM_BOT_TOKEN}"

BASELINE_FILE="$RUN_DIR/$NODE_ID/.tg_baseline"
if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "ERROR: baseline file missing: $BASELINE_FILE (ask_script must run first)" >&2
  exit 1
fi
BASELINE=$(cat "$BASELINE_FILE")

# Fetch pending updates strictly after the baseline. timeout=0 — short poll.
UPDATES=$(curl -sS --fail-with-body \
  "${API}/getUpdates?offset=$((BASELINE + 1))&timeout=0")

OK=$(echo "$UPDATES" | jq -r '.ok // false')
if [[ "$OK" != "true" ]]; then
  echo "ERROR: getUpdates failed: $UPDATES" >&2
  exit 1
fi

REPLY=$(echo "$UPDATES" | jq -r \
  --argjson chat "$FLOWAI_TELEGRAM_CHAT_ID" \
  --argjson baseline "$BASELINE" \
  '[.result[]
    | select(.update_id > $baseline)
    | select(.message.chat.id == $chat)
    | select(.message.text)
    | .message.text] | first // empty')

if [[ -n "$REPLY" ]]; then
  echo "$REPLY"
  exit 0
fi
exit 1
