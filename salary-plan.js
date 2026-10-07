import { formatMoney } from "./finance-core.js";
import { monthlySurplus } from "./financial-engine.js";

const keyOf = (iso) => String(iso ?? "").slice(0, 7);
const daysIn = (key) => { const [y, m] = key.split("-").map(Number); return new Date(y, m, 0, 12).getDate(); };
const remainingOf = (goal) => Math.max((goal.targetFils ?? 0) - (goal.savedFils ?? 0), 0);
const isEmergency = (goal) => /طوارئ|emergency/i.test(goal.name ?? "");

/* الفائض المتاح للأهداف = نفس دالة الفائض الشهري في كل الصفحات:
   الدخل − الأقساط − الالتزامات − متوسط المعيشة (أو الميزانية إذا ما فيه متوسط). */
export function goalsSurplus({ incomeFils = 0, budgetFils = 0, commitmentsFils = 0, debtPaymentsFils = 0, livingFils = null } = {}) {
  const living = Number.isSafeInteger(livingFils) && livingFils >= 0 ? livingFils : Math.max(budgetFils, 0);
  const result = monthlySurplus({ incomeFils, debtPaymentsFils, commitmentsFils, livingFils: living });
  return {
    outflowFils: result.outflowFils,
    livingFils: living,
    netSurplusFils: result.surplusFils,
    deficitFils: result.deficitFils,
    surplusFils: result.availableForGoalsFils
  };
}

export function planSummary(goals = [], surplusFils = 0, key) {
  const rows = goals.map((goal) => {
    const remainingFils = remainingOf(goal);
    return { id: goal.id, name: goal.name, remainingFils, plannedFils: remainingFils > 0 ? Math.min(goal.monthlyFils ?? 0, remainingFils) : 0, funded: goal.lastFundedMonth === key };
  });
  const plannedTotalFils = rows.reduce((sum, row) => sum + row.plannedFils, 0);
  const planned = rows.filter((row) => row.plannedFils > 0);
  return {
    rows, plannedTotalFils, plannedCount: planned.length,
    shortfallFils: Math.max(plannedTotalFils - surplusFils, 0),
    // قائمة فاضية ما تعني «كل الأهداف مموّلة»
    allFunded: planned.length > 0 && planned.every((row) => row.funded)
  };
}

/* صندوق الطوارئ أولاً (حتى نصف الفائض)، والباقي يتوزع بنسبة المتبقي لكل هدف. يُقرَّب لدينار كامل للأسفل. */
export function suggestAllocation(goals = [], surplusFils = 0) {
  const open = goals.filter((goal) => remainingOf(goal) > 0);
  const result = {};
  let left = surplusFils;
  const emergency = open.filter(isEmergency);
  for (const goal of emergency) {
    const share = Math.min(remainingOf(goal), Math.floor(surplusFils / 2 / emergency.length));
    result[goal.id] = Math.floor(share / 1000) * 1000;
    left -= result[goal.id];
  }
  const others = open.filter((goal) => !isEmergency(goal));
  const totalRemaining = others.reduce((sum, goal) => sum + remainingOf(goal), 0);
  const pool = emergency.length && !others.length ? 0 : left;
  for (const goal of others) {
    const share = totalRemaining ? Math.min(remainingOf(goal), Math.floor(pool * remainingOf(goal) / totalRemaining)) : 0;
    result[goal.id] = Math.floor(share / 1000) * 1000;
  }
  return result;
}

/* المقترح ما يصفّر هدفاً: نرجّع فقط الأهداف اللي لها نصيب فعلي، والباقي يبقى على إدخال المستخدم. */
export function suggestedChanges(goals = [], surplusFils = 0) {
  const allocation = suggestAllocation(goals, surplusFils);
  const applied = {};
  const changes = [];
  for (const goal of goals) {
    const next = allocation[goal.id];
    if (!(next > 0) || next === (goal.monthlyFils ?? 0)) continue;
    applied[goal.id] = next;
    changes.push({ id: goal.id, name: goal.name, fromFils: goal.monthlyFils ?? 0, toFils: next });
  }
  return { allocation: applied, changes };
}

export function fundGoals(goals = [], key) {
  let addedFils = 0, count = 0;
  const next = goals.map((goal) => {
    const amount = Math.min(goal.monthlyFils ?? 0, remainingOf(goal));
    if (goal.lastFundedMonth === key || amount <= 0) return goal;
    addedFils += amount; count += 1;
    return { ...goal, savedFils: goal.savedFils + amount, lastFundedMonth: key };
  });
  return { goals: next, addedFils, count };
}

