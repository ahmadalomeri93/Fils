import { formatMoney, investmentProjection, moneyInput, parseMoney } from "./finance-core.js";
import { calculateStockPosition, getKuwaitStock } from "./kuwait-stocks.js";

const clamp = (value, low = 0, high = 100) => Math.min(high, Math.max(low, value));
const lerp = (value, worst, best) => clamp(((value - worst) / (best - worst)) * 100);
const fin = (value) => Number.isFinite(value) ? value : 0;

/* نسبة بعلامة صريحة: «−0.0٪» مالها معنى، فنقرّب الصفر إلى صفر ونضع علامة الطرح بعلامة اتجاه (F57). */
export function signedPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  const safe = Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
  return `${safe < 0 ? "\u200E\u2212" : ""}${Math.abs(safe).toFixed(digits)}`;
}

/* ---------- 1) المؤشر الصحي المالي ---------- */
export function healthScore({
  incomeFils = 0, livingFils = 0, commitmentsFils = 0, debtPaymentsFils = 0,
  totalDebtFils = 0, cashFils = 0, overdue = false
} = {}) {
  if (!(incomeFils > 0)) return null;
  const outflow = livingFils + commitmentsFils + debtPaymentsFils;
  const savingsRate = ((incomeFils - outflow) / incomeFils) * 100;
  const dti = (debtPaymentsFils / incomeFils) * 100;
  const monthsCovered = outflow > 0 ? cashFils / outflow : null;
  const debtToAnnual = totalDebtFils / (incomeFils * 12);

  const components = [
    { key: "savings", label: "معدل الادخار", weight: 30, value: savingsRate, score: lerp(savingsRate, 0, 20),
      display: `${signedPercent(savingsRate)}٪ من الدخل`, target: "الهدف 20٪ فأكثر" },
    { key: "dti", label: "عبء الأقساط (DTI)", weight: 25, value: dti, score: lerp(dti, 50, 20),
      display: `${signedPercent(dti)}٪ من الدخل`, target: "الأفضل أقل من 20٪، والخطر فوق 40٪" },
    { key: "reserve", label: "احتياطي الطوارئ", weight: 30, value: monthsCovered,
      score: monthsCovered === null ? 0 : lerp(monthsCovered, 0, 6),
      display: monthsCovered === null ? "—" : `${monthsCovered.toFixed(1)} شهر`, target: "الهدف 3 إلى 6 أشهر من الصرف الإلزامي" },
    { key: "debtLoad", label: "الدين مقابل الدخل السنوي", weight: 15, value: debtToAnnual,
      score: lerp(debtToAnnual, 2, 0.25), display: `${debtToAnnual.toFixed(2)}× الدخل السنوي`, target: "الأفضل أقل من 0.5× الدخل السنوي" }
  ];
  let score = components.reduce((sum, item) => sum + item.score * item.weight, 0) / 100;
  if (overdue) score = Math.min(score, 40);
  score = Math.round(score);
  const grade = score >= 80 ? "ممتاز" : score >= 65 ? "جيد" : score >= 45 ? "يحتاج تحسين" : "حرج";
  const weakest = [...components].sort((a, b) => a.score - b.score)[0];
  return { score, grade, overdue, components, weakest, savingsRate, dti, monthsCovered, debtToAnnual };
}

/* ---------- 2) ترتيب سداد الديون ---------- */
export function debtOrder(loans = []) {
  const active = loans.filter((loan) => (loan?.status === "active" || loan?.status === "overdue") && loan.balanceFils > 0);
  const rateKnown = active.filter((loan) => loan.interestRateKnown);
  const avalanche = [...rateKnown].sort((a, b) => b.annualRate - a.annualRate || a.balanceFils - b.balanceFils);
  const snowball = [...active].sort((a, b) => a.balanceFils - b.balanceFils);
  const overdue = active.filter((loan) => loan.status === "overdue");
  return {
    active, avalanche, snowball, overdue,
    unknownRate: active.filter((loan) => !loan.interestRateKnown),
    monthlyInterestFils: rateKnown.reduce((sum, loan) => sum + Math.round(loan.balanceFils * loan.annualRate / 1200), 0)
  };
}

