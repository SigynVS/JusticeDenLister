'use strict';
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { getAppToken, getUserToken } = require('./ebay-auth');
const { reHostImage }               = require('./ebay-utils');
const { saveListingRecord, logActivity } = require('./db');

// ── Constants ─────────────────────────────────────────────────────────────────
const LOCATION_KEY     = 'justice-den-main';
const POLICY_IDS_FILE  = path.join(__dirname, '..', 'policy-ids.json');

// ── Policy cache ──────────────────────────────────────────────────────────────
let cachedPolicyIds = null;
try {
  cachedPolicyIds = JSON.parse(fs.readFileSync(POLICY_IDS_FILE, 'utf8'));
  console.log('Policy IDs loaded from file.');
} catch (e) {}

function getCachedPolicyIds() { return cachedPolicyIds; }

async function getPolicyIds(token) {
  if (cachedPolicyIds) return cachedPolicyIds;
  const headers = { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' };
  const [payRes, retRes, fulRes] = await Promise.all([
    axios.get('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US', { headers }),
    axios.get('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US', { headers }),
    axios.get('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US', { headers }),
  ]);
  const pay = payRes.data.paymentPolicies || [];
  const ret = retRes.data.returnPolicies  || [];
  const ful = fulRes.data.fulfillmentPolicies || [];
  if (!pay.length) throw new Error('No payment policies found — create one in eBay Seller Hub under Account > Payments');
  if (!ret.length) throw new Error('No return policies found — create one in eBay Seller Hub under Account > Returns');
  if (!ful.length) throw new Error('No fulfillment policies found — create one in eBay Seller Hub under Account > Shipping');
  if (pay.length > 1) console.warn('Multiple payment policies found; using first:', pay[0].name);
  if (ret.length > 1) console.warn('Multiple return policies found; using first:', ret[0].name);
  if (ful.length > 1) console.warn('Multiple fulfillment policies found; using first:', ful[0].name);
  cachedPolicyIds = {
    paymentPolicyId:     pay[0].paymentPolicyId,
    returnPolicyId:      ret[0].returnPolicyId,
    fulfillmentPolicyId: ful[0].fulfillmentPolicyId,
  };
  try { fs.writeFileSync(POLICY_IDS_FILE, JSON.stringify(cachedPolicyIds)); } catch (e) {}
  return cachedPolicyIds;
}

// ── Category lookup ───────────────────────────────────────────────────────────
const categoryCache     = new Map();
const CATEGORY_CACHE_TTL = 24 * 60 * 60 * 1000;

async function getCategoryId(title) {
  const key = title.toLowerCase().trim();
  const cached = categoryCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.id;
  try {
    const token = await getAppToken();
    const r = await axios.get(
      'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=' + encodeURIComponent(title),
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const suggestions = r.data.categorySuggestions || [];
    suggestions.sort((a, b) => (b.categoryTreeNodeAncestors || []).length - (a.categoryTreeNodeAncestors || []).length);
    const id = suggestions[0].category.categoryId;
    categoryCache.set(key, { id, expires: Date.now() + CATEGORY_CACHE_TTL });
    return id;
  } catch (e) {
    return '175672'; // fallback category
  }
}

// ── Paginated eBay fetchers ───────────────────────────────────────────────────
async function fetchAllInventoryItems(headers) {
  const items  = [];
  let offset   = 0;
  const limit  = 100;
  while (true) {
    const res = await axios.get(
      `https://api.ebay.com/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`,
      { headers }
    );
    const batch = res.data.inventoryItems || [];
    items.push(...batch);
    const total = res.data.total || 0;
    if (batch.length < limit || items.length >= total) break;
    offset += limit;
  }
  return items;
}

async function fetchAllOffers(headers) {
  const offers = [];
  let offset   = 0;
  const limit  = 100;
  while (true) {
    const res = await axios.get(
      `https://api.ebay.com/sell/inventory/v1/offer?marketplace_id=EBAY_US&limit=${limit}&offset=${offset}`,
      { headers }
    ).catch(() => ({ data: { offers: [], total: 0 } }));
    const batch = res.data.offers || [];
    offers.push(...batch);
    const total = res.data.total || 0;
    if (batch.length < limit || offers.length >= total) break;
    offset += limit;
  }
  return offers;
}

// ── Item specifics helpers ────────────────────────────────────────────────────
const COLOR_WORDS_SERVER = [
  'black','white','blue','red','green','gold','silver','gray','grey','pink',
  'purple','orange','yellow','navy','brown','beige','rose gold','midnight',
  'charcoal','space gray','space grey','titanium','champagne','cream','teal',
  'aqua','coral','graphite',
];

function extractColorServer(title) {
  const t = (title || '').toLowerCase();
  for (const c of ['rose gold','space gray','space grey']) {
    if (t.includes(c)) return c.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  for (const c of COLOR_WORDS_SERVER) {
    if (new RegExp('\\b' + c + '\\b').test(t)) return c[0].toUpperCase() + c.slice(1);
  }
  return null;
}

function extractConnectivity(title) {
  const t = (title || '').toLowerCase();
  const parts = [];
  if (t.includes('wi-fi') || t.includes('wifi') || t.includes('wireless') || t.includes('mesh') || t.includes('router') || t.includes('extender') || t.includes('hotspot')) parts.push('Wi-Fi');
  if (t.includes('bluetooth')) parts.push('Bluetooth');
  if (t.includes('ethernet') || t.includes('wired') || t.includes(' lan ')) parts.push('Ethernet');
  if (t.includes('usb-c') || t.includes('usb c') || t.includes('type-c')) parts.push('USB Type C');
  else if (t.includes('usb')) parts.push('USB');
  if (t.includes('hdmi')) parts.push('HDMI');
  if (t.includes('aux') || t.includes('3.5mm')) parts.push('3.5mm Audio Jack');
  if (t.includes('nfc')) parts.push('NFC');
  if (t.includes('zigbee')) parts.push('Zigbee');
  if (t.includes('z-wave')) parts.push('Z-Wave');
  return parts.length ? parts[0] : 'Wi-Fi';
}

const SPECIFIC_DEFAULTS = {
  'Color':                         (title) => extractColorServer(title) || 'Black',
  'Connectivity':                  (title) => extractConnectivity(title),
  'Connectivity Technology':       (title) => extractConnectivity(title),
  'Brand':                         ()      => 'Unbranded',
  'Model':                         ()      => 'Does Not Apply',
  'Type':                          ()      => 'Standard',
  'Size':                          ()      => 'One Size',
  'Unit Quantity':                 ()      => '1',
  'Unit Type':                     ()      => 'Unit',
  'Number of Items':               ()      => '1',
  'Material':                      ()      => 'Mixed Materials',
  'Style':                         ()      => 'Standard',
  'Item Height':                   ()      => 'Does Not Apply',
  'Item Width':                    ()      => 'Does Not Apply',
  'Item Weight':                   ()      => 'Does Not Apply',
  'Surface Recommendation':        ()      => 'All Surfaces',
  'Features':                      ()      => 'Portable',
  'Age Range':                     ()      => 'Adult',
  'Gender':                        ()      => 'Unisex',
  'Occasion':                      ()      => 'Casual',
  'Season':                        ()      => 'All Season',
  'Country/Region of Manufacture': ()      => 'China',
  'Compatible Brand':              ()      => 'Does Not Apply',
  'Compatible Model':              ()      => 'Does Not Apply',
  'Interface':                     ()      => 'USB',
  'Connection':                    ()      => 'Wireless',
  'Keyboard Layout':               ()      => 'QWERTY',
  'Number of Keys':                ()      => 'Does Not Apply',
  'Switch Type':                   ()      => 'Does Not Apply',
};

function parseMissingSpecifics(ebayErrors) {
  const missing = new Set();
  for (const err of (ebayErrors || [])) {
    if (err.parameters) {
      for (const p of err.parameters) {
        if (p.name === 'fieldName' && p.value) missing.add(p.value);
      }
    }
    const m = (err.message || '').match(/item specific (.+?) is missing/i);
    if (m) missing.add(m[1].trim());
  }
  return [...missing];
}

// ── Core listing creator ──────────────────────────────────────────────────────
async function createOneListing(body, token) {
  const { title, description, price, condition, quantity, category, type, imageUrl, weight, mpn, countryMfg, upc, itemSpecifics, asin, sourceUrl } = body;
  const sku = 'JD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
  const qty = parseInt(quantity) || 1;
  const userHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };

  const [categoryId, policies, hostedImageUrl] = await Promise.all([
    category ? Promise.resolve(category) : getCategoryId(title),
    getPolicyIds(token),
    reHostImage(imageUrl),
  ]);

  const resolvedMpn = mpn || 'Does Not Apply';
  const aspects = { 'Brand': ['Unbranded'], 'Type': [type || 'Standard'], 'MPN': [resolvedMpn], 'Country/Region of Manufacture': [countryMfg || 'China'] };
  if (itemSpecifics) {
    for (const line of itemSpecifics.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) { const k = line.slice(0, eq).trim(); const v = line.slice(eq + 1).trim(); if (k && v) aspects[k] = [v]; }
    }
  }

  const buildProductPayload = (asp) => {
    const p = { title, description: description || title, aspects: asp, brand: 'Unbranded', mpn: resolvedMpn, imageUrls: hostedImageUrl ? [hostedImageUrl] : [] };
    if (upc && upc.trim()) { p.upc = [upc.trim()]; } else { p.upc = ['Does Not Apply']; p.ean = ['Does Not Apply']; }
    return p;
  };

  await axios.put(
    'https://api.ebay.com/sell/inventory/v1/inventory_item/' + sku,
    { availability: { shipToLocationAvailability: { quantity: qty } }, condition: condition || 'NEW', product: buildProductPayload(aspects), packageWeightAndSize: { dimensions: { height: 4, length: 10, width: 6, unit: 'INCH' }, weight: { value: parseFloat(weight) || 1, unit: 'POUND' } } },
    { headers: userHeaders }
  );

  const offerRes = await axios.post(
    'https://api.ebay.com/sell/inventory/v1/offer',
    { sku, marketplaceId: 'EBAY_US', format: 'FIXED_PRICE', availableQuantity: qty, categoryId, listingDescription: description || title, listingPolicies: policies, merchantLocationKey: LOCATION_KEY, pricingSummary: { price: { value: String(parseFloat(price) || 9.99), currency: 'USD' } }, tax: { applyTax: true, vatPercentage: 0 }, includeCatalogProductDetails: false },
    { headers: userHeaders }
  );
  const offerId = offerRes.data.offerId;

  // Try to publish — auto-retry once if eBay reports missing item specifics
  let publishRes;
  try {
    publishRes = await axios.post('https://api.ebay.com/sell/inventory/v1/offer/' + offerId + '/publish', {}, { headers: userHeaders });
  } catch (pubErr) {
    const ebayErrors = pubErr.response && pubErr.response.data && pubErr.response.data.errors;
    const missing = parseMissingSpecifics(ebayErrors);
    if (missing.length > 0) {
      const added = [];
      for (const spec of missing) {
        if (!aspects[spec]) {
          const defaultFn = SPECIFIC_DEFAULTS[spec];
          aspects[spec] = [defaultFn ? defaultFn(title) : 'Does Not Apply'];
          added.push(spec + '=' + aspects[spec][0]);
        }
      }
      console.log(`[autofix] Added missing specifics for "${title}":`, added.join(', '));
      await axios.put(
        'https://api.ebay.com/sell/inventory/v1/inventory_item/' + sku,
        { availability: { shipToLocationAvailability: { quantity: qty } }, condition: condition || 'NEW', product: buildProductPayload(aspects), packageWeightAndSize: { dimensions: { height: 4, length: 10, width: 6, unit: 'INCH' }, weight: { value: parseFloat(weight) || 1, unit: 'POUND' } } },
        { headers: userHeaders }
      );
      try {
        publishRes = await axios.post('https://api.ebay.com/sell/inventory/v1/offer/' + offerId + '/publish', {}, { headers: userHeaders });
      } catch (retryErr) {
        try { await axios.delete('https://api.ebay.com/sell/inventory/v1/offer/' + offerId, { headers: userHeaders }); } catch (e) {}
        try { await axios.delete('https://api.ebay.com/sell/inventory/v1/inventory_item/' + sku, { headers: userHeaders }); } catch (e) {}
        throw retryErr;
      }
    } else {
      try { await axios.delete('https://api.ebay.com/sell/inventory/v1/offer/' + offerId, { headers: userHeaders }); } catch (e) { console.log('[cleanup] Could not delete offer:', e.message); }
      try { await axios.delete('https://api.ebay.com/sell/inventory/v1/inventory_item/' + sku, { headers: userHeaders }); } catch (e) { console.log('[cleanup] Could not delete inventory item:', e.message); }
      throw pubErr;
    }
  }

  const listingId = publishRes.data.listingId;
  const ebayUrl   = 'https://www.ebay.com/itm/' + listingId;
  saveListingRecord({ sku, offerId, listingId, title, price: String(parseFloat(price) || 9.99), originalPrice: String(parseFloat(price) || 9.99), imageUrl: hostedImageUrl || imageUrl || '', category: categoryId, status: 'PUBLISHED', ebayUrl, asin: asin || null, sourceUrl: sourceUrl || (asin ? 'https://www.amazon.com/dp/' + asin : null) });
  logActivity('listed', { sku, title, price: String(parseFloat(price) || 9.99), listingId, ebayUrl });
  return { success: true, sku, offerId, listingId, ebayUrl, message: 'Live on eBay! Listing ID: ' + listingId };
}

module.exports = {
  LOCATION_KEY,
  POLICY_IDS_FILE,
  getCachedPolicyIds,
  getPolicyIds,
  getCategoryId,
  categoryCache,
  CATEGORY_CACHE_TTL,
  fetchAllInventoryItems,
  fetchAllOffers,
  extractColorServer,
  extractConnectivity,
  SPECIFIC_DEFAULTS,
  parseMissingSpecifics,
  createOneListing,
};
