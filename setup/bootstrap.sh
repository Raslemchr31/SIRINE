#!/usr/bin/env bash
# =============================================================================
# SIRINE bot — one-command, idempotent bring-up. Run via `make setup` (or directly).
# Safe to re-run at any time: every step checks before it acts.
#
# What it does, in order:
#   1.  sanity checks (docker, compose, .env)
#   2.  generates any missing secret in .env
#   3.  creates the external docker network
#   4.  builds + starts the stack (adds the TLS edge proxy when FRONTEND_URL is a real domain)
#   5.  prepares the Chatwoot DB on first boot (rails db:chatwoot_prepare)
#   6.  sets ENABLE_MESSENGER_CHANNEL_HUMAN_AGENT=true (without it, every outbound
#       Messenger send fails — Facebook removed the ACCOUNT_UPDATE message tag)
#   7.  creates the Chatwoot admin + API token (first run only)
#   8.  seeds the Directus catalog (idempotent) + sets the Directus static token
#   9.  creates the AgentBot and wires it to every inbox
#   10. prints the Meta webhook URL + the exact next steps
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m   ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m   ! %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m   ✗ %s\033[0m\n' "$*"; exit 1; }

# --- 1. sanity ---------------------------------------------------------------
say "Checking prerequisites"
command -v docker >/dev/null || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
ok "docker + compose found"

if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env did not exist — created it from .env.example."
  warn "Open .env, fill the CLIENT section (GEMINI_API_KEY, FB_APP_ID, FB_APP_SECRET, FRONTEND_URL),"
  die  "then run 'make setup' again."
fi

# --- helpers to read/patch .env ----------------------------------------------
envget() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true; }
envset() { # envset KEY VALUE — replace the line in place (key must exist in .env)
  local k="$1" v="$2"
  if grep -qE "^$k=" .env; then
    sed -i.bak "s|^$k=.*|$k=$v|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
gen() { openssl rand -hex "$1"; }

# --- 2. secrets --------------------------------------------------------------
say "Generating missing secrets in .env"
for kv in POSTGRES_PASSWORD:24 REDIS_PASSWORD:24 CATALOG_RO_PASSWORD:24 \
          DIRECTUS_KEY:16 DIRECTUS_SECRET:32 DIRECTUS_TOKEN:24 \
          CHATWOOT_SECRET_KEY_BASE:64 RETRIEVAL_API_KEY:24 FB_VERIFY_TOKEN:16; do
  k="${kv%%:*}"; n="${kv##*:}"
  if [ -z "$(envget "$k")" ]; then envset "$k" "$(gen "$n")"; ok "$k generated"; else ok "$k already set"; fi
done
# Chatwoot password policy needs upper+lower+digit+special; Directus just needs strong.
if [ -z "$(envget DIRECTUS_ADMIN_PASSWORD)" ]; then envset DIRECTUS_ADMIN_PASSWORD "Dz$(gen 12)!"; ok "DIRECTUS_ADMIN_PASSWORD generated"; fi
if [ -z "$(envget CHATWOOT_ADMIN_PASSWORD)" ]; then envset CHATWOOT_ADMIN_PASSWORD "Dz$(gen 12)!"; ok "CHATWOOT_ADMIN_PASSWORD generated"; fi

for k in GEMINI_API_KEY FB_APP_ID FB_APP_SECRET; do
  [ -z "$(envget "$k")" ] && warn "$k is EMPTY — the bot/Messenger channel won't work until you fill it and re-run 'make setup'."
done

# --- 3. network + 4. stack ----------------------------------------------------
say "Docker network + stack"
docker network inspect sirine_net >/dev/null 2>&1 || { docker network create sirine_net >/dev/null; ok "created sirine_net"; }

FRONTEND_URL="$(envget FRONTEND_URL)"
DOMAIN="$(printf '%s' "$FRONTEND_URL" | sed -E 's|^https?://||; s|[:/].*$||')"
PROFILES=""
case "$FRONTEND_URL" in
  https://*)
    case "$DOMAIN" in
      localhost|127.0.0.1|*ngrok*|*trycloudflare*) ;;          # tunnels bring their own TLS
      *) envset DOMAIN "$DOMAIN"; PROFILES="--profile edge"; ok "edge proxy enabled for $DOMAIN (auto-TLS)";;
    esac;;
esac

docker compose $PROFILES up -d --build
ok "stack started"

say "Waiting for postgres / directus / chatwoot"
for i in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U "$(envget POSTGRES_USER)" >/dev/null 2>&1 && break; sleep 2
done
ok "postgres ready"
for i in $(seq 1 60); do
  curl -fsS http://localhost:8055/server/health >/dev/null 2>&1 && break; sleep 3
done
ok "directus ready"

# --- 5. chatwoot first boot ----------------------------------------------------
say "Chatwoot database"
HAS_SCHEMA="$(docker compose exec -T postgres psql -U "$(envget POSTGRES_USER)" -d chatwoot -tAc "SELECT to_regclass('public.installation_configs')" 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$HAS_SCHEMA" != "installation_configs" ]; then
  warn "first boot — running rails db:chatwoot_prepare (takes 1-2 min)"
  docker compose run --rm chatwoot-rails bundle exec rails db:chatwoot_prepare
  ok "chatwoot DB prepared"
else
  ok "chatwoot DB already prepared"
fi
# Puma needs to be up for the rails runner + API steps below.
for i in $(seq 1 90); do
  curl -fsS -o /dev/null http://localhost:3037/ 2>/dev/null && break; sleep 3
done
ok "chatwoot web responding"

