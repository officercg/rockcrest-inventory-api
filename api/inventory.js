// api/inventory.js
// Rock Crest Inventory API — minimal fast payload with metafields + "Blue" tag exclusion.

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;            // e.g. "cf3a53.myshopify.com"
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;             // Admin API token
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || "https://shop.rockcrestgardens.com";

// CORS (comma-separated list or "*")
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Metafield mapping (defaults match your Shopify Liquid snippet)
const META_NAMESPACE   = process.env.META_NAMESPACE   || "custom";
const KEY_COMMON_NAME  = process.env.KEY_COMMON_NAME  || "common_name";
const KEY_CALIPER      = process.env.KEY_CALIPER      || "plant_caliper";

// Hardcoded server-side exclusion: any tag containing this substring (case-insensitive)
const EXCLUDE_TAG_SUBSTR = "blue";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === "*") {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseLinkHeader(linkHeader) {
  if (!linkHeader) return {};
  const links = {};
  for (const part of linkHeader.split(",")) {
    const [rawUrl, rawRel] = part.split(";");
    if (!rawUrl || !rawRel) continue;
    const url = rawUrl.trim().replace(/^<|>$/g, "");
    const rel = (rawRel.match(/rel="(.+?)"/) || [])[1];
    if (rel) links[rel] = url;
  }
  return links;
}

async function fetchPagedJson(url) {
  const out = [];
  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Accept": "application/json"
      }
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") || "2");
      await sleep(Math.min(retryAfter, 5) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${url} -> ${res.status} ${res.statusText}: ${text || "request failed"}`);
    }

    const data = await res.json();
    if (data.products) out.push(...data.products);
    else if (data.metafields) out.push(...data.metafields);
    else out.push(data);

    const links = parseLinkHeader(res.headers.get("link"));
    url = links.next || null;
  }
  return out;
}

async function fetchAllProducts() {
  const fields = "id,title,handle,images,variants,product_type,tags";
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/products.json?limit=250&fields=${encodeURIComponent(fields)}`;
  return fetchPagedJson(url);
}

// Bulk fetch ALL product metafields (owner_resource=product)
async function fetchAllProductMetafields() {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/metafields.json?limit=250&metafield[owner_resource]=product`;
  return fetchPagedJson(url);
}

function buildMetaMap(allMetafields) {
  // Only keep the ones we care about; group by product owner_id
  const wanted = new Set([
    `${META_NAMESPACE}:${KEY_COMMON_NAME}`.toLowerCase(),
    `${META_NAMESPACE}:${KEY_CALIPER}`.toLowerCase(),
  ]);
  const map = new Map(); // productId -> { commonName, plantCaliper }

  for (const mf of allMetafields) {
    if (!mf || mf.owner_resource !== "product") continue;
    const keySig = `${(mf.namespace || "").toLowerCase()}:${(mf.key || "").toLowerCase()}`;
    if (!wanted.has(keySig)) continue;

    const pid = String(mf.owner_id);
    const cur = map.get(pid) || { commonName: null, plantCaliper: null };

    if (mf.key.toLowerCase() === KEY_COMMON_NAME.toLowerCase()) cur.commonName = mf.value || null;
    if (mf.key.toLowerCase() === KEY_CALIPER.toLowerCase())     cur.plantCaliper = mf.value || null;

    map.set(pid, cur);
  }
  return map;
}

function productHasExcludedTag(p) {
  if (!p || !p.tags) return false;
  const ex = EXCLUDE_TAG_SUBSTR.toLowerCase();
  // Shopify product.tags is a comma-separated string
  return p.tags.split(",").some(t => t.trim().toLowerCase().includes(ex));
}

function mapProductsToRows(products, metaMap) {
  const rows = [];
  for (const p of products) {
    // Server-side exclusion by tag substring "blue"
    if (productHasExcludedTag(p)) continue;

    const img = p.images?.[0]?.src || null;
    const meta = metaMap.get(String(p.id)) || {};

    for (const v of (p.variants || [])) {
      rows.push({
        title: p.title,
        commonName: meta.commonName || null,
        plantCaliper: meta.plantCaliper || null,
        sku: v.sku || null,
        price: v.price != null ? String(v.price) : null,
        qty: typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
        url: p.handle ? `${PUBLIC_STORE_DOMAIN}/products/${p.handle}` : null,
        image: img,
      });
    }
  }
  return rows;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!STORE_DOMAIN || !ADMIN_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing env vars: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_TOKEN" });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    // 1) products (paged)
    const products = await fetchAllProducts();

    // 2) metafields (paged, bulk) -> map by product
    const allMetafields = await fetchAllProductMetafields();
    const metaMap = buildMetaMap(allMetafields);

    // 3) flatten rows (no out-of-stock filter; includes qty 0)
    const items = mapProductsToRows(products, metaMap);

    const generatedAt = new Date().toISOString();
    res.setHeader("X-RC-Generated-At", generatedAt);

    // Always return the compact/minimal shape your Squarespace expects
    return res.status(200).json({
      ok: true,
      generatedAt,
      count: items.length,
      items
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
}
