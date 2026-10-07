import { countLabel, createId, formatMoney, normalizeDigits, parseMoney, todayISO } from "./finance-core.js";

// محفظة الذهب: كل الأسعار بالفلس لكل غرام ذهب صافي (عيار ٢٤)، والأوزان بالمليغرام.
export const TROY_OUNCE_GRAMS = 31.1034768;
export const KARATS = [24, 22, 21, 18];
export const GOLD_PRICE_URL = "https://api.gold-api.com/price/XAU";
const DAY_MS = 86_400_000;

export function parseGrams(value) {
  const text = normalizeDigits(String(value ?? "")).trim().replaceAll("٫", ".").replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return null;
  const mg = Math.round(Number(text) * 1000);
  return mg > 0 && mg <= 100_000_000 ? mg : null;
}

export function formatGrams(mg) {
  return `${(mg / 1000).toLocaleString("ar-KW-u-nu-latn", { maximumFractionDigits: 3 })} غ`;
}

export function pureMg(purchase) {
  return Math.round(purchase.mg * purchase.karat / 24);
}

// بدون تقريب المليغرام قبل الضرب، حتى ما يختلف تقييم عيار 22 عن سعر العيار المعروض
export function pureMgExact(purchase) {
  return purchase.mg * purchase.karat / 24;
}

export function purchaseValueFils(purchase, fils24) {
  return fils24 ? Math.round(purchase.mg * karatPrice(fils24, purchase.karat) / 1000) : null;
}

export function karatPrice(fils24, karat) {
  return Math.round(fils24 * karat / 24);
}

export function sanitizeGold(raw) {
  const purchases = Array.isArray(raw?.goldPurchases) ? raw.goldPurchases.slice(0, 500).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(item?.date ?? "") ? item.date : todayISO(),
    karat: KARATS.includes(item?.karat) ? item.karat : 24,
    mg: Number.isInteger(item?.mg) && item.mg > 0 && item.mg <= 100_000_000 ? item.mg : 0,
    paidFils: Number.isInteger(item?.paidFils) && item.paidFils > 0 && item.paidFils <= 1_000_000_000_000 ? item.paidFils : 0,
    note: typeof item?.note === "string" ? item.note.trim().slice(0, 60) : ""
  })).filter((item) => item.mg && item.paidFils) : [];
  const prices = Array.isArray(raw?.goldPrices) ? raw.goldPrices.slice(-500).map((item) => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(item?.date ?? "") ? item.date : "",
    fils24: Number.isInteger(item?.fils24) && item.fils24 > 0 && item.fils24 <= 10_000_000 ? item.fils24 : 0,
    source: item?.source === "live" ? "live" : "manual",
    at: typeof item?.at === "string" && Number.isFinite(Date.parse(item.at)) ? item.at.slice(0, 40) : ""
  })).filter((item) => item.date && item.fils24) : [];
  return { goldPurchases: purchases, goldPrices: prices };
}

// سعر واحد لكل يوم؛ آخر تحديث في اليوم يحل محل اللي قبله.
export function recordPrice(history, entry) {
  const next = history.filter((item) => item.date !== entry.date);
  next.push(entry);
  return next.sort((a, b) => a.date.localeCompare(b.date)).slice(-500);
}

export function goldSummary(purchases, fils24) {
  const paidFils = purchases.reduce((sum, item) => sum + item.paidFils, 0);
  const totalMg = purchases.reduce((sum, item) => sum + item.mg, 0);
  const pure = purchases.reduce((sum, item) => sum + pureMg(item), 0);
  const pureExact = purchases.reduce((sum, item) => sum + pureMgExact(item), 0);
  const avgCost24 = pureExact ? Math.round(paidFils * 1000 / pureExact) : null;
  const valueFils = fils24 ? purchases.reduce((sum, item) => sum + purchaseValueFils(item, fils24), 0) : null;
  const profitFils = valueFils === null ? null : valueFils - paidFils;
  return { paidFils, totalMg, pureMg: pure, avgCost24, valueFils, profitFils, profitPct: profitFils === null || !paidFils ? null : profitFils / paidFils * 100 };
}

function windowStats(history, todayIso, days) {
  const from = Date.parse(`${todayIso}T00:00:00Z`) - days * DAY_MS;
  const rows = history.filter((item) => Date.parse(`${item.date}T00:00:00Z`) >= from);
  if (!rows.length) return null;
  const values = rows.map((item) => item.fils24);
  return { count: rows.length, avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length), high: Math.max(...values), low: Math.min(...values) };
}

