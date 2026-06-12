-- pg_trgm GIN index powering explicit-mention (fuzzy product name) resolution.
-- Exact statement per 01-RESEARCH.md Pitfall 1. Runtime-safe: issue #24453 affects
-- only `directus schema apply` (never used here — schema is built via the SDK).
CREATE INDEX IF NOT EXISTS products_search_text_trgm_idx
  ON products USING gin (search_text gin_trgm_ops);
