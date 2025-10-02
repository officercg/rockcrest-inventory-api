// api/inventory.js — Admin GraphQL (metafield(namespace,key) compatible)
// Pulls VARIANT metafields (height, caliper) and exposes minimal payload.
// CORS via ALLOWED_ORIGIN. Edge cache. OOS hidden by default unless showOutOfStock=1.

const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;   // e.g. rockcrest.myshopify.com
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// Shopify Admin GraphQL metafield.value for measurements is often a JSON string:
// {"value":4.0,"unit":"INCHES"}  — normalize to "4 in"
function normalizeMeasure(raw, defaultUnit = "in") {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.value != null) {
        const num = Number(obj.value);
        if (Number.isFinite(num)) return `${num} ${unitAbbrev(obj.unit) || defaultUnit}`;
        return String(obj.value);
      }
    } catch {
      // Not JSON — try "4 INCHES" pattern
      const m = raw.trim().match(/^(\d+(?:\.\d+)?)(?:\s+([A-Za-z]+))?$/);
      if (m) return `${m[1]} ${unitAbbrev(m[2]) || defaultUnit}`;
      return raw;
    }
  }
  if (typeof raw === "object" && raw.value != null) {
    const num = Number(raw.value);
    if (Number.isFinite(num)) return `${num} ${unitAbbrev(raw.unit) || defaultUnit}`;
    return String(raw.value);
  }
  if (typeof raw === "number") return `${raw} ${defaultUnit}`;
  return String(raw);
}

function normalizePrice(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

const GQL_ENDPOINT = (ver) => `https://${STORE_DOMAIN}/admin/api/${ver}/graphql.json`;

async function gqlFetch(query, variables, attempt = 0) {
  const res = await fetch(GQL_ENDPOINT(DEFAULT_API_VERSION), {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query, variables }),
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

// NOTE: Using singular `metafield(namespace:, key:)` — works across Admin GraphQL versions.
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

          # Optional product-level "blue" controls (future use)
          blueTagged: metafield(namespace:"custom", key:"blue_tagged") { value type }
          blueTag:    metafield(namespace:"custom", key:"blue_tag")    { value type }
          blueTags:   metafield(namespace:"custom", key:"tags")        { value type }

          variants(first: 100) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                title
                sku
                inventoryQuantity
                price
                mHeight:  metafield(namespace:"custom", key:"plant_height")  { value type }
                mCaliper: metafield(namespace:"custom", key:"plant_caliper") { value type }
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
            mHeight:  metafield(namespace:"custom", key:"plant_height")  { value type }
            mCaliper: metafield(namespace:"custom", key:"plant_caliper") { value type }
          }
        }
      }
    }
  }
`;

function mapVariantRows(productNode) {
  const rows = [];
  const baseUrl = productNode.handle ? `https://${STORE_DOMAIN}/products/${productNode.handle}` : null;
  const image = productNode.images?.edges?.[0]?.node?.url || null;

  const vEdges = productNode.variants?.edges || [];
  for (const e of vEdges) {
    const v = e.node;
    rows.push({
      productId: productNode.id,
      variantId: v.id,
      title: productNode.title,
      handle: productNode.handle,
      cultivar: v.title && v.title !== "Default Title" ? v.title : null,
      sku: v.sku || (v.title && v.title !== "Default Title" ? v.title : null),
      price: normalizePrice(v.price),
      qty: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
      productType: productNode.productType || null,
      url: baseUrl,
      image,
      tags: Array.isArray(productNode.tags) ? productNode.tags.join(", ") : (productNode.tags || null),

      // normalized measurements
      plantHeight: normalizeMeasure(v.mHeight?.value, "in"),
      plantCaliper: normalizeMeasure(v.mCaliper?.value, "in"),

      // include raw minimal metafields in full shape
      metafields: {
        product: {
          custom: {
            blue_tagged: productNode.blueTagged?.value ?? null,
            blue_tag: productNode.blueTag?.value ?? null,
            tags: productNode.blueTags?.value ?? null,
          }
        },
        variant: {
          custom: {
            plant_height: v.mHeight?.value ?? null,
            plant_caliper: v.mCaliper?.value ?? null,
          }
        }
      }
    });
  }

  const needsVariantPagination = productNode.variants?.pageInfo?.hasNextPage || false;
  const variantCursor = productNode.variants?.pageInfo?.endCursor || null;

  return { rows, needsVariantPagination, variantCursor };
}

async function fetchAllRows() {
  const all = [];
  let after = null;

  do {
    const d = await gqlFetch(PRODUCTS_QUERY, { after });
    const conn = d.products;

    for (const edge of conn.edges) {
      const node = edge.node;
      const { rows, needsVariantPagination, variantCursor } = mapVariantRows(node);
      all.push(...rows);

      if (needsVariantPagination) {
        let vAfter = variantCursor;
        let keep = true;
        while (keep) {
          const vd = await gqlFetch(VARIANTS_QUERY, { productId: node.id, after: vAfter });
          const vConn = vd.product?.variants;
          if (!vConn) break;
          for (const vEdge of vConn.edges) {
            const v = vEdge.node;
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

              plantHeight: normalizeMeasure(v.mHeight?.value, "in"),
              plantCaliper: normalizeMeasure(v.mCaliper?.value, "in"),

              metafields: {
                product: {
                  custom: {
                    blue_tagged: node.blueTagged?.value ?? null,
                    blue_tag: node.blueTag?.value ?? null,
                    tags: node.blueTags?.value ?? null,
                  }
                },
                variant: {
                  custom: {
                    plant_height: v.mHeight?.value ?? null,
                    plant_caliper: v.mCaliper?.value ?? null,
                  }
                }
              }
            });
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

    // Cache a bit on edge (CDN) but keep it fresh
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");

    let items = await fetchAllRows();

    if (productType) {
      items = items.filter(i => (i.productType || "").toLowerCase() === productType);
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
