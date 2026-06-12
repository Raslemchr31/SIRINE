# agent-handler

The bot brain. Receives the Chatwoot AgentBot webhook, runs a Gemini function-calling loop
grounded in the catalog, and posts the Darija reply back to Chatwoot.

**No host port published.** Chatwoot reaches it over the shared `sirine_net` Docker network at
`http://agent-handler:8082/agentbot`. The Meta webhook relay (`/meta/webhook`) is reached the
same way (fronted by your domain / reverse proxy — see INSTALL.md).

## What happens on each customer message

1. **Loop prevention** — acts only on `message_created` + `incoming`; everything else → 200 no-op.
2. **Human lane** — conversations in `open`/`resolved` status are skipped (a human owns them);
   the bot answers only `pending` conversations.
3. **Media** — image attachments go to Gemini vision; voice notes go to Gemini audio. An image
   is cached briefly (Redis) and re-attached to the customer's follow-up text message, because
   Messenger sends image and caption as two separate webhooks.
4. **Memory** — prior text turns are replayed from Redis (`agent:hist:{conversation_id}`,
   trimmed to `AGENT_HISTORY_TURNS`).
5. **Grounding** — the model must call `get_product` (retrieval-api) before stating any catalog
   fact; product photos are fetched from Directus and uploaded to Chatwoot as real attachments
   when the model emits `[[IMG]]`.
6. **Orders** — when the customer confirms a purchase the model calls `capture_order`; the
   handler validates everything server-side (DZ phone, wilaya, re-verified price, computed
   shipping from `shipping.json`) and writes the order to Directus.
7. **Handoff** — `[[HANDOFF]]` posts a private note and flips the conversation to `open`
   (human queue). Errors and quota exhaustion degrade politely instead of going silent.

## Files

| File | Role |
|---|---|
| `server.mjs` | Everything (raw node:http, no framework) |
| `system-prompt.md` | SIRINE persona + grounding rules (volume-mounted — edit + restart, no rebuild) |
| `shipping.json` | Per-wilaya delivery rates (volume-mounted — single source for prompt + order totals) |

## Environment

See `.env.example` at the repo root — `GEMINI_API_KEY`, `GEMINI_MODEL`, `RETRIEVAL_API_KEY`,
`DIRECTUS_TOKEN`, `CHATWOOT_AGENT_BOT_TOKEN`, `REDIS_PASSWORD`, `FB_VERIFY_TOKEN`,
`FB_APP_SECRET`, and the `AGENT_*` tuning knobs.
