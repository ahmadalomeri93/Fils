const CACHE_NAME = "fils-static-v45";
// شبكة أولاً بمهلة قصيرة: على شبكة ضعيفة ما نخلي الصفحة تنتظر، نرجع النسخة المخزنة (F35).
const NETWORK_TIMEOUT_MS = 2500;
const OFFLINE_ASSETS = [
  "./", "./index.html", "./styles.css", "./fonts/plex-arabic-400.woff2", "./fonts/plex-arabic-500.woff2", "./fonts/plex-arabic-700.woff2", "./fonts/plex-latin-400.woff2", "./fonts/plex-latin-500.woff2", "./fonts/plex-latin-700.woff2", "./app.js", "./app-update.js", "./native-bridge.js", "./finance-core.js", "./financial-engine.js", "./checkup.js", "./bank-notifications.js", "./inbox.js", "./onboarding.js", "./safety.js", "./spending.js", "./salary-plan.js", "./loan-ocr.js", "./statement-import.js", "./pdf-statement.js", "./vendor/pdfjs/pdf.mjs", "./vendor/pdfjs/pdf.worker.mjs", "./kuwait-stocks.js", "./gold.js", "./portfolio-import.js", "./ai-assistant.js", "./ai-client.js", "./ai-tools.js", "./ai-tool-schemas.js",
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
function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    fetch(request).then((response) => {
      clearTimeout(timer);
      // رد غير ناجح (٥٠٠ أو صفحة بديلة من الشبكة) ما يستحق أن يحجب النسخة المخزنة
      if (!response.ok) reject(new Error("http " + response.status));
      else resolve(response);
    }, (error) => { clearTimeout(timer); reject(error); });
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // صندوق الاستقبال: ما يمر على الكاش أبداً (نص إشعارات وردود مصادقة)
  if (url.pathname.startsWith("/api/")) return;
  // sw.js نفسه ما يمر على الكاش: زر «تحديث التطبيق» يجلبه من الشبكة ليعرف إذا فيه إنترنت وإذا فيه نسخة أحدث
  if (url.pathname.endsWith("/sw.js")) return;
  event.respondWith(
    fromNetwork(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(event.request).then((cached) => {
      if (cached) return cached;
      if (event.request.mode === "navigate") return caches.match("./index.html").then((page) => page || Response.error());
      // ما عندنا نسخة: نكمل على الشبكة بلا مهلة حتى يصل الخطأ الحقيقي للصفحة
      return fetch(event.request).catch(() => Response.error());
    }))
  );
});
