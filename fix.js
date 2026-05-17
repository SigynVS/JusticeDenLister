const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');
s = s.replace(
  '"https://api.ebay.com/oauth/api_scope"',
  '"https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.fulfillment"'
);
fs.writeFileSync('server.js', s);
console.log('Done!');