// retrieval-api — read-only catalog grounding for the SIRINE agent.
// Resolves a product (by stored ad_id, or by fuzzy name via pg_trgm word_similarity) and returns
// compact JSON: price (integer DZD), variants, and image URLs. Read-only DB role (catalog_ro),
// NO cache (TTL=0) so owner price edits in Directus reflect on the next call. Anti-hallucination:
// unknown product → { found:false } (never fabricated).
//
// Raw node:http (no web framework) + pg. Env: PG* (catalog_ro), PORT, RETRIEVAL_API_KEY,
// DIRECTUS_PUBLIC_URL (for /assets image URLs).

import http from "node:http";
import pg from "pg";

const PORT = Number(process.env.PORT || 8088);
const API_KEY = process.env.RETRIEVAL_API_KEY || "";
const ASSET_BASE = (process.env.DIRECTUS_PUBLIC_URL || "http://localhost:8055").replace(/\/$/, "");
const SIM_THRESHOLD = Number(process.env.MATCH_THRESHOLD || 0.3);

const pool = new pg.Pool(); // PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from env (catalog_ro)

const assetUrl = (fileId) => `${ASSET_BASE}/assets/${fileId}`;

// Every query is scoped by merchant_id (tenant isolation). merchantId is REQUIRED — the /get_product
// handler rejects calls without one, so no query ever runs unscoped (no cross-tenant catalog bleed).
// price_dzd may be NULL (course "on request") — passed through as null, never coerced to 0.
async function loadProduct(productId, merchantId) {
  const p = (
    await pool.query(
      "SELECT id,name,category,description,base_price,currency,status,duration,certification,prerequisites,location " +
        "FROM products WHERE id=$1 AND merchant_id=$2",
      [productId, merchantId],
    )
  ).rows[0];
  if (!p) return null;
  const variants = (
    await pool.query(
      "SELECT color,size,price,stock,sku FROM variants WHERE product_id=$1 AND merchant_id=$2 ORDER BY sku",
      [productId, merchantId],
    )
  ).rows;
  const images = (
    await pool.query(
      "SELECT url,angle FROM images WHERE product_id=$1 AND merchant_id=$2 ORDER BY angle",
      [productId, merchantId],
    )
  ).rows;
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    price_dzd: p.base_price, // may be null = on request (do NOT default to 0)
    currency: p.currency,
    status: p.status,
    duration: p.duration,
    certification: p.certification,
    prerequisites: p.prerequisites,
    location: p.location,
    variants: variants.map((v) => ({
      color: v.color,
      size: v.size,
      price_dzd: v.price ?? p.base_price, // null variant price inherits product base_price (may be null)
      stock: v.stock,
      sku: v.sku,
    })),
    images: images.map((i) => ({ angle: i.angle, file_id: i.url, url: assetUrl(i.url) })),
  };
}

async function resolveByAd(adId, merchantId) {
  const r = await pool.query(
    "SELECT linked_product_id FROM ads WHERE ad_id=$1 AND merchant_id=$2",
    [adId, merchantId],
  );
  return r.rows[0]?.linked_product_id || null;
}

async function resolveByQuery(q, merchantId) {
  // word_similarity (not %) — short needle in long search_text; gin_trgm_ops index backs it.
  // Scoped to the tenant: a query can never resolve to another merchant's product.
  const r = await pool.query(
    "SELECT id, word_similarity($1, search_text) AS score FROM products " +
      "WHERE merchant_id=$3 AND word_similarity($1, search_text) > $2 ORDER BY score DESC LIMIT 1",
    [q, SIM_THRESHOLD, merchantId],
  );
  return r.rows[0] ? { id: r.rows[0].id, score: Number(r.rows[0].score) } : null;
}

// List products for browsing: by category (exact) and/or a fuzzy keyword, scoped to the merchant.
// Returns compact rows {name, price_dzd, category} so the agent can present the catalog and let the
// customer pick one (then get_product gives the full detail + photo). Anti-hallucination: only real
// active rows, never invented.
async function listProducts({ category, q }, merchantId) {
  const rows = (
    await pool.query(
      "SELECT name, category, base_price FROM products " +
        "WHERE merchant_id=$1 AND status='active' " +
        "AND ($2::text IS NULL OR lower(category)=lower($2)) " +
        "AND ($3::text IS NULL OR search_text ILIKE '%'||lower($3)||'%') " +
        "ORDER BY category, base_price NULLS LAST, name LIMIT 60",
      [merchantId, category || null, q || null],
    )
  ).rows;
  return rows.map((r) => ({ name: r.name, category: r.category, price_dzd: r.base_price }));
}

// Deterministic DZ phone normalization (libphonenumber comes in Phase 7; this stub covers the
// common Algerian forms: 0[567]xxxxxxxx and +213[567]xxxxxxxx).
function toE164DZ(raw) {
  const d = String(raw || "").replace(/[^\d+]/g, "");
  let m;
  if ((m = d.match(/^0([567]\d{8})$/))) return "+213" + m[1];
  if (/^\+213[567]\d{8}$/.test(d)) return d;
  if ((m = d.match(/^213([567]\d{8})$/))) return "+" + d;
  return null;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/health") return send(res, 200, { ok: true, service: "retrieval-api" });

    // Optional API key (internal service). /health is open.
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) return send(res, 401, { error: "unauthorized" });

    if (url.pathname === "/get_product" && req.method === "GET") {
      const adId = url.searchParams.get("ad_id");
      const q = url.searchParams.get("q");
      // FAIL CLOSED: merchant_id is REQUIRED. Without it we'd query across all tenants → catalog
      // bleed. Reject rather than default to "any merchant".
      const merchantId = url.searchParams.get("merchant_id");
      if (!merchantId) return send(res, 400, { error: "merchant_id required" });
      let productId = null,
        resolvedBy = null,
        score = null;
      if (adId) {
        productId = await resolveByAd(adId, merchantId);
        resolvedBy = "ad_id";
      } else if (q) {
        const r = await resolveByQuery(q, merchantId);
        if (r) {
          productId = r.id;
          score = r.score;
        }
        resolvedBy = "query";
      } else {
        return send(res, 400, { error: "provide ad_id or q" });
      }
      if (!productId) return send(res, 200, { found: false, resolved_by: resolvedBy, query: q || adId });
      const product = await loadProduct(productId, merchantId);
      if (!product) return send(res, 200, { found: false, resolved_by: resolvedBy });
      return send(res, 200, { found: true, resolved_by: resolvedBy, ...(score != null ? { score } : {}), product });
    }

    if (url.pathname === "/list_products" && req.method === "GET") {
      const merchantId = url.searchParams.get("merchant_id");
      if (!merchantId) return send(res, 400, { error: "merchant_id required" });
      const category = url.searchParams.get("category");
      const q = url.searchParams.get("q");
      const products = await listProducts({ category, q }, merchantId);
      return send(res, 200, { count: products.length, products });
    }

    if (url.pathname === "/capture_lead" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        return send(res, 400, { error: "invalid json" });
      }
      const e164 = toE164DZ(data.phone);
      const name = String(data.name || "").trim() || null;
      return send(res, 200, {
        valid: !!e164 && !!name,
        name,
        phone_e164: e164,
        reason: !name ? "missing_name" : !e164 ? "invalid_dz_phone" : null,
      });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "internal", detail: String(err.message) });
  }
});

server.listen(PORT, () => console.log(`retrieval-api listening on :${PORT} (assets ${ASSET_BASE})`));
