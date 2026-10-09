import { inferCategory, merchantDefaults, merchantKey, normalizeDigits, parseMoney } from "./finance-core.js";

const OTP = ["otp", "one time", "one-time", "verification code", "security code", "رمز تحقق", "رمز التحقق", "رمز التأكيد", "رمز التفعيل", "رمز الدخول", "كلمة المرور", "كلمة السر", "password"];
const DECLINED = ["declined", "rejected", "unsuccessful", "failed", "insufficient", "مرفوضة", "تم رفض", "رفض", "فشلت", "غير ناجحة", "رصيد غير كاف"];
const REFUND = ["refund", "reversal", "reversed", "استرداد", "استرجاع", "مسترد", "عكس عملية"];
const CARD_PAYMENT = ["card payment", "credit card payment", "payment to your card", "سداد بطاقة", "تسديد بطاقة", "سداد البطاقة", "تسديد البطاقة", "لبطاقة الائتمان", "لبطاقتك الائتمانية",
  // دفعة/تعبئة بطاقة من الحساب: تحويل داخلي، والشراء نفسه يجي بإشعار البطاقة
  "دفعة بطاقة", "دفعه بطاقة", "تعبئة بطاقة", "تعبئه بطاقة", "بطاقة العملات", "دفعة لبطاقة", "دفعة إلى بطاقة", "دفعة الى بطاقة"];

/*
 * صيغ بوبيان المؤكدة من رسائل حقيقية (2026-10-06):
 * 1) إشعار البطاقة على الآيفون، كل حقل بسطر: "KWD 10.000" / "Card Name" / "Merchant" / "1 January 2026 at 9:00 pm"
 * 2) خصم الحساب: "خصم من حساب 1234 مبلغ 1.750 د.ك. باستخدام UTap بجهاز نقاط البيع في @ MERCHANT NAME - -. الرصيد 100.000 د.ك."
 */
export const BOUBYAN_VERIFIED_FORMATS = ["card-notification", "account-debit"];
const CARD_LINE = /\b(?:prepaid|credit|debit|card|visa|mastercard)\b|بطاقة/i;
const AMOUNT_LINE = /^(?:KWD|KD|د\.ك\.?)\s*[\d,]+(?:\.\d{1,3})?$|^[\d,]+(?:\.\d{1,3})?\s*(?:KWD|KD|د\.ك\.?)$/i;
const DATE_LINE = /\d{1,2}\s+[A-Za-z\u0621-\u064A]+\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}/;
const ACCOUNT_DEBIT_MERCHANT = /@\s*(.+?)\s*(?:-\s*-|\.\s*الرصيد|$)/;

export const BANK_FIELDS = ["title", "subtitle", "body"];
export const DEFAULT_FIELD_ORDER = ["title", "subtitle", "body"];
const CARD_PHRASE = /(?:multi\s+currency\s+)?(?:prepaid|credit|debit)(?:\s+card)?|\bcard\b|بطاقة(?:\s+(?:مسبقة\s+الدفع|الائتمان(?:ية)?|الخصم))?/i;
const isPlain = (line) => !AMOUNT_LINE.test(line) && !CARD_LINE.test(line) && !DATE_LINE.test(line) && /[A-Za-zء-ي]/.test(line);

