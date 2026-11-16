// Fly.io server for the browser-in-a-browser.
// Serves the browser UI and proxies pages server-side with streaming,
// so heavy pages load progressively and video can use Range/206.
// Run: node server.js   (PORT env or 8080)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT || 8080);
const PROXY_PATH = '/proxy';

function proxyUrl(u, base) {
  try {
    const abs = new URL(u, base).toString();
    if (!/^https?:/.test(abs)) return u;
    return PROXY_PATH + '?url=' + encodeURIComponent(abs);
  } catch (e) {
    return u;
  }
}

const BOOTSTRAP = (pageUrl) => `<script>
(function(){
  var PAGE_URL = ${JSON.stringify(pageUrl)};

  // --- safety shims so heavy apps (YouTube) don't die on boot ---
  try {
    if (!('serviceWorker' in navigator)) {
      Object.defineProperty(navigator, 'serviceWorker', { value: {
        register: function(){ return Promise.reject(new Error('no-sw')); },
        getRegistration: function(){ return Promise.resolve(undefined); }
      }, configurable: true });
    }
  } catch(e){}
  try {
    if (!window.caches) {
      window.caches = {
        open: function(){ return Promise.reject(new Error('no-caches')); },
        match: function(){ return Promise.resolve(undefined); },
        keys: function(){ return Promise.resolve([]); }
      };
    }
  } catch(e){}
  try {
    if (window.indexedDB) {
      var _open = window.indexedDB.open.bind(window.indexedDB);
      window.indexedDB.open = function(){
        try { return _open.apply(null, arguments); }
        catch(e){
          var r = {};
          setTimeout(function(){ if (r.onerror) r.onerror({ target: r }); }, 0);
          return r;
        }
      };
    }
  } catch(e){}
  try {
    if (!window.BroadcastChannel) {
      window.BroadcastChannel = function(){ this.postMessage = function(){}; this.close = function(){}; };
    }
  } catch(e){}

  // --- cookie jar (kept in localStorage, sent as a header) ---
  var JAR_KEY = 'nb-cookie-jar';
  function getJar(){ try { return JSON.parse(localStorage.getItem(JAR_KEY) || '{}'); } catch(e){ return {}; } }
  function saveJar(j){ try { localStorage.setItem(JAR_KEY, JSON.stringify(j)); } catch(e){} }
  function jarHeader(host){
    var j = getJar(); var out = [];
    Object.keys(j).forEach(function(k){
      if (k === host || host.endsWith('.' + k)) {
        Object.keys(j[k]).forEach(function(n){ out.push(n + '=' + j[k][n]); });
      }
    });
    return out.join('; ');
  }
  function storeCookies(host, header){
    if (!header) return;
    var j = getJar(); j[host] = j[host] || {};
    header.split(/,(?=\\s*[^;,=]+=[^;,]*)/).forEach(function(part){
      var m = part.match(/^\\s*([^=;]+)=([^;]*)/);
      if (m) j[host][m[1].trim()] = m[2].trim();
    });
    saveJar(j);
  }
  function pageHost(){ try { return new URL(PAGE_URL).hostname; } catch(e){ return location.hostname; } }

  // --- route the page's own fetch/XHR through the proxy ---
  function toProxy(u){
    try {
      var abs = new URL(u, PAGE_URL).href;
      if (abs.indexOf(location.origin + '/proxy') === 0) return abs;
      if (!/^https?:/.test(abs)) return null;
      return '/proxy?url=' + encodeURIComponent(abs);
    } catch(e){ return null; }
  }
  var _fetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    var u = (typeof input === 'string') ? input : (input && input.url);
    var p = toProxy(u);
    if (!p) return _fetch(input, init);
    var opts = init ? Object.assign({}, init) : {};
    opts.headers = new Headers(opts.headers || {});
    var h = jarHeader(pageHost());
    if (h) opts.headers.set('x-proxy-cookie', h);
    if (typeof input !== 'string' && input && input.method && !opts.method) opts.method = input.method;
    return _fetch(p, opts).then(function(r){
      var sc = r.headers.get('x-proxy-set-cookie');
      if (sc) storeCookies(pageHost(), sc);
      return r;
    });
  };
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, u){
    this._nbProxy = toProxy(u);
    var args = Array.prototype.slice.call(arguments);
    args[1] = this._nbProxy || u;
    return _open.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function(body){
    var h = jarHeader(pageHost());
    if (h && this._nbProxy) { try { this.setRequestHeader('x-proxy-cookie', h); } catch(e){} }
    var self = this;
    this.addEventListener('load', function(){
      try {
        var sc = self.getResponseHeader('x-proxy-set-cookie');
        if (sc) storeCookies(pageHost(), sc);
      } catch(e){}
    });
    return _send.call(this, body);
  };

  // --- tell the parent our title, and surface page errors ---
  function postTitle(){ try { window.parent.postMessage({ type: 'nb-title', title: document.title }, '*'); } catch(e){} }
  document.addEventListener('DOMContentLoaded', postTitle);
  if (document.querySelector('title')) {
    new MutationObserver(postTitle).observe(document.querySelector('title'), { childList: true, subtree: true });
  }
  window.addEventListener('error', function(e){
    try { window.parent.postMessage({ type: 'nb-error', message: (e && e.message) || 'page error' }, '*'); } catch(err){}
  });
})();
</script>`;