/**
 * مؤشر الشراء القادم. القاعدة:
 * - سعر الشراء المستهدف = الأقل من (متوسط تكلفتك − ٣٪) و(متوسط آخر ٣٠ يوم − ٢٪)، حتى كل شراء جديد ينزّل متوسطك.
 * - سعر الربح = متوسط تكلفتك + فرق البيع عند المحل (افتراضي ٣٪)، لأن المحل يشتري منك أقل من سعر السوق.
 * مؤشر حسابي من الأسعار المسجلة، وليس توقعاً أو ضماناً.
 */
export function buySignal({ history, avgCost24, today = todayISO(), spreadPct = 3 }) {
  const current = history.at(-1)?.fils24 ?? null;
  const month = windowStats(history, today, 30);
  const quarter = windowStats(history, today, 90);
  const candidates = [];
  if (avgCost24) candidates.push(Math.round(avgCost24 * 0.97));
  if (month && month.count >= 5) candidates.push(Math.round(month.avg * 0.98));
  const target = candidates.length ? Math.min(...candidates) : null;
  const profitPrice = avgCost24 ? Math.round(avgCost24 * (1 + spreadPct / 100)) : null;
  let status = "unknown";
  if (current && target) status = current <= target ? "buy" : current <= target * 1.02 ? "near" : "wait";
  const gapPct = current && target ? (current - target) / target * 100 : null;
  return {
    current, target, profitPrice, status, gapPct, month, quarter,
    learning: !month || month.count < 10,
    inProfit: current && profitPrice ? current >= profitPrice : null
  };
}

export function averageAfterBuy(purchases, buyMg, priceFils24) {
  const pure = purchases.reduce((sum, item) => sum + pureMgExact(item), 0) + buyMg;
  const paid = purchases.reduce((sum, item) => sum + item.paidFils, 0) + Math.round(buyMg * priceFils24 / 1000);
  return pure ? Math.round(paid * 1000 / pure) : null;
}

