#!/usr/bin/env bash
set -euo pipefail

# hitl-ask.sh — Render HITL question JSON → text, send via Telegram Bot API.
# Called by engine via defaults.hitl.ask_script.
# Args (engine contract):
#   --run-dir DIR --artifact-source PATH --run-id ID --node-id ID --question-json JSON
# Env (from <project>/.env):
#   FLOWAI_TELEGRAM_BOT_TOKEN — bot token from @BotFather
#   FLOWAI_TELEGRAM_CHAT_ID   — target chat id (personal DM with the bot)

RUN_DIR="" RUN_ID="" NODE_ID="" QUESTION_JSON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir)          RUN_DIR="$2"; shift 2 ;;
    --artifact-source)  shift 2 ;; # unused in Telegram transport
    --run-id)           RUN_ID="$2"; shift 2 ;;
    --node-id)          NODE_ID="$2"; shift 2 ;;
    --question-json)    QUESTION_JSON="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$RUN_DIR" || -z "$RUN_ID" || -z "$NODE_ID" || -z "$QUESTION_JSON" ]]; then
  echo "ERROR: --run-dir, --run-id, --node-id, --question-json are required" >&2
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

QUESTION=$(echo "$QUESTION_JSON" | jq -r '.question // "No question provided"')
HEADER=$(echo "$QUESTION_JSON" | jq -r '.header // empty')

TEXT="Agent \`${NODE_ID}\` is waiting for your input"
if [[ -n "$HEADER" ]]; then
  TEXT="${TEXT} — ${HEADER}"
fi
TEXT="${TEXT}

${QUESTION}"

OPTIONS_COUNT=$(echo "$QUESTION_JSON" | jq -r '.options | length // 0')
if [[ "$OPTIONS_COUNT" -gt 0 ]]; then
  TEXT="${TEXT}
"
  for i in $(seq 0 $((OPTIONS_COUNT - 1))); do
    LABEL=$(echo "$QUESTION_JSON" | jq -r ".options[$i].label")
    DESC=$(echo "$QUESTION_JSON" | jq -r ".options[$i].description // empty")
    if [[ -n "$DESC" ]]; then
      TEXT="${TEXT}
$((i + 1)). ${LABEL} — ${DESC}"
    else
      TEXT="${TEXT}
$((i + 1)). ${LABEL}"
    fi
  done
fi

TEXT="${TEXT}

Reply in this chat. [run=${RUN_ID} node=${NODE_ID}]"

# Capture current latest update_id as baseline so check.sh ignores prior messages.
BASELINE=$(curl -sS --fail-with-body "${API}/getUpdates?offset=-1&limit=1" \
  | jq -r '.result[0].update_id // 0')

mkdir -p "$RUN_DIR/$NODE_ID"
echo "$BASELINE" > "$RUN_DIR/$NODE_ID/.tg_baseline"

BODY=$(jq -n \
  --arg chat "$FLOWAI_TELEGRAM_CHAT_ID" \
  --arg text "$TEXT" \
  '{chat_id: ($chat | tonumber), text: $text, disable_web_page_preview: true}')

RESP=$(curl -sS --fail-with-body -X POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${API}/sendMessage")

OK=$(echo "$RESP" | jq -r '.ok // false')
if [[ "$OK" != "true" ]]; then
  echo "ERROR: sendMessage failed: $RESP" >&2
  exit 1
fi
