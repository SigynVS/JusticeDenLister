'use strict';
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { parseAmazonProductsFromHtml } = require('../lib/amazon-parser');
const { checkProductSafety }          = require('../lib/product-safety');
const { updateListingRecord, getLocalListings } = require('../lib/db');
const { runStockCheck, runPriceWatch } = require('../lib/jobs');

const router = express.Router();

// ── Amazon PA API request builder ─────────────────────────────────────────────
function buildAmazonRequest(asin) {
  const accessKey    = process.env.AMAZON_ACCESS_KEY;
  const secretKey    = process.env.AMAZON_SECRET_KEY;
  const associateTag = process.env.AMAZON_ASSOCIATE_TAG;
  if (!accessKey || !secretKey || !associateTag)
    throw new Error('Amazon PA API keys not configured. Add AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, AMAZON_ASSOCIATE_TAG to .env');

  const host        = 'webservices.amazon.com';
  const region      = 'us-east-1';
  const service     = 'ProductAdvertisingAPI';
  const apiPath     = '/paapi5/getitems';
  const amzTarget   = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems';
  const contentType = 'application/json; charset=utf-8';
  const payload     = JSON.stringify({
    ItemIds: [asin],
    Resources: ['Images.Primary.Large','ItemInfo.Title','ItemInfo.Features','ItemInfo.ByLineInfo','ItemInfo.Classifications','Offers.Listings.Price'],
    PartnerTag: associateTag, PartnerType: 'Associates', Marketplace: 'www.amazon.com',
  });

  const now        = new Date();
  const amzDate    = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp  = amzDate.slice(0, 8);
  const canonicalHeaders =
    'content-encoding:amz-1.0\n' +
    'content-type:' + contentType + '\n' +
    'host:' + host + '\n' +
    'x-amz-date:' + amzDate + '\n' +
    'x-amz-target:' + amzTarget + '\n';
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
  const payloadHash   = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = ['POST', apiPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope  = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign     = ['AWS4-HMAC-SHA256', amzDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac             = (key, data, enc) => crypto.createHmac('sha256', key).update(data).digest(enc);
  const signingKey       = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service), 'aws4_request');
  const signature        = hmac(signingKey, stringToSign, 'hex');
  const authHeader       = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return {
    url: 'https://' + host + apiPath,
    headers: { 'content-encoding': 'amz-1.0', 'content-type': contentType, 'host': host, 'x-amz-date': amzDate, 'x-amz-target': amzTarget, 'Authorization': authHeader },
    payload,
  };
}

