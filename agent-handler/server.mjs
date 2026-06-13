// agent-handler — Chatwoot AgentBot webhook → Gemini agent (function-calling + memory + vision) → Chatwoot reply.
//
// THE BRAIN lives here. On each incoming customer message the agent:
//   1. loads prior conversation turns from Redis (per Chatwoot conversation_id),
//   2. runs a Gemini function-calling loop where the model autonomously calls get_product,
//   3. grounds every fact in the catalog tool output, answers in Algerian Darija,
//   4. persists the updated history, posts the reply to Chatwoot.
//
//   LANDMINE 1 — LOOP PREVENTION: act ONLY on event "message_created" && message_type "incoming"
//     (string compare). The bot's own outgoing replies re-fire this webhook; everything else → 200, no work.
//   LANDMINE 2 — MEMORY: history is keyed by Chatwoot conversation_id in Redis (agent:hist:{id}),
//     trimmed to the last N turns. Gemini is stateless; we replay the turns each call.
//   LANDMINE 3 — ESCALATION (HAND-01): if get_product returns found:false (unknown product) the
//     model emits the Darija escalation line; we ALSO post a private note + toggle the conversation
//     to "open" so a human takes over. Never ship a price/fact not grounded in get_product output.
//
// Env:
//   GEMINI_API_KEY          — Google AI Studio key (required)
//   GEMINI_MODEL            — default gemini-2.5-flash
//   RETRIEVAL_API_URL       — default http://retrieval-api:8088
//   RETRIEVAL_API_KEY       — x-api-key for retrieval-api
//   CHATWOOT_URL            — default http://chatwoot-rails:3000
//   CHATWOOT_ACCOUNT_ID     — default 1
//   CHATWOOT_AGENT_BOT_TOKEN — api_access_token for Chatwoot REST
//   REDIS_URL / REDIS_PASSWORD — conversation memory store
//   AGENT_MAX_STEPS         — max function-calling iterations per turn (default 4)
//   AGENT_HISTORY_TURNS     — how many prior Content items to keep (default 16)
//   PORT                    — default 8082

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";
import { toE164DZ, findWilaya, renderShippingTable, extractReferrals, validateOrderArgs, mergeTurnEntries } from "./lib.mjs";

const PORT = Number(process.env.PORT || 8082);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// LLM backend: "aistudio" (default — simple GEMINI_API_KEY) or "vertex" (Google Cloud Vertex AI,
// OAuth via a service account). The request/response body is the SAME Gemini schema for both, so
// only the endpoint + auth differ (see callGemini). Vertex unlocks the $300 trial / real billing
// and sidesteps the AI Studio free-tier 20/day cliff.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "aistudio").toLowerCase();
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "";
const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const VERTEX_URL = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
const RETRIEVAL_API_URL = (process.env.RETRIEVAL_API_URL || "http://retrieval-api:8088").replace(/\/$/, "");
const RETRIEVAL_API_KEY = process.env.RETRIEVAL_API_KEY || "";
const CHATWOOT_URL = (process.env.CHATWOOT_URL || "http://chatwoot-rails:3000").replace(/\/$/, "");
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "1";
const CHATWOOT_AGENT_BOT_TOKEN = process.env.CHATWOOT_AGENT_BOT_TOKEN || "";
const DIRECTUS_URL = (process.env.DIRECTUS_URL || "http://directus:8055").replace(/\/$/, "");
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN || "";
const AGENT_MAX_IMAGES = Number(process.env.AGENT_MAX_IMAGES || 3);
const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 6); // order turn = get_product + capture_order + answer
const AGENT_HISTORY_TURNS = Number(process.env.AGENT_HISTORY_TURNS || 16);
// Debounce window: how long to wait for the customer to stop sending before we process. A burst of
// rapid-fire messages ("salam" / "3andkom basket?" / "noir?") is merged into ONE turn the model
// answers with full context, instead of N separate replies. Each new message resets the timer; the
// agent fires only after this many ms of silence.
const AGENT_DEBOUNCE_MS = Number(process.env.AGENT_DEBOUNCE_MS || 4000);

const REDIS_URL =
  process.env.REDIS_URL || `redis://:${process.env.REDIS_PASSWORD || "changeme"}@redis:6379`;

// System prompt (Darija + grounding rules). Volume-mounted in compose so persona edits
// only need a `docker compose restart agent-handler` (the image carries a baked copy too).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let SYSTEM_PROMPT = "You are SIRINE's catalog assistant. Always call get_product before stating any product fact. Never invent prices, sizes, colors, stock, or images.";
try {
  SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "system-prompt.md"), "utf8");
} catch (e) {
  console.error("[prompt] could not read system-prompt.md, using fallback:", e.message);
}

// Shipping rates — SINGLE SOURCE (shipping.json): rendered into the prompt's
// {{SHIPPING_TABLE}} placeholder AND used by capture_order to compute totals
// server-side, so the displayed rate and the charged rate can never diverge.
let SHIPPING = { return_fee_dzd: 0, wilayas: [] };
try {
  SHIPPING = JSON.parse(fs.readFileSync(path.join(__dirname, "shipping.json"), "utf8"));
  console.log(`[shipping] loaded ${SHIPPING.wilayas.length} wilayas`);
} catch (e) {
  console.error("[shipping] could not read shipping.json — shipping quotes will hand off:", e.message);
}

// Render the shipping table into the prompt placeholder (single source: shipping.json).
SYSTEM_PROMPT = SYSTEM_PROMPT.includes("{{SHIPPING_TABLE}}")
  ? SYSTEM_PROMPT.replace("{{SHIPPING_TABLE}}", renderShippingTable(SHIPPING.wilayas))
  : SYSTEM_PROMPT;