export function salaryDue({ todayISO, salaryDay, goals = [] } = {}) {
  const key = keyOf(todayISO);
  const effectiveDay = Math.min(salaryDay, daysIn(key));
  if (!(Number(todayISO.slice(8, 10)) >= effectiveDay)) return { due: false, pendingTotalFils: 0, count: 0 };
  const pending = goals.filter((goal) => goal.lastFundedMonth !== key && remainingOf(goal) > 0 && goal.monthlyFils > 0);
  return { due: pending.length > 0, count: pending.length, pendingTotalFils: pending.reduce((sum, goal) => sum + Math.min(goal.monthlyFils, remainingOf(goal)), 0) };
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountSalaryPlan(root, { getModel, onApplySuggestion, onFund }) {
  function render() {
    const model = getModel();
    const key = keyOf(model.todayISO);
    if (!model.goals.length) { root.innerHTML = ""; return; }
    const { surplusFils, outflowFils, netSurplusFils, deficitFils, livingFils } = goalsSurplus(model);
    const summary = planSummary(model.goals, surplusFils, key);
    const suggestion = suggestedChanges(model.goals, surplusFils).allocation;
    const negative = (fils) => fils > 0 ? `‎−${esc(formatMoney(fils))}` : esc(formatMoney(0));
    root.innerHTML = `<section class="panel">
      <div class="section-heading"><div><span class="eyebrow">يوم الراتب</span><h2>خطة الراتب للأهداف</h2></div></div>
      ${model.incomeFils > 0 ? `<div class="advisor-budget-list">
        <div><span>الدخل</span><strong>${esc(formatMoney(model.incomeFils))}</strong></div>
        <div><span>الأقساط</span><strong>${negative(model.debtPaymentsFils)}</strong></div>
        <div><span>الالتزامات الشهرية</span><strong>${negative(model.commitmentsFils)}</strong></div>
        <div><span>المصروف المعيشي</span><strong>${negative(livingFils)}</strong></div>
        <div class="advisor-budget-total"><span>${deficitFils > 0 ? "العجز الشهري" : "المتاح للأهداف شهرياً"}</span><strong class="${deficitFils > 0 ? "amount-negative" : ""}">${esc(formatMoney(netSurplusFils))}</strong></div>
        <div><span>مجموع إضافات الأهداف</span><strong>${esc(formatMoney(summary.plannedTotalFils))}</strong></div>
      </div>
      ${deficitFils > 0
        ? `<p class="hint warn-hint">⚠ مصروفك والتزاماتك أعلى من دخلك بـ ${esc(formatMoney(deficitFils))}، فما نقترح توزيعاً للأهداف قبل تغطية العجز.</p>`
        : summary.shortfallFils > 0 ? `<p class="hint warn-hint">⚠ إضافات أهدافك أكبر من المتاح بـ ${esc(formatMoney(summary.shortfallFils))}. خفّضها أو اطلب مني اقتراح توزيع.</p>` : `<p class="hint">إضافات أهدافك ضمن المتاح.</p>`}`
        : `<p class="hint">سجّل دخلك من الإعدادات ليظهر المتاح للأهداف.</p>`}
      <div class="sp-rows">${summary.rows.filter((row) => row.plannedFils > 0).map((row) => `<div class="sp-row ${row.funded ? "sp-ok" : ""}"><div class="sp-line"><strong>${esc(row.name)}</strong><span class="sp-chip">${row.funded ? "تم هذا الشهر ✓" : esc(formatMoney(row.plannedFils))}</span></div></div>`).join("") || `<p class="hint">حدد إضافة شهرية لهدف حتى تظهر هنا.</p>`}</div>
      <div class="row wrap">
        <button type="button" class="primary" data-fund ${summary.allFunded || !summary.plannedCount ? "disabled" : ""}>${summary.allFunded ? "كل الأهداف مموّلة هذا الشهر" : !summary.plannedCount ? "ما حددت إضافة شهرية لأي هدف" : "حوّلت لأهدافي هذا الشهر"}</button>
        ${model.incomeFils > 0 && surplusFils > 0 && Object.values(suggestion).some((v) => v > 0) ? `<button type="button" class="secondary" data-suggest-goals>اقترح توزيعاً</button>` : ""}
      </div>
      <p class="hint">حوّل المبلغ فعلياً من حسابك لحساب الادخار، وبعدها اضغط الزر ليزيد المدّخر في كل هدف. ما يزيد مرتين بنفس الشهر.</p>
    </section>`;
  }
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-fund]")) onFund();
    if (event.target.closest("[data-suggest-goals]")) {
      const model = getModel();
      onApplySuggestion(suggestedChanges(model.goals, goalsSurplus(model).surplusFils));
    }
  });
  return { render };
}
