'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'jd.db');
const db = new Database(DB_PATH);

// WAL mode: concurrent reads don't block writes
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    sku                TEXT PRIMARY KEY,
    offerId            TEXT,
    listingId          TEXT,
    title              TEXT,
    price              TEXT,
    originalPrice      TEXT,
    imageUrl           TEXT,
    status             TEXT DEFAULT 'PUBLISHED',
    ebayUrl            TEXT,
    createdAt          TEXT,
    asin               TEXT,
    category           TEXT,
    sourceUrl          TEXT,
    lastReprice        TEXT,
    lastAmazonPrice    REAL,
    lastAmazonCheckedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS activity (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT    NOT NULL,
    action  TEXT    NOT NULL,
    sku     TEXT,
    data    TEXT
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sku       TEXT    NOT NULL,
    asin      TEXT,
    price     REAL    NOT NULL,
    checkedAt TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_asin   ON listings(asin);
  CREATE INDEX IF NOT EXISTS idx_activity_ts     ON activity(ts);
  CREATE INDEX IF NOT EXISTS idx_ph_sku          ON price_history(sku);
`);

// ── Column lists ──────────────────────────────────────────────────────────────
const LISTING_COLS = [
  'sku','offerId','listingId','title','price','originalPrice',
  'imageUrl','status','ebayUrl','createdAt','asin','category',
  'sourceUrl','lastReprice','lastAmazonPrice','lastAmazonCheckedAt'
];

const UPDATE_COLS = new Set([
  'offerId','listingId','title','price','originalPrice','imageUrl',
  'status','ebayUrl','asin','category','sourceUrl','lastReprice',
  'lastAmazonPrice','lastAmazonCheckedAt'
]);

// ── One-time migration from JSON files ────────────────────────────────────────
const LISTINGS_JSON = path.join(__dirname, '..', 'listings.json');
const ACTIVITY_JSON = path.join(__dirname, '..', 'activity.json');

if (db.prepare('SELECT COUNT(*) as c FROM listings').get().c === 0 &&
    fs.existsSync(LISTINGS_JSON)) {
  try {
    const rows = JSON.parse(fs.readFileSync(LISTINGS_JSON, 'utf8'));
    const insert = db.prepare(
      `INSERT OR IGNORE INTO listings (${LISTING_COLS.join(',')})
       VALUES (${LISTING_COLS.map(c => '@' + c).join(',')})`
    );
    db.transaction(rows => {
      for (const r of rows) {
        const row = {};
        for (const c of LISTING_COLS) row[c] = r[c] !== undefined ? r[c] : null;
        insert.run(row);
      }
    })(rows);
    console.log(`[db] Migrated ${rows.length} listings from listings.json`);
  } catch (e) {
    console.error('[db] listings migration error:', e.message);
  }
}

if (db.prepare('SELECT COUNT(*) as c FROM activity').get().c === 0 &&
    fs.existsSync(ACTIVITY_JSON)) {
  try {
    const rows = JSON.parse(fs.readFileSync(ACTIVITY_JSON, 'utf8'));
    const insert = db.prepare(
      'INSERT INTO activity (ts, action, sku, data) VALUES (?, ?, ?, ?)'
    );
    db.transaction(rows => {
      for (const r of rows) {
        const { ts, action, sku, ...rest } = r;
        insert.run(ts, action, sku || null,
          Object.keys(rest).length ? JSON.stringify(rest) : null);
      }
    })(rows);
    console.log(`[db] Migrated ${rows.length} activity entries from activity.json`);
  } catch (e) {
    console.error('[db] activity migration error:', e.message);
  }
}

// ── Data access ───────────────────────────────────────────────────────────────
function getLocalListings() {
  return db.prepare('SELECT * FROM listings ORDER BY createdAt DESC').all();
}

function saveListingRecord(record) {
  const row = {};
  for (const c of LISTING_COLS) row[c] = record[c] !== undefined ? record[c] : null;
  if (!row.createdAt) row.createdAt = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO listings (${LISTING_COLS.join(',')})
     VALUES (${LISTING_COLS.map(c => '@' + c).join(',')})`
  ).run(row);
}

