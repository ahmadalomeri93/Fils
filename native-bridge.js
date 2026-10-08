/* جسر تطبيق الآيفون (Capacitor). يتحمّل من app.js فقط لما يكون Capacitor.isNativePlatform() صحيح؛ في الموقع ما يتحمّل أبداً.
   كل ميزة هنا اختيارية: لو إضافة أصلية ناقصة أو فشلت، التطبيق يكمل مثل الموقع بدون هالميزة.
   ما فيه أي اتصال بالشبكة في هالملف: التذكيرات والنسخة المحفوظة والقفل كلها على الجهاز.
   المنطق الصرف (التواريخ والنصوص والقرارات) مفصول عن الشاشة حتى ينفحص بـ node بإضافات مزيّفة. */

import { LOCK_GRACE_MS, hasMeaningfulData, sanitizeLockRecord, shouldRelock } from "./safety.js";
import { addDaysISO, commitmentOccurrences, debtOccurrences, totalMonthlyIncome } from "./financial-engine.js";
import { countLabel, formatMoney } from "./finance-core.js";

/* نفس مفاتيح app.js (تفحصها tests/native-bridge.test.mjs حتى ما ينفصلون) */
export const STATE_KEY = "fils-state-v1";
export const LOCK_KEY = "fils-lock-v1";

export const MIRROR_FILE = "hawwesh-state.json";
export const LOCK_MIRROR_FILE = "hawwesh-lock.json";
/* LIBRARY يدخل في نسخ آيفون الاحتياطية مثل تخزين الصفحة نفسه؛ LIBRARY_NO_CLOUD يطلعه منها (قرار المؤسس) */
export const MIRROR_DIRECTORY = "LIBRARY";
export const MIRROR_DEBOUNCE_MS = 800;
export const RESTORE_TIMEOUT_MS = 4000;

export const PREF_BIOMETRIC = "hawwesh.biometric";
export const PREF_REMINDERS = "hawwesh.reminders";

export const REMINDER_HOUR = 9;
export const REMINDER_LEAD_DAYS = 3;
export const REMINDER_OCCURRENCES_PER_ITEM = 2;
export const REMINDER_HORIZON_DAYS = 400;
export const REMINDER_DEBOUNCE_MS = 2500;
/* آيفون يحتفظ بأقرب 64 إشعاراً مجدولاً ويرمي الباقي؛ نترك هامشاً صغيراً ونرتّب الأقرب أولاً */
export const MAX_PENDING = 60;

const MONTH_NAMES = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const BACKUP_TITLE = "نسخة حوّش الاحتياطية";
const BIOMETRIC_REASON = "لفتح بياناتك";
const BIOMETRIC_CANCEL = "استخدم الرمز";

export function isNativeApp(capacitor = globalThis.Capacitor) {
  try { return capacitor?.isNativePlatform?.() === true; } catch { return false; }
}

function getPlugin(capacitor, name) {
  try { return capacitor?.Plugins?.[name] ?? null; } catch { return null; }
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
}

/* تشغيل المهام واحدة بعد الثانية (الجدولة والكتابة ما تتداخل) */
function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

function createDebounce(fn, ms, timers) {
  let handle = null;
  const trigger = () => {
    timers.clear(handle);
    handle = timers.set(() => { handle = null; fn(); }, ms);
  };
  trigger.cancel = () => { timers.clear(handle); handle = null; };
  trigger.flush = () => { if (handle !== null) { timers.clear(handle); handle = null; fn(); } };
  return trigger;
}

const defaultTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) };

