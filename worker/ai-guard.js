// حارس «المحاسب الذكي»: كائن واحد (Durable Object) يحفظ عدّادات الصرف اليومية والشهرية، حدّ المعدّل لكل جهاز،
// منع الطلب المكرر، وقفل الاقتران. التخزين صغير جداً بمفتاحين فقط: usage وpair.
import { AiError, DUP_TTL_MS, LOCK_FAILS, LOCK_MS, MAX_INFLIGHT, RATE_HOUR, RATE_MINUTE, errorBody, kuwaitDay, kuwaitMonth, round6, secondsToKuwaitMidnight, secondsToKuwaitMonthEnd } from "./ai-core.js";

const KEEP_MS = 60 * 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_DEVICES = 16;
const waitOf = (ms) => Math.max(1, Math.ceil(ms / 1000));

// علامة طلب جاري: {at, did}. القيمة القديمة (رقم فقط) تبقى مقبولة وتُعامل كطلب بدون جهاز معروف
const markOf = (value) => (typeof value === "number" ? { at: value, did: "" } : { at: Number(value?.at) || 0, did: String(value?.did ?? "") });

function lockOf(pair, at) {
  return pair?.lockUntil > at ? { locked: true, retryAfter: waitOf(pair.lockUntil - at) } : { locked: false };
}

export class AiGuardStore {
  constructor(storage, now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
  }

  async #usage() { return (await this.storage.get("usage")) ?? { days: {}, months: {}, rate: {}, busy: {} }; }

