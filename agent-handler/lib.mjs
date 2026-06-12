// lib.mjs — pure, side-effect-free helpers shared by server.mjs and the unit tests.
// NOTHING here touches Redis, Directus, the network, or process env, so it can be
// imported and exercised in isolation (see test/lib.test.mjs).

/** Deterministic DZ mobile → E.164 (05/06/07 prefixes, with or without +213). null = invalid. */
export function toE164DZ(raw) {
  const d = String(raw || "").replace(/[^\d+]/g, "");
  let m;
  if ((m = d.match(/^0([567]\d{8})$/))) return "+213" + m[1];
  if (/^\+213[567]\d{8}$/.test(d)) return d;
  if ((m = d.match(/^213([567]\d{8})$/))) return "+" + d;
  return null;
}

/** Lowercase, strip latin diacritics, fold apostrophes/hyphens to spaces. */
export function normalizeWilaya(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[''`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Match a customer-supplied wilaya (code 1-58, French name, or Arabic name — any case,
 *  with or without diacritics/apostrophes/spaces) to its shipping entry. null = no match. */
export function findWilaya(wilayas, input) {
  const list = Array.isArray(wilayas) ? wilayas : [];
  const raw = String(input || "").trim();
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= 58) {
    return list.find((w) => w.code === asNum) || null;
  }
  const n = normalizeWilaya(raw);
  const flat = n.replace(/ /g, ""); // "m sila" / "msila", "tizi ouzou" / "tiziouzou"
  return (
    list.find((w) => normalizeWilaya(w.name) === n || w.ar === raw) ||
    list.find((w) => flat.length >= 4 && normalizeWilaya(w.name).replace(/ /g, "") === flat) ||
    list.find((w) => n.length >= 4 && normalizeWilaya(w.name).includes(n)) ||
    null
  );
}

/** Render the per-wilaya shipping markdown table from the shipping.json wilayas list. */
export function renderShippingTable(wilayas) {
  const rows = (Array.isArray(wilayas) ? wilayas : [])
    .filter((w) => w.home != null || w.desk != null)
    .map((w) => `| ${w.code} | ${w.name} (${w.ar}) | ${w.home ?? "—"} DA | ${w.desk ?? "—"} DA |`);
  return [
    "| # | Wilaya | À domicile | Stop desk (bureau) |",
    "|---|--------|-----------|--------------------|",
    ...rows,
  ].join("\n");
}

/** Pull every Meta referral (ad attribution) out of a Messenger webhook payload.
 *  Reads messaging_referrals, postback.referral, and a first message's referral. */
export function extractReferrals(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const m of [...(entry.messaging || []), ...(entry.standby || [])]) {
      const ref = m.referral || m.postback?.referral || m.message?.referral;
      const psid = m.sender?.id;
      if (ref && psid) out.push({ psid, ad_id: ref.ad_id || null, ref: ref.ref || null, source: ref.source || null });
    }
  }
  return out;
}

/** Merge a debounced burst of buffered messages into one turn: join the texts (each separate
 *  customer bubble on its own line) and concatenate every attachment. Pure → unit-testable. */
export function mergeTurnEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const query = list.map((e) => (e && e.query) || "").filter(Boolean).join("\n").trim();
  const attachments = list.flatMap((e) => (e && Array.isArray(e.attachments) ? e.attachments : []));
  return { query, attachments };
}

/** Validate the customer-supplied order fields (everything BEFORE the catalog price lookup).
 *  Pure: no catalog/price logic here. Returns either
 *    { error: {saved:false, reason, missing?} }  — give this straight back to the model, or
 *    { wilaya, fields:{customerName, phoneE164, qty, deliveryType, address}, shippingDzd }
 *  `shipping` is the parsed shipping.json object. */
export function validateOrderArgs(args, shipping) {
  const a = args || {};
  const wilayas = shipping?.wilayas || [];
  const missing = [];

  const customerName = String(a.customer_name || "").trim();
  if (!customerName) missing.push("customer_name");
  const phoneE164 = toE164DZ(a.phone);
  if (!phoneE164) missing.push("phone");
  const wilaya = findWilaya(wilayas, a.wilaya);
  if (!wilaya) missing.push("wilaya");
  const productName = String(a.product_name || "").trim();
  if (!productName) missing.push("product_name");
  const qty = Number(a.qty || 0);
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) missing.push("qty");
  const deliveryType = a.delivery_type === "home" || a.delivery_type === "desk" ? a.delivery_type : null;
  if (!deliveryType) missing.push("delivery_type");
  const address = String(a.address || "").trim();
  if (deliveryType === "home" && !address) missing.push("address");

  if (missing.length) return { error: { saved: false, reason: "missing_or_invalid_fields", missing } };

  const shippingDzd = wilaya[deliveryType];
  if (shippingDzd == null) return { error: { saved: false, reason: `no_shipping_rate_for_${wilaya.name}` } };

  return { wilaya, shippingDzd, fields: { customerName, phoneE164, productName, qty, deliveryType, address } };
}