// Single-tenant deployment: every inbox resolves to the SIRINE persona. (Tenant resolution
// below still scopes catalog queries by merchant_id — that isolation costs nothing and keeps
// the data model ready if a second merchant is ever added.)
function promptForTenant() {
  return SYSTEM_PROMPT;
}

// Function declarations exposed to the model.
const TOOLS = [{
  function_declarations: [{
    name: "get_product",
    description:
      "Authoritative catalog facts for THIS business. The ONLY source of " +
      "price/variants/details. Call this before stating any catalog fact. Returns {found:true, product:{...}} or {found:false}.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Product name or keywords from the customer message (fuzzy match). e.g. 'Basket Signature', 'baskets rouge', 'chaussures 42'." },
      },
      required: ["q"],
    },
  }, {
    name: "capture_order",
    description:
      "Save a CONFIRMED customer order. Call ONLY after the customer explicitly confirmed the " +
      "read-back summary (product, variant, qty, delivery type, total). The server re-verifies the " +
      "price against the catalog and computes shipping itself — pass what the customer said, never " +
      "computed totals. Returns {saved:true, order_id, total_dzd} or {saved:false, reason, missing:[...]}.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Customer full name." },
        phone: { type: "string", description: "Algerian mobile as given (05/06/07xxxxxxxx or +213…)." },
        wilaya: { type: "string", description: "Wilaya name (French or Arabic) or its number 1-58." },
        product_name: { type: "string", description: "Catalog product name in latin keywords (same wording you used for get_product)." },
        variant_color: { type: "string", description: "Chosen color, if the product has colors." },
        variant_size: { type: "string", description: "Chosen size/pointure, if applicable." },
        qty: { type: "integer", description: "Quantity, default 1." },
        delivery_type: { type: "string", enum: ["home", "desk"], description: "home = à domicile, desk = stop desk/bureau." },
        address: { type: "string", description: "Full delivery address (required for home delivery); commune for desk pickup." },
        notes: { type: "string", description: "Anything else the customer asked (optional)." },
      },
      required: ["customer_name", "phone", "wilaya", "product_name", "qty", "delivery_type"],
    },
  }, {
    name: "list_products",
    description:
      "Browse/list the catalog when the customer asks broadly ('what do you have', 'show me your bags', " +
      "'vos sacs', 'wech 3andkom', 'tous les produits'). Returns the matching products with names + prices. " +
      "Use it to present the list and let the customer pick one (then call get_product for that one's detail/photo).",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["chaussures", "sacs", "accessoires", "packs"], description: "Filter by category, if the customer named one." },
        query: { type: "string", description: "Optional keyword to narrow (e.g. 'nihel', 'sabo')." },
      },
    },
  }],
}];

const redis = createClient({ url: REDIS_URL });
redis.on("error", (err) => console.error("[redis] error:", err.message));
await redis.connect();
console.log("[redis] connected");

// LLM auth. aistudio → GEMINI_API_KEY (query param). vertex → OAuth Bearer from a service account
// (Application Default Credentials: GOOGLE_APPLICATION_CREDENTIALS points at the key JSON, or the
// VM's attached service account). google-auth-library is imported lazily so an AI-Studio-only
// install never needs it. The library caches the token and refreshes it before expiry, so calling
// vertexToken() per request is cheap.
let _googleAuth = null;
async function vertexToken() {
  if (!_googleAuth) {
    const { GoogleAuth } = await import("google-auth-library");
    _googleAuth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  }
  const client = await _googleAuth.getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : t?.token;
  if (!token) throw new Error("vertex: could not obtain an access token (check the service account / ADC)");
  return token;
}

if (LLM_PROVIDER === "vertex") {
  if (!VERTEX_PROJECT) console.error("[startup] WARNING: LLM_PROVIDER=vertex but GOOGLE_CLOUD_PROJECT is empty.");
  else console.log(`[startup] LLM provider: vertex (project=${VERTEX_PROJECT} location=${VERTEX_LOCATION} model=${GEMINI_MODEL})`);
} else {
  if (!GEMINI_API_KEY) console.error("[startup] WARNING: GEMINI_API_KEY is empty — agent will escalate every turn.");
  else console.log(`[startup] LLM provider: aistudio (model=${GEMINI_MODEL})`);
}

// ---------------------------------------------------------------------------
// Tenant resolution (multi-tenant). Map a Chatwoot inbox_id → merchant (tenant), cached from
// Directus. retrieval-api is then queried scoped to that merchant_id so catalogs never bleed
// across tenants. Any inbox NOT explicitly mapped resolves to the is_default merchant (SIRINE),
// so the live bot keeps working regardless of its exact inbox id.
// ---------------------------------------------------------------------------
let _merchantsCache = null;
let _merchantsCacheAt = 0;
const MERCHANTS_TTL_MS = 60_000;

async function loadMerchants(force = false) {
  const now = Date.now();
  if (!force && _merchantsCache && now - _merchantsCacheAt < MERCHANTS_TTL_MS) return _merchantsCache;
  try {
    const u = `${DIRECTUS_URL}/items/merchants?fields=id,name,inbox_ids,is_default&limit=-1`;
    const res = await fetch(u, { headers: DIRECTUS_TOKEN ? { Authorization: `Bearer ${DIRECTUS_TOKEN}` } : {} });
    if (!res.ok) { console.error(`[tenant] directus merchants → ${res.status}`); return _merchantsCache || []; }
    const data = (await res.json())?.data || [];
    _merchantsCache = data;
    _merchantsCacheAt = now;
    return data;
  } catch (err) {
    console.error(`[tenant] load merchants error: ${err.message}`);
    return _merchantsCache || [];
  }
}

/** Resolve a Chatwoot inbox id to a tenant {merchant_id, name}. Explicit inbox mapping wins;
 *  otherwise falls back to the is_default merchant. Returns null only if no merchants exist. */