/* ---------- تفضيلات صغيرة (Preferences = UserDefaults): تبقى حتى لو الصفحة خسرت تخزينها ---------- */
export function createPrefs({ plugin, storage = globalThis.localStorage } = {}) {
  const fallbackKey = "hawwesh-native-prefs-v1";
  const readFallback = () => { try { return JSON.parse(storage?.getItem(fallbackKey) ?? "{}") ?? {}; } catch { return {}; } };
  return {
    async get(key) {
      if (plugin) {
        try { const result = await plugin.get({ key }); return result?.value ?? null; } catch { /* نرجع للاحتياط */ }
      }
      return readFallback()[key] ?? null;
    },
    async set(key, value) {
      if (plugin) {
        try { await plugin.set({ key, value: String(value) }); return true; } catch { /* نرجع للاحتياط */ }
      }
      try { if (!storage) return false; storage.setItem(fallbackKey, JSON.stringify({ ...readFallback(), [key]: String(value) })); return true; } catch { return false; }
    }
  };
}

/* ---------- Face ID / Touch ID: اختصار فوق الرمز، مو بديل عنه ---------- */
const NO_BIOMETRY = Object.freeze({ available: false, biometryType: "none", reason: "" });

export function biometryName(info) {
  return info?.biometryType === "touchID" ? "Touch ID" : "Face ID";
}

export function createBiometricLock({ plugin, prefs, hooks, now = () => Date.now(), graceMs = LOCK_GRACE_MS } = {}) {
  let enabled = false;
  let info = NO_BIOMETRY;
  let inFlight = false;
  let hiddenAt = null;

  const api = {
    get enabled() { return enabled; },
    get info() { return info; },
    get busy() { return inFlight; },
    async init() {
      enabled = (await prefs.get(PREF_BIOMETRIC)) === "1";
      await api.refreshInfo();
    },
    async refreshInfo() {
      if (!plugin) { info = NO_BIOMETRY; return info; }
      try {
        const result = await plugin.isAvailable();
        info = { available: result?.available === true, biometryType: String(result?.biometryType ?? "none"), reason: String(result?.reason ?? "") };
      } catch { info = NO_BIOMETRY; }
      return info;
    },
    /* يشتغل فقط لو فيه رمز قفل: بدون الرمز ما فيه احتياط لو فشلت البصمة */
    usable() { return enabled && info.available && hooks.hasPin(); },
    async authenticate() {
      if (!plugin || inFlight) return false;
      inFlight = true;
      try {
        const result = await plugin.authenticate({ reason: BIOMETRIC_REASON, fallbackTitle: "", cancelTitle: BIOMETRIC_CANCEL });
        // وعد انحلّ لا يكفي: الإضافة الحقيقية ترجّع { success: true } وترفض كل فشل؛ أي شي ثاني (فاضي، false، نص) يعتبر فشلاً
        return result?.success === true;
      } catch { return false; } finally { inFlight = false; }
    },
    async tryUnlock() {
      if (!api.usable() || inFlight || !hooks.isLocked()) return false;
      if (!(await api.authenticate())) return false;
      if (!hooks.isLocked()) return true; // انفتح بالرمز وإحنا ننتظر
      hooks.unlock();
      return true;
    },
    async setEnabled(on) {
      if (!on) { enabled = false; await prefs.set(PREF_BIOMETRIC, "0"); return { ok: true }; }
      if (!hooks.hasPin()) return { ok: false, reason: "no-pin" };
      await api.refreshInfo();
      if (!info.available) return { ok: false, reason: "unavailable", detail: info.reason };
      // نجرّب مرة وحدة الحين: إذن Face ID يطلع هنا (مو عند فتح التطبيق) ونتأكد إنه يشتغل قبل ما نعتمد عليه
      if (!(await api.authenticate())) return { ok: false, reason: "failed" };
      enabled = true;
      await prefs.set(PREF_BIOMETRIC, "1");
      return { ok: true };
    },
    onBackground() { hiddenAt = now(); },
    /* نفس قاعدة القفل الحالية (30 ثانية)، ونتأكد منها هنا لأن visibilitychange مو مضمون في الغلاف */
    async onForeground() {
      const since = hiddenAt;
      hiddenAt = null;
      if (hooks.hasPin() && shouldRelock({ hiddenAtMs: since, nowMs: now(), graceMs })) hooks.lock();
      return api.tryUnlock();
    }
  };
  return api;
}

/* ---------- التذكيرات ---------- */
function localInstant(iso, hour) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

