// bootstrap.mjs — the seed entrypoint and the ONLY logic file (data lives in
// schema.mjs / data.mjs / sql/*.sql). Run by the compose one-shot `seed` service
// after a Directus-health poll: `node bootstrap.mjs`.
//
// Three idempotent phases, in MANDATORY order (RESEARCH System Architecture + Pitfalls 3,4):
//   PHASE A  schema  — collections → scalar fields → FK fields → relations (Directus SDK)
//   PHASE B  raw SQL — search_text function+trigger, then GIN index (pg, reads sql/*.sql)
//   PHASE C  seed    — file uploads, then upsert merchant → products → variants → images → ads
//
// Re-run = no-op: every helper is check-then-create / query-then-PATCH-or-POST.
// SECURITY (T-01-01 / ASVS V7): creds come from env ONLY; never console.log a token or password.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDirectus,
  rest,
  authentication,
  readCollection,
  createCollection,
  readFieldsByCollection,
  createField,
  updateField,
  readRelations,
  createRelation,
  readItems,
  createItem,
  updateItem,
  readFiles,
  uploadFiles,
} from "@directus/sdk";
import { Client as PgClient } from "pg";

import { collections, relations } from "./schema.mjs";
import { tenants } from "./data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, "sql");
const ASSETS_DIR = join(__dirname, "assets");

// ---------------------------------------------------------------------------
// Directus client + login. authentication('json') makes the SDK attach the
// Bearer token automatically on every later request.
// ---------------------------------------------------------------------------

function makeClient() {
  const url = process.env.DIRECTUS_URL;
  if (!url) throw new Error("DIRECTUS_URL is required (e.g. http://directus:8055)");
  // autoRefresh:false — no token-refresh timer, so the one-shot can exit cleanly.
  return createDirectus(url).with(authentication("json", { autoRefresh: false })).with(rest());
}

async function login(client) {
  const email = process.env.DIRECTUS_ADMIN_EMAIL;
  const password = process.env.DIRECTUS_ADMIN_PASSWORD;
  if (!email || !password) {
    // Never echo the values — only that they are missing.
    throw new Error("DIRECTUS_ADMIN_EMAIL and DIRECTUS_ADMIN_PASSWORD are required");
  }
  await client.login({ email, password }); // @directus/sdk v21: object payload; token kept in-memory, never logged
  console.log(`  login: authenticated as ${email}`);
}

// ---------------------------------------------------------------------------
// Generic idempotent helpers (fully implemented — reused by all phases).
// Each logs exactly one line per item: "ensure <thing>: exists|created".
// ---------------------------------------------------------------------------

// Ensure a collection (and its inline PK field) exists. Read-then-create.
async function ensureCollection(client, def) {
  try {
    await client.request(readCollection(def.collection));
    console.log(`  ensure collection ${def.collection}: exists`);
    return "exists";
  } catch {
    await client.request(createCollection(def));
    console.log(`  ensure collection ${def.collection}: created`);
    return "created";
  }
}

// Ensure a single field exists on a collection. Lists existing fields, then
// POSTs the field only if absent (no native idempotent field create).
async function ensureField(client, collection, fieldDef) {
  const existing = await client.request(readFieldsByCollection(collection));
  const has = existing.some((f) => f.field === fieldDef.field);
  if (has) {
    console.log(`  ensure field ${collection}.${fieldDef.field}: exists`);
    return "exists";
  }
  await client.request(createField(collection, fieldDef));
  console.log(`  ensure field ${collection}.${fieldDef.field}: created`);
  return "created";
}

// Force an EXISTING field to be nullable in Directus metadata (directus_fields). ensureField only
// CREATES missing fields, so a field first created NOT-NULL stays NOT-NULL and Directus rejects null
// values BEFORE they reach Postgres — even after a raw DB ALTER. updateField patches the metadata
// (and Directus re-applies the column DDL). Idempotent: patching an already-nullable field is a no-op.
async function ensureNullable(client, collection, field) {
  try {
    await client.request(updateField(collection, field, { schema: { is_nullable: true }, meta: { required: false } }));
    console.log(`  nullable ${collection}.${field}: ok`);
  } catch (err) {
    console.error(`  nullable ${collection}.${field}: ${err.message}`);
  }
}

// Ensure an m2o relation exists. Matches on (collection, field) in directus_relations.
// relDef is the create-body shape {collection, field, related_collection, meta}.
async function ensureRelation(client, relDef) {
  const existing = await client.request(readRelations());
  const has = existing.some(
    (r) => r.collection === relDef.collection && r.field === relDef.field,
  );
  if (has) {
    console.log(`  ensure relation ${relDef.collection}.${relDef.field}: exists`);
    return "exists";
  }
  await client.request(createRelation(relDef));
  console.log(`  ensure relation ${relDef.collection}.${relDef.field}: created`);
  return "created";
}

