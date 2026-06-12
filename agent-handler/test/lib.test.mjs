// Offline unit tests for the pure helpers in lib.mjs. No Docker, no network.
// Run: node --test   (from agent-handler/)  — or: node test/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toE164DZ, findWilaya, renderShippingTable, extractReferrals, validateOrderArgs, mergeTurnEntries } from "../lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPING = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "shipping.json"), "utf8"));
const W = SHIPPING.wilayas;

test("toE164DZ — valid Algerian mobiles", () => {
  assert.equal(toE164DZ("0551234567"), "+213551234567");
  assert.equal(toE164DZ("0661234567"), "+213661234567");
  assert.equal(toE164DZ("0771234567"), "+213771234567");
  assert.equal(toE164DZ("07 71 23 45 67"), "+213771234567"); // spaces tolerated
  assert.equal(toE164DZ("+213661234567"), "+213661234567");
  assert.equal(toE164DZ("213551234567"), "+213551234567");
});

test("toE164DZ — invalid numbers rejected", () => {
  assert.equal(toE164DZ("0451234567"), null); // 04 not a mobile prefix
  assert.equal(toE164DZ("12345"), null);
  assert.equal(toE164DZ(""), null);
  assert.equal(toE164DZ(null), null);
  assert.equal(toE164DZ("055123456"), null); // too short
});

test("findWilaya — code, French, Arabic, fuzzy", () => {
  assert.equal(findWilaya(W, "13").code, 13);
  assert.equal(findWilaya(W, "16").code, 16);
  assert.equal(findWilaya(W, "tlemcen").code, 13);
  assert.equal(findWilaya(W, "TLEMCEN").code, 13);
  assert.equal(findWilaya(W, "تلمسان").code, 13);
  assert.equal(findWilaya(W, "alger").code, 16);
  assert.equal(findWilaya(W, "béjaïa").code, 6);
  assert.equal(findWilaya(W, "bejaia").code, 6); // diacritic-insensitive
  assert.equal(findWilaya(W, "sidi bel abbès").code, 22);
  assert.equal(findWilaya(W, "M sila").code, 28); // space variant
});

test("findWilaya — no match returns null", () => {
  assert.equal(findWilaya(W, "timbuktu"), null);
  assert.equal(findWilaya(W, ""), null);
  assert.equal(findWilaya(W, "99"), null);
});

test("renderShippingTable — 57 priced rows (wilaya 50 has no rate)", () => {
  const table = renderShippingTable(W);
  const rows = table.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  assert.equal(rows.length, 57); // 58 wilayas − Bordj Badji Mokhtar (null)
  assert.match(table, /Tlemcen.*700 DA.*500 DA/);
  assert.ok(!table.includes("Bordj Badji Mokhtar")); // null rate excluded
});

test("extractReferrals — Click-to-Messenger ad referral", () => {
  const payload = { entry: [{ messaging: [{ sender: { id: "PSID1" }, referral: { ad_id: "AD42", ref: "promo", source: "ADS" } }] }] };
  const refs = extractReferrals(payload);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], { psid: "PSID1", ad_id: "AD42", ref: "promo", source: "ADS" });
});

test("extractReferrals — postback referral + empty payloads", () => {
  const pb = { entry: [{ messaging: [{ sender: { id: "P2" }, postback: { referral: { ad_id: "AD7" } } }] }] };
  assert.equal(extractReferrals(pb)[0].ad_id, "AD7");
  assert.deepEqual(extractReferrals({}), []);
  assert.deepEqual(extractReferrals({ entry: [{ messaging: [{ sender: { id: "x" }, message: { text: "hi" } }] }] }), []);
});

test("validateOrderArgs — happy path resolves shipping", () => {
  const r = validateOrderArgs(
    { customer_name: "Amel", phone: "0551234567", wilaya: "Oran", product_name: "basket signature", qty: 2, delivery_type: "home", address: "Cité 100 logements" },
    SHIPPING,
  );
  assert.equal(r.error, undefined);
  assert.equal(r.wilaya.code, 31);
  assert.equal(r.shippingDzd, 650); // Oran home
  assert.deepEqual(r.fields, { customerName: "Amel", phoneE164: "+213551234567", productName: "basket signature", qty: 2, deliveryType: "home", address: "Cité 100 logements" });
});

test("validateOrderArgs — desk delivery uses desk rate, address optional", () => {
  const r = validateOrderArgs(
    { customer_name: "Sara", phone: "0661234567", wilaya: "16", product_name: "sac", qty: 1, delivery_type: "desk" },
    SHIPPING,
  );
  assert.equal(r.error, undefined);
  assert.equal(r.shippingDzd, 450); // Alger desk
});

test("validateOrderArgs — collects every missing/invalid field", () => {
  const r = validateOrderArgs({ qty: 0, delivery_type: "home" }, SHIPPING);
  assert.equal(r.error.reason, "missing_or_invalid_fields");
  for (const f of ["customer_name", "phone", "wilaya", "product_name", "qty", "address"]) {
    assert.ok(r.error.missing.includes(f), `expected missing: ${f}`);
  }
});

test("validateOrderArgs — invalid phone flagged", () => {
  const r = validateOrderArgs(
    { customer_name: "X", phone: "0451234567", wilaya: "Oran", product_name: "sac", qty: 1, delivery_type: "desk" },
    SHIPPING,
  );
  assert.deepEqual(r.error.missing, ["phone"]);
});

test("mergeTurnEntries — merges a rapid-fire burst into one turn", () => {
  const r = mergeTurnEntries([
    { query: "salam", attachments: [] },
    { query: "3andkom basket signature?", attachments: [] },
    { query: "noir?", attachments: [] },
  ]);
  assert.equal(r.query, "salam\n3andkom basket signature?\nnoir?");
  assert.deepEqual(r.attachments, []);
});

test("mergeTurnEntries — single message is unchanged", () => {
  const r = mergeTurnEntries([{ query: "wesh rak", attachments: [] }]);
  assert.equal(r.query, "wesh rak");
});

test("mergeTurnEntries — concatenates attachments, drops empty texts", () => {
  const r = mergeTurnEntries([
    { query: "", attachments: [{ file_type: "image", data_url: "a.jpg" }] },
    { query: "hada?", attachments: [{ file_type: "audio", data_url: "b.ogg" }] },
  ]);
  assert.equal(r.query, "hada?");
  assert.equal(r.attachments.length, 2);
});

test("mergeTurnEntries — empty / malformed input is safe", () => {
  assert.deepEqual(mergeTurnEntries([]), { query: "", attachments: [] });
  assert.deepEqual(mergeTurnEntries(null), { query: "", attachments: [] });
  assert.deepEqual(mergeTurnEntries([{}, { query: null }]), { query: "", attachments: [] });
});

test("validateOrderArgs — wilaya with no rate hands off", () => {
  const r = validateOrderArgs(
    { customer_name: "X", phone: "0551234567", wilaya: "Bordj Badji Mokhtar", product_name: "sac", qty: 1, delivery_type: "home", address: "centre" },
    SHIPPING,
  );
  // wilaya 50 is in the list but home/desk are null → unmatched by name lookup OR no-rate guard.
  assert.ok(r.error, "expected an error result");
  assert.ok(/no_shipping_rate|missing_or_invalid/.test(r.error.reason));
});
