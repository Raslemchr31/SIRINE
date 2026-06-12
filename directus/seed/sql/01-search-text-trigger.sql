-- search_text maintenance for products (explicit-mention / pg_trgm resolution).
-- A BEFORE INSERT/UPDATE trigger recomputes products.search_text from
-- name + description + variant colors/sizes + image AI tags (image part null-safe
-- until M5 vision tagging). A second AFTER trigger on variants bumps the parent
-- product's updated_at so the product trigger re-fires when a variant changes
-- (keeps search_text fresh under owner edits — protects the M7 LIVE-01 test).
-- Idempotent: CREATE EXTENSION IF NOT EXISTS / CREATE OR REPLACE / pg_trigger guards.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION products_set_search_text() RETURNS trigger AS $$
BEGIN
  NEW.search_text := lower(concat_ws(' ',
    NEW.name,
    NEW.description,
    (SELECT string_agg(concat_ws(' ', v.color, v.size), ' ')
       FROM variants v WHERE v.product_id = NEW.id),
    (SELECT string_agg(concat_ws(' ', i.ai_description, i.attributes->>'tags'), ' ')
       FROM images i WHERE i.product_id = NEW.id)
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'trg_products_search_text') THEN
    CREATE TRIGGER trg_products_search_text
      BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION products_set_search_text();
  END IF;
END
$$;

-- Variant-touch: re-fire the product BEFORE trigger when a variant is added/edited/removed.
CREATE OR REPLACE FUNCTION variants_touch_product() RETURNS trigger AS $$
BEGIN
  UPDATE products SET updated_at = now()
    WHERE id = COALESCE(NEW.product_id, OLD.product_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'trg_variants_touch_product') THEN
    CREATE TRIGGER trg_variants_touch_product
      AFTER INSERT OR UPDATE OR DELETE ON variants
      FOR EACH ROW EXECUTE FUNCTION variants_touch_product();
  END IF;
END
$$;
