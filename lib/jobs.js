'use strict';
/**
 * Schedulable background jobs.
 * Pure functions — no req/res, no HTTP self-calls.
 * Called by lib/scheduler.js and also by API routes that trigger manual runs.
 */
const axios = require('axios');
const { getUserToken }                                                   = require('./ebay-auth');
const { getLocalListings, updateListingRecord, logActivity, logPriceHistory } = require('./db');

// ── Auto-repricer ─────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const REPRICER_FILE = path.join(__dirname, '..', 'repricer-settings.json');

function getRepricerSettings() {
  try { return JSON.parse(fs.readFileSync(REPRICER_FILE, 'utf8')); }
  catch (e) { return { enabled: false, dropPercent: 5, floorPercent: 20, daysThreshold: 7 }; }
}

async function runAutoRepricer({ force = false } = {}) {
  const settings = getRepricerSettings();
  if (!settings.enabled && !force) return { skipped: true, message: 'Auto-repricer is disabled.' };

  let token;
  try { token = await getUserToken(); }
  catch (err) { return { error: 'Not connected: ' + err.message }; }

  const userHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };
  const listings    = getLocalListings().filter(l => l.status === 'PUBLISHED' && l.offerId);
  const now         = Date.now();
  const results     = [];

  for (const listing of listings) {
    const ref      = listing.lastReprice || listing.createdAt;
    const daysSince = (now - new Date(ref).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < settings.daysThreshold) {
      results.push({ sku: listing.sku, title: listing.title, action: 'skipped', reason: Math.floor(daysSince) + 'd since last reprice' });
      continue;
    }
    const cur     = parseFloat(listing.price);
    const orig    = parseFloat(listing.originalPrice || listing.price);
    const floor   = orig * (settings.floorPercent / 100);
    const dropped = parseFloat((cur * (1 - settings.dropPercent / 100)).toFixed(2));
    if (dropped < floor) {
      results.push({ sku: listing.sku, title: listing.title, action: 'skipped', reason: 'Floor price ($' + floor.toFixed(2) + ')' });
      continue;
    }
    try {
      await axios.put(
        'https://api.ebay.com/sell/inventory/v1/offer/' + listing.offerId,
        { pricingSummary: { price: { value: String(dropped), currency: 'USD' } } },
        { headers: userHeaders }
      );
      updateListingRecord(listing.sku, { price: String(dropped), lastReprice: new Date().toISOString() });
      results.push({ sku: listing.sku, title: listing.title, action: 'repriced', oldPrice: cur, newPrice: dropped });
    } catch (e) {
      results.push({ sku: listing.sku, title: listing.title, action: 'error', error: e.message });
    }
  }

  const repriced = results.filter(r => r.action === 'repriced').length;
  if (repriced > 0) logActivity('repricer_run', { repriced, total: results.length });
  console.log(`[repricer] Done: ${repriced}/${results.length} repriced`);
  return { results, repriced, total: results.length };
}

// ── Stock checker ─────────────────────────────────────────────────────────────
async function runStockCheck({ autoEnd = false } = {}) {
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (!scraperKey) return { error: 'SCRAPER_API_KEY not configured' };

  const listings = getLocalListings().filter(l => l.asin && l.status === 'PUBLISHED');
  if (!listings.length) return { results: [], noAsins: true };

  let token;
  if (autoEnd) {
    try { token = await getUserToken(); }
    catch (err) { return { error: 'Not connected for auto-end: ' + err.message }; }
  }

  const results = [];
  for (const listing of listings.slice(0, 15)) {
    try {
      const url  = 'http://api.scraperapi.com?api_key=' + scraperKey + '&url=' + encodeURIComponent('https://www.amazon.com/dp/' + listing.asin + '?th=1&psc=1');
      const html = (await axios.get(url, { timeout: 30000 })).data;

      const outOfStock = /currently unavailable|Currently unavailable|unavailable/.test(html) && !/add-to-cart-button/.test(html);
      const inStock    = /add-to-cart-button|buy-now-button|addToCart/.test(html) && !outOfStock;

      let price = null;
      const pd = html.match(/"priceAmount":(\d+\.?\d*)/) || html.match(/"amount":(\d+\.?\d*),"currency":"USD"/);
      const pw = html.match(/class="a-price-whole">(\d+)</);
      const pf = html.match(/class="a-price-fraction">(\d+)</);
      if (pd) price = parseFloat(pd[1]); else if (pw && pf) price = parseFloat(pw[1] + '.' + pf[1]);

      const ebayPrice   = parseFloat(listing.price);
      const expectedMin = price ? price * 1.6 : null;
      const priceAlert  = expectedMin && ebayPrice < expectedMin * 0.85;
      const status      = !inStock ? 'out_of_stock' : priceAlert ? 'price_alert' : 'ok';

      // Auto-end OOS listings if requested and we have a token
      let ended = false;
      if (!inStock && autoEnd && token && listing.offerId) {
        try {
          await axios.post(
            'https://api.ebay.com/sell/inventory/v1/offer/' + listing.offerId + '/withdraw',
            {},
            { headers: { 'Authorization': 'Bearer ' + token } }
          );
          updateListingRecord(listing.sku, { status: 'ENDED' });
          logActivity('auto_ended', { sku: listing.sku, asin: listing.asin, reason: 'out_of_stock_on_amazon' });
          ended = true;
          console.log(`[stock] Auto-ended OOS listing: ${listing.sku} (ASIN: ${listing.asin})`);
        } catch (endErr) {
          console.warn(`[stock] Could not auto-end ${listing.sku}:`, endErr.message);
        }
      }

      results.push({ sku: listing.sku, offerId: listing.offerId || '', title: listing.title, asin: listing.asin, inStock, amazonPrice: price, ebayPrice, priceAlert, ebayUrl: listing.ebayUrl, status, ended });
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      results.push({ sku: listing.sku, title: listing.title, asin: listing.asin, status: 'error', error: e.message });
    }
  }

  const ended = results.filter(r => r.ended).length;
  console.log(`[stock] Done: ${results.length} checked, ${ended} auto-ended`);
  return { results, checkedAt: new Date().toISOString(), autoEnded: ended };
}