  #snapshot(usage, at) {
    const day = usage.days[kuwaitDay(at)] ?? {};
    return { dayUsd: day.usd ?? 0, monthUsd: usage.months[kuwaitMonth(at)]?.usd ?? 0, dayRequests: day.req ?? 0, daySearches: day.searches ?? 0 };
  }

  async status(at = this.now()) { return this.#snapshot(await this.#usage(), at); }
  usage(at) { return this.status(at); }

  // قبل الاتصال بClaude: الميزانية ثم الطلب المكرر (نفس الجسم، أو طلب ثاني جاري من نفس الجهاز، أو وصلنا سقف
  // الطلبات الجارية MAX_INFLIGHT لكل الأجهزة) ثم حد المعدّل؛ لو مرّ نسجّل العلامة والوقت ونرجع اللقطة.
  // الاثنان معاً (طلب واحد لكل جهاز + سقف عام) يحدّان تجاوز الميزانية بطلبات متوازية.
  // الـ409 يحمل retryAfter = ما بقي على انتهاء العلامة المعنية (من 1 إلى 120 ثانية).
  async check(did, hash, caps, at = this.now()) {
    const usage = await this.#usage();
    const snap = this.#snapshot(usage, at);
    if (snap.monthUsd >= caps.monthUsd) throw new AiError(429, "budget_month", "the monthly AI budget is used up", secondsToKuwaitMonthEnd(at));
    if (snap.dayUsd >= caps.dayUsd) throw new AiError(429, "budget_day", "the daily AI budget is used up", secondsToKuwaitMidnight(at));
    for (const [mark, value] of Object.entries(usage.busy)) if (at - markOf(value).at >= DUP_TTL_MS) delete usage.busy[mark];
    const marks = Object.values(usage.busy).map(markOf);
    const freeIn = (list) => Math.min(DUP_TTL_MS / 1000, waitOf(Math.min(...list.map((mark) => mark.at)) + DUP_TTL_MS - at));
    if (usage.busy[hash] !== undefined) throw new AiError(409, "duplicate_in_flight", "the same request is already being answered", freeIn([markOf(usage.busy[hash])]));
    const mine = marks.filter((mark) => mark.did === did);
    if (mine.length) throw new AiError(409, "duplicate_in_flight", "another request from this device is still being answered", freeIn(mine));
    if (marks.length >= MAX_INFLIGHT) throw new AiError(409, "duplicate_in_flight", "the AI service is busy with other requests", freeIn(marks));
    // مفتاح الجهاز بسابقة "d:" حتى لا يصير اسم مثل __proto__ خاصية خاصة بالكائن
    const slot = `d:${did}`;
    const recent = (usage.rate[slot] ?? []).filter((time) => at - time < HOUR_MS).sort((a, b) => a - b);
    const minute = recent.filter((time) => at - time < 60_000);
    if (minute.length >= RATE_MINUTE) throw new AiError(429, "rate_limited", "too many requests, slow down", waitOf(minute[0] + 60_000 - at));
    if (recent.length >= RATE_HOUR) throw new AiError(429, "rate_limited", "too many requests this hour", waitOf(recent[0] + HOUR_MS - at));
    recent.push(at);
    usage.rate[slot] = recent;
    usage.busy[hash] = { at, did };
    // نشيل الأجهزة الخاملة، ونبقي أحدث MAX_DEVICES فقط حتى يبقى التخزين صغيراً
    for (const [other, times] of Object.entries(usage.rate)) if (other !== slot && !times.some((time) => at - time < HOUR_MS)) delete usage.rate[other];
    const devices = Object.entries(usage.rate).sort((a, b) => b[1].at(-1) - a[1].at(-1));
    for (const [other] of devices.slice(MAX_DEVICES)) delete usage.rate[other];
    await this.storage.put("usage", usage);
    return snap;
  }

  // بعد رد ناجح من Claude (ورفضه أيضاً): نضيف الكلفة ونحرر العلامة
  async record(usd, tokens, searches, did, hash, at = this.now()) {
    const usage = await this.#usage();
    const add = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
    const day = (usage.days[kuwaitDay(at)] ??= { usd: 0, req: 0, searches: 0, tokens: 0 });
    day.usd = round6(day.usd + add(usd));
    day.req += 1;
    day.searches += add(searches);
    day.tokens += add(tokens);
    const month = (usage.months[kuwaitMonth(at)] ??= { usd: 0 });
    month.usd = round6(month.usd + add(usd));
    delete usage.busy[hash];
    // عدّادات أقدم من 60 يوم تنمسح عند الكتابة
    const [oldDay, oldMonth] = [kuwaitDay(at - KEEP_MS), kuwaitMonth(at - KEEP_MS)];
    for (const key of Object.keys(usage.days)) if (key < oldDay) delete usage.days[key];
    for (const key of Object.keys(usage.months)) if (key < oldMonth) delete usage.months[key];
    await this.storage.put("usage", usage);
    return this.#snapshot(usage, at);
  }

  // الطلب انتهى بدون تسجيل (خطأ): نحرر العلامة فقط
  async release(hash) {
    const usage = await this.#usage();
    if (usage.busy[hash] !== undefined) { delete usage.busy[hash]; await this.storage.put("usage", usage); }
    return {};
  }

  // بصمة الإعداد (epoch + بصمة مقتطعة من رمز المالك) محفوظة داخل حالة الاقتران؛ لو تغيّرت نمسح القفل والعدّاد.
  // هكذا تدوير رمز المالك أو رفع AI_TOKEN_EPOCH يفك القفل فوراً (مخرج للمالك لو أحد قفله بتخمينات غلط).
  async #pair(fp) {
    const pair = await this.storage.get("pair");
    if (pair && String(pair.fp ?? "") !== fp) { await this.storage.delete("pair"); return {}; }
    return pair ?? {};
  }

  async pairState(at = this.now(), fp = "") { return lockOf(await this.#pair(fp), at); }

  // محاولة فاشلة: 5 خلال 15 دقيقة تقفل 15 دقيقة (عامّ، مو لكل IP)
  async pairFail(at = this.now(), fp = "") {
    let pair = await this.#pair(fp);
    if (pair.lockUntil > at) return lockOf(pair, at);
    if (!pair.first || pair.lockUntil || at - pair.first >= LOCK_MS) pair = { fails: 1, first: at };
    else pair.fails += 1;
    if (pair.fails >= LOCK_FAILS) pair.lockUntil = at + LOCK_MS;
    pair.fp = fp;
    await this.storage.put("pair", pair);
    return lockOf(pair, at);
  }

  async pairOk() { await this.storage.delete("pair"); return {}; }

  // محاولة اقتران ذرّية: لو مقفول لا نكشف صحة الرمز أبداً؛ غير كذا نصفّر عند الصحيح ونعدّ الخطأ
  async pairAttempt(match, at = this.now(), fp = "") {
    const state = await this.pairState(at, fp);
    if (state.locked) return { match: false, ...state };
    if (match) { await this.pairOk(); return { match: true, locked: false }; }
    await this.pairFail(at, fp);
    return { match: false, locked: false };
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const finite = (value) => (Number.isFinite(value) ? value : undefined);

// العمليات تنفّذ بالدور (طابور داخلي) حتى لو تداخلت الطلبات
export class AiGuard {
  constructor(state) {
    this.store = new AiGuardStore(state.storage);
    this.queue = Promise.resolve();
  }

  fetch(request) {
    const run = async () => {
      try {
        const { op, ...a } = await request.json();
        const store = this.store;
        const at = finite(a.at);
        const fp = typeof a.fp === "string" ? a.fp : "";
        const caps = { dayUsd: Number(a.caps?.dayUsd), monthUsd: Number(a.caps?.monthUsd) };
        let result;
        if (op === "status" || op === "usage") result = await store.status(at);
        else if (op === "check") {
          if (typeof a.did !== "string" || typeof a.hash !== "string" || Number.isNaN(caps.dayUsd) || Number.isNaN(caps.monthUsd)) throw new AiError(400, "bad_request");
          result = await store.check(a.did, a.hash, caps, at);
        } else if (op === "record") result = await store.record(a.usd, a.tokens, a.searches, String(a.did), String(a.hash), at);
        else if (op === "release") result = await store.release(String(a.hash));
        else if (op === "pairState") result = await store.pairState(at, fp);
        else if (op === "pairFail") result = await store.pairFail(at, fp);
        else if (op === "pairOk") result = await store.pairOk();
        else if (op === "pairAttempt") result = await store.pairAttempt(a.match === true, at, fp);
        else throw new AiError(404, "not_found");
        return json({ ok: true, ...result });
      } catch (error) {
        return error instanceof AiError ? json(errorBody(error), error.status) : json({ ok: false, error: "server" }, 500);
      }
    };
    const turn = this.queue.then(run, run);
    this.queue = turn;
    return turn;
  }
}