// ── Product Finder ─────────────────────────────────────────────────────────────
const AMAZON_CATEGORIES = {
  electronics:  { name: 'Electronics',          url: 'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics/' },
  smarthome:    { name: 'Smart Home',           url: 'https://www.amazon.com/Best-Sellers-Amazon-Devices-Accessories/zgbs/amazon-devices/' },
  computers:    { name: 'Computer Accessories', url: 'https://www.amazon.com/Best-Sellers-Computers-Accessories/zgbs/pc/' },
  audio:        { name: 'Headphones & Audio',   url: 'https://www.amazon.com/Best-Sellers-Electronics-Headphones/zgbs/electronics/172541/' },
  wearables:    { name: 'Smart Watches',        url: 'https://www.amazon.com/Best-Sellers-Clothing-Shoes-Jewelry-Smart-Watches/zgbs/fashion/7939901011/' },
  cameras:      { name: 'Security Cameras',     url: 'https://www.amazon.com/Best-Sellers-Electronics-Security-Surveillance/zgbs/electronics/667846011/' },
  pcgaming:     { name: 'PC Gaming',            url: 'https://www.amazon.com/Best-Sellers-PC-Gaming-Equipment/zgbs/electronics/318813011/' },
  office:       { name: 'Office Electronics',   url: 'https://www.amazon.com/Best-Sellers-Office-Products-Office-Electronics/zgbs/office-products/172635011/' },
  home:         { name: 'Home & Kitchen',       url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/kitchen/' },
  tools:        { name: 'Tools & Improvement',  url: 'https://www.amazon.com/Best-Sellers-Tools-Home-Improvement/zgbs/hi/' },
  patio:        { name: 'Patio & Garden',       url: 'https://www.amazon.com/Best-Sellers-Patio-Lawn-Garden/zgbs/lawn-garden/' },
  lighting:     { name: 'Lighting',             url: 'https://www.amazon.com/Best-Sellers-Tools-Home-Improvement-Lamps-Shades/zgbs/hi/1063498/' },
  sports:       { name: 'Sports & Outdoors',    url: 'https://www.amazon.com/Best-Sellers-Sports-Outdoors/zgbs/sporting-goods/' },
  health:       { name: 'Health & Household',   url: 'https://www.amazon.com/Best-Sellers-Health-Personal-Care/zgbs/hpc/' },
  toys:         { name: 'Toys & Games',         url: 'https://www.amazon.com/Best-Sellers-Toys-Games/zgbs/toys-and-games/' },
  automotive:   { name: 'Automotive',           url: 'https://www.amazon.com/Best-Sellers-Automotive/zgbs/automotive/' },
  pet:          { name: 'Pet Supplies',         url: 'https://www.amazon.com/Best-Sellers-Pet-Supplies/zgbs/pet-supplies/' },
  baby:         { name: 'Baby',                 url: 'https://www.amazon.com/Best-Sellers-Baby-Products/zgbs/baby-products/' },
};

const TIKTOK_SEARCHES = {
  all:          { name: 'All Trending',  url: 'https://www.amazon.com/gp/movers-and-shakers/electronics/' },
  gadgets:      { name: 'Gadgets',       url: 'https://www.amazon.com/Best-Sellers-Electronics-Computers-Accessories/zgbs/electronics/172282/' },
  kitchen:      { name: 'Kitchen',       url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen-Kitchen-Dining/zgbs/kitchen/284507/' },
  home:         { name: 'Home & Decor',  url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen-Home-Decor-Products/zgbs/kitchen/1063306/' },
  beauty:       { name: 'Beauty',        url: 'https://www.amazon.com/Best-Sellers-Beauty/zgbs/beauty/' },
  fitness:      { name: 'Fitness',       url: 'https://www.amazon.com/Best-Sellers-Sports-Outdoors-Exercise-Fitness/zgbs/sporting-goods/3407731/' },
  cleaning:     { name: 'Cleaning',      url: 'https://www.amazon.com/Best-Sellers-Health-Personal-Care-Household-Supplies/zgbs/hpc/3760931/' },
  organization: { name: 'Organization',  url: 'https://www.amazon.com/gp/movers-and-shakers/kitchen/' },
};

const finderCache     = new Map();
const tiktokCache     = new Map();
const FINDER_CACHE_TTL = 60 * 60 * 1000;  // 1 hour
const TIKTOK_CACHE_TTL = 30 * 60 * 1000;  // 30 min

async function scrapeAmazonPage(url, label) {
  const scraperKey  = process.env.SCRAPER_API_KEY;
  const maxAttempts = 2;
  let html;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (scraperKey) {
        const renderFlag = attempt > 1 ? '&render=true' : '';
        const r = await axios.get('http://api.scraperapi.com?api_key=' + scraperKey + renderFlag + '&url=' + encodeURIComponent(url), { timeout: 35000 });
        html = r.data;
      } else {
        const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } });
        html = r.data;
      }
      const parsed = parseAmazonProductsFromHtml(html, 20);
      if (parsed.length) break;
      if (attempt < maxAttempts) { console.log(`[${label}] Attempt ${attempt} got 0 products, retrying...`); await new Promise(r => setTimeout(r, 2000)); }
    } catch (fetchErr) {
      if (attempt < maxAttempts) { console.log(`[${label}] Attempt ${attempt} error: ${fetchErr.message}, retrying...`); await new Promise(r => setTimeout(r, 2000)); }
      else throw fetchErr;
    }
  }
  return html;
}