// ── Price watcher ──────────────────────────────────────────────────────────────
async function runPriceWatch() {
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (!scraperKey) return { error: 'SCRAPER_API_KEY not configured' };

  const listings = getLocalListings().filter(l => l.asin && l.status === 'PUBLISHED');
  if (!listings.length) return { results: [], noAsins: true };

  const results = [];
  for (const listing of listings.slice(0, 15)) {
    try {
      const url  = 'http://api.scraperapi.com?api_key=' + scraperKey + '&url=' + encodeURIComponent('https://www.amazon.com/dp/' + listing.asin + '?th=1&psc=1');
      const html = (await axios.get(url, { timeout: 30000 })).data;

      let amazonPrice = null;
      const pd = html.match(/"priceAmount":(\d+\.?\d*)/) || html.match(/"amount":(\d+\.?\d*),"currency":"USD"/);
      const pw = html.match(/class="a-price-whole">(\d+)</);
      const pf = html.match(/class="a-price-fraction">(\d+)</);
      if (pd) amazonPrice = parseFloat(pd[1]); else if (pw && pf) amazonPrice = parseFloat(pw[1] + '.' + pf[1]);

      const ebayPrice  = parseFloat(listing.price);
      const profit     = amazonPrice ? (ebayPrice - amazonPrice - ebayPrice * 0.1325 - 0.30) : null;
      const margin     = (profit !== null && ebayPrice) ? (profit / ebayPrice) * 100 : null;
      const alert      = !amazonPrice ? 'unknown' : profit < 0 ? 'losing' : margin < 8 ? 'low' : 'ok';
      const prevPrice  = listing.lastAmazonPrice;
      const driftPct   = (amazonPrice && prevPrice) ? ((amazonPrice - prevPrice) / prevPrice) * 100 : null;
      const driftAlert = driftPct !== null && Math.abs(driftPct) >= 5;

      if (amazonPrice) {
        updateListingRecord(listing.sku, { lastAmazonPrice: amazonPrice, lastAmazonCheckedAt: new Date().toISOString() });
        logPriceHistory(listing.sku, listing.asin, amazonPrice);
      }
      results.push({ sku: listing.sku, offerId: listing.offerId || '', title: listing.title, asin: listing.asin, ebayPrice, amazonPrice, profit: profit !== null ? profit.toFixed(2) : null, margin: margin !== null ? margin.toFixed(1) : null, alert, ebayUrl: listing.ebayUrl || '', prevAmazonPrice: prevPrice || null, driftPct: driftPct !== null ? parseFloat(driftPct.toFixed(1)) : null, driftAlert });
    } catch (e) {
      results.push({ sku: listing.sku, title: listing.title, asin: listing.asin, alert: 'error', error: e.message });
    }
  }

  const losing = results.filter(r => r.alert === 'losing').length;
  const drift  = results.filter(r => r.driftAlert).length;
  console.log(`[price-watch] Done: ${results.length} checked, ${losing} losing, ${drift} drifted ≥5%`);
  return { results, checkedAt: new Date().toISOString() };
}

module.exports = { runAutoRepricer, runStockCheck, runPriceWatch, getRepricerSettings };