function updateListingRecord(sku, updates) {
  // Whitelist columns to prevent injection from unexpected call sites
  const safe = Object.fromEntries(
    Object.entries(updates).filter(([k]) => UPDATE_COLS.has(k))
  );
  if (!Object.keys(safe).length) return;
  const set = Object.keys(safe).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE listings SET ${set} WHERE sku = @sku`).run({ ...safe, sku });
}

function deleteListingRecord(sku) {
  db.prepare('DELETE FROM listings WHERE sku = ?').run(sku);
}

function logActivity(action, data) {
  const { sku, ...rest } = data || {};
  db.prepare(
    'INSERT INTO activity (ts, action, sku, data) VALUES (?, ?, ?, ?)'
  ).run(
    new Date().toISOString(),
    action,
    sku || null,
    Object.keys(rest).length ? JSON.stringify(rest) : null
  );
  // Keep last 500 entries
  db.prepare(
    'DELETE FROM activity WHERE id NOT IN ' +
    '(SELECT id FROM activity ORDER BY id DESC LIMIT 500)'
  ).run();
}

function getActivity(limit) {
  return db
    .prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?')
    .all(limit || 200)
    .map(r => {
      const extra = r.data ? JSON.parse(r.data) : {};
      return { ts: r.ts, action: r.action, sku: r.sku, ...extra };
    });
}

// Used by sync-to-local: upsert all eBay inventory items while preserving
// fields that eBay's API doesn't return (asin, sourceUrl, originalPrice, etc.)
function upsertAllListings(listings) {
  const preservedCols = ['asin','sourceUrl','originalPrice','lastReprice',
                         'lastAmazonPrice','lastAmazonCheckedAt'];
  const upsertCols    = LISTING_COLS.filter(c => !preservedCols.includes(c) && c !== 'sku');
  const insert = db.prepare(
    `INSERT INTO listings (${LISTING_COLS.join(',')})
     VALUES (${LISTING_COLS.map(c => '@' + c).join(',')})
     ON CONFLICT(sku) DO UPDATE SET
     ${upsertCols.map(c => `${c}=excluded.${c}`).join(',')}`
  );
  db.transaction(ls => {
    for (const r of ls) {
      const row = {};
      for (const c of LISTING_COLS) row[c] = r[c] !== undefined ? r[c] : null;
      if (!row.createdAt) row.createdAt = new Date().toISOString();
      insert.run(row);
    }
  })(listings);
}

// ── Price history ─────────────────────────────────────────────────────────────
function logPriceHistory(sku, asin, price) {
  db.prepare(
    'INSERT INTO price_history (sku, asin, price, checkedAt) VALUES (?, ?, ?, ?)'
  ).run(sku, asin || null, price, new Date().toISOString());
  // Keep last 90 data points per SKU
  db.prepare(
    'DELETE FROM price_history WHERE sku = ? AND id NOT IN ' +
    '(SELECT id FROM price_history WHERE sku = ? ORDER BY id DESC LIMIT 90)'
  ).run(sku, sku);
}

function getPriceHistory(sku) {
  return db.prepare(
    'SELECT price, checkedAt FROM price_history WHERE sku = ? ORDER BY id ASC'
  ).all(sku);
}

function getDbStats() {
  return {
    listings:        db.prepare('SELECT COUNT(*) as c FROM listings').get().c,
    published:       db.prepare("SELECT COUNT(*) as c FROM listings WHERE status='PUBLISHED'").get().c,
    activityEntries: db.prepare('SELECT COUNT(*) as c FROM activity').get().c,
    priceHistory:    db.prepare('SELECT COUNT(*) as c FROM price_history').get().c,
  };
}

module.exports = {
  db,
  getLocalListings,
  saveListingRecord,
  updateListingRecord,
  deleteListingRecord,
  logActivity,
  getActivity,
  upsertAllListings,
  logPriceHistory,
  getPriceHistory,
  getDbStats,
};
