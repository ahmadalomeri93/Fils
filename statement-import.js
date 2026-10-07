import { formatMoney, inferCategory, merchantDefaults, merchantKey, normalizeDigits, parseMoney } from "./finance-core.js";

// تحويلات داخلية ودفعات البطاقات: ما هي صرف جديد، والشراء نفسه يجي من كشف البطاقة
const excludedText = /\b(?:transfer|own account|between accounts|credit card payment|card payment|salary|refund|reversal)\b|تحويل|بين حساب|سداد بطاقة|تسديد بطاقة|دفعة بطاقة|دفعه بطاقة|دفعة لبطاقة|دفعة (?:إلى|الى) بطاقة|تعبئة بطاقة|تعبئه بطاقة|بطاقة العملات|راتب|استرداد|عكس قيد/i;
const debitType = /\b(?:debit|withdrawal|withdraw|purchase|payment|dr)\b|مدين|خصم|سحب|شراء|دفع/i;
const creditType = /\b(?:credit|deposit|salary|refund|cr)\b|دائن|إيداع|ايداع|راتب|استرداد/i;

function normalizeHeader(value = "") {
  return normalizeDigits(String(value).replace(/^\uFEFF/, ""))
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[\s_./-]+/g, " ")
    .trim();
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { cells.push(cell.trim()); cell = ""; }
    else cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function detectDelimiter(text, filename) {
  if (/\.tsv$/i.test(filename)) return "\t";
  const sample = text.split(/\r?\n/).slice(0, 8).join("\n");
  const counts = [",", ";", "\t"].map((delimiter) => {
    let quoted = false;
    let count = 0;
    for (let index = 0; index < sample.length; index += 1) {
      if (sample[index] === '"') quoted = !quoted;
      else if (sample[index] === delimiter && !quoted) count += 1;
    }
    return { delimiter, count };
  }).sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].delimiter : ",";
}

function parseDate(value) {
  const text = normalizeDigits(String(value ?? "")).trim();
  if (!text) return "";
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})/);
  let year, month, day;
  if (iso) [, year, month, day] = iso;
  else if (compact) [, year, month, day] = compact;
  else {
    const local = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (!local) return "";
    const [, first, second, yyyy] = local;
    year = yyyy;
    if (Number(first) > 12) { day = first; month = second; }
    else if (Number(second) > 12) { month = first; day = second; }
    else { day = first; month = second; }
  }
  const y = Number(year), m = Number(month), d = Number(day);
  const date = new Date(y, m - 1, d, 12);
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseAmount(value) {
  let text = normalizeDigits(String(value ?? "")).trim();
  if (!text || /^[-–—]+$/.test(text)) return { amountFils: 0, negative: false, invalid: false };
  const negative = /^\s*[-−]/.test(text) || /^\s*\(/.test(text) || /(?:^|[^\d])[-−]\s*\d/.test(text);
  text = text.replace(/[()]/g, "").replace(/\b(?:KWD|KD)\b|د\.ك|دينار/gi, "").replace(/[+−-]/g, "").replaceAll("٫", ".").replaceAll("٬", "").trim();
  // أكثر من ٣ منازل عشرية ما ينقص بصمت: الصف يُرفض ويُعد غير مقروء
  const match = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return { amountFils: 0, negative, invalid: false };
  if (/\.\d{4,}/.test(match[0])) return { amountFils: 0, negative, invalid: true };
  const amountFils = parseMoney(match[0]);
  return { amountFils: Number.isSafeInteger(amountFils) ? amountFils : 0, negative, invalid: amountFils === null };
}

function monthStartISO(todayISO, monthsBack = 11) {
  const [year, month] = todayISO.split("-").map(Number);
  const date = new Date(year, month - 1 - monthsBack, 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function headerIndex(headers, aliases) {
  const index = headers.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
  return index < 0 ? -1 : index;
}

function parseCSVRows(text, filename) {
  const delimiter = detectDelimiter(text, filename);
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).map((line) => splitDelimitedLine(line, delimiter));
}

function ofxValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([^\\r\\n<]+)`, "i"));
  return match?.[1]?.trim().replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">") ?? "";
}

function parseOFXRows(text) {
  return [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi)].map((match) => {
    const block = match[1];
    return [ofxValue(block, "DTPOSTED"), ofxValue(block, "NAME") || ofxValue(block, "PAYEE"), ofxValue(block, "TRNAMT"), ofxValue(block, "TRNTYPE"), ofxValue(block, "MEMO")];
  });
}

/* مطابقة التاجر بدون ترتيب الكلمات: كشف PDF يعيد ترتيب أجزاء الوصف، فنقارن مجموعة الكلمات.
   نسمح بكلمة ناقصة أو مقطوعة (الوصف يُقص عند ٨٠ حرفاً عند الحفظ). */
function merchantTokens(text) {
  return merchantKey(text).split(/\s+/).filter(Boolean);
}

/* فرق المسافات وحده ما يغيّر الوصف: «Ooredoo-66341327 بنك» و«Ooredoo-66341327بنك» نفس العملية (8 من 9 «مكررة» كانت كذا). */
const squashed = (text) => merchantKey(text).replace(/\s+/g, "");

export function sameMerchantWords(a, b) {
  const first = merchantTokens(a);
  const second = merchantTokens(b);
  if (!first.length || !second.length) return false;
  const squashedFirst = squashed(a);
  if (squashedFirst && squashedFirst === squashed(b)) return true;
  const counts = new Map();
  for (const token of second) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of first) {
    const left = counts.get(token) ?? 0;
    if (left > 0) { counts.set(token, left - 1); shared += 1; }
  }
  const longest = Math.max(first.length, second.length);
  return shared >= Math.max(1, Math.ceil(longest * 0.7));
}

/* فهرس العمليات المحفوظة حسب التاريخ+المبلغ. كل عملية محفوظة تُطابق صفاً واحداً فقط،
   فعمليتان حقيقيتان بنفس اليوم والمبلغ تبقى الثانية جديدة بدل ما تنشال كمكرر. */
function existingIndex(existingTransactions = []) {
  const map = new Map();
  for (const item of existingTransactions) {
    if (!item || item.kind === "income") continue;
    const key = `${item.date}|${item.amountFils}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ item, used: false });
  }
  return map;
}

