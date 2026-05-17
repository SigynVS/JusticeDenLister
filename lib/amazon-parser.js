"use strict";
const cheerio = require("cheerio");

/**
 * Parse Amazon Best Sellers / Movers & Shakers HTML into product records.
 *
 * Strategy 1 (cheerio): selects [data-asin] elements and reads structured
 * attributes — reliable when Amazon's rendered DOM is present.
 *
 * Strategy 2 (regex fallback): scans for /dp/ASIN in raw HTML and extracts
 * title/price/image from a 1.7 kB context window — used when the primary
 * strategy yields fewer than 3 products (e.g. heavily JS-rendered pages).
 *
 * @param {string} html - Raw HTML from Amazon
 * @param {number} max  - Maximum number of products to return (default 20)
 * @returns {{ asin: string, title: string, price: number|null, imageUrl: string|null }[]}
 */
function parseAmazonProductsFromHtml(html, max = 20) {
  if (!html) return [];

  const $ = cheerio.load(html);
  const seen = new Set();
  const products = [];

  // ── Strategy 1: DOM-aware cheerio extraction ────────────────────────────────
  $("[data-asin]").each((_, el) => {
    if (products.length >= max) return false; // break each()
    const asin = $(el).attr("data-asin");
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) return;
    seen.add(asin);

    // Title — img alt text is the most reliable source on Best Sellers pages
    const img = $(el).find("img").first();
    const altTitle = (img.attr("alt") || "").trim();
    const textTitle = $(el)
      .find(".p13n-sc-truncate-desktop-type2, .p13n-sc-truncate, [class*='truncate']")
      .first()
      .text()
      .trim();
    const title =
      altTitle.length >= 5 && !altTitle.includes("http") ? altTitle
      : textTitle.length >= 5 ? textTitle
      : null;
    if (!title) return;

    // Price
    const priceRaw = $(el).find(".p13n-sc-price, .a-price .a-offscreen").first().text();
    const priceM = priceRaw.match(/(\d+\.?\d*)/);
    const price = priceM ? parseFloat(priceM[1]) : null;

    // Image — strip Amazon thumbnail size params so we get the full image
    let imageUrl = img.attr("src") || null;
    if (imageUrl) imageUrl = imageUrl.replace(/\._[A-Z_,0-9]+_\./, ".");

    products.push({ asin, title, price, imageUrl });
  });

  // ── Strategy 2: Regex fallback ──────────────────────────────────────────────
  // Fall back only when cheerio clearly failed: zero results, or far fewer than
  // expected when a full list was requested. Never fall back just because max
  // was set small (max <= 3) — that would discard valid results.
  if (products.length === 0 || (max > 3 && products.length < 3)) {
    products.length = 0; // clear partial results and start fresh
    seen.clear();
    const asinRe = /\/dp\/([A-Z0-9]{10})/g;
    let m;
    while ((m = asinRe.exec(html)) !== null && products.length < max) {
      const asin = m[1];
      if (seen.has(asin)) continue;
      seen.add(asin);

      // Grab a context window around this ASIN occurrence
      const idx = html.indexOf("/dp/" + asin);
      const block = html.substring(Math.max(0, idx - 200), idx + 1500);

      // Title
      let title = null;
      for (const pat of [
        /alt="([^"]{5,200})"/,
        /title="([^"]{5,200})"/,
        /"name":"([^"<]{5,200})"/,
      ]) {
        const tm = block.match(pat);
        if (tm && tm[1] && !tm[1].includes("<") && !tm[1].includes("http")) {
          title = tm[1].trim();
          break;
        }
      }
      if (!title) continue;

      // Price
      const priceM = block.match(/\$(\d+\.?\d*)/);
      const price = priceM ? parseFloat(priceM[1]) : null;

      // Image
      const imgM =
        block.match(/src="(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/) ||
        block.match(/src="(https:\/\/images-na\.ssl-images-amazon\.com\/images\/[^"]+)"/);
      const imageUrl = imgM ? imgM[1].replace(/\._[A-Z_,0-9]+_\./, ".") : null;

      products.push({ asin, title, price, imageUrl });
    }
  }

  return products;
}

module.exports = { parseAmazonProductsFromHtml };
