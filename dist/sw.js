const CACHE_NAME = "fils-static-v31";
const OFFLINE_ASSETS = [
  "./", "./index.html", "./styles.css", "./fonts/plex-arabic-400.woff2", "./fonts/plex-arabic-500.woff2", "./fonts/plex-arabic-700.woff2", "./fonts/plex-latin-400.woff2", "./fonts/plex-latin-500.woff2", "./fonts/plex-latin-700.woff2", "./app.js", "./finance-core.js", "./financial-engine.js", "./checkup.js", "./bank-notifications.js", "./onboarding.js", "./safety.js", "./spending.js", "./salary-plan.js", "./loan-ocr.js", "./statement-import.js", "./pdf-statement.js", "./vendor/pdfjs/pdf.mjs", "./vendor/pdfjs/pdf.worker.mjs", "./kuwait-stocks.js", "./gold.js", "./portfolio-import.js",
  "./manifest.webmanifest", "./privacy.html", "./icons/fils-mark.svg", "./icons/icon-192.png",
  "./icons/icon-512.png", "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network first so a new version reaches the phone as soon as it is online; cache keeps it working offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const sameOrigin = new URL(event.request.url).origin === self.location.origin;
  if (!sameOrigin) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
