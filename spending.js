import { categories, countLabel, formatMoney, moneyInput, parseMoney } from "./finance-core.js";

export const EXPENSE_CATEGORIES = categories.filter((category) => category !== "راتب");
export const MATERIAL_THRESHOLD = 0.1;

/* ---------- تواريخ ---------- */
export const monthKeyOf = (iso) => String(iso ?? "").slice(0, 7);
export function shiftMonth(key, delta) {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
export function daysInMonth(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month, 0, 12).getDate();
}
export function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-KW-u-nu-latn", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1, 12));
}

/* ---------- المصروف حسب الفئة ---------- */
const isRefund = (item) => item.kind === "income" && /^استرداد/.test(item.merchant ?? "");

export function spendByCategory(transactions = [], key, { uptoDay = 31 } = {}) {
  const map = new Map();
  for (const item of transactions) {
    if (!item?.reviewed || !String(item.date ?? "").startsWith(key)) continue;
    if (Number(item.date.slice(8, 10)) > uptoDay) continue;
    const refund = isRefund(item);
    if (item.kind !== "expense" && !refund) continue;
    const category = EXPENSE_CATEGORIES.includes(item.category) ? item.category : "أخرى";
    const row = map.get(category) ?? { category, totalFils: 0, count: 0, merchants: new Map() };
    const sign = refund ? -1 : 1;
    row.totalFils += sign * item.amountFils;
    if (!refund) row.count += 1;
    row.merchants.set(item.merchant, (row.merchants.get(item.merchant) ?? 0) + sign * item.amountFils);
    map.set(category, row);
  }
  for (const row of map.values()) row.totalFils = Math.max(row.totalFils, 0);
  return map;
}

/* ---------- الميزانية مقابل الفعلي ---------- */
const STATUS_RANK = { over: 0, risk: 1, unbudgeted: 2, ok: 3 };

export function budgetReport({ transactions = [], budgets = {}, todayISO, key } = {}) {
  const monthKey = key ?? monthKeyOf(todayISO);
  const isCurrent = monthKey === monthKeyOf(todayISO);
  const dim = daysInMonth(monthKey);
  const day = isCurrent ? Math.min(Number(todayISO.slice(8, 10)), dim) : dim;
  const fraction = day / dim;
  const spend = spendByCategory(transactions, monthKey);
  const names = new Set([...Object.keys(budgets).filter((name) => budgets[name] > 0), ...spend.keys()]);
  const rows = [...names].map((category) => {
    const budgetFils = budgets[category] > 0 ? budgets[category] : 0;
    const actualFils = spend.get(category)?.totalFils ?? 0;
    const projectedFils = isCurrent ? (day >= 5 ? Math.round(actualFils / fraction) : null) : actualFils;
    const varianceFils = budgetFils > 0 ? actualFils - budgetFils : null;
    const variancePct = budgetFils > 0 ? (actualFils - budgetFils) / budgetFils : null;
    let status = "ok";
    if (budgetFils === 0) status = actualFils > 0 ? "unbudgeted" : "ok";
    else if (actualFils > budgetFils) status = "over";
    else if (isCurrent && (actualFils >= budgetFils * 0.9 || (projectedFils !== null && day >= 7 && projectedFils > budgetFils * (1 + MATERIAL_THRESHOLD)))) status = "risk";
    return { category, budgetFils, actualFils, varianceFils, variancePct, projectedFils, status, material: variancePct !== null && variancePct >= MATERIAL_THRESHOLD };
  }).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.actualFils - a.actualFils);
  return {
    key: monthKey, isCurrent, day, daysInMonth: dim, rows,
    budgetTotalFils: rows.reduce((sum, row) => sum + row.budgetFils, 0),
    actualTotalFils: rows.reduce((sum, row) => sum + row.actualFils, 0),
    actualBudgetedFils: rows.filter((row) => row.budgetFils > 0).reduce((sum, row) => sum + row.actualFils, 0)
  };
}

/* ---------- مقارنة شهرين وتفكيك الفرق ---------- */
function decompose(curTotal, curCount, prevTotal, prevCount) {
  const delta = curTotal - prevTotal;
  if (prevCount === 0) return { deltaFils: delta, volumeFils: delta, ticketFils: 0, avgPrevFils: 0, avgCurFils: curCount ? Math.round(curTotal / curCount) : 0 };
  const avgPrev = prevTotal / prevCount;
  const volumeFils = Math.round((curCount - prevCount) * avgPrev);
  return { deltaFils: delta, volumeFils, ticketFils: delta - volumeFils, avgPrevFils: Math.round(avgPrev), avgCurFils: curCount ? Math.round(curTotal / curCount) : 0 };
}

