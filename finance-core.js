const ARABIC_DIGITS = new Map([
  ["٠", "0"], ["١", "1"], ["٢", "2"], ["٣", "3"], ["٤", "4"],
  ["٥", "5"], ["٦", "6"], ["٧", "7"], ["٨", "8"], ["٩", "9"],
  ["۰", "0"], ["۱", "1"], ["۲", "2"], ["۳", "3"], ["۴", "4"],
  ["۵", "5"], ["۶", "6"], ["۷", "7"], ["۸", "8"], ["۹", "9"]
]);

export const categories = [
  "مطاعم", "بقالة", "مواصلات", "تسوق", "سكن", "فواتير", "صحة", "ترفيه", "سفر", "قسط", "راتب", "أخرى"
];

export function normalizeDigits(value = "") {
  return [...String(value)].map((character) => ARABIC_DIGITS.get(character) ?? character).join("");
}

/* الفاصلة: فاصل آلاف فقط بنمط 1,234,567 — وإذا بعدها رقم أو رقمين فهي عشرية («12,5» = 12.500).
   أي استخدام ثاني للفاصلة يُرفض بدل ما يتحول لرقم مختلف بصمت. */
export function parseMoney(value) {
  let normalized = normalizeDigits(value)
    .trim()
    .replaceAll("٫", ".")
    .replaceAll("٬", ",")
    .replace(/[‎‏؜]/g, "")
    .replace(/\s+/g, "");

  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,3})?$/.test(normalized)) normalized = normalized.replaceAll(",", "");
  else if (/^\d+,\d{1,2}$/.test(normalized)) normalized = normalized.replace(",", ".");
  if (/^\d+\.$/.test(normalized)) normalized = normalized.slice(0, -1);
  if (/^\.\d{1,3}$/.test(normalized)) normalized = `0${normalized}`; // «.5» = نص دينار (F33)

  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const wholeNumber = Number(whole);
  if (!Number.isSafeInteger(wholeNumber) || wholeNumber > 1_000_000_000) return null;
  const fils = wholeNumber * 1000 + Number(fraction.padEnd(3, "0"));
  return Number.isSafeInteger(fils) ? fils : null;
}

