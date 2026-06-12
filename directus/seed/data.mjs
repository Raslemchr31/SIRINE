// data.mjs — PURE DATA. Seed rows for the REAL SIRINE catalog.
// Source: .planning/research/sirine-catalog.json (scraped from https://sirinealgeria.com/).
// No @directus/sdk imports, no logic. bootstrap.mjs (PHASE C) resolves the nested
// shape into idempotent upserts keyed on natural keys.
//
// HARD CONTRACTS:
//   - base_price / variants.price / variants.stock are WHOLE INTEGERS (DZD). No decimals.
//   - Natural keys: merchant.name, products.name, variants.sku (unique), ads.ad_id (unique).
//   - ads AD_TEST_001 / AD_TEST_002 / AD_TEST_003 are a STABLE CONTRACT (M2+ simulators
//     reference these ids). Each links to a product by name (linked_product → linked_product_id
//     resolved at seed time by bootstrap). Real ad: channel facebook → "messenger" (the Meta
//     messaging surface the bot owns; enum is whatsapp|messenger|instagram).
//   - images reference an asset filename in ./assets/ (real downloaded SIRINE images).
//   - images.ai_description / attributes / tagged_at are LEFT UNSET (null until M5).
//   - stock values are DEMO integers (live stock drifts; reconciled at M7 live-edit).

// SIRINE merchant — tenant #1, and the DEFAULT tenant: any Chatwoot inbox NOT explicitly mapped to
// another tenant resolves to SIRINE. This keeps the live SIRINE bot green regardless of its exact
// inbox id. inbox_ids may stay empty while SIRINE is the default; populate to be explicit if desired.
export const merchant = {
  name: "SIRINE Algeria",
  inbox_ids: [], // SIRINE is is_default → unmapped inboxes fall back here anyway
  is_default: true,
};

// Real SIRINE products (8). category ∈ shoes|bags|accessories|packs. Prices are integer DZD
// (live values from products.json; compare-at discounts stripped).
export const products = [
  {
    name: "Basket Signature",
    category: "shoes",
    description:
      "Signature sneaker boot (basket) by SIRINE. Women's sizes 35-40, made in Tlemcen.",
    base_price: 1150,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "BASKET-SIGNATURE-BLACK", color: "Black", size: "35-40", price: 1150, stock: 10 },
      { sku: "BASKET-SIGNATURE-PINK", color: "Pastel Pink", size: "35-40", price: 1150, stock: 8 },
      { sku: "BASKET-SIGNATURE-BEIGE", color: "Beige", size: "35-40", price: 1150, stock: 6 },
      { sku: "BASKET-SIGNATURE-BROWN", color: "Brown", size: "35-40", price: 1150, stock: 4 },
    ],
    images: [
      { file: "basket-signature.jpg", angle: "front" },
      { file: "sabot-femme.jpg", angle: "side" },
    ],
  },
  {
    name: "Sabot Femme",
    category: "shoes",
    description: "Women's sabot / clog by SIRINE. Single option, made in Tlemcen.",
    base_price: 1990,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "SABOT-FEMME-DEFAULT", color: "Default", size: "37-41", price: 1990, stock: 12 },
    ],
    images: [
      { file: "sabot-femme.jpg", angle: "front" },
      { file: "basket-signature.jpg", angle: "side" },
    ],
  },
  {
    name: "Sac selle petit",
    category: "bags",
    description: "Small saddle bag (sac selle) by SIRINE. Four colors.",
    base_price: 1500,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "SAC-SELLE-PETIT-BLACK", color: "Black", size: "", price: 1500, stock: 9 },
      { sku: "SAC-SELLE-PETIT-BROWN", color: "Brown", size: "", price: 1500, stock: 7 },
      { sku: "SAC-SELLE-PETIT-BEIGE", color: "Beige", size: "", price: 1500, stock: 5 },
      { sku: "SAC-SELLE-PETIT-PINK", color: "Pink", size: "", price: 1500, stock: 5 },
    ],
    images: [
      { file: "sac-selle.jpg", angle: "front" },
      { file: "sac-signature.jpg", angle: "detail" },
    ],
  },
  {
    name: "Sac selle grand",
    category: "bags",
    description: "Large saddle bag (sac selle) by SIRINE. Four colors.",
    base_price: 1800,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "SAC-SELLE-GRAND-PINK", color: "Pink", size: "", price: 1800, stock: 6 },
      { sku: "SAC-SELLE-GRAND-BLACK", color: "Black", size: "", price: 1800, stock: 6 },
      { sku: "SAC-SELLE-GRAND-BROWN", color: "Brown", size: "", price: 1800, stock: 4 },
      { sku: "SAC-SELLE-GRAND-BEIGE", color: "Beige", size: "", price: 1800, stock: 3 },
    ],
    images: [
      { file: "sac-selle.jpg", angle: "front" },
      { file: "sac-signature.jpg", angle: "detail" },
    ],
  },
  {
    name: "Sac Signature SIRINE",
    category: "bags",
    description: "Signature handbag by SIRINE. Four colors. Frequently out of stock.",
    base_price: 3600,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "SAC-SIGNATURE-BLACK", color: "Black", size: "", price: 3600, stock: 4 },
      { sku: "SAC-SIGNATURE-BROWN", color: "Brown", size: "", price: 3600, stock: 3 },
      { sku: "SAC-SIGNATURE-PINK", color: "Pink", size: "", price: 3600, stock: 2 },
      { sku: "SAC-SIGNATURE-BEIGE", color: "Beige", size: "", price: 3600, stock: 2 },
    ],
    images: [
      { file: "sac-signature.jpg", angle: "front" },
      { file: "sac-selle.jpg", angle: "detail" },
    ],
  },
  {
    name: "Sac Nihel Croco",
    category: "bags",
    description: "Croco-textured handbag (Sac Nihel) by SIRINE. Four colors.",
    base_price: 2500,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "SAC-NIHEL-CROCO-BEIGE", color: "Beige", size: "", price: 2500, stock: 5 },
      { sku: "SAC-NIHEL-CROCO-BLACK", color: "Black", size: "", price: 2500, stock: 5 },
      { sku: "SAC-NIHEL-CROCO-PINK", color: "Pastel Pink", size: "", price: 2500, stock: 3 },
      { sku: "SAC-NIHEL-CROCO-BROWN", color: "Brown", size: "", price: 2500, stock: 3 },
    ],
    images: [
      { file: "sac-signature.jpg", angle: "front" },
      { file: "sac-selle.jpg", angle: "detail" },
    ],
  },
  {
    name: "Golden Pack Sirine",
    category: "packs",
    description:
      "Signature bundle (Golden Pack): SIRINE bag + footwear set. Sizes 36-40, made in Tlemcen.",
    base_price: 5800,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "GOLDEN-PACK-CARAMEL", color: "Caramel", size: "36-40", price: 5800, stock: 4 },
      { sku: "GOLDEN-PACK-PINK", color: "Pink", size: "36-40", price: 5800, stock: 3 },
      { sku: "GOLDEN-PACK-TIFFANY", color: "Tiffany Green", size: "36-40", price: 5800, stock: 3 },
      { sku: "GOLDEN-PACK-GRAY", color: "Gray", size: "36-40", price: 5800, stock: 2 },
      { sku: "GOLDEN-PACK-MILITARY", color: "Military Green", size: "36-40", price: 5800, stock: 2 },
      { sku: "GOLDEN-PACK-WHITE", color: "White", size: "36-40", price: 5800, stock: 2 },
    ],
    images: [
      { file: "golden-pack.jpg", angle: "front" },
      { file: "basket-signature.jpg", angle: "side" },
    ],
  },
  {
    name: "Pack mulle 2026",
    category: "packs",
    description: "2026 mule pack (bag + mules) by SIRINE. Sizes 37-41, four colors.",
    base_price: 3990,
    currency: "DZD",
    status: "active",
    variants: [
      { sku: "PACK-MULLE-2026-C1", color: "Color 1", size: "37-41", price: 3990, stock: 5 },
      { sku: "PACK-MULLE-2026-C2", color: "Color 2", size: "37-41", price: 3990, stock: 4 },
      { sku: "PACK-MULLE-2026-C3", color: "Color 3", size: "37-41", price: 3990, stock: 3 },
      { sku: "PACK-MULLE-2026-C4", color: "Color 4", size: "37-41", price: 3990, stock: 2 },
    ],
    images: [
      { file: "golden-pack.jpg", angle: "front" },
      { file: "sabot-femme.jpg", angle: "side" },
    ],
  },
];