// إشعار البطاقة: مبلغ + نوع البطاقة + التاجر، بأي ترتيب، بسطر واحد أو عدة أسطر.
// fieldOrder: ترتيب الحقول اللي حطها الاختصار (للتاجر = «النص» Body) — يُستخدم لما يتساوى عدد الأسطر.
export function cardNotificationMerchant(text, fieldOrder = DEFAULT_FIELD_ORDER) {
  const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1) {
    const one = lines[0].match(new RegExp(String.raw`^(?:KWD|KD|د\.ك\.?)\s*[\d,]+(?:\.\d{1,3})?\s+(${CARD_PHRASE.source})\s+(.+?)(?:\s+\d{1,2}\s+[A-Za-zء-ي]+\s+\d{4}.*)?$`, "i"));
    return one && /[A-Za-zء-ي]/.test(one[2]) ? one[2].slice(0, 80) : null;
  }
  if (!lines.some((line) => AMOUNT_LINE.test(line))) return null;
  const cardIndex = lines.findIndex((line) => CARD_LINE.test(line) && !AMOUNT_LINE.test(line));
  if (cardIndex < 0) return null;
  const bodyIndex = fieldOrder.indexOf("body");
  if (lines.length === fieldOrder.length && bodyIndex >= 0 && isPlain(lines[bodyIndex])) return lines[bodyIndex].slice(0, 80);
  const merchant = lines.slice(cardIndex + 1).find(isPlain) ?? lines.find(isPlain);
  return merchant ? merchant.slice(0, 80) : null;
}

/*
 * صيغ إضافية تقديرية حتى نطابقها مع رسالة حقيقية (BOUBYAN_FORMATS_VERIFIED = false).
 * لتصحيحها من عينة واحدة: عدّل التعبير هنا وأضف العينة إلى tests/bank-notifications.test.mjs.
 * المجموعة الأولى في كل تعبير هي اسم التاجر.
 */
