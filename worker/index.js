// صندوق استقبال إشعارات حوّش: Worker + Durable Object على حساب Cloudflare حقك.
// الملفات الثابتة (dist) تُقدَّم قبل هذا الكود؛ هنا فقط مسارات /api/*.
import { HttpError, InboxStore, KEY_PATTERN, MAX_BODY_BYTES, bearerKey } from "./inbox-core.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400"
};
const BASE_HEADERS = {
  ...CORS,
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: BASE_HEADERS });
}

function fail(error) {
  if (error instanceof HttpError) return json({ ok: false, error: error.code }, error.status);
  return json({ ok: false, error: "server" }, 500);
}

// يقرأ الجسم بحد أقصى حتى لو ما جاء Content-Length
async function readCapped(request, max) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > max) throw new HttpError(413, "too_large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new HttpError(413, "too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// الاختصار يرسل Form (multipart) أو JSON أو نصاً خاماً؛ كلها تنتهي بكائن حقول نصية
export async function readFields(request) {
  // الحدود (boundary) حساسة لحالة الأحرف: نصغّر النسخة للفحص فقط ونعطي المحلل الترويسة الأصلية
  const rawType = request.headers.get("content-type") ?? "";
  const type = rawType.toLowerCase();
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (!bytes.length) return {};
  try {
    if (type.includes("application/json")) {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    }
    if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
      const form = await new Response(bytes, { headers: { "content-type": rawType } }).formData();
      const fields = {};
      for (const [name, value] of form.entries()) if (typeof value === "string" && !(name in fields)) fields[name] = value;
      return fields;
    }
  } catch { throw new HttpError(400, "bad_body"); }
  return { body: new TextDecoder().decode(bytes) };
}

function stubFor(env) {
  return env.INBOX.get(env.INBOX.idFromName("main"));
}

// أي عطل بالكائن يرجع JSON بنفس الترويسات (مع CORS) بدل صفحة 500 خام
async function ask(env, op, payload) {
  try {
    return await stubFor(env).fetch("https://inbox.internal/op", { method: "POST", body: JSON.stringify({ op, ...payload }) });
  } catch { return fail(new Error("server")); }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/status") return ask(env, "status", {});
    if (request.method === "GET" && path === "/api/out") return ask(env, "list", { key: requireKey(request) });
    if (request.method === "POST" && path === "/api/claim") return ask(env, "claim", { key: requireKey(request) });
    if (request.method === "POST" && path === "/api/unclaim") return ask(env, "unclaim", { key: requireKey(request) });
    if (request.method === "POST" && path === "/api/ack") {
      const key = requireKey(request);
      const { ids } = await readFields(request).catch(() => ({}));
      return ask(env, "ack", { key, ids: Array.isArray(ids) ? ids : [] });
    }
    const incoming = /^\/api\/in\/([^/]+)$/.exec(path);
    if (request.method === "POST" && incoming) {
      let key = "";
      try { key = decodeURIComponent(incoming[1]); } catch { key = ""; }
      // مفتاح بشكل غلط ما يحتاج نسأل الصندوق أصلاً
      if (!KEY_PATTERN.test(key)) throw new HttpError(404, "not_found");
      return ask(env, "receive", { key, fields: await readFields(request) });
    }
    throw new HttpError(404, "not_found");
  } catch (error) { return fail(error); }
}

function requireKey(request) {
  const key = bearerKey(request.headers.get("authorization"));
  if (!key) throw new HttpError(401, "unauthorized");
  return key;
}

export default { fetch: handleRequest };

// كائن واحد يحفظ كل شي ويرتّب الطلبات بالدور، فما يتكرر عنصر ولا يضيع.
export class Inbox {
  constructor(state) {
    this.store = new InboxStore(state.storage);
  }

  // يحذف المنتهي حتى لو ما جاء أي طلب (وعد «30 يوماً كحد أقصى»)
  async alarm() {
    await this.store.sweep();
  }

  async fetch(request) {
    try {
      const { op, key, fields, ids } = await request.json();
      const store = this.store;
      let result;
      if (op === "status") result = await store.status();
      else if (op === "claim") result = await store.claim(key);
      else if (op === "receive") result = await store.receive(key, fields);
      else if (op === "list") result = await store.list(key);
      else if (op === "ack") result = await store.ack(key, ids);
      else if (op === "unclaim") result = await store.unclaim(key);
      else throw new HttpError(404, "not_found");
      return json(result);
    } catch (error) { return fail(error); }
  }
}
