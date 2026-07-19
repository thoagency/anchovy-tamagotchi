// Minimal offline-cache service worker. Only takes effect once the app is
// served over http(s) — browsers refuse to register service workers for
// file:// pages, so this is inert during local testing and "wakes up" the
// moment this gets hosted somewhere.
const CACHE_NAME = "anchovy-v22";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./brain.js",
  "./llm.js",
  "./sync.js",
  "./app.js",
  "./anchy.webp",
  "./anchy-web-bg.png",
  "./anchy-head.png",
  "./settings_icon.png",
  "./best_friends_icon.png",
  "./shopping_icon.png",
  "./music_icon.png",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
