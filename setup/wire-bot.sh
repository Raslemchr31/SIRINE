#!/usr/bin/env bash
# Attach the SIRINE AgentBot to every Chatwoot inbox (idempotent). Run after
# connecting the Facebook page in the Chatwoot UI: `make wire-bot`.
set -euo pipefail
cd "$(dirname "$0")/.."
envget() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true; }

docker run --rm --network leadbot_default -v "$PWD":/work -w /work \
  -e CHATWOOT_URL=http://chatwoot-rails:3000 \
  -e CHATWOOT_ACCOUNT_ID="$(envget CHATWOOT_ACCOUNT_ID)" \
  -e CHATWOOT_API_ACCESS_TOKEN="$(envget CHATWOOT_API_ACCESS_TOKEN)" \
  -e AGENT_WEBHOOK_URL=http://agent-handler:8082/agentbot \
  node:22 node chatwoot/setup.mjs