function dateLabel(iso) {
  const [, month, day] = String(iso).split("-").map(Number);
  return `${day} ${MONTH_NAMES[month - 1] ?? ""}`.trim();
}

function shortName(value, fallback) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 40);
}

/* رقم صحيح موجب ثابت من النص (FNV-1a): الإضافة تطلب رقماً صحيحاً لكل إشعار */
export function reminderId(key) {
  let hash = 2166136261;
  for (const character of String(key)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 1) || 1;
}

function paydayDate(todayISOValue, salaryDay, monthOffset) {
  const [year, month] = todayISOValue.split("-").map(Number);
  const last = new Date(year, month - 1 + monthOffset + 1, 0).getDate();
  const first = new Date(year, month - 1 + monthOffset, 1);
  const day = Math.min(Math.max(Number(salaryDay) || 1, 1), last);
  return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/* الخطة: قبل الموعد بـ 3 أيام الساعة 9 وصباح الموعد نفسه الساعة 9 (حسب توقيت الجهاز)، لأقرب موعدين غير مدفوعين
   لكل التزام نشط وقسط قرض، وصباح يوم نزول المعاش. ما نجدول وقتاً فات: الإضافة تسلّم الماضي فوراً. الأقرب أولاً وبحد MAX_PENDING. */
export function planReminders(state, { now = new Date(), hour = REMINDER_HOUR, leadDays = REMINDER_LEAD_DAYS, limit = MAX_PENDING } = {}) {
  if (!state || typeof state !== "object") return [];
  const nowMs = now.getTime();
  const earliest = nowMs + 5_000;
  const today = toLocalISO(now);
  const horizon = addDaysISO(today, REMINDER_HORIZON_DAYS);
  const items = [];

  const addItem = (kind, occurrences, label, amountOf) => {
    const perItem = new Map();
    for (const occurrence of occurrences) {
      const id = kind === "commitment" ? occurrence.commitmentId : occurrence.debtId;
      if (occurrence.paid) continue;
      const taken = perItem.get(id) ?? 0;
      if (taken >= REMINDER_OCCURRENCES_PER_ITEM) continue;
      const name = shortName(occurrence.name, kind === "commitment" ? "التزام" : "قرض");
      const amount = formatMoney(amountOf(occurrence));
      const due = localInstant(occurrence.dueDate, hour);
      const early = new Date(due.getTime());
      early.setDate(early.getDate() - leadDays);
      const base = { kind, itemId: id, dueDate: occurrence.dueDate };
      let added = false;
      if (early.getTime() > earliest) {
        items.push({ ...base, offsetDays: leadDays, at: early, title: `بعد ${countLabel(leadDays, "day")}: ${label}${name}`, body: `${amount} · يستحق ${dateLabel(occurrence.dueDate)}` });
        added = true;
      }
      if (due.getTime() > earliest) {
        items.push({ ...base, offsetDays: 0, at: due, title: `اليوم: ${label}${name}`, body: `${amount} · موعد الدفع اليوم` });
        added = true;
      }
      if (added) perItem.set(id, taken + 1);
    }
  };

  addItem("commitment",
    commitmentOccurrences(state.monthlyCommitments ?? [], { fromISO: today, toISO: horizon, payments: state.commitmentPayments ?? [] }),
    "", (occurrence) => occurrence.amountFils);
  addItem("loan",
    debtOccurrences(state.loans ?? [], { fromISO: today, toISO: horizon, payments: state.debtPayments ?? [] }),
    "قسط ", (occurrence) => occurrence.installmentFils);

  // يوم نزول المعاش (فقط إذا مسجّل دخل): صباح اليوم بدون مبلغ على شاشة القفل
  if (totalMonthlyIncome(state.incomes ?? [], state.settings?.incomeFils ?? 0) > 0) {
    for (const offset of [0, 1]) {
      const dueDate = paydayDate(today, state.settings?.salaryDay, offset);
      const at = localInstant(dueDate, hour);
      if (at.getTime() > earliest) {
        items.push({ kind: "payday", itemId: "payday", dueDate, offsetDays: 0, at, title: "اليوم يوم نزول المعاش", body: "افتح حوّش وسجّل رصيدك الحالي." });
        break;
      }
    }
  }

  items.sort((a, b) => a.at.getTime() - b.at.getTime() || a.title.localeCompare(b.title));
  const used = new Set();
  const plan = [];
  for (const item of items.slice(0, Math.max(0, limit))) {
    let id = reminderId(`${item.kind}:${item.itemId}:${item.dueDate}:${item.offsetDays}`);
    while (used.has(id)) id = (id % 2147483646) + 1;
    used.add(id);
    plan.push({ ...item, id });
  }
  return plan;
}

function toLocalISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createReminderScheduler({ plugin, prefs, getState, now = () => Date.now(), timers = defaultTimers, debounceMs = REMINDER_DEBOUNCE_MS } = {}) {
  const enqueue = createQueue();
  let enabled = false;
  let lastSignature = null;
  let lastCount = 0;
  let permission = "unknown";

  async function readPermission() {
    if (!plugin) { permission = "unavailable"; return permission; }
    try { permission = String((await plugin.checkPermissions())?.display ?? "prompt"); } catch { permission = "unknown"; }
    return permission;
  }

  const soon = createDebounce(() => { api.reschedule().catch(() => {}); }, debounceMs, timers);

  const api = {
    get enabled() { return enabled; },
    get permission() { return permission; },
    get count() { return lastCount; },
    async init() { enabled = (await prefs.get(PREF_REMINDERS)) === "1"; return enabled; },
    refreshPermission: readPermission,
    /* يُستدعى فقط من ضغطة المستخدم على المفتاح: هنا فقط يطلع طلب الإذن */
    async enable() {
      if (!plugin) return { ok: false, reason: "unavailable" };
      let status = await readPermission();
      if (status === "prompt" || status === "prompt-with-rationale") {
        try { status = String((await plugin.requestPermissions())?.display ?? "denied"); } catch { status = "denied"; }
        permission = status;
      }
      if (status !== "granted") return { ok: false, reason: "denied" };
      enabled = true;
      await prefs.set(PREF_REMINDERS, "1");
      const count = await api.reschedule({ force: true });
      return { ok: true, count: count ?? 0 };
    },
    async disable() {
      enabled = false;
      soon.cancel();
      await prefs.set(PREF_REMINDERS, "0");
      await enqueue(async () => {
        lastSignature = null; lastCount = 0;
        if (plugin) { try { await plugin.cancelAll(); } catch { /* ما في شي نلغيه */ } }
      });
      return { ok: true };
    },
    /* نلغي كل المجدول ونجدول من جديد. ما نطلب إذن هنا أبداً: لو الإذن مو ممنوح نتجاهل بصمت */
    reschedule({ force = false } = {}) {
      return enqueue(async () => {
        if (!enabled || !plugin) return null;
        if ((await readPermission()) !== "granted") return null;
        const plan = planReminders(getState(), { now: new Date(now()) });
        const signature = JSON.stringify(plan.map((item) => [item.id, item.at.getTime(), item.title, item.body]));
        if (!force && signature === lastSignature) return plan.length;
        await plugin.cancelAll();
        if (plan.length) {
          await plugin.schedule({ notifications: plan.map((item) => ({ id: item.id, title: item.title, body: item.body, schedule: { at: item.at } })) });
        }
        lastSignature = signature;
        lastCount = plan.length;
        return plan.length;
      });
    },
    /* بعد تغيّر البيانات: ننتظر شوي حتى لا نعيد الجدولة مع كل حرف */
    scheduleSoon() { if (enabled) soon(); }
  };
  return api;
}

/* ---------- مشاركة النسخة الاحتياطية ---------- */
export async function shareBackupFile({ fs, share, data, fileName, title = BACKUP_TITLE } = {}) {
  if (!fs || !share) return { status: "failed", error: new Error("share unavailable") };
  let written = false;
  try {
    const { uri } = await fs.writeFile({ path: fileName, data, directory: "CACHE", encoding: "utf8" });
    written = true;
    await share.share({ title, files: [uri] });
    return { status: "shared" };
  } catch (error) {
    if (/cancel/i.test(String(error?.message ?? error))) return { status: "cancelled" };
    return { status: "failed", error };
  } finally {
    // الملف المؤقت فيه كل بياناتك المالية كنص عادي: نمسحه بعد ما تنتهي المشاركة
    if (written) { try { await fs.deleteFile({ path: fileName, directory: "CACHE" }); } catch { /* ملف الكاش يمسحه النظام */ } }
  }
}

/* ---------- نسخة الحالة على ملف داخل التطبيق ---------- */
function isMissingFile(error) {
  return String(error?.code ?? "") === "OS-PLUG-FILE-0008" || /does not exist|not exist|no such file|not found/i.test(String(error?.message ?? ""));
}

export function createStorageMirror({ fs, storage = globalThis.localStorage, getState, timers = defaultTimers, debounceMs = MIRROR_DEBOUNCE_MS } = {}) {
  const enqueue = createQueue();
  let lastWritten = null;
  let lastLockWritten = null;
  let blocked = false; // ما قدرنا نتأكد إن الملف القديم فاضي: ما نكتب فوقه بحالة فاضية
  let pendingLock;

  async function read(path) {
    try {
      const { data } = await fs.readFile({ path, directory: MIRROR_DIRECTORY, encoding: "utf8" });
      return { status: "ok", text: typeof data === "string" ? data : "" };
    } catch (error) {
      return { status: isMissingFile(error) ? "missing" : "error" };
    }
  }

  function validState(text) {
    try {
      const parsed = JSON.parse(text);
      return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && Number.isInteger(parsed.version) && parsed.version >= 1 && parsed.version <= 4;
    } catch { return false; }
  }

  async function restore() {
    const state = await read(MIRROR_FILE);
    if (state.status === "missing") return "no-mirror";
    if (state.status === "error") { blocked = true; return "unreadable"; }
    if (!validState(state.text)) return "no-mirror"; // ملف تالف: ما ينفع للاسترجاع، والكتابة القادمة تصلحه
    const lock = await read(LOCK_MIRROR_FILE);
    // لو كان في رمز قفل وما قدرنا نقراه ما نرجّع البيانات بدونه
    if (lock.status === "error") { blocked = true; return "unreadable"; }
    let record = null;
    if (lock.status === "ok") { try { record = sanitizeLockRecord(JSON.parse(lock.text)); } catch { record = null; } }
    storage.setItem(STATE_KEY, state.text);
    if (record && storage.getItem(LOCK_KEY) === null) storage.setItem(LOCK_KEY, JSON.stringify(record));
    lastWritten = state.text;
    return "restored";
  }

  async function writeState() {
    const state = getState?.();
    if (!state || !fs) return;
    if (blocked && !hasMeaningfulData(state)) return;
    const text = JSON.stringify(state);
    if (text === lastWritten) return;
    try {
      await fs.writeFile({ path: MIRROR_FILE, directory: MIRROR_DIRECTORY, encoding: "utf8", data: text });
      lastWritten = text;
      blocked = false;
    } catch (error) { console.warn("State mirror write failed", error); }
  }

  async function writeLock() {
    if (!fs || pendingLock === undefined) return;
    const text = JSON.stringify(pendingLock);
    if (text === lastLockWritten) return;
    try {
      await fs.writeFile({ path: LOCK_MIRROR_FILE, directory: MIRROR_DIRECTORY, encoding: "utf8", data: text });
      lastLockWritten = text;
    } catch (error) { console.warn("Lock mirror write failed", error); }
  }

  const stateSoon = createDebounce(() => { enqueue(writeState); }, debounceMs, timers);
  const lockSoon = createDebounce(() => { enqueue(writeLock); }, 300, timers);

  return {
    get blocked() { return blocked; },
    /* عند الفتح: لو التخزين المحلي ما فيه حالة والنسخة موجودة نرجّعها قبل ما التطبيق يقرأ.
       النتيجة: restored | has-data | no-mirror | unreadable | skipped */
    async restoreIfEmpty({ timeoutMs = RESTORE_TIMEOUT_MS } = {}) {
      if (!fs) return "skipped";
      try {
        if (storage.getItem(STATE_KEY) !== null) return "has-data";
      } catch { return "skipped"; }
      const result = await withTimeout(restore().catch(() => { blocked = true; return "unreadable"; }), timeoutMs, "timeout");
      if (result === "timeout") { blocked = true; return "unreadable"; }
      return result;
    },
    stateChanged() { stateSoon(); },
    lockChanged(record) { pendingLock = record ?? null; lockSoon(); },
    flush() { stateSoon.flush(); lockSoon.flush(); return enqueue(async () => {}); },
    writeNow() { return enqueue(writeState); }
  };
}

/* ---------- الشاشة: مفاتيح الإعدادات وزر القفل وروابط الخارج ---------- */
function privacyMarkup(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll(".page-title a, script").forEach((node) => node.remove());
  return parsed.querySelector("main")?.innerHTML ?? "";
}

export function mountNativeUI({ doc = globalThis.document, win = globalThis, hooks, biometric, reminders, openIosSettings } = {}) {
  const $ = (selector) => doc.querySelector(selector);
  const setText = (selector, text) => { const node = $(selector); if (node) node.textContent = text; };
  let privacyDialog = null;

  function renderLock() {
    const button = $("#lock-biometric");
    if (!button) return;
    button.hidden = !biometric.usable();
    button.textContent = `فتح بـ ${biometryName(biometric.info)}`;
  }

  function renderSettings() {
    const info = biometric.info;
    const name = biometryName(info);
    const hasPin = hooks.hasPin();
    const bio = $("#biometric-toggle");
    if (bio) {
      bio.checked = biometric.enabled;
      bio.disabled = !biometric.enabled && (!info.available || !hasPin);
    }
    setText("#biometric-title", info.available ? `فتح التطبيق بـ ${name}` : "فتح التطبيق بالبصمة");
    setText("#biometric-label", info.available ? `استخدم ${name} مع الرمز` : "Face ID أو Touch ID");
    setText("#biometric-hint", !info.available
      ? "جهازك ما عنده Face ID أو Touch ID مفعّل. فعّله من إعدادات الآيفون وارجع هنا."
      : !hasPin
        ? `فعّل القفل بالرمز من قسم «الحماية» أول. بعدها يصير ${name} طريقة أسرع لفتح التطبيق، والرمز يبقى احتياط.`
        : `يطلب ${name} لما تفتح التطبيق أو ترجع له بعد 30 ثانية. إذا ما اشتغل أو ألغيته، تكتب الرمز.`);
    renderReminders();
    renderLock();
  }

  function renderReminders() {
    const toggle = $("#reminders-toggle");
    const denied = reminders.permission === "denied";
    if (toggle) toggle.checked = reminders.enabled;
    const settingsButton = $("#open-ios-settings");
    if (settingsButton) settingsButton.hidden = !denied;
    setText("#reminders-hint", denied
      ? "الإشعارات مقفلة لحوّش في إعدادات الآيفون. فعّلها من هناك وارجع، والتذكيرات ترجع تلقائياً."
      : reminders.enabled
        ? "التذكيرات شغّالة: إشعار قبل الموعد بـ 3 أيام وصباح اليوم نفسه الساعة 9، وصباح يوم نزول المعاش. تنحفظ على جهازك ولا تنرسل لأي جهة. اسم الالتزام والمبلغ يطلعون بالإشعار؛ لو تبي تخفيهم عن شاشة القفل غيّر «إظهار المعاينات» من إعدادات الآيفون."
        : "ذكّرني بمواعيد الأقساط والالتزامات قبلها بـ 3 أيام وصباح يومها، وصباح يوم نزول المعاش. أول ما تشغّلها يطلب الآيفون إذنك للإشعارات.");
  }

  async function onBiometricToggle(event) {
    const toggle = event.target;
    toggle.disabled = true;
    const result = await biometric.setEnabled(toggle.checked);
    if (!result.ok) {
      toggle.checked = false;
      hooks.toast(result.reason === "no-pin" ? "فعّل القفل بالرمز أول" : result.reason === "unavailable" ? "Face ID غير مفعّل على هذا الجهاز" : "ما تأكدنا من البصمة، جرب مرة ثانية");
    } else {
      hooks.toast(biometric.enabled ? `تم تفعيل ${biometryName(biometric.info)}` : "تم إيقاف فتح التطبيق بالبصمة");
    }
    renderSettings();
  }

  async function onRemindersToggle(event) {
    const toggle = event.target;
    toggle.disabled = true;
    try {
      if (toggle.checked) {
        const result = await reminders.enable();
        if (!result.ok) {
          toggle.checked = false;
          hooks.toast(result.reason === "denied" ? "الإشعارات مقفلة لحوّش. فعّلها من إعدادات الآيفون." : "التذكيرات غير متاحة على هذا الجهاز");
        } else {
          hooks.toast(result.count > 0 ? `تم تشغيل التذكيرات (${result.count})` : "تم تشغيل التذكيرات. توصلك لما تضيف التزام أو قسط.");
        }
      } else {
        await reminders.disable();
        hooks.toast("تم إيقاف التذكيرات");
      }
    } finally {
      toggle.disabled = false;
      await reminders.refreshPermission();
      renderSettings();
    }
  }

  function openExternal(url) {
    try { win.open(url, "_blank", "noopener"); } catch { /* ما نقدر نفتح الرابط */ }
  }

  async function openPrivacy() {
    try {
      const response = await win.fetch("privacy.html", { cache: "no-store" });
      if (!response.ok) throw new Error(`privacy.html ${response.status}`);
      const markup = privacyMarkup(await response.text());
      if (!markup) throw new Error("empty privacy page");
      if (!privacyDialog) {
        privacyDialog = doc.createElement("dialog");
        privacyDialog.className = "native-doc-dialog";
        privacyDialog.setAttribute("aria-label", "سياسة الخصوصية");
        privacyDialog.innerHTML = '<div class="dialog-heading"><h2>سياسة الخصوصية</h2><button type="button" class="close-dialog" aria-label="إغلاق">×</button></div><div class="native-doc-body"></div>';
        privacyDialog.querySelector(".close-dialog").addEventListener("click", () => privacyDialog.close());
        doc.body.append(privacyDialog);
      }
      privacyDialog.querySelector(".native-doc-body").innerHTML = markup;
      if (typeof privacyDialog.showModal === "function") privacyDialog.showModal(); else privacyDialog.setAttribute("open", "");
    } catch (error) {
      console.warn("Privacy page unavailable", error);
      hooks.toast("ما قدرت أفتح سياسة الخصوصية");
    }
  }

  /* الروابط الخارجية تفتح في متصفح النظام، وصفحة الخصوصية داخل التطبيق (فتحها بنفس الصفحة كان يعيد تشغيل التطبيق ويقفله) */
  function onLinkClick(event) {
    const link = event.target?.closest?.("a[href]");
    if (!link) return;
    let url;
    try { url = new URL(link.getAttribute("href"), doc.baseURI); } catch { return; }
    // origin تعطي "null" للمخططات غير القياسية مثل capacitor://، فنقارن المخطط والمضيف مباشرة
    const here = new URL(doc.baseURI);
    const sameOrigin = url.protocol === here.protocol && url.host === here.host;
    if (sameOrigin && /\/privacy\.html$/.test(url.pathname)) { event.preventDefault(); openPrivacy(); return; }
    if (!sameOrigin && (url.protocol === "http:" || url.protocol === "https:")) { event.preventDefault(); openExternal(url.href); }
  }

  function setPrivate(on) {
    if (on && !hooks.hasPin()) return;
    doc.body.classList.toggle("is-private", on);
  }

  return {
    renderSettings,
    renderLock,
    setPrivate,
    bind() {
      $("#biometric-toggle")?.addEventListener("change", onBiometricToggle);
      $("#reminders-toggle")?.addEventListener("change", onRemindersToggle);
      $("#open-ios-settings")?.addEventListener("click", () => { openIosSettings?.(); });
      $("#lock-biometric")?.addEventListener("click", () => { biometric.tryUnlock(); });
      doc.addEventListener("click", onLinkClick, true);
    }
  };
}

/* ---------- التجميع ---------- */
export function createNativeBridge(hooks, { capacitor = globalThis.Capacitor, storage = globalThis.localStorage, doc = globalThis.document, win = globalThis, now = () => Date.now(), timers = defaultTimers } = {}) {
  const prefs = createPrefs({ plugin: getPlugin(capacitor, "Preferences"), storage });
  const biometricPlugin = getPlugin(capacitor, "HawweshBiometrics");
  const biometric = createBiometricLock({ plugin: biometricPlugin, prefs, hooks, now });
  const reminders = createReminderScheduler({ plugin: getPlugin(capacitor, "LocalNotifications"), prefs, getState: hooks.getState, now, timers });
  const mirror = createStorageMirror({ fs: getPlugin(capacitor, "Filesystem"), storage, getState: hooks.getState, timers });
  const appPlugin = getPlugin(capacitor, "App");
  const ui = mountNativeUI({
    doc, win, hooks, biometric, reminders,
    openIosSettings: () => { try { biometricPlugin?.openSettings?.(); } catch { /* ما في إعدادات نفتحها */ } }
  });
  let started = false;

  async function onResume() {
    ui.setPrivate(false);
    await biometric.onForeground();
    ui.renderLock();
    if (reminders.enabled) await reminders.reschedule({ force: true }).catch(() => {});
  }

  function onPause() {
    biometric.onBackground();
    mirror.flush().catch(() => {});
  }

  function listen(eventName, handler) {
    try { return appPlugin?.addListener?.(eventName, handler); } catch { return null; }
  }

  return {
    biometric, reminders, mirror, ui,
    restoreIfEmpty: async (options) => (await mirror.restoreIfEmpty(options)) === "restored",
    restoreStatus: (options) => mirror.restoreIfEmpty(options),
    /* بعد ما التطبيق جهّز نفسه: يربط الشاشة، ويراقب الخلفية والرجوع، ويطلب البصمة لو التطبيق مقفول */
    async start() {
      if (started) return;
      started = true;
      await Promise.all([biometric.init(), reminders.init()]);
      ui.bind();
      if (appPlugin) {
        listen("pause", onPause);
        listen("resume", () => { onResume().catch(() => {}); });
        // صورة مبدّل التطبيقات: نضبّب قبل ما يلتقطها النظام (مثل ما يسوي الموقع بالضبط)
        listen("appStateChange", (event) => { if (event?.isActive === false) ui.setPrivate(true); else ui.setPrivate(false); });
      } else {
        doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") onPause(); else onResume().catch(() => {}); });
      }
      await reminders.refreshPermission();
      ui.renderSettings();
      if (hooks.isLocked()) await biometric.tryUnlock();
      if (reminders.enabled) reminders.reschedule({ force: true }).catch(() => {});
      mirror.stateChanged();
    },
    stateSaved() { mirror.stateChanged(); reminders.scheduleSoon(); },
    lockChanged(record) { mirror.lockChanged(record); ui.renderLock(); },
    renderSettings() {
      ui.renderSettings();
      reminders.refreshPermission().then(() => ui.renderSettings()).catch(() => {});
    },
    async shareBackup(data, fileName) {
      const result = await shareBackupFile({ fs: getPlugin(capacitor, "Filesystem"), share: getPlugin(capacitor, "Share"), data, fileName });
      if (result.status === "failed") console.warn("Backup share failed", result.error);
      return result.status;
    }
  };
}
