// عميل «المحاسب الذكي»: التخزين المحلي (مفتاح مستقل خارج بيانات التطبيق)، الربط بالجهاز، وطلبات الـWorker.
// المفتاح السري لClaude ما يوصل هنا أبداً: الجهاز يحمل رمز ربط موقّع فقط، والـWorker وحده يكلّم Anthropic.
// لا يُعاد استخدام مفتاح الاستقبال ولا رابطه السري. الرمز يُخزَّن هنا ويُمسح مع «نسيت الرمز» والمسح الكامل.
export const AI_BASE = "https://broken-queen-f0ed.ahmadalomeri.workers.dev";
export const AI_STORE_KEY = "fils-ai-v1";
export const AI_CONSENT_VERSION = 1;
export const JOURNAL_MAX = 20;
export const MAX_REQUEST_BYTES = 600_000; // الـWorker يرفض فوق 700000 بايت
export const MAX_HISTORY_MESSAGES = 76; // الـWorker يرفض فوق 80 رسالة
const TIMEOUT_MS = { status: 10_000, pair: 15_000, usage: 10_000, chat: 95_000 }; // الـWorker يقطع Anthropic عند 85 ثانية

/* ---------- التخزين ---------- */
const OP_KINDS = new Set(["tx_add", "tx_update", "ob_add", "pay_add", "pay_remove", "budget"]);

export function emptyStore() {
  return { v: 1, device: "", token: "", expiresAt: "", consentVersion: 0, consentAt: "", journal: [] };
}

function sanitizeJournal(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => entry && typeof entry.id === "string" && entry.op && OP_KINDS.has(entry.op.kind))
    .slice(0, JOURNAL_MAX).map((entry) => ({
      id: entry.id.slice(0, 80), proposalId: String(entry.proposalId ?? "").slice(0, 80), tool: String(entry.tool ?? "").slice(0, 60),
      title: String(entry.title ?? "").slice(0, 80), at: String(entry.at ?? "").slice(0, 40), undone: String(entry.undone ?? "").slice(0, 40),
      summary: Array.isArray(entry.summary) ? entry.summary.slice(0, 6).map((item) => String(item).slice(0, 160)) : [], op: entry.op
    }));
}

export function readAiStore(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(AI_STORE_KEY) ?? "null");
    if (!raw || raw.v !== 1) return emptyStore();
    return {
      v: 1,
      device: /^[A-Za-z0-9_-]{8,64}$/.test(raw.device ?? "") ? raw.device : "",
      token: typeof raw.token === "string" && raw.token.length <= 2000 ? raw.token : "",
      expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt.slice(0, 40) : "",
      consentVersion: Number.isInteger(raw.consentVersion) ? raw.consentVersion : 0,
      consentAt: typeof raw.consentAt === "string" ? raw.consentAt.slice(0, 40) : "",
      journal: sanitizeJournal(raw.journal)
    };
  } catch { return emptyStore(); }
}

export function writeAiStore(store, storage = globalThis.localStorage) {
  try { storage.setItem(AI_STORE_KEY, JSON.stringify({ ...store, journal: sanitizeJournal(store.journal) })); return true; } catch { return false; }
}

export function clearAiStore(storage = globalThis.localStorage) {
  try { storage.removeItem(AI_STORE_KEY); } catch { /* التخزين غير متاح */ }
}

