'use strict';
const fs   = require('fs');
const path = require('path');

// ── Custom blocklist (persisted to blocklist.json) ────────────────────────────
const BLOCKLIST_FILE = path.join(__dirname, '..', 'blocklist.json');

function getBlocklist() {
  try { return JSON.parse(fs.readFileSync(BLOCKLIST_FILE, 'utf8')); }
  catch { return { brands: [], keywords: [], asins: [] }; }
}

function saveBlocklist(data) {
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(data, null, 2));
}

// ── Built-in safety lists ─────────────────────────────────────────────────────
const VERO_BRANDS = [
  // Apple
  'apple', 'iphone', 'ipad', 'macbook', 'airpods', 'imac', 'apple watch',
  // Nike / sportswear
  'nike', 'adidas', 'under armour', 'lululemon', 'yeezy', 'jordan', 'off-white',
  // Audio
  'bose', 'beats by', 'beats by dre', 'sonos',
  // Luxury
  'louis vuitton', 'gucci', 'prada', 'rolex', 'versace', 'burberry', 'coach', 'kate spade',
  // Disney / IP
  'disney', 'marvel', 'star wars', 'harry potter', 'pokemon', 'nintendo', 'lego', 'barbie',
  // Electronics brands with active VeRO
  'dyson', 'roomba', 'irobot', 'yeti', 'stanley cup', 'stanley quencher', 'hydro flask',
  // Other
  'ugg', 'crocs', 'ralph lauren', 'tommy hilfiger', 'calvin klein', 'north face', 'patagonia',
];

const BLOCKED_KEYWORDS = [
  // Subscriptions / digital goods
  'subscription', 'auto-renewal', 'monthly plan', 'annual plan', 'membership', 'digital code',
  'gift card', 'e-gift', 'ebook', 'kindle edition',
  // Consumables / filters (hard to dropship profitably)
  'water filter', 'air filter', 'refrigerator filter', 'furnace filter', 'merv', 'hvac filter',
  'filter replacement', 'brita filter', 'pur filter',
  // Hazmat / restricted
  'ammunition', 'ammo', 'firearm', 'gun', 'knife set', 'switchblade',
  // Pharmaceutical / medical
  'prescription', 'rx only', 'medical device',
];

const BLOCKED_ASINS = new Set([
  // Add specific ASINs here if needed
]);

// ── Safety check ──────────────────────────────────────────────────────────────
function checkProductSafety(product) {
  const t = (product.title || '').toLowerCase();
  const custom = getBlocklist();

  if (BLOCKED_ASINS.has(product.asin))
    return { blocked: true, reason: 'Blocked ASIN' };
  if (product.asin && custom.asins.includes(product.asin.toLowerCase()))
    return { blocked: true, reason: 'Custom blocked ASIN' };

  for (const brand of VERO_BRANDS) {
    if (t.includes(brand))
      return { blocked: true, reason: 'VeRO brand: ' + brand.charAt(0).toUpperCase() + brand.slice(1) + ' — risk of listing removal & account strike' };
  }
  for (const brand of custom.brands) {
    if (t.includes(brand))
      return { blocked: true, reason: 'Your block rule: brand "' + brand + '"' };
  }
  for (const kw of BLOCKED_KEYWORDS) {
    if (t.includes(kw))
      return { blocked: true, reason: 'Restricted keyword: "' + kw + '" — not suitable for dropshipping' };
  }
  for (const kw of custom.keywords) {
    if (t.includes(kw))
      return { blocked: true, reason: 'Your block rule: keyword "' + kw + '"' };
  }

  const highValueTerms = ['iphone', 'ipad', 'macbook', 'laptop', 'gaming laptop', 'rtx', 'gpu', 'graphics card', 'xbox', 'playstation', 'ps5', 'ps4', 'nintendo switch', 'drone'];
  for (const term of highValueTerms) {
    if (t.includes(term))
      return { blocked: true, reason: 'High-value electronics — fraud risk for new accounts' };
  }

  if (product.price && product.price < 15)
    return { blocked: true, reason: 'Amazon price $' + product.price + ' — too low to profit after eBay fees + shipping' };

  return { blocked: false };
}

module.exports = {
  BLOCKLIST_FILE,
  VERO_BRANDS,
  BLOCKED_KEYWORDS,
  BLOCKED_ASINS,
  getBlocklist,
  saveBlocklist,
  checkProductSafety,
};
