// Serverless function for Vercel (Node 20)
// Fetches product + variant inventory from Shopify Admin REST API
// Normalizes metafields (height, caliper) into human-readable strings.

const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "rockcrest.myshopify.com"
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse Link header for REST cursor pagination
function parseLinkHeader(linkHeader) {
  if (!linkHeader) return {};
  const parts = linkHeader.split(",");
  const links = {};
  for (const part of parts) {
    const section = part.split(";");
    if (section.length < 2) continue;
    const url = section[0].trim().replace(/^<|>$/g, "");
    const rel = section[1].trim().replace(/rel="(.+?)"/, "$1");
    links[rel] = url;
  }
  return links;
}

// Fetch all products (REST)
async function fetchAllProducts({ fields = "id,title,handle,variants,product_type,tags,images,metafields", limit = 250 }) {
  let url = `https://${STORE_DOMAIN}/admin/api/${DEFAULT_API_VERSION}/products.json?limit=${limit}&fields=${encodeURIComponent(fields)}&expand=metafields`;
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
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Shopify error ${res.status}: ${text || res.statusText}`);
    }

    const data = await res.json();
    items.push(...(data.products || []));
    const links = parseLinkHeader(res.headers.get("link"));
    url = links.next || null;
  }

  return items;
}

// Normalize metafield object into string (e.g. "4 INCHES")
function normalizeMetaField(mf) {
  if (!mf) return null;
  if (typeof mf === "string") return mf;
  if (typeof mf === "object") {
    const v = mf.value ?? mf.amount ?? "";
    const u = mf.unit ?? "";
    return `${v} ${u}`.trim();
  }
  return null;
}

// Map products/variants
function mapProductsToInventory(products) {
  const rows = [];
  for (const p of products) {
    const img = (p.images && p.images[0] && p.images[0].src) ? p.images[0].src : null;

    for (const v of (p.variants || [])) {
      // Grab metafields (height, caliper, etc.)
      const meta = v.metafields?.custom || {};

      rows.push({
        productId: String(p.id),
        variantId: String(v.id),
        title: p.title,
        handle: p.handle,
        cultivar: v.title === "Default Title" ? null : v.title,
        sku: v.sku || v.title || null,
        price: v.price != null ? String(v.price) : null,
        quantity: typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
        image: img,
        productType: p.product_type || null,
        tags: p.tags || null,
        plantHeight: normalizeMetaField(meta.plant_height),
        plantCaliper: normalizeMetaField(meta.plant_caliper),
        pottingType: normalizeMetaField(meta.potting_type),
        containerSize: normalizeMetaField(meta.container_size),
        url: p.handle ? `https://${STORE_DOMAIN}/products/${p.handle}` : null
      });
    }
  }
  return rows;
}

// Filters
function filterInStock(items) {
  return items.filter(i => typeof i.quantity === "number" && i.quantity > 0);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Handler
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

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

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    const products = await fetchAllProducts({});
    let items = mapProductsToInventory(products);

    if (productType) items = items.filter(i => (i.productType || "").toLowerCase() === productType.toLowerCase());
    if (hasTag) items = items.filter(i => (i.tags || "").toLowerCase().split(", ").includes(hasTag.toLowerCase()));

    if (!showOutOfStock) items = filterInStock(items);

    const minimal = (req.query.minimal || "").toLowerCase() === "true";
    if (minimal) {
      items = items.map(i => ({
        title: i.title,
        cultivar: i.cultivar,
        sku: i.sku,
        qty: i.quantity,
        price: i.price,
        plantHeight: i.plantHeight,
        plantCaliper: i.plantCaliper,
        url: i.url
      }));
    }

    res.status(200).json({ ok: true, count: items.length, generatedAt: new Date().toISOString(), items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
}