/* عدد صحيح من خانة نصية: يقبل الأرقام العربية وفواصل الآلاف، ويرجع null إذا ما انفهم. */
export function parseCount(value, { min = 0, max = 1_000_000 } = {}) {
  const text = normalizeDigits(value).trim().replaceAll("٬", "").replaceAll(",", "").replace(/[‎‏؜]/g, "");
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

/* نسبة مئوية من خانة نصية: تقبل الأرقام العربية والفاصلة العربية، وأي كسر (3.3 مثلاً) بدون خطوات ثابتة. */
export function parseRate(value, { min = 0, max = 100 } = {}) {
  const text = normalizeDigits(value).trim().replaceAll("٫", ".").replaceAll("٬", "").replaceAll(",", "")
    .replace(/[‎‏؜٪%]/g, "").replace(/\s+/g, "");
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

/* قص آمن بالأحرف المرئية حتى لا ينكسر الإيموجي (نصف محرف) عند الحد. */
export function cutText(value = "", limit = 80) {
  const characters = [...String(value)];
  return characters.length <= limit ? String(value) : characters.slice(0, limit).join("");
}

const pluralRules = new Intl.PluralRules("ar");
const PLURAL_FORMS = {
  transaction: { zero: "عمليات", one: "عملية", two: "عمليتان", few: "عمليات", many: "عملية", other: "عملية" },
  month: { zero: "أشهر", one: "شهر", two: "شهران", few: "أشهر", many: "شهر", other: "شهر" },
  year: { zero: "سنوات", one: "سنة", two: "سنتان", few: "سنوات", many: "سنة", other: "سنة" },
  day: { zero: "أيام", one: "يوم", two: "يومان", few: "أيام", many: "يوم", other: "يوم" },
  commitment: { zero: "التزامات", one: "التزام", two: "التزامان", few: "التزامات", many: "التزاماً", other: "التزام" },
  installment: { zero: "أقساط", one: "قسط", two: "قسطان", few: "أقساط", many: "قسطاً", other: "قسط" },
  goal: { zero: "أهداف", one: "هدف", two: "هدفان", few: "أهداف", many: "هدفاً", other: "هدف" },
  notification: { zero: "إشعارات", one: "إشعار", two: "إشعاران", few: "إشعارات", many: "إشعاراً", other: "إشعار" },
  loan: { zero: "قروض", one: "قرض", two: "قرضان", few: "قروض", many: "قرضاً", other: "قرض" },
  question: { zero: "أسئلة", one: "سؤال", two: "سؤالان", few: "أسئلة", many: "سؤالاً", other: "سؤال" },
  stock: { zero: "أسهم", one: "سهم", two: "سهمان", few: "أسهم", many: "سهماً", other: "سهم" },
  price: { zero: "أسعار", one: "سعر", two: "سعران", few: "أسعار", many: "سعراً", other: "سعر" }
};

export function pluralWord(count, unit) {
  const forms = PLURAL_FORMS[unit];
  if (!forms) return "";
  return forms[pluralRules.select(count)] ?? forms.other;
}

/* «7 عمليات» و«1 عملية» و«11 عملية» — صيغة الجمع العربية مع أرقام لاتينية.
   المثنى يحمل العدد في صيغته، فـ«2 عمليتان» خطأ نحوي: نكتب «عمليتان» بلا رقم. */
export function countLabel(count, unit) {
  const number = Number(count) || 0;
  const word = pluralWord(number, unit);
  if (pluralRules.select(number) === "two" && word) return word;
  return `${number.toLocaleString("ar-KW-u-nu-latn")} ${word}`.trim();
}

export function moneyInput(fils = 0) {
  const sign = fils < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(fils));
  return `${sign}${Math.floor(absolute / 1000)}.${String(absolute % 1000).padStart(3, "0")}`;
}

const moneyNumber = new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

// أرقام إنجليزية بثلاث خانات عشرية مثل تطبيقات البنوك: 1,250.750 د.ك
export function formatMoney(fils = 0) {
  const value = Number(fils) / 1000;
  if (!Number.isFinite(value)) return "0.000 د.ك";
  const text = moneyNumber.format(Math.abs(value));
  return `${value < 0 && text !== "0.000" ? "\u200E\u2212" : ""}${text} د.ك`;
}

export function payoff({ balanceFils, installmentFils, extraFils = 0, annualRate = 0 }) {
  const values = [balanceFils, installmentFils, extraFils, annualRate];
  if (values.some((value) => !Number.isFinite(value)) || balanceFils < 0 || installmentFils <= 0 ||
      extraFils < 0 || annualRate < 0 || annualRate > 100) return null;
  if (balanceFils === 0) return { months: 0, chargesFils: 0, totalFils: 0 };

  let balance = Math.round(balanceFils);
  let chargesFils = 0;
  let totalFils = 0;
  const monthlyRate = annualRate / 1200;

  for (let month = 1; month <= 1200; month += 1) {
    const charge = Math.round(balance * monthlyRate);
    const available = installmentFils + extraFils;
    if (available <= charge) return null;
    const actual = Math.min(available, balance + charge);
    balance = balance + charge - actual;
    chargesFils += charge;
    totalFils += actual;
    if (balance === 0) return { months: month, chargesFils, totalFils };
  }
  return null;
}

export function investmentProjection({ initialFils, monthlyFils, annualRate, years }) {
  const values = [initialFils, monthlyFils, annualRate, years];
  if (values.some((value) => !Number.isFinite(value)) || initialFils < 0 || monthlyFils < 0 ||
      annualRate <= -100 || annualRate > 100 || !Number.isInteger(years) || years < 1 || years > 60) return null;

  const monthlyRate = Math.pow(1 + annualRate / 100, 1 / 12) - 1;
  let value = initialFils;
  const yearly = [];
  for (let month = 1; month <= years * 12; month += 1) {
    value = value * (1 + monthlyRate) + monthlyFils;
    if (month % 12 === 0) yearly.push({ year: month / 12, valueFils: Math.round(value) });
  }
  const contributionsFils = initialFils + monthlyFils * years * 12;
  const valueFils = Math.round(value);
  return { valueFils, contributionsFils, growthFils: valueFils - contributionsFils, yearly };
}

const rejectedBankTerms = ["otp", "verification", "رمز تحقق", "رمز التأكيد", "refund", "استرداد", "declined", "مرفوضة", "تم رفض"];
const purchaseTerms = ["purchase", "payment at", "شراء", "دفع لدى", "خصم", "pos"];

const categoryKeywords = [
  ["قسط", ["tabby", "tamara", "postpay", "spotii", "deema", "installment", "instalment", "emi", "loan", "قسط", "اقساط", "أقساط", "تمويل", "قرض"]],
  ["فواتير", ["zain", "ooredoo", "stc", "viva", "telecom", "internet", "fiber", "electricity", "water", "insurance", "traffic", "bill payment",
    "اتصالات", "زين", "اوريدو", "فيفا", "كهرباء", "مياه", "انترنت", "فاتورة", "تأمين", "مرور", "اشتراك"]],
  ["سفر", ["airways", "airline", "jazeera", "emirates", "etihad", "flydubai", "booking.com", "agoda", "expedia", "airbnb", "hotel", "hotels", "resort",
    "hertz", "avis", "airport", "duty free", "travel", "tourism", "سفر", "فندق", "طيران", "الجزيرة", "سياحة", "مطار"]],
  ["صحة", ["pharmacy", "clinic", "hospital", "dental", "dentist", "optical", "optics", "medical", "physio", "gym", "fitness", "vitamin", "doctor", "health",
    "صيدلية", "مستوصف", "مستشفى", "عيادة", "اسنان", "أسنان", "مختبر", "نظارات", "بصريات", "جيم", "نادي رياضي", "طبي", "علاج"]],
  ["ترفيه", ["netflix", "spotify", "shahid", "anghami", "osn", "youtube", "apple.com/bill", "itunes", "google play", "playstation", "psn", "steam", "xbox",
    "nintendo", "cinema", "vox", "cinescape", "grand cinemas", "bowling", "gaming", "game", "disney", "prime video", "amusement", "winter wonderland",
    "kidzania", "سينما", "السينما", "ترفيه", "العاب", "ألعاب", "ملاهي", "شاهد", "انغامي", "نتفلكس"]],
  ["مواصلات", ["uber", "careem", "taxi", "bolt", "jeeny", "fuel", "petrol", "oula", "knpc", "car wash", "carwash", "parking", "garage", "tire", "tyre",
    "بنزين", "وقود", "تاكسي", "غسيل سيارات", "موقف", "ورشة", "كراج", "اطارات"]],
  ["مطاعم", ["talabat", "deliveroo", "jahez", "keeta", "restaurant", "cafe", "cafeteria", "coffee", "starbucks", "costa", "tim hortons", "timhortons",
    "dunkin", "baskin", "mcdonald", "kfc", "burger", "hardee", "pizza", "domino", "papa john", "subway", "shake shack", "five guys", "shawarma", "kebab",
    "grill", "bistro", "kitchen", "sweets", "chocolate", "ice cream", "icecream", "juice", "مطعم", "كافيه", "كوفي", "قهوة", "شاورما", "برجر", "بيتزا",
    "مشويات", "حلويات", "عصير", "مندي", "كباب"]],
  ["بقالة", ["co-op", "coop", "grocery", "carrefour", "lulu", "sultan center", "the sultan", "nesto", "grand hyper", "grandhyper", "ramez", "danube",
    "saveco", "supermarket", "hypermarket", "mart", "talabat mart", "t-mart", "bakery", "butcher", "vegetable", "fruit", "dairy", "almarai",
    "جمعية", "تعاونية", "بقالة", "سوبرماركت", "هايبر", "كارفور", "لولو", "سلطان سنتر", "مخبز", "خضار", "لحوم", "قصاب"]],
  ["تسوق", ["amazon", "shein", "temu", "noon", "namshi", "zara", "h&m", "ikea", "xcite", "eureka", "jarir", "extra", "centrepoint", "splash", "homes r us",
    "daiso", "sephora", "~mall", "~avenues", "ounass", "farfetch", "aliexpress", "ebay", "trendyol", "decathlon", "nike", "adidas", "american eagle",
    "bershka", "stradivarius", "~متجر", "~مول", "أمازون", "نون", "اكسايت", "يوريكا", "تسوق"]],
  ["سكن", ["rent", "furniture", "maintenance", "plumber", "electrician", "cleaning", "laundry", "إيجار", "ايجار", "صيانة", "اثاث", "أثاث", "سباك", "كهربائي",
    "تنظيف", "مغسلة"]]
];

const keywordCache = new Map();
function keywordMatches(lower, term) {
  if (!/^[\x00-\x7f]+$/.test(term) || term.length > 5) return lower.includes(term);
  let re = keywordCache.get(term);
  if (!re) {
    re = new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`);
    keywordCache.set(term, re);
  }
  return re.test(lower);
}

/* الفئة صاحبة أطول كلمة مطابقة تفوز، فمثلاً «talabat mart» بقالة و«talabat» لحالها مطاعم.
   الكلمات التي تبدأ بـ ~ (مثل mall) ضعيفة: تُستعمل فقط إذا ما طابق شيء أقوى منها. */
export function inferCategory(text = "") {
  const lower = String(text).toLowerCase();
  let best = { length: 0, category: "أخرى" };
  for (const [category, words] of categoryKeywords) {
    for (const raw of words) {
      const weak = raw.startsWith("~");
      const word = weak ? raw.slice(1) : raw;
      const score = weak ? 1 : word.length;
      if (score > best.length && keywordMatches(lower, word)) best = { length: score, category };
    }
  }
  return best.category;
}

export function parseBankText(raw = "") {
  const text = normalizeDigits(raw).replaceAll("٫", ".");
  const lower = text.toLowerCase();
  if (!text.trim() || rejectedBankTerms.some((term) => lower.includes(term)) ||
      !purchaseTerms.some((term) => lower.includes(term))) return null;

  const patterns = [
    /(?:KWD|KD|د\.ك|دينار)\s*([0-9]+(?:\.[0-9]{1,3})?)(?![0-9.])/i,
    /([0-9]+(?:\.[0-9]{1,3})?)\s*(?:KWD|KD|د\.ك|دينار)(?![A-Za-z])/i
  ];
  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  if (!match) return null;
  const amountFils = parseMoney(match[1]);
  if (!amountFils || amountFils > 1_000_000_000_000) return null;

  let merchant = "تاجر غير محدد";
  const merchantMatch =
    text.match(/من\s+بطاقة(?:\s+مسبقة\s+الدفع)?\s+\d+\s+من\s+(.+?)(?=\s+في\s+(?:KWT|KUWAIT|الكويت)\b|\s+بتاريخ\b|$)/i) ??
    text.match(/(?:\bat\b|\bfrom\b|لدى|من متجر|التاجر)\s*[:\-]?\s+(.+)/i);
  if (merchantMatch) {
    merchant = merchantMatch[1]
      .split(/\n|[.!،]\s*(?:الرصيد|available balance|balance)|\s+(?:on|using|card|بتاريخ|بطاقة|الرصيد)\b/i)[0]
      .trim()
      .replace(/[.,،]+$/, "")
      .slice(0, 80) || merchant;
  }
  return { amountFils, merchant, category: inferCategory(`${merchant} ${text}`) };
}

export function merchantKey(value = "") {
  return normalizeDigits(value)
    .toLowerCase()
    .replace(/^(?:tap|myfatoorah|knet|pos|payment)\s+/i, "")
    .replace(/\b(?:food|kwt|kuwait)\b/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 80);
}

/* مفاتيح عامة تظهر في كل إشعار تقريباً: لو تعلّمناها، كل عملية قادمة تنقلب لنفس الاسم (F28). */
const GENERIC_MERCHANT_KEYS = /^(?:utap|u tap|tap|knet|k net|pos|payment|purchase|visa|mastercard|master|transfer|نقاط بيع|نقاط البيع|دفعة|دفع|شراء|سحب|تحويل|بطاقة|حساب|بنك|boubyan|بوبيان)$/i;
// وصف مكوّن من كلمات عامة فقط («كي نت نقاط بيع UTap») ما يحدد تاجراً
const GENERIC_MERCHANT_TOKENS = new Set(["utap", "u", "tap", "knet", "k", "net", "كي", "نت", "pos", "نقاط", "بيع", "البيع", "payment", "purchase",
  "visa", "mastercard", "master", "transfer", "card", "debit", "credit", "prepaid", "multi", "currency", "دفعة", "دفع", "شراء", "سحب", "تحويل",
  "بطاقة", "حساب", "بنك", "boubyan", "بوبيان", "خصم", "من", "في", "عبر", "باستخدام", "بجهاز", "جهاز", "عملية", "مشتريات"]);
export function genericMerchantKey(key) {
  const text = String(key ?? "").trim();
  if (!text || text.length < 3 || GENERIC_MERCHANT_KEYS.test(text)) return true;
  return text.split(/\s+/).every((token) => GENERIC_MERCHANT_TOKENS.has(token) || /^\d+$/.test(token));
}
export function merchantDefaults(raw = "", fallbackCategory = "أخرى") {
  const key = merchantKey(raw);
  const known = [
    { pattern: /(?:^|\s)talabat(?:\s|$)/i, merchant: "طلبات", category: "مطاعم" },
    { pattern: /(?:^|\s)carrefour(?:\s|$)/i, merchant: "كارفور", category: "بقالة" },
    { pattern: /(?:^|\s)careem(?:\s|$)/i, merchant: "كريم", category: "مواصلات" },
    { pattern: /(?:^|\s)uber(?:\s|$)/i, merchant: "أوبر", category: "مواصلات" },
    { pattern: /(?:^|\s)deliveroo(?:\s|$)/i, merchant: "ديليفرو", category: "مطاعم" }
  ].find((item) => item.pattern.test(key));
  return {
    key,
    merchant: (known?.merchant ?? String(raw).trim().slice(0, 80)) || "تاجر غير محدد",
    category: known?.category ?? fallbackCategory
  };
}

function clampedMonthlyDate(year, month, day) {
  const lastDay = new Date(year, month + 1, 0, 12).getDate();
  return new Date(year, month, Math.min(Math.max(day, 1), lastDay), 12);
}

export function safeToSpend({
  cashFils = 0,
  safetyBufferFils = 0,
  salaryDay = 25,
  loans = [],
  today = todayISO()
} = {}) {
  const current = new Date(`${today}T12:00:00`);
  if (Number.isNaN(current.getTime())) return null;
  let payday = clampedMonthlyDate(current.getFullYear(), current.getMonth(), salaryDay);
  if (payday <= current) payday = clampedMonthlyDate(current.getFullYear(), current.getMonth() + 1, salaryDay);

  let reservedInstallmentsFils = 0;
  for (const loan of loans) {
    const installmentFils = Number.isSafeInteger(loan?.installmentFils) ? Math.max(loan.installmentFils, 0) : 0;
    const dueDay = Number.isInteger(loan?.dueDay) ? loan.dueDay : 1;
    for (let monthOffset = 0; monthOffset <= 1; monthOffset += 1) {
      const due = clampedMonthlyDate(current.getFullYear(), current.getMonth() + monthOffset, dueDay);
      if (due >= current && due <= payday) reservedInstallmentsFils += installmentFils;
    }
  }
  const committedFils = Math.max(safetyBufferFils, 0) + reservedInstallmentsFils;
  const rawSafeFils = Math.max(cashFils, 0) - committedFils;
  return {
    paydayISO: `${payday.getFullYear()}-${String(payday.getMonth() + 1).padStart(2, "0")}-${String(payday.getDate()).padStart(2, "0")}`,
    daysUntilPayday: Math.max(Math.ceil((payday - current) / 86_400_000), 0),
    reservedInstallmentsFils,
    committedFils,
    safeFils: Math.max(rawSafeFils, 0),
    shortfallFils: Math.max(-rawSafeFils, 0)
  };
}

export function monthKey(dateLike = new Date()) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function todayISO() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
