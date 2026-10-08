// منطق صندوق الاستقبال بدون أي اعتماد على Cloudflare، حتى نفحصه بـ Node مباشرة.
export const KEY_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
export const ID_PATTERN = /^\d{13}-[a-z0-9]{6}$/;
export const MAX_BODY_BYTES = 8192;
export const MAX_FIELD = 1000;
export const MAX_TEXT = 2000;
export const MAX_ITEMS = 500;
export const BATCH = 100;
export const RETENTION_MS = 30 * 86_400_000;
// الاختصار يرسل هالحقول؛ text للرسائل (SMS) ولو جاء النص كاملاً بحقل واحد
export const FIELD_ORDER = ["title", "subtitle", "body", "text"];

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export async function hashKey(key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(key)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// مقارنة بزمن ثابت: ما نكشف كم حرف تطابق
export function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearerKey(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? "").trim());
  return match && KEY_PATTERN.test(match[1]) ? match[1] : "";
}

// يحوّل كائناً (JSON أو حقول نموذج) لنص واحد بنفس ترتيب الأسطر اللي يتوقعه التطبيق: عنوان ثم فرعي ثم نص
export function textFromFields(fields) {
  // أسماء الحقول ما تفرّق بين الصغير والكبير (Title = title)
  const byName = {};
  for (const [name, value] of Object.entries(fields && typeof fields === "object" ? fields : {})) {
    const lower = String(name).trim().toLowerCase();
    if (!(lower in byName)) byName[lower] = value;
  }
  const lines = [];
  for (const name of FIELD_ORDER) {
    const value = byName[name];
    if (typeof value !== "string") continue;
    // إشعار واحد = كتلة وحدة: نشيل الأسطر الفاضية داخل الحقل حتى ما ينقسم لرسالتين عند القراءة
    const clean = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n").trim().slice(0, MAX_FIELD);
    if (clean) lines.push(clean);
  }
  return lines.join("\n").slice(0, MAX_TEXT);
}

export function itemKey(id) { return `i:${id}`; }
export function itemTime(key) { return Number(String(key).slice(2, 15)); }

export function newItemId(now, random = Math.random) {
  const suffix = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
  return `${String(now).padStart(13, "0")}-${suffix}`;
}

// الصندوق كائن واحد: auth (بصمة المفتاح)، meta (عدادات)، وعناصر i:<id>
export class InboxStore {
  constructor(storage, now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
  }

  async #auth() { return (await this.storage.get("auth")) ?? null; }

  async #authorized(key) {
    const auth = await this.#auth();
    if (!auth || !KEY_PATTERN.test(String(key ?? ""))) return false;
    return sameHash(auth.hash, await hashKey(key));
  }

  async status() { return { ok: true, claimed: Boolean(await this.#auth()) }; }

  async claim(key) {
    if (!KEY_PATTERN.test(String(key ?? ""))) throw new HttpError(401, "unauthorized");
    const auth = await this.#auth();
    if (!auth) {
      await this.storage.put("auth", { hash: await hashKey(key), claimedAt: new Date(this.now()).toISOString() });
      await this.storage.put("meta", { lastReceivedAt: "", emptyCount: 0, lastEmptyAt: "" });
      return { ok: true, fresh: true };
    }
    if (!(await this.#authorized(key))) throw new HttpError(409, "taken");
    return { ok: true, fresh: false };
  }

  async receive(key, fields) {
    // مفتاح غلط أو صندوق غير مفعّل: نفس الرد، ما نكشف أيهما
    if (!(await this.#authorized(key))) throw new HttpError(404, "not_found");
    const meta = (await this.storage.get("meta")) ?? { lastReceivedAt: "", emptyCount: 0, lastEmptyAt: "" };
    const text = textFromFields(fields);
    const nowMs = this.now();
    if (!text) {
      await this.storage.put("meta", { ...meta, emptyCount: (meta.emptyCount ?? 0) + 1, lastEmptyAt: new Date(nowMs).toISOString() });
      throw new HttpError(422, "empty");
    }
    await this.#prune(nowMs, 1);
    const id = newItemId(nowMs);
    await this.storage.put(itemKey(id), { id, at: new Date(nowMs).toISOString(), text });
    // وصل إشعار سليم: عدّاد «الفاضي» يرجع صفر حتى ما يبقى التحذير بعد ما يتصلح الاختصار
    await this.storage.put("meta", { ...meta, lastReceivedAt: new Date(nowMs).toISOString(), emptyCount: 0, lastEmptyAt: "" });
    await this.#scheduleSweep(nowMs);
    return { ok: true };
  }

  // منبّه واحد: يصحّي الكائن بعد ما ينتهي أقدم عنصر ليمسحه حتى لو ما وصل أي طلب
  async #scheduleSweep(nowMs) {
    if (typeof this.storage.setAlarm !== "function") return;
    const existing = typeof this.storage.getAlarm === "function" ? await this.storage.getAlarm() : null;
    if (existing && existing > nowMs) return;
    await this.storage.setAlarm(nowMs + RETENTION_MS + 60_000);
  }

  // يُستدعى من alarm(): يمسح المنتهي، وإذا بقي شي يحدد منبّه جديد بعد انتهاء أقدمه
  async sweep() {
    const nowMs = this.now();
    await this.#prune(nowMs, 0);
    const left = await this.storage.list({ prefix: "i:", limit: 1 });
    if (left.size && typeof this.storage.setAlarm === "function") {
      const oldest = itemTime(left.keys().next().value);
      await this.storage.setAlarm(Math.max(nowMs + 60_000, oldest + RETENTION_MS + 60_000));
    }
  }

  // يحذف المنتهي (أقدم من 30 يوم) والزائد عن الحد، ويترك مكاناً لـ room عناصر جديدة
  async #prune(nowMs, room = 0) {
    const all = await this.storage.list({ prefix: "i:", limit: MAX_ITEMS + BATCH });
    const drop = [];
    let kept = 0;
    for (const key of all.keys()) {
      if (nowMs - itemTime(key) > RETENTION_MS) drop.push(key);
      else kept += 1;
    }
    let extra = kept + room - MAX_ITEMS;
    for (const key of all.keys()) {
      if (extra <= 0) break;
      if (!drop.includes(key)) { drop.push(key); extra -= 1; }
    }
    for (let i = 0; i < drop.length; i += 128) await this.storage.delete(drop.slice(i, i + 128));
  }

  async list(key) {
    if (!(await this.#authorized(key))) throw new HttpError(401, "unauthorized");
    await this.#prune(this.now(), 0);
    const all = await this.storage.list({ prefix: "i:", limit: BATCH + 1 });
    const items = [...all.values()].slice(0, BATCH).map(({ id, at, text }) => ({ id, at, text }));
    const meta = (await this.storage.get("meta")) ?? {};
    return { ok: true, items, more: all.size > BATCH, meta: { lastReceivedAt: meta.lastReceivedAt ?? "", emptyCount: meta.emptyCount ?? 0, lastEmptyAt: meta.lastEmptyAt ?? "" } };
  }

  async ack(key, ids) {
    if (!(await this.#authorized(key))) throw new HttpError(401, "unauthorized");
    const valid = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && ID_PATTERN.test(id)))].slice(0, BATCH);
    const removed = valid.length ? await this.storage.delete(valid.map(itemKey)) : 0;
    return { ok: true, removed: Number.isInteger(removed) ? removed : valid.length };
  }

  async unclaim(key) {
    if (!(await this.#authorized(key))) throw new HttpError(401, "unauthorized");
    if (typeof this.storage.deleteAlarm === "function") await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    return { ok: true };
  }
}