export function newDeviceId(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(24);
  cryptoImpl.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function tokenUsable(store, nowMs = Date.now()) {
  if (!store.token) return false;
  const expires = Date.parse(store.expiresAt);
  return Number.isFinite(expires) && expires - 60_000 > nowMs;
}

/* ---------- رسائل الخطأ للمستخدم ---------- */
const afterUnits = (n, one, two, few, many) => (n === 1 ? `بعد ${one}` : n === 2 ? `بعد ${two}` : `بعد ${n} ${n <= 10 ? few : many}`);

export function aiErrorMessage(result) {
  const wait = Number.isFinite(result?.retryAfter) && result.retryAfter > 0 ? Math.ceil(result.retryAfter) : 0;
  const waitText = wait >= 3600 ? `${afterUnits(Math.ceil(wait / 3600), "ساعة", "ساعتين", "ساعات", "ساعة")} تقريباً`
    : wait >= 120 ? `${afterUnits(Math.ceil(wait / 60), "دقيقة", "دقيقتين", "دقائق", "دقيقة")} تقريباً`
    : wait > 0 ? `بعد ${wait} ثانية` : "بعد شوي";
  switch (result?.error) {
    case "network": return "ما قدرت أوصل للخدمة. تأكد من الاتصال وجرب من جديد.";
    case "timeout": return "الخدمة تأخرت بالرد. جرب من جديد.";
    case "aborted": return "تم إيقاف الطلب.";
    case "unauthorized": return "انتهت صلاحية ربط هذا الجهاز. اربطه من جديد.";
    case "origin": return "هذا الموقع غير مسموح له باستخدام الخدمة.";
    case "too_large": return "المحادثة صارت كبيرة. ابدأ محادثة جديدة.";
    case "duplicate_in_flight": return wait > 0 ? `الطلب السابق لسا يشتغل. جرب ${waitText}.` : "الطلب السابق لسا يشتغل. انتظر شوي.";
    case "rate_limited": return `طلبات كثيرة بوقت قصير. جرب ${waitText}.`;
    case "budget_day": return wait > 0 ? `وصلت حد التكلفة اليومي للمحاسب. يتجدد ${waitText} (منتصف الليل بتوقيت الكويت).` : "وصلت حد التكلفة اليومي للمحاسب. يتجدد منتصف الليل بتوقيت الكويت.";
    case "budget_month": return "وصلت حد التكلفة الشهري للمحاسب. يتجدد أول الشهر.";
    case "not_configured": case "upstream_not_configured": return "الخدمة غير مفعّلة بعد. تحتاج إعداد مفتاح الخدمة.";
    case "upstream_overloaded": return "الخدمة مشغولة الحين. جرب بعد شوي.";
    case "upstream_timeout": return "الخدمة تأخرت بالرد. جرب من جديد.";
    case "upstream_error": return "صار خلل مؤقت بالخدمة. جرب من جديد.";
    case "bad_request": return "الطلب غير صالح. ابدأ محادثة جديدة وجرب.";
    case "empty_reply": return "المحاسب ما رجّع رد. جرب من جديد.";
    case "bad_code": return "الرمز غير صحيح.";
    case "locked": return `محاولات كثيرة غلط. جرب ${waitText}.`;
    default: return "صار خلل غير متوقع. جرب من جديد.";
  }
}

/* ---------- ضغط السجل: نحذف أقدم الأدوار الكاملة (مع ردود أدواتها) حتى يصغر الحجم ---------- */
function isTurnStart(message) {
  return message?.role === "user" && Array.isArray(message.content) && message.content.some((block) => block?.type === "text") && !message.content.some((block) => block?.type === "tool_result");
}

const encoder = new TextEncoder();
const byteLength = (messages) => encoder.encode(JSON.stringify({ messages })).length; // الـWorker يعدّ بايتات UTF-8 (العربي بايتان وأكثر)

export function compactMessages(messages, maxBytes = MAX_REQUEST_BYTES, maxMessages = MAX_HISTORY_MESSAGES) {
  let list = messages;
  let dropped = 0;
  while (list.length > maxMessages || byteLength(list) > maxBytes) {
    const next = list.findIndex((message, index) => index > 0 && isTurnStart(message));
    if (next < 0) return { messages: list, dropped, fits: false };
    dropped += next;
    list = list.slice(next);
  }
  return { messages: list, dropped, fits: true };
}

/* ---------- العميل ---------- */
export function createAiClient({ base = AI_BASE, fetchImpl = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage, now = () => Date.now(), cryptoImpl = globalThis.crypto } = {}) {
  async function request(path, { method = "GET", body, token = "", signal, timeoutMs }) {
    if (!fetchImpl) return { ok: false, error: "network" };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (response.ok && data && data.ok !== false) return { ok: true, status: response.status, ...data };
      const retryAfter = Number(data?.retryAfter);
      return { ok: false, status: response.status, error: typeof data?.error === "string" ? data.error.slice(0, 40) : "upstream_error", retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined };
    } catch {
      if (signal?.aborted) return { ok: false, error: "aborted" };
      return { ok: false, error: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  const client = {
    store: () => readAiStore(storage),
    save: (store) => writeAiStore(store, storage),
    status: () => request("/api/ai/status", { timeoutMs: TIMEOUT_MS.status }),

    async pair(code) {
      const store = readAiStore(storage);
      const device = store.device || newDeviceId(cryptoImpl);
      const text = String(code ?? "").trim();
      if (!text) return { ok: false, error: "bad_code" };
      const result = await request("/api/ai/pair", { method: "POST", body: { code: text, device }, timeoutMs: TIMEOUT_MS.pair });
      if (!result.ok) return result;
      if (typeof result.token !== "string" || !result.token) return { ok: false, error: "upstream_error" };
      writeAiStore({ ...store, device, token: result.token, expiresAt: String(result.expiresAt ?? "") }, storage);
      return { ok: true, limits: result.limits ?? null };
    },

    unpair() {
      const store = readAiStore(storage);
      writeAiStore({ ...store, token: "", expiresAt: "", consentVersion: 0, consentAt: "" }, storage);
    },

    usage(signal) {
      const store = readAiStore(storage);
      return request("/api/ai/usage", { token: store.token, signal, timeoutMs: TIMEOUT_MS.usage });
    },

    /* ما نعيد المحاولة تلقائياً: إعادة طلب منتهي بمهلة ممكن تُكلّف مرتين. المستخدم يقرر بزر «إعادة المحاولة». */
    async chat(messages, { signal } = {}) {
      const store = readAiStore(storage);
      if (!tokenUsable(store, now())) return { ok: false, error: "unauthorized" };
      const result = await request("/api/ai/chat", { method: "POST", body: { messages }, token: store.token, signal, timeoutMs: TIMEOUT_MS.chat });
      if (!result.ok && result.error === "unauthorized") writeAiStore({ ...readAiStore(storage), token: "", expiresAt: "" }, storage);
      return result;
    }
  };
  return client;
}