/* ---------- 3) تحويل ربح المرابحة الثابت إلى معدل فعلي ---------- */
export function flatRateToEffective({ principalFils, flatRatePercent, months } = {}) {
  if (![principalFils, flatRatePercent, months].every(Number.isFinite) || principalFils <= 0 ||
      flatRatePercent < 0 || flatRatePercent > 100 || !Number.isInteger(months) || months < 1 || months > 480) return null;
  const profitFils = Math.round(principalFils * (flatRatePercent / 100) * (months / 12));
  const installmentFils = Math.round((principalFils + profitFils) / months);
  if (flatRatePercent === 0) return { profitFils: 0, installmentFils, totalFils: principalFils, nominalAprPercent: 0, effectiveAprPercent: 0 };
  const payment = (principalFils + profitFils) / months;
  const pv = (rate) => payment * (1 - Math.pow(1 + rate, -months)) / rate;
  let low = 1e-9, high = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (pv(mid) > principalFils) low = mid; else high = mid;
  }
  const monthly = (low + high) / 2;
  return {
    profitFils, installmentFils, totalFils: principalFils + profitFils,
    nominalAprPercent: monthly * 12 * 100,
    effectiveAprPercent: (Math.pow(1 + monthly, 12) - 1) * 100
  };
}

/* ---------- 4) الزكاة ---------- */
export const NISAB_GOLD_GRAMS = 85;
export function zakat({ goldGramPriceFils = 0, assetsFils = 0, shortTermDebtFils = 0 } = {}) {
  if (!(goldGramPriceFils > 0)) return { ready: false };
  const nisabFils = Math.round(goldGramPriceFils * NISAB_GOLD_GRAMS);
  const netFils = Math.max(assetsFils - Math.max(shortTermDebtFils, 0), 0);
  const due = netFils >= nisabFils;
  return { ready: true, nisabFils, netFils, due, zakatFils: due ? Math.round(netFils * 0.025) : 0 };
}

/* ---------- 5) تركز المحفظة والتوزيعات ---------- */
const SECTORS = { 1: "بنوك", 2: "استثمار", 3: "تأمين", 4: "عقار" };
export const SECTOR_OPTIONS = ["بنوك", "استثمار", "تأمين", "عقار", "صناعة", "خدمات", "أغذية", "طاقة", "اتصالات", "أخرى"];
/* التقدير الافتراضي من أول رقم بالرمز غير مؤكد رسمياً؛ المستخدم يقدر يغيّره لكل سهم. */
export function sectorOf(code = "", overrides = {}) {
  if (SECTOR_OPTIONS.includes(overrides?.[code])) return overrides[code];
  const digit = Number(String(code)[0]);
  return SECTORS[digit] ?? "أخرى";
}

export function portfolioConcentration(holdings = [], overrides = {}) {
  const rows = holdings.map((holding) => {
    const security = getKuwaitStock(holding.securityCode);
    const position = calculateStockPosition(holding);
    return security && position ? { code: security.code, name: security.name, sector: sectorOf(security.code, overrides), overridden: SECTOR_OPTIONS.includes(overrides?.[security.code]), valueFils: position.currentValueFils } : null;
  }).filter(Boolean);
  const total = rows.reduce((sum, row) => sum + row.valueFils, 0);
  if (!rows.length || total <= 0) return null;
  const withShare = rows.map((row) => ({ ...row, sharePercent: (row.valueFils / total) * 100 })).sort((a, b) => b.valueFils - a.valueFils);
  const sectorMap = new Map();
  for (const row of withShare) sectorMap.set(row.sector, (sectorMap.get(row.sector) ?? 0) + row.valueFils);
  const sectors = [...sectorMap].map(([sector, valueFils]) => ({ sector, valueFils, sharePercent: (valueFils / total) * 100 }))
    .sort((a, b) => b.valueFils - a.valueFils);
  const hhi = withShare.reduce((sum, row) => sum + (row.sharePercent / 100) ** 2, 0) * 10000;
  const warnings = [];
  if (withShare[0].sharePercent > 40) warnings.push(`سهم ${withShare[0].name} يمثل ${withShare[0].sharePercent.toFixed(0)}٪ من المحفظة — تركز مرتفع في شركة واحدة.`);
  if (sectors[0].sharePercent > 60) warnings.push(`قطاع «${sectors[0].sector}» يمثل ${sectors[0].sharePercent.toFixed(0)}٪ — تركز قطاعي مرتفع.`);
  if (withShare.length < 5) warnings.push(`المحفظة ${withShare.length} أسهم فقط؛ التنويع الجيد يبدأ عادة من 5 شركات في قطاعات مختلفة.`);
  return { rows: withShare, sectors, totalFils: total, hhi, warnings };
}

