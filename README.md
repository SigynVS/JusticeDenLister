# JusticeDenLister

> Automated eBay listing tool with Amazon price tracking, built with Node.js, Express, and SQLite.

![Node.js](https://img.shields.io/badge/Node.js-Express-green) ![Database](https://img.shields.io/badge/Database-SQLite-blue) ![API](https://img.shields.io/badge/API-eBay%20%7C%20Amazon-orange)

---

## What This Project Demonstrates

- **Node.js/Express REST API** with modular route architecture
- **eBay Sell Inventory + Fulfillment API** integration — create, update, and manage listings
- **Amazon scraping** via ScraperAPI with cheerio + regex fallback parser
- **SQLite database** (better-sqlite3, WAL mode) for listings and activity log
- **OAuth 2.0** flow for eBay user authentication
- **Automated jobs** — auto-repricer, stock checker, price watcher via scheduler
- **VeRO/blocklist safety** — prevents listing restricted brands

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js, Express 5 |
| Database | SQLite (better-sqlite3, WAL mode) |
| Frontend | Vanilla JS (single-page, no framework) |
| External APIs | eBay Sell API, ScraperAPI (Amazon) |
| Auth | OAuth 2.0 (eBay) |
| Image hosting | ImgBB API |

---

## Project Structure

```
JusticeDenLister/
  server.js              Entry point — middleware, routes, scheduler
  lib/
    db.js                SQLite data layer
    ebay-auth.js         OAuth token management
    ebay-listing.js      Listing create/update, policy fetchers
    ebay-utils.js        Error handling, image re-hosting
    amazon-parser.js     HTML scraper (cheerio + regex fallback)
    product-safety.js    VeRO/blocklist checks
    jobs.js              Auto-repricer, stock check, price watch
    scheduler.js         setInterval job runner
  routes/
    auth.js              /auth/* OAuth flow
    amazon.js            /api/amazon product and price endpoints
    listings.js          /api/listings CRUD and repricer
    account.js           /api/setup-status, policies, profit summary
  public/index.html      Full frontend (vanilla JS, single file)
  tests/                 Unit + scraper regression tests (zero network)
```

---

## Running Locally

```bash
npm install
cp .env.example .env
# Fill in eBay API keys and ScraperAPI key
npm start
# Runs on http://localhost:3000
npm test
```

---

## Key Features

- **Auto-repricer** — monitors competitor prices and adjusts listings automatically
- **Stock checker** — syncs inventory levels with eBay
- **Price watcher** — tracks Amazon price changes for sourced products
- **Title scorer** — rates listing titles for eBay SEO quality
- **Profit summary** — calculates margins across active listings

---

*Built by [Brian Justice](https://github.com/SigynVS)*