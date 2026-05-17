'use strict';
/**
 * Unit tests for lib/ pure functions — zero network, zero eBay calls.
 * Run with: node tests/lib.test.js
 * Or:       npm test
 */
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.error('  ✗', name);
    console.error('   ', err.message);
    failed++;
  }
}

// ── lib/ebay-auth.js ──────────────────────────────────────────────────────────
console.log('\nextractCodeFromInput');
const { extractCodeFromInput } = require('../lib/ebay-auth');

test('extracts code from full callback URL', () => {
  const url = 'https://justiceden.com/ebay-callback?code=v%5E1.1%23abc123&state=xyz';
  assert.strictEqual(extractCodeFromInput(url), 'v^1.1#abc123');
});

test('returns raw value when no ?code= param', () => {
  assert.strictEqual(extractCodeFromInput('plaincodehere'), 'plaincodehere');
});

test('returns null for null input', () => {
  assert.strictEqual(extractCodeFromInput(null), null);
});

test('returns null for empty string', () => {
  assert.strictEqual(extractCodeFromInput(''), null);
});

test('handles &code= mid-URL', () => {
  const url = 'https://example.com/cb?state=abc&code=tok%3D123';
  assert.strictEqual(extractCodeFromInput(url), 'tok=123');
});

// ── lib/ebay-utils.js ─────────────────────────────────────────────────────────
console.log('\nebayErrDetail');
const { ebayErrDetail, isAllowedImageHost } = require('../lib/ebay-utils');

test('returns null when no response', () => {
  assert.strictEqual(ebayErrDetail(new Error('network')), null);
});

test('returns null when response has no data', () => {
  assert.strictEqual(ebayErrDetail({ response: {} }), null);
});

test('extracts errors array', () => {
  const err = { response: { data: { errors: [{ errorId: 1, message: 'bad', category: 'REQUEST', longMessage: 'very bad' }] } } };
  const result = ebayErrDetail(err);
  assert.strictEqual(Array.isArray(result), true);
  assert.strictEqual(result[0].errorId, 1);
  assert.strictEqual(result[0].message, 'bad');
});

test('extracts oauth error_description', () => {
  const err = { response: { data: { error: 'invalid_grant', error_description: 'Token expired' } } };
  const result = ebayErrDetail(err);
  assert.strictEqual(result.code, 'invalid_grant');
  assert.strictEqual(result.description, 'Token expired');
});

console.log('\nisAllowedImageHost');
test('allows amazon.com', () => assert.strictEqual(isAllowedImageHost('https://www.amazon.com/img/foo.jpg'), true));
test('allows m.media-amazon.com', () => assert.strictEqual(isAllowedImageHost('https://m.media-amazon.com/images/I/foo.jpg'), true));
test('allows i.ibb.co', () => assert.strictEqual(isAllowedImageHost('https://i.ibb.co/abc/img.jpg'), true));
test('blocks unknown host', () => assert.strictEqual(isAllowedImageHost('https://sketchy-cdn.ru/img.jpg'), false));
test('blocks malformed URL', () => assert.strictEqual(isAllowedImageHost('not-a-url'), false));

// ── lib/product-safety.js ─────────────────────────────────────────────────────
console.log('\ncheckProductSafety');
const { checkProductSafety } = require('../lib/product-safety');

test('blocks Apple VeRO brand', () => {
  const r = checkProductSafety({ title: 'Apple AirPods Pro 2nd Gen', asin: 'B123', price: 250 });
  assert.strictEqual(r.blocked, true);
  assert.ok(r.reason.toLowerCase().includes('vero'));
});

test('blocks high-value electronics (PS5)', () => {
  const r = checkProductSafety({ title: 'Sony PS5 Console', asin: 'B456', price: 500 });
  assert.strictEqual(r.blocked, true);
});

test('blocks cheap products under $15', () => {
  const r = checkProductSafety({ title: 'Generic USB Cable Pack', asin: 'B789', price: 8 });
  assert.strictEqual(r.blocked, true);
  assert.ok(r.reason.includes('too low'));
});

test('allows safe generic product', () => {
  const r = checkProductSafety({ title: 'Wireless LED Desk Lamp 3-Color Modes', asin: 'B001', price: 35 });
  assert.strictEqual(r.blocked, false);
});

test('blocks subscription keyword', () => {
  const r = checkProductSafety({ title: 'Monthly Subscription Box Wellness', asin: 'B002', price: 50 });
  assert.strictEqual(r.blocked, true);
});

test('null price does not block', () => {
  const r = checkProductSafety({ title: 'Nice Portable Speaker', asin: 'B003', price: null });
  assert.strictEqual(r.blocked, false);
});

// ── lib/ebay-listing.js ───────────────────────────────────────────────────────
console.log('\nparseMissingSpecifics');
const { parseMissingSpecifics, extractColorServer, extractConnectivity } = require('../lib/ebay-listing');

test('extracts fieldName from parameters', () => {
  const errors = [{ parameters: [{ name: 'fieldName', value: 'Color' }], message: '' }];
  const result = parseMissingSpecifics(errors);
  assert.deepStrictEqual(result, ['Color']);
});

test('falls back to message parsing', () => {
  const errors = [{ message: 'The item specific Brand is missing. Add Brand to this listing.' }];
  const result = parseMissingSpecifics(errors);
  assert.deepStrictEqual(result, ['Brand']);
});

test('deduplicates across errors', () => {
  const errors = [
    { parameters: [{ name: 'fieldName', value: 'Color' }], message: '' },
    { message: 'The item specific Color is missing.' },
  ];
  assert.strictEqual(parseMissingSpecifics(errors).length, 1);
});

test('returns empty array for no errors', () => {
  assert.deepStrictEqual(parseMissingSpecifics([]), []);
  assert.deepStrictEqual(parseMissingSpecifics(null), []);
});

console.log('\nextractColorServer');
test('extracts Black from title', () => assert.strictEqual(extractColorServer('Wireless Headphones Black'), 'Black'));
test('extracts Rose Gold (multi-word)', () => assert.strictEqual(extractColorServer('Apple Watch Rose Gold'), 'Rose Gold'));
test('returns null for no color', () => assert.strictEqual(extractColorServer('USB Charging Cable'), null));

console.log('\nextractConnectivity');
test('extracts Wi-Fi from wifi title', () => assert.strictEqual(extractConnectivity('Smart WiFi Plug'), 'Wi-Fi'));
test('extracts Bluetooth', () => assert.strictEqual(extractConnectivity('Bluetooth Speaker 40W'), 'Bluetooth'));
test('defaults to Wi-Fi for unknown', () => assert.strictEqual(extractConnectivity('Generic LED Lamp'), 'Wi-Fi'));

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