export function dividendIncome(holdings = [], dividendTenthsByCode = {}) {
  let incomeFils = 0, cost = 0, value = 0;
  const rows = [];
  for (const holding of holdings) {
    const position = calculateStockPosition(holding);
    const security = getKuwaitStock(holding.securityCode);
    const perShareTenths = dividendTenthsByCode?.[holding.securityCode] ?? 0;
    if (!position || !security) continue;
    const fils = Math.round(holding.quantity * perShareTenths / 10);
    incomeFils += fils; cost += position.totalCostFils; value += position.currentValueFils;
    rows.push({ code: security.code, name: security.name, perShareTenths, incomeFils: fils });
  }
  return { rows, incomeFils, yieldOnCostPercent: cost ? (incomeFils / cost) * 100 : 0, yieldOnValuePercent: value ? (incomeFils / value) * 100 : 0 };
}

/* ---------- 6) العائد الحقيقي بعد التضخم ---------- */
export function realProjection({ initialFils, monthlyFils, annualRate, inflationRate, years }) {
  const nominal = investmentProjection({ initialFils, monthlyFils, annualRate, years });
  if (!nominal || !Number.isFinite(inflationRate) || inflationRate < 0 || inflationRate > 50) return null;
  const realRate = ((1 + annualRate / 100) / (1 + inflationRate / 100) - 1) * 100;
  const real = investmentProjection({ initialFils, monthlyFils, annualRate: realRate, years });
  if (!real) return null;
  return { nominalFils: nominal.valueFils, realFils: real.valueFils, realRate, contributionsFils: nominal.contributionsFils };
}

