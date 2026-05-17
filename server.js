require('dotenv').config();
const express = require('express');
const path    = require('path');

const { getAppToken, refreshUserToken } = require('./lib/ebay-auth');
const { startScheduler }               = require('./lib/scheduler');

const authRouter     = require('./routes/auth');
const amazonRouter   = require('./routes/amazon');
const listingsRouter = require('./routes/listings');
const accountRouter  = require('./routes/account');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Route modules ─────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/', amazonRouter);
app.use('/', listingsRouter);
app.use('/', accountRouter);

// ── Proactive token refresh ───────────────────────────────────────────────────
// Checks every 5 min; refreshes if access token expires within 10 min.
setInterval(async () => {
  if (!process.env.EBAY_OAUTH_REFRESH_TOKEN) return;
  const expiry = parseInt(process.env.EBAY_OAUTH_USER_TOKEN_EXPIRY || '0', 10);
  if (!expiry || Date.now() < expiry - 10 * 60 * 1000) return;
  try {
    await refreshUserToken();
    console.log('[token] Proactively refreshed before expiry');
  } catch (e) {
    console.error('[token] Proactive refresh failed:', e.message);
  }
}, 5 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('====================================');
  console.log('  Justice Den Lister is running!');
  console.log('  Go to: http://localhost:' + PORT);
  console.log('====================================');
  try { await getAppToken(); } catch (e) { console.log('Token error:', e.message); }
  startScheduler();
});
