'use strict';
const express = require('express');
const axios   = require('axios');
const { getUserToken }                          = require('../lib/ebay-auth');
const { ebayErrDetail, reHostImage, isAllowedImageHost } = require('../lib/ebay-utils');
const { fetchAllInventoryItems, fetchAllOffers, getCategoryId, createOneListing, CATEGORY_CACHE_TTL } = require('../lib/ebay-listing');
const { getBlocklist, saveBlocklist, BLOCKLIST_FILE, checkProductSafety } = require('../lib/product-safety');
const { getLocalListings, saveListingRecord, updateListingRecord, deleteListingRecord, logActivity, upsertAllListings, getPriceHistory } = require('../lib/db');
const { runStockCheck, runAutoRepricer } = require('../lib/jobs');
const fs   = require('fs');
const path = require('path');

const router = express.Router();

const REPRICER_FILE = path.join(__dirname, '..', 'repricer-settings.json');
function getRepricerSettings() {
  try { return JSON.parse(fs.readFileSync(REPRICER_FILE, 'utf8')); }
  catch (e) { return { enabled: false, dropPercent: 5, floorPercent: 20, daysThreshold: 7 }; }
}

// ── Category helpers ──────────────────────────────────────────────────────────
const { getAppToken } = require('../lib/ebay-auth');
const categorySuggestionsCache = new Map();

