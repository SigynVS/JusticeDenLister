const fs = require('fs');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Justice Den Lister</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#1a1a2e;color:#eee}
header{background:#16213e;padding:20px 40px;border-bottom:2px solid #e94560}
header h1{color:#e94560;font-size:24px}
header p{color:#aaa;font-size:13px}
.container{max-width:1100px;margin:30px auto;padding:0 20px}
.tabs{display:flex;gap:10px;margin-bottom:25px;flex-wrap:wrap}
.tab{padding:10px 24px;border-radius:6px;border:none;cursor:pointer;font-size:14px;background:#16213e;color:#aaa}
.tab.active{background:#e94560;color:white}
.panel{display:none}
.panel.active{display:block}
.card{background:#16213e;border-radius:10px;padding:25px;margin-bottom:20px}
.card h2{font-size:16px;margin-bottom:20px;color:#e94560}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.form-group{display:flex;flex-direction:column;gap:6px}
.form-group.full{grid-column:1/-1}
label{font-size:12px;color:#aaa;text-transform:uppercase}
input,select,textarea{background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px 12px;color:#eee;font-size:14px;width:100%}
textarea{height:120px;resize:vertical}
.btn{padding:12px 24px;border-radius:6px;border:none;cursor:pointer;font-size:14px;font-weight:bold;margin-right:8px}
.btn-primary{background:#e94560;color:white}
.btn-secondary{background:#0f3460;color:white}
.btn-green{background:#4ecca3;color:#1a1a2e}
.btn:hover{opacity:0.9}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin-bottom:25px}
.stat{background:#16213e;border-radius:10px;padding:20px;text-align:center}
.stat h3{font-size:28px;color:#e94560}
.stat p{font-size:12px;color:#aaa;margin-top:5px}
.item-card{background:#0f3460;border-radius:8px;padding:12px;margin-top:10px}
.item-card h4{font-size:13px;color:#eee;margin-bottom:5px}
.item-card p{font-size:12px;color:#4ecca3}
.search-row{display:flex;gap:10px;margin-bottom:15px}
.search-row input{flex:1}
.walmart-result{background:#0f3460;border-radius:10px;padding:20px;margin-top:15px}
.walmart-result h3{color:#4ecca3;margin-bottom:10px;font-size:15px}
.price-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:15px 0}
.price-item{background:#1a1a2e;border-radius:8px;padding:12px;text-align:center}
.price-item p{font-size:11px;color:#aaa;margin-bottom:4px}
.price-item h4{font-size:18px;color:#4ecca3}
.template-btn{padding:8px 16px;background:#0f3460;border:1px solid #e94560;border-radius:6px;color:#e94560;cursor:pointer;font-size:13px;margin-right:8px;margin-bottom:8px}
.template-btn:hover{background:#e94560;color:white}
</style>
</head>
<body>
<header>
<h1>Justice Den Lister</h1>
<p>eBay Listing Management Tool</p>
</header>
<div class="container">
<div class="tabs">
<button class="tab active" onclick="showTab('dashboard',this)">Dashboard</button>
<button class="tab" onclick="showTab('walmart',this)">Walmart Importer</button>
<button class="tab" onclick="showTab('research',this)">Product Research</button>
<button class="tab" onclick="showTab('create',this)">Create Listing</button>
<button class="tab" onclick="showTab('calculator',this)">Profit Calculator</button>
<button class="tab" onclick="showTab('templates',this)">Templates</button>
</div>

<div id="dashboard" class="panel active">
<div class="stats">
<div class="stat"><h3>1</h3><p>Active Listings</p></div>
<div class="stat"><h3>$139.99</h3><p>Total Value</p></div>
<div class="stat"><h3>justicedenco</h3><p>Store Name</p></div>
</div>
<div class="card">
<h2>Welcome to Justice Den Lister</h2>
<p style="color:#aaa;font-size:14px;line-height:2">
✅ eBay API connected<br>
✅ Walmart Importer ready<br>
✅ Product Research ready<br>
✅ Listing Templates loaded<br>
✅ Profit Calculator ready
</p>
</div>
</div>

<div id="walmart" class="panel">
<div class="card">
<h2>Walmart to eBay Importer</h2>
<p style="color:#aaa;font-size:13px;margin-bottom:15px">Paste any Walmart product URL to generate an optimized eBay listing</p>
<div class="search-row">
<input type="text" id="walmart-url" placeholder="https://www.walmart.com/ip/Product-Name/1234567890"/>
<button class="btn btn-primary" onclick="importWalmart()">Import</button>
</div>
<div id="walmart-loading" style="display:none;color:#aaa;margin-top:10px;font-size:13px">Loading product data...</div>
<div id="walmart-error" style="display:none;color:#e94560;margin-top:10px;font-size:13px"></div>
<div id="walmart-result" style="display:none">
<div class="walmart-result">
<h3 id="w-title"></h3>
<div class="price-row">
<div class="price-item"><p>Walmart Price</p><h4 id="w-price"></h4></div>
<div class="price-item"><p>Suggested eBay Price</p><h4 id="w-ebay-price"></h4></div>
<div class="price-item"><p>Est. Profit</p><h4 id="w-profit"></h4></div>
</div>
<button class="btn btn-green" onclick="sendToListing()">Send to Listing Form</button>
</div>
</div>
</div>
</div>

<div id="research" class="panel">
<div class="card">
<h2>Product Research</h2>
<div class="search-row">
<input type="text" id="search-q" placeholder="Search eBay products..."/>
<button class="btn btn-primary" onclick="searchProducts()">Search</button>
</div>
<div id="research-stats" style="display:none;margin-bottom:15px">
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
<div class="stat"><h3 id="r-total">-</h3><p>Total Listings</p></div>
<div class="stat"><h3 id="r-avg">-</h3><p>Avg Price</p></div>
<div class="stat"><h3 id="r-min">-</h3><p>Min Price</p></div>
<div class="stat"><h3 id="r-max">-</h3><p>Max Price</p></div>
</div>
</div>
<div id="research-results"></div>
</div>
</div>

<div id="create" class="panel">
<div class="card">
<h2>Create New eBay Listing</h2>
<div class="form-grid">
<div class="form-group full"><label>Title (80 chars max)</label><input type="text" id="title" maxlength="80" placeholder="Product title..."/></div>
<div class="form-group full"><label>Description</label><textarea id="description" placeholder="Product description..."></textarea></div>
<div class="form-group"><label>Price ($)</label><input type="number" id="price" placeholder="39.99"/></div>
<div class="form-group"><label>Quantity</label><input type="number" id="quantity" value="1"/></div>
<div class="form-group"><label>Category ID</label><input type="text" id="category" placeholder="e.g. 175673"/></div>
<div class="form-group"><label>Condition</label><select id="condition"><option value="NEW">New</option><option value="LIKE_NEW">Like New</option><option value="USED_EXCELLENT">Used - Excellent</option></select></div>
</div>
<br>
<button class="btn btn-primary" onclick="createListing()">Create Listing on eBay</button>
<div id="create-output" style="background:#0f3460;border-radius:8px;padding:15px;margin-top:15px;font-size:12px;color:#4ecca3;white-space:pre-wrap;display:none;max-height:300px;overflow-y:auto"></div>
</div>
</div>

<div id="calculator" class="panel">
<div class="card">
<h2>Profit Calculator</h2>
<div class="form-grid">
<div class="form-group"><label>Your Cost ($)</label><input type="number" id="cost" placeholder="0.00" oninput="calculate()"/></div>
<div class="form-group"><label>eBay Sale Price ($)</label><input type="number" id="sale-price" placeholder="0.00" oninput="calculate()"/></div>
<div class="form-group"><label>Shipping Cost ($)</label><input type="number" id="shipping" placeholder="0.00" oninput="calculate()"/></div>
<div class="form-group"><label>eBay Fee %</label><input type="number" id="fee-pct" value="13.25" oninput="calculate()"/></div>
</div>
<div style="background:#0f3460;border-radius:8px;padding:15px;margin-top:15px">
<p style="font-size:13px;color:#aaa;margin-bottom:5px">Estimated Profit</p>
<h3 id="profit-output" style="font-size:22px;color:#4ecca3">$0.00</h3>
<p id="margin-output" style="margin-top:8px;font-size:13px;color:#aaa">Margin: 0%</p>
</div>
</div>
</div>

<div id="templates" class="panel">
<div class="card">
<h2>Quick Templates</h2>
<button class="template-btn" onclick="loadTemplate('airduster')">Electric Air Duster</button>
<button class="template-btn" onclick="loadTemplate('bluetooth')">Bluetooth Speaker</button>
<button class="template-btn" onclick="loadTemplate('earbuds')">Wireless Earbuds</button>
<button class="template-btn" onclick="loadTemplate('smartwatch')">Smartwatch</button>
<button class="template-btn" onclick="loadTemplate('firepit')">Fire Pit</button>
<button class="template-btn" onclick="loadTemplate('tools')">Tools</button>
</div>
</div>

</div>
<script>
let walmartData=null;
function showTab(id,el){document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));document.getElementById(id).classList.add('active');el.classList.add('active');}
function calculate(){const cost=parseFloat(document.getElementById('cost').value)||0;const sp=parseFloat(document.getElementById('sale-price').value)||0;const sh=parseFloat(document.getElementById('shipping').value)||0;const fp=parseFloat(document.getElementById('fee-pct').value)||13.25;const fee=sp*(fp/100);const profit=sp-cost-sh-fee-0.30;const margin=sp>0?((profit/sp)*100).toFixed(1):0;document.getElementById('profit-output').textContent='$'+profit.toFixed(2);document.getElementById('margin-output').textContent='Margin: '+margin+'%';document.getElementById('profit-output').style.color=profit>0?'#4ecca3':'#e94560';}
async function importWalmart(){const url=document.getElementById('walmart-url').value.trim();const rd=document.getElementById('walmart-result');const ed=document.getElementById('walmart-error');const ld=document.getElementById('walmart-loading');rd.style.display='none';ed.style.display='none';ld.style.display='block';if(!url.includes('walmart.com')){ld.style.display='none';ed.textContent='Please enter a valid Walmart URL';ed.style.display='block';return;}try{const res=await fetch('/api/walmart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});const data=await res.json();ld.style.display='none';if(data.error){ed.textContent='Error: '+data.error;ed.style.display='block';return;}walmartData=data;document.getElementById('w-title').textContent=data.ebayTitle;document.getElementById('w-price').textContent=data.price?'$'+data.price:'N/A';document.getElementById('w-ebay-price').textContent=data.suggestedEbayPrice?'$'+data.suggestedEbayPrice:'N/A';document.getElementById('w-profit').textContent=data.estimatedProfit?'$'+data.estimatedProfit:'N/A';rd.style.display='block';}catch(e){ld.style.display='none';ed.textContent='Error: '+e.message;ed.style.display='block';}}
function sendToListing(){if(!walmartData)return;document.getElementById('title').value=walmartData.ebayTitle||'';document.getElementById('description').value=walmartData.ebayDescription||'';document.getElementById('price').value=walmartData.suggestedEbayPrice||'';document.querySelector('.tab:nth-child(4)').click();}
async function searchProducts(){const q=document.getElementById('search-q').value||'fire pit';const rd=document.getElementById('research-results');const sd=document.getElementById('research-stats');rd.innerHTML='<p style="color:#aaa">Searching...</p>';try{const res=await fetch('/api/terapeak?q='+encodeURIComponent(q));const data=await res.json();if(data.error){rd.innerHTML='<p style="color:#e94560">Error: '+data.error+'</p>';return;}sd.style.display='block';document.getElementById('r-total').textContent=data.totalResults?data.totalResults.toLocaleString():'0';document.getElementById('r-avg').textContent='$'+data.avgPrice;document.getElementById('r-min').textContent='$'+data.minPrice;document.getElementById('r-max').textContent='$'+data.maxPrice;rd.innerHTML=data.items.map(i=>'<div class="item-card"><h4>'+i.title+'</h4><p>$'+i.price+' - '+i.condition+' - Seller: '+i.seller+'</p></div>').join('');}catch(e){rd.innerHTML='<p style="color:#e94560">Error: '+e.message+'</p>';}}
async function createListing(){const out=document.getElementById('create-output');out.style.display='block';out.textContent='Creating...';const body={title:document.getElementById('title').value,description:document.getElementById('description').value,price:document.getElementById('price').value,quantity:document.getElementById('quantity').value,category:document.getElementById('category').value,condition:document.getElementById('condition').value};try{const res=await fetch('/api/create-listing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();out.textContent=JSON.stringify(data,null,2);}catch(e){out.textContent='Error: '+e.message;}}
const templates={airduster:{title:'Electric Air Duster Cordless Compressed Air Blower Computer Keyboard Cleaner New',description:'Electric Air Duster\\n\\nPowerful cordless cleaning solution.\\n\\nJustice Den - Quality you can trust.',price:'39.99',category:'175701'},bluetooth:{title:'Bluetooth Speaker Portable Wireless Waterproof 20W Deep Bass New',description:'Bluetooth Speaker\\n\\nJustice Den - Quality you can trust.',price:'49.99',category:'14969'},earbuds:{title:'Wireless Earbuds Bluetooth 5.3 Active Noise Cancelling 48Hr Battery New',description:'Wireless Earbuds\\n\\nJustice Den - Quality you can trust.',price:'39.99',category:'112529'},smartwatch:{title:'Smart Watch Fitness Tracker Heart Rate Monitor iOS Android Compatible New',description:'Smartwatch\\n\\nJustice Den - Quality you can trust.',price:'59.99',category:'178893'},firepit:{title:'32 Inch American Flag Fire Pit Outdoor Wood Burning Patio Backyard New',description:'Fire Pit\\n\\nJustice Den - Quality you can trust.',price:'139.99',category:'175673'},tools:{title:'Professional Tool Set Heavy Duty Home Repair Kit Complete Set New',description:'Tool Set\\n\\nJustice Den - Quality you can trust.',price:'49.99',category:'631'}};
function loadTemplate(name){const t=templates[name];document.getElementById('title').value=t.title;document.getElementById('description').value=t.description;document.getElementById('price').value=t.price;document.getElementById('category').value=t.category;document.querySelector('.tab:nth-child(4)').click();}
</script>
</body>
</html>`;

fs.writeFileSync('public/index.html', html);
console.log('Done! Size:', fs.statSync('public/index.html').size);