// api/inventory.js
// Rock Crest Inventory API — fast bulk metafields, excludeTag, include OOS option.
// Minimal payload omits tags and sunRequirement; keeps commonName, growthRate, plantCaliper.

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

// ---------- Shopify fetch helpers ----------
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

// Bulk fetch ALL product metafields, paginated
async function fetchAllProductMetafields() {
  const url = `https://${STORE_DOMAIN}/admin
