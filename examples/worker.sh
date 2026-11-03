#!/bin/sh
# A short, synchronous worker. Longer jobs need heartbeats and cancellation, as worker/worker.ts implements.
set -eu
: "${AGENT_HUB_URL:?}" "${AGENT_HUB_KEY:?}"
claim=${AGENT_HUB_CLAIM:-curl-$$}
while :; do
  packet=$(curl -fsS --max-time 65 -H "Authorization: Bearer $AGENT_HUB_KEY" "$AGENT_HUB_URL/v1/work?claim=$claim&wait=50")
  job=$(printf '%s' "$packet" | jq -c '.job')
  if [ "$job" != null ]; then
    run=$(printf '%s' "$job" | jq -r '.run')
    token=$(printf '%s' "$job" | jq -r '.token')
    curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{}' "$AGENT_HUB_URL/v1/runs/$run/started" >/dev/null
    receipt=${AGENT_HUB_RECEIPT:-'{"outcome":"done","summary":"处理完成"}'}
    curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$receipt" "$AGENT_HUB_URL/v1/runs/$run/result"
    claim="curl-$$-$run"
  fi
  [ "${AGENT_HUB_ONCE:-0}" != 1 ] || break
done