async function resolveTenant(inboxId) {
  const idStr = String(inboxId ?? "");
  const pick = (list) => {
    for (const m of list) {
      const ids = Array.isArray(m.inbox_ids) ? m.inbox_ids.map(String) : [];
      if (idStr && ids.includes(idStr)) return m;
    }
    return null;
  };
  let merchants = await loadMerchants();
  let m = pick(merchants);
  if (!m && idStr) { merchants = await loadMerchants(true); m = pick(merchants); } // refresh once on miss
  if (!m) m = merchants.find((x) => x.is_default === true) || null;
  return m ? { merchant_id: m.id, name: m.name } : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/** Raw request bytes — the Meta relay must forward the body BYTE-EXACT or Chatwoot's
 *  X-Hub-Signature check (HMAC of the raw payload) fails. */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Meta webhook relay (ad attribution). Chatwoot v4.13 discards Messenger referral
// data entirely (its message parser never reads `referral`), so the Meta webhook
// points HERE instead of Chatwoot's /bot. We extract which ad the customer clicked
// (Click-to-Messenger), remember it by PSID, then forward the untouched payload —
// raw bytes + signature headers — to Chatwoot so everything else works as before.
// PASS-THROUGH FIRST: any relay-side error must never block delivery to Chatwoot.
// ---------------------------------------------------------------------------
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";
const AD_ATTRIBUTION_TTL = 60 * 60 * 24 * 60; // 60 days

async function relayMetaWebhook(req, res) {
  const raw = await readRawBody(req);
  // 1) Remember ad attribution by PSID (best-effort — never blocks forwarding).
  try {
    const payload = JSON.parse(raw.toString("utf8") || "{}");
    for (const r of extractReferrals(payload)) {
      if (!r.ad_id && !r.ref) continue;
      await redis.set(`agent:ad:psid:${r.psid}`, JSON.stringify({ ad_id: r.ad_id, ref: r.ref, source: r.source, ts: Date.now() }), { EX: AD_ATTRIBUTION_TTL });
      console.log(`[ads] referral psid=${r.psid} ad_id=${r.ad_id} ref=${r.ref}`);
    }
  } catch (err) {
    console.error(`[ads] referral extraction error (forwarding anyway): ${err.message}`);
  }
  // 2) Forward byte-exact to Chatwoot's Facebook endpoint with the signature headers.
  try {
    const headers = { "Content-Type": req.headers["content-type"] || "application/json" };
    for (const h of ["x-hub-signature", "x-hub-signature-256"]) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    const fwd = await fetch(`${CHATWOOT_URL}/bot`, { method: "POST", headers, body: raw });
    const txt = await fwd.text().catch(() => "");
    res.writeHead(fwd.status, { "Content-Type": fwd.headers.get("content-type") || "text/plain" });
    res.end(txt);
    if (!fwd.ok) console.error(`[ads] chatwoot /bot forward → ${fwd.status}: ${txt.slice(0, 200)}`);
  } catch (err) {
    console.error(`[ads] forward error: ${err.message}`);
    if (!res.headersSent) send(res, 502, { error: "chatwoot unreachable" }); // Meta retries on 5xx
  }
}

async function chatwootPost(convId, payload) {
  const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "api_access_token": CHATWOOT_AGENT_BOT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[chatwoot] POST messages ${convId} → ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res;
}

/**
 * Post an outgoing Chatwoot message with image attachments (multipart/form-data).
 * Chatwoot stores the files and delivers them to Messenger as real image attachments,
 * served from a public (tunnelled) URL — unlike the internal localhost asset URLs.
 */
async function chatwootPostWithImages(convId, content, images) {
  const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`;
  const form = new FormData();
  if (content) form.append("content", content);
  form.append("message_type", "outgoing");
  images.forEach((img, i) => {
    const ext = (img.mime.split("/")[1] || "jpg").replace("jpeg", "jpg");
    form.append("attachments[]", new Blob([img.buf], { type: img.mime }), `product-${i + 1}.${ext}`);
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "api_access_token": CHATWOOT_AGENT_BOT_TOKEN }, // let fetch set the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[chatwoot] POST attachments ${convId} → ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res;
}

/**
 * Fetch a Directus product image's bytes by its asset URL (any host) using the static
 * read token, so they can be re-uploaded to Chatwoot. Returns {buf, mime} or null.
 */
async function fetchDirectusImage(assetUrl) {
  const m = String(assetUrl).match(/\/assets\/([0-9a-fA-F-]{36})/);
  if (!m) return null;
  const u = `${DIRECTUS_URL}/assets/${m[1]}`;
  try {
    const res = await fetch(u, { headers: DIRECTUS_TOKEN ? { Authorization: `Bearer ${DIRECTUS_TOKEN}` } : {} });
    if (!res.ok) { console.error(`[image] directus ${res.status} for ${m[1]}`); return null; }
    const mime = res.headers.get("content-type") || "image/jpeg";
    if (!mime.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8_000_000) return null; // keep upload sane
    return { buf, mime };
  } catch (err) {
    console.error(`[image] fetch error: ${err.message}`);
    return null;
  }
}

/** Escalate: private note + toggle conversation to "open" (HAND-01). */
async function escalate(convId, reason) {
  console.log(`[escalate] conv=${convId} reason=${reason}`);
  await chatwootPost(convId, { content: `Bot escalation — ${reason}. A human agent should take over.`, private: true });
  const toggleUrl = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/toggle_status`;
  const res = await fetch(toggleUrl, {
    method: "POST",
    headers: { "api_access_token": CHATWOOT_AGENT_BOT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "open" }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[chatwoot] toggle_status ${convId} → ${res.status}: ${txt.slice(0, 200)}`);
  }
}

/** Execute the get_product tool against retrieval-api, scoped to the tenant's merchant_id.
 *  Returns the parsed JSON (or {found:false} on error). */
async function getProduct(args, merchantId) {
  const q = String(args?.q || "").trim();
  const u = new URL(`${RETRIEVAL_API_URL}/get_product`);
  if (q) u.searchParams.set("q", q);
  if (merchantId) u.searchParams.set("merchant_id", merchantId);
  try {
    const res = await fetch(u, { headers: { "x-api-key": RETRIEVAL_API_KEY } });
    if (!res.ok) {
      console.error(`[get_product] ${res.status} for q="${q}"`);
      return { found: false, error: `retrieval-api HTTP ${res.status}` };
    }
    const data = await res.json();
    console.log(`[get_product] q="${q}" → found=${data?.found}`);
    return data;
  } catch (err) {
    console.error(`[get_product] fetch error: ${err.message}`);
    return { found: false, error: err.message };
  }
}

/** Execute the list_products tool against retrieval-api (catalog browse), scoped to the tenant. */
async function listProducts(args, merchantId) {
  const u = new URL(`${RETRIEVAL_API_URL}/list_products`);
  if (merchantId) u.searchParams.set("merchant_id", merchantId);
  if (args?.category) u.searchParams.set("category", String(args.category));
  if (args?.query) u.searchParams.set("q", String(args.query));
  try {
    const res = await fetch(u, { headers: { "x-api-key": RETRIEVAL_API_KEY } });
    if (!res.ok) { console.error(`[list_products] ${res.status}`); return { count: 0, products: [] }; }
    const data = await res.json();
    console.log(`[list_products] category=${args?.category || "-"} q=${args?.query || "-"} → ${data?.count}`);
    return data;
  } catch (err) {
    console.error(`[list_products] error: ${err.message}`);
    return { count: 0, products: [] };
  }
}

/**
 * Execute the capture_order tool. EVERYTHING money-related is recomputed server-side:
 * the unit price comes from a fresh get_product call (never the model's number) and the
 * shipping from shipping.json — the model only relays what the customer said.
 * Returns {saved:true, order_id, ...} or {saved:false, reason, missing?} for the model
 * to ask the customer for the missing/invalid piece.
 */
async function captureOrder(args, tenant, convId) {
  const a = args || {};
  // Field validation + shipping resolution is pure (lib.mjs) — unit-tested in isolation.
  const v = validateOrderArgs(a, SHIPPING);
  if (v.error) return v.error;
  const { wilaya, shippingDzd: shipping } = v;
  const { customerName, phoneE164, productName, qty, deliveryType, address } = v.fields;

  // Re-verify the product + price against the catalog RIGHT NOW (price may have changed,
  // and the model's numbers are never trusted).
  const lookup = await getProduct({ q: productName }, tenant?.merchant_id);
  if (!lookup?.found || !lookup.product) return { saved: false, reason: "product_not_found_in_catalog" };
  const product = lookup.product;
  const wantColor = String(a.variant_color || "").trim().toLowerCase();
  const wantSize = String(a.variant_size || "").trim().toLowerCase();
  let variant = null;
  if (Array.isArray(product.variants) && product.variants.length && (wantColor || wantSize)) {
    variant = product.variants.find((v) =>
      (!wantColor || String(v.color || "").toLowerCase().includes(wantColor)) &&
      (!wantSize || String(v.size || "").toLowerCase() === wantSize),
    ) || null;
    if (!variant) return { saved: false, reason: "variant_not_found", available_variants: product.variants.map((v) => ({ color: v.color, size: v.size, stock: v.stock })) };
    if (variant.stock === 0) return { saved: false, reason: "variant_out_of_stock" };
  }
  const unitPrice = variant?.price_dzd ?? product.price_dzd;
  if (unitPrice == null) return { saved: false, reason: "price_on_request_handoff_required" };
  const total = unitPrice * qty + shipping;

  // Ad attribution (set by the /meta/webhook relay when the customer came from an ad).
  let sourceAdId = null, sourceRef = null;
  try {
    const rawAd = await redis.get(`agent:ad:conv:${convId}`);
    if (rawAd) ({ ad_id: sourceAdId = null, ref: sourceRef = null } = JSON.parse(rawAd));
  } catch {}

  const row = {
    merchant_id: tenant?.merchant_id || null,
    customer_name: customerName,
    phone_e164: phoneE164,
    wilaya: wilaya.name,
    wilaya_code: wilaya.code,
    product_id: product.id || null,
    product_name: product.name,
    variant_color: variant?.color ?? (wantColor || null),
    variant_size: variant?.size ?? (wantSize || null),
    qty,
    delivery_type: deliveryType,
    unit_price_dzd: unitPrice,
    shipping_dzd: shipping,
    total_dzd: total,
    address: address || null,
    notes: String(a.notes || "").trim() || null,
    conversation_id: String(convId),
    source_ad_id: sourceAdId,
    source_ref: sourceRef,
    status: "new",
  };
  try {
    const res = await fetch(`${DIRECTUS_URL}/items/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(DIRECTUS_TOKEN ? { Authorization: `Bearer ${DIRECTUS_TOKEN}` } : {}) },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[order] directus POST → ${res.status}: ${txt.slice(0, 200)}`);
      return { saved: false, reason: "storage_error_handoff_required" };
    }
    const data = await res.json();
    const orderId = data?.data?.id || null;
    console.log(`[order] saved conv=${convId} order=${orderId} total=${total} DZD (${product.name} x${qty} + ${shipping} ship)`);
    return { saved: true, order_id: orderId, unit_price_dzd: unitPrice, shipping_dzd: shipping, total_dzd: total, wilaya: wilaya.name };
  } catch (err) {
    console.error(`[order] save error: ${err.message}`);
    return { saved: false, reason: "storage_error_handoff_required" };
  }
}

/**
 * Fetch a Chatwoot attachment (image OR audio/voice note) and return a Gemini inlineData part.
 * Gemini 2.5 understands both vision and audio (Darija voice notes), so we pass the raw media.
 * Returns the part or null.
 */
async function mediaPartFromUrl(dataUrl, hintType) {
  try {
    // Chatwoot mints attachment URLs with the public FRONTEND_URL (ngrok), which is
    // unreachable from inside the Docker network — and dead entirely when the tunnel
    // is down. Rewrite active_storage paths to the internal Chatwoot service so media
    // fetch (vision + voice transcription) never depends on the public tunnel.
    let fetchUrl = dataUrl;
    try {
      const u = new URL(dataUrl);
      if (u.pathname.startsWith("/rails/")) fetchUrl = CHATWOOT_URL + u.pathname + u.search;
    } catch { /* non-URL data_url — fetch as-is */ }
    const res = await fetch(fetchUrl);
    if (!res.ok) { console.error(`[media] fetch ${res.status}`); return null; }
    let mimeType = res.headers.get("content-type") || "";
    // active_storage sometimes serves octet-stream — fall back to the attachment hint.
    if (!mimeType.startsWith("image/") && !mimeType.startsWith("audio/")) {
      if (hintType === "audio") mimeType = "audio/ogg";
      else if (hintType === "image") mimeType = "image/jpeg";
      else return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const cap = mimeType.startsWith("audio/") ? 15_000_000 : 4_000_000;
    if (buf.length > cap) { console.error(`[media] too big ${buf.length}`); return null; }
    return { inlineData: { mimeType, data: buf.toString("base64") } };
  } catch (err) {
    console.error(`[media] could not fetch attachment: ${err.message}`);
    return null;
  }
}

/**
 * One Gemini generateContent call with tools, with retry on transient failures
 * (HTTP 429/500/503 — model overload was causing spurious escalations).
 */
async function callGemini(tenant, contents) {
  const body = {
    system_instruction: { parts: [{ text: promptForTenant(tenant) }] },
    contents,
    tools: TOOLS,
    tool_config: { function_calling_config: { mode: "AUTO" } },
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };
  const RETRYABLE = new Set([429, 500, 503]);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * 2 ** (attempt - 1))); // 0.6s,1.2s,2.4s
    let res;
    try {
      // Same Gemini body for both backends — only the endpoint + auth differ.
      let endpoint, headers;
      if (LLM_PROVIDER === "vertex") {
        endpoint = VERTEX_URL;
        headers = { "Content-Type": "application/json", Authorization: `Bearer ${await vertexToken()}` };
      } else {
        endpoint = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
        headers = { "Content-Type": "application/json" };
      }
      res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) { lastErr = e; continue; } // network blip / token fetch → retry
    if (res.ok) {
      const data = await res.json();
      const cand = data?.candidates?.[0];
      if (!cand?.content) throw new Error(`Gemini returned no content: ${JSON.stringify(data).slice(0, 300)}`);
      return cand.content;
    }
    const txt = await res.text().catch(() => "");
    lastErr = new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 300)}`);
    // Per-DAY quota is exhausted for the rest of the day — retrying just burns calls. Fail fast
    // with a tagged error so the handler can degrade politely instead of escalating every customer.
    const perDayExhausted = res.status === 429 && /PerDay|per day|RequestsPerDay/i.test(txt);
    if (perDayExhausted) lastErr.code = "quota_daily";
    if (!RETRYABLE.has(res.status) || perDayExhausted) {
      if (perDayExhausted) console.error("[gemini] 429 per-DAY quota exhausted — not retrying");
      break; // 4xx (bad key/request) or daily quota → don't retry
    }
    console.error(`[gemini] ${res.status} attempt ${attempt + 1}/4, retrying`);
  }
  throw lastErr;
}

