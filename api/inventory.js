// api/inventory.js
// Rock Crest Inventory API — GraphQL Admin, fast and exact metafields.
// Returns: title, commonName, plantCaliper, sku, price, qty, url
// Excludes any product with a tag containing "blue" (case-insensitive)

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
const META_NAMESPACE   = (process.env.META_NAMESPACE || "custom");
const KEY_COMMON_NAME  = (process.env.KEY_COMMON_NAME || "common_name");
const KEY_CALIPER      = (process.env.KEY_CALIPER || "plant_caliper");

// Exclude products whose tags contain this substring (case-insensitive)
const EXCLUDE_TAG_SUBSTR = "blue";

// ---------- helpers ----------
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

    if (res.status === 429) { // backoff on rate limit
      const retryAfter = Number(res.headers.get("Retry-After") || "2");
      await sleep(Math.min(retryAfter, 5) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GraphQL ${res.status} ${res.statusText}: ${text || "request failed"}`);
    }

    const data = await res.json();
    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    return data.data;
  }
}

const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String, $ns: String!, $keyCommon: String!, $keyCaliper: String!) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          title
          handle
          tags
          images(first: 1) { edges { node { url: originalSrc } } }
          variants(first: 100) {
            edges {
              node {
                id
                sku
                price
                inventoryQuantity
              }
            }
          }
          common: metafield(namespace: $ns, key: $keyCommon) { value }
          caliper: metafield(namespace: $ns, key: $keyCaliper) { value }
        }
      }
    }
  }
`;

function hasExcludedTag(tags) {
  if (!tags || !tags.length) return false;
  const ex = EXCLUDE_TAG_SUBSTR.toLowerCase();
  return tags.some(t => (t || "").toLowerCase().includes(ex));
}

async function fetchAllProductPages() {
  let after = null;
  const first = 100;
  const out = [];

  while (true) {
    const data = await gqlFetch(PRODUCTS_QUERY, {
      first,
      after,
      ns: META_NAMESPACE,
      keyCommon: KEY_COMMON_NAME,
      keyCaliper: KEY_CALIPER
    });

    const edges = data?.products?.edges || [];
    for (const edge of edges) {
      out.push(edge.node);
    }

    const hasNext = data?.products?.pageInfo?.hasNextPage;
    if (!hasNext || edges.length === 0) break;
    after = edges[edges.length - 1].cursor;
  }

  return out;
}

function mapToRows(products) {
  const rows = [];
  for (const p of products) {
    if (hasExcludedTag(p.tags)) continue;

    const img = p.images?.edges?.[0]?.node?.url || null;
    const commonName = p.common?.value || null;
    const plantCaliper = p.caliper?.value || null;

    const variants = p.variants?.edges || [];
    for (const ve of variants) {
      const v = ve.node;
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

// ---------- handler ----------
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!STORE_DOMAIN || !ADMIN_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing env vars: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_TOKEN" });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    const products = await fetchAllProductPages();
    const items = mapToRows(products);

    const generatedAt = new Date().toISOString();
    res.setHeader("X-RC-Generated-At", generatedAt);

    return res.status(200).json({ ok: true, generatedAt, count: items.length, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
}
