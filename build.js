'use strict';
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT  = __dirname;
const DIST  = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.lib-cache');

const LIBS = {
  marked:  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  mermaid: 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js',
};

// ── helpers ────────────────────────────────────────────────────────────────

function die(msg) {
  console.error('\n\x1b[31mError:\x1b[0m ' + msg + '\n');
  process.exit(1);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, { headers: { 'User-Agent': 'presentation-build/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200)
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getLib(name, url) {
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
  const cached = path.join(CACHE, name + '.min.js');
  if (fs.existsSync(cached)) {
    console.log('  [cached] ' + name);
    return fs.readFileSync(cached, 'utf8');
  }
  console.log('  [download] ' + name + ' …');
  const buf = await download(url);
  fs.writeFileSync(cached, buf);
  console.log('  [saved]    ' + name);
  return buf.toString('utf8');
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',  '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

const VIDEO_EXTS = new Set(['.mp4', '.webm']);

function fileToBase64(p) {
  const ext  = path.extname(p).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseSlidesFile(md) {
  return md
    .split(/^---\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function getImageDimensions(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === '.png') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (ext === '.gif') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xFF) break;
      const marker = buf[i + 1];
      if (marker >= 0xC0 && marker <= 0xC3) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (ext === '.webp') {
    const fmt = buf.slice(12, 16).toString('ascii');
    if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
    if (fmt === 'VP8L') { const b = buf.readUInt32LE(25); return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 }; }
    if (fmt === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (ext === '.svg') {
    const s = buf.toString('utf8', 0, Math.min(buf.length, 2048));
    const wm = s.match(/\bwidth="([0-9.]+)"/);
    const hm = s.match(/\bheight="([0-9.]+)"/);
    if (wm && hm) return { width: parseFloat(wm[1]), height: parseFloat(hm[1]) };
    const vb = s.match(/viewBox="[0-9. ]*?([0-9.]+)\s+([0-9.]+)"\s/);
    if (vb) return { width: parseFloat(vb[1]), height: parseFloat(vb[2]) };
  }
  return null;
}

function normalizeSlideCoords(slides, imgWidth, imgHeight) {
  return slides.map(slide => {
    if (!slide.image_center) return slide;
    const { x, y } = slide.image_center;
    if (x > 1 || y > 1) {
      return Object.assign({}, slide, {
        image_center: { x: x / imgWidth, y: y / imgHeight }
      });
    }
    return slide;
  });
}

function inlineImages(mdContent, root) {
  return mdContent.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
    if (/^(https?:|data:)/.test(src)) return m;
    const p = path.resolve(root, src);
    if (!fs.existsSync(p)) {
      console.warn('  [warn] image not found: ' + p);
      return m;
    }
    return '![' + alt + '](' + fileToBase64(p) + ')';
  });
}

// ── CSS ───────────────────────────────────────────────────────────────────

const CSS = String.raw`
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden}

/* ── themes ── */
[data-theme="obsidian"]{
  --bg:#0f1117;--surface:#1a1d27;--text:#e8eaf0;--accent:#7c6af7;
  --h-font:'DM Sans','Inter',sans-serif;--b-font:'Inter',sans-serif;
  --code-bg:#0d1017;--code-text:#c5c8d6;--sb:#3a3d4d;--prog:#7c6af7;
  --border:rgba(255,255,255,.07);--overlay:rgba(0,0,0,.55)
}
[data-theme="paper"]{
  --bg:#faf8f4;--surface:#fff;--text:#1a1a1a;--accent:#c0533a;
  --h-font:'Playfair Display',Georgia,serif;--b-font:'Source Sans 3','Helvetica Neue',sans-serif;
  --code-bg:#f2ede6;--code-text:#3a2a20;--sb:#c8c0b4;--prog:#c0533a;
  --border:rgba(0,0,0,.08);--overlay:rgba(0,0,0,.35)
}
[data-theme="aurora"]{
  --bg:#0a0e1a;--surface:#111827;--text:#f0f4ff;--accent:#22d3ee;--accent2:#a78bfa;
  --h-font:'Space Grotesk','Inter',sans-serif;--b-font:'Inter',sans-serif;
  --code-bg:#0a0e1a;--code-text:#a5f3fc;--sb:#2a3450;--prog:#22d3ee;
  --border:rgba(255,255,255,.07);--overlay:rgba(0,0,0,.55)
}
[data-theme="midnight"]{
  --bg:#020617;--surface:#0f172a;--text:#e2e8f0;--accent:#38bdf8;--accent2:#818cf8;
  --h-font:'DM Sans','Inter',sans-serif;--b-font:'Inter',sans-serif;
  --code-bg:#020617;--code-text:#7dd3fc;--sb:#1e3a8a;--prog:#38bdf8;
  --border:rgba(255,255,255,.07);--overlay:rgba(0,0,0,.60)
}
[data-theme="forest"]{
  --bg:#0a1a0a;--surface:#122012;--text:#dcfce7;--accent:#4ade80;
  --h-font:'Space Grotesk','Inter',sans-serif;--b-font:'Inter',sans-serif;
  --code-bg:#071507;--code-text:#86efac;--sb:#166534;--prog:#4ade80;
  --border:rgba(255,255,255,.07);--overlay:rgba(0,0,0,.55)
}
[data-theme="sand"]{
  --bg:#fdf8f0;--surface:#fffcf7;--text:#292524;--accent:#d97706;
  --h-font:'Playfair Display',Georgia,serif;--b-font:'Source Sans 3','Helvetica Neue',sans-serif;
  --code-bg:#fef3c7;--code-text:#78350f;--sb:#d4b896;--prog:#d97706;
  --border:rgba(0,0,0,.08);--overlay:rgba(0,0,0,.35)
}
[data-theme="jungle"]{
  --bg:#071a0a;--surface:#0d2410;--text:#e8f5e9;--accent:#4caf50;
  --h-font:'Space Grotesk','Inter',sans-serif;--b-font:'Inter',sans-serif;
  --code-bg:#051008;--code-text:#a5d6a7;--sb:#2d6a30;--prog:#4caf50;
  --border:rgba(255,255,255,.07);--overlay:rgba(0,0,0,.55)
}

body{background:var(--bg);color:var(--text);font-family:var(--b-font)}

/* ── layout ── */
#app{display:flex;flex-direction:column;width:1280px;height:720px;position:absolute;transform-origin:0 0;overflow:hidden}

#image-panel{
  position:relative;width:100%;height:33.33%;
  flex-shrink:0;overflow:hidden;background:#000
}
#hero-image{
  position:absolute;
  will-change:transform;
  transition:transform var(--tdur,500ms) ease-in-out
}

#content-panel{
  position:relative;flex:1;
  overflow:hidden;background:var(--surface)
}

.slide-pane{
  position:absolute;inset:0;
  overflow-y:auto;padding:2.4rem 3.2rem 5rem;
}
.slide-pane::-webkit-scrollbar{width:5px}
.slide-pane::-webkit-scrollbar-track{background:transparent}
.slide-pane::-webkit-scrollbar-thumb{background:var(--sb);border-radius:3px}

/* ── typography ── */
.slide-pane h1{
  font-family:var(--h-font);font-size:2.64rem;
  font-weight:700;color:var(--accent);margin-bottom:1rem;line-height:1.15
}
[data-theme="aurora"] .slide-pane h1{
  background:linear-gradient(90deg,#22d3ee,#a78bfa);
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;color:transparent
}
[data-theme="midnight"] .slide-pane h1{
  background:linear-gradient(90deg,#38bdf8,#818cf8);
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;color:transparent
}
.slide-pane h2{font-family:var(--h-font);font-size:1.76rem;font-weight:600;margin:1.4rem 0 .5rem;color:var(--text)}
.slide-pane h3{font-family:var(--h-font);font-size:1.21rem;font-weight:600;margin:1rem 0 .4rem;color:var(--text);opacity:.85}
.slide-pane p{line-height:1.75;margin-bottom:.8rem}
.slide-pane ul,.slide-pane ol{padding-left:1.6rem;margin-bottom:.8rem}
.slide-pane li{line-height:1.65;margin-bottom:.25rem}
.slide-pane a{color:var(--accent);text-decoration:underline}
.slide-pane blockquote{
  border-left:3px solid var(--accent);
  padding:.2rem 1rem;margin:.8rem 0;opacity:.8
}
.slide-pane code{
  background:var(--code-bg);color:var(--code-text);
  padding:.15em .38em;border-radius:4px;font-size:.968em;font-family:monospace
}
.slide-pane pre{
  background:var(--code-bg);border-left:3px solid var(--accent);
  border-radius:6px;padding:1rem 1.2rem;margin-bottom:1rem;overflow-x:auto
}
.slide-pane pre code{background:none;padding:0;font-size:.935em}
.slide-pane table{width:100%;border-collapse:collapse;margin-bottom:1rem}
.slide-pane th,.slide-pane td{
  padding:.4rem .8rem;border:1px solid var(--border);text-align:left
}
.slide-pane th{background:var(--code-bg);font-weight:600}
.slide-pane img{max-width:100%;border-radius:6px;margin:.4rem 0}
.slide-pane hr{border:none;border-top:1px solid var(--border);margin:1.2rem 0}

/* ── mermaid wrapper ── */
.slide-pane .mermaid{margin:1rem 0;text-align:center}

/* ── controls overlay ── */
#controls{
  position:absolute;bottom:1rem;left:0;right:0;
  display:flex;align-items:center;justify-content:center;gap:.8rem;
  z-index:100;opacity:0;transition:opacity .2s;pointer-events:none
}
#app:hover #controls,#controls:focus-within{opacity:1;pointer-events:auto}

.nav-btn{
  background:var(--overlay);backdrop-filter:blur(6px);
  color:var(--text);border:1px solid var(--border);
  border-radius:50%;width:2.4rem;height:2.4rem;
  font-size:1.54rem;line-height:1;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:background .15s
}
.nav-btn:hover{background:var(--accent)}

#slide-counter{
  color:var(--text);font-size:.88rem;opacity:.75;
  background:var(--overlay);backdrop-filter:blur(6px);
  padding:.25rem .6rem;border-radius:20px;border:1px solid var(--border)
}

#btn-fullscreen{
  background:var(--overlay);backdrop-filter:blur(6px);
  color:var(--text);border:1px solid var(--border);
  border-radius:6px;padding:.3rem .55rem;font-size:.99rem;
  cursor:pointer;transition:background .15s
}
#btn-fullscreen:hover{background:var(--accent)}

#slide-dots{display:flex;gap:.4rem;align-items:center}
.dot{
  width:7px;height:7px;border-radius:50%;
  border:none;padding:0;cursor:pointer;
  background:rgba(128,128,128,.4);
  transition:background .2s,transform .2s
}
.dot.active{background:var(--accent);transform:scale(1.35)}

/* ── progress bar ── */
#progress-bar-wrap{
  position:absolute;bottom:0;left:0;right:0;
  height:3px;z-index:200;background:rgba(128,128,128,.15)
}
#progress-bar{height:100%;background:var(--prog);width:0%;transition:width .35s ease}

/* ── slide transitions ── */
@keyframes exitLeft{from{transform:translateX(0);opacity:1}to{transform:translateX(-8%);opacity:0}}
@keyframes exitRight{from{transform:translateX(0);opacity:1}to{transform:translateX(8%);opacity:0}}
@keyframes enterRight{from{transform:translateX(8%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes enterLeft{from{transform:translateX(-8%);opacity:0}to{transform:translateX(0);opacity:1}}

.exit-left {animation:exitLeft  var(--tdur,500ms) ease-in-out both}
.exit-right{animation:exitRight var(--tdur,500ms) ease-in-out both}
.enter-right{animation:enterRight var(--tdur,500ms) ease-in-out both}
.enter-left {animation:enterLeft  var(--tdur,500ms) ease-in-out both}

@media(prefers-reduced-motion:reduce){
  .exit-left,.exit-right,.enter-right,.enter-left{animation:none!important}
  #hero-image{transition:none!important}
}

/* ── overview ── */
#overview{
  position:fixed;inset:0;background:rgba(0,0,0,.92);
  z-index:500;overflow-y:auto;padding:2rem;display:flex;flex-direction:column
}
#overview.hidden{display:none}
#overview-header{
  display:flex;justify-content:flex-end;margin-bottom:1.5rem
}
#overview-close{
  background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);
  border-radius:6px;padding:.35rem .8rem;cursor:pointer;font-size:.99rem
}
#overview-close:hover{background:rgba(255,255,255,.2)}
#overview-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:1.2rem;max-width:1200px;margin:0 auto;width:100%
}
.ov-card{
  background:var(--surface);border-radius:8px;overflow:hidden;
  cursor:pointer;border:2px solid transparent;
  transition:border-color .15s,transform .15s
}
.ov-card:hover{border-color:var(--accent);transform:scale(1.03)}
.ov-card.active{border-color:var(--accent)}
.ov-img{
  width:100%;height:72px;overflow:hidden;position:relative;
  background:var(--code-bg)
}
.ov-img img{position:absolute;will-change:transform}
.ov-body{padding:.45rem .7rem}
.ov-num{font-size:.715rem;opacity:.5;margin-bottom:.2rem}
.ov-title{
  font-size:.858rem;font-weight:600;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--text)
}
`;

// ── App JS ─────────────────────────────────────────────────────────────────

const APP_JS = String.raw`
(function(){
'use strict';

var cfg      = JSON.parse(document.getElementById('deck-config').textContent);
var slideData= JSON.parse(document.getElementById('slide-data').textContent);
var TOTAL    = slideData.length;
var current  = 0;
var transitioning = false;
var queued   = null;
var ovOpen   = false;

var TDUR = cfg.transition_duration_ms || 500;
document.documentElement.style.setProperty('--tdur', TDUR + 'ms');
document.title = cfg.title || 'Presentation';
document.documentElement.setAttribute('data-theme', cfg.theme || 'obsidian');

var heroImg     = document.getElementById('hero-image');
var isVideoHero = heroImg.tagName === 'VIDEO';
var contentPanel = document.getElementById('content-panel');
var paneA      = document.getElementById('slide-pane-a');
var paneB      = document.getElementById('slide-pane-b');
var progBar    = document.getElementById('progress-bar');
var counter    = document.getElementById('slide-counter');
var dotsEl     = document.getElementById('slide-dots');
var overview   = document.getElementById('overview');
var ovGrid     = document.getElementById('overview-grid');
var activePane = paneA;
var inactPane  = paneB;

// ── mermaid ──────────────────────────────────────────────────────────────
function mermaidTheme(){return cfg.theme==='paper'||cfg.theme==='sand'?'default':'dark';}
if(typeof mermaid!=='undefined'){
  mermaid.initialize({startOnLoad:false,theme:mermaidTheme()});
}

function runMermaid(container){
  if(typeof mermaid==='undefined') return;
  container.querySelectorAll('pre code').forEach(function(block){
    if(block.className.indexOf('language-mermaid')>=0){
      var div=document.createElement('div');
      div.className='mermaid';
      div.textContent=block.textContent;
      block.parentElement.replaceWith(div);
    }
  });
  var nodes=container.querySelectorAll('.mermaid:not([data-processed])');
  if(nodes.length){
    try{ mermaid.run({nodes:Array.from(nodes)}); }catch(e){}
  }
}

// ── render slide ─────────────────────────────────────────────────────────
function renderInto(pane, idx){
  pane.innerHTML = marked.parse(slideData[idx].content);
  runMermaid(pane);
  contentPanel.setAttribute('aria-label','Slide '+(idx+1)+' of '+TOTAL);
}

// ── image transform ───────────────────────────────────────────────────────
function applyTransform(idx, animate){
  var nw = heroImg.naturalWidth || heroImg.videoWidth;
  var nh = heroImg.naturalHeight || heroImg.videoHeight;
  if(!nw) return;
  var sc  = (cfg.slides&&cfg.slides[idx])||{};
  var zoom= Math.max(1.0, sc.image_zoom||1.0);
  var cx  = sc.image_center ? Math.max(0,Math.min(1,sc.image_center.x)) : 0.5;
  var cy  = sc.image_center ? Math.max(0,Math.min(1,sc.image_center.y)) : 0.5;

  var panel = document.getElementById('image-panel');
  var pw = panel.clientWidth, ph = panel.clientHeight;
  var sc_cover = Math.max(pw/nw, ph/nh);
  var s = sc_cover * zoom;
  var tx = -s*(cx-0.5)*nw;
  var ty = -s*(cy-0.5)*nh;

  heroImg.style.width  = nw+'px';
  heroImg.style.height = nh+'px';
  heroImg.style.left   = (pw/2 - nw/2)+'px';
  heroImg.style.top    = (ph/2 - nh/2)+'px';
  heroImg.style.transformOrigin = (nw/2)+'px '+(nh/2)+'px';

  if(!animate){
    var prev=heroImg.style.transition;
    heroImg.style.transition='none';
    heroImg.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';
    heroImg.offsetHeight; // flush
    heroImg.style.transition=prev;
  } else {
    heroImg.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';
  }
}

// ── UI update ─────────────────────────────────────────────────────────────
function updateUI(){
  var pct = TOTAL<=1 ? 100 : (current/(TOTAL-1))*100;
  progBar.style.width = pct+'%';
  counter.textContent = (current+1)+' / '+TOTAL;
  document.querySelectorAll('.dot').forEach(function(d,i){
    d.classList.toggle('active', i===current);
  });
  document.querySelectorAll('.ov-card').forEach(function(c,i){
    c.classList.toggle('active', i===current);
  });
}

// ── transition ────────────────────────────────────────────────────────────
function goTo(target, dir){
  if(target<0||target>=TOTAL||target===current) return;
  if(transitioning){
    queued={target:target, dir:dir}; return;
  }
  transitioning=true;

  var exitCls  = dir==='fwd' ? 'exit-left'   : 'exit-right';
  var enterCls = dir==='fwd' ? 'enter-right'  : 'enter-left';

  renderInto(inactPane, target);
  inactPane.style.display='';
  inactPane.scrollTop=0;

  // force reflow so animation starts fresh
  void inactPane.offsetWidth;

  applyTransform(target, true);
  activePane.classList.add(exitCls);
  inactPane.classList.add(enterCls);

  setTimeout(function(){
    activePane.classList.remove(exitCls);
    activePane.style.display='none';
    inactPane.classList.remove(enterCls);

    var tmp=activePane; activePane=inactPane; inactPane=tmp;
    current=target;
    updateUI();
    transitioning=false;

    if(queued){
      var q=queued; queued=null;
      goTo(q.target, q.dir);
    }
  }, TDUR);
}

function next(){ goTo(current+1,'fwd'); }
function prev(){ goTo(current-1,'bwd'); }

// ── keyboard ──────────────────────────────────────────────────────────────
document.addEventListener('keydown', function(e){
  if(ovOpen){
    if(e.key==='Escape') closeOverview();
    return;
  }
  if(e.key==='ArrowRight'||e.key===' '){ e.preventDefault(); next(); }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); prev(); }
  else if(e.key==='f'||e.key==='F'){ toggleFs(); }
  else if(e.key==='Escape'){ openOverview(); }
});

// ── click / touch ─────────────────────────────────────────────────────────
contentPanel.addEventListener('click', function(e){
  if(!ovOpen && !e.target.closest('.nav-btn')) next();
});

var touchX=0;
document.addEventListener('touchstart',function(e){touchX=e.touches[0].clientX;},{passive:true});
document.addEventListener('touchend',function(e){
  var dx=e.changedTouches[0].clientX-touchX;
  if(Math.abs(dx)>=50){ if(dx<0) next(); else prev(); }
});

// ── buttons ───────────────────────────────────────────────────────────────
document.getElementById('btn-prev').addEventListener('click',function(e){e.stopPropagation();prev();});
document.getElementById('btn-next').addEventListener('click',function(e){e.stopPropagation();next();});
document.getElementById('btn-fullscreen').addEventListener('click',function(e){e.stopPropagation();toggleFs();});

function toggleFs(){
  if(!document.fullscreenElement)
    document.documentElement.requestFullscreen().catch(function(){});
  else
    document.exitFullscreen().catch(function(){});
}

// ── overview ──────────────────────────────────────────────────────────────
function extractTitle(md){
  var m=md.match(/^#[ \t]+(.+)$/m);
  return m ? m[1].replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
}

function buildOverview(){
  ovGrid.innerHTML='';
  slideData.forEach(function(slide, i){
    var card=document.createElement('div');
    card.className='ov-card'+(i===current?' active':'');
    card.tabIndex=0;

    // mini image
    var imgWrap=document.createElement('div');
    imgWrap.className='ov-img';
    var mini=document.createElement(isVideoHero?'video':'img');
    mini.src=heroImg.src;
    if(isVideoHero){mini.muted=true;mini.loop=true;mini.autoplay=true;mini.playsInline=true;}
    else{mini.alt='';}

    // compute mini transform (approximate)
    var sc=(cfg.slides&&cfg.slides[i])||{};
    var zoom=Math.max(1.0,sc.image_zoom||1.0);
    var cx=sc.image_center?Math.max(0,Math.min(1,sc.image_center.x)):0.5;
    var cy=sc.image_center?Math.max(0,Math.min(1,sc.image_center.y)):0.5;

    function positionMini(){
      var pw=imgWrap.clientWidth||180, ph=72;
      var nw=(mini.naturalWidth||mini.videoWidth)||1, nh=(mini.naturalHeight||mini.videoHeight)||1;
      var s=Math.max(pw/nw, ph/nh)*zoom;
      var tx=-s*(cx-0.5)*nw, ty=-s*(cy-0.5)*nh;
      mini.style.width=nw+'px'; mini.style.height=nh+'px';
      mini.style.left=(pw/2-nw/2)+'px'; mini.style.top=(ph/2-nh/2)+'px';
      mini.style.transformOrigin=(nw/2)+'px '+(nh/2)+'px';
      mini.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';
    }
    mini.addEventListener(isVideoHero?'loadedmetadata':'load', positionMini);
    if(!isVideoHero&&mini.complete&&mini.naturalWidth) positionMini();

    imgWrap.appendChild(mini);

    var body=document.createElement('div');
    body.className='ov-body';
    body.innerHTML='<div class="ov-num">'+(i+1)+'</div>'
      +'<div class="ov-title">'+(extractTitle(slide.content)||'Slide '+(i+1))+'</div>';

    card.appendChild(imgWrap);
    card.appendChild(body);
    card.addEventListener('click',function(){
      var dir=i>current?'fwd':'bwd';
      closeOverview();
      goTo(i, dir);
    });
    card.addEventListener('keydown',function(e){
      if(e.key==='Enter'||e.key===' ') card.click();
    });
    ovGrid.appendChild(card);
  });
}

function openOverview(){ ovOpen=true; buildOverview(); overview.classList.remove('hidden'); }
function closeOverview(){ ovOpen=false; overview.classList.add('hidden'); }
document.getElementById('overview-close').addEventListener('click',closeOverview);

// ── dots ──────────────────────────────────────────────────────────────────
function buildDots(){
  dotsEl.innerHTML='';
  for(var i=0;i<TOTAL;i++){
    (function(idx){
      var dot=document.createElement('button');
      dot.className='dot'+(idx===0?' active':'');
      dot.setAttribute('aria-label','Go to slide '+(idx+1));
      dot.addEventListener('click',function(e){
        e.stopPropagation();
        goTo(idx, idx>current?'fwd':'bwd');
      });
      dotsEl.appendChild(dot);
    })(i);
  }
}

// ── scale to fit viewport (16:9 reference: 1280×720) ─────────────────────
var REF_W=1280, REF_H=720;
var appEl=document.getElementById('app');
function scaleApp(){
  var scale=Math.min(window.innerWidth/REF_W, window.innerHeight/REF_H);
  appEl.style.left=((window.innerWidth -REF_W*scale)/2)+'px';
  appEl.style.top =((window.innerHeight-REF_H*scale)/2)+'px';
  appEl.style.transform='scale('+scale+')';
}

// ── resize ────────────────────────────────────────────────────────────────
var resizeTimer;
window.addEventListener('resize',function(){
  scaleApp();
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(function(){ applyTransform(current,false); },120);
});

// ── init ──────────────────────────────────────────────────────────────────
function init(){
  buildDots();
  renderInto(activePane, 0);
  inactPane.style.display='none';
  scaleApp();
  applyTransform(0, false);
  updateUI();
}

heroImg.addEventListener(isVideoHero?'loadedmetadata':'load',function(){
  applyTransform(current,false);
});

init();
})();
`;

// ── HTML builder ───────────────────────────────────────────────────────────

function buildHtml(config, slides, heroB64, markedJs, mermaidJs) {
  const theme = escHtml(config.theme || 'obsidian');
  const title = escHtml(config.title || 'Presentation');
  const n     = slides.length;
  const slideJson = JSON.stringify(slides.map(c => ({ content: c })));
  const cfgJson   = JSON.stringify(config);
  const heroIsVideo = VIDEO_EXTS.has(path.extname(config.image).toLowerCase());
  const heroEl = heroIsVideo
    ? `<video id="hero-image" src="${heroB64}" autoplay loop muted playsinline></video>`
    : `<img id="hero-image" src="${heroB64}" alt="Slide background">`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700&family=Playfair+Display:wght@400;700&family=Source+Sans+3:wght@300;400;600&family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<script>${markedJs}</script>
<script>${mermaidJs}</script>
<script type="application/json" id="slide-data">${slideJson}</script>
<script type="application/json" id="deck-config">${cfgJson}</script>
<style>${CSS}</style>
</head>
<body>
<div id="app">
  <div id="image-panel">
    ${heroEl}
  </div>
  <div id="content-panel" role="region" aria-label="Slide 1 of ${n}">
    <div id="slide-pane-a" class="slide-pane"></div>
    <div id="slide-pane-b" class="slide-pane" style="display:none"></div>
  </div>
  <div id="controls">
    <button id="btn-prev" class="nav-btn" aria-label="Previous slide">&#8249;</button>
    <div id="slide-dots"></div>
    <button id="btn-next" class="nav-btn" aria-label="Next slide">&#8250;</button>
    <div id="slide-counter"></div>
    <button id="btn-fullscreen" aria-label="Toggle fullscreen">&#x26F6;</button>
  </div>
  <div id="progress-bar-wrap">
    <div id="progress-bar"></div>
  </div>
</div>
<div id="overview" class="hidden" role="dialog" aria-modal="true" aria-label="Slide overview">
  <div id="overview-header">
    <button id="overview-close">&#10005; Close overview</button>
  </div>
  <div id="overview-grid"></div>
</div>
<script>${APP_JS}</script>
</body>
</html>`;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPresentation Builder\n');

  // 1. deck.json
  const deckPath = path.join(ROOT, 'deck.json');
  if (!fs.existsSync(deckPath)) die('deck.json not found in ' + ROOT);
  let config;
  try { config = JSON.parse(fs.readFileSync(deckPath, 'utf8')); }
  catch(e) { die('deck.json is invalid JSON: ' + e.message); }

  // 2. slides.md
  const slidesPath = path.join(ROOT, 'slides.md');
  if (!fs.existsSync(slidesPath)) die('slides.md not found in ' + ROOT);
  const rawMd = fs.readFileSync(slidesPath, 'utf8');

  // 3. parse
  const slides = parseSlidesFile(rawMd);
  console.log('  Parsed ' + slides.length + ' slide(s).');

  // 4. validate count
  const cfgCount = (config.slides && config.slides.length) || 0;
  if (cfgCount !== slides.length) {
    die(
      'Slide count mismatch:\n' +
      '  deck.json → slides[] has ' + cfgCount + ' entr' + (cfgCount===1?'y':'ies') + '\n' +
      '  slides.md has ' + slides.length + ' slide' + (slides.length===1?'':'s') + '\n' +
      'These must match exactly.'
    );
  }

  // 5. inline images
  const processed = slides.map(s => inlineImages(s, ROOT));

  // 6. hero image
  if (!config.image) die('deck.json must include an "image" field pointing to the hero image.');
  const heroPath = path.resolve(ROOT, config.image);
  if (!fs.existsSync(heroPath)) die('Hero image not found: ' + config.image);
  const heroB64 = fileToBase64(heroPath);
  console.log('  Hero image: ' + config.image + ' (' + (heroB64.length/1024|0) + ' KB base64)');

  // 6.5 normalize pixel coordinates → 0-1
  if (config.slides) {
    const dims = getImageDimensions(heroPath);
    if (dims) {
      config.slides = normalizeSlideCoords(config.slides, dims.width, dims.height);
    } else {
      console.warn('  [warn] Could not read image dimensions — image_center values must be normalized (0-1).');
    }
  }

  // 7. libs
  const [markedJs, mermaidJs] = await Promise.all([
    getLib('marked',  LIBS.marked),
    getLib('mermaid', LIBS.mermaid),
  ]);

  // 8. build
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const html = buildHtml(config, processed, heroB64, markedJs, mermaidJs);
  const outPath = path.join(DIST, 'index.html');
  fs.writeFileSync(outPath, html, 'utf8');

  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log('\n\x1b[32m✓ Built dist/index.html (' + kb + ' KB)\x1b[0m');
  console.log('  Open in your browser: file://' + outPath.replace(/\\/g, '/') + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