# --- 6. HUMAN_AGENT flag (landmine: outbound Messenger fails without it) -------
say "Messenger HUMAN_AGENT flag"
docker compose exec -T chatwoot-rails bundle exec rails runner "
  c = InstallationConfig.find_or_initialize_by(name: 'ENABLE_MESSENGER_CHANNEL_HUMAN_AGENT')
  c.value = true; c.save!
  GlobalConfig.clear_cache rescue nil
  puts 'HUMAN_AGENT flag: set'
"
ok "ENABLE_MESSENGER_CHANNEL_HUMAN_AGENT=true"

# --- 7. chatwoot admin + API token ---------------------------------------------
say "Chatwoot admin"
if [ -z "$(envget CHATWOOT_API_ACCESS_TOKEN)" ]; then
  TOKEN_OUT="$(docker compose exec -T \
      -e ADMIN_EMAIL="$(envget CHATWOOT_ADMIN_EMAIL)" \
      -e ADMIN_PASS="$(envget CHATWOOT_ADMIN_PASSWORD)" \
      chatwoot-rails bundle exec rails runner "
    email = ENV['ADMIN_EMAIL']; pass = ENV['ADMIN_PASS']
    user = User.find_by(email: email)
    if user.nil?
      account = Account.first || Account.create!(name: 'SIRINE')
      user = User.new(name: 'Admin', email: email, password: pass, password_confirmation: pass)
      user.skip_confirmation! if user.respond_to?(:skip_confirmation!)
      user.save!
      AccountUser.create!(account_id: account.id, user_id: user.id, role: :administrator)
    end
    puts \"TOKEN=#{user.access_token.token}\"
  ")"
  TOKEN="$(printf '%s' "$TOKEN_OUT" | grep -oE 'TOKEN=.*' | cut -d= -f2 | tr -d '[:space:]')"
  [ -n "$TOKEN" ] || die "could not create/read the Chatwoot admin token"
  envset CHATWOOT_API_ACCESS_TOKEN "$TOKEN"
  ok "admin created ($(envget CHATWOOT_ADMIN_EMAIL)) + API token stored"
else
  ok "admin token already in .env"
fi

# --- 8. catalog seed + directus static token ------------------------------------
say "Catalog seed (idempotent)"
docker compose run --rm seed
ok "catalog seeded"

docker compose exec -T postgres psql -U "$(envget POSTGRES_USER)" -d directus -tAc \
  "UPDATE directus_users SET token='$(envget DIRECTUS_TOKEN)' WHERE email='$(envget DIRECTUS_ADMIN_EMAIL)';" >/dev/null
ok "directus static token assigned to admin"

# --- 9. AgentBot + inbox wiring ---------------------------------------------------
say "AgentBot wiring"
WIRE_OUT="$(docker run --rm --network leadbot_default -v "$PWD":/work -w /work \
  -e CHATWOOT_URL=http://chatwoot-rails:3000 \
  -e CHATWOOT_ACCOUNT_ID="$(envget CHATWOOT_ACCOUNT_ID)" \
  -e CHATWOOT_API_ACCESS_TOKEN="$(envget CHATWOOT_API_ACCESS_TOKEN)" \
  -e AGENT_WEBHOOK_URL=http://agent-handler:8082/agentbot \
  node:22 node chatwoot/setup.mjs)"
printf '%s\n' "$WIRE_OUT" | sed 's/^/   /'
for k in CHATWOOT_INBOX_ID CHATWOOT_INBOX_IDENTIFIER CHATWOOT_AGENT_BOT_ID; do
  v="$(printf '%s\n' "$WIRE_OUT" | grep -oE "^$k=.*" | cut -d= -f2 | tr -d '[:space:]' || true)"
  [ -n "$v" ] && envset "$k" "$v"
done
BOT_TOKEN="$(printf '%s\n' "$WIRE_OUT" | grep -oE '^CHATWOOT_AGENT_BOT_TOKEN=.*' | cut -d= -f2 | tr -d '[:space:]' || true)"
if [ -n "$BOT_TOKEN" ] && [ "${BOT_TOKEN#(}" = "$BOT_TOKEN" ]; then  # skip the "(existing bot…)" placeholder
  envset CHATWOOT_AGENT_BOT_TOKEN "$BOT_TOKEN"
fi
[ -n "$(envget CHATWOOT_AGENT_BOT_TOKEN)" ] || warn "CHATWOOT_AGENT_BOT_TOKEN still empty — get it from Chatwoot UI (Settings → Agent Bots) and put it in .env, then re-run."

# Restart agent-handler so it picks up freshly written tokens.
docker compose up -d agent-handler >/dev/null 2>&1
ok "agent-handler restarted with current .env"

# --- 10. next steps ------------------------------------------------------------
say "DONE — what's left (one-time, in the browser)"
cat <<EOF

   Chatwoot   : ${FRONTEND_URL:-http://localhost:3037}   (login: $(envget CHATWOOT_ADMIN_EMAIL))
   Catalog UI : http://localhost:8055                    (login: $(envget DIRECTUS_ADMIN_EMAIL))

   1. Meta app webhook (developers.facebook.com → your app → Messenger → Webhooks):
        Callback URL : ${FRONTEND_URL:-https://YOUR-DOMAIN}/meta/webhook
        Verify token : $(envget FB_VERIFY_TOKEN)
        Subscribe to : messages, messaging_postbacks, messaging_referrals
   2. Connect your Facebook page: Chatwoot → Inboxes → New Inbox → Messenger.
   3. Wire the bot to the new Messenger inbox:  make wire-bot
   4. Send "salam" to your page — the bot answers in Darija.

   Re-running 'make setup' is always safe.
EOF
