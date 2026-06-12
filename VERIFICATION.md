# VERIFICATION — SIRINE bot packaging

Two layers: **(A) automated checks run during this work** (green, reproducible on any machine
with Node, no Docker) and **(B) a live end-to-end checklist** to run once on the VPS after
`make setup` (needs the stack up + a Gemini key). The client runs Docker/build steps manually.

---

## A. Automated — verified now ✅

### A1. Unit tests — the order/shipping/ad logic (`make test`)
`node --test` in `agent-handler/` against `lib.mjs` (the same functions `server.mjs` imports —
no duplication, so these tests guard the real code path).

```
# tests 12   # pass 12   # fail 0
```

| Test | What it proves |
|---|---|
| `toE164DZ` valid / invalid | DZ mobile → E.164 (`0551234567`→`+213551234567`, `+213…`, `213…`, spaces); rejects `04…`, short, empty |
| `findWilaya` code/FR/AR/fuzzy | matches by number, French name, Arabic name (تلمسان), diacritic-insensitive (bejaia), space variants (M sila) |
| `findWilaya` no-match | `timbuktu`/`99`/`""` → null |
| `renderShippingTable` | 57 priced rows (wilaya 50 has no rate → excluded), Tlemcen row correct |
| `extractReferrals` | pulls ad_id from `messaging_referrals` + `postback.referral`; ignores plain messages |
| `validateOrderArgs` happy | resolves Oran→650 home / Alger→450 desk, returns clean fields |
| `validateOrderArgs` missing | collects every missing/invalid field at once (the bot then asks) |
| `validateOrderArgs` bad phone | `0451234567` flagged as `phone` |
| `validateOrderArgs` no-rate wilaya | hands off instead of saving |
| `mergeTurnEntries` burst | 3 rapid messages → one merged turn (texts joined, attachments concatenated) |
| `mergeTurnEntries` single / empty | 1 message unchanged; empty/malformed input safe |

16 tests total, all green.

### A2. Static validation — every changed file parses
- `node --check` on `server.mjs`, `lib.mjs`, `lib.test.mjs`, `retrieval-api/server.mjs`,
  `schema.mjs`, `data.mjs`, `bootstrap.mjs`, `chatwoot/setup.mjs` → all OK.
- `shipping.json` parses → **58 wilayas** present.
- `bash -n` on `bootstrap.sh`, `wire-bot.sh`, `smoke-agent.sh`, `verify.sh`, `run.sh` → all OK.
- `docker compose --profile edge config` → valid (7 base services + caddy).

### A3. Repo hygiene — verified
- Secret scan over tree **and full git history**: no real credential ever committed (only Dify's
  public upstream placeholder, now removed). `.env` never tracked. See `.planning/packaging/AUDIT.md`.
- `git grep` for `dify|skillence|n8n` over the shipped tree → no functional references remain
  (only the `whatsapp|messenger|instagram` ad-channel enum, which is legitimate).
- Tracked file count: 36 (was 97) — Dify, Skillence, n8n, planning docs all gone.

---

## B. Live end-to-end — run once on the VPS after `make setup`

Prereqs: `make setup` completed, all services healthy (`make health`), real `GEMINI_API_KEY` in `.env`.
One command runs the whole suite:

```bash
make smoke      # = bash setup/smoke-agent.sh
```

It POSTs crafted AgentBot webhooks straight to `agent-handler` (throwaway conv ids 99000x),
prints each stored Darija reply, then dumps the `orders` table. Expected outcomes:

| # | Scenario | Pass criteria |
|---|---|---|
| 1 | "salam" | warm Darija welcome, asks what they want, **no** get_product call, no handoff |
| 2 | "3andkom basket signature? bch7al?" | price quoted **from the catalog** with DZD, no invented number |
| 3 | "werini tswira…" | reply + a real product photo delivered (Chatwoot attachment), no URL in text |
| 4 | "9adach toswil l Oran?" | gives **both** home (650 DA) and desk (450 DA) — exact table values |
| 5 | "…toswil l wilaya 50?" | hands off (no rate for Bordj Badji Mokhtar) — never invents a price |
| 6 | "3andkom iphone 15?" | clarifies / hands off — refuses to answer out-of-catalog |
| 7 | "bghit nahder m3a insan" | wait message + handoff (conversation flips to open) |
| 8 | order happy path (3 turns) | bot collects fields, reads back total (price×qty + shipping), saves on "نأكد" |
| 9 | order missing-field | bot **asks** for the missing details, **no** row saved |
| 10 | debounce burst (3 rapid messages) | **one** merged reply addressing all three; `bot=1` turn in history, not 3 |

Then verify in the browser:
- **Directus → Orders**: the happy-path row exists with `phone_e164=+213551234567`,
  `wilaya=Oran`, computed `total_dzd`, `status=new`. The missing-field attempt did **not** create a row.
- **Add-a-product test**: create a product + variant + front image in Directus, then send its
  name to the page — the bot finds it (DB trigger keeps `search_text` fresh; confirms UI inserts
  aren't bypassed).

### B2. Ad attribution (optional, needs a real Click-to-Messenger ad)
Map the ad in **Directus → Ads** (`ad_id`, channel `messenger`, `linked_product_id`). Click the
ad → message the page. Expected: the bot opens already aware of the product, and a resulting
order row carries `source_ad_id`. (The relay + attribution logic is unit-covered in A1; this
confirms the live Meta payload shape.)

---

## Known caveats (documented, not blockers)
- **Wilaya 50** (Bordj Badji Mokhtar) has no delivery rate in `shipping.json` → the bot hands
  off for it by design. Add a rate to `shipping.json` if the courier covers it.
- **Live B-suite needs a billed Gemini key.** On the free tier (~20/day) the bot degrades
  politely (one wait message/conversation) instead of answering — that path is in the code
  (`quota_daily`) but not exercised by `make smoke`.
- `make smoke` reflects the bot brain only (it bypasses Chatwoot↔Facebook); the Messenger
  round-trip itself is verified by sending a real "salam" to the connected page (INSTALL step 4).
