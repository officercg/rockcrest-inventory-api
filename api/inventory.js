// api/inventory.js — GraphQL (variant metafields) + minimal mode + edge cache + Blue filter
const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. rockcrest.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function unitAbbrev(u) {
  if (!u) return "";
  const s = String(u).toLowerCase();
  if (s === "inches" || s === "inch" || s === "in") return "in";
  if (s === "feet" || s === "foot" || s === "ft") return "ft";
  if (s === "centimeters" || s === "cm") return "cm";
  if (s === "meters" || s === "m") return "m";
  return s;
}

function normalizeMeasureFromJSONish(raw, defaultUnit = "in") {
  if (raw == null) return null;
  // GraphQL metafield.value can be:
  //  - JSON string: {"value":4,"unit":"INCHES"}
  //  - plain string: "4 INCHES" or "4"
  // Try JSON first:
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj && obj.value != null) {
      const num = Number(obj.value);
      if (Number.isFinite(num)) {
        const abbr = unitAbbrev(obj.unit) || defaultUnit;
        return `${num} ${abbr}`;
      }
    }
  } catch (_) { /* not JSON */ }

  // If plain string, try to split numeric + unit
  const s = String(raw).trim();
  if (!s) return null;
  // e.g. "4 INCHES" or "4 in"
  const m = s.match(/^(\d+(\.\d+)?)(?:\s+([A-Za-z]+))?$/);
  if (m) {
    const num = m[1];
    const abbr = unitAbbrev(m[3]) || defaultUnit;
    return `${num} ${abbr}`;
  }
  // last resort, return as-is
  return s;
}

