"use strict";
/**
 * Scraper regression tests — no external network access required.
 * Run with: node tests/scraper.test.js
 * Or:       npm test
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseAmazonProductsFromHtml } = require("../lib/amazon-parser");

const FIXTURES = path.join(__dirname, "fixtures");
const load = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
    passed++;
  } catch (err) {
    console.error("  ✗", name);
    console.error("   ", err.message);
    failed++;
  }
}

// ── Cheerio (primary) path ──────────────────────────────────────────────────
console.log("\nCheerio path (data-asin elements)");
{
  const html = load("amazon-bestsellers.html");
  const products = parseAmazonProductsFromHtml(html);

  test("finds 3 valid products (skips dup + short-alt)", () => {
    assert.strictEqual(products.length, 3, `Got ${products.length}`);
  });

  test("first ASIN is B08N5LNQCX", () => {
    assert.strictEqual(products[0].asin, "B08N5LNQCX");
  });

  test("title comes from img alt text", () => {
    assert.ok(products[0].title.includes("Echo Dot"), `Got: "${products[0].title}"`);
  });

  test("price parsed to 49.99", () => {
    assert.strictEqual(products[0].price, 49.99);
  });

  test("second price parsed to 139.99", () => {
    assert.strictEqual(products[1].price, 139.99);
  });

  test("missing price returns null", () => {
    assert.strictEqual(products[2].price, null, `Got: ${products[2].price}`);
  });

  test("image URL strips size params", () => {
    assert.ok(
      !products[0].imageUrl.includes("._AC_"),
      `Still contains size params: ${products[0].imageUrl}`
    );
  });

  test("deduplicates ASINs across doubled HTML", () => {
    const doubled = html + html;
    const deduped = parseAmazonProductsFromHtml(doubled);
    assert.strictEqual(deduped.length, 3, `Got ${deduped.length}`);
  });

  test("respects max=2 limit", () => {
    const limited = parseAmazonProductsFromHtml(html, 2);
    assert.strictEqual(limited.length, 2);
  });
}

// ── Regex fallback path ─────────────────────────────────────────────────────
console.log("\nRegex fallback path (no data-asin)");
{
  const html = load("amazon-bestsellers-fallback.html");
  const products = parseAmazonProductsFromHtml(html);

  test("fallback extracts all 3 products", () => {
    assert.strictEqual(products.length, 3, `Got ${products.length}`);
  });

  test("fallback: first ASIN is B08N5LNQCX", () => {
    assert.strictEqual(products[0].asin, "B08N5LNQCX");
  });

  test("fallback: title from alt text", () => {
    assert.ok(products[0].title.includes("Echo Dot"), `Got: "${products[0].title}"`);
  });

  test("fallback: price parsed", () => {
    assert.strictEqual(products[0].price, 49.99);
  });

  test("fallback: image URL strips size params", () => {
    assert.ok(
      !products[0].imageUrl.includes("._AC_"),
      `Still contains size params: ${products[0].imageUrl}`
    );
  });
}

// ── Edge cases ──────────────────────────────────────────────────────────────
console.log("\nEdge cases");
{
  test("empty string returns []", () => {
    assert.deepStrictEqual(parseAmazonProductsFromHtml(""), []);
  });

  test("null-ish input returns []", () => {
    assert.deepStrictEqual(parseAmazonProductsFromHtml(null), []);
  });

  test("HTML with no products returns []", () => {
    const empty = "<html><body><p>Sorry, we couldn't find that page.</p></body></html>";
    assert.deepStrictEqual(parseAmazonProductsFromHtml(empty), []);
  });

  test("ASIN not 10 chars is ignored", () => {
    const bad = '<li data-asin="B001"><img alt="Short ASIN product" src="https://m.media-amazon.com/images/I/test._AC_.jpg"></li>';
    assert.deepStrictEqual(parseAmazonProductsFromHtml(bad), []);
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