function matchExisting(index, { date, amountFils, balanceFils, rawMerchant }) {
  const entries = index.get(`${date}|${amountFils}`);
  if (!entries?.length) return "new";
  const free = entries.filter((entry) => !entry.used);
  const byBalance = balanceFils
    ? free.find((entry) => entry.item.balanceAfterFils === balanceFils)
    : null;
  const match = byBalance ?? free.find((entry) => sameMerchantWords(entry.item.rawMerchant || entry.item.merchant, rawMerchant));
  if (match) { match.used = true; return "duplicate"; }
  // نفس التاريخ والمبلغ والرصيد بعد العملية = نفس الحركة، حتى لو الملف يذكرها مرتين
  if (balanceFils && entries.some((entry) => entry.item.balanceAfterFils === balanceFils)) return "duplicate";
  if (!free.length) return "new";
  return "possible";
}

function buildCandidate({ date, description, amountFils, balanceFils, index }) {
  const merchantText = description.replace(/\s+/g, " ").trim().slice(0, 140);
  const learned = merchantDefaults(merchantText, inferCategory(merchantText));
  const merchant = learned.merchant || merchantText || "تاجر غير محدد";
  const rawMerchant = merchantText || merchant;
  // الرصيد بعد العملية يميّز صفين بنفس اليوم والمبلغ (أعلى من ترتيب كلمات الوصف)
  const fingerprint = balanceFils
    ? `${date}|${amountFils}|bal:${balanceFils}`
    : `${date}|${amountFils}|${merchantKey(rawMerchant)}`;
  const verdict = matchExisting(index, { date, amountFils, balanceFils, rawMerchant });
  return {
    date, amountFils, merchant, rawMerchant, category: learned.category || "أخرى", kind: "expense",
    reviewed: true, source: "bank-statement", fingerprint,
    balanceAfterFils: balanceFils || null,
    possibleDuplicate: verdict === "possible",
    duplicate: verdict === "duplicate"
  };
}