export function compareMonths({ transactions = [], currentKey, previousKey, uptoDay = 31 } = {}) {
  const cur = spendByCategory(transactions, currentKey, { uptoDay });
  const prev = spendByCategory(transactions, previousKey, { uptoDay });
  const sum = (map, field) => [...map.values()].reduce((total, row) => total + row[field], 0);
  const curTotal = sum(cur, "totalFils"), prevTotal = sum(prev, "totalFils");
  const curCount = sum(cur, "count"), prevCount = sum(prev, "count");
  const categoriesDelta = [...new Set([...cur.keys(), ...prev.keys()])].map((category) => {
    const curFils = cur.get(category)?.totalFils ?? 0, prevFils = prev.get(category)?.totalFils ?? 0;
    return { category, curFils, prevFils, deltaFils: curFils - prevFils, pct: prevFils > 0 ? (curFils - prevFils) / prevFils : null };
  }).sort((a, b) => Math.abs(b.deltaFils) - Math.abs(a.deltaFils));
  return { currentKey, previousKey, uptoDay, curTotal, prevTotal, curCount, prevCount, ...decompose(curTotal, curCount, prevTotal, prevCount), categories: categoriesDelta,
    hasPrevious: prevCount > 0 || prevTotal > 0 };
}

/* formatMoney ينتهي بنقطة («د.ك.»)، فلا نضيف نقطة جملة بعدها. */
export const tidyMoneyPeriods = (text) => String(text).replace(/(د\.ك\.\u200f?)\./g, "$1");
const pctText = (value) => `${Math.abs(Math.round(value * 100)).toLocaleString("ar-KW-u-nu-latn")}٪`;
const num = (value) => Number(value).toLocaleString("ar-KW-u-nu-latn");

/* شرح فروقات فئة واحدة: محدد، رقمي، فيه السبب والتوقع والإجراء. */
export function explainCategory({ row, transactions, key, todayISO }) {
  const previousKey = shiftMonth(key, -1);
  const isCurrent = key === monthKeyOf(todayISO);
  const uptoDay = isCurrent ? Number(todayISO.slice(8, 10)) : 31;
  const cur = spendByCategory(transactions, key, { uptoDay }).get(row.category);
  const prev = spendByCategory(transactions, previousKey, { uptoDay }).get(row.category);
  const parts = [];
  if (row.budgetFils > 0) {
    const sign = row.actualFils >= row.budgetFils ? "\u200E+" : "\u200E−";
    parts.push(`${row.category}: ${formatMoney(row.actualFils)} مقابل ميزانية ${formatMoney(row.budgetFils)} (${sign}${pctText(row.variancePct)}).`);
  } else parts.push(`${row.category}: ${formatMoney(row.actualFils)} بدون ميزانية محددة.`);

  let driver = null;
  if (cur && prev && cur.totalFils > prev.totalFils) {
    const d = decompose(cur.totalFils, cur.count, prev.totalFils, prev.count);
    if (Math.abs(d.volumeFils) >= Math.abs(d.ticketFils) && d.volumeFils > 0)
      driver = `السبب الرئيسي: زاد عدد العمليات من ${num(prev.count)} إلى ${num(cur.count)} (+${formatMoney(d.volumeFils)}).`;
    else if (d.ticketFils > 0)
      driver = `السبب الرئيسي: ارتفع متوسط العملية من ${formatMoney(d.avgPrevFils)} إلى ${formatMoney(d.avgCurFils)} (+${formatMoney(d.ticketFils)}).`;
    const top = [...cur.merchants].map(([name, fils]) => [name, fils - (prev.merchants.get(name) ?? 0)]).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 0) driver = `${driver ?? ""} أكبر زيادة عند ${top[0]} (+${formatMoney(top[1])}).`.trim();
  } else if (cur && !prev) {
    const top = [...cur.merchants].sort((a, b) => b[1] - a[1])[0];
    driver = `ما فيه صرف بهذي الفئة بنفس الفترة من الشهر الماضي.${top ? ` الأكبر: ${top[0]} (${formatMoney(top[1])}).` : ""}`;
  }
  if (driver) parts.push(driver);

  if (isCurrent && row.projectedFils !== null && row.budgetFils > 0) {
    parts.push(row.status === "over"
      ? `بنفس الوتيرة تنهي الشهر عند ${formatMoney(row.projectedFils)}. قلّل الصرف بها أو عدّل ميزانيتها إذا كانت الزيادة مقصودة.`
      : `بنفس الوتيرة تنهي الشهر عند ${formatMoney(row.projectedFils)}، باقي لك ${formatMoney(Math.max(row.budgetFils - row.actualFils, 0))} فقط.`);
  } else if (row.status === "over") parts.push("قلّل الصرف بها أو عدّل ميزانيتها إذا كانت الزيادة مقصودة.");
  return tidyMoneyPeriods(parts.join(" "));
}

