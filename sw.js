const CACHE = 'btc-swap-workbench-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.url.includes('okx.com/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
