-- Multi-tenant alters that the Directus SDK cannot perform on an EXISTING column.
-- ensureField (bootstrap.mjs) only CREATES missing fields; it never alters an existing one.
-- These run in PHASE B (after schema, before seed) and are idempotent: DROP NOT NULL / DROP
-- DEFAULT on an already-nullable / default-less column is a no-op in Postgres (no error).
--
-- WHY: a NULL price = "on request". A NOT-NULL default-0 column would silently store those as
-- 0 DZD — a false "free" fact (anti-hallucination breach). Unknown stock likewise → NULL allowed.
ALTER TABLE products ALTER COLUMN base_price DROP NOT NULL;
ALTER TABLE products ALTER COLUMN base_price DROP DEFAULT;
ALTER TABLE variants ALTER COLUMN stock DROP NOT NULL;
ALTER TABLE variants ALTER COLUMN stock DROP DEFAULT;