export const BOUBYAN_FORMATS_VERIFIED = false;
const COUNTRY_END = String.raw`(?=\s+في\s+(?:[A-Z]{3}|الكويت)(?=[\s.،]|$)|\s+بتاريخ|\s+in\s+[A-Z]{3}\b|\s+on\s+\d|[.،]\s|$)`;
export const BOUBYAN_MERCHANT_FORMATS = [
  // خصم KWD 2.900 من بطاقة مسبقة الدفع 1054 من TAP TALABAT في KWT بتاريخ …  (مطابقة لعينة حقيقية)
  new RegExp(String.raw`(?:من|إلى|الى)\s+(?:بطاقة|بطاقتك)(?:\s+(?:مسبقة\s+الدفع|الائتمان(?:ية)?|الخصم(?:\s+المباشر)?|السحب\s+الآلي))?\s+(?:رقم\s+)?[*xX•]*\d+\s+(?:من|لدى|في)\s+(.+?)${COUNTRY_END}`, "i"),
  // Debit KWD 12.500 from card 1234 at SULTAN CENTER in KWT on …  (تقديرية)
  new RegExp(String.raw`\b(?:from|on|using)\s+(?:your\s+)?(?:prepaid\s+|credit\s+|debit\s+)?card\s+(?:ending\s+)?[*xX•]*\d+\s+at\s+(.+?)${COUNTRY_END}`, "i")
];
const WITHDRAWAL = ["atm", "cash withdrawal", "withdrawal", "سحب نقدي", "سحب من", "صراف"];
const SALARY = ["salary", "payroll", "راتب", "الراتب"];
const TRANSFER = ["transfer", "تحويل", "حوالة", "ومض", "wamd"];
const TRANSFER_IN = ["incoming", "received", "إلى حسابك", "الى حسابك", "to your account", "واردة", "وصلك", "تم استلام"];
const TRANSFER_OUT = ["outgoing", "sent", "من حسابك", "from your account", "صادر", "تم تحويل مبلغ", "you transferred"];
// ومض (2026-10-08، عينة حقيقية): «تحويل ومض 23.000 د.ك. من حساب 8002 إلى NAME. الرصيد المتوفر 11.508 د.ك.»
// «من حساب <رقم>» بدون «ـك» = خرج من حسابك؛ ما نعتمدها إذا فيه علامة وارد صريحة.
const FROM_ACCOUNT_NUMBER = /من\s+حساب\s*(?:رقم\s+)?[\d*xX•]{3,24}/;
const DEPOSIT = ["credited", "deposit", "تم إضافة", "تم اضافة", "إيداع", "ايداع", "مبلغ وارد", "received"];
const PURCHASE = ["purchase", "payment at", "paid", "spent", "pos", "knet", "debit", "debited", "charged", "شراء", "دفع", "خصم", "عملية"];

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)`;
const KWD = String.raw`(?:KWD|KD|د\.ك\.?|دينار(?:\s+كويتي)?)`;
const FOREIGN = String.raw`(USD|EUR|GBP|AED|SAR|BHD|QAR|OMR|EGP|INR|TRY|JPY|\$|€|£)`;
const BALANCE_RE = new RegExp(String.raw`(?:الرصيد\s+المتاح|الرصيد\s+المتوفر|الرصيد\s+المتبقي|الرصيد\s+الحالي|الرصيد|available\s+balance|avail\.?\s*bal(?:ance)?\.?|balance)\s*[:\-]?\s*(?:${KWD})?\s*${NUM}(?:\s*${KWD})?`, "i");

const MONTHS = {
  "يناير": 1, "كانون الثاني": 1, "فبراير": 2, "شباط": 2, "مارس": 3, "آذار": 3, "ابريل": 4, "أبريل": 4, "نيسان": 4, "مايو": 5, "أيار": 5,
  "يونيو": 6, "حزيران": 6, "يوليو": 7, "تموز": 7, "اغسطس": 8, "أغسطس": 8, "آب": 8, "سبتمبر": 9, "أيلول": 9, "اكتوبر": 10, "أكتوبر": 10,
  "نوفمبر": 11, "ديسمبر": 12, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

const has = (lower, terms) => terms.some((term) => lower.includes(term));

function prepare(raw) {
  return normalizeDigits(String(raw ?? "")).replaceAll("٫", ".").replaceAll("٬", ",");
}

function findAmount(text) {
  const kwd = [
    new RegExp(`${KWD}\\s*${NUM}(?![\\d.])`, "i"),
    new RegExp(`${NUM}\\s*${KWD}(?![A-Za-z])`, "i")
  ].map((re) => text.match(re)).find(Boolean);
  if (kwd) {
    const fils = parseMoney(kwd[1]);
    return fils && fils <= 1_000_000_000_000 ? { fils } : null;
  }
  const foreign = text.match(new RegExp(`${FOREIGN}\\s*${NUM}`, "i")) ?? text.match(new RegExp(`${NUM}\\s*${FOREIGN}(?![A-Za-z])`, "i"));
  if (foreign) {
    const currency = /^[\d,.]+$/.test(foreign[1]) ? foreign[2] : foreign[1];
    const amount = /^[\d,.]+$/.test(foreign[1]) ? foreign[1] : foreign[2];
    return { foreign: { currency: currency.toUpperCase(), amount } };
  }
  return null;
}

function findDate(text, todayISO) {
  const candidates = [];
  for (const m of text.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)) candidates.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g)) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    candidates.push([year, Number(m[2]), Number(m[1])]);
  }
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[\s\-/.]*([^\s\d\-/.,،]{3,10})[\s\-/.,،]*(\d{4})(?!\d)/g)) {
    const month = MONTHS[m[2].toLowerCase().replace(/[\u064B-\u0652]/g, "")];
    if (month) candidates.push([Number(m[3]), month, Number(m[1])]);
  }
  const today = new Date(`${todayISO}T12:00:00`);
  for (const [y, mo, d] of candidates) {
    const date = new Date(y, mo - 1, d, 12);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) continue;
    const diffDays = (today - date) / 86_400_000;
    if (diffDays < -1 || diffDays > 90) continue;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

function cleanMerchant(value = "") {
  return value
    .split(/\n|[.!،]\s*(?:الرصيد|available balance|balance)|\s+(?:on|using|card|ref|reference|available|avail|balance|bal|approved|successful|successfully|date|بتاريخ|بطاقة|الرصيد|رصيد|المرجع|التاريخ)(?=[\s:.]|$)|\s+في\s+(?:KWT|KUWAIT|الكويت)(?=[\s.]|$)|\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\s+\d{4}-\d{2}-\d{2}|\s+\d{1,2}:\d{2}/i)[0]
    .trim().replace(/[.,،:]+$/, "").slice(0, 80);
}

function findMerchant(text, type, fieldOrder) {
  if (type === "withdrawal") return "سحب نقدي";
  const fromCard = cardNotificationMerchant(text, fieldOrder);
  if (fromCard) return fromCard;
  const fromAccount = text.match(ACCOUNT_DEBIT_MERCHANT);
  if (fromAccount && cleanMerchant(fromAccount[1])) return cleanMerchant(fromAccount[1]);
  for (const format of BOUBYAN_MERCHANT_FORMATS) {
    const match = text.match(format);
    if (match && cleanMerchant(match[1])) return cleanMerchant(match[1]);
  }
  if (type === "transfer_out") {
    const to = text.match(/(?:\bto\b|إلى|الى)\s*[:\-]?\s+(.+)/i);
    const label = /ومض|wamd/i.test(text) ? "تحويل ومض" : "تحويل";
    return `${label}${to ? ` إلى ${cleanMerchant(to[1])}` : ""}`.slice(0, 80);
  }
  if (type === "salary") return "راتب";
  if (type === "deposit" || type === "transfer_in") {
    const from = text.match(/(?:\bfrom\b|من)\s*[:\-]?\s+(.+)/i);
    const sender = from ? cleanMerchant(from[1]) : "";
    return sender ? `إيداع من ${sender}`.slice(0, 80) : "إيداع";
  }
  const at = text.match(/(?:\bat\b|\bfrom\b|لدى|من متجر|التاجر)\s*[:\-]?\s+(.+)/i);
  const viaAt = at && cleanMerchant(at[1]);
  if (viaAt) return viaAt;
  const payTo = text.match(/\b(?:payment|paid|pay)\b[^\n]*?\bto\s+(.+)/i);
  const viaTo = payTo && cleanMerchant(payTo[1]);
  if (viaTo) return viaTo;
  // «دفع خيرية 1.000 د.ك. من حساب 8002» (إشعار حقيقي 2026-10-08): الاسم بين «دفع» والمبلغ، مو «من حساب …».
  const payLabel = text.match(new RegExp(String.raw`(?:^|[\s.])دفع\s+(?!مبلغ|بمبلغ|قيمة)([^\d\n]{2,40}?)\s*(?:${KWD}\s*${NUM}|${NUM}\s*${KWD})`));
  const viaPayLabel = payLabel && cleanMerchant(payLabel[1]);
  if (viaPayLabel) return viaPayLabel;
  const trailing = text.match(new RegExp(`${KWD}\\s*${NUM}\\s+([A-Za-z\u0621-\u064A][^\\n]*)`, "i")) ?? text.match(new RegExp(`${NUM}\\s*${KWD}\\s+([A-Za-z\u0621-\u064A][^\\n]*)`, "i"));
  const viaTrailing = trailing && cleanMerchant(trailing[2]);
  return viaTrailing || "تاجر غير محدد";
}

export function parseBankNotification(raw, { todayISO, fieldOrder = DEFAULT_FIELD_ORDER } = {}) {
  const text = prepare(raw);
  const lower = text.toLowerCase();
  const base = { raw: String(raw ?? ""), type: "unknown", kind: null, amountFils: null, foreign: null, merchant: "", rawMerchant: "", category: "أخرى",
    dateISO: todayISO ?? null, dateAssumed: true, time: null, balanceFils: null, cardLast4: null, cardKind: "", reference: null,
    ignored: false, reason: null, needsManual: false };
  if (!text.trim()) return { ...base, needsManual: true, reason: "empty" };

  if (has(lower, OTP)) return { ...base, type: "otp", ignored: true, reason: "otp" };
  if (has(lower, DECLINED)) return { ...base, type: "declined", ignored: true, reason: "declined" };
  if (has(lower, CARD_PAYMENT)) return { ...base, type: "card_payment", ignored: true, reason: "card_payment" };

  let type = "unknown";
  if (cardNotificationMerchant(text, fieldOrder) && !has(lower, REFUND)) type = "purchase";
  else   if (has(lower, REFUND)) type = "refund";
  else if (has(lower, WITHDRAWAL)) type = "withdrawal";
  else if (has(lower, SALARY)) type = "salary";
  else if (has(lower, TRANSFER)) type = has(lower, TRANSFER_IN) && !has(lower, TRANSFER_OUT) ? "transfer_in"
    : has(lower, TRANSFER_OUT) || (!has(lower, TRANSFER_IN) && FROM_ACCOUNT_NUMBER.test(text)) ? "transfer_out" : "unknown";
  else if (has(lower, DEPOSIT)) type = "deposit";
  else if (has(lower, PURCHASE)) type = "purchase";
  if (type === "unknown") return { ...base, needsManual: true, reason: "unrecognized" };

  const balanceMatch = text.match(BALANCE_RE);
  const balanceFils = balanceMatch ? parseMoney(balanceMatch[1]) : null;
  const withoutBalance = balanceMatch ? text.replace(balanceMatch[0], " ") : text;
  const amount = findAmount(withoutBalance);
  const dateISO = todayISO ? findDate(text, todayISO) : null;
  const timeMatch = text.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?!\d)(?:\s*(am|pm|ص|م)(?![A-Za-z\u0621-\u064A]))?/i);
  if (timeMatch?.[3]) {
    const pm = /^(pm|م)$/i.test(timeMatch[3]);
    let hour = Number(timeMatch[1]) % 12;
    if (pm) hour += 12;
    timeMatch[1] = String(hour);
  }
  // آخر ٤ أرقام من آخر الرقم (المخفي مثل 3678******443995 آخره 3995)، ونفرّق بين البطاقة والحساب
  const accountMatch = text.match(/(?:من|إلى|الى|على)\s+حساب(?:ك)?\s+(?:رقم\s+)?([\d*xX•]{4,24})(?![\d*])/);
  const cardDigits = text.match(/(?:بطاقة|بطاقتك|card|visa|mastercard|ماستر)[^\d\n]{0,20}([\d*xX•]{4,24})(?![\d*])/i) ?? text.match(/[*xX•]{2,}\s*(\d{4})(?!\d)/);
  const cardMatch = cardDigits ?? accountMatch;
  const cardKind = cardDigits ? "card" : accountMatch ? "account" : "";
  const lastFour = (token) => (String(token).match(/(\d+)(?!.*\d)/)?.[1] ?? "").slice(-4) || null;
  const refMatch = text.match(/(?:reference|ref|auth(?:orization)?(?:\s+code)?|رقم المرجع|المرجع|رقم العملية)\s*(?:no\.?|#)?\s*[:#-]?\s*([A-Za-z0-9]{5,20})/i);

  const merchantRaw = findMerchant(withoutBalance, type, fieldOrder);
  const income = ["refund", "salary", "deposit", "transfer_in"].includes(type);
  const result = {
    ...base, type, kind: income ? "income" : "expense", merchant: merchantRaw, rawMerchant: merchantRaw,
    dateISO: dateISO ?? todayISO ?? null, dateAssumed: !dateISO,
    time: timeMatch ? `${timeMatch[1].padStart(2, "0")}${timeMatch[2]}` : null,
    balanceFils: balanceFils && balanceFils > 0 ? balanceFils : null,
    cardLast4: cardMatch ? lastFour(cardMatch[1]) : null,
    cardKind: cardMatch ? cardKind : "",
    reference: refMatch ? refMatch[1].toUpperCase() : null
  };
  if (!amount) return { ...result, needsManual: true, reason: "no_amount" };
  if (amount.foreign) return { ...result, needsManual: true, reason: "foreign", foreign: amount.foreign };
  result.amountFils = amount.fils;

  if (type === "salary") result.category = "راتب";
  else if (type === "refund") { result.merchant = `استرداد ${merchantRaw}`.slice(0, 80); result.category = inferCategory(`${merchantRaw} ${text}`); }
  else if (income) result.category = "أخرى";
  else if (type === "withdrawal" || type === "transfer_out") result.category = "أخرى";
  else result.category = merchantDefaults(merchantRaw, inferCategory(`${merchantRaw} ${text}`)).category;
  return result;
}

// سطر التاريخ اللي يكتبه الاختصار قبل كل إشعار: ISO أو تنسيق الآيفون الافتراضي (عربي أو إنجليزي).
const STAMP_TIME = String.raw`(?:[T ,،]*(?:at|الساعة|في)?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[AaPp]\.?\s?[Mm]\.?|ص|م)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?`;
const STAMP_DATE = String.raw`(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{1,2}\s+[^\s\d,،:]{3,12}\.?,?\s+\d{4}|[A-Za-zء-ي]{3,12}\.?\s+\d{1,2},?\s+\d{4})`;
// اسم اليوم اللي يحطه الآيفون قبل التاريخ («Tuesday, October 6, 2026» أو «الثلاثاء، ٦ أكتوبر ٢٠٢٦»)
const STAMP_WEEKDAY = /^[A-Za-zء-ي]{3,12}\.?\s*[,،]\s*/;
const STAMP_LINE = new RegExp(String.raw`^\s*${STAMP_DATE}${STAMP_TIME}\s*$`, "i");

export function parseStampDate(line) {
  const text = normalizeDigits(String(line ?? ""))
    .replace(/[‎‏؜]/g, "")
    .trim()
    .replace(STAMP_WEEKDAY, "")
    .trim();
  if (!STAMP_LINE.test(text)) return null;
  let y, m, d;
  let match;
  if ((match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [y, m, d] = [match[1], match[2], match[3]].map(Number);
  else if ((match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3].length === 2 ? `20${match[3]}` : match[3])];
  else if ((match = text.match(/^(\d{1,2})\s+([^\s\d,،:.]+)\.?,?\s+(\d{4})/))) [d, m, y] = [Number(match[1]), MONTHS[match[2].toLowerCase()], Number(match[3])];
  else if ((match = text.match(/^([A-Za-zء-ي]+)\.?\s+(\d{1,2}),?\s+(\d{4})/))) [m, d, y] = [MONTHS[match[1].toLowerCase()], Number(match[2]), Number(match[3])];
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// وقت سطر الطابع بنظام 24 ساعة («HH:mm»)، أو null لو الطابع بلا وقت. «٨:٠٦ م» و«8:06 PM» تصير 20:06، و«12:05 AM» تصير 00:05.
export function parseStampTime(line) {
  const text = normalizeDigits(String(line ?? ""))
    .replace(/[‎‏؜]/g, "")
    .trim()
    .replace(STAMP_WEEKDAY, "")
    .trim();
  if (!STAMP_LINE.test(text)) return null;
  const clock = /(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?/.exec(text);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2]);
  const meridiem = /^\s*(?:([AaPp])\.?\s?[Mm]\.?|(ص|م))/.exec(text.slice(clock.index + clock[0].length));
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem[1] ? /[Pp]/.test(meridiem[1]) : meridiem[2] === "م";
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// وقت الإشعار نفسه جاي من المحلل مضغوط («1435»): نرجّعه «14:35»، أو "" لو ما فيه وقت صالح
export function timeFromCompact(value) {
  const match = /^([01]\d|2[0-3])([0-5]\d)$/.exec(String(value ?? ""));
  return match ? `${match[1]}:${match[2]}` : "";
}

const isStampLine = (line) => parseStampDate(line) !== null;

/*
 * يقسم ملف الاختصار إلى إشعارات. سطر التاريخ يبدأ إشعاراً جديداً إذا كان أول الملف، أو بعد سطر فاضي،
 * أو إذا بعده نص فعلي قبل سطر التاريخ اللي يليه (حتى ما ينفصل سطر تاريخ داخل إشعار بوبيان نفسه).
 */
// سطر فيه إشعار كامل لحاله (مبلغ + تاجر)، مثل إشعارات «خصم من حساب … في @ TAJER». يُستخدم لما يلصق المستخدم إشعارين بدون سطر فاضي.
const SELF_CONTAINED = new RegExp(String.raw`(?:${KWD}\s*${NUM}|${NUM}\s*${KWD})`, "i");
function looksSelfContained(line) {
  const text = line.trim();
  return text.length >= 24 && SELF_CONTAINED.test(text) && /@|\bat\b|لدى|من\s+حساب|باستخدام|from\s+card|نقاط\s+البيع/i.test(text);
}

function isBalanceTail(chunk) {
  const text = chunk.trim();
  return !looksSelfContained(text) && text.length <= 60 && /الرصيد|رصيد|balance|avail/i.test(text);
}

// سطر مبلغ لحاله في أول إشعار البطاقة («KWD 5.800» أو «USD 12.99»): يبدأ إشعاراً جديداً لو قبله إشعار فيه مبلغ (F9)
const CARD_AMOUNT_LINE = /^(?:[A-Z]{3}|KD|د\.ك\.?)\s*[\d,]+(?:\.\d{1,3})?$|^[\d,]+(?:\.\d{1,3})?\s*(?:[A-Z]{3}|KD|د\.ك\.?)$/;
const KWD_AMOUNT = new RegExp(String.raw`(?:${KWD}\s*${NUM}|${NUM}\s*${KWD})`, "i");
const FOREIGN_AMOUNT = /\b[A-Z]{3}\s*\d[\d,]*(?:\.\d+)?\b|\b\d[\d,]*(?:\.\d+)?\s*[A-Z]{3}\b/;
const hasAmount = (chunk) => {
  const text = normalizeDigits(chunk).replaceAll("٫", ".");
  return KWD_AMOUNT.test(text) || FOREIGN_AMOUNT.test(text);
};

function splitRuns(part) {
  const lines = part.split("\n");
  const starts = lines.map((line) => looksSelfContained(line) || CARD_AMOUNT_LINE.test(line.trim()));
  if (starts.filter(Boolean).length < 2) return [part];
  const runs = [];
  let current = [];
  let currentHasAmount = false;
  lines.forEach((line, index) => {
    if (starts[index] && currentHasAmount && current.some((item) => item.trim())) { runs.push(current.join("\n")); current = []; currentHasAmount = false; }
    current.push(line);
    if (starts[index]) currentHasAmount = true;
  });
  runs.push(current.join("\n"));
  return runs;
}

/* بعد التقسيم بالأسطر الفاضية: كل إشعار لازم يكون فيه مبلغ واحد. سطر عنوان بلا أرقام («بنك بوبيان»)
   يلتصق بالإشعار اللي بعده، وتكملة بلا مبلغ (اسم التاجر بعد سطر فاضي أو «الرصيد المتبقي…») تلتصق باللي قبله،
   فما يطلع جزء ناقص كرسالة «ما تعرفت عليها» (F9). */
function groupNotifications(chunks) {
  const groups = [];
  chunks.forEach((chunk, index) => {
    const last = groups[groups.length - 1];
    if (last && isBalanceTail(chunk)) { last.text += `\n${chunk}`; return; }
    if (hasAmount(chunk)) {
      if (last && !last.amount) { last.text += `\n${chunk}`; last.amount = true; }
      else groups.push({ text: chunk, amount: true });
      return;
    }
    const next = chunks[index + 1];
    const header = chunk.length <= 40 && !/\d/.test(normalizeDigits(chunk)) && next && hasAmount(next);
    if (last && !last.amount) last.text += `\n${chunk}`;
    else if (last && !header) last.text += `\n${chunk}`;
    else groups.push({ text: chunk, amount: false });
  });
  return groups.map((group) => group.text);
}

export function splitBankMessages(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const lines = text.split("\n");
  const stamps = lines.map(isStampLine);
  const byBlankLines = (chunk) => groupNotifications(chunk.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean))
    .flatMap(splitRuns).map((item) => item.trim());
  if (!stamps.some(Boolean)) return byBlankLines(text).filter((part) => part.length >= 8);
  const contentAfter = (i) => {
    let content = "";
    for (let j = i + 1; j < lines.length && !stamps[j]; j += 1) content += lines[j].trim();
    return content.length >= 12;
  };
  const parts = [];
  let current = [];
  lines.forEach((line, i) => {
    // سطر التاريخ يبدأ إشعاراً فقط إذا جاء بعده نص مباشرة؛ وإلا فهو آخر سطر في إشعار البطاقة نفسه.
    const starts = stamps[i] && (i === 0 || !lines[i - 1].trim() || (Boolean(lines[i + 1]?.trim()) && contentAfter(i)));
    if (starts && current.some((item) => item.trim())) { parts.push(current.join("\n")); current = []; }
    current.push(line);
  });
  parts.push(current.join("\n"));
  return parts.flatMap((part) => {
    const trimmed = part.trim();
    const partLines = trimmed.split("\n");
    // جزء بلا سطر تاريخ في أوله (ملف قديم أو لصق) يُقسم بالأسطر الفاضية وبالإشعارات المكتملة
    if (!isStampLine(partLines[0])) return byBlankLines(trimmed);
    // الطابع في أول الجزء يخص أول إشعار فقط؛ الباقي يُقسم عادياً وإلا التصق الكل برسالة واحدة
    // («الرصيد المتبقي …» بعد سطر فاضي تكملة لنفس الإشعار — يتكفل فيها groupNotifications)
    const chunks = byBlankLines(partLines.slice(1).join("\n")).filter((item) => item.length);
    if (!chunks.length) return [trimmed];
    return chunks.map((chunk, index) => (index === 0 ? `${partLines[0]}\n${chunk}` : chunk));
  }).filter((part) => splitStamp(part).body.length >= 8);
}

// يفصل سطر التاريخ عن نص الإشعار، فيُقرأ النص وحده ويُؤرخ بوقت وصوله.
export function splitStamp(message) {
  const text = String(message ?? "").trim();
  const [first, ...rest] = text.split("\n");
  const stampISO = parseStampDate(first);
  return stampISO ? { stampISO, stampTime: parseStampTime(first), body: rest.join("\n").trim() } : { stampISO: null, stampTime: null, body: text };
}

/* بصمة الإشعار: الأساس (تاريخ + مبلغ + تاجر) للتشابه، والكاملة تضيف النوع والرصيد بعد العملية والوقت
   حتى ما ينشال شراءان حقيقيان بنفس المبلغ، أو شراء واسترداده بنفس اليوم. */
export function notificationFingerprints(notification) {
  const base = `${notification.dateISO}|${notification.amountFils}|${merchantKey(notification.rawMerchant || notification.merchant)}`;
  const distinctive = Boolean(notification.reference || notification.balanceFils || notification.time);
  const full = notification.reference
    ? `ref|${notification.reference}`
    : `${base}|${notification.type ?? ""}|${notification.kind ?? ""}|${notification.balanceFils ?? ""}|${notification.time ?? ""}`;
  return { base, full, distinctive };
}

export const NOTIFICATION_REASONS = {
  otp: "رمز تحقق — تجاهلته",
  declined: "عملية مرفوضة — ما أضفتها",
  card_payment: "تسديد بطاقة — يُستبعد حتى ما ينحسب الشراء مرتين",
  foreign: "عملة أجنبية — أدخل المبلغ بالدينار يدوياً",
  no_amount: "ما لقيت مبلغاً واضحاً",
  unrecognized: "ما تعرفت على نوع العملية",
  empty: "النص فارغ"
};

export const NOTIFICATION_TYPE_LABELS = {
  purchase: "شراء", withdrawal: "سحب نقدي", transfer_out: "تحويل صادر", transfer_in: "تحويل وارد",
  deposit: "إيداع", salary: "راتب", refund: "استرداد"
};
