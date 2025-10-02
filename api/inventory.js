// api/inventory.js — minimal mode + edge cache + Blue filter + Height + $0-friendly
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

// REST: fetch products (restrict to fields we actually use)
async function fetchAllProducts({ limit = 250 }) {
  const fields = "id,title,handle,product_type,tags,images,variants,metafields";
  let url = `https://${STORE_DOMAIN}/admin/api/${DEFAULT_API_VERSION}/products.json?limit=${limit}&fields=${encodeURIComponent(fields)}`;

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

// Metafield helpers
function isBlueByMetafields(mf, tagsStr) {
  if (mf && typeof mf === "object") {
    const c = mf.custom || {};
    if (c.blue_tagged === true || String(c.blue_tagged).toLowerCase() === "true") return true;
    if (typeof c.blue_tag === "string" && c.blue_tag.toLowerCase() === "blue") return true;

    const list = c.tags || c.blue_tags || c.metatags;
    if (Array.isArray(list) && list.some(x => String(x).toLowerCase() === "blue")) return true;
    if (typeof list === "string") {
      const parts = list.toLowerCase().split(/[,\|]/).map(s=>s.trim()).filter(Boolean);
      if (parts.includes("blue")) return true;
    }
    return false; // metafields exist but none indicate "blue"
  }
  // fallback to product tags only if no metafields
  if (typeof tagsStr === "string" && tagsStr.toLowerCase().includes("blue")) return true;
  return false;
}

function unitAbbrev(u) {
  if (!u) return "";
  const s = String(u).toLowerCase();
  if (s === "inches" || s === "inch" || s === "in") return "in";
  if (s === "feet" || s === "foot" || s === "ft") return "ft";
  if (s === "centimeters" || s === "cm") return "cm";
  if (s === "meters" || s === "m") return "m";
  return s; // fallback
}

function normalizeMeasure(val, defaultUnit = "in") {
  // Accepts: number -> "X in"
  //          string -> returned as-is
  //          object { value, unit } -> "value <abbr>"
  if (val == null) return null;
  if (typeof val === "object" && val.value != null) {
    const num = Number(val.value);
    if (Number.isFinite(num)) return `${num} ${unitAbbrev(val.unit) || defaultUnit}`;
    return String(val.value);
  }
  if (typeof val === "number") return `${val} ${defaultUnit}`;
  return String(val);
}

function mapProductsToRows(products, { minimal = false, excludeBlue = true }) {
  const rows = [];
  for (const p of products) {
    const img = p.images?.[0]?.src || null;
    const mf = p.metafields || null;

    const blue = excludeBlue ? isBlueByMetafields(mf, p.tags || "") : false;
    if (blue) continue;

    // NOTE: Height & Caliper pulled from product metafields: custom.plant_height & custom.plant_caliper
    const caliperRaw =
      (mf?.custom?.plant_caliper && typeof mf.custom.plant_caliper === "object")
        ? mf.custom.plant_caliper
        : (mf?.custom?.plant_caliper ?? null);

    const heightRaw =
      (mf?.custom?.plant_height && typeof mf.custom.plant_height === "object")
        ? mf.custom.plant_height
        : (mf?.custom?.plant_height ?? null);

    for (const v of (p.variants || [])) {
      const base = {
        productId: String(p.id),
        variantId: String(v.id),
        title: p.title,
        handle: p.handle,
        cultivar: v.title && v.title !== "Default Title" ? v.title : null, // variant name as “Cultivar”
        sku: v.sku || null,
        price: v.price != null ? String(v.price) : null,
        qty: typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
        productType: p.product_type || null,
        url: p.handle ? `https://${STORE_DOMAIN}/products/${p.handle}` : null,
        plantCaliper: normalizeMeasure(caliperRaw, "in"),
        plantHeight: normalizeMeasure(heightRaw, "in"),
        image: img,
        tags: p.tags || null,
        metafields: mf || null
      };

      if (minimal) {
        rows.push({
          title: base.title,
          cultivar: base.cultivar,
          plantCaliper: base.plantCaliper,
          plantHeight: base.plantHeight,
          sku: base.sku,
          price: base.price,
          qty: base.qty,
          url: base.url
        });
      } else {
        rows.push(base);
      }
    }
  }
  return rows;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (!STORE_DOMAIN || !ADMIN_TOKEN) {
      return res.status(500).json({ ok:false, error:"Missing env vars: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_TOKEN" });
    }

    const minimal = ["1","true","yes"].includes(String(req.query.minimal||"").toLowerCase());
    const showOutOfStock = ["1","true","yes"].includes(String(req.query.showOutOfStock||"").toLowerCase());
    const productType = req.query.productType ? String(req.query.productType).toLowerCase() : null;

    // Strong edge caching for speed
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");

    const products = await fetchAllProducts({ limit: 250 });
    let items = mapProductsToRows(products, { minimal, excludeBlue: true });

    if (productType) items = items.filter(i => (i.productType||"").toLowerCase() === productType);
    if (!showOutOfStock) items = items.filter(i => typeof i.qty === "number" && i.qty > 0);

    res.status(200).json({ ok:true, generatedAt: new Date().toISOString(), count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: err.message || "Internal error" });
  }
}
