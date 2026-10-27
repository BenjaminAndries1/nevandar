// Houdt de app zelf (niet je Dropbox-data) bij voor snel openen. Netwerk eerst, zodat updates meteen doorkomen.
const CACHE = "nevandar-luisteren-v3";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest", "nevandar-192.png", "nevandar-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // Dropbox en lettertypes: nooit via de cache
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
