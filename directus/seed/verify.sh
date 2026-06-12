#!/usr/bin/env bash
# CAT-01 acceptance harness for M1 (Directus Data Model & Seed).
# Run from the repo root AFTER `make seed`, against the live stack:
#   make verify-seed
# Asserts schema + seed invariants. Prints OK/FAIL per check; exits non-zero on any FAIL.
set -uo pipefail

# Load secrets/role names from .env (POSTGRES_USER, CATALOG_RO_ROLE, etc.)
[ -f .env ] && { set -a; . ./.env; set +a; }
PGU="${POSTGRES_USER:-app}"
RO_ROLE="${CATALOG_RO_ROLE:-catalog_ro}"
DURL="${DIRECTUS_PUBLIC_URL:-http://localhost:8055}"
ADMIN_EMAIL="${DIRECTUS_ADMIN_EMAIL:-}"
ADMIN_PASS="${DIRECTUS_ADMIN_PASSWORD:-}"

fail=0
sql()  { docker compose exec -T postgres psql -U "$PGU" -d directus -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
eq()   { if [ "$2" = "$3" ]; then echo "OK   $1"; else echo "FAIL $1 (got '$2', want '$3')"; fail=1; fi; }
ge()   { if [ "${2:-0}" -ge "$3" ] 2>/dev/null; then echo "OK   $1 ($2 >= $3)"; else echo "FAIL $1 (got '${2:-}', want >= $3)"; fail=1; fi; }

# Admin token — used for the /assets fetch and the /collections visibility check.
# (Directus files aren't public by default; M4's meta-bridge fetches assets server-side with a token.)
TOKEN=""
if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASS" ]; then
  TOKEN="$(curl -s -X POST "$DURL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
fi

echo "── CAT-01 schema ──"
eq "6 collections exist"            "$(sql "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('merchants','products','variants','images','ads','leads')")" "6"
eq "pg_trgm enabled"                "$(sql "SELECT 1 FROM pg_extension WHERE extname='pg_trgm'")" "1"
eq "GIN index present"              "$(sql "SELECT 1 FROM pg_indexes WHERE indexname='products_search_text_trgm_idx'")" "1"
eq "base_price is integer (DZD)"    "$(sql "SELECT data_type FROM information_schema.columns WHERE table_name='products' AND column_name='base_price'")" "integer"

echo "── CAT-01 seed ──"
ge ">=5 products seeded"            "$(sql "SELECT count(*) FROM products")" "5"
eq "3 ads seeded"                   "$(sql "SELECT count(*) FROM ads")" "3"
ge ">=10 variants seeded"           "$(sql "SELECT count(*) FROM variants")" "10"
ge ">=10 images seeded"             "$(sql "SELECT count(*) FROM images")" "10"
eq "ad ids = AD_TEST_001..003"      "$(sql "SELECT string_agg(ad_id, ',' ORDER BY ad_id) FROM ads")" "AD_TEST_001,AD_TEST_002,AD_TEST_003"
eq "every ad linked to a product"   "$(sql "SELECT count(*) FROM ads WHERE linked_product_id IS NULL")" "0"

echo "── CAT-01 retrieval (trigram + assets) ──"
eq "trigram 'basket' -> Basket Signature" "$(sql "SELECT name FROM products WHERE word_similarity('basket', search_text) > 0.5 ORDER BY word_similarity('basket', search_text) DESC LIMIT 1")" "BasketSignature"
IMG_UUID="$(sql "SELECT url FROM images WHERE url IS NOT NULL LIMIT 1")"
if [ -n "$IMG_UUID" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$DURL/assets/$IMG_UUID")"
  eq "images.url resolves at /assets (200)" "$CODE" "200"
else
  echo "FAIL images.url resolves at /assets (no image url found)"; fail=1
fi

echo "── CAT-01 variant-touch trigger (LIVE-01 precursor) ──"
TSKU="$(sql "SELECT sku FROM variants ORDER BY sku LIMIT 1")"
if [ -n "$TSKU" ]; then
  ORIG_COLOR="$(docker compose exec -T postgres psql -U "$PGU" -d directus -tAc "SELECT color FROM variants WHERE sku='$TSKU'")"
  docker compose exec -T postgres psql -U "$PGU" -d directus -c "UPDATE variants SET color='zzqa' WHERE sku='$TSKU'" >/dev/null 2>&1
  eq "variant edit refreshes parent search_text" "$(sql "SELECT (search_text LIKE '%zzqa%') FROM products WHERE id=(SELECT product_id FROM variants WHERE sku='$TSKU')")" "t"
  # Non-destructive: restore the original color so verify never mutates seed data.
  docker compose exec -T postgres psql -U "$PGU" -d directus -c "UPDATE variants SET color='${ORIG_COLOR}' WHERE sku='$TSKU'" >/dev/null 2>&1
else
  echo "FAIL variant-touch (no variant found)"; fail=1
fi

echo "── CAT-01 admin visibility ──"
if [ -n "$TOKEN" ]; then
  if curl -s -H "Authorization: Bearer $TOKEN" "$DURL/collections" | grep -q '"products"'; then
    echo "OK   products visible via Directus API (UI proxy)"
  else
    echo "FAIL products visible via Directus API"; fail=1
  fi
else
  echo "SKIP admin visibility (DIRECTUS_ADMIN_EMAIL/PASSWORD not set)"
fi

echo "── CAT-01 catalog_ro read path (M4 dependency) ──"
if docker compose exec -T postgres psql -U "$RO_ROLE" -d directus -tAc "SELECT count(*) FROM products" >/dev/null 2>&1; then
  echo "OK   catalog_ro can SELECT products"
else
  echo "FAIL catalog_ro cannot SELECT products"; fail=1
fi
if docker compose exec -T postgres psql -U "$RO_ROLE" -d directus -c "INSERT INTO products(name) VALUES('__ro_probe__')" >/dev/null 2>&1; then
  echo "FAIL catalog_ro write blocked (INSERT unexpectedly SUCCEEDED)"; fail=1
  docker compose exec -T postgres psql -U "$PGU" -d directus -c "DELETE FROM products WHERE name='__ro_probe__'" >/dev/null 2>&1
else
  echo "OK   catalog_ro write blocked (INSERT denied)"
fi

echo "── CAT-02 tenant scoping ──"
ge "merchant seeded"                       "$(sql "SELECT count(*) FROM merchants")" "1"
eq "SIRINE is the default tenant"          "$(sql "SELECT is_default FROM merchants WHERE name='SIRINE Algeria'")" "t"
eq "variants.merchant_id backfilled (0 NULL)" "$(sql "SELECT count(*) FROM variants WHERE merchant_id IS NULL")" "0"
eq "images.merchant_id backfilled (0 NULL)"   "$(sql "SELECT count(*) FROM images WHERE merchant_id IS NULL")" "0"
eq "no product has NULL merchant_id"          "$(sql "SELECT count(*) FROM products WHERE merchant_id IS NULL")" "0"

echo "────────────────────────────"
if [ "$fail" -eq 0 ]; then echo "✓ All CAT-01 + CAT-02 checks passed"; else echo "✗ One or more checks FAILED"; fi
exit "$fail"
