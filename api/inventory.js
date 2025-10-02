// api/inventory.js — GraphQL (reads VARIANT metafields) + minimal mode + edge cache
// - Pulls variant.metafields.custom.plant_height & .plant_caliper
// - Blue filtering ONLY by product metafields (no tag fallback)
// - CORS via ALLOWED_ORIGIN
// - Supports ?minimal=1 & ?showOutOfStock=1

const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. rockcrest.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function unitAbbrev(u) {
  if (!u) return "";
  const s = String(u).toLowerCase();
  if (["inches","inch","in"].includes(s)) return "in";
  if (["feet","foot","ft"].includes(s)) return "ft";
  if (["centimeters","centimeter","cm"].includes(s)) return "cm";
  if (["meters","meter","m"].includes(s)) return "m";
  return s;
}

// Handles GraphQL metafield.value that might be JSON or plain text
function normalizeMeasure(raw, defaultUnit = "in") {
  if (raw == null || raw === "") return null;
  // Try JSON {"value":4,"unit":"INCHES"}
  if (typeof raw === "string") {
    try {
      const o = JSON.parse(raw);
      if (o && o.value != null) {
        const num = Number(o.value);
        if (Number.isFinite(num)) return `${num} ${unitAbbrev(o.unit) || defaultUnit}`;
        return String(o.value);
      }
    } catch (_) { /* not JSON, continue */ }
  } else if (typeof raw === "object" && raw.value != null) {
    const num = Number(raw.value);
    if (Number.isFinite(num)) return `${num} ${unitAbbrev(raw.unit) || defaultUnit}`;
    return String(raw.value);
  }

  // Try "4 INCHES" or "4 in"
  const s = String(raw).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)(?:\s+([A-Za-z]+))?$/);
  if (m) return `${m[1]} ${unitAbbrev(m[2]) || defaultUnit}`;
  return s;
}

