// api/inventory.js
// Rock Crest Inventory API — includes Shopify product metafields:
// commonName, sunRequirement, growthRate, plantCaliper

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
const META_NAMESPACE = process.env.META_NAMESPACE || "custom";
const KEY_COMMON_NAME = process.env.KEY_COMMON_NAME || "common_name";
const KEY_SUN = process.env.KEY_SUN || "sun_requirement";
const KEY_GROWTH = process.env.KEY_GROWTH || "growth_rate";
const KEY_CALIPER = process.env.KEY_CALIPER || "plant_caliper";

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

// Pull all products with REST pagination
async function fetchAllProducts({ fields = "id,title,handle,images,variants,product_type,tags", limit = 250 } = {}) {
  let url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/products.json?limit=${limit}&fields=${encodeURIComponent(fields)}`;
  const items = [];
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
      throw new Error(`Shopify ${res.status} ${res.statusText}: ${text || "request failed"}`);
    }

    const data = await res.json();
    items.push(...(data.products || []));

    const links = parseLinkHeader(res.headers.get("link"));
    url = links.next || null;
  }
  return items;
}

// Fetch metafields for a single product
async function fetchProductMetafields(productId) {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/products/${productId}/metafields.json`;
  while (true) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Accept": "application/json"
      }
    });
    if (res.status === 429) { await sleep(1500); continue; }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Metafields ${res.status}: ${text || res.statusText}`);
    }
    const data = await res.json();
    return data.metafields || [];
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchMetafieldsForProducts(products, { concurrency = 4 } = {}) {
  const map = new Map(); // productId -> {commonName, sunRequirement, growthRate, plantCaliper}
  const ids = products.map(p => String(p.id));
  const groups = chunk(ids, concurrency);

  for (const group of groups) {
    await Promise.all(group.map(async (pid) => {
      try {
        const mfs = await fetchProductMetafields(pid);
        let commonName = null, sunRequirement = null, growthRate = null, plantCaliper = null;

        for (const mf of mfs) {
          if (mf.namespace !== META_NAMESPACE) continue;
          const key = (mf.key || "").toLowerCase();
          if (key === KEY_COMMON_NAME.toLowerCase()) commonName = mf.value || null;
          else if (key === KEY_SUN.toLowerCase()) sunRequirement = mf.value || null;
          else if (key === KEY_GROWTH.toLowerCase()) growthRate = mf.value || null;
          else if (key === KEY_CALIPER.toLowerCase()) plantCaliper = mf.value || null;
        }
        map.set(pid, { commonName, sunRequirement, growthRate, plantCaliper });
      } catch (e) {
        console.error(`Metafields error for product ${pid}:`, e.message);
        map.set(pid, { commonName: null, sunRequirement: null, growthRate: null, plantCaliper: null });
      }
    }));
    await sleep(200); // small delay between batches
  }
  return map;
}

function mapProductsToInventory(products, metaMap) {
  const rows = [];
  for (const p of products) {
    const img = p.images?.[0]?.src || null;
    const tagArray = (p.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const meta = metaMap.get(String(p.id)) || {};
    for (const v of (p.variants || [])) {
      rows.push({
        productId: String(p.id),
        variantId: String(v.id),
        title: p.title,
        handle: p.handle,
        variantTitle: v.title === "Default Title" ? null : v.title,
        sku: v.sku || null,
        price: v.price != null ? String(v.price) : null,
        quantity: typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
        image: img,
        productType: p.product_type || null,
        tags: tagArray,
        url: p.handle ? `${PUBLIC_STORE_DOMAIN}/products/${p.handle}` : null,
        // metafields:
        commonName: meta.commonName || null,
        sunRequirement: meta.sunRequirement || null,
        growthRate: meta.growthRate || null,
        plantCaliper: meta.plantCaliper || null
      });
    }
  }
  return rows;
}

const filterInStock = (items) => items.filter(i => typeof i.quantity === "number" && i.quantity > 0);

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!STORE_DOMAIN || !ADMIN_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing env vars: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_TOKEN" });
    }

    const showOutOfStock = (req.query.showOutOfStock || "").toLowerCase() === "true";
    const productType = req.query.productType || null;
    const singleTag = req.query.tag || null; // exact tag (case-insensitive)
    const minimal = (req.query.minimal || "").toLowerCase() === "true";

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    // 1) products
    const products = await fetchAllProducts({});
    // 2) metafields
    const metaMap = await fetchMetafieldsForProducts(products, { concurrency: 4 });
    // 3) flatten rows
    let items = mapProductsToInventory(products, metaMap);

    if (productType) {
      const needle = productType.toLowerCase();
      items = items.filter(i => (i.productType || "").toLowerCase() === needle);
    }
    if (singleTag) {
      const t = singleTag.toLowerCase();
      items = items.filter(i => (i.tags || []).some(tag => tag.toLowerCase() === t));
    }
    if (!showOutOfStock) items = filterInStock(items);

    const generatedAt = new Date().toISOString();
    res.setHeader("X-RC-Generated-At", generatedAt);

    if (minimal) {
      const compact = items.map(i => ({
        title: i.title,
        variant: i.variantTitle,
        sku: i.sku,
        qty: i.quantity,
        price: i.price,
        image: i.image,
        url: i.url,
        tags: i.tags,
        commonName: i.commonName,
        sunRequirement: i.sunRequirement,
        growthRate: i.growthRate,
        plantCaliper: i.plantCaliper
      }));
      return res.status(200).json({ ok: true, generatedAt, count: compact.length, items: compact });
    }

    return res.status(200).json({ ok: true, generatedAt, count: items.length, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
}
