// api/inventory.js
// Rock Crest Inventory API — Vercel Serverless (Node 20)

// ===== Env =====
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";          // e.g. "2025-07"
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;                      // e.g. "cf3a53.myshopify.com"
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;                       // Admin API access token
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || "https://shop.rockcrestgardens.com"; // public storefront
// ALLOWED_ORIGIN can be "*" or a comma-separated list of origins (https://host)
// e.g. "https://www.rockcrestgardens.com,https://rockcrestgardens.com,https://rockcrestgardens.squarespace.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ===== Utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

function setCors(req, res) {
  const origin = req.headers.origin;

  // Reflect any origin when "*" (useful for testing)
  if (ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === "*") {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function fetchAllProducts({ fields = "id,title,handle,images,variants,product_type,tags", limit = 250 }) {
  let url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/products.json?limit=${limit}&fields=${encodeURIComponent(fields)}`;
  const items = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Accept": "application/json"
      }
    });

    // Rate-limited — back off and retry loop iteration without advancing page
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

function mapProductsToInventory(products) {
  const rows = [];
  for (const p of products) {
    const img = p.images?.[0]?.src || null;
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
        tags: p.tags || null,
        url: p.handle ? `${PUBLIC_STORE_DOMAIN}/products/${p.handle}` : null
      });
    }
  }
  return rows;
}

const filterInStock = (items) => items.filter(i => typeof i.quantity === "number" && i.quantity > 0);

// ===== Handler =====
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!STORE_DOMAIN || !ADMIN_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_TOKEN"
      });
    }

    // Query params
    const showOutOfStock = (req.query.showOutOfStock || "").toLowerCase() === "true";
    const productType = req.query.productType || null;
    const hasTag = req.query.tag || null;
    const minimal = (req.query.minimal || "").toLowerCase() === "true";

    // Cache at the edge for 30s, allow 2 min stale while revalidating
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    const products = await fetchAllProducts({});
    let items = mapProductsToInventory(products);

    if (productType) {
      const needle = productType.toLowerCase();
      items = items.filter(i => (i.productType || "").toLowerCase() === needle);
    }
    if (hasTag) {
      const t = hasTag.toLowerCase();
      items = items.filter(i => (i.tags || "").toLowerCase().split(", ").includes(t));
    }
    if (!showOutOfStock) items = filterInStock(items);

    if (minimal) {
      items = items.map(i => ({
        title: i.title,
        variant: i.variantTitle,
        sku: i.sku,
        qty: i.quantity,
        price: i.price,
        image: i.image,
        url: i.url
      }));
    }

    const generatedAt = new Date().toISOString();
res.setHeader("X-RC-Generated-At", generatedAt); // optional handy header
res.status(200).json({ ok: true, generatedAt, count: items.length, items });
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
}