function normalizePrice(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

function isBlueByMetafields(productMF, productTags) {
  if (productMF && typeof productMF === "object") {
    const c = productMF.custom || {};
    if (c.blue_tagged === true || String(c.blue_tagged).toLowerCase() === "true") return true;
    if (typeof c.blue_tag === "string" && c.blue_tag.toLowerCase() === "blue") return true;
    const list = c.tags || c.blue_tags || c.metatags;
    if (Array.isArray(list) && list.some(x => String(x).toLowerCase() === "blue")) return true;
    if (typeof list === "string") {
      const parts = list.toLowerCase().split(/[,\|]/).map(s=>s.trim()).filter(Boolean);
      if (parts.includes("blue")) return true;
    }
    return false; // metafields exist but none indicate blue
  }
  // fallback to product tags when no metafields exist
  if (typeof productTags === "string" && productTags.toLowerCase().includes("blue")) return true;
  return false;
}

// ---------- GraphQL ----------
const GQL_ENDPOINT = (version) => `https://${STORE_DOMAIN}/admin/api/${version}/graphql.json`;

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
    // rate limited
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

// GraphQL query: products + variants + specific metafields
// - Pull product metafields for "Blue" detection
// - Pull variant metafields for height/caliper
const PRODUCTS_QUERY = `
  query ProductsWithVariants($after: String) {
    products(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          tags
          productType
          images(first: 1) { edges { node { url } } }
          metafields(identifiers: [
            {namespace: "custom", key: "blue_tagged"},
            {namespace: "custom", key: "blue_tag"},
            {namespace: "custom", key: "tags"}
          ]) {
            namespace
            key
            type
            value
          }
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
                ]) {
                  namespace
                  key
                  type
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Paginate variants if >100 per product
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
            ]) {
              namespace
              key
              type
              value
            }
          }
        }
      }
    }
  }
`;

// ---------- Mapping ----------
function metafieldsArrayToObject(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (const mf of arr) {
    if (!mf || !mf.namespace || !mf.key) continue;
    const ns = mf.namespace;
    const k = mf.key;
    out[ns] = out[ns] || {};
    // Try to coerce common boolean/text
    if (mf.type && mf.type.toLowerCase().includes("boolean")) {
      out[ns][k] = String(mf.value).toLowerCase() === "true";
    } else {
      out[ns][k] = mf.value;
    }
  }
  return out;
}

function mapProductNodeToRows(node, storeDomain) {
  const rows = [];

  const productMF = metafieldsArrayToObject(node.metafields);
  const isBlue = isBlueByMetafields(productMF, (node.tags || []).join(", "));
  if (isBlue) return rows; // exclude entire product if blue at product level

  const img = node.images?.edges?.[0]?.node?.url || null;
  const base = {
    productId: node.id,
    title: node.title,
    handle: node.handle,
    productType: node.productType || null,
    tags: Array.isArray(node.tags) ? node.tags.join(", ") : (node.tags || null),
    image: img,
    url: node.handle ? `https://${storeDomain}/products/${node.handle}` : null,
    metafields: productMF
  };

  const pushVariant = (vNode) => {
    const vMF = metafieldsArrayToObject(vNode.metafields);
    // If Blue is ever set at variant level, you could exclude here too (optional)
    const cultivar = vNode.title && vNode.title !== "Default Title" ? vNode.title : null;

    rows.push({
      productId: base.productId,
      variantId: vNode.id,
      title: base.title,
      handle: base.handle,
      cultivar,
      sku: vNode.sku || cultivar || null,
      price: normalizePrice(vNode.price),
      qty: typeof vNode.inventoryQuantity === "number" ? vNode.inventoryQuantity : null,
      productType: base.productType,
      url: base.url,
      image: base.image,
      tags: base.tags,
      metafields: { product: productMF, variant: vMF },
      plantHeight: normalizeMeasureFromJSONish(vMF?.custom?.plant_height, "in"),
      plantCaliper: normalizeMeasureFromJSONish(vMF?.custom?.plant_caliper, "in")
    });
  };

  // Push up to first 100 variants
  const vEdges = node.variants?.edges || [];
  vEdges.forEach(e => pushVariant(e.node));

  // If product has more than 100 variants, we need to paginate variants as well
  const hasMoreVariants = node.variants?.pageInfo?.hasNextPage;
  const endCursor = node.variants?.pageInfo?.endCursor;

  return { rows, needsVariantPagination: !!hasMoreVariants, productId: node.id, variantCursor: endCursor };
}

// Fetch ALL products and variants (with pagination)
async function fetchAllRows() {
  const allRows = [];
  let after = null;

  do {
    const data = await gqlFetch(PRODUCTS_QUERY, { after });
    const conn = data.products;
    for (const edge of conn.edges) {
      const node = edge.node;
      const mapped = mapProductNodeToRows(node, STORE_DOMAIN);
      allRows.push(...mapped.rows);

      if (mapped.needsVariantPagination) {
        // paginate variants for this product
        let vAfter = mapped.variantCursor;
        let keepGoing = true;
        while (keepGoing) {
          const vData = await gqlFetch(VARIANTS_QUERY, { productId: node.id, after: vAfter });
          const vConn = vData.product?.variants;
          if (!vConn) break;
          for (const vEdge of vConn.edges) {
            const vNode = vEdge.node;
            // We need the product-level context to compute row; recreate light base here:
            const vMF = metafieldsArrayToObject(vNode.metafields);
            const cultivar = vNode.title && vNode.title !== "Default Title" ? vNode.title : null;
            allRows.push({
              productId: node.id,
              variantId: vNode.id,
              title: node.title,
              handle: node.handle,
              cultivar,
              sku: vNode.sku || cultivar || null,
              price: normalizePrice(vNode.price),
              qty: typeof vNode.inventoryQuantity === "number" ? vNode.inventoryQuantity : null,
              productType: node.productType || null,
              url: node.handle ? `https://${STORE_DOMAIN}/products/${node.handle}` : null,
              image: node.images?.edges?.[0]?.node?.url || null,
              tags: Array.isArray(node.tags) ? node.tags.join(", ") : (node.tags || null),
              metafields: { product: metafieldsArrayToObject(node.metafields), variant: vMF },
              plantHeight: normalizeMeasureFromJSONish(vMF?.custom?.plant_height, "in"),
              plantCaliper: normalizeMeasureFromJSONish(vMF?.custom?.plant_caliper, "in")
            });
          }
          keepGoing = vConn.pageInfo?.hasNextPage;
          vAfter = vConn.pageInfo?.endCursor || null;
        }
      }
    }
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  return allRows;
}

// ---------- Handler ----------
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

    // Strong edge caching for speed
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");

    const rows = await fetchAllRows();

    // Optional productType filter
    let items = productType
      ? rows.filter(r => (r.productType||"").toLowerCase() === productType)
      : rows;

    // Hide OOS unless requested
    if (!showOut) items = items.filter(i => typeof i.qty === "number" && i.qty > 0);

    // Final shape
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