router.get('/api/category-suggestions', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });
  const key    = q.toLowerCase().trim();
  const cached = categorySuggestionsCache.get(key);
  if (cached && Date.now() < cached.expires) return res.json(cached.data);
  try {
    const token = await getAppToken();
    const r     = await axios.get(
      'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=' + encodeURIComponent(q),
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const suggestions = (r.data.categorySuggestions || []).slice(0, 8).map(s => ({
      id:   s.category.categoryId,
      name: s.category.categoryName,
      path: (s.categoryTreeNodeAncestors || []).reverse().map(a => a.categoryName).join(' > ') + ' > ' + s.category.categoryName,
      depth: (s.categoryTreeNodeAncestors || []).length,
    }));
    suggestions.sort((a, b) => b.depth - a.depth);
    const data = { suggestions };
    categorySuggestionsCache.set(key, { data, expires: Date.now() + CATEGORY_CACHE_TTL });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/category-aspects', async (req, res) => {
  const { category_id } = req.query;
  if (!category_id) return res.status(400).json({ error: 'category_id required' });
  try {
    const token = await getAppToken();
    const r     = await axios.get(
      'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=' + encodeURIComponent(category_id),
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const aspects = (r.data.aspects || [])
      .filter(a => a.aspectConstraint && a.aspectConstraint.aspectRequired)
      .map(a => ({ name: a.localizedAspectName, values: a.aspectValues ? a.aspectValues.slice(0, 5).map(v => v.localizedValue) : [] }));
    res.json({ aspects });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Live eBay listings ────────────────────────────────────────────────────────
router.get('/api/listings', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  try {
    const headers = { 'Authorization': 'Bearer ' + token };
    const [items, allOffers] = await Promise.all([fetchAllInventoryItems(headers), fetchAllOffers(headers)]);
    const offersBySku = {};
    for (const o of allOffers) { if (!offersBySku[o.sku]) offersBySku[o.sku] = o; }
    const withOffers = items.map(item => ({
      sku:      item.sku,
      title:    item.product ? item.product.title : item.sku,
      imageUrl: item.product && item.product.imageUrls ? item.product.imageUrls[0] : null,
      condition: item.condition,
      offer:    offersBySku[item.sku] || null,
    }));
    res.json({ listings: withOffers });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Update listing ────────────────────────────────────────────────────────────
router.put('/api/update-listing', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  const { sku, offerId, title, description, price, condition, quantity, category, type, imageUrl, weight, mpn, countryMfg, upc, itemSpecifics } = req.body;
  if (!sku) return res.status(400).json({ error: 'SKU required' });
  const userHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };
  try {
    const hostedImageUrl = imageUrl ? await reHostImage(imageUrl).catch(() => imageUrl) : null;
    const resolvedMpn    = mpn || 'Does Not Apply';
    const aspects = { 'Brand': ['Unbranded'], 'Type': [type || 'Standard'], 'MPN': [resolvedMpn], 'Country/Region of Manufacture': [countryMfg || 'China'] };
    if (itemSpecifics) {
      for (const line of itemSpecifics.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) { const k = line.slice(0, eq).trim(); const v = line.slice(eq + 1).trim(); if (k && v) aspects[k] = [v]; }
      }
    }
    const productPayload = { title, description: description || title, aspects, brand: 'Unbranded', mpn: resolvedMpn };
    if (hostedImageUrl) productPayload.imageUrls = [hostedImageUrl];
    if (upc && upc.trim()) productPayload.upc = [upc.trim()]; else productPayload.ean = ['Does Not Apply'];
    await axios.put(
      'https://api.ebay.com/sell/inventory/v1/inventory_item/' + sku,
      { availability: { shipToLocationAvailability: { quantity: parseInt(quantity) || 1 } }, condition: condition || 'NEW', product: productPayload, packageWeightAndSize: { dimensions: { height: 4, length: 10, width: 6, unit: 'INCH' }, weight: { value: parseFloat(weight) || 1, unit: 'POUND' } } },
      { headers: userHeaders }
    );
    if (offerId) {
      await axios.put(
        'https://api.ebay.com/sell/inventory/v1/offer/' + offerId,
        { availableQuantity: parseInt(quantity) || 1, listingDescription: description || title, pricingSummary: { price: { value: String(parseFloat(price) || 9.99), currency: 'USD' } } },
        { headers: userHeaders }
      );
    }
    updateListingRecord(sku, { title, price: String(parseFloat(price) || 9.99), imageUrl: hostedImageUrl || imageUrl || '' });
    logActivity('updated', { sku, title, price: String(parseFloat(price) || 9.99) });
    res.json({ success: true, sku, offerId, message: 'Listing updated!' });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Delete listing ────────────────────────────────────────────────────────────
router.delete('/api/delete-listing/:sku', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  const { sku } = req.params;
  const { offerId, status } = req.query;
  const headers = { 'Authorization': 'Bearer ' + token };
  const results = [];
  try {
    if (offerId) {
      if (status === 'PUBLISHED') { await axios.post('https://api.ebay.com/sell/inventory/v1/offer/' + offerId + '/withdraw', {}, { headers }); results.push('Listing withdrawn'); }
      await axios.delete('https://api.ebay.com/sell/inventory/v1/offer/' + offerId, { headers }); results.push('Offer deleted');
    }
    await axios.delete('https://api.ebay.com/sell/inventory/v1/inventory_item/' + sku, { headers }); results.push('Inventory item deleted');
    deleteListingRecord(sku);
    logActivity('deleted', { sku, results });
    res.json({ success: true, sku, results });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Cleanup unpublished ───────────────────────────────────────────────────────
router.post('/api/cleanup-unpublished', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  const headers = { 'Authorization': 'Bearer ' + token };
  try {
    const itemsRes = await axios.get('https://api.ebay.com/sell/inventory/v1/inventory_item?limit=100', { headers });
    const items    = itemsRes.data.inventoryItems || [];
    const deleted = [], skipped = [], errors = [];
    for (const item of items) {
      try {
        let offerRes;
        try { offerRes = await axios.get('https://api.ebay.com/sell/inventory/v1/offer?sku=' + encodeURIComponent(item.sku) + '&marketplace_id=EBAY_US', { headers }); }
        catch (e) { offerRes = { data: { offers: [] } }; }
        const offers    = offerRes.data.offers || [];
        const published = offers.find(o => o.status === 'PUBLISHED');
        if (published) { skipped.push(item.sku); continue; }
        for (const offer of offers) await axios.delete('https://api.ebay.com/sell/inventory/v1/offer/' + offer.offerId, { headers });
        await axios.delete('https://api.ebay.com/sell/inventory/v1/inventory_item/' + item.sku, { headers });
        deleted.push(item.sku);
      } catch (e) { errors.push({ sku: item.sku, error: e.message }); }
    }
    res.json({ success: true, deleted, skipped, errors, message: 'Deleted ' + deleted.length + ' unpublished listing(s), kept ' + skipped.length + ' published.' });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Local listings (SQLite) ───────────────────────────────────────────────────
router.get('/api/local-listings', (req, res) => res.json({ listings: getLocalListings() }));

// ── Sync from eBay → local ────────────────────────────────────────────────────
router.post('/api/sync-to-local', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  try {
    const headers  = { 'Authorization': 'Bearer ' + token };
    const items    = await fetchAllInventoryItems(headers);
    const listings = await Promise.all(items.map(async (item) => {
      try {
        const offerRes = await axios.get('https://api.ebay.com/sell/inventory/v1/offer?sku=' + encodeURIComponent(item.sku) + '&marketplace_id=EBAY_US', { headers });
        const offer    = offerRes.data.offers && offerRes.data.offers[0] ? offerRes.data.offers[0] : null;
        const listingId = offer && offer.listing ? offer.listing.listingId : null;
        return { sku: item.sku, offerId: offer ? offer.offerId : '', listingId: listingId || '', title: item.product ? item.product.title : item.sku, price: offer && offer.pricingSummary && offer.pricingSummary.price ? offer.pricingSummary.price.value : '', imageUrl: item.product && item.product.imageUrls ? item.product.imageUrls[0] : '', category: offer ? offer.categoryId : '', status: offer ? offer.status : 'NO_OFFER', ebayUrl: listingId ? 'https://www.ebay.com/itm/' + listingId : '', createdAt: new Date().toISOString() };
      } catch (e) {
        return { sku: item.sku, title: item.product ? item.product.title : item.sku, status: 'NO_OFFER', price: '', imageUrl: '', offerId: '', listingId: '', ebayUrl: '', createdAt: new Date().toISOString() };
      }
    }));
    upsertAllListings(listings);
    res.json({ listings, synced: listings.length });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Blocklist ─────────────────────────────────────────────────────────────────
router.get('/api/blocklist',  (req, res) => res.json(getBlocklist()));

router.post('/api/blocklist', (req, res) => {
  const current = getBlocklist();
  const { action, type, value } = req.body;
  if (!action || !type || !value) return res.status(400).json({ error: 'action, type, value required' });
  const v = value.trim().toLowerCase();
  if (!v) return res.status(400).json({ error: 'value cannot be empty' });
  if (!['brands','keywords','asins'].includes(type)) return res.status(400).json({ error: 'type must be brands, keywords, or asins' });
  if (action === 'add') { if (!current[type].includes(v)) current[type].push(v); }
  else if (action === 'remove') { current[type] = current[type].filter(x => x !== v); }
  else return res.status(400).json({ error: 'action must be add or remove' });
  saveBlocklist(current);
  res.json({ success: true, blocklist: current });
});

// ── Duplicate check ───────────────────────────────────────────────────────────
router.post('/api/check-duplicate', (req, res) => {
  const { title } = req.body;
  if (!title) return res.json({ duplicates: [] });
  const listings = getLocalListings();
  function words(s) { return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2); }
  function similarity(a, b) {
    const wa = new Set(words(a)); const wb = new Set(words(b));
    const intersection = [...wa].filter(w => wb.has(w)).length;
    const minSize = Math.min(wa.size, wb.size);
    return minSize === 0 ? 0 : intersection / minSize;
  }
  const THRESHOLD  = 0.55;
  const duplicates = listings
    .map(l => ({ listing: l, score: similarity(title, l.title || '') }))
    .filter(({ score }) => score >= THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ listing, score }) => ({ sku: listing.sku, title: listing.title, price: listing.price, ebayUrl: listing.ebayUrl, score: Math.round(score * 100) }));
  res.json({ duplicates });
});

// ── Create listing ────────────────────────────────────────────────────────────
router.post('/api/create-listing', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected (' + err.message + '). Visit /auth/ebay' }); }
  try {
    const result = await createOneListing(req.body, token);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Title SEO scorer ──────────────────────────────────────────────────────────
router.post('/api/score-title', (req, res) => {
  const { title } = req.body;
  if (!title) return res.json({ score: 0, grade: 'F', tips: ['No title provided'], length: 0 });
  const t = title.trim(); const tl = t.toLowerCase();
  const tips = []; let score = 0;
  const len = t.length;
  if (len >= 60 && len <= 80) score += 25;
  else if (len >= 45 && len < 60) { score += 15; tips.push('📏 Title is ' + len + ' chars — aim for 60-80 to fit more keywords'); }
  else if (len > 80) { score += 18; tips.push('📏 Title is ' + len + ' chars — eBay hard-truncates at 80, check nothing important is cut off'); }
  else { score += 5; tips.push('📏 Title is only ' + len + ' chars — way too short, add model, specs, color, use case'); }
  if (/\bnew\b/.test(tl)) score += 10; else tips.push("✅ Add 'New' at the end — buyers filter by condition and it adds a keyword");
  if (/\d+/.test(t)) score += 15; else tips.push('🔢 Add numbers (watts, inches, pieces, GB, hrs) — buyers search by specs');
  const fillers      = ['and','with','for','the',' a ',' an ','or ','of the','in the','to the'];
  const foundFillers = fillers.filter(w => tl.includes(w));
  if (foundFillers.length === 0) score += 15;
  else if (foundFillers.length <= 2) { score += 10; tips.push('🚮 Trim filler words (' + foundFillers.join(', ').trim() + ') — eBay ignores them in search'); }
  else { score += 3; tips.push('🚮 Too many filler words — replace them with product keywords'); }
  const badChars = (t.match(/[|,!@#$%^&*()\[\]{}]/g) || []).length;
  if (badChars === 0) score += 10;
  else if (badChars <= 2) { score += 6; tips.push('⚠️ Minimize punctuation (' + badChars + ' found) — wastes character space'); }
  else tips.push('⚠️ Too many special characters — clean up the title');
  const ws = t.split(' ').filter(w => w.length > 0);
  const capWords = ws.filter(w => w.length > 3 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()).length;
  if (capWords / ws.length >= 0.5) score += 10; else tips.push('🔤 Capitalize key words — improves click-through rate');
  const riskyBrands = ['apple','nike','samsung','sony','bose','beats','dyson','lego','disney','gucci','rolex'];
  const foundBrand  = riskyBrands.find(b => tl.includes(b));
  if (foundBrand) tips.push("🚨 Contains '" + foundBrand + "' — VeRO risk, eBay may remove this listing");
  else score += 15;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
  if (tips.length === 0) tips.push('🏆 Solid title! No major issues found.');
  res.json({ score, grade, tips, length: len });
});

// ── Repricer ──────────────────────────────────────────────────────────────────
router.get('/api/repricer-settings',  (req, res) => res.json(getRepricerSettings()));

router.post('/api/repricer-settings', (req, res) => {
  const { enabled, dropPercent, floorPercent, daysThreshold } = req.body;
  const errors = [];
  if (dropPercent !== undefined)  { const v = parseFloat(dropPercent);  if (isNaN(v) || v < 0.1 || v > 20)  errors.push('dropPercent must be between 0.1 and 20'); }
  if (floorPercent !== undefined) { const v = parseFloat(floorPercent); if (isNaN(v) || v < 1 || v > 99)    errors.push('floorPercent must be between 1 and 99'); }
  if (daysThreshold !== undefined){ const v = parseInt(daysThreshold, 10); if (isNaN(v) || v < 1 || v > 365) errors.push('daysThreshold must be between 1 and 365'); }
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const current = getRepricerSettings();
  const updated = { ...current, ...(enabled !== undefined ? { enabled: !!enabled } : {}), ...(dropPercent !== undefined ? { dropPercent: parseFloat(dropPercent) } : {}), ...(floorPercent !== undefined ? { floorPercent: parseFloat(floorPercent) } : {}), ...(daysThreshold !== undefined ? { daysThreshold: parseInt(daysThreshold, 10) } : {}) };
  fs.writeFileSync(REPRICER_FILE, JSON.stringify(updated, null, 2));
  res.json({ success: true, settings: updated });
});

router.post('/api/run-auto-repricer', async (req, res) => {
  try {
    const result = await runAutoRepricer({ force: !!req.body.force });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auto-end OOS listings ──────────────────────────────────────────────────────
router.post('/api/auto-end-oos', async (req, res) => {
  try {
    const result = await runStockCheck({ autoEnd: true });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Orders ────────────────────────────────────────────────────────────────────
router.get('/api/orders', async (req, res) => {
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  try {
    const headers  = { 'Authorization': 'Bearer ' + token };
    const r        = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order?limit=50', { headers });
    const listings = getLocalListings();
    const orders   = (r.data.orders || []).map(o => {
      const items = (o.lineItems || []).map(li => {
        const local = listings.find(l => l.listingId === li.legacyItemId) || listings.find(l => l.title && li.title && l.title.substring(0, 30).toLowerCase() === li.title.substring(0, 30).toLowerCase());
        return { title: li.title, quantity: li.quantity, price: li.lineItemCost ? li.lineItemCost.value : null, sourceUrl: local ? local.sourceUrl : null, asin: local ? local.asin : null, listingId: li.legacyItemId };
      });
      const ship = o.fulfillmentStartInstructions && o.fulfillmentStartInstructions[0] ? o.fulfillmentStartInstructions[0].shippingStep : null;
      return { orderId: o.orderId, status: o.orderFulfillmentStatus, paymentStatus: o.orderPaymentStatus, total: o.pricingSummary && o.pricingSummary.total ? o.pricingSummary.total.value : null, buyer: o.buyer ? o.buyer.username : null, createdAt: o.creationDate, shipTo: ship, items };
    });
    res.json({ orders, total: r.data.total || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/submit-tracking', async (req, res) => {
  const { orderId, trackingNumber, carrier } = req.body;
  if (!orderId || !trackingNumber) return res.status(400).json({ error: 'orderId and trackingNumber required' });
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  try {
    const headers   = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    const orderRes  = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order/' + orderId, { headers });
    const lineItems = (orderRes.data.lineItems || []).map(li => ({ lineItemId: li.lineItemId, quantity: li.quantity }));
    await axios.post('https://api.ebay.com/sell/fulfillment/v1/order/' + orderId + '/shipping_fulfillment', { lineItems, shippingCarrierCode: carrier || 'USPS', trackingNumber }, { headers });
    res.json({ success: true, orderId, trackingNumber });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Quick reprice ─────────────────────────────────────────────────────────────
router.post('/api/quick-reprice', async (req, res) => {
  const { sku, offerId, price } = req.body;
  if (!sku || !price) return res.status(400).json({ error: 'sku and price required' });
  let token;
  try { token = await getUserToken(); }
  catch (err) { return res.status(401).json({ error: 'Not connected' }); }
  const userHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };
  try {
    if (offerId) await axios.put('https://api.ebay.com/sell/inventory/v1/offer/' + offerId, { pricingSummary: { price: { value: String(parseFloat(price)), currency: 'USD' } } }, { headers: userHeaders });
    updateListingRecord(sku, { price: String(parseFloat(price)) });
    logActivity('repriced', { sku, newPrice: String(parseFloat(price)) });
    res.json({ success: true, sku, price: parseFloat(price) });
  } catch (err) { res.status(500).json({ error: err.message, details: ebayErrDetail(err) }); }
});

// ── Preflight validator ───────────────────────────────────────────────────────
router.post('/api/validate-listing', (req, res) => {
  const { title, price, imageUrl, category, itemSpecifics, asin, weight } = req.body;
  const errors = [], warnings = [];
  if (!title || !title.trim()) { errors.push({ field: 'title', code: 'REQUIRED', msg: 'Title is required' }); }
  else {
    if (title.length > 80) errors.push({ field: 'title', code: 'TOO_LONG', msg: `Title is ${title.length} chars — eBay max is 80` });
    else if (title.length < 15) warnings.push({ field: 'title', code: 'SHORT', msg: 'Title under 15 chars — more detail improves search ranking' });
    if (title === title.toUpperCase() && /[A-Z]{4}/.test(title)) warnings.push({ field: 'title', code: 'ALL_CAPS', msg: 'All-caps titles can hurt eBay search ranking' });
    if (/[!]{2,}|\${2,}|\*{2,}/.test(title)) warnings.push({ field: 'title', code: 'SPAM', msg: 'Repeated special chars may trigger eBay spam filter' });
  }
  const p = parseFloat(price);
  if (!price || isNaN(p) || p <= 0) { errors.push({ field: 'price', code: 'REQUIRED', msg: 'A positive price is required' }); }
  else {
    if (p < 5) warnings.push({ field: 'price', code: 'VERY_LOW', msg: `$${p.toFixed(2)} — nearly nothing left after eBay fees + shipping` });
    const fee = p * 0.1325 + 0.30;
    if (fee > p * 0.5) warnings.push({ field: 'price', code: 'FEE_HEAVY', msg: `eBay fee (~$${fee.toFixed(2)}) eats over half the sale price` });
  }
  if (!imageUrl || !imageUrl.trim()) { errors.push({ field: 'imageUrl', code: 'REQUIRED', msg: 'Image URL required — eBay rejects listings without one' }); }
  else if (!imageUrl.startsWith('https://')) { errors.push({ field: 'imageUrl', code: 'NOT_HTTPS', msg: 'eBay requires HTTPS image URLs' }); }
  else if (!isAllowedImageHost(imageUrl)) { warnings.push({ field: 'imageUrl', code: 'UNHOSTED', msg: 'Image host not recognised — re-host via Images tab to avoid eBay rejection' }); }
  if (!category || !category.trim()) { warnings.push({ field: 'category', code: 'MISSING', msg: 'No category — eBay will auto-assign, which is often wrong' }); }
  else if (isNaN(parseInt(category))) { errors.push({ field: 'category', code: 'INVALID', msg: 'Category must be a numeric eBay ID (use Find Category button)' }); }
  const w = parseFloat(weight);
  if (!weight || isNaN(w) || w <= 0) warnings.push({ field: 'weight', code: 'MISSING', msg: 'No weight set — shipping will default to 1 lb' });
  else if (w > 70) warnings.push({ field: 'weight', code: 'HEAVY', msg: `${w} lb is heavy — verify your shipping cost` });
  if (!itemSpecifics || !itemSpecifics.trim()) warnings.push({ field: 'itemSpecifics', code: 'EMPTY', msg: 'No item specifics — eBay requires Brand and Type at minimum' });
  const listings = getLocalListings();
  const asinUp   = asin ? asin.trim().toUpperCase() : null;
  if (asinUp) { const dup = listings.find(l => l.asin === asinUp && l.status === 'PUBLISHED'); if (dup) errors.push({ field: 'asin', code: 'DUPLICATE_ASIN', msg: `Already listed as ${dup.sku} — "${(dup.title || '').slice(0, 50)}"` }); }
  if (title && title.trim().length >= 10) {
    const wds = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const tw  = new Set(wds(title));
    const sim = listings.find(l => { if (l.status !== 'PUBLISHED' || !l.title) return false; if (asinUp && l.asin === asinUp) return false; const lw = wds(l.title); const overlap = lw.filter(w => tw.has(w)).length; return lw.length && overlap / Math.max(tw.size, lw.length) > 0.72; });
    if (sim) warnings.push({ field: 'title', code: 'SIMILAR_TITLE', msg: `Similar active listing: "${(sim.title || '').slice(0, 50)}…" (${sim.sku})` });
  }
  const bl = getBlocklist(); const tl = (title || '').toLowerCase();
  for (const brand of bl.brands || []) { if (tl.includes(brand.toLowerCase())) { errors.push({ field: 'title', code: 'BLOCKLIST', msg: `Brand "${brand}" is on your blocklist` }); break; } }
  for (const kw of bl.keywords || [])   { if (tl.includes(kw.toLowerCase()))    { errors.push({ field: 'title', code: 'BLOCKLIST', msg: `Keyword "${kw}" is on your blocklist` }); break; } }
  if (asinUp && (bl.asins || []).map(a => a.toUpperCase()).includes(asinUp)) errors.push({ field: 'asin', code: 'BLOCKLIST', msg: 'ASIN is on your blocklist' });
  res.json({ valid: errors.length === 0, errors, warnings });
});

// ── Price history ─────────────────────────────────────────────────────────────
router.get('/api/price-history/:sku', (req, res) => {
  const history = getPriceHistory(req.params.sku);
  res.json({ sku: req.params.sku, history });
});

module.exports = router;
