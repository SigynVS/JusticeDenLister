'use strict';
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ── eBay error sanitiser ──────────────────────────────────────────────────────
/**
 * Extract only structured error fields from an eBay API error response.
 * Avoids forwarding raw upstream payloads (which can include request bodies).
 */
function ebayErrDetail(err) {
  if (!err.response || !err.response.data) return null;
  const d = err.response.data;
  if (Array.isArray(d.errors)) {
    return d.errors.map(e => ({
      errorId: e.errorId,
      message: e.message,
      category: e.category,
      longMessage: e.longMessage,
    }));
  }
  if (d.error_description) return { code: d.error, description: d.error_description };
  return null;
}

// ── Image hosting ─────────────────────────────────────────────────────────────
const IMAGES_FILE = path.join(__dirname, '..', 'images.json');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB

const ALLOWED_IMAGE_HOSTS = [
  'amazon.com', 'amazonaws.com', 'walmart.com', 'walmartimages.com',
  'ibb.co', 'i.ibb.co', 'ebayimg.com', 'images-amazon.com',
  'm.media-amazon.com', 'i5.walmartimages.com',
];

function isAllowedImageHost(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return ALLOWED_IMAGE_HOSTS.some(a => h === a || h.endsWith('.' + a));
  } catch { return false; }
}

function saveHostedImage(originalUrl, hostedUrl) {
  let images = [];
  try { images = JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf8')); } catch (e) {}
  images.unshift({ hostedUrl, originalUrl, savedAt: new Date().toISOString() });
  fs.writeFileSync(IMAGES_FILE, JSON.stringify(images, null, 2));
}

async function uploadBufferToImgBB(buffer) {
  const key = process.env.IMGBB_API_KEY;
  if (!key) throw new Error('IMGBB_API_KEY not set in .env — get a free key at api.imgbb.com');
  const base64 = buffer.toString('base64');
  const r = await axios.post(
    'https://api.imgbb.com/1/upload?key=' + key,
    'image=' + encodeURIComponent(base64),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
  );
  if (r.data && r.data.data && r.data.data.url) return r.data.data.url;
  throw new Error('Unexpected ImgBB response: ' + JSON.stringify(r.data));
}

async function reHostImage(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('http')) return imageUrl;
  if (imageUrl.includes('ibb.co')) return imageUrl;
  if (!isAllowedImageHost(imageUrl)) {
    console.log('[rehost] Blocked non-allowlisted host:', imageUrl);
    return imageUrl;
  }
  let imageBuffer;
  try {
    const imgRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: MAX_IMAGE_BYTES,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    imageBuffer = Buffer.from(imgRes.data);
    if (imageBuffer.length > MAX_IMAGE_BYTES) throw new Error('Image too large');
    console.log('Image downloaded:', imageBuffer.length, 'bytes');
  } catch (e) {
    throw new Error('Could not download image (' + e.message + ')');
  }
  const hosted = await uploadBufferToImgBB(imageBuffer);
  console.log('Image re-hosted:', hosted);
  saveHostedImage(imageUrl, hosted);
  return hosted;
}

module.exports = {
  ebayErrDetail,
  IMAGES_FILE,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_HOSTS,
  isAllowedImageHost,
  saveHostedImage,
  uploadBufferToImgBB,
  reHostImage,
};