router.get('/api/product-finder', async (req, res) => {
  const cat     = req.query.category || 'electronics';
  const catInfo = AMAZON_CATEGORIES[cat];
  if (!catInfo) return res.status(400).json({ error: 'Unknown category' });
  const cached = finderCache.get(cat);
  if (cached && Date.now() < cached.expires) return res.json(cached.data);
  try {
    const html = await scrapeAmazonPage(catInfo.url, 'finder');
    const rawProducts = parseAmazonProductsFromHtml(html, 20);
    if (!rawProducts.length) return res.status(503).json({ error: 'Could not extract products — Amazon may be blocking. Try again shortly.' });
    const products = rawProducts.map(({ asin, title, price, imageUrl }) => {
      const suggestedPrice = price ? (price * 1.6).toFixed(2) : null;
      const estimatedProfit = price && suggestedPrice ? (suggestedPrice - price - suggestedPrice * 0.1325 - 0.30).toFixed(2) : null;
      const product = { asin, title, price, suggestedPrice, estimatedProfit, imageUrl, amazonUrl: 'https://www.amazon.com/dp/' + asin };
      const safety  = checkProductSafety(product);
      product.blocked = safety.blocked; product.blockReason = safety.reason || null;
      return product;
    });
    const data = { category: catInfo.name, products, fetchedAt: new Date().toISOString() };
    finderCache.set(cat, { data, expires: Date.now() + FINDER_CACHE_TTL });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/api/tiktok-trends', async (req, res) => {
  const type       = req.query.type || 'all';
  const searchInfo = TIKTOK_SEARCHES[type];
  if (!searchInfo) return res.status(400).json({ error: 'Unknown trend type' });
  const cached = tiktokCache.get(type);
  if (cached && Date.now() < cached.expires) return res.json(cached.data);
  try {
    const html = await scrapeAmazonPage(searchInfo.url, 'movers');
    const rawProducts = parseAmazonProductsFromHtml(html, 20);
    if (!rawProducts.length) return res.status(503).json({ error: 'Could not extract trending products — try again shortly.' });
    const products = rawProducts.map(({ asin, title, price, imageUrl }) => {
      const suggestedPrice = price ? (price * 1.6).toFixed(2) : null;
      const estimatedProfit = price && suggestedPrice ? (suggestedPrice - price - suggestedPrice * 0.1325 - 0.30).toFixed(2) : null;
      const product = { asin, title, price, suggestedPrice, estimatedProfit, imageUrl, amazonUrl: 'https://www.amazon.com/dp/' + asin, tiktokTrend: true };
      const safety  = checkProductSafety(product);
      product.blocked = safety.blocked; product.blockReason = safety.reason || null;
      return product;
    });
    const data = { type: searchInfo.name, products, fetchedAt: new Date().toISOString() };
    tiktokCache.set(type, { data, expires: Date.now() + TIKTOK_CACHE_TTL });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Amazon product lookup ──────────────────────────────────────────────────────
router.post('/api/amazon', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})/i) || url.match(/^([A-Z0-9]{10})$/i);
  if (!asinMatch) return res.status(400).json({ error: 'Could not find an ASIN in that URL. Paste a full Amazon product URL.' });
  const asin = asinMatch[1].toUpperCase();

  // PA API path
  const hasKeys = process.env.AMAZON_ACCESS_KEY && process.env.AMAZON_SECRET_KEY && process.env.AMAZON_ASSOCIATE_TAG;
  if (hasKeys) {
    try {
      const { url: apiUrl, headers, payload } = buildAmazonRequest(asin);
      const r    = await axios.post(apiUrl, payload, { headers });
      const item = r.data.ItemsResult && r.data.ItemsResult.Items && r.data.ItemsResult.Items[0];
      if (!item) return res.status(404).json({ error: 'Product not found on Amazon' });
      const title      = item.ItemInfo && item.ItemInfo.Title ? item.ItemInfo.Title.DisplayValue : '';
      const price      = item.Offers && item.Offers.Listings && item.Offers.Listings[0] && item.Offers.Listings[0].Price ? parseFloat(item.Offers.Listings[0].Price.Amount) : null;
      const imageUrl   = item.Images && item.Images.Primary && item.Images.Primary.Large ? item.Images.Primary.Large.URL : null;
      const features   = item.ItemInfo && item.ItemInfo.Features ? item.ItemInfo.Features.DisplayValues.slice(0, 4).join('\n') : '';
      const ebayTitle  = title.length > 80 ? title.substring(0, 77) + '...' : title;
      const suggestedPrice  = price ? (price * 1.6).toFixed(2) : null;
      const estimatedProfit = price && suggestedPrice ? (suggestedPrice - price - suggestedPrice * 0.1325 - 0.30).toFixed(2) : null;
      const ebayDescription = title + '\n\n' + (features ? features + '\n\n' : '') + '✅ Brand New\n✅ Fast US Shipping\n✅ 30-day returns\n\n🏪 Justice Den — Quality you can trust, prices you\'ll love.';
      return res.json({ asin, title, ebayTitle, price, suggestedEbayPrice: suggestedPrice, estimatedProfit, ebayDescription, imageUrl, source: 'api' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Scrape fallback
  const scraperKey = process.env.SCRAPER_API_KEY;
  const scrapeAttempts = [
    { url: 'https://www.amazon.com/dp/' + asin + '?th=1&psc=1', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', mobile: false },
    { url: 'https://www.amazon.com/dp/' + asin, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', mobile: true },
  ];

  for (let attempt = 0; attempt < scrapeAttempts.length; attempt++) {
    const { url: fetchUrl, ua, mobile } = scrapeAttempts[attempt];
    try {
      let html;
      if (scraperKey) {
        html = (await axios.get('http://api.scraperapi.com?api_key=' + scraperKey + '&url=' + encodeURIComponent(fetchUrl), { timeout: 30000 })).data;
      } else {
        html = (await axios.get(fetchUrl, { timeout: 15000, headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', ...(!mobile ? { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Upgrade-Insecure-Requests': '1' } : {}) } })).data;
      }

      const isBlocked = html.includes('validateCaptcha') || html.includes('robot check') ||
        (html.includes('ap/signin') && !html.includes('productTitle') && !html.includes('a-price') && !html.includes('"name"'));
      if (isBlocked) {
        console.log('Amazon attempt', attempt + 1, 'blocked');
        if (attempt < scrapeAttempts.length - 1) { await new Promise(r => setTimeout(r, 1500)); continue; }
        return res.status(503).json({ error: 'Amazon is blocking automated requests. Add a SCRAPER_API_KEY to .env (free at scraperapi.com — 1000 free/mo) to bypass this, or use the Amazon PA API.' });
      }

      let title = null, price = null, imageUrl = null;

      const productTitleMatch = html.match(/id="productTitle"[^>]*>[\s\n]*([^<]{5,400})[\s\n]*</);
      if (productTitleMatch && !productTitleMatch[1].includes('<')) title = productTitleMatch[1].trim();
      if (!title) { const m = html.match(/"productTitle"\s*:\s*"([^"<]{10,400})"/); if (m) title = m[1].replace(/\\u[\dA-F]{4}/gi, c => String.fromCharCode(parseInt(c.slice(2), 16))).trim(); }
      if (!title) {
        const jsonLdRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = jsonLdRe.exec(html)) !== null) {
          try {
            const ld    = JSON.parse(m[1]);
            const items = Array.isArray(ld) ? ld : [ld];
            for (const item of items) {
              if (item['@type'] === 'Product' && item.name && !item.name.includes('<') && item.name.length > 15) {
                title = item.name.trim();
                if (item.offers) { const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers; if (offer && offer.price) price = parseFloat(offer.price); }
                if (item.image) imageUrl = Array.isArray(item.image) ? item.image[0] : item.image;
                break;
              }
            }
            if (title) break;
          } catch (e) {}
        }
      }
      if (!title) {
        const pageTitle = html.match(/<title>([^<]{15,400})<\/title>/i);
        if (pageTitle) {
          let c = pageTitle[1].replace(/Amazon Official Site\s*:\s*/i, '').replace(/Amazon\.com\s*:\s*/i, '').replace(/Amazon\s*\|\s*/i, '').replace(/\s*[-|]\s*Amazon.*$/i, '').trim();
          if (c.length >= 15 && !c.toLowerCase().includes('page not found') && !c.toLowerCase().includes('sign in')) title = c;
        }
      }
      if (!title) {
        if (attempt < scrapeAttempts.length - 1) { await new Promise(r => setTimeout(r, 1500)); continue; }
        title = asin;
      }

      if (!price) {
        const pd = html.match(/"priceAmount":(\d+\.?\d*)/) || html.match(/"amount":(\d+\.?\d*),"currency":"USD"/);
        const pw = html.match(/class="a-price-whole">(\d+)</);
        const pf = html.match(/class="a-price-fraction">(\d+)</);
        if (pd) price = parseFloat(pd[1]);
        else if (pw && pf) price = parseFloat(pw[1] + '.' + pf[1]);
      }
      if (!imageUrl) {
        const im = html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/) || html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/) || html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/) || html.match(/"landingImageUrl":"(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/);
        imageUrl = im ? im[1].replace(/\\\//g, '/') : null;
      }
      if (imageUrl) imageUrl = imageUrl.replace(/\._[A-Z_,0-9]+_\./, '.');

      title = title.replace(/^Amazon Official Site\s*:\s*/i, '').replace(/^Amazon\.com\s*:\s*/i, '').replace(/^Amazon\s*:\s*/i, '').replace(/\s*\|\s*Amazon.*$/i, '').trim();
      const ebayTitle       = title.length > 80 ? title.substring(0, 77) + '...' : title;
      const suggestedPrice  = price ? (price * 1.6).toFixed(2) : null;
      const estimatedProfit = price && suggestedPrice ? (suggestedPrice - price - suggestedPrice * 0.1325 - 0.30).toFixed(2) : null;
      const ebayDescription = title + '\n\n✅ Brand New\n✅ Fast US Shipping\n✅ 30-day returns\n\n🏪 Justice Den — Quality you can trust, prices you\'ll love.';
      console.log('Amazon scrape OK (attempt', attempt + 1, ') — title:', title.substring(0, 60), '| price:', price);
      return res.json({ asin, title, ebayTitle, price, suggestedEbayPrice: suggestedPrice, estimatedProfit, ebayDescription, imageUrl, source: 'scrape' });
    } catch (err) {
      if (attempt < scrapeAttempts.length - 1) { await new Promise(r => setTimeout(r, 1500)); continue; }
      return res.status(500).json({ error: 'Could not load the Amazon product page. Try again, or add SCRAPER_API_KEY to .env. Error: ' + err.message });
    }
  }
});