// Idempotent item upsert keyed on a natural key (RESEARCH Pattern 5 — no native upsert).
// Returns the row id (existing or newly created).
async function upsertByKey(client, collection, keyField, keyValue, payload) {
  const found = await client.request(
    readItems(collection, {
      filter: { [keyField]: { _eq: keyValue } },
      limit: 1,
      fields: ["id"],
    }),
  );
  if (found.length) {
    await client.request(updateItem(collection, found[0].id, payload));
    console.log(`  upsert ${collection}[${keyField}=${keyValue}]: updated`);
    return found[0].id;
  }
  const created = await client.request(
    createItem(collection, { [keyField]: keyValue, ...payload }, { fields: ["id"] }),
  );
  console.log(`  upsert ${collection}[${keyField}=${keyValue}]: created`);
  return created.id;
}

// Detect real image type from magic bytes so Directus stores the correct content-type
// (octet-stream → no thumbnail, breaks M4 media relay). SIRINE CDN mixes PNG + JPEG.
function sniffImage(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return { mime: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };
  return { mime: "application/octet-stream", ext: "bin" };
}

// Idempotent file upload: look up by title before uploading; reuse the file UUID on re-run.
async function ensureFile(client, title, filepath) {
  const found = await client.request(
    readFiles({ filter: { title: { _eq: title } }, limit: 1, fields: ["id"] }),
  );
  if (found.length) {
    console.log(`  ensure file ${title}: exists`);
    return found[0].id;
  }
  const bytes = await readFile(filepath);
  const { mime, ext } = sniffImage(bytes); // real type, not the .jpg in the filename
  const base = title.replace(/\.[^.]+$/, "");
  const form = new FormData();
  form.append("title", title); // properties BEFORE the file field (title = idempotent lookup key)
  form.append("file", new Blob([bytes], { type: mime }), `${base}.${ext}`);
  const res = await client.request(uploadFiles(form));
  console.log(`  ensure file ${title}: created (${mime})`);
  return res.id;
}

// Split a collection's field list into scalar fields and FK (m2o) fields so the
// orchestrator can create scalars before FKs before relations (Pitfall 3).
function partitionFields(def) {
  const scalar = [];
  const foreign = [];
  for (const f of def.fields) {
    if (f.field === "id") continue; // PK is created inline with the collection
    const special = (f.meta && f.meta.special) || [];
    if (special.includes("m2o")) foreign.push(f);
    else scalar.push(f);
  }
  return { scalar, foreign };
}

// ---------------------------------------------------------------------------
// PHASE A — schema. Order: all collections (+PKs) → all scalar fields →
// all FK fields → all relations. Plans 02/03 extend the smoke-tests; the
// generic ensure* feed-through is implemented here.
// ---------------------------------------------------------------------------

async function phaseA(client) {
  console.log("PHASE A: schema");
  for (const def of collections) await ensureCollection(client, def);
  for (const def of collections) {
    const { scalar } = partitionFields(def);
    for (const f of scalar) await ensureField(client, def.collection, f);
  }
  for (const def of collections) {
    const { foreign } = partitionFields(def);
    for (const f of foreign) await ensureField(client, def.collection, f);
  }
  for (const rel of relations) await ensureRelation(client, rel);
  // Flip price/stock to nullable in Directus metadata (on-request courses store NULL, not a false 0).
  // ensureField can't alter existing fields, so do it explicitly here. No-op once already nullable.
  await ensureNullable(client, "products", "base_price");
  await ensureNullable(client, "variants", "stock");
}

// ---------------------------------------------------------------------------
// PHASE B — raw SQL via pg. Reads the two versioned .sql files from disk (DDL
// stays in sql/*.sql, not inlined — PATTERNS data-vs-logic) and runs them in
// order: function+trigger first, then GIN index. pg reads PG* from env.
// ---------------------------------------------------------------------------

async function phaseB() {
  console.log("PHASE B: raw SQL (search_text trigger + GIN index + multi-tenant alters)");
  const triggerSql = await readFile(join(SQL_DIR, "01-search-text-trigger.sql"), "utf8");
  const indexSql = await readFile(join(SQL_DIR, "02-gin-index.sql"), "utf8");
  // Multi-tenant alters (base_price/stock → nullable). ensureField cannot alter existing columns.
  const multitenantSql = await readFile(join(SQL_DIR, "03-multitenant.sql"), "utf8");

  const pg = new PgClient(); // PGHOST/PGUSER/PGPASSWORD/PGDATABASE from env
  await pg.connect();
  try {
    // Static, idempotent DDL only — no string interpolation of data (ASVS V5/Tampering).
    await pg.query(triggerSql);
    console.log("  ran sql/01-search-text-trigger.sql");
    await pg.query(indexSql);
    console.log("  ran sql/02-gin-index.sql");
    await pg.query(multitenantSql);
    console.log("  ran sql/03-multitenant.sql");
  } finally {
    await pg.end();
  }
}

