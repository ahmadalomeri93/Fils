import { normalizeDigits } from "./finance-core.js";

export const KUWAIT_STOCKS_AS_OF = "2026-10-02";

const STOCK_ROWS = `
101|NBK|وطني
102|GBK|خليج ب
103|CBK|تجاري
104|ABK|اهلي
106|KIB|الدولي
107|BURG|برقان
108|KFH|بيتك
109|BOUBYAN|بنك بوبيان
201|KINV|كويتية
202|FACIL|تسهيلات
203|IFA|ايفا
204|NINV|استثمارات
205|KPROJ|مشاريع
207|COAST|ساحل
209|SECH|البيت
212|ARZAN|أرزان
213|MARKAZ|المركز
214|KMEFIC|كميفك
219|ALOLA|الأولى
221|GIH|الخليجي
222|AAYAN|أعيان
223|BAYANINV|بيان
225|OSOUL|أصول
227|KFIC|كفيك
228|KAMCO|كامكو
231|NIH|وطنية د ق
232|UNICAP|يونيكاب
233|MADAR|مدار
234|ALDEERA|الديره
235|ALSAFAT|الصفاة
237|EKTTITAB|اكتتاب
239|SOKOUK|صكوك
241|NOOR|نور
242|TAMINV|تمدين أ
245|EMIRATES|الإماراتية
247|ASIYA|آسيا
249|RASIYAT|راسيات
252|ALIMTIAZ|الامتياز
301|KINS|كويت ت
302|GINS|خليج ت
303|AINS|اهلية ت
304|WINSRE|وربة ت إ
305|KUWAITRE|الاعادة
306|FTI|أولى تكافل
307|WETHAQ|وثاق
401|KRE|عقارات ك
402|URC|متحدة
403|NRE|وطنية
404|SRE|صالحية
406|TAM|تمدين ع
408|AREEC|اجيال
410|ARABREC|ع عقارية
412|ALENMA|الإنماء
413|MABANEE|المباني
414|INJAZZAT|إنجازات
418|ALTIJARIA|التجارية
419|SANAM|سنام
420|AAYANRE|أعيان ع
421|AQAR|عقار
422|ALAQARIA|العقارية
423|MAZAYA|مزايا
427|TIJARA|تجارة
429|ARKAN|أركان
431|ARGAN|أرجان
433|MUNSHAAT|منشات
435|KBT|م الأعمال
436|MANAZEL|منازل
438|MENA|مينا
440|MARAKEZ|مراكز
501|NIND|صناعات
503|KCEM|اسمنت
505|CABLE|كابلات
506|SHIP|سفن
508|PCEM|بورتلاند
509|SHUAIBA|شعيبة
510|MRC|معادن
511|KFOUC|سكب ك
512|ACICO|أسيكو
514|BPCC|بوبيان ب
517|ALKOUT|الكوت
520|NICBM|وطنية م ب
522|EQUIPMENT|المعدات
524|NCCI|استهلاكيه
529|WARBACAP|وربة كبيتل
601|KCIN|سينما
602|KHOT|فنادق
603|MKHZN|مخازن
605|ZAIN|زين
606|SENERGY|سنرجي
608|IPG|بترولية
609|CLEANING|تنظيف
613|OOREDOO|أريد
616|ASC|الأنظمة
617|NAPESCO|نابيسكو
618|KCPC|المعامل
623|HUMANSOFT|هيومن سوفت
624|PHC|التخصيص
627|ENERGYH|بيت الطاقة
630|GFC|امتيازات
631|TAHSSILAT|تحصيلات
633|ABAR|آبار
634|IFAHR|ايفا فنادق
635|CGC|المشتركة
637|PAPCO|النخيل
638|OSOS|أسس
640|UPAC|يوباك
644|MASHAER|مشاعر
645|OULAFUEL|أولى وقود
649|DIGITUS|ديجتس
650|MUBARRAD|مبرد
651|MUNTAZAHAT|منتزهات
652|ATC|التقدم
654|JAZEERA|الجزيرة
655|SOOR|السور
657|FUTUREKID|فيوتشر كيد
701|CATTL|مواشي
806|QIC|قيوين ا
811|VALMORE|فالمور
812|BKIKWT|ب ك تأمين
813|GFH|جي اف اتش
817|INOVEST|إنوفست
821|WARBABANK|بنك وربة
822|STC|أس تي سي
823|MEZZAN|ميزان
824|INTEGRATED|المتكاملة
825|ALMANAR|المنار
826|AZNOULA|شمال الزور
827|BOURSA|البورصة
829|JTC|جي تي سي
830|ALG|الغانم
831|BEYOUT|بيوت
832|ALFTAQA|ألف طاقة
833|TROLLEY|ترولي
2010|SPEC|الخصوصية
2011|MASAKEN|المساكن
2012|DALQANRE|دلقان ع
2014|MIDAN|ميدان
2017|THURAYA|ثريا
2019|AMAR|عمار`;

export const kuwaitStocks = Object.freeze(STOCK_ROWS.trim().split("\n").map((row) => {
  const [code, ticker, name] = row.split("|");
  return Object.freeze({ code, ticker, name });
}));

export function getKuwaitStock(code) {
  return kuwaitStocks.find((stock) => stock.code === String(code ?? "")) ?? null;
}

