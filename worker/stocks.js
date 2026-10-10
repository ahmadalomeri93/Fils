// أسعار بورصة الكويت لصفحة الأسهم: GET /api/stocks/quotes?codes=NBK,KFH
// المصدر: Yahoo Finance (رموز ‎.KW، السعر بالفلس). بيانات عامة، ما يرسل التطبيق أي شي عن المستخدم غير رموز الأسهم.
// مصدر غير رسمي وقد يتأخر حتى 15 دقيقة؛ نخزّن كل سعر 5 دقايق حتى ما نضغط عليه.

const CODE = /^[A-Z0-9&.-]{1,12}$/;
const MAX_CODES = 40;
const CACHE_SECONDS = 300;
const TIMEOUT_MS = 8000;

const HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export function parseCodes(raw) {
  const codes = [...new Set(String(raw ?? "").toUpperCase().split(",").map((code) => code.trim()).filter(Boolean))];
  if (!codes.length || codes.length > MAX_CODES || !codes.every((code) => CODE.test(code))) return null;
  return codes;
}

// نتيجة Yahoo chart → { priceFils, previousCloseFils, at } أو null
export function parseYahoo(data) {
  const meta = data?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!meta || !Number.isFinite(price) || price <= 0) return null;
  // Yahoo يعطي أسعار الكويت بالفلس (KWF). لو جات بالدينار (KWD) نحوّلها؛ أي عملة ثانية نرفضها بدل ما نخمّن
  if (meta.currency != null && meta.currency !== "KWF" && meta.currency !== "KWD") return null;
  const factor = meta.currency === "KWD" ? 1000 : 1;
  const previous = Number(meta.chartPreviousClose ?? meta.previousClose);
  const at = Number(meta.regularMarketTime);
  // سقف التطبيق: 10,000 د.ك للسهم (فوقه يُحذف السهم عند التحميل)
  if (price * factor > 10_000_000) return null;
  return {
    priceFils: Math.round(price * factor * 10) / 10,
    previousCloseFils: Number.isFinite(previous) && previous > 0 ? Math.round(previous * factor * 10) / 10 : null,
    at: Number.isFinite(at) ? new Date(at * 1000).toISOString() : null
  };
}

async function quote(code, { fetchImpl, cache }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}.KW?range=1d&interval=1d`;
  const key = new Request(`https://stocks.cache/${code}`);
  const hit = await cache?.match(key).catch(() => null);
  if (hit) return hit.json();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0 (Hawwesh price check)", accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return null;
    const parsed = parseYahoo(await response.json());
    if (parsed && cache) await cache.put(key, new Response(JSON.stringify(parsed), { headers: { "cache-control": `max-age=${CACHE_SECONDS}` } })).catch(() => {});
    return parsed;
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}

export async function handleStockQuotes(request, deps = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (request.method !== "GET") return reply({ ok: false, error: "method_not_allowed" }, 405);
  const codes = parseCodes(new URL(request.url).searchParams.get("codes"));
  if (!codes) return reply({ ok: false, error: "bad_codes" }, 400);
  const fetchImpl = deps.fetch ?? fetch;
  const cache = deps.cache === undefined ? globalThis.caches?.default : deps.cache;
  const results = await Promise.all(codes.map((code) => quote(code, { fetchImpl, cache }).then((value) => [code, value])));
  const quotes = Object.fromEntries(results.filter(([, value]) => value));
  return reply({ ok: true, source: "Yahoo Finance", fetchedAt: new Date().toISOString(), quotes, missing: results.filter(([, value]) => !value).map(([code]) => code) });
}
