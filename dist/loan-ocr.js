const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
const balanceLabels = [
  "الرصيد المتبقي", "المبلغ المتبقي", "إجمالي المديونية", "اجمالي المديونية",
  "الرصيد القائم", "outstanding balance", "remaining balance", "outstanding", "balance"
];
const installmentLabels = [
  "القسط الشهري", "قيمة القسط", "مبلغ القسط", "monthly installment",
  "monthly payment", "installment amount", "installment"
];
const originalAmountLabels = ["المبلغ الأصلي", "مبلغ التمويل", "قيمة التمويل", "finance amount", "original amount", "loan amount"];

export function normalizeOCRText(value = "") {
  return String(value)
    .replace(/[٠-٩]/g, (digit) => arabicDigits.indexOf(digit))
    .replace(/[۰-۹]/g, (digit) => persianDigits.indexOf(digit))
    .replace(/[٬،]/g, ",")
    .replace(/٫/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function amountToFils(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/,/g, "").replace(/[^\d.]/g, "");
  if (!cleaned || (cleaned.match(/\./g) ?? []).length > 1) return null;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return null;
  return Math.round(amount * 1000);
}

function labeledAmount(text, labels) {
  for (const label of labels) {
    const expression = new RegExp(`(?:${label})[^\\d]{0,45}([\\d][\\d,]*(?:\\.\\d{1,3})?)`, "i");
    const match = text.match(expression);
    const amount = amountToFils(match?.[1]);
    if (amount) return amount;
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labeledAmounts(text, labels) {
  const alternatives = [...labels].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const expression = new RegExp(`(?:${alternatives})[^\\d]{0,45}([\\d][\\d,]*(?:\\.\\d{1,3})?)`, "gi");
  const results = [];
  for (const match of text.matchAll(expression)) {
    const amount = amountToFils(match[1]);
    if (amount) results.push({ amount, index: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return results;
}

function findDueDay(text) {
  const patterns = [
    /(?:يوم الاستحقاق|تاريخ الاستحقاق|موعد القسط)[^\d]{0,25}(\d{1,2})/i,
    /(?:due date|payment date)[^\d]{0,25}(\d{1,2})[\/\-.]/i
  ];
  for (const pattern of patterns) {
    const day = Number(text.match(pattern)?.[1]);
    if (Number.isInteger(day) && day >= 1 && day <= 31) return day;
  }
  return null;
}

function dateToISO(value) {
  const normalized = String(value ?? "").replace(/[.]/g, "/").replace(/-/g, "/");
  const match = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return "";
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function labeledDate(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp(`(?:${label})[^\\d]{0,35}(\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{4})`, "i"));
    const value = dateToISO(match?.[1]);
    if (value) return value;
  }
  return "";
}

function inferLender(text) {
  const lenders = [
    [/(boubyan|بوبيان)/i, "بنك بوبيان"], [/(kfh|kuwait finance house|بيتك|بيت التمويل)/i, "بيت التمويل الكويتي"],
    [/(nbk|national bank of kuwait|الوطني)/i, "بنك الكويت الوطني"], [/(gulf bank|بنك الخليج)/i, "بنك الخليج"],
    [/(burgan|برقان)/i, "بنك برقان"], [/(warba|وربة)/i, "بنك وربة"]
  ];
  return lenders.find(([pattern]) => pattern.test(text))?.[1] ?? "";
}

function inferType(name) {
  if (name.includes("شخصي")) return "شخصي";
  if (name.includes("سيارة")) return "سيارة";
  if (name.includes("عقاري")) return "عقاري";
  if (name.includes("بطاقة")) return "بطاقة ائتمانية";
  return "أخرى";
}

function inferName(text, fallback) {
  const names = [
    [/(?:ال)?(?:تمويل|قرض)\s*(?:ال)?(شخصي|استهلاكي)|personal (?:financing|loan)|consumer (?:financing|loan)/i, "تمويل شخصي"],
    [/(?:ال)?(?:تمويل|قرض)\s*(?:ال)?(سيارة|مركبة|سيارات)|(?:car|auto|vehicle) (?:financing|loan)/i, "تمويل سيارة"],
    [/(?:ال)?(?:تمويل|قرض)\s*(?:ال)?(سكني|عقاري|منزل)|housing financing|home loan|mortgage/i, "تمويل عقاري"],
    [/(credit card|بطاقة ائتمانية|فيزا)/i, "بطاقة ائتمانية"]
  ];
  let closest = null;
  for (const [pattern, name] of names) {
    const match = text.match(pattern);
    if (match && (!closest || (match.index ?? 0) > closest.index)) closest = { index: match.index ?? 0, name };
  }
  return closest?.name ?? fallback;
}

export function parseLoanOCRText(rawText, index = 0) {
  const text = normalizeOCRText(rawText);
  const balanceFils = labeledAmount(text, balanceLabels);
  const installmentFils = labeledAmount(text, installmentLabels);
  const originalAmountFils = labeledAmount(text, originalAmountLabels);
  const name = inferName(text, "");
  const dueDay = findDueDay(text);
  return {
    id: `ocr-${Date.now()}-${index}`,
    name,
    lender: inferLender(text),
    type: inferType(name),
    originalAmountFils,
    balanceFils,
    installmentFils,
    annualRate: 0,
    interestRateKnown: false,
    dueDay,
    startDate: labeledDate(text, ["تاريخ البداية", "تاريخ بدء التمويل", "start date", "loan start"]),
    endDate: labeledDate(text, ["تاريخ النهاية", "تاريخ آخر قسط", "end date", "maturity date"]),
    confidence: balanceFils && installmentFils && name ? "high" : balanceFils || installmentFils ? "medium" : "low",
    fieldConfidence: { name: name ? "high" : "low", lender: inferLender(text) ? "high" : "low", balance: balanceFils ? "high" : "low", installment: installmentFils ? "high" : "low", original: originalAmountFils ? "medium" : "low", dueDay: dueDay ? "medium" : "low" }
  };
}

export function parseLoanOCRLoans(rawText, startIndex = 0) {
  const text = normalizeOCRText(rawText);
  const balances = labeledAmounts(text, balanceLabels);
  if (balances.length <= 1) return [parseLoanOCRText(rawText, startIndex)];
  const installments = labeledAmounts(text, installmentLabels);
  const usedInstallments = new Set();

  return balances.map((balance, position) => {
    const nextBalanceIndex = balances[position + 1]?.index ?? text.length;
    const installmentIndex = installments.findIndex((item, index) => (
      !usedInstallments.has(index) && item.index >= balance.index && item.index < nextBalanceIndex
    ));
    const installment = installmentIndex >= 0 ? installments[installmentIndex] : null;
    if (installmentIndex >= 0) usedInstallments.add(installmentIndex);
    const segmentStart = position ? balances[position - 1].end : 0;
    const segment = text.slice(balance.index, nextBalanceIndex);
    const nameSegment = text.slice(segmentStart, balance.end);
    const candidateIndex = startIndex + position;
    const name = inferName(nameSegment, "");
    const originalAmountFils = labeledAmount(segment, originalAmountLabels);
    const dueDay = findDueDay(segment);
    const lender = inferLender(text);

    return {
      id: `ocr-${Date.now()}-${candidateIndex}`,
      name,
      lender,
      type: inferType(name),
      originalAmountFils,
      balanceFils: balance.amount,
      installmentFils: installment?.amount ?? null,
      annualRate: 0,
      interestRateKnown: false,
      dueDay,
      startDate: labeledDate(segment, ["تاريخ البداية", "تاريخ بدء التمويل", "start date", "loan start"]),
      endDate: labeledDate(segment, ["تاريخ النهاية", "تاريخ آخر قسط", "end date", "maturity date"]),
      confidence: installment && name ? "high" : "medium",
      fieldConfidence: { name: name ? "high" : "low", lender: lender ? "high" : "low", balance: "high", installment: installment ? "high" : "low", original: originalAmountFils ? "medium" : "low", dueDay: dueDay ? "medium" : "low" }
    };
  });
}
