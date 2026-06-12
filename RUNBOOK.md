# RUNBOOK — operating the SIRINE bot (for the team)

Two places matter day-to-day:

| URL | What it is | Login |
|---|---|---|
| `https://chat.yourdomain.com` | **Chatwoot** — all customer conversations | `CHATWOOT_ADMIN_EMAIL` in `.env` |
| `http://<server>:8055` | **Directus** — catalog + orders | `DIRECTUS_ADMIN_EMAIL` in `.env` |

## Start / stop / status / logs

```bash
make up        # start everything
make down      # stop (data is kept)
make ps        # status of each service
make logs      # follow all logs
docker compose logs -f agent-handler   # just the bot brain (most useful)
```

## Why did the bot stop answering a conversation?

**This is by design.** The bot only answers conversations in **pending** status:

- Customer writes → conversation is **pending** → bot answers.
- A human replies or assigns it → status becomes **open** → **bot goes silent**. It's yours now.
- The bot hits something it can't handle → it posts a wait message, a private note with the
  reason, and flips the conversation to **open** for you.
- Mark the conversation **resolved** when finished. If the customer writes again it
  re-opens as pending and the bot resumes.

So: to **take over** a conversation, just reply in it. To **give it back** to the bot,
mark it resolved.

## Orders

Captured orders appear in **Directus → Orders** with everything: customer, validated phone,
wilaya, product/variant, quantity, delivery type, the exact price + shipping + total at order
time, address, the conversation id, and **which Facebook ad** brought the customer (when they
came from an ad).

- Work the `status` field: `new → confirmed → shipped → delivered` (or `cancelled`).
- Export: open the Orders collection → select rows (or none for all) → **Export** → CSV.
- The bot never invents prices: the total was computed from the catalog + `shipping.json`
  at the moment the customer confirmed.

## Adding / editing products

In **Directus → Products**:

1. **Create the product**: name, category, description, `base_price` (whole DZD, no decimals),
   status `active`. Leave `search_text` alone (it maintains itself).
2. **Add variants** (Variants collection or from the product page): color, size, `stock`,
   optional per-variant `price` (empty = uses the product's base price), unique `sku`.
3. **Add images**: upload the file in Directus (Files), then create an Images row pointing
   to the product with `angle = front` (the bot only sends *front* photos).
4. Test: message the page "3andkom <product name>?" — the bot should find it immediately
   (the search index updates automatically on every save, including variant edits).

**Hide a product**: set its status to `hidden` *and/or* set variant stock to 0.
**Price change**: edit `base_price` (or the variant price) — effective on the next customer
message; no restart needed.

## Facebook ads (Click-to-Messenger)

If you run ads that open Messenger, the bot can greet the customer already knowing which
product the ad was about, and the order row records the ad:

- In **Directus → Ads**: create a row with the Meta `ad_id`, channel `messenger`, and link
  it to the product (`linked_product_id`).
- That's it — the webhook relay reads the ad id from Meta's referral automatically.

## Editing the bot itself

| What | Where | Apply with |
|---|---|---|
| Delivery rates (per wilaya) | `agent-handler/shipping.json` | `docker compose restart agent-handler` |
| Persona / rules / tone | `agent-handler/system-prompt.md` | `docker compose restart agent-handler` |
| Gemini model | `GEMINI_MODEL` in `.env` | `docker compose up -d agent-handler` |

No rebuild is ever needed for these — they are mounted into the container.

## When the Gemini quota runs out

On the free tier (~20 requests/day) the bot pauses politely: each customer gets one
"the team will reply soon" message, conversations stay pending, and a private note marks
the reason. Fix permanently by using a billed Gemini key in `.env` → `GEMINI_API_KEY`,
then `docker compose up -d agent-handler`.

## Backups

All data lives in Docker volumes (`pg_data`, `directus_uploads`, `chatwoot_storage`).
Minimal backup (run from the repo directory):

```bash
docker compose exec -T postgres pg_dumpall -U app | gzip > backup-$(date +%F).sql.gz
```

Keep a copy of `.env` somewhere safe — it holds all your secrets.

## Rotating secrets

Re-generating a secret = edit/clear it in `.env`, then `make setup` (regenerates blanks)
and `docker compose up -d` (applies). Note: changing `POSTGRES_PASSWORD` after install also
requires changing it inside Postgres (`ALTER USER app PASSWORD '...'`) — do this with a
technical person.
