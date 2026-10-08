// يتحقن داخل تطبيق حوّش للآيفون بس (مو بالموقع): يضيف إعدادات Face ID والتذكيرات،
// ويرسل يوم الراتب والأقساط للتطبيق عشان يجدول التذكيرات. ما يرسل أي شي برا الجهاز.
(() => {
  const native = window.webkit?.messageHandlers?.hawwesh;
  const state = window.__hawwesh;
  if (!native || !state) return;

  const STORAGE_KEY = "fils-state-v1";

  function snapshot() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const loans = (data.loans || [])
        .filter((loan) => loan && loan.status !== "completed" && loan.status !== "stopped")
        .map((loan) => ({ id: String(loan.id || ""), name: String(loan.name || "قسط"), dueDay: Number(loan.dueDay) || 0, installmentFils: Number(loan.installmentFils) || 0 }));
      native.postMessage({ type: "snapshot", salaryDay: Number(data.settings?.salaryDay) || 0, loans });
    } catch {}
  }

  let timer;
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    originalSetItem.call(this, key, value);
    if (this === localStorage && key === STORAGE_KEY) { clearTimeout(timer); timer = setTimeout(snapshot, 800); }
  };

  function toggleRow(id, label, hint, on, onChange) {
    const row = document.createElement("div");
    row.className = "row wrap";
    row.style.cssText = "align-items:center;justify-content:space-between;gap:10px;margin-top:8px";
    row.innerHTML = `<span><strong></strong><br><small class="muted"></small></span><button type="button" class="secondary" id="${id}"></button>`;
    row.querySelector("strong").textContent = label;
    row.querySelector("small").textContent = hint;
    const button = row.querySelector("button");
    const paint = (value) => { button.textContent = value ? "مفعّل ✓" : "تفعيل"; button.setAttribute("aria-pressed", String(value)); };
    paint(on);
    button.addEventListener("click", () => onChange(button.getAttribute("aria-pressed") !== "true"));
    return { row, paint };
  }

  function addSettings() {
    const form = document.getElementById("settings-form");
    if (!form || document.getElementById("hawwesh-native")) return;
    const section = document.createElement("section");
    section.className = "data-actions";
    section.id = "hawwesh-native";
    section.innerHTML = "<h3>الآيفون</h3>";
    const face = toggleRow("hawwesh-faceid", `قفل ${state.biometry}`, "يطلب Face ID كل ما تفتح حوّش.", state.faceID, (value) => native.postMessage({ type: "setFaceID", value }));
    const remind = toggleRow("hawwesh-reminders", "تذكيرات الراتب والأقساط", "إشعار الساعة 9 الصبح بيوم الراتب ويوم كل قسط.", state.reminders, (value) => native.postMessage({ type: "setReminders", value }));
    section.append(face.row, remind.row);
    state.update = (faceOn, remindersOn) => { face.paint(faceOn); remind.paint(remindersOn); };
    const actions = form.querySelector(":scope > .dialog-actions");
    form.insertBefore(section, actions || null);
  }

  // زر "تحديث التطبيق" ما له داعي داخل التطبيق: التحديث يجي من App Store
  function hideWebUpdate() {
    document.getElementById("app-update")?.closest("section")?.remove();
  }

  function init() { addSettings(); hideWebUpdate(); snapshot(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
