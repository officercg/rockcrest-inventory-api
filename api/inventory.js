// api/inventory.js
// GraphQL Admin — returns rows: title, commonName, plantCaliper, sku, price, qty, url
// Default: NO tag exclusion (so list always loads).
// Optional: ?exclude=blue,clearance   (case-insensitive substring match on tags)

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;            // e.g. "cf3a53.myshopify.com"
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;             // Admin API access token
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || "https://shop.rockcrestgardens.com";

// CORS (comma-separated list or "*")
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Metafield mapping (defaults match your Shopify setup)
const META_NAMESPACE   = process.env.META_NAMESPACE  || "custom";
const KEY_COMMON_NAME  = process.env.KEY_COMMON_NAME || "common_name";
const KEY_CALIPER      = process.env.KEY_CALIPER     || "plant_caliper";

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

async function gqlFetch(query, variables) {
  while (true) {
    const res = await fetch(`https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN
      },
      body: JSON.stringify({ query, variables })
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") || "2");
      await sleep(Math.min(retryAfter, 5) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GraphQL ${res.status} ${res.statusText}: ${text || "request failed"}`);
    }

    const data = await res.json();
    if (data.errors) throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    return data.data;
  }
}

/**
 * We fetch:
 * - product fields
 * - product metafield common_name
 * - product + variant metafield plant_caliper (variant wins)
 * - first 100 variants per product
 */
const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String, $ns: String!, $keyCommon: String!, $keyCaliper: String!) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          title
          handle
          tags
          images(first: 1) { edges { node { url: originalSrc } } }
          common: metafield(namespace: $ns, key: $keyCommon) { value }
          caliperProduct: metafield(namespace: $ns, key: $keyCaliper) { value type }
          variants(first: 100) {
            edges {
              node {
                sku
                price
                inventoryQuantity
                caliperVariant: metafield(namespace: $ns, key: $keyCaliper) { value type }
              }
            }
          }
        }
      }
    }
  }
`;

// Map Shopify unit enums to concise labels for dimension JSON
const UNIT_MAP = {
  MILLIMETERS: "mm",
  CENTIMETERS: "cm",
  METERS: "m",
  INCHES: "in",
  FEET: "ft",
  YARDS: "yd"
};

// Normalize dimension metafields ("{\"value\":4.0,\"unit\":\"INCHES\"}") => "4 in"
function normalizeDimension(mf) {
  if (!mf || mf.value == null) return null;
  const raw = String(mf.value).trim();

  if ((mf.type || "").toLowerCase().includes("dimension")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.value != null) {
        const unit = UNIT_MAP[(parsed.unit || "").toUpperCase()] || (parsed.unit || "").toLowerCase();
        return unit ? `${parsed.value} ${unit}` : String(parsed.value);
      }
    } catch {
      // if value wasn't JSON, fall through
    }
  }
  return raw || null;
}

function pickCaliper(productMF, variantMF) {
  const v = normalizeDimension(variantMF);
  if (v) return v;
  const p = normalizeDimension(productMF);
  if (p) return p;
  return null;
}

async function fetchAllProducts(ns, keyCommon, keyCaliper) {
  let after = null;
  const first = 100;
  const out = [];
  while (true) {
    const data = await gqlFetch(PRODUCTS_QUERY, { first, after, ns, keyCommon, keyCaliper });
    const edges = data?.products?.edges || [];
    for (const e of edges) out.push(e.node);
    const hasNext = data?.products?.pageInfo?.hasNextPage;
    if (!hasNext || edges.length === 0) break;
    after = edges[edges.length - 1].cursor;
  }
  return out;
}

function shouldExcludeByTags(tags, excludeList) {
  if (!excludeList.length) return false;
  const lower = (tags || []).map(t => (t || "").toLowerCase());
  return excludeList.some(sub => lower.some(t => t.includes(sub)));
}

function mapToRows(products, excludeList) {
  const rows = [];
  for (const p of products) {
    if (shouldExcludeByTags(p.tags, excludeList)) continue;

    const img = p.images?.edges?.[0]?.node?.url || null;
    const commonName = p.common?.value || null;

    const vs = p.variants?.edges || [];
    for (const ve of vs) {
      const v = ve.node;
      const plantCaliper = pickCaliper(p.caliperProduct, v.caliperVariant);

      rows.push({
        title: p.title,
        commonName,
        plantCaliper,
        sku: v.sku || null,
        price: v.price != null ? String(v.price) : null,
        qty: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
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

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    // Optional tag exclusions: ?exclude=blue,clearance
    const exclude = String(req.query.exclude || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const products = await fetchAllProducts(META_NAMESPACE, KEY_COMMON_NAME, KEY_CALIPER);
    const items = mapToRows(products, exclude);

    const generatedAt = new Date().toISOString();
    res.setHeader("X-RC-Generated-At", generatedAt);

    return res.status(200).json({ ok: true, generatedAt, count: items.length, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
}
