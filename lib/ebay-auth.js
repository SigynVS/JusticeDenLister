'use strict';
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ── In-memory state ───────────────────────────────────────────────────────────
let appToken        = null;
let appTokenExpiry  = null;
let userTokenRefreshing = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function persistEnvVar(key, value) {
  const envPath = path.join(__dirname, '..', '.env');
  let contents = '';
  try { contents = fs.readFileSync(envPath, 'utf8'); } catch (e) { contents = ''; }
  const safeValue = String(value).replace(/'/g, '');
  const line = key + "='" + safeValue + "'";
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(contents)) {
    contents = contents.replace(re, line);
  } else {
    if (contents.length && !contents.endsWith('\n')) contents += '\n';
    contents += line + '\n';
  }
  fs.writeFileSync(envPath, contents);
  process.env[key] = value;
}

async function getAppToken() {
  if (appToken && appTokenExpiry && Date.now() < appTokenExpiry) return appToken;
  const r = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    {
      headers: {
        'Authorization': 'Basic ' + process.env.EBAY_OAUTH_CREDENTIALS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  appToken       = r.data.access_token;
  appTokenExpiry = Date.now() + r.data.expires_in * 1000 - 60000;
  console.log('Got app token!');
  return appToken;
}

async function refreshUserToken() {
  const refreshToken = process.env.EBAY_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('No refresh token saved. Re-auth at /auth/ebay');
  const scopes =
    'https://api.ebay.com/oauth/api_scope/sell.inventory ' +
    'https://api.ebay.com/oauth/api_scope/sell.account ' +
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment';
  const body =
    'grant_type=refresh_token' +
    '&refresh_token=' + encodeURIComponent(refreshToken) +
    '&scope=' + encodeURIComponent(scopes);
  const r = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    body,
    {
      headers: {
        'Authorization': 'Basic ' + process.env.EBAY_OAUTH_CREDENTIALS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  persistEnvVar('EBAY_OAUTH_USER_TOKEN', r.data.access_token);
  if (r.data.expires_in)
    persistEnvVar('EBAY_OAUTH_USER_TOKEN_EXPIRY', String(Date.now() + r.data.expires_in * 1000));
  console.log('Refreshed user OAuth token!');
  return r.data.access_token;
}

async function getUserToken() {
  const token  = process.env.EBAY_OAUTH_USER_TOKEN;
  const expiry = parseInt(process.env.EBAY_OAUTH_USER_TOKEN_EXPIRY || '0', 10);
  const needsRefresh = !token || (expiry && Date.now() > expiry - 60000);
  if (!needsRefresh) return token;
  if (!userTokenRefreshing) {
    userTokenRefreshing = refreshUserToken().finally(() => { userTokenRefreshing = null; });
  }
  return userTokenRefreshing;
}

async function exchangeAuthCodeForToken(code) {
  const body =
    'grant_type=authorization_code' +
    '&code=' + encodeURIComponent(code) +
    '&redirect_uri=Justice_Auto_Wo-JusticeA-Justic-xnvyvi';
  const r = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    body,
    {
      headers: {
        'Authorization': 'Basic ' + process.env.EBAY_OAUTH_CREDENTIALS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  persistEnvVar('EBAY_OAUTH_USER_TOKEN', r.data.access_token);
  if (r.data.refresh_token)
    persistEnvVar('EBAY_OAUTH_REFRESH_TOKEN', r.data.refresh_token);
  if (r.data.expires_in)
    persistEnvVar('EBAY_OAUTH_USER_TOKEN_EXPIRY', String(Date.now() + r.data.expires_in * 1000));
  console.log('Got user OAuth token! Saved to .env as EBAY_OAUTH_USER_TOKEN');
  return r.data;
}

function extractCodeFromInput(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  const match = trimmed.match(/[?&]code=([^&\s#]+)/);
  if (match) return decodeURIComponent(match[1]);
  return decodeURIComponent(trimmed);
}

module.exports = {
  persistEnvVar,
  getAppToken,
  refreshUserToken,
  getUserToken,
  exchangeAuthCodeForToken,
  extractCodeFromInput,
};
