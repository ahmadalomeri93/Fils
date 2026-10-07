import { countLabel, formatMoney, moneyInput, parseCount, parseMoney } from "./finance-core.js";
import { monthlySurplus } from "./financial-engine.js";

const dinar = (fils) => Math.round(fils / 1000) * 1000;

/* خطة مبدئية بسيطة: ٧٠٪ مصروف، ٢٠٪ ادخار، ١٠٪ هامش أمان. كلها قابلة للتعديل لاحقاً.
   إذا عند المستخدم أقساط والتزامات مسجلة، النسب تنحسب من الباقي بعدها (نفس دالة الفائض الشهري) — F27. */
export function buildStarterPlan({ incomeFils, savingsFils = 0, salaryDay = 25, fixedFils = 0 } = {}) {
  if (!Number.isSafeInteger(incomeFils) || incomeFils <= 0 || !Number.isSafeInteger(savingsFils) || savingsFils < 0 ||
      !Number.isInteger(salaryDay) || salaryDay < 1 || salaryDay > 31) return null;
  const fixed = Number.isSafeInteger(fixedFils) && fixedFils > 0 ? fixedFils : 0;
  const spendableFils = Math.max(monthlySurplus({ incomeFils, commitmentsFils: fixed }).surplusFils, 0);
  const budgetFils = dinar(spendableFils * 0.7);
  const safetyBufferFils = dinar(spendableFils * 0.1);
  const monthlySaveFils = dinar(spendableFils * 0.2);
  const emergencyTargetFils = Math.max(dinar((budgetFils + fixed) * 3), 1000);
  const gapFils = Math.max(emergencyTargetFils - savingsFils, 0);
  const monthsToTarget = gapFils === 0 ? 0 : monthlySaveFils > 0 ? Math.ceil(gapFils / monthlySaveFils) : null;
  const monthsCovered = budgetFils + fixed > 0 ? savingsFils / (budgetFils + fixed) : 0;
  const level = monthsCovered >= 3 ? "strong" : monthsCovered >= 1 ? "ok" : "start";
  return { incomeFils, savingsFils, salaryDay, fixedFils: fixed, spendableFils, budgetFils, safetyBufferFils, monthlySaveFils, emergencyTargetFils,
    dailyFils: Math.floor(budgetFils / 30), gapFils, monthsToTarget, monthsCovered, level };
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (value) => Number(value).toLocaleString("ar-KW-u-nu-latn");

export function mountOnboarding(root, { getSettings, getFixedFils = () => 0, onApply, onSkip }) {
  let step = 0;
  let answers = { income: "", savings: "", salaryDay: "25" };
  let error = "";

  const frame = (title, body, actions) => `
    <div class="dialog-heading"><h2>${title}</h2><button type="button" class="close-dialog" data-ob="skip" aria-label="إغلاق">×</button></div>
    <div class="ob-progress" aria-hidden="true"><span style="width:${Math.round((step / 4) * 100)}%"></span></div>
    ${body}
    <p class="form-error" role="alert">${esc(error)}</p>
    <div class="dialog-actions">${actions}</div>`;

  function render() {
    if (step === 0) {
      root.innerHTML = frame("هلا فيك 👋", `
        <p class="ob-big">أنا أرتّب لك فلوسك بكل بساطة، وما تحتاج تفهم شي معقد.</p>
        <p class="hint">بسألك 3 أسئلة صغيرة بس: كم معاشك، وكم عندك محوّش، ومتى ينزل الراتب. وبعدها أضبط لك كل شي: ميزانيتك، مصروفك اليومي، وهدف صندوق الطوارئ.</p>`,
        `<button type="button" class="secondary" data-ob="skip">لاحقاً</button><button type="button" class="primary" data-ob="next">يلا نبدأ</button>`);
    } else if (step === 1) {
      root.innerHTML = frame("كم معاشك الشهري؟", `
        <p class="ob-big">اكتب المبلغ اللي ينزل لك كل شهر.</p>
        <label class="field"><span>المعاش بالدينار</span><div class="money-field"><input id="ob-income" inputmode="decimal" placeholder="مثال: 1200" value="${esc(answers.income)}" autofocus><b>د.ك</b></div></label>`,
        `<button type="button" class="secondary" data-ob="back">رجوع</button><button type="button" class="primary" data-ob="next">التالي</button>`);
    } else if (step === 2) {
      root.innerHTML = frame("كم عندك محوّش؟", `
        <p class="ob-big">كل الفلوس اللي معك الحين: بالحساب أو كاش.</p>
        <label class="field"><span>المدخرات بالدينار</span><div class="money-field"><input id="ob-savings" inputmode="decimal" placeholder="اكتب 0 إذا ما عندك" value="${esc(answers.savings)}"><b>د.ك</b></div></label>
        <p class="hint">لا تحسب الأسهم هنا، فقط السيولة اللي تقدر تصرفها.</p>`,
        `<button type="button" class="secondary" data-ob="back">رجوع</button><button type="button" class="primary" data-ob="next">التالي</button>`);
    } else if (step === 3) {
      root.innerHTML = frame("متى ينزل راتبك؟", `
        <p class="ob-big">أي يوم من الشهر؟</p>
        <label class="field"><span>يوم نزول الراتب (1 إلى 31)</span><input id="ob-day" type="text" inputmode="numeric" autocomplete="off" value="${esc(answers.salaryDay)}"></label>`,
        `<button type="button" class="secondary" data-ob="back">رجوع</button><button type="button" class="primary" data-ob="next">شوف خطتي</button>`);
    } else {
      const plan = buildStarterPlan({ incomeFils: parseMoney(answers.income), savingsFils: parseMoney(answers.savings) ?? 0, salaryDay: parseCount(answers.salaryDay, { min: 1, max: 31 }) ?? 0, fixedFils: getFixedFils() });
      if (!plan) { step = 1; error = "فيه رقم غير صحيح، راجع إجاباتك."; render(); return; }
      const verdict = plan.fixedFils > 0 && plan.spendableFils === 0 ? "دخلك ما يغطي أقساطك والتزاماتك المسجلة، فأول خطوة نخفف الالتزامات قبل أي ادخار."
        : plan.level === "strong" ? "وضعك ممتاز، عندك احتياطي يغطي 3 شهور أو أكثر 👏"
        : plan.level === "ok" ? "بداية حلوة، عندك احتياطي شهر على الأقل 👍"
        : "ما عليك، نبدأ خطوة خطوة. أهم شي نبني احتياطي 💪";
      root.innerHTML = frame("خطتك جاهزة ✅", `
        <p class="ob-big">${verdict}</p>
        <div class="advisor-budget-list">
          <div><span>تقدر تصرف بالشهر</span><strong>${esc(formatMoney(plan.budgetFils))}</strong></div>
          <div><span>يعني تقريباً باليوم</span><strong>${esc(formatMoney(plan.dailyFils))}</strong></div>
          <div><span>وفّر بالشهر</span><strong>${esc(formatMoney(plan.monthlySaveFils))}</strong></div>
          <div><span>هامش أمان ما تلمسه</span><strong>${esc(formatMoney(plan.safetyBufferFils))}</strong></div>
          <div class="advisor-budget-total"><span>هدف صندوق الطوارئ (3 شهور)</span><strong>${esc(formatMoney(plan.emergencyTargetFils))}</strong></div>
        </div>
        <p class="hint">${plan.monthsToTarget === 0 ? "وصلت هدف الطوارئ أصلاً." : plan.monthsToTarget === null ? "" : `إذا وفّرت المبلغ كل شهر توصل لهدف الطوارئ بعد حوالي ${countLabel(plan.monthsToTarget, "month")}.`}
        ${plan.fixedFils > 0
          ? `حسبتها بعد أقساطك والتزاماتك المسجلة (${esc(formatMoney(plan.fixedFils))} شهرياً): من الباقي ${esc(formatMoney(plan.spendableFils))} 70٪ مصروف، 20٪ ادخار، 10٪ أمان. وهدف الطوارئ يغطي 3 شهور من المصروف والالتزامات.`
          : "هذي أرقام مبدئية (70٪ مصروف، 20٪ ادخار، 10٪ أمان)، وتقدر تعدلها من الإعدادات. القروض والأقساط أضفها من «المزيد» ليصير الحساب أدق."}</p>`,
        `<button type="button" class="secondary" data-ob="back">رجوع</button><button type="button" class="primary" data-ob="apply">طبّق الخطة</button>`);
      root._plan = plan;
    }
  }

  function readStep() {
    error = "";
    if (step === 1) {
      const value = root.querySelector("#ob-income")?.value ?? "";
      const fils = parseMoney(value);
      if (!fils) { error = "اكتب معاشك كرقم، مثل 1200 أو 850.500"; return false; }
      answers.income = value;
    } else if (step === 2) {
      const value = root.querySelector("#ob-savings")?.value ?? "";
      if (parseMoney(value) === null) { error = "اكتب المدخرات كرقم، أو 0 إذا ما عندك."; return false; }
      answers.savings = value;
    } else if (step === 3) {
      // الأرقام العربية (٢٥) تنقبل مثل اللاتينية (F16)
      const day = parseCount(root.querySelector("#ob-day")?.value ?? "", { min: 1, max: 31 });
      if (day === null) { error = "اكتب يوم من 1 إلى 31."; return false; }
      answers.salaryDay = String(day);
    }
    return true;
  }

  root.addEventListener("click", (event) => {
    const action = event.target.dataset?.ob;
    if (!action) return;
    if (action === "skip") { onSkip(); return; }
    if (action === "back") { readStep(); error = ""; step = Math.max(step - 1, 0); render(); }
    if (action === "next") { if (readStep()) step += 1; render(); }
    if (action === "apply" && root._plan) onApply(root._plan);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") { event.preventDefault(); if (readStep()) step += 1; render(); }
  });

  return {
    start() {
      const settings = getSettings();
      step = 0; error = "";
      answers = { income: settings.incomeFils ? moneyInput(settings.incomeFils) : "", savings: settings.cashFils ? moneyInput(settings.cashFils) : "", salaryDay: String(settings.salaryDay || 25) };
      render();
    }
  };
}
