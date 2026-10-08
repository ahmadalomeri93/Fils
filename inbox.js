// الاستقبال التلقائي: الآيفون يرسل نص الإشعار لصندوق خاص (Worker على موقعك)، وحوّش يجلبه ويؤكد استلامه.
// المفتاح السري يتولد هنا على الجهاز ويُحفظ بمفتاح تخزين مستقل (مو داخل النسخة الاحتياطية).
export const INBOX_BASE = "https://broken-queen-f0ed.ahmadalomeri.workers.dev";
export const INBOX_STORE_KEY = "fils-inbox-v1";
export const INBOX_KEY_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const TIMEOUT_MS = 8000;

export function newInboxKey(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function inboxLink(key, base = INBOX_BASE) { return `${base}/api/in/${key}`; }

// يقبل الرابط كاملاً أو المفتاح وحده (لو لصقه المستخدم من الاختصار)
export function parseInboxKey(input) {
  const text = String(input ?? "").trim();
  const fromLink = /\/api\/in\/([A-Za-z0-9_-]{32,64})(?:[/?#\s]|$)/.exec(text);
  if (fromLink) return fromLink[1];
  return INBOX_KEY_PATTERN.test(text) ? text : "";
}

export function readInboxConfig(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(INBOX_STORE_KEY) ?? "null");
    if (!raw || typeof raw.key !== "string" || !INBOX_KEY_PATTERN.test(raw.key)) return null;
    return {
      key: raw.key,
      enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : "",
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : "",
      lastCount: Number.isInteger(raw.lastCount) ? raw.lastCount : 0,
      // مفتاح انحفظ قبل ما نتأكد أن الخادم حجز الصندوق به: نعيد المحاولة بنفس المفتاح بدل ما ينقفل علينا
      pending: raw.pending === true
    };
  } catch { return null; }
}

export function writeInboxConfig(config, storage = globalThis.localStorage) {
  try {
    if (config) storage.setItem(INBOX_STORE_KEY, JSON.stringify(config));
    else storage.removeItem(INBOX_STORE_KEY);
    return true;
  } catch { return false; }
}

function pad(value) { return String(value).padStart(2, "0"); }

// سطر التاريخ بتوقيت الجهاز: السنة-الشهر-اليوم ساعة:دقيقة:ثانية (يقرأه حوّش مثل أي طابع)
export function stampFor(iso, tzOffsetMinutes = -new Date(iso).getTimezoneOffset()) {
  const moved = new Date(new Date(iso).getTime() + tzOffsetMinutes * 60_000);
  if (Number.isNaN(moved.getTime())) return "";
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())} ${pad(moved.getUTCHours())}:${pad(moved.getUTCMinutes())}:${pad(moved.getUTCSeconds())}`;
}

// نفس شكل ملف الاختصار القديم: سطر تاريخ ثم نص الإشعار، وسطر فاضي بين إشعار وإشعار
export function itemsToBankText(items, tzOffsetMinutes) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .map((item) => {
      const stamp = stampFor(item.at, tzOffsetMinutes);
      return stamp ? `${stamp}\n${item.text.trim()}` : item.text.trim();
    })
    .join("\n\n");
}

// يرجع دائماً { ok, status, data, error }: error = network | service | unauthorized | taken | not_found | ...
export async function inboxRequest(path, { method = "GET", key = "", body = null, fetchImpl = globalThis.fetch, base = INBOX_BASE, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const headers = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (body) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller?.signal, cache: "no-store", credentials: "omit" });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!data || typeof data !== "object") return { ok: false, status: response.status, data: null, error: "service" };
    if (response.ok && data.ok) return { ok: true, status: response.status, data, error: "" };
    return { ok: false, status: response.status, data, error: typeof data.error === "string" ? data.error : "service" };
  } catch { return { ok: false, status: 0, data: null, error: "network" }; }
  finally { if (timer) clearTimeout(timer); }
}

export const inboxStatus = (options) => inboxRequest("/api/status", options);
export const claimInbox = (key, options) => inboxRequest("/api/claim", { ...options, method: "POST", key });
export const fetchInbox = (key, options) => inboxRequest("/api/out", { ...options, key });
export const ackInbox = (key, ids, options) => inboxRequest("/api/ack", { ...options, method: "POST", key, body: { ids } });
export const unclaimInbox = (key, options) => inboxRequest("/api/unclaim", { ...options, method: "POST", key });

export function inboxErrorMessage(error) {
  switch (error) {
    case "network": return "ما قدرت أتصل بالخدمة. تأكد من الإنترنت وجرّب مرة ثانية.";
    case "service": case "not_found": case "server": return "الخدمة غير جاهزة على موقعك للحين. جرّب بعد دقيقتين.";
    case "taken": return "الصندوق محجوز بمفتاح ثاني. لو هذا جهازك، انسخ رابط الاختصار وألصقه تحت في «عندك رابط من قبل؟».";
    case "unauthorized": return "الصندوق ما يعرف هالمفتاح. أوقف الاستقبال وفعّله من جديد.";
    default: return "صار خطأ بالخدمة. جرّب مرة ثانية.";
  }
}

// «قبل دقيقة»، «قبل 3 دقائق»، «قبل 12 دقيقة»…
function unitLabel(count, one, two, few, many) {
  if (count === 1) return `قبل ${one}`;
  if (count === 2) return `قبل ${two}`;
  return `قبل ${count} ${count <= 10 ? few : many}`;
}

export function agoLabel(iso, nowMs = Date.now()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((nowMs - time) / 60_000));
  if (minutes < 1) return "قبل لحظات";
  if (minutes < 60) return unitLabel(minutes, "دقيقة", "دقيقتين", "دقائق", "دقيقة");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return unitLabel(hours, "ساعة", "ساعتين", "ساعات", "ساعة");
  return unitLabel(Math.round(hours / 24), "يوم", "يومين", "أيام", "يوماً");
}