export function categoryNudges(report, { max = 3 } = {}) {
  return report.rows.filter((row) => row.status === "over" || row.status === "risk").slice(0, max).map((row) => ({
    category: row.category, level: row.status,
    text: tidyMoneyPeriods(row.status === "over"
      ? `${row.category}: تجاوزت ميزانيتك بـ ${formatMoney(row.actualFils - row.budgetFils)} (${pctText(row.variancePct)}).`
      : `${row.category}: قربت من ميزانيتك${row.projectedFils ? `، المتوقع آخر الشهر ${formatMoney(row.projectedFils)}` : ""}.`)
  }));
}

/* ميزانية مقترحة من متوسط آخر أشهر كاملة فيها بيانات. تُقرَّب لأقرب ٥ دنانير. */
export function suggestBudgets(transactions = [], todayISO, months = 3) {
  const current = monthKeyOf(todayISO);
  const keys = Array.from({ length: months }, (_, index) => shiftMonth(current, -(index + 1)));
  const usable = keys.filter((key) => spendByCategory(transactions, key).size > 0);
  if (!usable.length) return null;
  const totals = new Map();
  for (const key of usable) for (const [category, row] of spendByCategory(transactions, key)) totals.set(category, (totals.get(category) ?? 0) + row.totalFils);
  const budgets = {};
  for (const [category, total] of totals) {
    const rounded = Math.round(total / usable.length / 5000) * 5000;
    if (rounded > 0) budgets[category] = rounded;
  }
  return { budgets, monthsUsed: usable.length };
}

/* ---------- توزيع الصرف (رسم) ---------- */
/* لون ثابت لكل فئة (لا يتغير بترتيب الصرف). الفئات خارج الجدول تُدمج بلون محايد. */
export const CATEGORY_SLOT = { "مطاعم": 1, "بقالة": 2, "مواصلات": 3, "تسوق": 4, "فواتير": 5, "صحة": 6, "ترفيه": 7 };

export function chartSegments(rows = []) {
  const active = rows.filter((row) => row.actualFils > 0).sort((a, b) => b.actualFils - a.actualFils);
  const total = active.reduce((sum, row) => sum + row.actualFils, 0);
  if (!total) return { total: 0, segments: [], legend: [] };
  const legend = active.map((row) => ({ category: row.category, fils: row.actualFils, pct: row.actualFils / total, slot: CATEGORY_SLOT[row.category] ?? null }));
  const segments = legend.filter((item) => item.slot).map((item) => ({ ...item }));
  const otherFils = legend.filter((item) => !item.slot).reduce((sum, item) => sum + item.fils, 0);
  if (otherFils > 0) segments.push({ category: "غير ذلك", fils: otherFils, pct: otherFils / total, slot: null });
  return { total, segments, legend };
}

/* ---------- الواجهة ---------- */
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATUS_LABEL = { over: "تجاوز", risk: "قرّب", unbudgeted: "بدون ميزانية", ok: "ضمن الميزانية" };