// Exactly 3 ads — ad_id values are the stable contract. linked_product is a product NAME;
// bootstrap resolves it to linked_product_id at seed time. channel ∈ whatsapp|messenger|instagram
// (real facebook ad maps to "messenger", the Meta messaging surface).
export const ads = [
  {
    ad_id: "AD_TEST_001",
    channel: "instagram",
    status: "active",
    headline: "Basket Signature SIRINE — l'élégance algérienne à tes pieds",
    body: "Sneakers signature SIRINE à seulement 1150 DA. Dispo en noir, beige, rose et marron, pointures 35-40. Livraison 58 wilayas, paiement à la livraison. Écris-nous pour commander!",
    linked_product: "Basket Signature",
  },
  {
    ad_id: "AD_TEST_002",
    channel: "messenger",
    status: "active",
    headline: "Golden Pack SIRINE — Sac + Chaussure, l'offre signature",
    body: "Le Golden Pack SIRINE à 5800 DA. Plusieurs couleurs, pointures 36-40, fabrication 100% algérienne à Tlemcen. Stock limité — commande maintenant en message!",
    linked_product: "Golden Pack Sirine",
  },
  {
    ad_id: "AD_TEST_003",
    channel: "whatsapp",
    status: "active",
    headline: "Sac Signature SIRINE — commande sur WhatsApp",
    body: "Sac Signature SIRINE à 3600 DA, dispo en noir, marron, beige et rose. Paiement à la livraison partout en Algérie. Écris-nous pour réserver le tien.",
    linked_product: "Sac Signature SIRINE",
  },
];

// ---------------------------------------------------------------------------
// Tenant seed manifest. bootstrap.mjs PHASE C iterates this array, seeding each merchant and
// tagging its products/variants/images with that merchant's id. Single tenant: SIRINE (default).
// ---------------------------------------------------------------------------
export const tenants = [{ merchant, products, ads }];
