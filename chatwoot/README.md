# Chatwoot setup (Phase 2)

Chatwoot v4.13.0 runs as two services in the stack: `chatwoot-rails` (web, :3000) + `chatwoot-sidekiq`
(background jobs — required for webhooks/replies). It uses the `chatwoot` Postgres DB (created in M0)
and the shared Redis.

## One-time bring-up (run these in order, PowerShell)

`CHATWOOT_SECRET_KEY_BASE` is already set in `.env` — no secret to generate.

```powershell
# 1. Prepare the Chatwoot DB (create + migrate + seed). One-off, ~1-2 min.
docker compose run --rm chatwoot-rails bundle exec rails db:chatwoot_prepare

# 2. Start Chatwoot (web + worker)
docker compose up -d chatwoot-rails chatwoot-sidekiq

# 3. Watch it boot (first boot is slow ~60-90s; wait for "Listening on http://0.0.0.0:3000")
docker compose logs -f chatwoot-rails
```

## Create the admin (UI)

1. Open <http://localhost:3037> → **Create new account** (signup is enabled).
2. Fill name / email / password, company name **SIRINE**. This first user becomes the **administrator**
   of account `1`.
3. Profile (bottom-left avatar) → **Profile Settings** → scroll to **Access Token** → copy it.
4. Paste it into `.env`:
   ```
   CHATWOOT_API_ACCESS_TOKEN=<paste>
   ```

## Provision the inbox + bot (scripted — zero deps)

```powershell
node --env-file=.env chatwoot/setup.mjs
```

This creates (idempotently): an **API-channel inbox** (`SIRINE Bot Inbox`) and an **AgentBot**
(`SIRINE Brain`), attaches the bot to the inbox, and prints:

```
CHATWOOT_INBOX_ID=...
CHATWOOT_INBOX_IDENTIFIER=...
CHATWOOT_AGENT_BOT_ID=...
CHATWOOT_AGENT_BOT_TOKEN=...
```

Paste those four lines into `.env` (Phase 4 — the agent handler — needs them).

> The inbox `webhook_url` / bot `outgoing_url` are placeholders (`:8082/agentbot`) until the Phase 4
> agent handler exists. Re-run `setup.mjs` after Phase 4 to point them at the real handler.

## Verify (Phase 2 done when)

- <http://localhost:3037> loads and you can log in as the admin.
- `SIRINE Bot Inbox` appears under Inboxes; `SIRINE Brain` under Settings → Agent Bots.
- A test message posted via the API lands in a conversation:
  ```powershell
  # (after setup.mjs; uses values it printed)
  # create a contact+conversation+message via the Application API — see docs/research/chatwoot.md §1
  ```

## Notes / gotchas
- **Sidekiq must run** or webhooks/replies silently don't fire — if something "doesn't happen", check
  `docker compose logs chatwoot-sidekiq` first.
- `ENABLE_ACCOUNT_SIGNUP` is `true` for first-admin signup; lock it to `false` at hardening (Phase 8).
- `FRONTEND_URL` must match the origin you load (`http://localhost:3037`) or webhook/asset links break.
- Full API surface (inbox/contact/conversation/message/agentbot/webhook/signature) is documented in
  `docs/research/chatwoot.md`.