/* ---------- الواجهة ---------- */
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n1 = (value) => Number(value).toLocaleString("ar-KW-u-nu-latn", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function mountCheckup(root, { getModel, getUi, setUi }) {
  const $ = (selector) => root.querySelector(selector);
  const kd = (selector) => parseMoney($(selector)?.value ?? "");

  function scoreColor(score) { return score >= 80 ? "#1f9d63" : score >= 65 ? "#7aa63a" : score >= 45 ? "#d98a1f" : "#cf3f3f"; }

  function updateMurabaha() {
    const out = $("#cu-mur-out");
    const principal = kd("#cu-mur-principal"), months = Number($("#cu-mur-months").value), rate = Number($("#cu-mur-rate").value);
    const result = principal ? flatRateToEffective({ principalFils: principal, flatRatePercent: rate, months }) : null;
    out.innerHTML = result
      ? `<div><span>القسط الشهري</span><strong>${esc(formatMoney(result.installmentFils))}</strong></div>
         <div><span>إجمالي الربح</span><strong>${esc(formatMoney(result.profitFils))}</strong></div>
         <div><span>المعدل الاسمي المكافئ</span><strong>${n1(result.nominalAprPercent)}٪</strong></div>
         <div><span>المعدل الفعلي السنوي</span><strong>${n1(result.effectiveAprPercent)}٪</strong></div>`
      : `<p class="hint">أدخل المبلغ والمدة والنسبة لعرض التكلفة الحقيقية.</p>`;
  }

  function updateZakat() {
    const model = getModel();
    const gram = kd("#cu-gold");
    const extra = (kd("#cu-z-other") ?? 0) + (kd("#cu-z-gold") ?? 0);
    const debts = kd("#cu-z-debts") ?? 0;
    const assets = model.cashFils + model.stocksFils + extra;
    const result = zakat({ goldGramPriceFils: gram ?? 0, assetsFils: assets, shortTermDebtFils: debts });
    setUi({ goldGramFils: gram ?? 0, zakatOtherFils: kd("#cu-z-other") ?? 0, zakatGoldFils: kd("#cu-z-gold") ?? 0, zakatDebtsFils: debts });
    $("#cu-z-out").innerHTML = !result.ready
      ? `<p class="hint">أدخل سعر جرام الذهب اليوم لحساب النصاب (${NISAB_GOLD_GRAMS} جرام).</p>`
      : `<div><span>النصاب</span><strong>${esc(formatMoney(result.nisabFils))}</strong></div>
         <div><span>الوعاء الزكوي</span><strong>${esc(formatMoney(result.netFils))}</strong></div>
         <div class="advisor-budget-total"><span>${result.due ? "الزكاة المستحقة 2.5٪" : "لم يبلغ النصاب"}</span><strong>${esc(formatMoney(result.zakatFils))}</strong></div>`;
  }

  function updateReal() {
    const model = getModel();
    const inflation = Number($("#cu-infl").value);
    const result = realProjection({ initialFils: model.investment.initialFils, monthlyFils: model.investment.monthlyFils,
      annualRate: model.investment.annualRate, inflationRate: inflation, years: model.investment.years });
    setUi({ inflationRate: Number.isFinite(inflation) ? inflation : 2.5 });
    $("#cu-real-out").innerHTML = result
      ? `<div><span>القيمة الاسمية بعد ${model.investment.years} سنة</span><strong>${esc(formatMoney(result.nominalFils))}</strong></div>
         <div><span>القوة الشرائية الحقيقية</span><strong>${esc(formatMoney(result.realFils))}</strong></div>
         <div><span>العائد الحقيقي السنوي</span><strong>${n1(result.realRate)}٪</strong></div>`
      : `<p class="hint">تأكد من قيم التضخم وسيناريو الاستثمار.</p>`;
  }

  function updateDividends() {
    const model = getModel();
    const map = { ...(getUi().dividends ?? {}) };
    root.querySelectorAll("[data-div-code]").forEach((input) => {
      const value = Number(String(input.value).replace(",", "."));
      if (Number.isFinite(value) && value >= 0 && value < 100000) map[input.dataset.divCode] = Math.round(value * 10);
    });
    setUi({ dividends: map });
    const result = dividendIncome(model.holdings, map);
    $("#cu-div-out").innerHTML = `<div><span>التوزيعات السنوية المتوقعة</span><strong>${esc(formatMoney(result.incomeFils))}</strong></div>
      <div><span>العائد على التكلفة</span><strong>${n1(result.yieldOnCostPercent)}٪</strong></div>
      <div><span>العائد على القيمة الحالية</span><strong>${n1(result.yieldOnValuePercent)}٪</strong></div>`;
  }

  function render() {
    const model = getModel();
    const ui = getUi();
    const health = healthScore(model);
    const debts = debtOrder(model.loans);
    const conc = portfolioConcentration(model.holdings, ui.sectorOverrides ?? {});
    const order = (list) => list.map((loan, index) => `<li><b>${index + 1}.</b> ${esc(loan.name)}${loan.lender ? ` — ${esc(loan.lender)}` : ""} <span class="muted-inline">(${esc(formatMoney(loan.balanceFils))}${loan.interestRateKnown ? ` · ${n1(loan.annualRate)}٪` : ""})</span></li>`).join("");

    root.innerHTML = `
      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">تقييم شامل</span><h2>المؤشر الصحي المالي</h2></div>
          ${health ? `<span class="pill" style="background:${scoreColor(health.score)};color:#fff">${health.score} / 100 · ${health.grade}</span>` : `<span class="pill">بانتظار البيانات</span>`}</div>
        ${health ? `
          <div class="cu-bar"><span style="width:${health.score}%;background:${scoreColor(health.score)}"></span></div>
          <div class="cu-rows">${health.components.map((c) => `
            <div class="cu-row"><div><strong>${c.label}</strong><small>${c.target}</small></div>
              <div><b>${esc(c.display)}</b><div class="cu-bar small"><span style="width:${Math.round(c.score)}%;background:${scoreColor(c.score)}"></span></div></div></div>`).join("")}</div>
          <p class="hint"><b>أضعف نقطة:</b> ${health.weakest.label}.${health.overdue ? " يوجد قرض متأخر، لذلك لا يتجاوز التقييم 40 حتى تنتظم الدفعات." : ""}
          المؤشر يعتمد على بياناتك المسجلة فقط وهو إرشاد عام وليس استشارة مرخصة.</p>`
        : `<p class="hint">أدخل دخلك ومصروفك الشهري في الإعدادات ليظهر التقييم.</p>`}
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">استراتيجية</span><h2>أي دين أسدد أولاً؟</h2></div></div>
        ${debts.active.length ? `
          ${debts.overdue.length ? `<p class="hint" style="color:#cf3f3f"><b>أولوية قصوى:</b> سدّد المتأخر أولاً (${debts.overdue.map((l) => esc(l.name)).join("، ")}) لتفادي الغرامات وأثرها على السجل الائتماني.</p>` : ""}
          ${debts.avalanche.length ? `<h3>الانهيار الجليدي — الأقل تكلفة كلياً</h3><ol class="cu-list">${order(debts.avalanche)}</ol>
            <p class="hint">يوجّه أي مبلغ إضافي للدين الأعلى معدلاً. الفوائد التقريبية الشهرية على ديونك المعروفة المعدل: ${esc(formatMoney(debts.monthlyInterestFils))}.</p>` : ""}
          <h3>كرة الثلج — الأسرع إنجازاً نفسياً</h3><ol class="cu-list">${order(debts.snowball)}</ol>
          ${debts.unknownRate.length ? `<p class="hint">لم تُسجَّل نسبة الربح لـ ${debts.unknownRate.length.toLocaleString("ar-KW-u-nu-latn")} من الديون، فلا يمكن ترتيبها بالتكلفة. أضف النسبة من عقد القرض لنتيجة أدق.</p>` : ""}`
        : `<p class="hint">لا توجد ديون نشطة. ممتاز.</p>`}
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">تمويل المرابحة والتقسيط</span><h2>التكلفة الحقيقية للقرض</h2></div></div>
        <p class="hint">كثير من القروض تُعلن بنسبة ربح ثابتة على أصل المبلغ طوال المدة. هذه الحاسبة تحوّلها إلى المعدل الفعلي على الرصيد المتناقص لتقارن بين العروض.</p>
        <div class="form-grid">
          <label class="field"><span>مبلغ التمويل</span><div class="money-field"><input id="cu-mur-principal" inputmode="decimal" placeholder="10000.000"><b>د.ك</b></div></label>
          <label class="field"><span>المدة بالأشهر</span><input id="cu-mur-months" type="number" min="1" max="480" value="60"></label>
          <label class="field"><span>نسبة الربح الثابتة سنوياً ٪</span><input id="cu-mur-rate" type="number" min="0" max="100" step="0.01" value="4"></label>
        </div>
        <div class="advisor-budget-list" id="cu-mur-out"></div>
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">تركز المخاطر</span><h2>تنويع محفظة الأسهم</h2></div></div>
        ${conc ? `
          <div class="advisor-budget-list">${conc.rows.map((r) => `<div><span>${esc(r.name)}<select class="sector-select" data-sector-code="${esc(r.code)}" aria-label="قطاع ${esc(r.name)}">${SECTOR_OPTIONS.map((o) => `<option${o === r.sector ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></span><strong>${n1(r.sharePercent)}٪</strong></div>`).join("")}</div>
          <h3>حسب القطاع</h3>
          <div class="advisor-budget-list">${conc.sectors.map((s) => `<div><span>${esc(s.sector)}</span><strong>${n1(s.sharePercent)}٪</strong></div>`).join("")}</div>
          ${conc.warnings.map((w) => `<p class="hint warn-hint">⚠ ${esc(w)}</p>`).join("") || `<p class="hint">توزيع المحفظة متوازن نسبياً.</p>`}
          <p class="hint">القطاع الافتراضي تقدير من أول رقم بالرمز (1 بنوك، 2 استثمار، 3 تأمين، 4 عقار) ولم أتحقق منه رسمياً. غيّره لكل سهم من القائمة إذا كان تصنيفه مختلفاً.</p>`
        : `<p class="hint">أضف أسهماً في صفحة الاستثمار لعرض التركز.</p>`}
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">دخل سلبي</span><h2>توزيعات الأسهم النقدية</h2></div></div>
        ${model.holdings.length ? `
          <p class="hint">أدخل التوزيع النقدي المتوقع لكل سهم بالفلس سنوياً (من إعلان الشركة). لا نخمّن أي توزيع.</p>
          ${model.holdings.map((h) => { const s = getKuwaitStock(h.securityCode); const v = (ui.dividends?.[h.securityCode] ?? 0) / 10; return s ? `
            <label class="field"><span>${esc(s.name)} — فلس / سهم</span><input data-div-code="${esc(h.securityCode)}" inputmode="decimal" value="${v || ""}" placeholder="0"></label>` : ""; }).join("")}
          <div class="advisor-budget-list" id="cu-div-out"></div>`
        : `<p class="hint">لا توجد أسهم في محفظتك.</p>`}
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">قوة شرائية</span><h2>الاستثمار بعد التضخم</h2></div></div>
        <p class="hint">العائد الاسمي يخدع؛ هذه المقارنة تخصم التضخم من سيناريو الاستثمار المحفوظ في صفحة الاستثمار.</p>
        <label class="field"><span>التضخم السنوي المتوقع ٪ (افتراض منك)</span><input id="cu-infl" type="number" min="0" max="50" step="0.1" value="${ui.inflationRate ?? 2.5}"></label>
        <div class="advisor-budget-list" id="cu-real-out"></div>
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">فريضة</span><h2>حاسبة الزكاة</h2></div></div>
        <p class="hint">تُحسب على النقد وقيمة الأسهم الحالية المسجلين في التطبيق، وتضيف أنت ما عداها. النصاب ${NISAB_GOLD_GRAMS} جراماً من الذهب، ويشترط مرور حول هجري. للأحكام التفصيلية راجع جهة شرعية معتمدة كبيت الزكاة.</p>
        <div class="form-grid">
          <label class="field"><span>سعر جرام الذهب عيار 24 اليوم</span><div class="money-field"><input id="cu-gold" inputmode="decimal" value="${ui.goldGramFils ? moneyInput(ui.goldGramFils) : ""}"><b>د.ك</b></div></label>
          <label class="field"><span>ذهب وفضة مملوكة للادخار (قيمة)</span><div class="money-field"><input id="cu-z-gold" inputmode="decimal" value="${ui.zakatGoldFils ? moneyInput(ui.zakatGoldFils) : ""}"><b>د.ك</b></div></label>
          <label class="field"><span>أصول أخرى زكوية (ودائع، ديون لك…)</span><div class="money-field"><input id="cu-z-other" inputmode="decimal" value="${ui.zakatOtherFils ? moneyInput(ui.zakatOtherFils) : ""}"><b>د.ك</b></div></label>
          <label class="field"><span>ديون حالّة خلال السنة (تُخصم)</span><div class="money-field"><input id="cu-z-debts" inputmode="decimal" value="${ui.zakatDebtsFils ? moneyInput(ui.zakatDebtsFils) : ""}"><b>د.ك</b></div></label>
        </div>
        <p class="hint">النقد المسجل: ${esc(formatMoney(model.cashFils))} · الأسهم: ${esc(formatMoney(model.stocksFils))}</p>
        <div class="advisor-budget-list" id="cu-z-out"></div>
      </section>`;
    updateMurabaha(); updateZakat(); updateReal(); if ($("#cu-div-out")) updateDividends();
  }

  root.addEventListener("change", (event) => {
    const code = event.target.dataset?.sectorCode;
    if (!code || !SECTOR_OPTIONS.includes(event.target.value)) return;
    setUi({ sectorOverrides: { ...(getUi().sectorOverrides ?? {}), [code]: event.target.value } });
    render();
  });
  root.addEventListener("input", (event) => {
    const id = event.target.id;
    if (id?.startsWith("cu-mur")) updateMurabaha();
    else if (id === "cu-infl") updateReal();
    else if (id === "cu-gold" || id?.startsWith("cu-z-")) updateZakat();
    else if (event.target.dataset?.divCode) updateDividends();
  });
  return { render };
}
