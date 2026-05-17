'use strict';
/**
 * Scheduled background jobs.
 * Reads interval config from environment variables (minutes, 0 = disabled).
 * Call startScheduler() once from server.js after app.listen.
 */
const { runAutoRepricer, runStockCheck, runPriceWatch } = require('./jobs');

function toMs(envKey, defaultMinutes) {
  const raw = parseInt(process.env[envKey] || String(defaultMinutes), 10);
  return raw > 0 ? raw * 60 * 1000 : 0;
}

function scheduleJob(name, fn, intervalMs) {
  if (!intervalMs) {
    console.log(`[scheduler] ${name}: disabled (set ${name.toUpperCase().replace(/-/g, '_')}_INTERVAL_MINUTES > 0 to enable)`);
    return;
  }
  const minutes = Math.round(intervalMs / 60000);
  console.log(`[scheduler] ${name}: every ${minutes} min`);
  // Stagger first runs by 2 min each so they don't all fire at boot
  const stagger = { repricer: 2, 'stock-check': 4, 'price-watch': 6 }[name] || 0;
  setTimeout(() => {
    fn().catch(e => console.error(`[scheduler] ${name} error:`, e.message));
    setInterval(() => {
      fn().catch(e => console.error(`[scheduler] ${name} error:`, e.message));
    }, intervalMs);
  }, stagger * 60 * 1000);
}

function startScheduler() {
  const repricerMs    = toMs('REPRICER_INTERVAL_MINUTES',    1440); // default: daily
  const stockMs       = toMs('STOCK_CHECK_INTERVAL_MINUTES',  360); // default: 6 hr
  const priceWatchMs  = toMs('PRICE_WATCH_INTERVAL_MINUTES',  360); // default: 6 hr

  scheduleJob('repricer',    () => runAutoRepricer({ force: false }), repricerMs);
  scheduleJob('stock-check', () => runStockCheck({ autoEnd: true }),  stockMs);
  scheduleJob('price-watch', () => runPriceWatch(),                   priceWatchMs);
}

module.exports = { startScheduler };