/**
 * Run the function-calling agent for one user turn.
 * `history` = prior Gemini Content[] (persisted). `userParts` = parts for this turn.
 * Returns { answer, contents, foundFalse, ok }.
 */
async function runAgent(tenant, history, userParts, convId) {
  const contents = [...history, { role: "user", parts: userParts }];
  let foundFalse = false;
  let foundTrue = false;
  let images = []; // asset URLs from the most recently resolved product (for [[IMG]] delivery)

  for (let step = 0; step < AGENT_MAX_STEPS; step++) {
    const modelContent = await callGemini(tenant, contents);
    contents.push(modelContent);

    const calls = (modelContent.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
    if (calls.length === 0) {
      // Plain text answer — done.
      const answer = (modelContent.parts || []).map((p) => p.text).filter(Boolean).join("\n").trim();
      return { answer, contents, foundFalse, foundTrue, images, ok: true };
    }

    // Execute each requested tool call and append the responses.
    const responseParts = [];
    for (const call of calls) {
      let result = { error: "unknown tool" };
      if (call.name === "capture_order") {
        result = await captureOrder(call.args || {}, tenant, convId);
      } else if (call.name === "list_products") {
        result = await listProducts(call.args || {}, tenant?.merchant_id);
      } else if (call.name === "get_product") {
        result = await getProduct(call.args || {}, tenant?.merchant_id);
        if (result && result.found === true) {
          foundTrue = true;
          const imgs = result.product && Array.isArray(result.product.images) ? result.product.images : [];
          // Send ONLY the product's own primary ("front") photo. Seed data fills the secondary
          // angle with a DIFFERENT product's image, so non-front angles aren't trustworthy yet.
          if (imgs.length) {
            const front = imgs.filter((i) => i.angle === "front");
            images = (front.length ? front : imgs).map((i) => i.url).filter(Boolean); // latest product wins
          }
        }
        if (result && result.found === false) foundFalse = true;
      }
      responseParts.push({ functionResponse: { name: call.name, response: result } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  // Ran out of steps without a final text answer.
  return { answer: "", contents, foundFalse, foundTrue, images, ok: false };
}

/**
 * Sanitize history for persistence: keep only conversational TEXT turns (what the customer said
 * + what the bot answered), dropping functionCall / functionResponse / inlineData parts.
 * Gemini requires a functionResponse turn to immediately follow a functionCall turn; persisting
 * that scaffolding and then trimming can split the pair → HTTP 400 INVALID_ARGUMENT on the next
 * turn. Tool calls are re-derived each turn anyway, so memory only needs the text.
 */
function sanitizeHistory(contents) {
  const out = [];
  for (const c of contents || []) {
    const textParts = (c.parts || []).filter((p) => typeof p.text === "string" && p.text.trim());
    if (textParts.length) out.push({ role: c.role, parts: textParts.map((p) => ({ text: p.text })) });
  }
  return out;
}

/** Keep memory bounded: sanitize, then keep the last AGENT_HISTORY_TURNS text turns. */
function trimHistory(contents) {
  const clean = sanitizeHistory(contents);
  return clean.length > AGENT_HISTORY_TURNS ? clean.slice(-AGENT_HISTORY_TURNS) : clean;
}

// ---------------------------------------------------------------------------
// Debounce + per-conversation serialization.
//   pendingTurns:   convId → { entries:[{query,attachments}], ctx, timer }  (messages buffered
//                   during the silence window; ctx = latest webhook's conversation/contact/body).
//   processingConvs: convId currently being processed — the LOCK. A conversation never has two
//                   turns running at once, so memory reads/writes can't race (out-of-order webhooks,
//                   or a new message arriving mid-run, are handled cleanly).
// Single agent-handler instance → in-process maps are sufficient (and avoid serializing media to
// Redis). A container restart drops an in-flight buffer (rare; the customer simply re-sends).
// ---------------------------------------------------------------------------
const pendingTurns = new Map();
const processingConvs = new Set();

/** Fire when the debounce timer elapses: process the buffered burst as one turn, honoring the
 *  per-conversation lock. */
async function drainConv(convId) {
  const buf = pendingTurns.get(convId);
  if (!buf || !buf.entries.length) return;
  // A run is already in flight for this conversation → don't overlap. Re-arm a short timer and
  // keep the buffer; we'll drain once the current turn finishes.
  if (processingConvs.has(convId)) {
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => drainConv(convId).catch((e) => console.error(`[debounce] drain error: ${e.message}`)), 1000);
    return;
  }
  pendingTurns.delete(convId);
  processingConvs.add(convId);
  try {
    await processConvTurn(convId, buf.entries, buf.ctx);
  } catch (err) {
    console.error(`[turn] conv=${convId} error: ${err.message}`);
  } finally {
    processingConvs.delete(convId);
    // If new messages arrived while we were processing, they created a fresh buffer + timer
    // already — leave it to fire on its own.
  }
}

/**
 * Process one (possibly merged) customer turn: build parts from every buffered message, load
 * memory, resolve tenant + ad attribution, run the agent, and post the single reply.
 * `entries` = [{query, attachments}] collected during the debounce window. `ctx` = latest
 * webhook's { conversation, contact, body }.
 */
async function processConvTurn(convId, entries, ctx) {
  const { conversation, contact, body } = ctx;
  const chatwootConvId = String(convId);
  // Merge the burst: all texts joined (newline = the customer's separate bubbles), all
  // attachments concatenated. The model sees the whole thought, not fragments.
  const { query, attachments } = mergeTurnEntries(entries);
  const contactId = String(contact?.id || body.sender?.id || "unknown");
  console.log(`[turn] conv=${chatwootConvId} contact=${contactId} merged ${entries.length} message(s) query="${query.slice(0, 80)}" attachments=${attachments.length}`);

  // Build this turn's user parts: text + image attachments (vision) + audio (voice notes).
  const userParts = [];
  if (query) userParts.push({ text: query });
  let hadMedia = false;
  let sawImage = false;
  for (const att of attachments) {
    const dataUrl = att?.data_url || att?.url || att?.thumb_url;
    if (!dataUrl) continue;
    const isImage = (att?.file_type === "image") || /\.(png|jpe?g|webp|gif)$/i.test(String(dataUrl));
    const isAudio = (att?.file_type === "audio") || /\.(ogg|oga|mp3|m4a|aac|wav|opus)$/i.test(String(dataUrl));
    if (!isImage && !isAudio) continue;
    const part = await mediaPartFromUrl(dataUrl, isAudio ? "audio" : "image");
    if (part) { userParts.push(part); hadMedia = true; if (isImage) sawImage = true; }
  }

  // IMAGE CARRY-FORWARD: covers the cross-window case (image in one debounce turn, the follow-up
  // text in a LATER turn). Within a single window an image + its caption are already merged above.
  const imgKey = `agent:img:${chatwootConvId}`;
  if (sawImage) {
    const imgParts = userParts.filter((p) => p.inlineData && String(p.inlineData.mimeType).startsWith("image/"));
    try { await redis.set(imgKey, JSON.stringify(imgParts), { EX: 180 }); } catch {}
  } else if (query) {
    try {
      const rawImg = await redis.get(imgKey);
      const cachedImgs = rawImg ? JSON.parse(rawImg) : null;
      if (Array.isArray(cachedImgs) && cachedImgs.length) {
        userParts.unshift(...cachedImgs);
        console.log(`[image] carried forward ${cachedImgs.length} cached image(s) into text turn conv=${chatwootConvId}`);
      }
    } catch {}
  }

  // If the customer ONLY sent media (no text), nudge the model to act on it. For an image with no
  // clear question, the model must ASK what the customer wants (NOT hand off).
  if (hadMedia && !query) {
    userParts.push({ text: "(le client a envoyé un média ci-dessus — comprends-le et réponds; si c'est l'image d'un produit, identifie-le et appelle get_product; si tu ne sais pas ce qu'il veut, demande-lui brièvement ce qu'il veut savoir — NE fais PAS de handoff)" });
  }
  if (userParts.length === 0) userParts.push({ text: "(message vide)" });

  // LANDMINE 2 — load conversation memory.
  const storeKey = `agent:hist:${chatwootConvId}`;
  let history = [];
  try {
    const raw = await redis.get(storeKey);
    // sanitize on read too, so any legacy history that still holds functionCall/response
    // scaffolding (which can 400 Gemini) self-heals instead of breaking the conversation.
    if (raw) history = sanitizeHistory(JSON.parse(raw));
  } catch (e) {
    console.error(`[memory] load error: ${e.message}`);
  }

  // Resolve which tenant (merchant) this inbox serves. retrieval-api is queried scoped to this
  // merchant_id so catalogs never bleed across tenants. Unmapped inbox → is_default (SIRINE).
  const inboxId = conversation?.inbox_id ?? body.inbox?.id ?? conversation?.inbox?.id;
  const tenant = await resolveTenant(inboxId);
  if (!tenant) {
    console.error(`[tenant] no merchant resolved for inbox=${inboxId} — escalating`);
    await escalate(chatwootConvId, `no tenant mapped for inbox ${inboxId}`);
    return;
  }
  console.log(`[tenant] inbox=${inboxId} → ${tenant.name} (${tenant.merchant_id})`);

  // AD ATTRIBUTION: the Meta relay stored the clicked ad by PSID; pin it to this
  // conversation (capture_order reads agent:ad:conv:<id> at save time). On the very
  // first turn, also tell the model WHICH product the ad was about (grounded via the
  // ads collection in the catalog) so it can answer without guessing.
  try {
    const psid = conversation?.contact_inbox?.source_id || body.contact_inbox?.source_id;
    const convAdKey = `agent:ad:conv:${chatwootConvId}`;
    let attribution = JSON.parse((await redis.get(convAdKey)) || "null");
    if (!attribution && psid) {
      attribution = JSON.parse((await redis.get(`agent:ad:psid:${psid}`)) || "null");
      if (attribution) {
        await redis.set(convAdKey, JSON.stringify(attribution), { EX: AD_ATTRIBUTION_TTL });
        console.log(`[ads] conv=${chatwootConvId} attributed to ad_id=${attribution.ad_id}`);
      }
    }
    if (attribution?.ad_id && history.length === 0) {
      const u = new URL(`${RETRIEVAL_API_URL}/get_product`);
      u.searchParams.set("ad_id", attribution.ad_id);
      u.searchParams.set("merchant_id", tenant.merchant_id);
      const r = await fetch(u, { headers: { "x-api-key": RETRIEVAL_API_KEY } });
      const d = r.ok ? await r.json() : null;
      if (d?.found && d.product?.name) {
        userParts.push({ text: `(contexte système : le client arrive d'une publicité Facebook pour le produit « ${d.product.name} » — c'est très probablement le produit dont il parle ; vérifie avec get_product avant d'affirmer un fait)` });
      }
    }
  } catch (err) {
    console.error(`[ads] attribution lookup error: ${err.message}`);
  }

  // Run the agent.
  let result;
  try {
    result = await runAgent(tenant, history, userParts, chatwootConvId);
  } catch (err) {
    console.error(`[agent] error: ${err.message}`);
    if (err.code === "quota_daily") {
      // GRACEFUL 429 DEGRADE: the daily Gemini quota is gone — do NOT dump every customer
      // into the human queue. Tell the customer ONCE (per conversation, per day) that the
      // team will follow up, leave the conversation in `pending`, and note it for the team.
      const quotaKey = `agent:quotamsg:${chatwootConvId}`;
      const already = await redis.get(quotaKey).catch(() => null);
      if (!already) {
        await redis.set(quotaKey, "1", { EX: 86400 }).catch(() => {});
        await chatwootPost(chatwootConvId, {
          content: "معليش خويا/ختي، عندنا ضغط كبير دروك 🙏 واحد من الفريق يجاوبك في أقرب وقت إن شاء الله.",
          message_type: "outgoing",
          private: false,
          content_type: "text",
        });
        await chatwootPost(chatwootConvId, { content: "Bot paused: Gemini daily quota exhausted (HTTP 429 per-day). Customers get a polite wait message; conversations stay pending.", private: true });
      }
      return;
    }
    await escalate(chatwootConvId, `agent error: ${err.message}`);
    return;
  }

  if (!result.ok || !result.answer) {
    await escalate(chatwootConvId, "agent produced no grounded answer");
    return;
  }

  // Persist trimmed memory.
  try {
    await redis.set(storeKey, JSON.stringify(trimHistory(result.contents)), { EX: 86400 });
  } catch (e) {
    console.error(`[memory] save error: ${e.message}`);
  }

  // Image delivery: when the model emits the [[IMG]] marker, fetch the resolved product's
  // image bytes from Directus and upload them to Chatwoot as REAL attachments (Messenger then
  // shows actual photos instead of dead localhost links). Strip the marker from the text.
  // The model often writes a photo caption but FORGETS the marker, so also send when the
  // CUSTOMER's own message clearly asks for a photo (keyword) and we have an image to send.
  const askedPhoto = /photo|tswira|tsawer|sewra|sawra|\bimage\b|صور|تصاو|تصوير|نشوف|ورّ?يني|ورني|montre|\bvoir\b/i.test(query);
  const wantsImages = /\[\[IMG\]\]/.test(result.answer) || askedPhoto;
  // [[HANDOFF]] = the model couldn't help (didn't understand, can't identify a product,
  // customer wants a human, question beyond catalog) → send the wait message then hand to a human.
  const wantsHandoff = /\[\[HANDOFF\]\]/.test(result.answer);
  const cleanAnswer = result.answer
    .replace(/\[\[IMG\]\]/g, "")
    .replace(/\[\[HANDOFF\]\]/g, "")
    .replace(/https?:\/\/\S*\/assets\/[0-9a-fA-F-]{36}\S*/g, "") // never leak dead asset URLs
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || "📷";
  // Cache the most-recently-resolved product's images per conversation. So when the model emits
  // [[IMG]] in a follow-up turn WITHOUT re-calling get_product (it answered from memory), we can
  // still send the right photo instead of dropping it.
  const lastImgKey = `agent:lastimg:${chatwootConvId}`;
  if (result.images && result.images.length) {
    try { await redis.set(lastImgKey, JSON.stringify(result.images), { EX: 3600 }); } catch {}
  }
  let imageUrls = (result.images && result.images.length) ? result.images : null;
  if (wantsImages && !imageUrls) {
    try { const raw = await redis.get(lastImgKey); if (raw) imageUrls = JSON.parse(raw); } catch {}
  }

  let sentWithImages = false;
  if (wantsImages && imageUrls && imageUrls.length) {
    const picked = imageUrls.slice(0, AGENT_MAX_IMAGES);
    const imgs = (await Promise.all(picked.map(fetchDirectusImage))).filter(Boolean);
    if (imgs.length) {
      await chatwootPostWithImages(chatwootConvId, cleanAnswer, imgs);
      sentWithImages = true;
      console.log(`[reply] conv=${chatwootConvId} images=${imgs.length} answer="${cleanAnswer.slice(0, 60)}"`);
    }
  }
  if (!sentWithImages) {
    // Plain text reply (no images requested, or image fetch failed → never drop the answer).
    await chatwootPost(chatwootConvId, {
      content: cleanAnswer,
      message_type: "outgoing",
      private: false,
      content_type: "text",
    });
    console.log(`[reply] conv=${chatwootConvId} answer="${cleanAnswer.slice(0, 80)}"`);
  }

  // HAND-01 escalation — MODEL-DRIVEN ONLY (via [[HANDOFF]]). The model is instructed to give the
  // customer a chance to re-explain BEFORE handing off; a single found:false (vague query) must NOT
  // auto-escalate, or the bot would dump the customer on a human at the first misunderstanding and
  // the conversation flips to "open" (bot goes silent). So we no longer auto-escalate on found:false
  // — the model asks for clarification, and only emits [[HANDOFF]] once it's genuinely stuck.
  if (wantsHandoff) {
    await escalate(chatwootConvId, "model requested human handoff (after clarification / out of scope)");
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "agent-handler" });
    }

    // Meta webhook relay — GET = subscription verify echo, POST = referral capture + passthrough.
    if (url.pathname === "/meta/webhook" && req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") || "";
      if (mode === "subscribe" && FB_VERIFY_TOKEN && token === FB_VERIFY_TOKEN) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(challenge);
      }
      return send(res, 403, { error: "verify token mismatch" });
    }
    if (url.pathname === "/meta/webhook" && req.method === "POST") {
      return relayMetaWebhook(req, res);
    }

    if (url.pathname === "/agentbot" && req.method === "POST") {
      const body = await readBody(req);
      const { event, message_type, content, conversation, contact } = body;

      // LANDMINE 1 — loop prevention.
      if (event !== "message_created" || message_type !== "incoming") {
        return send(res, 200, { ok: true, skipped: true });
      }

      // HANDOFF-PAUSE: once a human owns the conversation (status "open") or it's closed
      // ("resolved"), the bot stays silent so the human takes over cleanly. The bot acts only
      // on "pending" conversations (its lane). Unknown/missing status → act (safe fallback).
      const convStatus = conversation?.status;
      if (convStatus === "open" || convStatus === "resolved") {
        console.log(`[skip] conv=${conversation?.id} status=${convStatus} — human handling, bot silent`);
        return send(res, 200, { ok: true, skipped: true, reason: `human_handling:${convStatus}` });
      }

      const chatwootConvId = String(conversation?.id || "");
      const query = String(content || "").trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];

      if (!chatwootConvId || (!query && attachments.length === 0)) {
        return send(res, 200, { ok: true, skipped: true, reason: "empty conv or content" });
      }

      // Ack immediately so Chatwoot's webhook does not time out.
      send(res, 200, { ok: true });

      // DEBOUNCE: buffer this message and (re)start the silence timer. A burst of rapid messages
      // is merged into ONE turn (processConvTurn) once the customer pauses AGENT_DEBOUNCE_MS.
      const buf = pendingTurns.get(chatwootConvId) || { entries: [], ctx: null, timer: null };
      buf.entries.push({ query, attachments });
      buf.ctx = { conversation, contact, body }; // latest webhook wins (newest inbox/psid/status)
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(() => drainConv(chatwootConvId).catch((e) => console.error(`[debounce] drain error: ${e.message}`)), AGENT_DEBOUNCE_MS);
      pendingTurns.set(chatwootConvId, buf);
      console.log(`[agentbot] conv=${chatwootConvId} buffered (${buf.entries.length} pending) query="${query.slice(0, 60)}" attachments=${attachments.length}`);
      return;
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[server] unhandled error:", err.message);
    if (!res.headersSent) send(res, 500, { error: "internal", detail: String(err.message) });
  }
});

server.listen(PORT, () => console.log(`agent-handler (gemini agent) listening on :${PORT}`));