// ── Safety check ──────────────────────────────────────────────────────────────
router.post('/api/check-product', (req, res) => {
  const { title, asin, price } = req.body;
  res.json(checkProductSafety({ title: title || '', asin: asin || '', price: price || null }));
});

// ── Stock checker (delegates to lib/jobs.js) ───────────────────────────────────
router.get('/api/check-stock', async (req, res) => {
  try { res.json(await runStockCheck({ autoEnd: false })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Price watch (delegates to lib/jobs.js) ────────────────────────────────────
router.get('/api/price-watch', async (req, res) => {
  try { res.json(await runPriceWatch()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ASIN tools ────────────────────────────────────────────────────────────────
router.post('/api/set-asin', (req, res) => {
  const { sku, asin } = req.body;
  if (!sku || !asin) return res.status(400).json({ error: 'sku and asin required' });
  updateListingRecord(sku, { asin: asin.trim().toUpperCase() });
  res.json({ success: true, sku, asin: asin.trim().toUpperCase() });
});

router.post('/api/backfill-asins', async (req, res) => {
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (!scraperKey) return res.status(400).json({ error: 'SCRAPER_API_KEY not configured' });
  const listings = getLocalListings().filter(l => !l.asin && l.status === 'PUBLISHED');
  if (!listings.length) return res.json({ results: [], message: 'All listings already have ASINs.' });
  const results = [];
  for (const listing of listings) {
    try {
      const searchUrl = 'https://www.amazon.com/s?k=' + encodeURIComponent(listing.title.substring(0, 60));
      const html      = (await axios.get('http://api.scraperapi.com?api_key=' + scraperKey + '&url=' + encodeURIComponent(searchUrl), { timeout: 30000 })).data;
      const asinMatch = html.match(/\/dp\/([A-Z0-9]{10})[\/\"]/);
      if (asinMatch) {
        updateListingRecord(listing.sku, { asin: asinMatch[1] });
        results.push({ sku: listing.sku, title: listing.title, asin: asinMatch[1], found: true });
      } else {
        results.push({ sku: listing.sku, title: listing.title, asin: null, found: false });
      }
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      results.push({ sku: listing.sku, title: listing.title, asin: null, found: false, error: e.message });
    }
  }
  res.json({ results, found: results.filter(r => r.found).length, total: results.length });
});

module.exports = router;