/** Parse a local CSV/TSV or OFX/QFX bank statement into reviewed expense candidates. */
export function parseBankStatement({ text, filename = "statement.csv", todayISO, existingTransactions = [], maxRows = 12000 } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("الملف فاضي أو تعذرت قراءته.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayISO ?? "")) throw new Error("تاريخ التحليل غير صالح.");
  if (text.length > 12_000_000) throw new Error("حجم الكشف أكبر من الحد المسموح (12 ميغابايت).");

  const extension = filename.toLowerCase().split(".").pop();
  let rows, dateIndex, descriptionIndex, amountIndex, debitIndex, creditIndex, typeIndex, memoIndex, balanceIndex = -1;
  if (["ofx", "qfx"].includes(extension)) {
    rows = parseOFXRows(text);
    dateIndex = 0; descriptionIndex = 1; amountIndex = 2; typeIndex = 3; memoIndex = 4;
    if (!rows.length) throw new Error("ما لقيت عمليات بصيغة OFX داخل الملف.");
  } else if (["csv", "tsv", "txt"].includes(extension)) {
    rows = parseCSVRows(text, filename);
    const dateAliases = ["date", "transaction date", "posted date", "booking date", "timestamp", "تاريخ العملية", "تاريخ القيد", "التاريخ"];
    const descriptionAliases = ["description", "details", "narrative", "merchant", "transaction details", "البيان", "الوصف", "تفاصيل العملية", "تفاصيل"];
    const amountAliases = ["amount", "transaction amount", "المبلغ", "قيمة العملية"];
    const debitAliases = ["debit", "withdrawal", "withdraw", "مدين", "خصم", "السحب"];
    const creditAliases = ["credit", "deposit", "دائن", "إيداع", "ايداع"];
    const typeAliases = ["type", "transaction type", "dr cr", "نوع العملية", "نوع الحركة"];
    let headerRow = -1;
    for (let index = 0; index < Math.min(rows.length, 12); index += 1) {
      const headers = rows[index].map(normalizeHeader);
      const date = headerIndex(headers, dateAliases);
      const description = headerIndex(headers, descriptionAliases);
      const amount = headerIndex(headers, amountAliases);
      const debit = headerIndex(headers, debitAliases);
      const credit = headerIndex(headers, creditAliases);
      if (date >= 0 && description >= 0 && (amount >= 0 || debit >= 0 || credit >= 0)) {
        headerRow = index;
        dateIndex = date; descriptionIndex = description; amountIndex = amount; debitIndex = debit; creditIndex = credit;
        typeIndex = headerIndex(headers, typeAliases);
        memoIndex = headerIndex(headers, ["memo", "reference", "ملاحظات", "مرجع"]);
        balanceIndex = headerIndex(headers, ["balance", "running balance", "closing balance", "الرصيد", "الرصيد بعد العملية", "رصيد"]);
        break;
      }
    }
    if (headerRow < 0) throw new Error("ما تعرفت على أعمدة الكشف. نحتاج تاريخ العملية والبيان والمبلغ أو المدين/الدائن.");
    rows = rows.slice(headerRow + 1);
  } else {
    throw new Error("الصيغ المدعومة: CSV وTSV وOFX وQFX. نزّل كشف العمليات كملف جدولي من البنك.");
  }

  const cutoffISO = monthStartISO(todayISO, 11);
  const totals = { sourceRows: rows.length, invalidRows: 0, outOfRange: 0, credits: 0, transfers: 0, transfersFils: 0, duplicates: 0, possibleDuplicates: 0, repeatedInFile: 0 };
  const candidates = [];
  const seen = new Set();
  const seenNoBalance = new Set();
  const index = existingIndex(existingTransactions);
  for (const row of rows.slice(0, maxRows)) {
    const date = parseDate(row[dateIndex]);
    const description = [row[descriptionIndex], memoIndex >= 0 ? row[memoIndex] : ""].filter(Boolean).join(" ").trim();
    if (!date || !description) { totals.invalidRows += 1; continue; }
    if (date < cutoffISO || date > todayISO) { totals.outOfRange += 1; continue; }

    let amountFils = 0;
    let isDebit = false;
    let isCredit = false;
    let invalidAmount = false;
    if (debitIndex >= 0 || creditIndex >= 0) {
      const debitValue = debitIndex >= 0 ? parseAmount(row[debitIndex]) : { amountFils: 0 };
      const creditValue = creditIndex >= 0 ? parseAmount(row[creditIndex]) : { amountFils: 0 };
      invalidAmount = Boolean(debitValue.invalid || creditValue.invalid);
      const debit = debitValue.amountFils;
      const credit = creditValue.amountFils;
      if (debit > 0 && credit > 0) { totals.invalidRows += 1; continue; }
      if (debit > 0) { amountFils = debit; isDebit = true; }
      else if (credit > 0) { amountFils = credit; isCredit = true; }
    }
    if (!amountFils && amountIndex >= 0) {
      const parsed = parseAmount(row[amountIndex]);
      invalidAmount = invalidAmount || Boolean(parsed.invalid);
      amountFils = parsed.amountFils;
      isDebit = parsed.negative || debitType.test(String(row[typeIndex] ?? ""));
      isCredit = creditType.test(String(row[typeIndex] ?? ""));
    }
    if (invalidAmount || !amountFils) { totals.invalidRows += 1; continue; }
    if (isCredit && !isDebit) { totals.credits += 1; continue; }
    if (!isDebit) { totals.invalidRows += 1; continue; }
    // دفعات البطاقة والتحويلات مستبعدة من الصرف، ونجمع مبلغها حتى تبين بالمعاينة (F2)
    if (excludedText.test(description)) { totals.transfers += 1; totals.transfersFils += amountFils; continue; }

    const balanceFils = balanceIndex >= 0 ? parseAmount(row[balanceIndex]).amountFils : 0;
    const candidate = buildCandidate({ date, description, amountFils, balanceFils, index });
    /* مع عمود الرصيد: نفس التاريخ والمبلغ والرصيد = نفس الحركة. بدونه: الصف المتكرر داخل الملف الواحد
       شراء حقيقي (TALABAT 5.800 مرتين)، والمقارنة بالموجود عندك تتم بالعدد: M في الملف و N عندك → نضيف max(0, M−N). */
    if (candidate.duplicate || (balanceFils && seen.has(candidate.fingerprint))) { totals.duplicates += 1; continue; }
    if (balanceFils) seen.add(candidate.fingerprint);
    else {
      const repeat = `${date}|${amountFils}|${merchantKey(candidate.rawMerchant)}`;
      if (seenNoBalance.has(repeat)) totals.repeatedInFile += 1;
      seenNoBalance.add(repeat);
    }
    delete candidate.duplicate;
    if (candidate.possibleDuplicate) totals.possibleDuplicates += 1;
    candidates.push(candidate);
  }
  if (rows.length > maxRows) totals.invalidRows += rows.length - maxRows;
  if (!candidates.length && totals.duplicates === 0) throw new Error("ما لقيت مصروفات جديدة خلال آخر 12 شهر. تأكد من نوع الملف والفترة.");
  candidates.sort((a, b) => a.date.localeCompare(b.date) || a.merchant.localeCompare(b.merchant));
  /* صفوف «قد تكون مكررة» تبقى بالقائمة لكن ما تنحسب بالعدد والمجموع والفترة؛ المستخدم هو اللي يعلّم اللي يبي يضيفه (v35) */
  const counted = candidates.filter((item) => !item.possibleDuplicate);
  return {
    transactions: candidates,
    stats: {
      ...totals,
      newCount: counted.length,
      totalFils: counted.reduce((sum, item) => sum + item.amountFils, 0),
      possibleFils: candidates.filter((item) => item.possibleDuplicate).reduce((sum, item) => sum + item.amountFils, 0),
      startDate: counted[0]?.date ?? "",
      endDate: counted.at(-1)?.date ?? "",
      hasBalanceColumn: balanceIndex >= 0,
      cutoffISO
    }
  };
}

function monthKey(date) { return date.slice(0, 7); }

function addMonths(dateISO, amount) {
  const [year, month] = dateISO.split("-").map(Number);
  const date = new Date(year, month - 1 + amount, 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-KW-u-nu-latn", { month: "short", year: "2-digit" }).format(new Date(year, month - 1, 1, 12));
}

/** Summarize observed transactions; never infer personality or diagnose intent. */
export function analyzeSpendingBehavior(transactions = [], { todayISO, salaryDay = 25 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayISO ?? "")) return null;
  const fromISO = monthStartISO(todayISO, 11);
  const expenses = transactions.filter((item) => item?.kind === "expense" && item.reviewed !== false && item.amountFils > 0 && item.date >= fromISO && item.date <= todayISO);
  const monthKeys = Array.from({ length: 12 }, (_, index) => monthKey(addMonths(fromISO, index)));
  const monthTotals = new Map(monthKeys.map((key) => [key, 0]));
  const categoryTotals = new Map();
  const categoryMonths = new Map();
  const merchantMonths = new Map();
  const payCycleTotals = { firstWeek: 0, later: 0 };
  const weekDayTotals = new Map();
  for (const item of expenses) {
    const key = monthKey(item.date);
    if (monthTotals.has(key)) monthTotals.set(key, monthTotals.get(key) + item.amountFils);
    const category = item.category || "أخرى";
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + item.amountFils);
    if (!categoryMonths.has(category)) categoryMonths.set(category, new Map(monthKeys.map((month) => [month, 0])));
    const categoryMonthTotals = categoryMonths.get(category);
    if (categoryMonthTotals.has(key)) categoryMonthTotals.set(key, categoryMonthTotals.get(key) + item.amountFils);
    const merchant = (item.rawMerchant || item.merchant || "").trim();
    const merchantKeyValue = merchantKey(merchant);
    if (merchantKeyValue) {
      if (!merchantMonths.has(merchantKeyValue)) merchantMonths.set(merchantKeyValue, { merchant: item.merchant || merchant, months: new Set(), count: 0, totalFils: 0, amounts: [] });
      const record = merchantMonths.get(merchantKeyValue);
      record.months.add(key); record.count += 1; record.totalFils += item.amountFils; record.amounts.push(item.amountFils);
    }
    const [year, month, day] = item.date.split("-").map(Number);
    const transactionDate = new Date(year, month - 1, day, 12);
    weekDayTotals.set(transactionDate.getDay(), (weekDayTotals.get(transactionDate.getDay()) ?? 0) + item.amountFils);
    const paydayFor = (baseYear, monthIndex) => {
      const safeDay = Math.min(Math.max(salaryDay, 1), new Date(baseYear, monthIndex + 1, 0, 12).getDate());
      return new Date(baseYear, monthIndex, safeDay, 12);
    };
    let payday = paydayFor(year, month - 1);
    if (transactionDate < payday) payday = paydayFor(year, month - 2);
    const daysAfterPayday = Math.floor((transactionDate - payday) / 86_400_000);
    if (daysAfterPayday >= 0 && daysAfterPayday < 7) payCycleTotals.firstWeek += item.amountFils;
    else payCycleTotals.later += item.amountFils;
  }

  const totalFils = expenses.reduce((sum, item) => sum + item.amountFils, 0);
  // الشهر الحالي ناقص: ما يدخل بالمتوسط ولا بمقارنة آخر 3 أشهر حتى ما نقول «انخفض» وهو ما خلص
  const [todayYear, todayMonth, todayDay] = todayISO.split("-").map(Number);
  const partialMonthKey = todayDay === new Date(todayYear, todayMonth, 0, 12).getDate() ? null : monthKey(todayISO);
  const completeKeys = monthKeys.filter((key) => key !== partialMonthKey);
  const completeTotalFils = completeKeys.reduce((sum, key) => sum + (monthTotals.get(key) ?? 0), 0);
  const activeMonths = completeKeys.filter((key) => (monthTotals.get(key) ?? 0) > 0).length;
  const categories = [...categoryTotals.entries()].map(([name, amountFils]) => ({ name, amountFils, sharePercent: totalFils ? amountFils / totalFils * 100 : 0 })).sort((a, b) => b.amountFils - a.amountFils);
  const merchants = [...merchantMonths.values()].map((item) => ({
    merchant: item.merchant, months: item.months.size, count: item.count, totalFils: item.totalFils,
    averagePerRecordedMonthFils: Math.round(item.totalFils / item.months.size),
    repeatedAmount: item.amounts.length >= 3 && Math.max(...item.amounts) - Math.min(...item.amounts) <= Math.max(...item.amounts) * 0.08
  })).filter((item) => item.months >= 3 && item.count >= 3).sort((a, b) => b.totalFils - a.totalFils).slice(0, 5);
  const monthly = monthKeys.map((key) => ({ month: key, label: monthLabel(key), totalFils: monthTotals.get(key) ?? 0, partial: key === partialMonthKey }));
  const peakMonth = [...monthly].filter((item) => !item.partial).sort((a, b) => b.totalFils - a.totalFils)[0] ?? null;
  const completeMonthly = monthly.filter((item) => !item.partial);
  const recent3 = completeMonthly.slice(-3).reduce((sum, item) => sum + item.totalFils, 0);
  const previous3 = completeMonthly.slice(-6, -3).reduce((sum, item) => sum + item.totalFils, 0);
  const trendPercent = previous3 > 0 ? ((recent3 - previous3) / previous3) * 100 : null;
  const categoryChanges = [...categoryMonths.entries()].map(([name, totals]) => {
    const previous = completeMonthly.slice(-6, -3).reduce((sum, item) => sum + (totals.get(item.month) ?? 0), 0);
    const recent = completeMonthly.slice(-3).reduce((sum, item) => sum + (totals.get(item.month) ?? 0), 0);
    const previousAverageFils = Math.round(previous / 3);
    const recentAverageFils = Math.round(recent / 3);
    return { name, previousAverageFils, recentAverageFils, changePercent: previous > 0 ? (recent - previous) / previous * 100 : null };
  }).filter((item) => item.changePercent >= 25 && item.previousAverageFils >= 10_000 && item.recentAverageFils >= 20_000)
    .sort((a, b) => b.changePercent - a.changePercent).slice(0, 3);
  const firstWeekPercent = totalFils ? payCycleTotals.firstWeek / totalFils * 100 : 0;
  const peakShare = peakMonth && completeTotalFils ? peakMonth.totalFils / completeTotalFils * 100 : 0;
  const recordedDates = expenses.map((item) => item.date).sort();
  const insights = [];
  if (categories[0]) insights.push(`أكبر فئة مسجلة: ${categories[0].name}، وتمثل ${Math.round(categories[0].sharePercent).toLocaleString("ar-KW-u-nu-latn")}٪ من المصروفات المحللة.`);
  if (peakMonth && peakShare >= 12) insights.push(`أعلى شهر صرف مسجل: ${peakMonth.label} بإجمالي ${formatMoney(peakMonth.totalFils)}.`);
  if (trendPercent !== null && activeMonths >= 6) {
    const direction = trendPercent > 5 ? "ارتفع" : trendPercent < -5 ? "انخفض" : "بقي قريباً من";
    insights.push(`إجمالي آخر 3 أشهر مكتملة ${direction} ${Math.abs(Math.round(trendPercent)).toLocaleString("ar-KW-u-nu-latn")}٪ مقارنة بالثلاثة السابقة (${formatMoney(recent3)} مقابل ${formatMoney(previous3)}).`);
  }
  if (partialMonthKey) insights.push(`شهر ${monthLabel(partialMonthKey)} ما خلص، فما دخل في المتوسط ولا بالمقارنة.`);
  if (firstWeekPercent >= 30) insights.push(`حوالي ${Math.round(firstWeekPercent).toLocaleString("ar-KW-u-nu-latn")}٪ من الصرف وقع في أول 7 أيام بعد يوم الراتب المحدد.`);
  if (categoryChanges[0]) insights.push(`صرف ${categoryChanges[0].name} ارتفع ${Math.round(categoryChanges[0].changePercent).toLocaleString("ar-KW-u-nu-latn")}٪ في آخر 3 أشهر مقارنة بالثلاثة السابقة.`);
  return {
    fromISO, toISO: todayISO, totalFils, count: expenses.length, activeMonths,
    completeTotalFils, partialMonth: partialMonthKey, recent3Fils: recent3, previous3Fils: previous3,
    monthlyAverageFils: activeMonths ? Math.round(completeTotalFils / activeMonths) : 0,
    recordedStartISO: recordedDates[0] ?? "", recordedEndISO: recordedDates.at(-1) ?? "",
    categories, categoryChanges, merchants, monthly, peakMonth, trendPercent, firstWeekPercent, insights
  };
}