export function mountSpending(root, { getModel, onBudgetsChange }) {
  let view = "current";

  function render() {
    const model = getModel();
    const currentKey = monthKeyOf(model.todayISO);
    const key = view === "current" ? currentKey : shiftMonth(currentKey, -1);
    const report = budgetReport({ transactions: model.transactions, budgets: model.budgets, todayISO: model.todayISO, key });
    const suggestion = suggestBudgets(model.transactions, model.todayISO);
    const flagged = report.rows.filter((row) => row.status === "over" || (row.status === "risk" && report.isCurrent)).slice(0, 4);
    const uptoDay = report.isCurrent ? report.day : 31;
    const comparison = compareMonths({ transactions: model.transactions, currentKey: key, previousKey: shiftMonth(key, -1), uptoDay });
    const overallBudget = model.monthlyBudgetFils;
    const sumBudgets = report.budgetTotalFils;
    const chart = chartSegments(report.rows);
    const maxBar = Math.max(...report.rows.map((row) => Math.max(row.actualFils, row.budgetFils)), 1);

    root.innerHTML = `
      <section class="panel">
        <div class="seg" role="group" aria-label="الشهر">
          <button type="button" class="${view === "current" ? "active" : ""}" data-month="current">هذا الشهر</button>
          <button type="button" class="${view === "previous" ? "active" : ""}" data-month="previous">الشهر الماضي</button>
        </div>
        <div class="section-heading"><div><span class="eyebrow">${esc(monthLabel(key))}${report.isCurrent ? ` · اليوم ${num(report.day)} من ${num(report.daysInMonth)}` : ""}</span><h2>الصرف الفعلي</h2></div>
          <strong class="sp-total">${esc(formatMoney(report.actualTotalFils))}</strong></div>
        ${overallBudget > 0 ? `<div class="cu-bar"><span style="width:${Math.min(report.actualTotalFils / overallBudget * 100, 100)}%;background:${report.actualTotalFils > overallBudget ? "#cf3f3f" : "#0f7a5f"}"></span></div>
          <p class="hint">من ميزانية الشهر الإجمالية ${esc(formatMoney(overallBudget))} (${num(Math.round(report.actualTotalFils / overallBudget * 100))}٪).</p>` : `<p class="hint">حدد ميزانية الشهر من الإعدادات لتظهر النسبة هنا.</p>`}
        ${chart.total ? `<div class="sp-stack" role="img" aria-label="توزيع الصرف حسب الفئة">${chart.segments.map((seg) => `<span style="flex:${seg.fils};background:var(--series-${seg.slot ?? "other"})" title="${esc(seg.category)}: ${esc(formatMoney(seg.fils))} (${num(Math.round(seg.pct * 100))}٪)"></span>`).join("")}</div>
          <ul class="sp-legend">${chart.legend.map((item) => `<li><i style="background:var(--series-${item.slot ?? "other"})"></i><span>${esc(item.category)}</span><b>${num(Math.round(item.pct * 100))}٪</b></li>`).join("")}</ul>` : ""}
        ${model.pendingCount ? `<p class="hint warn-hint">⚠ ${countLabel(model.pendingCount, "transaction")} بانتظار مراجعتك ولا تُحسب هنا قبل اعتمادها.</p>` : ""}
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">الميزانية مقابل الفعلي</span><h2>حسب الفئة</h2></div></div>
        ${report.rows.length ? `<div class="sp-rows">${report.rows.map((row) => `
          <div class="sp-row sp-${row.status}">
            <div class="sp-line"><strong>${esc(row.category)}</strong>
              <span class="sp-chip">${esc(row.varianceFils === null ? STATUS_LABEL[row.status] : `${row.varianceFils > 0 ? "+" : row.varianceFils < 0 ? "\u200E−" : ""}${formatMoney(Math.abs(row.varianceFils))}`)}</span></div>
            <div class="sp-track" aria-hidden="true"><span class="sp-fill" style="width:${Math.round(row.actualFils / maxBar * 100)}%"></span>${row.budgetFils > 0 ? `<i class="sp-mark" style="inset-inline-start:${Math.round(row.budgetFils / maxBar * 100)}%"></i>` : ""}</div>
            <div class="sp-line sp-sub"><span>${esc(formatMoney(row.actualFils))}${row.budgetFils > 0 ? ` من ${esc(formatMoney(row.budgetFils))}` : ""}</span><span>${esc(STATUS_LABEL[row.status])}</span></div>
          </div>`).join("")}</div>` : `<p class="hint">ما فيه مصروفات معتمدة بهذا الشهر.</p>`}
        <h3>ميزانيات الفئات</h3>
        <div class="sp-edit">${EXPENSE_CATEGORIES.map((category) => `
          <label class="field"><span>${esc(category)}</span><div class="money-field"><input inputmode="decimal" data-budget-cat="${esc(category)}" value="${model.budgets[category] ? esc(moneyInput(model.budgets[category])) : ""}" placeholder="بدون"><b>د.ك</b></div></label>`).join("")}</div>
        ${overallBudget > 0 && sumBudgets > overallBudget ? `<p class="hint warn-hint">⚠ مجموع ميزانيات الفئات ${esc(formatMoney(sumBudgets))} أكبر من ميزانية الشهر الإجمالية ${esc(formatMoney(overallBudget))}.</p>` : ""}
        <div class="row wrap"><button type="button" class="secondary" data-suggest ${suggestion ? "" : "disabled"}>${suggestion ? `اقترح من متوسط آخر ${countLabel(suggestion.monthsUsed, "month")}` : "اقترح من متوسط آخر 3 أشهر"}</button></div>
        <p class="hint">${suggestion ? "الاقتراح يعبّي الفئات الفاضية فقط ويقرّب لأقرب 5 دنانير." : "الاقتراح يحتاج شهراً كاملاً سابقاً فيه عمليات معتمدة."}</p>
      </section>

      ${flagged.length ? `<section class="panel"><div class="section-heading"><div><span class="eyebrow">فروقات تستحق نظرة</span><h2>ليش تغيّر؟</h2></div></div>
        ${flagged.map((row) => `<p class="sp-narrative">${esc(explainCategory({ row, transactions: model.transactions, key, todayISO: model.todayISO }))}</p>`).join("")}</section>` : ""}

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">${esc(monthLabel(shiftMonth(key, -1)))}${report.isCurrent ? ` (حتى اليوم ${num(report.day)})` : ""}</span><h2>مقارنة بالشهر السابق</h2></div></div>
        ${comparison.hasPrevious ? `
          <div class="advisor-budget-list">
            <div><span>الشهر الحالي</span><strong>${esc(formatMoney(comparison.curTotal))}</strong></div>
            <div><span>الشهر السابق (نفس الفترة)</span><strong>${esc(formatMoney(comparison.prevTotal))}</strong></div>
            <div class="advisor-budget-total"><span>الفرق</span><strong>${comparison.deltaFils > 0 ? "+" : comparison.deltaFils < 0 ? "\u200E−" : ""}${esc(formatMoney(Math.abs(comparison.deltaFils)))}</strong></div>
          </div>
          ${comparison.deltaFils !== 0 ? `<p class="hint">الفرق من عدد العمليات: ${comparison.volumeFils >= 0 ? "\u200E+" : "\u200E−"}${esc(formatMoney(Math.abs(comparison.volumeFils)))} (${num(comparison.prevCount)} ← ${countLabel(comparison.curCount, "transaction")}). ومن متوسط العملية: ${comparison.ticketFils >= 0 ? "\u200E+" : "\u200E−"}${esc(formatMoney(Math.abs(comparison.ticketFils)))} (${esc(formatMoney(comparison.avgPrevFils))} ← ${esc(formatMoney(comparison.avgCurFils))}).</p>` : ""}
          <h3>أكبر التغيّرات</h3>
          <div class="advisor-budget-list">${comparison.categories.slice(0, 5).filter((item) => item.deltaFils !== 0).map((item) => `<div><span>${esc(item.category)}</span><strong>${item.deltaFils > 0 ? "\u200E+" : "\u200E−"}${esc(formatMoney(Math.abs(item.deltaFils)))}</strong></div>`).join("") || "<p class='hint'>ما فيه تغيّر يُذكر.</p>"}</div>`
        : `<p class="hint">ما فيه عمليات معتمدة بالشهر السابق للمقارنة.</p>`}
      </section>`;
  }

  root.addEventListener("click", (event) => {
    const month = event.target.closest("[data-month]")?.dataset.month;
    if (month) { view = month; render(); return; }
    if (event.target.closest("[data-suggest]")) {
      const model = getModel();
      const suggestion = suggestBudgets(model.transactions, model.todayISO);
      if (!suggestion) return;
      const next = { ...model.budgets };
      for (const [category, fils] of Object.entries(suggestion.budgets)) if (!(next[category] > 0)) next[category] = fils;
      onBudgetsChange(next);
    }
  });
  root.addEventListener("change", (event) => {
    const category = event.target.dataset?.budgetCat;
    if (!category || !EXPENSE_CATEGORIES.includes(category)) return;
    const fils = event.target.value.trim() === "" ? 0 : parseMoney(event.target.value);
    if (fils === null || fils < 0 || fils > 1_000_000_000) return;
    const next = { ...getModel().budgets };
    if (fils > 0) next[category] = fils; else delete next[category];
    onBudgetsChange(next);
  });
  return { render, setView(next) { view = next; } };
}
