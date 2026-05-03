#!/usr/bin/env bash
# Trigger an AI Reframe job and poll until it completes.
# Usage: trigger-reframe.sh <fileId> <aspectRatio> [authToken]
#   aspectRatio: 9:16 | 1:1 | 4:5 | 16:9
#
# Defaults to http://localhost:3000 — override with API_URL env var.

set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
FILE_ID="${1:-}"
ASPECT="${2:-}"
TOKEN="${3:-${AUTH_TOKEN:-}}"

if [[ -z "$FILE_ID" || -z "$ASPECT" ]]; then
  echo "usage: $0 <fileId> <aspectRatio> [authToken]" >&2
  exit 1
fi

AUTH_HEADER=()
if [[ -n "$TOKEN" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer $TOKEN")
fi

ELEMENT_ID="cli-$(date +%s)"

echo "→ POST $API_URL/api/v1/reframe   fileId=$FILE_ID  ratio=$ASPECT"
START_RES=$(curl -sS -X POST "$API_URL/api/v1/reframe" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  -d "{\"fileId\":\"$FILE_ID\",\"aspectRatio\":\"$ASPECT\",\"elementId\":\"$ELEMENT_ID\"}")
echo "$START_RES" | sed 's/^/   /'

INITIAL_STATUS=$(echo "$START_RES" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))' 2>/dev/null || echo "")

if [[ "$INITIAL_STATUS" == "already_done" ]]; then
  echo "✅ already completed (cached)"
  exit 0
fi

if [[ "$INITIAL_STATUS" != "queued" && "$INITIAL_STATUS" != "processing" ]]; then
  echo "✗ unexpected start status: $INITIAL_STATUS"
  exit 1
fi

echo
echo "→ polling /api/v1/reframe/status/$FILE_ID/$ASPECT every 3s"
for _ in $(seq 1 200); do
  sleep 3
  RES=$(curl -sS "$API_URL/api/v1/reframe/status/$FILE_ID/$ASPECT" "${AUTH_HEADER[@]}")
  STATUS=$(echo "$RES" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))' 2>/dev/null || echo "")
  printf '   status=%s\n' "$STATUS"

  if [[ "$STATUS" == "completed" ]]; then
    echo
    echo "✅ completed. layout decision:"
    echo "$RES" | python3 -m json.tool
    exit 0
  fi

  if [[ "$STATUS" == "failed" ]]; then
    echo "✗ failed:"
    echo "$RES" | python3 -m json.tool
    exit 2
  fi
done

echo "✗ timed out after ~10 minutes"
exit 3
