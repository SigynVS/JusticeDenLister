'use strict';
const express = require('express');
const crypto  = require('crypto');
const { getUserToken, refreshUserToken, exchangeAuthCodeForToken, extractCodeFromInput } = require('../lib/ebay-auth');

const router = express.Router();

// CSRF state store — expires after 10 min
const pendingOAuthStates = new Set();

// ── eBay OAuth flow ───────────────────────────────────────────────────────────
router.get('/ebay', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  pendingOAuthStates.add(state);
  setTimeout(() => pendingOAuthStates.delete(state), 10 * 60 * 1000);
  const scopes = [
    'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  ].join('%20');
  const authUrl =
    'https://auth.ebay.com/oauth2/authorize?client_id=' + process.env.EBAY_APP_ID +
    '&redirect_uri=Justice_Auto_Wo-JusticeA-Justic-xnvyvi' +
    '&response_type=code&scope=' + scopes + '&state=' + state;
  res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/auth/manual');
  if (state) {
    if (!pendingOAuthStates.has(state))
      return res.status(403).send("<p style='font-family:Arial;color:#b00'>Invalid or expired OAuth state. Please <a href='/auth/ebay'>start a fresh auth flow</a>.</p>");
    pendingOAuthStates.delete(state);
  }
  try {
    await exchangeAuthCodeForToken(code);
    res.send("<h2 style='font-family:Arial;color:green'>Successfully connected to eBay! You can close this tab and go back to your tool.</h2>");
  } catch (err) {
    res.send('Error: ' + JSON.stringify(err.response ? err.response.data : err.message));
  }
});

router.get('/manual', (req, res) => {
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Justice Den — Manual eBay Auth</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { margin-bottom: 8px; }
  p { color: #555; line-height: 1.5; }
  textarea { width: 100%; min-height: 140px; padding: 10px; font-family: monospace; font-size: 13px; border: 1px solid #bbb; border-radius: 6px; }
  button { margin-top: 12px; padding: 10px 20px; background: #e1251b; color: white; border: 0; border-radius: 6px; font-size: 15px; cursor: pointer; }
  button:hover { background: #b81d14; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
  ol li { margin-bottom: 8px; }
</style></head><body>
<h1>Connect eBay (Manual Code Paste)</h1>
<p>Use this when eBay redirects you back to <code>justiceden.com/ebay-callback</code> instead of localhost.</p>
<ol>
  <li>Start the auth flow: <a href="/auth/ebay">/auth/ebay</a></li>
  <li>After approving on eBay, you'll land on a "page not found" on justiceden.com.</li>
  <li>Copy the entire URL from the address bar and paste it below.</li>
</ol>
<form method="POST" action="/auth/manual">
  <textarea name="codeOrUrl" placeholder="Paste the full callback URL here, e.g. https://justiceden.com/ebay-callback?code=v%5E1.1%23i%5E1%23..." autofocus></textarea>
  <br>
  <button type="submit">Exchange code for token</button>
</form>
</body></html>`);
});

router.post('/manual', async (req, res) => {
  const input = req.body.codeOrUrl || '';
  const code  = extractCodeFromInput(input);
  if (!code) return res.send("<p style='font-family:Arial;color:#b00'>Could not find a code in your input. <a href='/auth/manual'>Try again</a>.</p>");
  const stateMatch = input.match(/[?&]state=([^&\s#]+)/);
  const state = stateMatch ? decodeURIComponent(stateMatch[1]) : null;
  if (state) {
    if (!pendingOAuthStates.has(state))
      return res.send("<p style='font-family:Arial;color:#b00'>OAuth state mismatch — the auth link may have expired. Please <a href='/auth/ebay'>start a fresh auth flow</a>.</p>");
    pendingOAuthStates.delete(state);
  }
  try {
    await exchangeAuthCodeForToken(code);
    res.send('<h2 style=\'font-family:Arial;color:green\'>Successfully connected to eBay! Token saved to .env. You can close this tab and go back to your tool.</h2>');
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    res.send("<p style='font-family:Arial;color:#b00'>Error exchanging code: " + detail + "</p><p><a href='/auth/manual'>Try again</a> — note that auth codes expire in a few minutes, you may need a fresh one from <a href='/auth/ebay'>/auth/ebay</a>.</p>");
  }
});

module.exports = router;
