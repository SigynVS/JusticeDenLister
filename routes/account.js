'use strict';
const express = require('express');
const axios   = require('axios');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const { getAppToken, getUserToken, refreshUserToken } = require('../lib/ebay-auth');
const { ebayErrDetail, IMAGES_FILE, uploadBufferToImgBB, saveHostedImage, reHostImage } = require('../lib/ebay-utils');
const { LOCATION_KEY, getCachedPolicyIds, getPolicyIds } = require('../lib/ebay-listing');
const { BLOCKLIST_FILE }                     = require('../lib/product-safety');
const { getLocalListings, getActivity, getDbStats } = require('../lib/db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const REPRICER_FILE = path.join(__dirname, '..', 'repricer-settings.json');

// ── Auth status + token refresh ───────────────────────────────────────────────
router.get('/api/auth-status', (req, res) => {
  const hasToken = !!(process.env.EBAY_OAUTH_USER_TOKEN || process.env.EBAY_OAUTH_REFRESH_TOKEN);
  const expiry   = parseInt(process.env.EBAY_OAUTH_USER_TOKEN_EXPIRY || '0', 10);
  res.json({
    connected:        hasToken,
    canAutoRefresh:   !!process.env.EBAY_OAUTH_REFRESH_TOKEN,
    expiresInSeconds: expiry ? Math.max(0, Math.floor((expiry - Date.now()) / 1000)) : null,
  });
});

router.post('/api/refresh-token', async (req, res) => {
  try {
    await refreshUserToken();
    const expiry = parseInt(process.env.EBAY_OAUTH_USER_TOKEN_EXPIRY || '0', 10);
    res.json({ success: true, expiresAt: expiry ? new Date(expiry).toISOString() : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Market research (eBay Browse API) ─────────────────────────────────────────
// NOTE: Named "terapeak" internally but queries eBay Browse API for active listings.
const researchCache     = new Map();
const RESEARCH_CACHE_TTL = 30 * 60 * 1000;

router.get('/api/terapeak', async (req, res) => {
  try {
    const q      = req.query.q || 'fire pit';
    const key    = q.toLowerCase().trim();
    const cached = researchCache.get(key);
    if (cached && Date.now() < cached.expires) return res.json(cached.data);
    const token  = await getAppToken();
    const r      = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + encodeURIComponent(q) + '&limit=20&sort=NEWLY_LISTED',
      { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
    );
    const items  = r.data.itemSummaries || [];
    const prices = items.map(i => parseFloat(i.price && i.price.value ? i.price.value : 0)).filter(p => p > 0);
    const avgPrice = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : 0;
    const data   = { query: q, totalResults: r.data.total, avgPrice, minPrice: prices.length ? Math.min(...prices).toFixed(2) : 0, maxPrice: prices.length ? Math.max(...prices).toFixed(2) : 0, items: items.slice(0, 10).map(i => ({ title: i.title, price: i.price ? i.price.value : 'N/A', seller: i.seller ? i.seller.username : 'N/A', condition: i.condition || 'N/A' })) };
    researchCache.set(key, { data, expires: Date.now() + RESEARCH_CACHE_TTL });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Account readiness ─────────────────────────────────────────────────────────
let accountReadinessCache = null;
let accountReadinessCacheExpiry = 0;
const ACCOUNT_READINESS_TTL = 10 * 60 * 1000;

router.get('/api/account-readiness', async (req, res) => {
  if (accountReadinessCache && Date.now() < accountReadinessCacheExpiry) return res.json(accountReadinessCache);
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected. Visit /auth/ebay' }); }
  const auth  = { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } };
  const probe = async (label, url) => {
    try {
      const r       = await axios.get(url, auth);
      const arrayKey = Object.keys(r.data).find(k => Array.isArray(r.data[k]));
      const items   = arrayKey ? r.data[arrayKey] : [];
      return { ok: true, count: items.length, items: items.map(i => ({ id: i.paymentPolicyId || i.returnPolicyId || i.fulfillmentPolicyId || i.merchantLocationKey, name: i.name || i.merchantLocationKey })) };
    } catch (err) {
      const status = err.response ? err.response.status : 0;
      const msg    = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
      return { ok: false, status, error: msg };
    }
  };
  const [payment, ret, fulfillment, location] = await Promise.all([
    probe('payment',     'https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US'),
    probe('return',      'https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US'),
    probe('fulfillment', 'https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US'),
    probe('location',    'https://api.ebay.com/sell/inventory/v1/location'),
  ]);
  const ready = payment.ok && payment.count > 0 && ret.ok && ret.count > 0 && fulfillment.ok && fulfillment.count > 0 && location.ok && location.count > 0;
  accountReadinessCache = { ready, paymentPolicies: payment, returnPolicies: ret, fulfillmentPolicies: fulfillment, inventoryLocations: location };
  accountReadinessCacheExpiry = Date.now() + ACCOUNT_READINESS_TTL;
  res.json(accountReadinessCache);
});

// ── Walmart scraper ───────────────────────────────────────────────────────────
router.post('/api/walmart', async (req, res) => {
  try {
    const { url } = req.body;
    const match   = url.match(/\/ip\/([^\/]+)\/(\d+)/);
    if (!match) return res.status(400).json({ error: 'Invalid Walmart URL' });
    const [, slug, itemId] = match;
    const r       = await axios.get('https://www.walmart.com/ip/' + slug + '/' + itemId, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.5' } });
    const html    = r.data;
    const titleMatch = html.match(/"name":"([^"]+)"/);
    const priceMatch = html.match(/"currentPrice":\{"price":(\d+\.?\d*)/) || html.match(/"price":(\d+\.?\d*)/);
    const title    = titleMatch ? titleMatch[1] : slug.replace(/-/g, ' ');
    const price    = priceMatch ? parseFloat(priceMatch[1]) : null;
    const suggestedPrice   = price ? (price * 1.7).toFixed(2) : null;
    const estimatedProfit  = price ? (suggestedPrice - price - suggestedPrice * 0.1325 - 0.30).toFixed(2) : null;
    const ebayTitle        = title.length > 80 ? title.substring(0, 77) + '...' : title;
    const ebayDescription  = title + '\n\n✅ Brand New\n✅ Fast US Shipping\n✅ 30-day returns\n\n🏪 Justice Den — Quality you can trust, prices you\'ll love.';
    res.json({ itemId, title, ebayTitle, price, suggestedEbayPrice: suggestedPrice, estimatedProfit, ebayDescription });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Setup status ──────────────────────────────────────────────────────────────
router.get('/api/setup-status', (req, res) => {
  const tokenExpiry = parseInt(process.env.EBAY_OAUTH_USER_TOKEN_EXPIRY || '0');
  const expSecs     = tokenExpiry ? Math.max(0, Math.floor((tokenExpiry - Date.now()) / 1000)) : null;
  const listings    = getLocalListings();
  res.json({
    env: {
      required: { EBAY_APP_ID: !!process.env.EBAY_APP_ID, EBAY_OAUTH_CREDENTIALS: !!process.env.EBAY_OAUTH_CREDENTIALS },
      optional: { EBAY_OAUTH_REFRESH_TOKEN: !!process.env.EBAY_OAUTH_REFRESH_TOKEN, SCRAPER_API_KEY: !!process.env.SCRAPER_API_KEY, AMAZON_ACCESS_KEY: !!process.env.AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY: !!process.env.AMAZON_SECRET_KEY, AMAZON_ASSOCIATE_TAG: !!process.env.AMAZON_ASSOCIATE_TAG },
    },
    token: {
      hasAccessToken:  !!process.env.EBAY_OAUTH_USER_TOKEN,
      hasRefreshToken: !!process.env.EBAY_OAUTH_REFRESH_TOKEN,
      expiresInSeconds: expSecs,
      status: !process.env.EBAY_OAUTH_USER_TOKEN && !process.env.EBAY_OAUTH_REFRESH_TOKEN ? 'not_connected' : expSecs !== null && expSecs < 300 ? 'expiring_soon' : 'ok',
    },
    policies: getCachedPolicyIds() || null,
    stats: { published: listings.filter(l => l.status === 'PUBLISHED').length, total: listings.length },
  });
});

// ── Policies ──────────────────────────────────────────────────────────────────
router.get('/api/policies', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  const headers = { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' };
  try {
    const [payRes, retRes, fulRes] = await Promise.all([
      axios.get('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US', { headers }),
      axios.get('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US', { headers }),
      axios.get('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US', { headers }),
    ]);
    res.json({
      paymentPolicies:     (payRes.data.paymentPolicies     || []).map(p => ({ id: p.paymentPolicyId,     name: p.name })),
      returnPolicies:      (retRes.data.returnPolicies      || []).map(p => ({ id: p.returnPolicyId,      name: p.name })),
      fulfillmentPolicies: (fulRes.data.fulfillmentPolicies || []).map(p => ({ id: p.fulfillmentPolicyId, name: p.name })),
      current: getCachedPolicyIds(),
    });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Activity log ──────────────────────────────────────────────────────────────
router.get('/api/activity', (req, res) => {
  try { res.json({ entries: getActivity(parseInt(req.query.limit) || 200) }); }
  catch (e) { res.json({ entries: [] }); }
});

// ── Setup location ────────────────────────────────────────────────────────────
router.post('/api/setup-location', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected. Visit /auth/ebay' }); }
  try {
    await axios.post(
      'https://api.ebay.com/sell/inventory/v1/location/' + LOCATION_KEY,
      { location: { address: { addressLine1: req.body.addressLine1 || '123 Main St', city: req.body.city || 'Atlanta', stateOrProvince: req.body.state || 'GA', postalCode: req.body.zip || '30301', country: 'US' } }, name: 'Justice Den', merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE'] },
      { headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Language': 'en-US' } }
    );
    res.json({ success: true, locationKey: LOCATION_KEY, message: 'Inventory location created: ' + LOCATION_KEY });
  } catch (err) {
    const detail = err.response ? err.response.data : err.message;
    if (JSON.stringify(detail).includes('already exist')) return res.json({ success: true, locationKey: LOCATION_KEY, message: 'Location already exists.' });
    res.status(500).json({ error: err.message, details: detail });
  }
});

// ── Export / backup ───────────────────────────────────────────────────────────
router.get('/api/export/:type', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json');
  if (req.params.type === 'listings') {
    res.setHeader('Content-Disposition', `attachment; filename=jd-listings-${stamp}.json`);
    return res.send(JSON.stringify(getLocalListings(), null, 2));
  }
  const map = { blocklist: BLOCKLIST_FILE, repricer: REPRICER_FILE };
  const fp  = map[req.params.type];
  if (!fp) return res.status(400).json({ error: 'Valid types: listings, blocklist, repricer' });
  try {
    res.setHeader('Content-Disposition', `attachment; filename=jd-${req.params.type}-${stamp}.json`);
    res.send(fs.readFileSync(fp, 'utf8'));
  } catch (e) { res.status(404).json({ error: 'File not found or empty' }); }
});

router.post('/api/export/queue', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename=jd-queue-${stamp}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(req.body.queue || [], null, 2));
});

// ── Image gallery ─────────────────────────────────────────────────────────────
router.get('/api/images', (req, res) => {
  try { res.json({ images: JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf8')) }); }
  catch (e) { res.json({ images: [] }); }
});

router.post('/api/images/add', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  let images = [];
  try { images = JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf8')); } catch (e) {}
  if (images.find(i => i.hostedUrl === url)) return res.json({ success: true, message: 'Already in gallery' });
  images.unshift({ hostedUrl: url, originalUrl: 'manual', savedAt: new Date().toISOString() });
  fs.writeFileSync(IMAGES_FILE, JSON.stringify(images, null, 2));
  res.json({ success: true, total: images.length });
});

router.delete('/api/images/:index', (req, res) => {
  try {
    const images = JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf8'));
    images.splice(parseInt(req.params.index), 1);
    fs.writeFileSync(IMAGES_FILE, JSON.stringify(images, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/rehost-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  try {
    const hosted = await reHostImage(url);
    res.json({ originalUrl: url, hostedUrl: hosted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const hosted = await uploadBufferToImgBB(req.file.buffer);
    console.log('File uploaded:', hosted);
    saveHostedImage('file-upload', hosted);
    res.json({ hostedUrl: hosted });
  } catch (e) {
    console.log('File upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/api/health', (req, res) => {
  const expiry = parseInt(process.env.EBAY_OAUTH_USER_TOKEN_EXPIRY || '0', 10);
  res.json({
    status:  'ok',
    uptime:  Math.floor(process.uptime()),
    db:      getDbStats(),
    token: {
      hasAccessToken:  !!process.env.EBAY_OAUTH_USER_TOKEN,
      hasRefreshToken: !!process.env.EBAY_OAUTH_REFRESH_TOKEN,
      expiresInSeconds: expiry ? Math.max(0, Math.floor((expiry - Date.now()) / 1000)) : null,
    },
    scheduler: {
      repricer:   { intervalMinutes: parseInt(process.env.REPRICER_INTERVAL_MINUTES   || '1440', 10) },
      stockCheck: { intervalMinutes: parseInt(process.env.STOCK_CHECK_INTERVAL_MINUTES || '360',  10) },
      priceWatch: { intervalMinutes: parseInt(process.env.PRICE_WATCH_INTERVAL_MINUTES || '360',  10) },
    },
    mem: { heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) },
  });
});

// ── Profit summary ────────────────────────────────────────────────────────────
router.get('/api/profit-summary', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  try {
    const headers  = { 'Authorization': 'Bearer ' + token };
    // Fetch up to 200 orders (eBay max per call is 50, paginate twice)
    const pages    = await Promise.all([
      axios.get('https://api.ebay.com/sell/fulfillment/v1/order?limit=50&offset=0',  { headers }).catch(() => ({ data: { orders: [] } })),
      axios.get('https://api.ebay.com/sell/fulfillment/v1/order?limit=50&offset=50', { headers }).catch(() => ({ data: { orders: [] } })),
      axios.get('https://api.ebay.com/sell/fulfillment/v1/order?limit=50&offset=100',{ headers }).catch(() => ({ data: { orders: [] } })),
      axios.get('https://api.ebay.com/sell/fulfillment/v1/order?limit=50&offset=150',{ headers }).catch(() => ({ data: { orders: [] } })),
    ]);
    const orders   = pages.flatMap(p => p.data.orders || []);
    const listings = getLocalListings();

    let grossRevenue = 0;
    let estimatedCogs = 0;
    let estimatedFees = 0;
    let orderCount    = 0;
    const byMonth     = {};

    for (const order of orders) {
      if (order.orderPaymentStatus !== 'PAID') continue;
      orderCount++;
      const total = parseFloat(order.pricingSummary && order.pricingSummary.total ? order.pricingSummary.total.value : 0);
      grossRevenue += total;
      const fee = total * 0.1325 + 0.30;
      estimatedFees += fee;

      // Estimate COGS from Amazon price stored on the local listing
      for (const li of (order.lineItems || [])) {
        const local = listings.find(l => l.listingId === li.legacyItemId);
        if (local && local.lastAmazonPrice) estimatedCogs += local.lastAmazonPrice * (li.quantity || 1);
        else if (local && local.originalPrice) estimatedCogs += parseFloat(local.originalPrice) * 0.6 * (li.quantity || 1); // rough estimate: 60% of original list price
      }

      // Group by month (YYYY-MM)
      const month = (order.creationDate || '').slice(0, 7);
      if (month) {
        if (!byMonth[month]) byMonth[month] = { revenue: 0, orders: 0 };
        byMonth[month].revenue += total;
        byMonth[month].orders++;
      }
    }

    const estimatedProfit = grossRevenue - estimatedCogs - estimatedFees;
    const margin          = grossRevenue > 0 ? (estimatedProfit / grossRevenue) * 100 : 0;

    res.json({
      orderCount,
      grossRevenue:     parseFloat(grossRevenue.toFixed(2)),
      estimatedCogs:    parseFloat(estimatedCogs.toFixed(2)),
      estimatedFees:    parseFloat(estimatedFees.toFixed(2)),
      estimatedProfit:  parseFloat(estimatedProfit.toFixed(2)),
      marginPct:        parseFloat(margin.toFixed(1)),
      byMonth:          Object.entries(byMonth).sort(([a], [b]) => b.localeCompare(a)).map(([month, d]) => ({ month, ...d, revenue: parseFloat(d.revenue.toFixed(2)) })),
      note: 'COGS estimated from lastAmazonPrice or 60% of original listing price where Amazon data unavailable.',
    });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

module.exports = router;