// ---------------------------------------------------------------------------
// PHASE C — seed. Order: file uploads → merchant → products → variants →
// images → ads. Uses ensureFile + upsertByKey. The detailed image/ads
// linked_product_id resolution and idempotency proof are exercised in plan 03;
// this plan implements the call structure against the generic helpers.
// ---------------------------------------------------------------------------

async function phaseC(client) {
  console.log("PHASE C: seed");

  // Iterate every tenant. Each merchant's products/variants/images carry that merchant's id so the
  // retrieval-api merchant filter isolates catalogs (no cross-tenant bleed).
  for (const tenant of tenants) {
    const { merchant, products, ads } = tenant;
    console.log(`  ── tenant: ${merchant.name} ──`);

    // 1. merchant (natural key: name) — incl. tenant-registry fields (inbox_ids, is_default).
    const merchantId = await upsertByKey(client, "merchants", "name", merchant.name, {
      name: merchant.name,
      inbox_ids: merchant.inbox_ids ?? [],
      is_default: merchant.is_default ?? false,
    });

    // 2. products + nested variants + images (natural keys: products.name, variants.sku).
    const productIdByName = {};
    for (const p of products) {
      const productId = await upsertByKey(client, "products", "name", p.name, {
        merchant_id: merchantId,
        name: p.name,
        category: p.category,
        description: p.description,
        base_price: p.base_price ?? null, // NULL = on request (anti-hallucination)
        currency: p.currency,
        status: p.status,
        // course-domain fields (null for product tenants like SIRINE)
        duration: p.duration ?? null,
        certification: p.certification ?? null,
        prerequisites: p.prerequisites ?? null,
        location: p.location ?? null,
      });
      productIdByName[p.name] = productId;

      for (const v of p.variants) {
        await upsertByKey(client, "variants", "sku", v.sku, {
          product_id: productId,
          merchant_id: merchantId, // denormalized tenant tag
          color: v.color,
          size: v.size,
          price: v.price ?? null,
          stock: v.stock ?? null,
          sku: v.sku,
        });
      }

      // images: upload the asset, then link via images.url = file UUID.
      // Composite natural key product_id + angle + url — asset files are SHARED across
      // products (same title → same file UUID via ensureFile), so url alone is NOT unique.
      // ai_description / attributes / tagged_at left unset (null until M5).
      for (const img of p.images) {
        const fileId = await ensureFile(client, img.file, join(ASSETS_DIR, img.file));
        const existing = await client.request(
          readItems("images", {
            filter: {
              product_id: { _eq: productId },
              angle: { _eq: img.angle },
              url: { _eq: fileId },
            },
            limit: 1,
            fields: ["id"],
          }),
        );
        const payload = { product_id: productId, merchant_id: merchantId, url: fileId, angle: img.angle };
        if (existing.length) {
          await client.request(updateItem("images", existing[0].id, payload));
          console.log(`  upsert images[${p.name}/${img.angle}]: updated`);
        } else {
          await client.request(createItem("images", payload, { fields: ["id"] }));
          console.log(`  upsert images[${p.name}/${img.angle}]: created`);
        }
      }
    }

    // 3. ads (natural key: ad_id) — resolve linked_product (name) → linked_product_id.
    for (const ad of ads) {
      await upsertByKey(client, "ads", "ad_id", ad.ad_id, {
        merchant_id: merchantId,
        ad_id: ad.ad_id,
        channel: ad.channel,
        status: ad.status,
        headline: ad.headline,
        body: ad.body,
        linked_product_id: productIdByName[ad.linked_product] ?? null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// main — runs A → B → C sequentially. Errors throw → non-zero exit (fail-fast).
// ---------------------------------------------------------------------------

async function main() {
  const client = makeClient();
  await login(client);
  await phaseA(client);
  await phaseB();
  await phaseC(client);
  console.log("seed: done");
}

main()
  .then(() => process.exit(0)) // belt-and-suspenders: force clean exit even if a handle lingers
  .catch((err) => {
    // Log the message only — never dump env/creds.
    console.error("seed: FAILED —", err.message);
    process.exit(1);
  });