// يقبل رد gold-api.com: { price, currency, ... } بالأونصة.
export function priceFromApi(json, usdToKwd) {
  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("bad price");
  const currency = String(json?.currency ?? "USD").toUpperCase();
  const perOz = currency === "KWD" ? price : currency === "USD" ? price * usdToKwd : NaN;
  if (!Number.isFinite(perOz)) throw new Error("unsupported currency");
  const fils24 = Math.round(perOz / TROY_OUNCE_GRAMS * 1000);
  if (fils24 < 1_000 || fils24 > 1_000_000) throw new Error("price out of range");
  return fils24;
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (value) => `${value >= 0 ? "\u200E+" : "\u200E−"}${Math.abs(value).toLocaleString("ar-KW-u-nu-latn", { maximumFractionDigits: 1 })}٪`;
const STATUS = {
  buy: ["ok", "منطقة شراء مناسبة", "السعر الحين تحت سعر الشراء المستهدف."],
  near: ["warn", "قريب من منطقة الشراء", "السعر أعلى من المستهدف بأقل من 2٪."],
  wait: ["neutral", "انتظر", "السعر أعلى من المستهدف؛ الشراء الحين يرفع متوسط تكلفتك."],
  unknown: ["neutral", "نحتاج سعر", "حدّث السعر أو أدخله يدوياً."]
};

export function mountGold(root, { getState, save, toast, fetchPrice }) {
  let busy = false;

  function freezeNotice(state) {
    const fund = state.goals.find((goal) => /طوار/.test(goal.name));
    if (fund && fund.savedFils >= fund.targetFils) return "";
    const progress = fund ? ` (المجمّع ${formatMoney(fund.savedFils)} من ${formatMoney(fund.targetFils)})` : "";
    return `<div class="notice warning"><p><strong>تذكير من خطتك:</strong> لا شراء ذهب جديد قبل اكتمال صندوق الطوارئ${esc(progress)}. المؤشر تحت للمتابعة فقط.</p></div>`;
  }

  function render() {
    const state = getState();
    const ui = state.ui;
    const history = state.goldPrices;
    const last = history.at(-1);
    const summary = goldSummary(state.goldPurchases, last?.fils24);
    const signal = buySignal({ history, avgCost24: summary.avgCost24, spreadPct: ui.goldSpreadPct });
    const [tone, label, hint] = STATUS[signal.status];
    const after = signal.target && state.goldPurchases.length ? averageAfterBuy(state.goldPurchases, 10_000, signal.target) : null;
    const updated = last ? `${last.source === "live" ? "سعر السوق" : "سعر أدخلته"} · ${new Date(`${last.date}T12:00:00`).toLocaleDateString("ar-KW-u-nu-latn", { day: "numeric", month: "long" })}${last.at ? ` ${new Date(last.at).toLocaleTimeString("ar-KW-u-nu-latn", { hour: "2-digit", minute: "2-digit" })}` : ""}` : "ما فيه سعر مسجل";
    root.innerHTML = `
      ${freezeNotice(state)}
      <section class="panel gold-price-card">
        <div class="section-heading"><div><span class="eyebrow">${esc(updated)}</span><h2>سعر الغرام اليوم</h2></div><button type="button" class="primary small" data-gold="refresh" ${busy ? "disabled" : ""}>${busy ? "جاري التحديث…" : "تحديث السعر"}</button></div>
        <div class="gold-karats">${KARATS.map((k) => `<div><span>عيار ${k.toLocaleString("ar-KW-u-nu-latn")}</span><strong>${last ? esc(formatMoney(karatPrice(last.fils24, k))) : "—"}</strong></div>`).join("")}</div>
        <p class="hint">سعر السوق العالمي محوّل للدينار، بدون المصنعية. سعر المحل غالباً أعلى عند الشراء وأقل عند البيع.</p>
        <form class="gold-manual" data-gold-form="price"><label class="field"><span>أو أدخل سعر غرام عيار 24 بنفسك</span><div class="money-field"><input name="price" inputmode="decimal" placeholder="0.000"><b>د.ك</b></div></label><button type="submit" class="secondary">حفظ السعر</button></form>
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">محفظتك</span><h2>ذهبك الحين</h2></div><span class="pill">${esc(formatGrams(summary.totalMg))}</span></div>
        <div class="metric-grid">
          <article class="metric"><span>دفعت</span><strong>${esc(formatMoney(summary.paidFils))}</strong></article>
          <article class="metric"><span>قيمته بسعر اليوم</span><strong>${summary.valueFils === null ? "—" : esc(formatMoney(summary.valueFils))}</strong></article>
          <article class="metric"><span>الربح أو الخسارة</span><strong class="${summary.profitFils < 0 ? "negative" : "positive"}">${summary.profitFils === null ? "—" : `${esc(formatMoney(summary.profitFils))} (${esc(pct(summary.profitPct))})`}</strong></article>
          <article class="metric"><span>متوسط تكلفتك لغرام 24</span><strong>${summary.avgCost24 ? esc(formatMoney(summary.avgCost24)) : "—"}</strong></article>
        </div>
      </section>

      <section class="panel gold-signal ${tone}">
        <div class="section-heading"><div><span class="eyebrow">مؤشر من الأسعار المسجلة</span><h2>متى الشراء القادم؟</h2></div><span class="status-badge ${tone}">${esc(label)}</span></div>
        <p>${esc(hint)}</p>
        <div class="metric-grid">
          <article class="metric"><span>اشترِ إذا نزل غرام 24 إلى</span><strong>${signal.target ? esc(formatMoney(signal.target)) : "—"}</strong></article>
          <article class="metric"><span>تربح إذا بعت فوق</span><strong>${signal.profitPrice ? esc(formatMoney(signal.profitPrice)) : "—"}</strong></article>
        </div>
        <ul class="gold-basis">
          ${summary.avgCost24 ? `<li>متوسط تكلفتك ${esc(formatMoney(summary.avgCost24))}؛ الشراء تحته بـ3٪ ينزّل المتوسط.</li>` : ""}
          ${signal.month ? `<li>آخر 30 يوم: متوسط ${esc(formatMoney(signal.month.avg))} · أعلى ${esc(formatMoney(signal.month.high))} · أدنى ${esc(formatMoney(signal.month.low))} (${countLabel(signal.month.count, "price")}).</li>` : ""}
          ${signal.gapPct !== null ? `<li>السعر الحالي ${esc(pct(signal.gapPct))} عن المستهدف.</li>` : ""}
          ${after ? `<li>لو اشتريت 10 غرام عيار 24 بالسعر المستهدف، يصير متوسطك ${esc(formatMoney(after))}.</li>` : ""}
          <li>سعر الربح = متوسطك + ${Number(ui.goldSpreadPct).toLocaleString("ar-KW-u-nu-latn")}٪ فرق بيع المحل.</li>
          ${signal.learning ? "<li>البيانات قليلة: حدّث السعر يومياً عشان المؤشر يصير أدق.</li>" : ""}
        </ul>
        <p class="hint">هذا مؤشر حسابي من أسعارك المسجلة، مو توقع للسوق ولا ضمان ربح.</p>
      </section>

      <section class="panel">
        <div class="section-heading"><div><span class="eyebrow">سجل المشتريات</span><h2>مشترياتك</h2></div></div>
        <form class="gold-add" data-gold-form="purchase">
          <label class="field"><span>التاريخ</span><input name="date" type="date" required value="${esc(todayISO())}" max="${esc(todayISO())}"></label>
          <label class="field"><span>العيار</span><select name="karat">${KARATS.map((k) => `<option value="${k}">${k.toLocaleString("ar-KW-u-nu-latn")}</option>`).join("")}</select></label>
          <label class="field"><span>الوزن (غرام)</span><input name="grams" inputmode="decimal" required placeholder="10"></label>
          <label class="field"><span>المبلغ المدفوع كامل</span><div class="money-field"><input name="paid" inputmode="decimal" required placeholder="0.000"><b>د.ك</b></div></label>
          <label class="field"><span>ملاحظة (اختياري)</span><input name="note" maxlength="60" placeholder="سبيكة، سوار…"></label>
          <button type="submit" class="primary">إضافة الشراء</button>
        </form>
        <div class="stack-list">${state.goldPurchases.slice().sort((a, b) => b.date.localeCompare(a.date)).map((item) => {
          const unit = Math.round(item.paidFils * 1000 / item.mg);
          return `<article class="data-card gold-row"><div><strong>${esc(formatGrams(item.mg))} · عيار ${item.karat.toLocaleString("ar-KW-u-nu-latn")}</strong><small>${esc(new Date(`${item.date}T12:00:00`).toLocaleDateString("ar-KW-u-nu-latn", { day: "numeric", month: "long", year: "numeric" }))}${item.note ? ` · ${esc(item.note)}` : ""}</small><small>دفعت ${esc(formatMoney(item.paidFils))} · ${esc(formatMoney(unit))} للغرام</small></div><button type="button" class="ghost small" data-gold-delete="${esc(item.id)}" aria-label="حذف الشراء">حذف</button></article>`;
        }).join("") || '<p class="hint">ما سجلت مشتريات ذهب بعد.</p>'}</div>
        <label class="field gold-spread"><span>فرق البيع عند المحل (٪)</span><input name="spread" data-gold-spread inputmode="decimal" value="${esc(ui.goldSpreadPct)}"></label>
      </section>`;
  }

  async function refresh() {
    busy = true; render();
    try {
      const fils24 = await fetchPrice();
      const state = getState();
      state.goldPrices = recordPrice(state.goldPrices, { date: todayISO(), fils24, source: "live", at: new Date().toISOString() });
      state.ui.goldGramFils = fils24;
      save(); toast("تم تحديث سعر الذهب");
    } catch {
      toast("ما قدرت أجيب السعر الحين؛ أدخله يدوياً");
    } finally { busy = false; render(); }
  }

  root.addEventListener("click", (event) => {
    if (event.target.closest('[data-gold="refresh"]')) { refresh(); return; }
    const id = event.target.closest("[data-gold-delete]")?.dataset.goldDelete;
    if (id) {
      const state = getState();
      state.goldPurchases = state.goldPurchases.filter((item) => item.id !== id);
      save(); render(); toast("تم حذف الشراء");
    }
  });
  root.addEventListener("change", (event) => {
    if (!event.target.matches("[data-gold-spread]")) return;
    const value = Number(normalizeDigits(event.target.value).replace("٫", "."));
    if (!Number.isFinite(value) || value < 0 || value > 20) { toast("اكتب نسبة من 0 إلى 20"); render(); return; }
    getState().ui.goldSpreadPct = value; save(); render();
  });
  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-gold-form]");
    if (!form) return;
    event.preventDefault();
    const state = getState();
    const data = new FormData(form);
    if (form.dataset.goldForm === "price") {
      const fils24 = parseMoney(data.get("price"));
      if (!fils24 || fils24 < 1_000 || fils24 > 1_000_000) { toast("اكتب سعر غرام صحيح بالدينار"); return; }
      state.goldPrices = recordPrice(state.goldPrices, { date: todayISO(), fils24, source: "manual", at: new Date().toISOString() });
      state.ui.goldGramFils = fils24;
      save(); render(); toast("تم حفظ السعر");
      return;
    }
    const mg = parseGrams(data.get("grams"));
    const paidFils = parseMoney(data.get("paid"));
    const date = String(data.get("date"));
    const karat = Number(data.get("karat"));
    if (!mg || !paidFils || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayISO() || !KARATS.includes(karat)) { toast("راجع التاريخ والوزن والمبلغ"); return; }
    state.goldPurchases.push({ id: createId(), date, karat, mg, paidFils, note: String(data.get("note") ?? "").trim().slice(0, 60) });
    save(); render(); toast("تمت إضافة الشراء");
  });

  return { render };
}

