# JusticeDenLister — Project Guidelines

## Stack
Node.js / Express (CommonJS), vanilla JS frontend, eBay Sell Inventory + Fulfillment APIs, ScraperAPI for Amazon scraping, better-sqlite3 for local persistence.

## eBay API Rules
- When a 400 error occurs, read the full response body before guessing. Do not propose a fix until the error is quoted.
- eBay uses `Model` (not `Compatible Model`) in item specifics for most categories.
- Common 400 causes: HTML entities in title (always decode before sending), missing required item specifics, invalid category ID.
- VeRO risk brands: Apple, Samsung, Garmin, Fitbit, Sony, Bose, Amazon Echo — avoid listing these even as compatible devices.

## Module Layout
```
server.js              — thin orchestrator: middleware, router mounts, scheduler, listen
lib/
  db.js                — SQLite data layer (better-sqlite3, WAL mode)
  ebay-auth.js         — OAuth tokens: getAppToken, getUserToken, refreshUserToken
  ebay-listing.js      — createOneListing, getPolicyIds, getCategoryId, paginated fetchers
  ebay-utils.js        — ebayErrDetail, image re-hosting (ImgBB)
  product-safety.js    — VeRO/blocklist check, checkProductSafety
  amazon-parser.js     — HTML parser, two-strategy (cheerio + regex fallback)
  jobs.js              — schedulable tasks: runAutoRepricer, runStockCheck, runPriceWatch
  scheduler.js         — setInterval wrappers around jobs.js
routes/
  auth.js              — /auth/* OAuth flow
  amazon.js            — /api/amazon, product-finder, price-watch, stock-check, etc.
  listings.js          — /api/listings CRUD, repricer, orders, validate, score-title
  account.js           — /api/setup-status, policies, activity, images, profit-summary
public/index.html      — entire frontend (single file, vanilla JS)
tests/
  scraper.test.js      — zero-network scraper regression tests
  lib.test.js          — zero-network unit tests for lib/ pure functions
```

## Data Storage
- **SQLite** (`jd.db`, WAL mode) — listings + activity log. No more listings.json / activity.json.
- `blocklist.json`, `repricer-settings.json`, `policy-ids.json`, `images.json` — small JSON sidecars (infrequent writes).

## Run & Test
```
npm start        # starts server on port 3000
npm test         # runs all tests (scraper + lib unit tests, zero network)
```
