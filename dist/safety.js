/* حماية البيانات: قفل بالرمز + تذكير النسخ الاحتياطي.
   القفل يمنع فتح الواجهة فقط؛ لا يشفّر البيانات المخزنة في المتصفح. */

import { normalizeDigits, countLabel } from "./finance-core.js";

export const PIN_PATTERN = /^\d{4,8}$/;
/* لوحة المفاتيح العربية ترسل ٠١٢٣: نوحّد الأرقام قبل أي فحص حتى يُقبل الرمز نفسه مكتوباً بأي خط (F36). */
export const normalizePin = (pin) => normalizeDigits(String(pin ?? "")).replace(/[\s‎‏؜]/g, "");
export const LOCK_GRACE_MS = 30_000;
export const BACKUP_INTERVAL_DAYS = 7;
const DEFAULT_ITERATIONS = 150_000;

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin, saltBytes, iterations, cryptoImpl) {
  const key = await cryptoImpl.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await cryptoImpl.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, key, 256));
}

export function cryptoAvailable(cryptoImpl = globalThis.crypto) {
  return Boolean(cryptoImpl?.subtle?.deriveBits && cryptoImpl?.getRandomValues);
}

export async function createLockRecord(pin, { iterations = DEFAULT_ITERATIONS, cryptoImpl = globalThis.crypto } = {}) {
  const digits = normalizePin(pin);
  if (!PIN_PATTERN.test(digits)) throw new Error("PIN must be 4 to 8 digits");
  const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
  const hash = await derive(digits, salt, iterations, cryptoImpl);
  return { v: 1, salt: toB64(salt), hash: toB64(hash), iterations, failures: 0, lockedUntil: 0 };
}

export async function verifyPin(pin, record, { cryptoImpl = globalThis.crypto } = {}) {
  const digits = normalizePin(pin);
  if (!record || !PIN_PATTERN.test(digits)) return false;
  try {
    const expected = fromB64(record.hash);
    const actual = await derive(digits, fromB64(record.salt), record.iterations, cryptoImpl);
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ actual[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/* بعد ٥ محاولات خاطئة: انتظار ٣٠ ثانية ثم يتضاعف حتى ١٥ دقيقة. */
export function lockDelayMs(failures) {
  if (!Number.isInteger(failures) || failures < 5) return 0;
  return Math.min(30 * 2 ** (failures - 5), 900) * 1000;
}

export function registerFailure(record, nowMs) {
  const failures = (record.failures ?? 0) + 1;
  return { ...record, failures, lockedUntil: nowMs + lockDelayMs(failures) };
}

export function registerSuccess(record) {
  return { ...record, failures: 0, lockedUntil: 0 };
}

export function remainingLockMs(record, nowMs) {
  return Math.max((record?.lockedUntil ?? 0) - nowMs, 0);
}

export function shouldRelock({ hiddenAtMs, nowMs, graceMs = LOCK_GRACE_MS } = {}) {
  return Number.isFinite(hiddenAtMs) && Number.isFinite(nowMs) && nowMs - hiddenAtMs >= graceMs;
}

export function sanitizeLockRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { salt, hash, iterations } = raw;
  if (typeof salt !== "string" || typeof hash !== "string" || !Number.isInteger(iterations) || iterations < 1000 || iterations > 5_000_000) return null;
  if (salt.length > 64 || hash.length > 128) return null;
  return {
    v: 1, salt, hash, iterations,
    failures: Number.isInteger(raw.failures) && raw.failures >= 0 && raw.failures < 1000 ? raw.failures : 0,
    lockedUntil: Number.isFinite(raw.lockedUntil) && raw.lockedUntil >= 0 ? raw.lockedUntil : 0
  };
}

/* ---------- النسخ الاحتياطي ---------- */
export function daysSince(iso, nowMs) {
  const time = Date.parse(iso ?? "");
  if (!Number.isFinite(time) || !Number.isFinite(nowMs) || time > nowMs) return null;
  return Math.floor((nowMs - time) / 86_400_000);
}

export function backupStatus({ lastBackupAt = "", baselineAt = "", snoozedUntil = "", hasData = false, nowMs, intervalDays = BACKUP_INTERVAL_DAYS } = {}) {
  if (!hasData || !Number.isFinite(nowMs)) return { due: false, neverBackedUp: !lastBackupAt, days: null };
  const snooze = Date.parse(snoozedUntil ?? "");
  if (Number.isFinite(snooze) && snooze > nowMs) return { due: false, neverBackedUp: !lastBackupAt, days: daysSince(lastBackupAt, nowMs) };
  const reference = lastBackupAt || baselineAt;
  const days = daysSince(reference, nowMs);
  if (days === null) return { due: false, neverBackedUp: !lastBackupAt, days: null };
  return { due: days >= intervalDays, neverBackedUp: !lastBackupAt, days };
}

export function hasMeaningfulData(state) {
  return Boolean(
    state?.transactions?.length || state?.loans?.length || state?.stockHoldings?.length ||
    state?.goals?.length || state?.monthlyCommitments?.length || state?.settings?.incomeFils > 0
  );
}

export function describeBackupAge({ neverBackedUp, days }) {
  if (neverBackedUp) return "ما صدّرت نسخة احتياطية بعد.";
  if (days === 0) return "آخر نسخة احتياطية اليوم.";
  if (days === 1) return "آخر نسخة احتياطية قبل يوم.";
  if (days === 2) return "آخر نسخة احتياطية قبل يومين.";
  return `آخر نسخة احتياطية قبل ${countLabel(days, "day")}.`;
}