function normalizePrice(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

// Only consider metafields to mark an item Blue (no tag fallback)
function isBlueByMetafields(productMF) {
  const c = productMF?.custom || {};
  if (c.blue_tagged === true || String(c.blue_tagged).toLowerCase() === "true") return true;
  if (typeof c.blue_tag === "string" && c.blue_tag.toLowerCase() === "blue") return true;

  const list = c.tags || c.blue_tags || c.metatags;
  if (Array.isArray(list) && list.some(x => String(x).toLowerCase() === "blue")) return true;
  if (typeof list === "string") {
    const parts = list.toLowerCase().split(/[,\|]/).map(s=>s.trim()).filter(Boolean);
    if (parts.includes("blue")) return true;
  }
  return false;
}

const GQL_ENDPOINT = (ver) => `https://${STORE_DOMAIN}/admin/api/${ver}/graphql.json`;

async function gqlFetch(query, variables, attempt = 0) {
  const res = await fetch(GQL_ENDPOINT(DEFAULT_API_VERSION), {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") || "2");
    await sleep(retryAfter * 1000);
    return gqlFetch(query, variables, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GraphQL ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

const PRODUCTS_QUERY = `
  query ProductsWithVariants($after: String) {
    products(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          productType
          tags
          images(first: 1) { edges { node { url } } }
          metafields(identifiers: [
            {namespace: "custom", key: "blue_tagged"},
            {namespace: "custom", key: "blue_tag"},
            {namespace: "custom", key: "tags"}
          ]) { namespace key type value }
          variants(first: 100) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                title
                sku
                inventoryQuantity
                price
                metafields(identifiers: [
                  {namespace: "custom", key: "plant_height"},
                  {namespace: "custom", key: "plant_caliper"}
                ]) { namespace key type value }
              }
            }
          }
        }
      }
    }
  }
`;

const VARIANTS_QUERY = `
  query ProductVariants($productId: ID!, $after: String) {
    product(id: $productId) {
      variants(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            sku
            inventoryQuantity
            price
            metafields(identifiers: [
              {namespace: "custom", key: "plant_height"},
              {namespace: "custom", key: "plant_caliper"}
            ]) { namespace key type value }
          }
        }
      }
    }
  }
`;

function mfArrayToObj(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (const mf of arr) {
    if (!mf || !mf.namespace || !mf.key) continue;
    const ns = mf.namespace;
    out[ns] = out[ns] || {};
    // coerce booleans where type says boolean
    if (mf.type && mf.type.toLowerCase().includes("boolean")) {
      out[ns][mf.key] = String(mf.value).toLowerCase() === "true";
    } else {
      out[ns][mf.key] = mf.value;
    }
  }
  return out;
}

function mapProductNode(node) {
  const productMF = mfArrayToObj(node.metafields);
  const blue = isBlueByMetafields(productMF);
  const base = {
    productId: node.id,
    title: node.title,
    handle: node.handle,
    productType: node.productType || null,
    tags: Array.isArray(node.tags) ? node.tags.join(", ") : (node.tags || null),
    image: node.images?.edges?.[0]?.node?.url || null,
    url: node.handle ? `https://${STORE_DOMAIN}/products/${node.handle}` : null,
    productMF
  };

  const rows = [];
  const vEdges = node.variants?.edges || [];
  for (const e of vEdges) {
    const v = e.node;
    const vMF = mfArrayToObj(v.metafields);
    rows.push({
      productId: base.productId,
      variantId: v.id,
      title: base.title,
      handle: base.handle,
      cultivar: v.title && v.title !== "Default Title" ? v.title : null,
      sku: v.sku || (v.title && v.title !== "Default Title" ? v.title : null),
      price: normalizePrice(v.price),
      qty: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
      productType: base.productType,
      url: base.url,
      image: base.image,
      tags: base.tags,
      metafields: { product: productMF, variant: vMF },
      plantHeight: normalizeMeasure(vMF?.custom?.plant_height, "in"),
      plantCaliper: normalizeMeasure(vMF?.custom?.plant_caliper, "in"),
      blue // marker if product-level blue (we’ll decide later whether to exclude)
    });
  }

  const needsVariantPagination = node.variants?.pageInfo?.hasNextPage || false;
  const variantCursor = node.variants?.pageInfo?.endCursor || null;

  return { rows, blue, needsVariantPagination, variantCursor, productId: node.id, node };
}

async function fetchAllRows() {
  const all = [];
  let after = null;

  do {
    const d = await gqlFetch(PRODUCTS_QUERY, { after });
    const conn = d.products;
    for (const edge of conn.edges) {
      const { rows, blue, needsVariantPagination, variantCursor, productId, node } = mapProductNode(edge.node);
      // If product-level metafield marks Blue, exclude all its rows
      if (!blue) all.push(...rows);

      if (needsVariantPagination) {
        let vAfter = variantCursor;
        let keep = true;
        while (keep) {
          const vd = await gqlFetch(VARIANTS_QUERY, { productId, after: vAfter });
          const vConn = vd.product?.variants;
          if (!vConn) break;
          for (const vEdge of vConn.edges) {
            const v = vEdge.node;
            const vMF = mfArrayToObj(v.metafields);
            if (!blue) {
              all.push({
                productId: node.id,
                variantId: v.id,
                title: node.title,
                handle: node.handle,
                cultivar: v.title && v.title !== "Default Title" ? v.title : null,
                sku: v.sku || (v.title && v.title !== "Default Title" ? v.title : null),
                price: normalizePrice(v.price),
                qty: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
                productType: node.productType || null,
                url: node.handle ? `https://${STORE_DOMAIN}/products/${node.handle}` : null,
                image: node.images?.edges?.[0]?.node?.url || null,
                tags: Array.isArray(node.tags) ? node.tags.join(", ") : (node.tags || null),
                metafields: { product: mfArrayToObj(node.metafields), variant: vMF },
                plantHeight: normalizeMeasure(vMF?.custom?.plant_height, "in"),
                plantCaliper: normalizeMeasure(vMF?.custom?.plant_caliper, "in"),
                blue
              });
            }
          }
          keep = vConn.pageInfo?.hasNextPage;
          vAfter = vConn.pageInfo?.endCursor || null;
        }
      }
    }
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  return all;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (!STORE_DOMAIN || !ADMIN_TOKEN) {
      return res.status(500).json({ ok:false, error:"Missing env vars: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_TOKEN" });
    }

    const minimal = ["1","true","yes"].includes(String(req.query.minimal||"").toLowerCase());
    const showOut = ["1","true","yes"].includes(String(req.query.showOutOfStock||"").toLowerCase());
    const productType = req.query.productType ? String(req.query.productType).toLowerCase() : null;

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");

    let items = await fetchAllRows();

    if (productType) {
      items = items.filter(r => (r.productType || "").toLowerCase() === productType);
    }

    if (!showOut) {
      items = items.filter(i => typeof i.qty === "number" && i.qty > 0);
    }

    if (minimal) {
      items = items.map(i => ({
        title: i.title,
        cultivar: i.cultivar,
        plantCaliper: i.plantCaliper,
        plantHeight: i.plantHeight,
        sku: i.sku,
        price: i.price,
        qty: i.qty,
        url: i.url
      }));
    }

    res.status(200).json({ ok:true, generatedAt: new Date().toISOString(), count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: err.message || "Internal error" });
  }
}
