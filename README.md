# SIRINE Messenger Bot

AI sales assistant for **SIRINE** (women's footwear, bags & accessories — Tlemcen, Algeria).
Answers customers on Facebook Messenger in Algerian Darija, grounds every product fact in the
real catalog (never invents a price, size, color or stock), sends product photos, understands
voice notes and photos, quotes per-wilaya delivery rates, **captures complete orders**, and hands
off to a human whenever it can't help.

## How it works

```
Facebook page ──► Meta webhook ──► agent-handler /meta/webhook (ad attribution)
                                        │ forwards untouched
                                        ▼
                                  Chatwoot (inbox, Messenger channel)
                                        │ AgentBot webhook
                                        ▼
                                  agent-handler (Gemini function-calling loop)
                                        │ get_product / capture_order
                                        ▼
                    retrieval-api ──► Postgres catalog (read-only)
                    Directus  ◄────── orders written here (team UI :8055)
```

| Service | Role | Port |
|---|---|---|
| **chatwoot** (rails + sidekiq) | Inbox, Messenger channel, human handoff | 3037 |
| **agent-handler** | The bot brain: Gemini loop, memory, vision/voice, orders | internal |
| **retrieval-api** | Read-only catalog lookups (`get_product`) | 8137 |
| **directus** | Catalog + orders admin UI for the team | 8055 |
| **postgres / redis** | Data + conversation memory | internal |

## Install

See **[INSTALL.md](./INSTALL.md)** — short version:

```bash
git clone <this repo> && cd SIRINE
cp .env.example .env        # fill GEMINI_API_KEY, FB_APP_ID, FB_APP_SECRET, FRONTEND_URL
make setup                  # brings up everything, seeds the catalog, wires the bot
```

## Day-to-day operation

See **[RUNBOOK.md](./RUNBOOK.md)** — adding products, viewing orders, why a conversation
went quiet, editing the bot's persona or delivery rates, logs, backups.

## Key behaviors (don't be surprised)

- The bot only answers conversations in **pending** status. As soon as a human replies or
  assigns the conversation (status **open**), the bot goes silent — that conversation is yours.
- Every product fact comes from the catalog via `get_product`. Empty catalog = the bot hands off.
- Delivery rates come from `agent-handler/shipping.json` (58 wilayas, home + stop-desk).
- Orders land in Directus → **Orders** collection, with the source Facebook ad when the
  customer came from a Click-to-Messenger ad.
