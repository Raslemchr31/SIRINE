#!/usr/bin/env bash
# Live synthetic test of the bot brain. Run AFTER `make setup`, with the stack up and a
# working GEMINI_API_KEY. It POSTs crafted AgentBot webhooks straight to agent-handler
# (bypassing Chatwoot/Facebook) using throwaway conversation ids, then shows the reply the
# bot stored in Redis (agent:hist:<id>) so you can eyeball the Darija answers and the order rows.
#
#   bash setup/smoke-agent.sh
#
# It does NOT post to real customers. Conversations are fake ids in the 990000+ range.
set -uo pipefail
cd "$(dirname "$0")/.."
envget() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true; }

NET=leadbot_default
RPASS="$(envget REDIS_PASSWORD)"
redis() { docker compose exec -T redis redis-cli -a "$RPASS" "$@" 2>/dev/null; }

# Fire one webhook at agent-handler from inside the network, wait, print the stored history.
fire() { # fire <convId> <json-body> <label>
  local id="$1" body="$2" label="$3"
  echo; echo "── $label  (conv $id) ──"
  docker run --rm --network "$NET" curlimages/curl:8.10.1 -s -o /dev/null -w "  http %{http_code}\n" \
    -X POST http://agent-handler:8082/agentbot -H 'Content-Type: application/json' -d "$body"
  sleep 7  # let the async Gemini round-trip + Chatwoot post finish
  echo "  bot reply (last stored turn):"
  redis GET "agent:hist:$id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const last=[...a].reverse().find(c=>c.role==="model");console.log("   "+(last?last.parts.map(p=>p.text).join(" "):"(no model turn stored)"));}catch{console.log("   (no history yet)")}})'
}

base() { # base convId status text  -> JSON webhook body
  printf '{"event":"message_created","message_type":"incoming","content":%s,"conversation":{"id":%s,"status":"%s","inbox_id":1,"contact_inbox":{"source_id":"PSID-%s"}},"contact":{"id":%s}}' \
    "$3" "$1" "$2" "$1" "$1"
}

echo "SIRINE bot — live smoke test"
echo "Gemini key set: $([ -n "$(envget GEMINI_API_KEY)" ] && echo yes || echo 'NO — bot will escalate every turn')"

fire 990001 "$(base 990001 pending '"salam"')" "greeting (no get_product, warm welcome)"
fire 990002 "$(base 990002 pending '"3andkom basket signature? bch7al?"')" "product grounding (price from catalog)"
fire 990003 "$(base 990003 pending '"werini tswira ta3 basket signature"')" "image request ([[IMG]] → photo)"
fire 990004 "$(base 990004 pending '"9adach toswil l Oran?"')" "shipping per-wilaya (home + desk)"
fire 990005 "$(base 990005 pending '"9adach toswil l wilaya 50?"')" "no-rate wilaya → handoff"
fire 990006 "$(base 990006 pending '"3andkom iphone 15?"')" "out-of-catalog → clarify/handoff"
fire 990007 "$(base 990007 pending '"bghit nahder m3a wahed insan"')" "human request → handoff"

echo; echo "── ORDER CAPTURE — happy path (multi-turn, same conv) ──"
fire 990010 "$(base 990010 pending '"nheb nechri basket signature, pointure 39, noir"')" "order: start"
fire 990010 "$(base 990010 pending '"smiti Amel Bouzid, tel 0551234567, wilaya Oran, livraison a domicile, l3onwane Cité 100 logements bloc B"')" "order: give all details"
fire 990010 "$(base 990010 pending '"ايه نأكد"')" "order: confirm → capture_order"

echo; echo "── ORDER CAPTURE — missing field (bot must ask, NOT save) ──"
fire 990011 "$(base 990011 pending '"nheb nechri sac signature, confirmi"')" "order: confirm with nothing collected"

echo; echo "────────────────────────────────────────"
echo "Saved orders in Directus (expect at least the happy-path row, NOT the missing-field one):"
docker compose exec -T postgres psql -U "$(envget POSTGRES_USER)" -d directus -c \
  "SELECT customer_name, phone_e164, wilaya, product_name, qty, delivery_type, total_dzd, status FROM orders ORDER BY created_at DESC LIMIT 5;" 2>/dev/null \
  || echo "  (could not read orders table)"

echo; echo "Cleanup test conversations from Redis:"
for id in 990001 990002 990003 990004 990005 990006 990007 990010 990011; do redis DEL "agent:hist:$id" >/dev/null; done
echo "  done. (Delete the test order rows in Directus → Orders if you want a clean slate.)"