/** Boursa Kuwait prices can include a tenth of a fils (for example 74.2 fils). */
export function parseSharePriceTenths(value) {
  const text = normalizeDigits(String(value ?? "")).replaceAll("٬", "").replaceAll(",", "").replaceAll("٫", ".").trim();
  if (!/^\d+(?:\.\d)?$/.test(text)) return null;
  const [whole, decimal = ""] = text.split(".");
  const result = Number(whole) * 10 + Number(decimal || 0);
  return Number.isSafeInteger(result) && result > 0 && result <= 100_000_000 ? result : null;
}

export function formatSharePrice(priceTenths) {
  if (!Number.isSafeInteger(priceTenths) || priceTenths < 0) return "—";
  const value = priceTenths / 10;
  return `${value.toLocaleString("ar-KW-u-nu-latn", { minimumFractionDigits: priceTenths % 10 ? 1 : 0, maximumFractionDigits: 1 })} فلس`;
}

export function calculateStockPosition({ quantity, purchasePriceTenths, feesFils = 0, currentPriceTenths } = {}) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100_000_000) return null;
  if (!Number.isSafeInteger(purchasePriceTenths) || purchasePriceTenths <= 0) return null;
  if (!Number.isSafeInteger(feesFils) || feesFils < 0) return null;
  if (!Number.isSafeInteger(currentPriceTenths) || currentPriceTenths <= 0) return null;
  const purchaseValueTenths = quantity * purchasePriceTenths;
  const totalCostTenths = purchaseValueTenths + feesFils * 10;
  const currentValueTenths = quantity * currentPriceTenths;
  if (![purchaseValueTenths, totalCostTenths, currentValueTenths].every(Number.isSafeInteger)) return null;
  const profitLossTenths = currentValueTenths - totalCostTenths;
  const breakEvenPriceTenths = Math.ceil(totalCostTenths / quantity);
  return {
    purchaseValueFils: Math.round(purchaseValueTenths / 10),
    totalCostFils: Math.round(totalCostTenths / 10),
    currentValueFils: Math.round(currentValueTenths / 10),
    profitLossFils: Math.round(profitLossTenths / 10),
    profitLossPercent: totalCostTenths ? profitLossTenths / totalCostTenths * 100 : 0,
    averageCostPriceTenths: breakEvenPriceTenths,
    breakEvenPriceTenths,
    riseNeededPercent: currentPriceTenths < breakEvenPriceTenths ? (breakEvenPriceTenths - currentPriceTenths) / currentPriceTenths * 100 : 0
  };
}

/** Minimum whole shares needed to reach or go below the chosen cost ceiling. */
export function calculateAverageDown({ quantity, purchasePriceTenths, feesFils = 0, buyPriceTenths, targetPriceTenths, additionalFeesFils = 0 } = {}) {
  const inputs = [quantity, purchasePriceTenths, feesFils, buyPriceTenths, targetPriceTenths, additionalFeesFils];
  if (!inputs.every(Number.isSafeInteger) || quantity <= 0 || purchasePriceTenths <= 0 || buyPriceTenths <= 0 || targetPriceTenths <= 0 || feesFils < 0 || additionalFeesFils < 0) return { status: "invalid" };
  const q = BigInt(quantity), target = BigInt(targetPriceTenths), buy = BigInt(buyPriceTenths);
  const cost = q * BigInt(purchasePriceTenths) + BigInt(feesFils) * 10n;
  if (cost <= q * target) return { status: "already_reached", additionalQuantity: 0 };
  if (buy >= target) return { status: "unreachable" };
  const needed = cost + BigInt(additionalFeesFils) * 10n - q * target;
  const gap = target - buy;
  const shares = (needed + gap - 1n) / gap;
  const totalQuantity = q + shares;
  const outlay = shares * buy + BigInt(additionalFeesFils) * 10n;
  const totalCost = cost + outlay;
  if ([shares, totalQuantity, outlay, totalCost].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) return { status: "too_large" };
  return {
    status: "ok", additionalQuantity: Number(shares), totalQuantity: Number(totalQuantity),
    additionalAmountFils: Number((outlay + 9n) / 10n),
    newAveragePriceTenths: Number((totalCost + totalQuantity - 1n) / totalQuantity)
  };
}

export function calculateStockBudget({ quantity, purchasePriceTenths, feesFils = 0, buyPriceTenths, budgetFils, additionalFeesFils = 0 } = {}) {
  if (![quantity, purchasePriceTenths, feesFils, buyPriceTenths, budgetFils, additionalFeesFils].every(Number.isSafeInteger) || quantity <= 0 || purchasePriceTenths <= 0 || buyPriceTenths <= 0 || feesFils < 0 || budgetFils < 0 || additionalFeesFils < 0) return { status: "invalid" };
  const available = BigInt(budgetFils - additionalFeesFils) * 10n;
  if (available < BigInt(buyPriceTenths)) return { status: "insufficient" };
  const shares = available / BigInt(buyPriceTenths);
  const outlay = shares * BigInt(buyPriceTenths) + BigInt(additionalFeesFils) * 10n;
  const totalQuantity = BigInt(quantity) + shares;
  const totalCost = BigInt(quantity) * BigInt(purchasePriceTenths) + BigInt(feesFils) * 10n + outlay;
  if ([shares, outlay, totalQuantity, totalCost].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) return { status: "too_large" };
  const spentFils = Number((outlay + 9n) / 10n);
  return {
    status: "ok", additionalQuantity: Number(shares), spentFils,
    remainingFils: budgetFils - spentFils,
    newAveragePriceTenths: Number((totalCost + totalQuantity - 1n) / totalQuantity)
  };
}
