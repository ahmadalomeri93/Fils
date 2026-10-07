/* زر «تحديث التطبيق» في الإعدادات: المنطق الصرف (بدون شاشة ولا شبكة) حتى ينفحص بـ node.
   رقم النسخة يجي من اسم كاش الـ service worker (fils-static-v34 → 34).
   الشبكة والكاش والتحميل من جديد في app.js؛ هنا القرار فقط. */

export const CACHE_PREFIX = "fils-static";
const CACHE_NAME_PATTERN = /^fils-static-v(\d+)$/;
const WORKER_NAME_PATTERN = /\bconst\s+CACHE_NAME\s*=\s*["'](fils-static-v\d+)["']/;

/* fils-static-v34 → 34، وأي اسم ثاني → null */
export function cacheVersion(name) {
  const match = CACHE_NAME_PATTERN.exec(String(name ?? ""));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

export const versionLabel = (number) => `v${number}`;

/* كاشات فلس بس (تبدأ بـ fils-static): غيرها ما نلمسه أبداً */
export const staticCacheNames = (names) => [...(names ?? [])].filter((name) => String(name).startsWith(CACHE_PREFIX));

/* النسخة المثبتة = أعلى رقم بين كاشات فلس (ما يبقى عادةً إلا كاش واحد بعد تفعيل الـ service worker) */
export function installedVersion(names) {
  const numbers = staticCacheNames(names).map(cacheVersion).filter((number) => number !== null);
  return numbers.length ? Math.max(...numbers) : null;
}

/* نقرأ CACHE_NAME من نص sw.js اللي نزل من الشبكة؛ لو الرد مو sw.js (صفحة بوابة واي فاي مثلاً) نرجع null */
export function remoteVersion(workerSource) {
  const match = WORKER_NAME_PATTERN.exec(String(workerSource ?? ""));
  return match ? cacheVersion(match[1]) : null;
}

/* القرار:
   - unreadable: ما قدرنا نعرف نسخة الموقع → ما نغيّر شي
   - update: نسخة الموقع أحدث، أو النسخة المثبتة غير معروفة، أو الصفحة المفتوحة أقدم من الملفات المثبتة
     (الـ service worker تحدّث بالخلفية والصفحة لسا تشغّل الكود القديم من الذاكرة) → نعيد التحميل
   - current: ما في أحدث من اللي عندك
   loaded = نسخة الكاش لما انفتحت الصفحة (null إذا ما نعرف). */
export function decideUpdate({ installed = null, remote = null, loaded = null } = {}) {
  if (remote === null) return { action: "unreadable" };
  if (installed === null) return { action: "update", reason: "unknown-installed", to: remote };
  if (remote > installed) return { action: "update", reason: "newer", to: remote };
  if (loaded !== null && installed > loaded) return { action: "update", reason: "stale-page", to: installed };
  return { action: "current", version: installed };
}