function rewriteHtml(html, base) {
  const boot =
    `<base href="${PROXY_PATH}?url=${encodeURIComponent(base.toString())}">` +
    BOOTSTRAP(base.toString());
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + boot);
  else html = boot + html;

  html = html.replace(/((?:href|src|action|poster)\s*=\s*["'])([^"']+)(["'])/gi, (m, pre, u, post) => {
    if (/^(data:|javascript:|mailto:|tel:|blob:|#)/i.test(u)) return m;
    return pre + proxyUrl(u, base) + post;
  });
  html = html.replace(/srcset\s*=\s*["']([^"']+)["']/gi, (m, val) => {
    const out = val.split(',').map((p) => {
      const parts = p.trim().split(/\s+/);
      if (!parts[0]) return p;
      return [proxyUrl(parts[0], base), ...parts.slice(1)].join(' ');
    }).join(', ');
    return 'srcset="' + out + '"';
  });
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    if (/^(data:|blob:|#)/i.test(u)) return m;
    return 'url(' + q + proxyUrl(u, base) + q + ')';
  });
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
  return html;
}

async function handleProxy(req, res, u) {
  const target = u.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing ?url=');
    return;
  }
  let url;
  try {
    url = new URL(target);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad URL');
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Only http/https URLs');
    return;
  }

  const method = (req.method || 'GET').toUpperCase();
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: req.headers.accept || '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (req.headers['x-proxy-cookie']) headers.Cookie = req.headers['x-proxy-cookie'];
  if (req.headers.range) headers.Range = req.headers.range; // video chunks

  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  }

  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      method,
      headers,
      body: body && body.length ? body : undefined,
      redirect: 'follow',
    });
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Fetch failed: ' + (e && e.message ? e.message : e));
    return;
  }

  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  const outHeaders = {};
  const setCookie = upstream.headers.get('set-cookie');
  if (setCookie) outHeaders['x-proxy-set-cookie'] = setCookie;

  if (type.includes('text/html')) {
    const html = rewriteHtml(await upstream.text(), url);
    outHeaders['Content-Type'] = 'text/html; charset=utf-8';
    outHeaders['Cache-Control'] = 'no-store';
    res.writeHead(upstream.status, outHeaders);
    res.end(html);
    return;
  }

  if (type.includes('text/css')) {
    let css = await upstream.text();
    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, uu) => {
      if (/^(data:|blob:|#)/i.test(uu)) return m;
      return 'url(' + q + proxyUrl(uu, url) + q + ')';
    });
    outHeaders['Content-Type'] = 'text/css; charset=utf-8';
    outHeaders['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(upstream.status, outHeaders);
    res.end(css);
    return;
  }

  // stream everything else (images, JS, fonts, video) with Range support
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/octet-stream';
  res.writeHead(upstream.status, outHeaders);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

const server = http.createServer((req, res) => {
  (async () => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
      return;
    }
    if (u.pathname === PROXY_PATH) {
      await handleProxy(req, res, u);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  })().catch((e) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error: ' + (e && e.message ? e.message : e));
  });
});

server.listen(PORT, () => console.log('Browser server listening on :' + PORT));
