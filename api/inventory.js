// api/inventory.js
// Rock Crest Inventory API — bulk metafields with smart matching + optional debug
// Columns returned: title, commonName, plantCaliper, sku, price, qty, url
// Server-side exclusion: any product with a tag containing "blue" (case-insensitive)

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;            // e.g. "cf3a53.myshopify.com"
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;             // Admin API token
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || "https://shop.rockcrestgardens.com";

// CORS (comma-separated list or "*")
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Metafield mapping (defaults match your Shopify Liquid)
const META_NAMESPACE   = process.env.META_NAMESPACE   || "custom";
const KEY_COMMON_NAME  = process.env.KEY_COMMON_NAME  || "common_name";
const KEY_CALIPER      = process.env.KEY_CALIPER      || "plant_caliper";

// Exclude products whose tags contain this substring (case-insensitive)
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

// Build per-product metafield map with smart matching:
// 1) Prefer exact namespace+key matches (custom.common_name, custom.plant_caliper)
// 2) If missing, fall back to any namespace where key matches (common_name / plant_caliper)
function buildMetaMap(allMetafields) {
  const WANT_KEYS_LO = new Set([
    KEY_COMMON_NAME.toLowerCase(),
    KEY_CALIPER.toLowerCase()
  ]);

  const preferredNs = META_NAMESPACE.toLowerCase();

  // First pass: collect candidates per product id
  const byProduct = new Map(); // pid -> { candidates: {key:[{ns,key,value}, ...]} }
  for (const mf of allMetafields) {
    if (!mf || mf.owner_resource !== "product") continue;
    const pid = String(mf.owner_id || "");
    if (!pid) continue;

    const ns = (mf.namespace || "").toLowerCase();
    const key = (mf.key || "").toLowerCase();
    if (!WANT_KEYS_LO.has(key)) continue; // ignore other keys

    const entry = byProduct.get(pid) || { candidates: {} };
    if (!entry.candidates[key]) entry.candidates[key] = [];
    entry.candidates[key].push({ ns, key, value: mf.value ?? null });
    byProduct.set(pid, entry);
  }

  // Second pass: choose best candidate per key (prefer preferredNs)
  const out = new Map(); // pid -> { commonName, plantCaliper }
  for (const [pid, { candidates }] of byProduct.entries()) {
    let commonName = null, plantCaliper = null;

    const choose = (k) => {
      const list = candidates[k] || [];
      if (!list.length) return null;
      const exact = list.find(x => x.ns === preferredNs);
      return (exact ? exact.value : list[0].value) ?? null;
    };

    commonName = choose(KEY_COMMON_NAME.toLowerCase());
    plantCaliper = choose(KEY_CALIPER.toLowerCase());

    out.set(pid, { commonName, plantCaliper });
  }

  return out;
}

function productHasExcludedTag(p) {
  if (!p || !p.tags) return false;
  const ex = EXCLUDE_TAG_SUBSTR.toLowerCase();
  return p.tags.split(",").some(t => t.trim().toLowerCase().includes(ex));
}

function mapProductsToRows(products, metaMap) {
  const rows = [];
  for (const p of products) {
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
        image: img
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

    // Debug: /api/inventory?debugMeta=1&limit=1
    const debugMeta = String(req.query.debugMeta || "").toLowerCase() === "1";
    const limit = Math.max(0, parseInt(String(req.query.limit || "0"), 10) || 0);

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    // 1) products
    let products = await fetchAllProducts();
    if (limit > 0) products = products.slice(0, limit);

    // 2) metafields (bulk)
    const allMetafields = await fetchAllProductMetafields();

    if (debugMeta) {
      // Show a summary so we can confirm namespace/keys coming back from Shopify
      const sample = allMetafields.slice(0, 50).map(mf => ({
        owner_id: mf.owner_id,
        owner_resource: mf.owner_resource,
        namespace: mf.namespace,
        key: mf.key,
        value_preview: typeof mf.value === "string" ? mf.value.slice(0, 40) : mf.value
      }));
      return res.status(200).json({ ok: true, note: "debugMeta sample", count: sample.length, sample });
    }

    // 3) map metafields -> product
    const metaMap = buildMetaMap(allMetafields);

    // 4) flatten rows (include all inventory; qty may be 0)
    const items = mapProductsToRows(products, metaMap);

    const generatedAt = new Date().toISOString();
    res.setHeader("X-RC-Generated-At", generatedAt);

    return res.status(200).json({ ok: true, generatedAt, count: items.length, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
}
