// load-catalog.mjs — load the REAL SIRINE catalog (catalog.json + assets/catalog/*.png) into the
// live Directus, REPLACING the demo products. Run as the compose `seed` one-shot:
//
//   docker compose run --rm seed node load-catalog.mjs
//
// It logs in with DIRECTUS_ADMIN_EMAIL/PASSWORD (seed service env), finds the default (SIRINE)
// merchant, wipes that merchant's existing products/variants/images, then creates each product with
// its variants (color × size for footwear, color-only otherwise; stock 99 = available) and uploads
// its photo(s) as front images. Re-runnable (it wipes first → no duplicates).
//
// Env (from the seed service): DIRECTUS_URL, DIRECTUS_ADMIN_EMAIL, DIRECTUS_ADMIN_PASSWORD.

import fs from "node:fs";
import path from "node:path";

const DIRECTUS_URL = (process.env.DIRECTUS_URL || "http://directus:8055").replace(/\/$/, "");
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL;
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CATALOG = path.join(HERE, "catalog.json");
const ASSETS = path.join(HERE, "assets", "catalog");
const STOCK_AVAILABLE = 99; // client confirmed "everything available"; no per-unit tracking

let TOKEN = "";
async function api(method, p, body, isForm = false) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  let payload = body;
  if (body && !isForm) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${DIRECTUS_URL}${p}`, { method, headers, body: payload });
  const txt = await res.text();
  let json; try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${txt.slice(0, 300)}`);
  return json;
}

async function login() {
  if (!EMAIL || !PASSWORD) throw new Error("DIRECTUS_ADMIN_EMAIL / DIRECTUS_ADMIN_PASSWORD not set");
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  TOKEN = (await res.json()).data.access_token;
}

const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

async function wipeMerchant(merchantId) {
  // ads.linked_product_id has a DB foreign key to products — clear it first, or deleting the
  // products fails (ads_linked_product_id_foreign). We keep the ad rows, just drop the link.
  const ads = (await api("GET", `/items/ads?filter[merchant_id][_eq]=${merchantId}&filter[linked_product_id][_nnull]=true&limit=-1&fields=id`)).data;
  for (const a of ads) await api("PATCH", `/items/ads/${a.id}`, { linked_product_id: null });
  if (ads.length) console.log(`  cleared linked_product_id on ${ads.length} ads`);

  for (const coll of ["images", "variants", "products"]) {
    const ids = (await api("GET", `/items/${coll}?filter[merchant_id][_eq]=${merchantId}&limit=-1&fields=id`)).data.map((r) => r.id);
    if (ids.length) { await api("DELETE", `/items/${coll}`, ids); console.log(`  wiped ${ids.length} ${coll}`); }
  }
}

async function uploadImage(file) {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/png" }), file);
  const json = await api("POST", "/files", form, true);
  return json.data.id; // Directus file UUID
}

async function main() {
  console.log(`load-catalog → ${DIRECTUS_URL}`);
  await login();
  const merchants = (await api("GET", "/items/merchants?filter[is_default][_eq]=true&limit=1")).data;
  if (!merchants.length) throw new Error("no default (SIRINE) merchant found");
  const merchantId = merchants[0].id;
  console.log(`merchant: ${merchants[0].name} (${merchantId})`);

  console.log("wiping existing catalog for this merchant…");
  await wipeMerchant(merchantId);

  const products = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  console.log(`loading ${products.length} products…`);
  let nVar = 0, nImg = 0;
  for (const p of products) {
    const product = (await api("POST", "/items/products", {
      merchant_id: merchantId, name: p.name, category: p.category,
      base_price: p.price, currency: "DZD", status: "active",
    })).data;

    // variants: color × size for footwear (sizes present), else one per color.
    const sizes = p.sizes && p.sizes.length ? p.sizes : [null];
    const colors = p.colors && p.colors.length ? p.colors : [null];
    const rows = [];
    let k = 0;
    for (const color of colors) for (const size of sizes) {
      rows.push({
        product_id: product.id, merchant_id: merchantId,
        color: color, size: size, price: null, stock: STOCK_AVAILABLE,
        sku: `${slug(p.name)}-${slug(color || "x")}-${size || "x"}-${k++}`,
      });
    }
    if (rows.length) { await api("POST", "/items/variants", rows); nVar += rows.length; }

    // images: all as front (bot sends front; up to AGENT_MAX_IMAGES).
    for (const file of p.images) {
      const fileId = await uploadImage(file);
      await api("POST", "/items/images", { product_id: product.id, merchant_id: merchantId, url: fileId, angle: "front" });
      nImg++;
    }
    console.log(`  ✓ ${p.name} (${rows.length} variants, ${p.images.length} img)`);
  }
  console.log(`\nDONE — ${products.length} products, ${nVar} variants, ${nImg} images loaded.`);
  console.log("The bot answers from these immediately (search index updates on insert).");
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED —", e.message); process.exit(1); });
