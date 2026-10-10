/* حماية البيانات: قفل Face ID / Touch ID (تطبيق الآيفون فقط) + تذكير النسخ الاحتياطي.
   ما فيه رمز داخل التطبيق: القفل يعتمد على بصمة الوجه/الإصبع من الآيفون نفسه.
   القفل يمنع فتح الواجهة فقط؛ لا يشفّر البيانات المخزنة على الجهاز. */

import { countLabel } from "./finance-core.js";

export const LOCK_GRACE_MS = 30_000;
export const BACKUP_INTERVAL_DAYS = 7;

/* سجل القفل الجديد: { v: 2, method: "faceid" }. */
export const FACE_LOCK_RECORD = Object.freeze({ v: 2, method: "faceid" });

export function shouldRelock({ hiddenAtMs, nowMs, graceMs = LOCK_GRACE_MS } = {}) {
  return Number.isFinite(hiddenAtMs) && Number.isFinite(nowMs) && nowMs - hiddenAtMs >= graceMs;
}

/* يقبل السجل الجديد، ويحوّل سجل الرمز القديم (v1: salt + hash) إلى قفل Face ID:
   اللي كان مفعّل القفل يبقى محمي، بس الفتح صار بالبصمة بدل الرمز. أي شي ثاني = ما فيه قفل. */
export function sanitizeLockRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.v === 2 && raw.method === "faceid") return { ...FACE_LOCK_RECORD };
  const { salt, hash, iterations } = raw;
  if (typeof salt === "string" && typeof hash === "string" && Number.isInteger(iterations) && salt.length <= 64 && hash.length <= 128) return { ...FACE_LOCK_RECORD };
  return null;
}

export const isLegacyPinRecord = (raw) => Boolean(raw && typeof raw === "object" && raw.v !== 2 && typeof raw.hash === "string");

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
