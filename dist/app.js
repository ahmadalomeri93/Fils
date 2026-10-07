import { readPDFStatement } from "./pdf-statement.js";
import { SECTOR_OPTIONS, mountCheckup } from "./checkup.js";
import { mountOnboarding } from "./onboarding.js";
import { EXPENSE_CATEGORIES, budgetReport, categoryNudges, mountSpending, monthKeyOf } from "./spending.js";
import { fundGoals, mountSalaryPlan, salaryDue } from "./salary-plan.js";
import { PIN_PATTERN, backupStatus, createLockRecord, cryptoAvailable, describeBackupAge, hasMeaningfulData, registerFailure, registerSuccess,
  remainingLockMs, sanitizeLockRecord, shouldRelock, verifyPin } from "./safety.js";
import { GOLD_PRICE_URL, mountGold, priceFromApi, sanitizeGold } from "./gold.js";
import { NOTIFICATION_REASONS, NOTIFICATION_TYPE_LABELS, notificationFingerprints, parseBankNotification, splitBankMessages, splitStamp, BANK_FIELDS, DEFAULT_FIELD_ORDER } from "./bank-notifications.js";
import { parsePortfolioLink, newPortfolioHoldings } from "./portfolio-import.js";
import {
  categories,
  createId,
  formatMoney,
  investmentProjection,
  merchantDefaults,
  merchantKey,
  moneyInput,
  monthKey,
  normalizeDigits,
  parseBankText,
  parseMoney,
  payoff,
  todayISO
} from "./finance-core.js";
import {
  addDaysISO,
  addMonthsISO,
  answerFinancialQuestion,
  commitmentOccurrences,
  commitmentRecurrences,
  commitmentSummary,
  createAdvisorAllocation,
  debtOccurrences,
  debtProgress,
  debtSummary,
  endOfMonthForecast,
  financialFlow,
  generateFinancialAlerts,
  mergeFinancialAlerts,
  monthBounds,
  monthlyCommitmentEquivalent,
  remainingInstallments,
  safeToSpendEngine,
  simulateExtraPayment,
  spendingComparison,
  totalMonthlyIncome
} from "./financial-engine.js";
import { parseLoanOCRLoans } from "./loan-ocr.js";
import { analyzeSpendingBehavior, parseBankStatement } from "./statement-import.js";
import {
  KUWAIT_STOCKS_AS_OF,
  calculateAverageDown,
  calculateStockBudget,
  calculateStockPosition,
  formatSharePrice,
  getKuwaitStock,
  kuwaitStocks,
  parseSharePriceTenths
} from "./kuwait-stocks.js";

const STORAGE_KEY = "fils-state-v1";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const commitmentCategories = ["إيجار", "كهرباء وماء", "إنترنت", "هاتف", "تأمين", "اشتراكات", "مدرسة / حضانة", "عامل منزلي", "نادي", "سيارة", "عائلة", "أخرى"];
const debtTypes = ["شخصي", "استهلاكي", "سيارة", "عقاري", "بطاقة ائتمانية", "تقسيط", "أخرى"];

function defaultState() {
  return {
    version: 4,
    settings: { incomeFils: 0, budgetFils: 0, cashFils: 0, salaryDay: 25, safetyBufferFils: 0, creditCardReserveFils: 0, investedFils: 0, assetsFils: 0 },
    incomes: [],
    transactions: [],
    merchantRules: [],
    loans: [],
    debtPayments: [],
    extraPayments: [],
    monthlyCommitments: [],
    commitmentPayments: [],
    creditCards: [],
    financialAlerts: [],
    financialSnapshots: [],
    statementImport: { coverageStartISO: "", coverageEndISO: "", importedAt: "", importedCount: 0 },
    customCommitmentCategories: [],
    goals: [],
    categoryBudgets: {},
    stockHoldings: [],
    goldPurchases: [],
    goldPrices: [],
    investment: { initialFils: 0, monthlyFils: 100_000, annualRate: 7, years: 10 },
    ui: { installDismissed: false, extraFils: 0, initialPortfolioApplied: false, onboarded: false, lastBackupAt: "", backupBaselineAt: "", backupSnoozedUntil: "", goldGramFils: 0, zakatOtherFils: 0, zakatGoldFils: 0, zakatDebtsFils: 0, inflationRate: 2.5, dividends: {}, sectorOverrides: {}, bankSeen: [], bankFieldOrder: ["title", "subtitle", "body"], goldSpreadPct: 3, goldUsdKwd: 0.307 }
  };
}

function finiteInteger(value, fallback = 0, minimum = 0, maximum = 1_000_000_000_000) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function finiteNumber(value, fallback = 0, minimum = -100, maximum = 100) {
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
}

function optionalDate(value) { return validDate(value) ? value : ""; }
function optionalInteger(value, minimum = 0, maximum = 1_000_000) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function sanitizeState(raw) {
  const clean = defaultState();
  if (!raw || typeof raw !== "object") return clean;
  const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  for (const key of Object.keys(clean.settings)) clean.settings[key] = finiteInteger(settings[key]);
  clean.settings.salaryDay = finiteInteger(settings.salaryDay, 25, 1, 31);

  clean.incomes = Array.isArray(raw.incomes) ? raw.incomes.slice(0, 50).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    name: typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "دخل شهري",
    amountFils: finiteInteger(item?.amountFils),
    frequency: item?.frequency === "monthly" ? "monthly" : "monthly",
    status: item?.status === "paused" ? "paused" : "active"
  })).filter((item) => item.name && item.amountFils > 0) : [];
  if (!clean.incomes.length && clean.settings.incomeFils > 0) {
    clean.incomes.push({ id: "legacy-primary-income", name: "الدخل الشهري", amountFils: clean.settings.incomeFils, frequency: "monthly", status: "active" });
  }
  clean.settings.incomeFils = totalMonthlyIncome(clean.incomes, clean.settings.incomeFils);

  clean.transactions = Array.isArray(raw.transactions) ? raw.transactions.slice(0, 20_000).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    amountFils: finiteInteger(item?.amountFils, 0, 1),
    merchant: typeof item?.merchant === "string" ? item.merchant.trim().slice(0, 80) : "غير محدد",
    category: categories.includes(item?.category) ? item.category : "أخرى",
    kind: item?.kind === "income" ? "income" : "expense",
    date: validDate(item?.date) ? item.date : todayISO(),
    reviewed: item?.reviewed !== false,
    source: ["bank-text", "bank-statement"].includes(item?.source) ? item.source : "manual",
    rawMerchant: typeof item?.rawMerchant === "string" ? item.rawMerchant.trim().slice(0, 80) : "",
    fingerprint: typeof item?.fingerprint === "string" ? item.fingerprint.slice(0, 180) : "",
    notifBalanceFils: optionalInteger(item?.notifBalanceFils, 1, 1_000_000_000_000),
    cardLast4: /^\d{4}$/.test(item?.cardLast4 ?? "") ? item.cardLast4 : "",
    possibleDuplicate: item?.possibleDuplicate === true,
    createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString()
  })).filter((item) => item.amountFils > 0 && item.merchant) : [];

  clean.merchantRules = Array.isArray(raw.merchantRules) ? raw.merchantRules.slice(0, 500).map((item) => ({
    key: typeof item?.key === "string" ? item.key.trim().slice(0, 80) : "",
    merchant: typeof item?.merchant === "string" ? item.merchant.trim().slice(0, 80) : "",
    category: categories.includes(item?.category) ? item.category : "أخرى"
  })).filter((item) => item.key && item.merchant) : [];

  clean.loans = Array.isArray(raw.loans) ? raw.loans.slice(0, 200).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    name: typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "قرض",
    lender: typeof item?.lender === "string" ? item.lender.trim().slice(0, 60) : "",
    type: debtTypes.includes(item?.type) ? item.type : "أخرى",
    originalAmountFils: finiteInteger(item?.originalAmountFils, finiteInteger(item?.balanceFils)),
    originalAmountKnown: item?.originalAmountKnown !== false,
    balanceFils: finiteInteger(item?.balanceFils),
    installmentFils: finiteInteger(item?.installmentFils, 0, 1),
    annualRate: finiteNumber(item?.annualRate, 0, 0, 100),
    interestRateKnown: item?.interestRateKnown === true || finiteNumber(item?.annualRate, 0, 0, 100) > 0,
    dueDay: finiteInteger(item?.dueDay, 1, 1, 31),
    startDate: optionalDate(item?.startDate),
    endDate: optionalDate(item?.endDate),
    remainingInstallments: optionalInteger(item?.remainingInstallments),
    totalPaidFils: finiteInteger(item?.totalPaidFils),
    status: ["active", "completed", "overdue", "stopped"].includes(item?.status) ? item.status : (finiteInteger(item?.balanceFils) === 0 ? "completed" : "active")
  })).filter((item) => item.name && (item.installmentFils > 0 || item.status === "completed")) : [];

  clean.debtPayments = Array.isArray(raw.debtPayments) ? raw.debtPayments.slice(0, 10_000).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    debtId: typeof item?.debtId === "string" ? item.debtId.slice(0, 100) : "",
    amountFils: finiteInteger(item?.amountFils), dueDate: optionalDate(item?.dueDate), paidAt: optionalDate(item?.paidAt), status: item?.status === "reversed" ? "reversed" : "paid"
  })).filter((item) => item.debtId && item.dueDate && item.amountFils > 0) : [];

  clean.extraPayments = Array.isArray(raw.extraPayments) ? raw.extraPayments.slice(0, 5_000).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    debtId: typeof item?.debtId === "string" ? item.debtId.slice(0, 100) : "",
    amountFils: finiteInteger(item?.amountFils), date: validDate(item?.date) ? item.date : todayISO(),
    balanceBeforeFils: finiteInteger(item?.balanceBeforeFils), balanceAfterFils: finiteInteger(item?.balanceAfterFils)
  })).filter((item) => item.debtId && item.amountFils > 0) : [];

  clean.monthlyCommitments = Array.isArray(raw.monthlyCommitments) ? raw.monthlyCommitments.slice(0, 1_000).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    name: typeof item?.name === "string" ? item.name.trim().slice(0, 80) : "التزام",
    category: typeof item?.category === "string" ? item.category.trim().slice(0, 60) : "أخرى",
    amountFils: finiteInteger(item?.amountFils),
    dueDate: validDate(item?.dueDate) ? item.dueDate : todayISO(),
    recurrence: Object.hasOwn(commitmentRecurrences, item?.recurrence) ? item.recurrence : "monthly",
    paymentMethod: ["bank", "credit_card", "cash", "other"].includes(item?.paymentMethod) ? item.paymentMethod : "bank",
    notes: typeof item?.notes === "string" ? item.notes.trim().slice(0, 500) : "",
    status: ["active", "paused", "completed"].includes(item?.status) ? item.status : "active",
    createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString()
  })).filter((item) => item.name && item.amountFils > 0) : [];

  clean.commitmentPayments = Array.isArray(raw.commitmentPayments) ? raw.commitmentPayments.slice(0, 20_000).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    commitmentId: typeof item?.commitmentId === "string" ? item.commitmentId.slice(0, 100) : "",
    amountFils: finiteInteger(item?.amountFils), dueDate: optionalDate(item?.dueDate), paidAt: optionalDate(item?.paidAt), status: item?.status === "reversed" ? "reversed" : "paid"
  })).filter((item) => item.commitmentId && item.dueDate && item.amountFils > 0) : [];

  clean.creditCards = Array.isArray(raw.creditCards) ? raw.creditCards.slice(0, 50).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    name: typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "بطاقة ائتمان",
    reservedPaymentFils: finiteInteger(item?.reservedPaymentFils), status: item?.status === "paused" ? "paused" : "active"
  })).filter((item) => item.name && item.reservedPaymentFils > 0) : [];

  clean.customCommitmentCategories = Array.isArray(raw.customCommitmentCategories)
    ? [...new Set(raw.customCommitmentCategories.filter((item) => typeof item === "string").map((item) => item.trim().slice(0, 60)).filter(Boolean))].slice(0, 100)
    : [];

  const alertDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value.slice(0, 40) : null;
  clean.financialAlerts = Array.isArray(raw.financialAlerts) ? raw.financialAlerts.slice(0, 100).filter((item) => item && typeof item.key === "string").map((item) => ({
    ...item, key: item.key.slice(0, 180), id: typeof item.id === "string" ? item.id.slice(0, 180) : createId(),
    createdAt: alertDate(item.createdAt), updatedAt: alertDate(item.updatedAt), dismissedAt: alertDate(item.dismissedAt), cooldownUntil: alertDate(item.cooldownUntil),
    active: item.active === true
  })) : [];
  clean.financialSnapshots = Array.isArray(raw.financialSnapshots) ? raw.financialSnapshots.slice(-400).filter((item) => validDate(item?.date)).map((item) => ({
    date: item.date, cashFils: finiteInteger(item.cashFils), safeFils: finiteInteger(item.safeFils), debtFils: finiteInteger(item.debtFils), monthSpentFils: finiteInteger(item.monthSpentFils)
  })) : [];

  const statementImport = raw.statementImport && typeof raw.statementImport === "object" ? raw.statementImport : {};
  clean.statementImport = {
    coverageStartISO: validDate(statementImport.coverageStartISO) ? statementImport.coverageStartISO : "",
    coverageEndISO: validDate(statementImport.coverageEndISO) ? statementImport.coverageEndISO : "",
    importedAt: typeof statementImport.importedAt === "string" ? statementImport.importedAt.slice(0, 40) : "",
    importedCount: finiteInteger(statementImport.importedCount, 0, 0, 100_000)
  };

  clean.goals = Array.isArray(raw.goals) ? raw.goals.slice(0, 200).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    name: typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "هدف",
    targetFils: finiteInteger(item?.targetFils, 0, 1),
    savedFils: finiteInteger(item?.savedFils),
    monthlyFils: finiteInteger(item?.monthlyFils),
    lastFundedMonth: /^\d{4}-\d{2}$/.test(item?.lastFundedMonth ?? "") ? item.lastFundedMonth : ""
  })).filter((item) => item.name && item.targetFils > 0) : [];

  clean.categoryBudgets = {};
  if (raw.categoryBudgets && typeof raw.categoryBudgets === "object") {
    for (const [category, fils] of Object.entries(raw.categoryBudgets)) {
      if (EXPENSE_CATEGORIES.includes(category) && finiteInteger(fils, 0, 1) > 0) clean.categoryBudgets[category] = fils;
    }
  }

  clean.stockHoldings = Array.isArray(raw.stockHoldings) ? raw.stockHoldings.slice(0, 500).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    securityCode: getKuwaitStock(item?.securityCode)?.code ?? "",
    quantity: finiteInteger(item?.quantity, 0, 1, 100_000_000),
    purchasePriceTenths: finiteInteger(item?.purchasePriceTenths, 0, 1, 100_000_000),
    feesFils: finiteInteger(item?.feesFils, 0, 0, 1_000_000_000),
    currentPriceTenths: finiteInteger(item?.currentPriceTenths, 0, 1, 100_000_000),
    priceUpdatedAt: typeof item?.priceUpdatedAt === "string" && !Number.isNaN(Date.parse(item.priceUpdatedAt)) ? item.priceUpdatedAt.slice(0, 40) : "",
    createdAt: typeof item?.createdAt === "string" && !Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt.slice(0, 40) : new Date().toISOString()
  })).filter((item) => item.securityCode && item.quantity > 0 && item.purchasePriceTenths > 0 && item.currentPriceTenths > 0) : [];

  const investment = raw.investment && typeof raw.investment === "object" ? raw.investment : {};
  clean.investment.initialFils = finiteInteger(investment.initialFils);
  clean.investment.monthlyFils = finiteInteger(investment.monthlyFils, 100_000);
  clean.investment.annualRate = finiteNumber(investment.annualRate, 7, -99.99, 100);
  clean.investment.years = finiteInteger(investment.years, 10, 1, 60);
  clean.ui.installDismissed = raw.ui?.installDismissed === true;
  clean.ui.extraFils = finiteInteger(raw.ui?.extraFils);
  clean.ui.initialPortfolioApplied = raw.ui?.initialPortfolioApplied === true;
  clean.ui.onboarded = raw.ui?.onboarded === true;
  for (const key of ["lastBackupAt", "backupBaselineAt", "backupSnoozedUntil"]) {
    clean.ui[key] = typeof raw.ui?.[key] === "string" && Number.isFinite(Date.parse(raw.ui[key])) ? raw.ui[key].slice(0, 40) : "";
  }
  clean.ui.goldGramFils = finiteInteger(raw.ui?.goldGramFils, 0, 0, 100_000_000);
  clean.ui.zakatOtherFils = finiteInteger(raw.ui?.zakatOtherFils);
  clean.ui.zakatGoldFils = finiteInteger(raw.ui?.zakatGoldFils);
  clean.ui.zakatDebtsFils = finiteInteger(raw.ui?.zakatDebtsFils);
  clean.ui.inflationRate = finiteNumber(raw.ui?.inflationRate, 2.5, 0, 50);
  clean.ui.bankSeen = Array.isArray(raw.ui?.bankSeen) ? raw.ui.bankSeen.filter((item) => typeof item === "string" && /^[0-9a-z]{1,16}$/.test(item)).slice(-3000) : [];
  const fieldOrder = Array.isArray(raw.ui?.bankFieldOrder) ? raw.ui.bankFieldOrder.filter((item, i, all) => BANK_FIELDS.includes(item) && all.indexOf(item) === i) : [];
  clean.ui.bankFieldOrder = fieldOrder.length ? fieldOrder : [...DEFAULT_FIELD_ORDER];
  clean.ui.goldSpreadPct = finiteNumber(raw.ui?.goldSpreadPct, 3, 0, 20);
  clean.ui.goldUsdKwd = finiteNumber(raw.ui?.goldUsdKwd, 0.307, 0.2, 0.5);
  Object.assign(clean, sanitizeGold(raw));
  clean.ui.sectorOverrides = {};
  if (raw.ui?.sectorOverrides && typeof raw.ui.sectorOverrides === "object") {
    for (const [code, sector] of Object.entries(raw.ui.sectorOverrides)) {
      if (getKuwaitStock(code) && SECTOR_OPTIONS.includes(sector)) clean.ui.sectorOverrides[code] = sector;
    }
  }
  clean.ui.dividends = {};
  if (raw.ui?.dividends && typeof raw.ui.dividends === "object") {
    for (const [code, tenths] of Object.entries(raw.ui.dividends)) {
      if (getKuwaitStock(code) && finiteInteger(tenths, -1, 0, 1_000_000) >= 0) clean.ui.dividends[code] = tenths;
    }
  }
  clean.version = 4;
  return clean;
}

let storageAvailable = true;
function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? sanitizeState(JSON.parse(saved)) : defaultState();
  } catch (error) {
    storageAvailable = false;
    console.warn("Local storage unavailable", error);
    return defaultState();
  }
}

let state = loadState();
function saveState() {
  if (!storageAvailable) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (error) { storageAvailable = false; toast("تعذر الحفظ على الجهاز. صدّر بياناتك قبل إغلاق الصفحة."); console.error(error); }
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[character]));
}

const dateFormatter = new Intl.DateTimeFormat("ar-KW-u-nu-latn", { day: "numeric", month: "short", year: "numeric" });
const stockDateTimeFormatter = new Intl.DateTimeFormat("ar-KW-u-nu-latn", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function formatStockTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "غير مسجل" : stockDateTimeFormatter.format(date);
}

function formatSignedMoney(valueFils) {
  if (!valueFils) return formatMoney(0);
  return `${valueFils > 0 ? "\u200E+" : "\u200E−"}${formatMoney(Math.abs(valueFils))}`;
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value) || Math.abs(value) < .005) return "٠٪";
  return `${value > 0 ? "\u200E+" : "\u200E−"}${Math.abs(value).toLocaleString("ar-KW-u-nu-latn", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}٪`;
}

function stockPriceInput(priceTenths) {
  if (!Number.isSafeInteger(priceTenths) || priceTenths <= 0) return "";
  return (priceTenths / 10).toFixed(priceTenths % 10 ? 1 : 0);
}

function parseShareQuantity(value) {
  const normalized = normalizeDigits(String(value ?? "")).replaceAll("٬", "").replaceAll(",", "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const quantity = Number(normalized);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 100_000_000 ? quantity : null;
}

function formatDuration(months) {
  if (months === 0) return "مكتمل";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return `${months} شهر`;
  return rest ? `${years} سنة و${rest} شهر` : `${years} سنة`;
}

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function setText(selector, value) { $(selector).textContent = value; }

function currentMonthTransactions(kind = null) {
  const key = monthKey(new Date());
  return state.transactions.filter((item) => item.reviewed && monthKey(`${item.date}T12:00:00`) === key && (!kind || item.kind === kind));
}

function transactionFingerprint({ amountFils, merchant, date }) {
  return `${date}|${amountFils}|${merchantKey(merchant)}`;
}

function applyMerchantKnowledge(parsed) {
  const defaults = merchantDefaults(parsed.merchant, parsed.category);
  const learned = state.merchantRules.find((item) => item.key === defaults.key);
  return {
    ...parsed,
    rawMerchant: parsed.merchant,
    merchant: learned?.merchant ?? defaults.merchant,
    category: learned?.category ?? defaults.category
  };
}

function learnMerchant(record) {
  if (!["bank-text", "bank-statement"].includes(record.source) || !record.rawMerchant) return;
  const key = merchantKey(record.rawMerchant);
  if (!key) return;
  const rule = state.merchantRules.find((item) => item.key === key);
  const values = { key, merchant: record.merchant, category: record.category };
  if (rule) Object.assign(rule, values);
  else state.merchantRules.unshift(values);
  state.merchantRules = state.merchantRules.slice(0, 500);
}

function bankItemBase(item) {
  return transactionFingerprint({ amountFils: item.amountFils, merchant: item.rawMerchant || item.merchant, date: item.date });
}

function findNotificationDuplicate(fingerprints) {
  const strong = fingerprints.full !== fingerprints.base;
  const exact = strong
    ? state.transactions.find((item) => item.fingerprint === fingerprints.full)
    : state.transactions.find((item) => bankItemBase(item) === fingerprints.base && Date.now() - Date.parse(item.createdAt) < 180_000);
  if (exact) return { duplicate: exact };
  return { possibleDuplicate: state.transactions.some((item) => bankItemBase(item) === fingerprints.base) };
}

function queueNotification(notification) {
  const learned = notification.type === "purchase"
    ? applyMerchantKnowledge({ merchant: notification.rawMerchant, category: notification.category })
    : { merchant: notification.merchant, rawMerchant: notification.rawMerchant, category: notification.category };
  const fingerprints = notificationFingerprints({ ...notification, rawMerchant: learned.rawMerchant });
  const found = findNotificationDuplicate(fingerprints);
  if (found.duplicate) return { status: "duplicate", record: found.duplicate };
  const record = {
    id: createId(), amountFils: notification.amountFils, merchant: learned.merchant, rawMerchant: learned.rawMerchant,
    category: learned.category, kind: notification.kind, date: notification.dateISO, reviewed: false, source: "bank-text",
    fingerprint: fingerprints.full, notifBalanceFils: notification.balanceFils, cardLast4: notification.cardLast4 ?? "",
    possibleDuplicate: found.possibleDuplicate === true, createdAt: new Date().toISOString()
  };
  state.transactions.push(record);
  return { status: "queued", record };
}

function bankMessageHash(message) {
  const text = message.replace(/\s+/g, " ").trim();
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 + code, 2654435761) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function ingestBankText(raw, { fromFile = false } = {}) {
  const today = todayISO();
  const all = splitBankMessages(raw);
  const seen = new Set(state.ui.bankSeen);
  const messages = all.filter((message) => !seen.has(bankMessageHash(message)));
  const summary = { total: messages.length, alreadyRead: all.length - messages.length, queued: 0, duplicates: 0, possible: 0, ignored: [], manual: [] };
  if (fromFile) {
    // A file is re-read many times; remember every message so it is never added twice, even ones needing manual entry.
    state.ui.bankSeen = [...state.ui.bankSeen, ...messages.map(bankMessageHash)].slice(-3000);
  }
  for (const message of messages) {
    const { stampISO, body } = splitStamp(message);
    const notification = parseBankNotification(body, { todayISO: stampISO && stampISO <= today ? stampISO : today, fieldOrder: state.ui.bankFieldOrder });
    if (notification.ignored) { summary.ignored.push(NOTIFICATION_REASONS[notification.reason]); continue; }
    if (notification.needsManual) { summary.manual.push(notification); continue; }
    const result = queueNotification(notification);
    if (result.status === "duplicate") summary.duplicates += 1;
    else { summary.queued += 1; if (result.record.possibleDuplicate) summary.possible += 1; }
  }
  if (summary.queued || fromFile) { saveState(); renderAll(); }
  return summary;
}

function manualBankMessage(notification) {
  if (notification.reason === "foreign" && notification.foreign) {
    return `عملة أجنبية: ${notification.foreign.currency} ${notification.foreign.amount} — أضفها يدوياً بالدينار حسب مبلغ كشف البنك.`;
  }
  return `${NOTIFICATION_REASONS[notification.reason] ?? "ما قدرت أحدد العملية تلقائيًا"}. راجع النص أو أضفها يدويًا.`;
}

function showBankManual(notification) {
  $("#bank-form").reset();
  $("#bank-text").value = notification.raw;
  $("#bank-error").textContent = manualBankMessage(notification);
  renderBankPreview();
  openDialog($("#bank-dialog"));
}

function reportBankSummary(summary) {
  const parts = [];
  if (summary.queued) parts.push(summary.queued === 1 && summary.total === 1 ? "وصل إشعار بوبيان — راجعه واعتمده" : `أضفت ${summary.queued.toLocaleString("ar-KW-u-nu-latn")} للمراجعة`);
  if (summary.possible) parts.push(`${summary.possible.toLocaleString("ar-KW-u-nu-latn")} قد تكون مكررة`);
  if (summary.duplicates) parts.push(`${summary.duplicates.toLocaleString("ar-KW-u-nu-latn")} مكررة تجاهلتها`);
  if (summary.ignored.length) parts.push(summary.ignored[0] + (summary.ignored.length > 1 ? ` (+${(summary.ignored.length - 1).toLocaleString("ar-KW-u-nu-latn")})` : ""));
  if (!parts.length && summary.alreadyRead && !summary.manual.length) parts.push("ما فيه رسائل جديدة من آخر مرة");
  if (summary.queued) switchView("transactions");
  if (parts.length) toast(parts.join(" · "));
  if (summary.manual.length) showBankManual(summary.manual[0]);
}

function describeNotification(notification) {
  if (notification.ignored || notification.needsManual) return `⚠ ${escapeHTML(notification.reason === "foreign" && notification.foreign ? manualBankMessage(notification) : (NOTIFICATION_REASONS[notification.reason] ?? "غير معروف"))}`;
  const sign = notification.kind === "income" ? "\u200E+" : "\u200E−";
  const bits = [
    NOTIFICATION_TYPE_LABELS[notification.type] ?? "عملية",
    `${sign}${formatMoney(notification.amountFils)}`,
    `${notification.merchant} (${notification.category})`,
    `${formatDate(notification.dateISO)}${notification.dateAssumed ? " (اليوم افتراضياً)" : ""}`
  ];
  if (notification.balanceFils) bits.push(`رصيد ${formatMoney(notification.balanceFils)}`);
  if (notification.cardLast4) bits.push(`بطاقة ••${notification.cardLast4}`);
  return `✓ ${bits.map(escapeHTML).join(" · ")}`;
}

function renderBankPreview() {
  const box = $("#bank-preview");
  if (!box) return;
  const messages = splitBankMessages($("#bank-text").value);
  const today = todayISO();
  box.innerHTML = messages.slice(0, 5).map((message) => `<div>${describeNotification(parseBankNotification(splitStamp(message).body, { todayISO: today, fieldOrder: state.ui.bankFieldOrder }))}</div>`).join("") +
    (messages.length > 5 ? `<div>… و${(messages.length - 5).toLocaleString("ar-KW-u-nu-latn")} إشعارات أخرى</div>` : "");
}

function financialContext(today = todayISO()) {
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const commitments = commitmentSummary(state.monthlyCommitments, state.commitmentPayments, today);
  const debts = debtSummary(state.loans, { incomeFils, todayISO: today, payments: state.debtPayments });
  const safe = safeToSpendEngine({
    availableCashFils: state.settings.cashFils,
    safetyBufferFils: state.settings.safetyBufferFils,
    reservedCreditCardFils: state.settings.creditCardReserveFils,
    creditCards: state.creditCards,
    debts: state.loans,
    debtPayments: state.debtPayments,
    commitments: state.monthlyCommitments,
    commitmentPayments: state.commitmentPayments,
    salaryDay: state.settings.salaryDay,
    todayISO: today
  });
  const forecast = endOfMonthForecast({
    availableCashFils: state.settings.cashFils,
    transactions: state.transactions,
    debts: state.loans,
    debtPayments: state.debtPayments,
    commitments: state.monthlyCommitments,
    commitmentPayments: state.commitmentPayments,
    reservedCreditCardFils: safe?.reservedCreditCardFils ?? state.settings.creditCardReserveFils,
    todayISO: today
  });
  const bounds = monthBounds(today);
  const expenses = currentMonthTransactions("expense");
  const spentFils = expenses.reduce((sum, item) => sum + item.amountFils, 0);
  const weekDebt = debtOccurrences(state.loans, { fromISO: today, toISO: addDaysISO(today, 7), payments: state.debtPayments }).filter((item) => !item.paid);
  const weekCommitments = commitmentOccurrences(state.monthlyCommitments, { fromISO: today, toISO: addDaysISO(today, 7), payments: state.commitmentPayments }).filter((item) => !item.paid);
  const monthDebt = bounds ? debtOccurrences(state.loans, { fromISO: today, toISO: bounds.endISO, payments: state.debtPayments }).filter((item) => !item.paid) : [];
  const monthCommitments = bounds ? commitmentOccurrences(state.monthlyCommitments, { fromISO: today, toISO: bounds.endISO, payments: state.commitmentPayments }).filter((item) => !item.paid) : [];
  const activeWithMonths = state.loans.filter((item) => ["active", "overdue"].includes(item.status)).map((item) => ({ ...item, months: remainingInstallments(item) })).filter((item) => item.months !== null);
  return {
    todayISO: today,
    incomeFils,
    availableCashFils: state.settings.cashFils,
    commitments,
    debts,
    safe,
    forecast,
    expenses,
    spentFils,
    comparison: spendingComparison(state.transactions, today),
    flow: financialFlow({ incomeFils, debtPaymentsFils: debts.monthlyPaymentsFils, commitmentFils: commitments?.monthlyEquivalentFils ?? 0, expensesFils: spentFils }),
    weekDue: {
      debtCount: weekDebt.length,
      commitmentCount: weekCommitments.length,
      totalFils: weekDebt.reduce((sum, item) => sum + item.installmentFils, 0) + weekCommitments.reduce((sum, item) => sum + item.amountFils, 0)
    },
    monthDueFils: monthDebt.reduce((sum, item) => sum + item.installmentFils, 0) + monthCommitments.reduce((sum, item) => sum + item.amountFils, 0),
    firstDebt: activeWithMonths.sort((a, b) => a.months - b.months)[0] ?? null,
    largestDebt: [...state.loans].filter((item) => ["active", "overdue"].includes(item.status)).sort((a, b) => b.balanceFils - a.balanceFils)[0] ?? null,
    transactions: state.transactions,
    formatMoney,
    formatDate,
    alertCount: state.financialAlerts.filter((item) => item.active && !item.dismissedAt).length
  };
}

function syncFinancialAlerts(context) {
  const candidates = generateFinancialAlerts({
    todayISO: context.todayISO,
    debts: state.loans,
    debtPayments: state.debtPayments,
    commitments: state.monthlyCommitments,
    commitmentPayments: state.commitmentPayments,
    transactions: state.transactions,
    budgetFils: state.settings.budgetFils,
    forecast: context.forecast
  });
  const merged = mergeFinancialAlerts(state.financialAlerts, candidates, context.todayISO);
  if (JSON.stringify(merged) !== JSON.stringify(state.financialAlerts)) {
    state.financialAlerts = merged;
    saveState();
  }
}

function renderFinancialAlerts() {
  const alerts = state.financialAlerts.filter((item) => item.active && !item.dismissedAt).slice(0, 5);
  $("#financial-alerts-panel").hidden = alerts.length === 0;
  setText("#financial-alert-count", alerts.length.toLocaleString("ar-KW-u-nu-latn"));
  $("#financial-alert-list").innerHTML = alerts.map((alert) => `
    <article class="financial-alert ${escapeHTML(alert.severity ?? "info")}">
      <span class="alert-icon">${alert.severity === "danger" ? "!" : alert.severity === "positive" ? "✓" : "◷"}</span>
      <div><strong>${escapeHTML(alert.title)}</strong><small>${escapeHTML(alert.message)}${alert.amountFils ? ` · ${escapeHTML(formatMoney(alert.amountFils))}` : ""}</small></div>
      <button type="button" class="dismiss-alert" data-dismiss-alert="${escapeHTML(alert.id)}" aria-label="إخفاء التنبيه">×</button>
    </article>`).join("");
}

function renderDashboard() {
  const context = financialContext();
  syncFinancialAlerts(context);
  context.alertCount = state.financialAlerts.filter((item) => item.active && !item.dismissedAt).length;
  const todaySpent = context.expenses.filter((item) => item.date === context.todayISO).reduce((sum, item) => sum + item.amountFils, 0);
  const netWorth = state.settings.cashFils + state.settings.investedFils + state.settings.assetsFils - context.debts.totalBalanceFils;
  const budget = state.settings.budgetFils;
  const budgetRatio = budget > 0 ? context.spentFils / budget : 0;
  const safeToday = context.safe?.dailySafeFils ?? 0;
  const dailyRemaining = safeToday - todaySpent;
  const dailyRatio = safeToday > 0 ? todaySpent / safeToday : 0;

  setText("#today-spend", formatMoney(todaySpent));
  setText("#month-spend", formatMoney(context.spentFils));
  setText("#total-debt", formatMoney(context.debts.totalBalanceFils));
  setText("#net-worth", formatMoney(netWorth));
  setText("#budget-remaining", formatMoney(context.safe?.safeFils ?? 0));
  setText("#safe-cash", formatMoney(state.settings.cashFils));
  setText("#safe-installments", formatMoney(context.safe?.upcomingDebtPaymentsFils ?? 0));
  setText("#safe-commitments", formatMoney(context.safe?.upcomingCommitmentsFils ?? 0));
  setText("#safe-cards", formatMoney(context.safe?.reservedCreditCardFils ?? 0));
  setText("#safe-buffer", formatMoney(state.settings.safetyBufferFils));
  if (context.safe?.shortfallFils > 0) setText("#budget-caption", `عندك عجز محجوز قدره ${formatMoney(context.safe.shortfallFils)} قبل أي صرف جديد`);
  else if (context.safe) setText("#budget-caption", `متاح حتى دخل ${formatDate(context.safe.paydayISO)} · بعد حجز كل المستحقات`);

  setText("#budget-percent", `${Math.round(budgetRatio * 100).toLocaleString("ar-KW-u-nu-latn")}٪`);
  setText("#budget-spent-label", `صرفت ${formatMoney(context.spentFils)}`);
  setText("#budget-limit-label", `من ${formatMoney(budget)}`);
  $("#budget-progress").style.width = `${Math.min(Math.max(budgetRatio * 100, 0), 100)}%`;

  const dailyCard = $("#daily-budget-card");
  setText("#daily-limit", formatMoney(safeToday));
  setText("#daily-remaining", formatMoney(dailyRemaining));
  setText("#days-remaining", (context.safe?.daysUntilPayday ?? 0).toLocaleString("ar-KW-u-nu-latn"));
  $("#daily-progress").style.width = `${Math.min(Math.max(dailyRatio * 100, 0), 100)}%`;
  dailyCard.classList.toggle("over-budget", dailyRemaining < 0);
  if (!context.incomeFils || !state.settings.cashFils) {
    setText("#daily-status", "بيانات ناقصة");
    setText("#daily-guidance", "أضف دخلك ورصيدك الحالي من الإعدادات حتى نحسب المتاح اليوم بدقة.");
  } else if (context.safe?.shortfallFils > 0 || dailyRemaining < 0) {
    setText("#daily-status", "يحتاج انتباه");
    setText("#daily-guidance", `التزاماتك المحجوزة أعلى من المساحة الآمنة للصرف بـ ${formatMoney(Math.max(context.safe?.shortfallFils ?? 0, Math.abs(dailyRemaining)))}.`);
  } else {
    setText("#daily-status", "ضمن المسار");
    setText("#daily-guidance", `تقدر تصرف حتى ${formatMoney(Math.max(dailyRemaining, 0))} اليوم وتبقى التزاماتك محجوزة.`);
  }

  setText("#flow-income", formatMoney(context.flow.incomeFils));
  setText("#flow-debts", formatMoney(context.flow.debtPaymentsFils));
  setText("#flow-commitments", formatMoney(context.flow.commitmentFils));
  setText("#flow-expenses", formatMoney(context.flow.expensesFils));
  setText("#flow-available", formatMoney(context.flow.availableFils));

  if (context.forecast?.sufficient) {
    setText("#forecast-status", "تقديري");
    setText("#forecast-balance", formatMoney(context.forecast.forecastAvailableFils));
    setText("#forecast-message", `إذا استمر صرفك بمتوسط ${formatMoney(context.forecast.averageDailyFils)} يومياً، فهذا هو المتاح المتوقع بنهاية الشهر.`);
  } else {
    setText("#forecast-status", "بيانات غير كافية");
    setText("#forecast-balance", "—");
    setText("#forecast-message", context.forecast?.reason ?? "نحتاج بيانات أكثر لبناء توقع.");
  }

  const categoryMap = new Map();
  context.expenses.forEach((item) => categoryMap.set(item.category, (categoryMap.get(item.category) ?? 0) + item.amountFils));
  const categoryData = [...categoryMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const categoryChart = $("#category-chart");
  if (!categoryData.length) categoryChart.innerHTML = '<div class="empty-inline">بعد ما عندنا صرف معتمد لهذا الشهر.</div>';
  else {
    const highest = categoryData[0][1];
    categoryChart.innerHTML = categoryData.map(([category, amount]) => `<div class="category-row"><span>${escapeHTML(category)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, amount / highest * 100)}%"></div></div><strong>${escapeHTML(formatMoney(amount))}</strong></div>`).join("");
  }

  const pending = state.transactions.filter((item) => !item.reviewed).length;
  let message = "أضف أول عملية عشان أبدأ أحلل صرفك.";
  if (pending) message = `عندك ${pending.toLocaleString("ar-KW-u-nu-latn")} عملية تحتاج مراجعة قبل تدخل في حساباتك.`;
  else if (context.alertCount) message = `عندك ${context.alertCount.toLocaleString("ar-KW-u-nu-latn")} تنبيه مالي جديد يستحق المراجعة.`;
  else if (categoryData.length) message = `أكثر صرفك هذا الشهر على ${categoryData[0][0]}: ${formatMoney(categoryData[0][1])}.`;
  else if (context.debts.dtiPercent !== null) message = `نسبة أقساطك إلى دخلك ${Math.round(context.debts.dtiPercent).toLocaleString("ar-KW-u-nu-latn")}٪.`;
  setText("#coach-message", message);
  renderSpendingBehavior();
  renderFinancialAlerts();
}

function renderSpendingBehavior() {
  const report = analyzeSpendingBehavior(state.transactions, { todayISO: todayISO(), salaryDay: state.settings.salaryDay });
  const hasImportedStatement = state.statementImport.importedCount > 0;
  const hasData = hasImportedStatement && report?.count > 0;
  $("#behavior-empty").hidden = hasData;
  $("#behavior-content").hidden = !hasData;
  if (!hasData) {
    if (hasImportedStatement) $("#behavior-empty strong").textContent = "ما عندنا مصروفات معتمدة ضمن الفترة";
    return;
  }
  $("#behavior-empty strong").textContent = "ما عندنا كشف 12 شهر للحين";
  setText("#behavior-total", formatMoney(report.totalFils));
  setText("#behavior-average", formatMoney(report.monthlyAverageFils));
  setText("#behavior-count", report.count.toLocaleString("ar-KW-u-nu-latn"));
  setText("#behavior-top-category", report.categories[0]?.name ?? "—");
  const maximum = Math.max(...report.monthly.map((item) => item.totalFils), 1);
  $("#behavior-month-chart").innerHTML = report.monthly.map((item) => `
    <div class="behavior-month-row"><span>${escapeHTML(item.label)}</span><div class="behavior-month-bar"><i style="width:${Math.max(item.totalFils ? 3 : 0, item.totalFils / maximum * 100)}%"></i></div><strong>${escapeHTML(formatMoney(item.totalFils))}</strong></div>`).join("");
  const insights = report.insights.length ? report.insights : ["ما ظهر نمط متكرر كافٍ حتى الآن؛ راجع التصنيفات بعد الاستيراد لتتحسن القراءة."];
  $("#behavior-insights").innerHTML = insights.map((item) => `<li>${escapeHTML(item)}</li>`).join("");
  const repeated = report.merchants.slice(0, 3);
  $("#behavior-repeat-section").hidden = repeated.length === 0;
  $("#behavior-repeat-list").innerHTML = repeated.map((item) => `
    <div class="behavior-repeat-row"><span><strong>${escapeHTML(item.merchant)}</strong><small>${item.count.toLocaleString("ar-KW-u-nu-latn")} عمليات · ${item.months.toLocaleString("ar-KW-u-nu-latn")} أشهر</small></span><strong>${escapeHTML(formatMoney(item.averagePerRecordedMonthFils))}<small>لكل شهر ظهر فيه</small></strong></div>`).join("");
  $("#behavior-category-change-section").hidden = report.categoryChanges.length === 0;
  $("#behavior-category-change-list").innerHTML = report.categoryChanges.map((item) => `
    <div class="behavior-repeat-row"><span><strong>${escapeHTML(item.name)}</strong><small>متوسط الشهر: ${escapeHTML(formatMoney(item.previousAverageFils))} ← ${escapeHTML(formatMoney(item.recentAverageFils))}</small></span><strong class="behavior-change">+${Math.round(item.changePercent).toLocaleString("ar-KW-u-nu-latn")}٪</strong></div>`).join("");
  const importedStart = state.statementImport.coverageStartISO || report.fromISO;
  const importedEnd = state.statementImport.coverageEndISO || report.toISO;
  const firstTransaction = report.recordedStartISO ? formatDate(report.recordedStartISO) : formatDate(importedStart);
  const lastTransaction = report.recordedEndISO ? formatDate(report.recordedEndISO) : formatDate(importedEnd);
  setText("#behavior-coverage", `نافذة التحليل: ${formatDate(report.fromISO)} إلى ${formatDate(report.toISO)} · أقدم وآخر حركة مسجلة: ${firstTransaction} إلى ${lastTransaction} · ${report.activeMonths.toLocaleString("ar-KW-u-nu-latn")} أشهر فيها مصروفات من ${report.count.toLocaleString("ar-KW-u-nu-latn")} عملية معتمدة. تأكد أن ملف البنك يغطي الفترة كاملة؛ الشهر الخالي من العمليات قد يكون بلا صرف أو خارج الملف.`);
}

function renderTransactions() {
  const query = $("#transaction-search").value.trim().toLowerCase();
  const filter = $("#transaction-kind-filter").value;
  const filtered = state.transactions
    .filter((item) => !query || `${item.merchant} ${item.category}`.toLowerCase().includes(query))
    .filter((item) => filter === "all" || (filter === "pending" ? !item.reviewed : item.kind === filter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const pendingItems = state.transactions
    .filter((item) => !item.reviewed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = pendingItems.length;
  $("#pending-inbox").hidden = pending === 0;
  setText("#pending-count", pending.toLocaleString("ar-KW-u-nu-latn"));
  renderBankCard();
  $("#pending-inbox-list").innerHTML = (pending > 1 ? `<button type="button" class="secondary approve-all" data-approve-all="1">اعتماد الكل (بدون المشكوك فيها)</button>` : "") + pendingItems.map((item) => `
    <article class="pending-inbox-item">
      <div><strong>${escapeHTML(item.merchant)}</strong><small>${escapeHTML(item.category)} · ${escapeHTML(formatDate(item.date))}${item.cardLast4 ? ` · بطاقة ••${escapeHTML(item.cardLast4)}` : ""}</small>${item.possibleDuplicate ? '<span class="pending-badge">قد تكون مكررة</span>' : ""}</div>
      <div class="pending-inbox-amount ${item.kind === "income" ? "income" : ""}">${item.kind === "income" ? "\u200E+" : "\u200E−"}${escapeHTML(formatMoney(item.amountFils))}</div>
      ${item.notifBalanceFils ? `<button type="button" class="ghost small sync-balance" data-sync-balance="${escapeHTML(item.id)}">الرصيد بالإشعار ${escapeHTML(formatMoney(item.notifBalanceFils))} — تحديث رصيدي</button>` : ""}
      <div class="pending-inbox-actions">
        <button type="button" class="primary" data-approve-pending="${escapeHTML(item.id)}">اعتماد</button>
        <button type="button" class="secondary" data-review-pending="${escapeHTML(item.id)}">تعديل ومراجعة</button>
      </div>
    </article>`).join("");
  const pendingNotice = $("#pending-notice");
  pendingNotice.hidden = true;
  pendingNotice.textContent = "";
  $("#transaction-empty").hidden = filtered.length > 0;
  $("#transaction-list").innerHTML = filtered.map((item) => `
    <article class="transaction-item" data-id="${escapeHTML(item.id)}">
      <div class="transaction-icon ${item.kind === "income" ? "income" : ""}">${item.kind === "income" ? "↓" : "↑"}</div>
      <div class="transaction-main">
        <strong>${escapeHTML(item.merchant)}</strong>
        <small>${escapeHTML(item.category)} · ${escapeHTML(formatDate(item.date))}</small>
        ${item.reviewed ? "" : '<span class="pending-badge">تحتاج مراجعة</span>'}
      </div>
      <div>
        <div class="transaction-amount ${item.kind === "income" ? "income" : ""}">${item.kind === "income" ? "\u200E+" : "\u200E−"}${escapeHTML(formatMoney(item.amountFils))}</div>
        <div class="item-actions"><button data-edit-transaction="${escapeHTML(item.id)}">${item.reviewed ? "تعديل" : "مراجعة"}</button><button class="delete" data-delete-transaction="${escapeHTML(item.id)}">حذف</button></div>
      </div>
    </article>`).join("");
}

function paymentMethodLabel(value) {
  return { bank: "حساب بنكي", credit_card: "بطاقة ائتمان", cash: "نقدي", other: "أخرى" }[value] ?? "أخرى";
}

function commitmentStatusInfo(commitment, today = todayISO()) {
  const bounds = monthBounds(today);
  const monthOccurrences = bounds ? commitmentOccurrences([commitment], { fromISO: bounds.startISO, toISO: bounds.endISO, payments: state.commitmentPayments, includePaused: true }) : [];
  const current = monthOccurrences[0] ?? null;
  if (commitment.status === "paused") return { key: "paused", label: "متوقف مؤقتاً", occurrence: current };
  if (commitment.status === "completed") return { key: "completed", label: "مكتمل", occurrence: current };
  if (current?.paid) return { key: "paid", label: "مدفوع هذا الشهر", occurrence: current };
  return { key: "active", label: "نشط", occurrence: current };
}

function nextCommitmentOccurrence(commitment, today = todayISO()) {
  return commitmentOccurrences([commitment], { fromISO: today, toISO: addDaysISO(today, 730), payments: state.commitmentPayments, includePaused: true })
    .find((item) => !item.paid) ?? null;
}

function renderCommitments() {
  const today = todayISO();
  const summary = commitmentSummary(state.monthlyCommitments, state.commitmentPayments, today);
  const income = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const debts = debtSummary(state.loans, { incomeFils: income, todayISO: today, payments: state.debtPayments });
  setText("#commitments-monthly-total", formatMoney(summary?.monthlyEquivalentFils ?? 0));
  setText("#commitments-paid-total", formatMoney(summary?.paidThisMonthFils ?? 0));
  setText("#commitments-remaining-total", formatMoney(summary?.remainingThisMonthFils ?? 0));
  setText("#income-after-fixed", formatMoney(Math.max(income - debts.monthlyPaymentsFils - (summary?.monthlyEquivalentFils ?? 0), 0)));
  setText("#next-commitment-name", summary?.nextUpcoming?.name ?? "لا يوجد");
  setText("#next-commitment-detail", summary?.nextUpcoming ? `${formatDate(summary.nextUpcoming.dueDate)} · ${formatMoney(summary.nextUpcoming.amountFils)}` : "ما عندك التزام نشط قادم.");

  const query = $("#commitment-search").value.trim().toLowerCase();
  const categoryFilter = $("#commitment-category-filter").value;
  const statusFilter = $("#commitment-status-filter").value;
  const filtered = state.monthlyCommitments.filter((commitment) => {
    const status = commitmentStatusInfo(commitment, today);
    return (!query || `${commitment.name} ${commitment.category} ${commitment.notes}`.toLowerCase().includes(query)) &&
      (categoryFilter === "all" || commitment.category === categoryFilter) &&
      (statusFilter === "all" || status.key === statusFilter);
  }).sort((a, b) => (nextCommitmentOccurrence(a, today)?.dueDate ?? "9999").localeCompare(nextCommitmentOccurrence(b, today)?.dueDate ?? "9999"));

  $("#commitment-empty").hidden = state.monthlyCommitments.length > 0;
  $("#commitment-list").innerHTML = filtered.map((commitment) => {
    const status = commitmentStatusInfo(commitment, today);
    const next = nextCommitmentOccurrence(commitment, today);
    const monthlyEquivalent = monthlyCommitmentEquivalent(commitment);
    const markOccurrence = status.occurrence ?? next;
    return `<article class="data-card commitment-card">
      <div class="card-head"><div><h3>${escapeHTML(commitment.name)}</h3><div class="commitment-meta"><span>${escapeHTML(commitment.category)}</span><span>${escapeHTML(commitmentRecurrences[commitment.recurrence])}</span><span>${escapeHTML(paymentMethodLabel(commitment.paymentMethod))}</span></div></div><div><span class="card-status ${status.key}">${status.label}</span><div class="amount">${escapeHTML(formatMoney(commitment.amountFils))}</div></div></div>
      <div class="card-summary-grid">
        <div><span>الاستحقاق القادم</span><strong>${next ? escapeHTML(formatDate(next.dueDate)) : "—"}</strong></div>
        <div><span>المتوسط الشهري</span><strong>${escapeHTML(formatMoney(monthlyEquivalent))}</strong></div>
        <div><span>ملاحظة</span><strong>${escapeHTML(commitment.notes || "—")}</strong></div>
      </div>
      <div class="item-actions">
        <button data-edit-commitment="${escapeHTML(commitment.id)}">تعديل</button>
        ${commitment.status === "active" && markOccurrence ? `<button class="commitment-paid-toggle ${markOccurrence.paid ? "is-paid" : ""}" role="checkbox" aria-checked="${markOccurrence.paid ? "true" : "false"}" aria-label="${markOccurrence.paid ? "إلغاء تسجيل دفع" : "تسجيل الدفع"}: ${escapeHTML(commitment.name)}" data-toggle-commitment-paid="${escapeHTML(commitment.id)}" data-due-date="${escapeHTML(markOccurrence.dueDate)}"><span aria-hidden="true">${markOccurrence.paid ? "✓" : "○"}</span>${markOccurrence.paid ? "مدفوع" : "تم الدفع"}</button>` : ""}
        <button data-toggle-commitment="${escapeHTML(commitment.id)}">${commitment.status === "paused" ? "إعادة تفعيل" : "إيقاف مؤقت"}</button>
        <button class="delete" data-delete-commitment="${escapeHTML(commitment.id)}">حذف</button>
      </div>
    </article>`;
  }).join("");
  if (state.monthlyCommitments.length && !filtered.length) $("#commitment-list").innerHTML = '<div class="empty-inline">ما لقينا التزام يطابق البحث أو الفلتر.</div>';
}

function debtStatusLabel(status) {
  return { active: "نشط", completed: "مكتمل", overdue: "متأخر", stopped: "متوقف" }[status] ?? "نشط";
}

function dtiDescription(percent) {
  if (percent === null) return "أضف دخلك لحساب النسبة";
  if (percent < 20) return "مساحة مريحة نسبياً ضمن دخلك";
  if (percent <= 35) return "نسبة متوسطة؛ راقب الالتزامات الجديدة";
  return "جزء كبير من الدخل يذهب للأقساط؛ خطط لأي التزام جديد بحذر";
}

function renderLoans() {
  const today = todayISO();
  const income = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const summary = debtSummary(state.loans, { incomeFils: income, todayISO: today, payments: state.debtPayments });
  setText("#loans-total", formatMoney(summary.totalBalanceFils));
  setText("#installments-total", formatMoney(summary.monthlyPaymentsFils));
  setText("#active-loans-count", summary.activeCount.toLocaleString("ar-KW-u-nu-latn"));
  setText("#next-installment", summary.nextPayment ? `${formatMoney(summary.nextPayment.installmentFils)} · ${formatDate(summary.nextPayment.dueDate)}` : "لا يوجد");
  setText("#zero-debt-date", summary.activeCount ? (summary.zeroDebtDate ? formatDate(summary.zeroDebtDate) : "بيانات ناقصة") : "بدون ديون 🎉");
  setText("#debt-income-ratio", summary.dtiPercent === null ? "—" : `${Math.round(summary.dtiPercent).toLocaleString("ar-KW-u-nu-latn")}٪`);
  setText("#dti-caption", dtiDescription(summary.dtiPercent));
  $("#global-extra").value = moneyInput(state.ui.extraFils);
  $("#loan-empty").hidden = state.loans.length > 0;
  $("#loan-list").innerHTML = state.loans.map((loan) => {
    const progress = debtProgress(loan);
    const remaining = remainingInstallments(loan);
    const calculatedEnd = loan.endDate || (remaining !== null ? addMonthsISO(today, remaining) : "");
    const next = debtOccurrences([loan], { fromISO: today, toISO: addDaysISO(today, 62), payments: state.debtPayments }).find((item) => !item.paid);
    const base = payoff({ balanceFils: loan.balanceFils, installmentFils: loan.installmentFils, annualRate: loan.annualRate });
    const faster = payoff({ balanceFils: loan.balanceFils, installmentFils: loan.installmentFils, extraFils: state.ui.extraFils, annualRate: loan.annualRate });
    const globalSimulation = state.ui.extraFils > 0 && base && faster ? `<div class="detail-grid"><div class="detail"><span>بدون زيادة</span><strong>${formatDuration(base.months)}</strong></div><div class="detail"><span>مع ${escapeHTML(formatMoney(state.ui.extraFils))}</span><strong>${formatDuration(faster.months)}</strong></div><div class="detail"><span>أشهر أقل</span><strong>${Math.max(base.months - faster.months, 0).toLocaleString("ar-KW-u-nu-latn")}</strong></div><div class="detail"><span>فرق رسوم تقديري</span><strong>${loan.annualRate > 0 ? escapeHTML(formatMoney(Math.max(base.chargesFils - faster.chargesFils, 0))) : "لا ينطبق"}</strong></div></div>` : "";
    return `<article class="data-card debt-card">
      <div class="card-head"><div><h3>${escapeHTML(loan.name)}</h3><div class="debt-meta"><span>${escapeHTML(loan.lender || "الجهة غير محددة")}</span><span>${escapeHTML(loan.type)}</span><span>الخصم يوم ${loan.dueDay.toLocaleString("ar-KW-u-nu-latn")}</span></div></div><span class="card-status ${escapeHTML(loan.status)}">${debtStatusLabel(loan.status)}</span></div>
      <div class="debt-progress-label"><span>تم سداد ${progress.percent.toLocaleString("ar-KW-u-nu-latn")}٪</span><strong>${escapeHTML(formatMoney(progress.paidFils))}</strong></div>
      <div class="progress large"><span style="width:${progress.percent}%"></span></div>
      <div class="card-summary-grid">
        <div><span>المتبقي</span><strong>${escapeHTML(formatMoney(loan.balanceFils))}</strong></div>
        <div><span>القسط</span><strong>${escapeHTML(formatMoney(loan.installmentFils))}</strong></div>
        <div><span>الأقساط المتبقية</span><strong>${remaining === null ? "غير واضح" : remaining.toLocaleString("ar-KW-u-nu-latn")}</strong></div>
      </div>
      <details class="debt-details"><summary>عرض تفاصيل القرض والمحاكاة</summary><div class="detail-grid">
        <div class="detail"><span>المبلغ الأصلي</span><strong>${escapeHTML(formatMoney(progress.originalAmountFils))}</strong></div>
        <div class="detail"><span>إجمالي المدفوع</span><strong>${escapeHTML(formatMoney(progress.paidFils))}</strong></div>
        <div class="detail"><span>القسط القادم</span><strong>${next ? escapeHTML(formatDate(next.dueDate)) : "—"}</strong></div>
        <div class="detail"><span>النهاية ${loan.endDate ? "المسجلة" : "التقديرية"}</span><strong>${calculatedEnd ? escapeHTML(formatDate(calculatedEnd)) : "غير واضحة"}</strong></div>
      </div>${globalSimulation}</details>
      <div class="item-actions"><button data-edit-loan="${escapeHTML(loan.id)}">تعديل</button>${["active", "overdue"].includes(loan.status) ? `<button data-extra-payment="${escapeHTML(loan.id)}">دفعة إضافية</button>` : ""}<button class="delete" data-delete-loan="${escapeHTML(loan.id)}">حذف</button></div>
    </article>`;
  }).join("");
}

function renderStockSelector(filter = "", selectedCode = "") {
  const normalizedFilter = normalizeDigits(filter).trim().toLocaleLowerCase("ar");
  const matches = kuwaitStocks.filter((stock) => !normalizedFilter ||
    `${stock.name} ${stock.ticker} ${stock.code}`.toLocaleLowerCase("ar").includes(normalizedFilter));
  const select = $("#stock-security");
  select.innerHTML = `<option value="">اختر من ${kuwaitStocks.length.toLocaleString("ar-KW-u-nu-latn")} سهماً مدرجاً</option>${matches.map((stock) =>
    `<option value="${escapeHTML(stock.code)}">${escapeHTML(stock.name)} — ${escapeHTML(stock.ticker)} (${escapeHTML(stock.code)})</option>`
  ).join("")}${matches.length ? "" : '<option value="" disabled>ما لقينا سهماً مطابقاً</option>'}`;
  if (matches.some((stock) => stock.code === selectedCode)) select.value = selectedCode;
  setText("#stock-list-date", `قائمة بورصة الكويت الرسمية: ${kuwaitStocks.length.toLocaleString("ar-KW-u-nu-latn")} شركة · محدثة ${formatDate(KUWAIT_STOCKS_AS_OF)}`);
}

function updateStockPreview() {
  const quantity = parseShareQuantity($("#stock-quantity").value);
  const purchasePriceTenths = parseSharePriceTenths($("#stock-purchase-price").value);
  const feesFils = parseMoney($("#stock-fees").value);
  const currentPriceTenths = parseSharePriceTenths($("#stock-current-price").value);
  const position = quantity && purchasePriceTenths && feesFils !== null && currentPriceTenths
    ? calculateStockPosition({ quantity, purchasePriceTenths, feesFils, currentPriceTenths })
    : null;
  setText("#stock-preview-cost", position ? formatMoney(position.totalCostFils) : "—");
  setText("#stock-preview-break-even", position ? formatSharePrice(position.breakEvenPriceTenths) : "—");
  setText("#stock-preview-profit", position ? `${formatSignedMoney(position.profitLossFils)} (${formatSignedPercent(position.profitLossPercent)})` : "—");
  const profit = $("#stock-preview-profit");
  profit.classList.toggle("stock-positive", Boolean(position && position.profitLossFils > 0));
  profit.classList.toggle("stock-negative", Boolean(position && position.profitLossFils < 0));
}

function openStock(holding = null) {
  $("#stock-form").reset();
  $("#stock-error").textContent = "";
  $("#stock-dialog-title").textContent = holding ? "تعديل السهم" : "إضافة سهم كويتي";
  $("#stock-id").value = holding?.id ?? "";
  $("#stock-search").value = "";
  renderStockSelector("", holding?.securityCode ?? "");
  $("#stock-quantity").value = holding?.quantity ?? "";
  $("#stock-purchase-price").value = stockPriceInput(holding?.purchasePriceTenths);
  $("#stock-fees").value = holding ? moneyInput(holding.feesFils) : "0.000";
  $("#stock-current-price").value = stockPriceInput(holding?.currentPriceTenths);
  updateStockPreview();
  openDialog($("#stock-dialog"));
}

function submitStock(event) {
  event.preventDefault();
  const security = getKuwaitStock($("#stock-security").value);
  const quantity = parseShareQuantity($("#stock-quantity").value);
  const purchasePriceTenths = parseSharePriceTenths($("#stock-purchase-price").value);
  const feesFils = parseMoney($("#stock-fees").value);
  const currentPriceTenths = parseSharePriceTenths($("#stock-current-price").value);
  const position = quantity && purchasePriceTenths && feesFils !== null && currentPriceTenths
    ? calculateStockPosition({ quantity, purchasePriceTenths, feesFils, currentPriceTenths })
    : null;
  if (!security || !position) {
    $("#stock-error").textContent = "اختر السهم وراجع العدد والأسعار والرسوم. أسعار الأسهم تُكتب بالفلس وتقبل منزلة عشرية واحدة.";
    return;
  }
  const id = $("#stock-id").value;
  const existing = state.stockHoldings.find((item) => item.id === id);
  const now = new Date().toISOString();
  const record = {
    id: existing?.id ?? createId(), securityCode: security.code, quantity, purchasePriceTenths, feesFils,
    currentPriceTenths, priceUpdatedAt: now, createdAt: existing?.createdAt ?? now
  };
  if (existing) Object.assign(existing, record); else state.stockHoldings.push(record);
  saveState(); renderAll(); closeDialog($("#stock-dialog"));
  toast(existing ? `تم تحديث ${security.name}` : `تمت إضافة ${security.name}`);
}

function openAverageDown(holding, buyPriceTenths = null) {
  if (!holding) return;
  $("#average-down-form").reset();
  $("#average-stock-id").value = holding.id;
  setText("#average-stock-name", getKuwaitStock(holding.securityCode)?.name ?? "");
  const position = calculateStockPosition(holding);
  setText("#average-current-summary", `تملك ${holding.quantity.toLocaleString("ar-KW-u-nu-latn")} سهم · تكلفة السهم مع الرسوم: ${formatSharePrice(position.averageCostPriceTenths)} · آخر سعر مسجل: ${formatSharePrice(holding.currentPriceTenths)}`);
  $("#average-buy-price").value = stockPriceInput(buyPriceTenths ?? holding.currentPriceTenths);
  $("#average-target-price").value = stockPriceInput(holding.currentPriceTenths);
  $("#average-extra-fees").value = "0.000";
  updateAverageDown();
  openDialog($("#average-down-dialog"));
}

function updateAverageDown() {
  const holding = state.stockHoldings.find((item) => item.id === $("#average-stock-id").value);
  if (!holding) return;
  const buyPriceTenths = parseSharePriceTenths($("#average-buy-price").value);
  const targetPriceTenths = parseSharePriceTenths($("#average-target-price").value);
  const additionalFeesFils = parseMoney($("#average-extra-fees").value);
  const result = calculateAverageDown({ ...holding, buyPriceTenths, targetPriceTenths, additionalFeesFils });
  const budgetFils = parseMoney($("#average-budget").value);
  const budget = calculateStockBudget({ ...holding, buyPriceTenths, budgetFils, additionalFeesFils });
  $("#average-budget-results").hidden = budget.status !== "ok";
  if (budget.status === "ok") {
    setText("#average-budget-shares", budget.additionalQuantity.toLocaleString("ar-KW-u-nu-latn"));
    setText("#average-budget-spent", formatMoney(budget.spentFils));
    setText("#average-budget-remaining", formatMoney(budget.remainingFils));
    setText("#average-budget-cost", formatSharePrice(budget.newAveragePriceTenths));
    setText("#average-budget-message", "الحساب بأسهم كاملة، مع خصم الرسوم الإضافية من ميزانيتك.");
  } else {
    setText("#average-budget-message", budget.status === "insufficient" ? "المبلغ لا يكفي لشراء سهم واحد بعد الرسوم." : budget.status === "too_large" ? "المبلغ يتجاوز حدود الحاسبة." : "أدخل المبلغ بالدينار وسعر الشراء والرسوم لرؤية النتيجة.");
  }
  $("#average-results").hidden = result.status !== "ok";
  const messages = {
    invalid: "أدخل سعر الشراء والمتوسط المطلوب بالفلس، والرسوم بالدينار.",
    already_reached: "تكلفتك الحالية عند أو أقل من المتوسط المطلوب؛ لا تحتاج أسهماً إضافية لتحقيقه.",
    unreachable: "لا توجد كمية محدودة تحقق هذا المتوسط: اجعل سعر الشراء الإضافي أقل من المتوسط المطلوب.",
    too_large: "الكمية المطلوبة تتجاوز حدود الحاسبة. اختر متوسطاً أقرب لتكلفتك الحالية."
  };
  if (result.status !== "ok") { setText("#average-message", messages[result.status]); return; }
  setText("#average-shares", result.additionalQuantity.toLocaleString("ar-KW-u-nu-latn"));
  setText("#average-amount", formatMoney(result.additionalAmountFils));
  setText("#average-new-cost", formatSharePrice(result.newAveragePriceTenths));
  setText("#average-message", `هذه أقل كمية أسهم كاملة للوصول إلى المتوسط المطلوب أو أقل منه. إجمالي الأسهم بعدها: ${result.totalQuantity.toLocaleString("ar-KW-u-nu-latn")}. الرسوم مبلغ ثابت حسب إدخالك؛ عدّلها إذا تغيرت مع حجم الصفقة.`);
}

function renderStockPortfolio() {
  const holdings = state.stockHoldings.map((holding) => ({
    holding,
    security: getKuwaitStock(holding.securityCode),
    position: calculateStockPosition(holding)
  })).filter((item) => item.security && item.position);
  $("#stock-empty").hidden = holdings.length > 0;
  setText("#stock-holdings-count", holdings.length ? `${holdings.length.toLocaleString("ar-KW-u-nu-latn")} مركز استثماري` : "لا توجد أسهم");
  const totals = holdings.reduce((sum, item) => ({
    costFils: sum.costFils + item.position.totalCostFils,
    currentFils: sum.currentFils + item.position.currentValueFils
  }), { costFils: 0, currentFils: 0 });
  const profitFils = totals.currentFils - totals.costFils;
  const percent = totals.costFils ? profitFils / totals.costFils * 100 : 0;
  setText("#stock-total-cost", formatMoney(totals.costFils));
  setText("#stock-current-value", formatMoney(totals.currentFils));
  setText("#stock-total-profit", formatSignedMoney(profitFils));
  setText("#stock-total-percent", formatSignedPercent(percent));
  [$("#stock-total-profit"), $("#stock-total-percent")].forEach((element) => {
    element.classList.toggle("stock-positive", profitFils > 0);
    element.classList.toggle("stock-negative", profitFils < 0);
  });
  $("#stock-list").innerHTML = holdings.map(({ holding, security, position }) => {
    const resultClass = position.profitLossFils > 0 ? "stock-positive" : position.profitLossFils < 0 ? "stock-negative" : "";
    const breakEvenCaption = position.riseNeededPercent > 0
      ? `يحتاج ارتفاع ${position.riseNeededPercent.toLocaleString("ar-KW-u-nu-latn", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}٪ من السعر الحالي`
      : "السعر الحالي عند أو فوق التعادل";
    return `<article class="data-card stock-card">
      <div class="card-head"><div><h3>${escapeHTML(security.name)}</h3><div class="stock-symbol"><b>${escapeHTML(security.ticker)}</b><span>رمز ${escapeHTML(security.code)}</span></div></div><strong class="stock-return ${resultClass}">${escapeHTML(formatSignedPercent(position.profitLossPercent))}</strong></div>
      <div class="card-summary-grid stock-summary-grid">
        <div><span>عدد الأسهم</span><strong>${holding.quantity.toLocaleString("ar-KW-u-nu-latn")}</strong></div>
        <div><span>سعر الشراء</span><strong>${escapeHTML(formatSharePrice(holding.purchasePriceTenths))}</strong></div>
        <div><span>إجمالي التكلفة</span><strong>${escapeHTML(formatMoney(position.totalCostFils))}</strong></div>
        <div><span>السعر الحالي</span><strong>${escapeHTML(formatSharePrice(holding.currentPriceTenths))}</strong></div>
        <div><span>القيمة الحالية</span><strong>${escapeHTML(formatMoney(position.currentValueFils))}</strong></div>
        <div><span>الربح / الخسارة</span><strong class="${resultClass}">${escapeHTML(formatSignedMoney(position.profitLossFils))}</strong></div>
      </div>
      <div class="stock-break-even"><span>سعر الخروج من الخسارة</span><strong>${escapeHTML(formatSharePrice(position.breakEvenPriceTenths))}</strong><small>${escapeHTML(breakEvenCaption)}</small></div>
      <p class="stock-updated">آخر سعر أدخلته: ${escapeHTML(formatStockTimestamp(holding.priceUpdatedAt))}</p>
      <div class="stock-average-entry">
        <label class="field"><span>سعر الشراء لتعديل التكلفة</span><div class="money-field"><input class="stock-adjustment-price" inputmode="decimal" value="${escapeHTML(stockPriceInput(holding.currentPriceTenths))}" aria-label="سعر الشراء لتعديل تكلفة ${escapeHTML(security.name)}"><b>فلس</b></div></label>
        <button type="button" class="secondary" data-average-stock="${escapeHTML(holding.id)}">احسب تعديل التكلفة</button>
      </div>
      <div class="item-actions"><button data-edit-stock="${escapeHTML(holding.id)}">تعديل / تحديث السعر</button><button class="delete" data-delete-stock="${escapeHTML(holding.id)}">حذف</button></div>
    </article>`;
  }).join("");
}

function renderCooling() {
  const select = $("#cooling-stock");
  const previous = select.value;
  select.innerHTML = '<option value="">اختَر السهم</option>' + state.stockHoldings.map(holding => {
    const security = getKuwaitStock(holding.securityCode);
    return `<option value="${escapeHTML(holding.id)}">${escapeHTML(security.name)} · ${escapeHTML(security.ticker)} · ${holding.quantity.toLocaleString("ar-KW-u-nu-latn")} سهم</option>`;
  }).join("");
  select.value = state.stockHoldings.some(item => item.id === previous) ? previous : "";
  select.disabled = !state.stockHoldings.length;
  updateCooling(!select.value);
}

function updateCooling(reset = false) {
  const holding = state.stockHoldings.find(item => item.id === $("#cooling-stock").value);
  $("#cooling-results").hidden = true;
  if (!holding) {
    $("#cooling-current-cost").value = "";
    $("#cooling-buy-price").value = "";
    $("#cooling-target-price").value = "";
    setText("#cooling-position", "");
    setText("#cooling-message", state.stockHoldings.length ? "اختَر السهم اللي تبي تعدّل تكلفته." : "أضف أسهمك إلى المحفظة أولاً عشان تختار السهم وتحسب التبريد.");
    return;
  }
  const position = calculateStockPosition(holding);
  $("#cooling-current-cost").value = stockPriceInput(position.averageCostPriceTenths);
  setText("#cooling-position", `الكمية الحالية: ${holding.quantity.toLocaleString("ar-KW-u-nu-latn")} سهم · آخر سعر مسجل: ${formatSharePrice(holding.currentPriceTenths)}`);
  if (reset) {
    $("#cooling-buy-price").value = stockPriceInput(holding.currentPriceTenths);
    $("#cooling-target-price").value = stockPriceInput(holding.currentPriceTenths);
    $("#cooling-fees").value = "0.000";
  }
  const result = calculateAverageDown({ ...holding,
    buyPriceTenths: parseSharePriceTenths($("#cooling-buy-price").value),
    targetPriceTenths: parseSharePriceTenths($("#cooling-target-price").value),
    additionalFeesFils: parseMoney($("#cooling-fees").value)
  });
  const messages = {
    invalid: "أدخل أسعاراً صحيحة بالفلس والرسوم بالدينار.",
    already_reached: "تكلفتك عند أو أقل من المتوسط المطلوب؛ ما تحتاج تبريد لتحقيقه.",
    unreachable: "ما فيه كمية محدودة تحقق المتوسط المطلوب بهالسعر. أدخل سعر شراء أقل من المتوسط المطلوب؛ الشراء بسعر السوق يقرّب التكلفة منه فقط.",
    too_large: "الكمية المطلوبة تتجاوز حدود الحاسبة؛ جرّب متوسطاً أقرب لتكلفتك الحالية."
  };
  if (result.status !== "ok") { setText("#cooling-message", messages[result.status]); return; }
  $("#cooling-results").hidden = false;
  setText("#cooling-quantity", result.additionalQuantity.toLocaleString("ar-KW-u-nu-latn") + " سهم");
  setText("#cooling-amount", formatMoney(result.additionalAmountFils));
  setText("#cooling-new-cost", formatSharePrice(result.newAveragePriceTenths));
  setText("#cooling-message", `أقل كمية أسهم كاملة تحقق المتوسط المطلوب أو أقل. إجمالي الأسهم بعدها ${result.totalQuantity.toLocaleString("ar-KW-u-nu-latn")}. محاكاة فقط؛ ما تتغير محفظتك.`);
}

function investmentFromInputs() {
  const initialFils = parseMoney($("#investment-initial").value);
  const monthlyFils = parseMoney($("#investment-monthly").value);
  const annualRate = Number($("#investment-rate").value);
  const years = Number($("#investment-years").value);
  if (initialFils === null || monthlyFils === null || !Number.isFinite(annualRate) || !Number.isInteger(years)) return null;
  return { initialFils, monthlyFils, annualRate, years };
}

function chartSVG(points) {
  if (!points.length) return "";
  const width = 620, height = 210, padX = 34, padY = 20;
  const maximum = Math.max(...points.map((point) => point.valueFils), 1);
  const coordinates = points.map((point, index) => ({
    x: padX + (points.length === 1 ? (width - padX * 2) / 2 : index / (points.length - 1) * (width - padX * 2)),
    y: height - padY - point.valueFils / maximum * (height - padY * 2),
    year: point.year
  }));
  const path = coordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${path} L${coordinates.at(-1).x.toFixed(1)},${height - padY} L${coordinates[0].x.toFixed(1)},${height - padY} Z`;
  const labels = coordinates.filter((_, index) => index === 0 || index === coordinates.length - 1 || (coordinates.length > 8 && index % Math.ceil(coordinates.length / 5) === 0));
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d66d36" stop-opacity=".25"/><stop offset="1" stop-color="#d66d36" stop-opacity="0"/></linearGradient></defs>
    <line class="chart-grid" x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}"/>
    <line class="chart-grid" x1="${padX}" y1="${height / 2}" x2="${width - padX}" y2="${height / 2}"/>
    <path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>
    ${labels.map((point) => `<text class="chart-label" x="${point.x}" y="${height - 4}" text-anchor="middle">${point.year}</text>`).join("")}
  </svg>`;
}

function renderInvestment(syncInputs = false) {
  renderStockPortfolio();
  renderCooling();
  if (syncInputs) {
    $("#investment-initial").value = moneyInput(state.investment.initialFils);
    $("#investment-monthly").value = moneyInput(state.investment.monthlyFils);
    $("#investment-rate").value = state.investment.annualRate;
    $("#investment-years").value = state.investment.years;
  }
  const values = investmentFromInputs();
  const result = values ? investmentProjection(values) : null;
  if (!result) {
    setText("#investment-value", "راجع المدخلات");
    setText("#investment-contributions", "—");
    setText("#investment-growth", "—");
    $("#investment-chart").innerHTML = "";
    $("#scenario-list").innerHTML = "";
    return;
  }
  state.investment = values;
  saveState();
  setText("#investment-value", formatMoney(result.valueFils));
  setText("#investment-contributions", formatMoney(result.contributionsFils));
  setText("#investment-growth", formatMoney(result.growthFils));
  setText("#investment-duration", `${values.years.toLocaleString("ar-KW-u-nu-latn")} سنة`);
  $("#investment-growth").style.color = result.growthFils < 0 ? "var(--danger)" : "";
  $("#investment-chart").innerHTML = chartSVG(result.yearly);
  $("#scenario-list").innerHTML = [-5, 0, 4, 7, 10].map((rate) => {
    const scenario = investmentProjection({ ...values, annualRate: rate });
    return `<div class="scenario ${Math.abs(values.annualRate - rate) < .001 ? "selected" : ""}"><span>${rate.toLocaleString("ar-KW-u-nu-latn")}٪ سنوياً</span><strong>${escapeHTML(formatMoney(scenario.valueFils))}</strong></div>`;
  }).join("");
}

function renderGoals() {
  $("#goal-empty").hidden = state.goals.length > 0;
  $("#goal-list").innerHTML = state.goals.map((goal) => {
    const percent = Math.min(Math.max(goal.savedFils / goal.targetFils * 100, 0), 100);
    const remaining = Math.max(goal.targetFils - goal.savedFils, 0);
    let caption = "حدد إضافة شهرية لحساب المدة";
    if (remaining === 0) caption = "وصلت للهدف 🎉";
    else if (goal.monthlyFils > 0) caption = `باقي تقريباً ${Math.ceil(remaining / goal.monthlyFils).toLocaleString("ar-KW-u-nu-latn")} شهر بدون عائد`;
    return `<article class="data-card">
      <div class="card-head"><div><h3>${escapeHTML(goal.name)}</h3><span class="eyebrow">${escapeHTML(caption)}</span></div><span class="amount">${Math.round(percent).toLocaleString("ar-KW-u-nu-latn")}٪</span></div>
      <div class="goal-progress"><div class="progress"><span style="width:${percent}%"></span></div><div class="goal-meta"><span>${escapeHTML(formatMoney(goal.savedFils))}</span><span>${escapeHTML(formatMoney(goal.targetFils))}</span></div></div>
      <div class="item-actions"><button data-edit-goal="${escapeHTML(goal.id)}">تعديل</button><button class="delete" data-delete-goal="${escapeHTML(goal.id)}">حذف</button></div>
    </article>`;
  }).join("");
}

function advisorLivingBaseline(today = todayISO()) {
  const [year, month] = today.split("-").map(Number);
  const monthKeys = Array.from({ length: 3 }, (_, index) => {
    const date = new Date(year, month - 2 - index, 1, 12);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
  const totals = new Map(monthKeys.map((key) => [key, 0]));
  for (const item of state.transactions) {
    const key = item.date.slice(0, 7);
    if (item.kind === "expense" && item.reviewed && totals.has(key)) totals.set(key, totals.get(key) + item.amountFils);
  }
  const observedMonths = [...totals.values()].filter((amount) => amount > 0).length;
  if (observedMonths === 3) {
    return { amountFils: Math.round([...totals.values()].reduce((sum, amount) => sum + amount, 0) / 3), source: "transactions", months: observedMonths };
  }
  if (state.settings.budgetFils > 0) return { amountFils: state.settings.budgetFils, source: "budget", months: observedMonths };
  return { amountFils: 0, source: "missing", months: observedMonths };
}

function renderAdvisor() {
  const today = todayISO();
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const debt = debtSummary(state.loans, { incomeFils, todayISO: today, payments: state.debtPayments });
  const commitmentsFils = state.monthlyCommitments.reduce((sum, item) => sum + monthlyCommitmentEquivalent(item), 0);
  const baseline = advisorLivingBaseline(today);
  const plan = createAdvisorAllocation({
    incomeFils, debtInstallmentsFils: debt.monthlyPaymentsFils, commitmentsFils,
    livingCostFils: baseline.amountFils, cashFils: state.settings.cashFils,
    totalDebtFils: debt.totalBalanceFils,
    overdue: state.loans.some((item) => item.status === "overdue"),
    baselineReady: baseline.source !== "missing" && incomeFils > 0
  });
  setText("#advisor-income", formatMoney(incomeFils));
  setText("#advisor-installments", formatMoney(debt.monthlyPaymentsFils));
  setText("#advisor-commitments", formatMoney(commitmentsFils));
  setText("#advisor-total-debt", formatMoney(debt.totalBalanceFils));
  setText("#advisor-budget-income", formatMoney(incomeFils));
  setText("#advisor-budget-installments", `\u200E−${formatMoney(debt.monthlyPaymentsFils)}`);
  setText("#advisor-budget-commitments", `\u200E−${formatMoney(commitmentsFils)}`);
  setText("#advisor-budget-living", `\u200E−${formatMoney(baseline.amountFils)}`);
  setText("#advisor-surplus", plan.baselineReady ? formatMoney(Math.max(plan.surplusFils, 0)) : "—");
  setText("#advisor-surplus-label", plan.surplusFils < 0 ? "عجز بعد الأساسيات" : "المتبقي للأهداف");
  setText("#advisor-reserve-allocation", formatMoney(plan.reserveAllocationFils));
  setText("#advisor-debt-allocation", formatMoney(plan.extraDebtFils));
  setText("#advisor-investment-allocation", formatMoney(plan.investmentFils));
  setText("#advisor-reserve-caption", `هدف 3 أشهر: ${formatMoney(plan.emergencyTargetFils)} · رصيد نقدي: ${formatMoney(state.settings.cashFils)}`);
  const priorityDebt = state.loans.filter((item) => ["active", "overdue"].includes(item.status) && item.balanceFils > 0 && item.interestRateKnown && item.annualRate > 0)
    .sort((a, b) => b.annualRate - a.annualRate)[0];
  setText("#advisor-debt-caption", priorityDebt ? `الأعلى بمعدل مسجل: ${priorityDebt.name} (${priorityDebt.annualRate.toLocaleString("ar-KW-u-nu-latn")}٪)` : "سجّل معدل كل قرض عشان نحدد الأولوية بدقة");
  const phaseLabels = {
    needs_data: "أكمل البيانات", deficit: "راجع العجز", overdue: "ابدأ بالمتأخرات",
    build_minimum_reserve: "كوّن احتياطياً أولياً", build_emergency_reserve: "وازن بين الاحتياط والسداد",
    debt_and_invest: "سداد واستثمار", invest_after_debt: "وجّه الفائض للاستثمار"
  };
  setText("#advisor-phase-pill", phaseLabels[plan.phase] ?? "خطة مبدئية");
  const baselineMessage = baseline.source === "transactions"
    ? "المعيشة محسوبة من متوسط آخر 3 أشهر مكتملة فيها مصروفات معتمدة. عدّل ميزانية الشهر من الإعدادات إذا كان المتوسط لا يمثل احتياجك القادم."
    : baseline.source === "budget"
      ? `المعيشة مبنية على ميزانيتك المسجلة ${formatMoney(baseline.amountFils)}؛ بيانات الصرف المعتمدة موجودة في ${baseline.months.toLocaleString("ar-KW-u-nu-latn")} من آخر 3 أشهر مكتملة.`
      : "ما نقدر نحسب فائضاً موثوقاً للحين. حدد ميزانية مصروفاتك الشهرية من الإعدادات، أو اعتمد مصروفات 3 أشهر مكتملة.";
  setText("#advisor-baseline-note", baselineMessage);
  const summaryByPhase = {
    needs_data: "أكمل دخلك وميزانيتك والأقساط عشان أطلع لك توزيعاً واقعياً.",
    deficit: `الأساسيات أعلى من دخلك بنحو ${formatMoney(plan.deficitFils)} شهرياً؛ نبدأ بخفض العجز قبل الاستثمار الإضافي.`,
    overdue: "خلّص المتأخرات أولاً بعد تأمين مصاريف الشهر الأساسية.",
    build_minimum_reserve: "نبني احتياطياً أولياً يحميك من الرجوع للدين عند الطوارئ.",
    build_emergency_reserve: "نوازن حالياً بين تقوية الاحتياطي وسداد الدين والاستثمار.",
    debt_and_invest: "الاحتياطي مكتمل مبدئياً؛ نوزع الفائض بين سداد أسرع واستثمار طويل الأجل.",
    invest_after_debt: "ما عندك دين مسجل؛ نحافظ على الاحتياطي ونوجّه الفائض للاستثمار طويل الأجل."
  };
  setText("#advisor-summary", summaryByPhase[plan.phase] ?? "توزيع مبدئي من البيانات المسجلة.");
  const actionMessages = [];
  if (plan.phase === "needs_data") actionMessages.push("أدخل الدخل والميزانية الشهرية، وأضف الأقساط والالتزامات الفعلية قبل اعتماد أي توزيع.");
  else if (plan.phase === "deficit") actionMessages.push(`الأساسيات أعلى من الدخل بنحو ${formatMoney(plan.deficitFils)} شهرياً؛ أوقف الاستثمار الإضافي مؤقتاً وراجع المصروف المرن والالتزامات.`);
  else if (plan.phase === "overdue") actionMessages.push("سدّد المتأخرات أولاً بعد تغطية الاحتياجات والأقساط الحالية؛ الخطة لا تفترض رسوم التأخير أو شروط البنك.");
  else if (plan.phase === "build_minimum_reserve") actionMessages.push(debt.totalBalanceFils > 0
    ? "كوّن احتياطياً نقدياً يعادل شهراً واحداً من الأساسيات؛ الخطة تخصص ما يصل إلى 70٪ من الفائض لذلك والباقي لسداد دين إضافي، وتؤجل الاستثمار الإضافي حالياً."
    : "كوّن احتياطياً نقدياً يعادل شهراً واحداً من الأساسيات؛ وبعد بلوغه يمكن توجيه الفائض للاستثمار أو هدفك التالي.");
  else if (plan.phase === "build_emergency_reserve") actionMessages.push("وصلت لاحتياطي شهر تقريباً؛ الخطة تواصل زيادة الاحتياط إلى 3 أشهر وتوزع الباقي بين الدين والاستثمار.");
  else if (plan.phase === "debt_and_invest") actionMessages.push("بعد وصول الاحتياط إلى 3 أشهر، الخطة تقترح 75٪ من الفائض لسداد إضافي و25٪ لاستثمار طويل الأجل.");
  else actionMessages.push("بعد سداد الديون المسجلة، وجّه الفائض إلى أهدافك الاستثمارية مع الحفاظ على احتياطي الطوارئ.");
  actionMessages.push(priorityDebt
    ? `بعد دفع الأقساط الإلزامية، وجّه السداد الإضافي إلى ${priorityDebt.name} لأنه الأعلى بين معدلات الفائدة المسجلة.`
    : "إذا عندك ديون، أدخل معدلها السنوي الفعلي. عند السداد الإضافي ابدأ بالأعلى تكلفة بعد التأكد من رسوم السداد المبكر.");
  actionMessages.push("استثمر فقط مبلغاً طويل الأجل تستطيع تحمل تقلبه؛ العائد المتوقع في صفحة الاستثمار افتراض حسابي وليس وعداً بالربح.");
  $("#advisor-actions").innerHTML = actionMessages.map((message) => `<li>${escapeHTML(message)}</li>`).join("");
}

let onboardingController = null;
function openOnboarding() {
  const dialog = $("#onboarding-dialog");
  if (!onboardingController) {
    onboardingController = mountOnboarding($("#onboarding-root"), {
      getSettings: () => state.settings,
      onApply: applyStarterPlan,
      onSkip: () => { state.ui.onboarded = true; saveState(); closeDialog(dialog); }
    });
  }
  onboardingController.start();
  openDialog(dialog);
}

function applyStarterPlan(plan) {
  const settings = state.settings;
  settings.incomeFils = plan.incomeFils;
  settings.cashFils = plan.savingsFils;
  settings.budgetFils = plan.budgetFils;
  settings.safetyBufferFils = plan.safetyBufferFils;
  settings.salaryDay = plan.salaryDay;
  let keptIncomes = false;
  if (state.incomes.length > 1) keptIncomes = true;
  else state.incomes = [{ ...(state.incomes[0] ?? { id: createId(), name: "المعاش", frequency: "monthly", status: "active" }), amountFils: plan.incomeFils }];
  const saved = Math.min(plan.savingsFils, plan.emergencyTargetFils);
  const goal = state.goals.find((item) => item.name === "صندوق الطوارئ");
  if (goal) Object.assign(goal, { targetFils: plan.emergencyTargetFils, savedFils: saved, monthlyFils: plan.monthlySaveFils });
  else state.goals.push({ id: createId(), name: "صندوق الطوارئ", targetFils: plan.emergencyTargetFils, savedFils: saved, monthlyFils: plan.monthlySaveFils });
  state.ui.onboarded = true;
  saveState();
  closeDialog($("#onboarding-dialog"));
  renderAll({ investmentInputs: true });
  switchView("dashboard");
  toast(keptIncomes ? "طبّقت الخطة. عندك أكثر من دخل مسجل فما غيّرتها، راجعها من الإعدادات." : "تم ترتيب كل شي حسب معاشك ✅");
}

let spendingController = null;
function spendingModel() {
  return {
    transactions: state.transactions, budgets: state.categoryBudgets, todayISO: todayISO(), monthlyBudgetFils: state.settings.budgetFils,
    pendingCount: state.transactions.filter((item) => !item.reviewed).length
  };
}
function renderSpending() {
  const root = $("#spending-root");
  if (!root) return;
  if (!spendingController) {
    spendingController = mountSpending(root, {
      getModel: spendingModel,
      onBudgetsChange: (budgets) => { state.categoryBudgets = budgets; saveState(); renderAll(); }
    });
  }
  spendingController.render();
}

let salaryPlanController = null;
function salaryPlanModel() {
  const base = checkupModel();
  return { goals: state.goals, incomeFils: base.incomeFils, budgetFils: state.settings.budgetFils, commitmentsFils: base.commitmentsFils,
    debtPaymentsFils: base.debtPaymentsFils, todayISO: todayISO(), salaryDay: state.settings.salaryDay };
}
function renderSalaryPlan() {
  const root = $("#salary-plan-root");
  if (!root) return;
  if (!salaryPlanController) {
    salaryPlanController = mountSalaryPlan(root, {
      getModel: salaryPlanModel,
      onFund: () => {
        const result = fundGoals(state.goals, monthKeyOf(todayISO()));
        if (!result.count) { toast("كل أهدافك مموّلة هذا الشهر"); return; }
        state.goals = result.goals; saveState(); renderAll();
        toast(`أضفت ${formatMoney(result.addedFils)} لـ ${result.count.toLocaleString("ar-KW-u-nu-latn")} أهداف`);
      },
      onApplySuggestion: async (allocation) => {
        if (!(await askConfirm("نغيّر الإضافة الشهرية لأهدافك حسب التوزيع المقترح (الطوارئ أولاً)؟", { okLabel: "طبّق" }))) return;
        state.goals.forEach((goal) => { if (allocation[goal.id] !== undefined) goal.monthlyFils = allocation[goal.id]; });
        saveState(); renderAll(); toast("تم تحديث إضافات الأهداف");
      }
    });
  }
  salaryPlanController.render();
}

function renderNudges() {
  const box = $("#nudges");
  if (!box) return;
  const today = todayISO();
  const report = budgetReport({ transactions: state.transactions, budgets: state.categoryBudgets, todayISO: today });
  const items = categoryNudges(report).map((nudge) => ({ text: nudge.text, view: "spending", level: nudge.level }));
  const salary = salaryDue({ todayISO: today, salaryDay: state.settings.salaryDay, goals: state.goals });
  if (salary.due) items.unshift({ text: `نزل راتبك؟ حوّل ${formatMoney(salary.pendingTotalFils)} لأهدافك هذا الشهر.`, view: "goals", level: "info" });
  box.hidden = items.length === 0 || lockedNow;
  box.innerHTML = items.map((item) => `<button type="button" class="nudge nudge-${item.level}" data-nudge-view="${item.view}">${escapeHTML(item.text)}</button>`).join("");
}

function checkupModel() {
  const today = todayISO();
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const debt = debtSummary(state.loans, { incomeFils, todayISO: today, payments: state.debtPayments });
  const commitmentsFils = state.monthlyCommitments.filter((item) => item.status !== "paused").reduce((sum, item) => sum + monthlyCommitmentEquivalent(item), 0);
  const baseline = advisorLivingBaseline(today);
  const fixed = commitmentsFils + debt.monthlyPaymentsFils;
  const livingFils = baseline.source === "transactions" ? Math.max(baseline.amountFils - fixed, 0) : baseline.amountFils;
  const stocksFils = state.stockHoldings.reduce((sum, holding) => sum + (calculateStockPosition(holding)?.currentValueFils ?? 0), 0);
  return {
    incomeFils, livingFils, commitmentsFils, debtPaymentsFils: debt.monthlyPaymentsFils, totalDebtFils: debt.totalBalanceFils,
    cashFils: state.settings.cashFils, overdue: state.loans.some((loan) => loan.status === "overdue"),
    loans: state.loans, holdings: state.stockHoldings, stocksFils, investment: state.investment
  };
}

let checkupController = null;
function renderCheckup() {
  const root = $("#checkup-root");
  if (!root) return;
  if (!checkupController) {
    checkupController = mountCheckup(root, {
      getModel: checkupModel,
      getUi: () => state.ui,
      setUi: (patch) => { Object.assign(state.ui, patch); saveState(); }
    });
  }
  checkupController.render();
}

let goldController = null;
async function fetchGoldPrice() {
  const get = async (url) => {
    const response = await fetch(url, { cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  try { return priceFromApi(await get(`${GOLD_PRICE_URL}/KWD`), state.ui.goldUsdKwd); }
  catch { return priceFromApi(await get(GOLD_PRICE_URL), state.ui.goldUsdKwd); }
}

function renderGold() {
  const root = $("#gold-root");
  if (!root) return;
  goldController ??= mountGold(root, { getState: () => state, save: () => saveState(), toast, fetchPrice: fetchGoldPrice });
  goldController.render();
}

function renderAll({ investmentInputs = false } = {}) {
  renderDashboard();
  renderGold();
  renderTransactions();
  renderCommitments();
  renderLoans();
  renderInvestment(investmentInputs);
  renderGoals();
  renderAdvisor();
  renderCheckup();
  renderSpending();
  renderSalaryPlan();
  renderNudges();
  renderBackupReminder();
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

let pendingTransactionSource = "manual";
let pendingStatementBatch = null;
let statementImportController = null;

function openStatementImport() {
  pendingStatementBatch = null;
  $("#statement-import-form").reset();
  $("#statement-import-error").textContent = "";
  $("#statement-import-preview").hidden = true;
  $("#statement-import-confirm").disabled = true;
  openDialog($("#statement-import-dialog"));
}

async function prepareStatementImport(file) {
  statementImportController?.abort();
  const controller = new AbortController();
  statementImportController = controller;
  $("#statement-import-progress").hidden = true;
  pendingStatementBatch = null;
  $("#statement-import-preview").hidden = true;
  $("#statement-import-confirm").disabled = true;
  $("#statement-import-error").textContent = "";
  if (!file) return;
  try {
    if (file.size > 12 * 1024 * 1024) throw new Error("حجم الكشف أكبر من 12 ميغابايت.");
    if (state.transactions.length >= 20_000) throw new Error("وصلت لحد العمليات المحفوظة. صدّر نسخة وقلّل السجلات قبل الاستيراد.");
    const isPDF = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    let text;
    if (isPDF) {
      $("#statement-import-progress").hidden = false;
      setText("#statement-import-progress", "جاري فتح كشف PDF…");
      text = await readPDFStatement(file, (page, total) => {
        if (controller.signal.aborted) return;
        setText("#statement-import-progress", `قراءة صفحة ${page.toLocaleString("ar-KW-u-nu-latn")} من ${total.toLocaleString("ar-KW-u-nu-latn")}…`);
      }, controller.signal);
    } else text = await file.text();
    if (controller.signal.aborted) return;
    const parsed = parseBankStatement({ text, filename: isPDF ? "statement.csv" : file.name, todayISO: todayISO(), existingTransactions: state.transactions, maxRows: Math.min(12_000, 20_000 - state.transactions.length) });
    parsed.transactions = parsed.transactions.map((item) => ({
      ...item,
      ...applyMerchantKnowledge({ merchant: item.rawMerchant || item.merchant, category: item.category }),
      source: "bank-statement", reviewed: true, kind: "expense", createdAt: new Date().toISOString()
    }));
    pendingStatementBatch = parsed;
    renderStatementPreview(parsed);
    $("#statement-import-preview").hidden = false;
    $("#statement-import-confirm").disabled = parsed.transactions.length === 0;
  } catch (error) {
    if (!controller.signal.aborted) $("#statement-import-error").textContent = error instanceof Error ? error.message : "تعذر قراءة الملف.";
  } finally {
    if (statementImportController === controller) $("#statement-import-progress").hidden = true;
  }
}

function renderStatementPreview(batch) {
  const { stats, transactions } = batch;
  setText("#statement-preview-period", stats.startDate ? `${formatDate(stats.startDate)} — ${formatDate(stats.endDate)}` : "كل المصروفات الموجودة مضافة من قبل");
  setText("#statement-preview-count", `${transactions.length.toLocaleString("ar-KW-u-nu-latn")} عملية`);
  setText("#statement-preview-total", formatMoney(stats.totalFils));
  setText("#statement-preview-duplicates", stats.duplicates.toLocaleString("ar-KW-u-nu-latn"));
  setText("#statement-preview-excluded", (stats.credits + stats.transfers).toLocaleString("ar-KW-u-nu-latn"));
  setText("#statement-preview-skipped", (stats.invalidRows + stats.outOfRange).toLocaleString("ar-KW-u-nu-latn"));
  $("#statement-preview-list").innerHTML = transactions.slice(-12).reverse().map((item) => `
    <div class="statement-preview-item"><span>${escapeHTML(item.merchant)}<small>${escapeHTML(item.category)} · ${escapeHTML(formatDate(item.date))}</small></span><strong>−${escapeHTML(formatMoney(item.amountFils))}</strong></div>`).join("");
}

function submitStatementImport(event) {
  event.preventDefault();
  if (!pendingStatementBatch) return;
  const known = new Set(state.transactions.map((item) => item.fingerprint || transactionFingerprint({ amountFils: item.amountFils, merchant: item.rawMerchant || item.merchant, date: item.date })));
  const transactions = pendingStatementBatch.transactions.filter((item) => !known.has(item.fingerprint));
  if (!transactions.length) {
    $("#statement-import-error").textContent = "كل العمليات الجديدة صارت موجودة من قبل؛ ما كررناها.";
    return;
  }
  if (transactions.length + state.transactions.length > 20_000) {
    $("#statement-import-error").textContent = "عدد العمليات يتجاوز سعة السجل الحالي. صدّر نسخة وقلّل السجلات قبل الاستيراد.";
    return;
  }
  state.transactions.push(...transactions.map((item) => ({ id: createId(), ...item })));
  const startDate = transactions[0].date;
  const endDate = transactions.at(-1).date;
  const previous = state.statementImport;
  state.statementImport = {
    coverageStartISO: previous.coverageStartISO ? (previous.coverageStartISO < startDate ? previous.coverageStartISO : startDate) : startDate,
    coverageEndISO: previous.coverageEndISO ? (previous.coverageEndISO > endDate ? previous.coverageEndISO : endDate) : endDate,
    importedAt: new Date().toISOString(),
    importedCount: previous.importedCount + transactions.length
  };
  pendingStatementBatch = null;
  saveState();
  renderAll();
  closeDialog($("#statement-import-dialog"));
  switchView("dashboard");
  $("#behavior-panel").closest("details").open = true;
  requestAnimationFrame(() => $("#behavior-panel").scrollIntoView({ behavior: "smooth", block: "start" }));
  toast(`تم استيراد ${transactions.length.toLocaleString("ar-KW-u-nu-latn")} عملية وتحليلها`);
}

function openTransaction(item = null, imported = null) {
  const form = $("#transaction-form");
  form.reset();
  $("#transaction-error").textContent = "";
  $("#transaction-dialog-title").textContent = item ? "تعديل العملية" : imported ? "راجع العملية" : "عملية جديدة";
  $("#transaction-id").value = item?.id ?? "";
  $("#transaction-kind").value = item?.kind ?? "expense";
  $("#transaction-amount").value = item ? moneyInput(item.amountFils) : imported ? moneyInput(imported.amountFils) : "";
  $("#transaction-merchant").value = item?.merchant ?? imported?.merchant ?? "";
  $("#transaction-category").value = item?.category ?? imported?.category ?? "أخرى";
  $("#transaction-date").value = item?.date ?? todayISO();
  $("#transaction-reviewed").checked = item ? true : !imported;
  pendingTransactionSource = item?.source ?? (imported ? "bank-text" : "manual");
  openDialog($("#transaction-dialog"));
}

function submitTransaction(event) {
  event.preventDefault();
  const amountFils = parseMoney($("#transaction-amount").value);
  const merchant = $("#transaction-merchant").value.trim();
  const date = $("#transaction-date").value;
  if (!amountFils || !merchant || !validDate(date)) {
    $("#transaction-error").textContent = "أدخل مبلغاً صحيحاً، اسماً، وتاريخاً صالحاً.";
    return;
  }
  const id = $("#transaction-id").value;
  const existing = state.transactions.find((item) => item.id === id);
  const record = {
    id: existing?.id ?? createId(), amountFils, merchant: merchant.slice(0, 80),
    category: categories.includes($("#transaction-category").value) ? $("#transaction-category").value : "أخرى",
    kind: $("#transaction-kind").value === "income" ? "income" : "expense", date,
    reviewed: $("#transaction-reviewed").checked, source: pendingTransactionSource,
    rawMerchant: existing?.rawMerchant ?? (["bank-text", "bank-statement"].includes(pendingTransactionSource) ? merchant.slice(0, 80) : ""),
    fingerprint: existing?.fingerprint ?? "",
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };
  if (["bank-text", "bank-statement"].includes(record.source)) {
    record.fingerprint = transactionFingerprint({ amountFils: record.amountFils, merchant: record.rawMerchant || record.merchant, date: record.date });
  }
  if (["bank-text", "bank-statement"].includes(record.source) && state.transactions.some((item) =>
    item.id !== existing?.id && (item.fingerprint === record.fingerprint ||
    (item.amountFils === record.amountFils && item.date === record.date &&
    merchantKey(item.rawMerchant || item.merchant) === merchantKey(record.rawMerchant || record.merchant))))) {
    $("#transaction-error").textContent = "في عملية مستوردة مطابقة بنفس اليوم. راجع القائمة قبل إضافتها مرة ثانية.";
    return;
  }
  if (record.reviewed) learnMerchant(record);
  if (existing && record.reviewed) existing.possibleDuplicate = false;
  if (existing) Object.assign(existing, record); else state.transactions.push(record);
  saveState(); renderAll(); closeDialog($("#transaction-dialog")); toast(existing ? "تم تعديل العملية" : "تمت إضافة العملية");
}

function renderCommitmentCategoryOptions(selected = "") {
  const options = [...new Set([...commitmentCategories, ...state.customCommitmentCategories])];
  $("#commitment-category").innerHTML = `${options.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("")}<option value="__custom">＋ تصنيف مخصص</option>`;
  $("#commitment-category").value = options.includes(selected) ? selected : (selected ? "__custom" : "أخرى");
  $("#custom-category-field").hidden = $("#commitment-category").value !== "__custom";
  $("#commitment-custom-category").value = options.includes(selected) ? "" : selected;
}

function updateCommitmentCategoryFilterOptions() {
  const select = $("#commitment-category-filter");
  const selected = select.value || "all";
  const options = [...new Set([...commitmentCategories, ...state.customCommitmentCategories])];
  select.innerHTML = `<option value="all">كل التصنيفات</option>${options.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("")}`;
  select.value = options.includes(selected) ? selected : "all";
}

function openCommitment(commitment = null) {
  $("#commitment-form").reset();
  $("#commitment-error").textContent = "";
  $("#commitment-dialog-title").textContent = commitment ? "تعديل الالتزام" : "التزام جديد";
  $("#commitment-id").value = commitment?.id ?? "";
  $("#commitment-name").value = commitment?.name ?? "";
  renderCommitmentCategoryOptions(commitment?.category ?? "أخرى");
  $("#commitment-amount").value = commitment ? moneyInput(commitment.amountFils) : "";
  $("#commitment-due-date").value = commitment?.dueDate ?? todayISO();
  $("#commitment-recurrence").value = commitment?.recurrence ?? "monthly";
  $("#commitment-payment-method").value = commitment?.paymentMethod ?? "bank";
  $("#commitment-status").value = commitment?.status === "paused" ? "paused" : "active";
  $("#commitment-notes").value = commitment?.notes ?? "";
  openDialog($("#commitment-dialog"));
}

function submitCommitment(event) {
  event.preventDefault();
  const name = $("#commitment-name").value.trim();
  const amountFils = parseMoney($("#commitment-amount").value);
  const dueDate = $("#commitment-due-date").value;
  const categoryValue = $("#commitment-category").value;
  const customCategory = $("#commitment-custom-category").value.trim();
  const category = categoryValue === "__custom" ? customCategory : categoryValue;
  if (!name || !amountFils || !validDate(dueDate) || !category) {
    $("#commitment-error").textContent = "راجع الاسم والتصنيف والمبلغ وتاريخ الاستحقاق.";
    return;
  }
  if (categoryValue === "__custom" && !state.customCommitmentCategories.includes(category)) state.customCommitmentCategories.push(category.slice(0, 60));
  const id = $("#commitment-id").value;
  const existing = state.monthlyCommitments.find((item) => item.id === id);
  const record = {
    id: existing?.id ?? createId(), name: name.slice(0, 80), category: category.slice(0, 60), amountFils, dueDate,
    recurrence: Object.hasOwn(commitmentRecurrences, $("#commitment-recurrence").value) ? $("#commitment-recurrence").value : "monthly",
    paymentMethod: ["bank", "credit_card", "cash", "other"].includes($("#commitment-payment-method").value) ? $("#commitment-payment-method").value : "other",
    notes: $("#commitment-notes").value.trim().slice(0, 500),
    status: $("#commitment-status").value === "paused" ? "paused" : "active",
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };
  if (existing) Object.assign(existing, record); else state.monthlyCommitments.push(record);
  saveState(); updateCommitmentCategoryFilterOptions(); renderAll(); closeDialog($("#commitment-dialog")); toast(existing ? "تم تعديل الالتزام" : "تمت إضافة الالتزام");
}

function openLoan(loan = null) {
  $("#loan-form").reset();
  $("#loan-error").textContent = "";
  $("#loan-dialog-title").textContent = loan ? "تعديل القرض" : "قرض جديد";
  $("#loan-id").value = loan?.id ?? "";
  $("#loan-name").value = loan?.name ?? "";
  $("#loan-lender").value = loan?.lender ?? "";
  $("#loan-type").value = loan?.type ?? "أخرى";
  $("#loan-status").value = loan?.status ?? "active";
  $("#loan-original").value = loan ? moneyInput(loan.originalAmountFils || loan.balanceFils) : "";
  $("#loan-balance").value = loan ? moneyInput(loan.balanceFils) : "";
  $("#loan-installment").value = loan ? moneyInput(loan.installmentFils) : "";
  $("#loan-paid").value = loan ? moneyInput(loan.totalPaidFils ?? Math.max((loan.originalAmountFils ?? loan.balanceFils) - loan.balanceFils, 0)) : "0.000";
  $("#loan-rate").value = loan?.annualRate ?? 0;
  $("#loan-day").value = loan?.dueDay ?? 1;
  $("#loan-remaining-installments").value = loan?.remainingInstallments ?? "";
  $("#loan-start-date").value = loan?.startDate ?? "";
  $("#loan-end-date").value = loan?.endDate ?? "";
  openDialog($("#loan-dialog"));
}

function submitLoan(event) {
  event.preventDefault();
  const name = $("#loan-name").value.trim();
  const originalAmountFils = parseMoney($("#loan-original").value);
  const balanceFils = parseMoney($("#loan-balance").value);
  const installmentFils = parseMoney($("#loan-installment").value);
  const totalPaidInput = parseMoney($("#loan-paid").value);
  const annualRate = Number($("#loan-rate").value);
  const dueDay = Number($("#loan-day").value);
  const remainingRaw = $("#loan-remaining-installments").value.trim();
  const remainingInstallmentCount = remainingRaw === "" ? null : Number(remainingRaw);
  const startDate = $("#loan-start-date").value;
  const endDate = $("#loan-end-date").value;
  const status = $("#loan-status").value;
  if (!name || !originalAmountFils || balanceFils === null || balanceFils > originalAmountFils || !installmentFils || totalPaidInput === null || !Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100 || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31 || (remainingInstallmentCount !== null && (!Number.isInteger(remainingInstallmentCount) || remainingInstallmentCount < 0 || remainingInstallmentCount > 1200)) || (startDate && !validDate(startDate)) || (endDate && !validDate(endDate)) || (startDate && endDate && endDate < startDate) || (status === "completed" && balanceFils !== 0)) {
    $("#loan-error").textContent = "راجع الاسم والمبلغ الأصلي والرصيد والقسط والنسبة والتواريخ."; return;
  }
  const id = $("#loan-id").value;
  const existing = state.loans.find((item) => item.id === id);
  const record = {
    id: existing?.id ?? createId(), name: name.slice(0, 60), lender: $("#loan-lender").value.trim().slice(0, 60),
    type: debtTypes.includes($("#loan-type").value) ? $("#loan-type").value : "أخرى",
    originalAmountFils, originalAmountKnown: true, balanceFils, installmentFils, annualRate, interestRateKnown: true, dueDay, startDate, endDate,
    remainingInstallments: remainingInstallmentCount,
    totalPaidFils: Math.max(totalPaidInput, originalAmountFils - balanceFils),
    status: ["active", "completed", "overdue", "stopped"].includes(status) ? status : "active"
  };
  if (existing) Object.assign(existing, record); else state.loans.push(record);
  saveState(); renderAll(); closeDialog($("#loan-dialog")); toast(existing ? "تم تعديل القرض" : "تمت إضافة القرض");
}

let currentExtraPaymentSimulation = null;

function openExtraPayment(loan) {
  if (!loan) return;
  $("#extra-payment-form").reset();
  $("#extra-payment-error").textContent = "";
  $("#extra-payment-loan-id").value = loan.id;
  setText("#extra-payment-loan-name", loan.name);
  $("#save-extra-payment").disabled = true;
  $("#extra-payment-simulation").innerHTML = "<p>أدخل المبلغ لعرض المحاكاة قبل الحفظ.</p>";
  currentExtraPaymentSimulation = null;
  openDialog($("#extra-payment-dialog"));
}

function updateExtraPaymentSimulation() {
  const loan = state.loans.find((item) => item.id === $("#extra-payment-loan-id").value);
  const amountFils = parseMoney($("#extra-payment-amount").value);
  const simulation = loan && amountFils ? simulateExtraPayment(loan, amountFils, todayISO()) : null;
  currentExtraPaymentSimulation = simulation;
  $("#save-extra-payment").disabled = !simulation;
  if (!simulation) {
    $("#extra-payment-simulation").innerHTML = "<p>أدخل مبلغاً صحيحاً لا يتجاوز الرصيد لعرض المحاكاة.</p>";
    return;
  }
  $("#extra-payment-simulation").innerHTML = `<div class="simulation-grid">
    <div><span>الرصيد قبل الدفعة</span><strong>${escapeHTML(formatMoney(simulation.beforeBalanceFils))}</strong></div>
    <div><span>الرصيد بعد الدفعة</span><strong>${escapeHTML(formatMoney(simulation.afterBalanceFils))}</strong></div>
    <div><span>الأشهر المتوقع اختصارها</span><strong>${simulation.monthsShortened.toLocaleString("ar-KW-u-nu-latn")}</strong></div>
    <div><span>النهاية الحالية</span><strong>${escapeHTML(formatDate(simulation.currentEndDate))}</strong></div>
    <div><span>النهاية المتوقعة</span><strong>${escapeHTML(formatDate(simulation.expectedEndDate))}</strong></div>
    <div><span>الفرق في الرصيد</span><strong>${escapeHTML(formatMoney(simulation.balanceDifferenceFils))}</strong></div>
    ${simulation.estimatedChargeSavingsFils === null ? "" : `<div><span>فرق رسوم/فوائد تقديري</span><strong>${escapeHTML(formatMoney(simulation.estimatedChargeSavingsFils))}</strong></div>`}
  </div>`;
}

function submitExtraPayment(event) {
  event.preventDefault();
  const loan = state.loans.find((item) => item.id === $("#extra-payment-loan-id").value);
  const simulation = currentExtraPaymentSimulation;
  if (!loan || !simulation) { $("#extra-payment-error").textContent = "تعذر حفظ الدفعة. راجع المبلغ."; return; }
  state.extraPayments.push({ id: createId(), debtId: loan.id, amountFils: simulation.appliedFils, date: todayISO(), balanceBeforeFils: simulation.beforeBalanceFils, balanceAfterFils: simulation.afterBalanceFils });
  loan.balanceFils = simulation.afterBalanceFils;
  loan.totalPaidFils = Math.max((loan.totalPaidFils ?? 0) + simulation.appliedFils, loan.originalAmountFils - loan.balanceFils);
  loan.remainingInstallments = simulation.expectedMonths;
  loan.endDate = simulation.expectedEndDate;
  if (loan.balanceFils === 0) loan.status = "completed";
  saveState(); renderAll(); closeDialog($("#extra-payment-dialog")); toast("تم تسجيل الدفعة الإضافية");
}

let scannedLoanCandidates = [];
let scannedImageURLs = [];
let loanScanInProgress = false;
let loanScanState = "idle";

function setLoanScanState(nextState) {
  loanScanState = ["idle", "uploading", "processing", "review", "success", "error"].includes(nextState) ? nextState : "error";
  $("#loan-analysis-status").dataset.state = loanScanState;
  $("#loan-review-dialog").dataset.state = loanScanState;
}

function clearScannedImageURLs() {
  scannedImageURLs.forEach((item) => URL.revokeObjectURL(item.url));
  scannedImageURLs = [];
  $("#loan-image-previews").innerHTML = "";
  closeImageLightbox();
}

function renderImagePreviews() {
  $("#loan-image-previews").innerHTML = scannedImageURLs.map((item, index) => `
    <button type="button" class="image-preview-button" data-preview-image="${index}" aria-label="فتح ${escapeHTML(item.name)}">
      <img src="${escapeHTML(item.url)}" alt="معاينة ${escapeHTML(item.name)}">
      <span>${escapeHTML(item.name)}</span>
    </button>`).join("");
}

function openImageLightbox(index) {
  const item = scannedImageURLs[index];
  if (!item) return;
  $("#lightbox-image").src = item.url;
  $("#lightbox-image").alt = `صورة ${item.name}`;
  $("#image-lightbox").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeImageLightbox() {
  const lightbox = $("#image-lightbox");
  if (!lightbox) return;
  lightbox.hidden = true;
  $("#lightbox-image").removeAttribute("src");
  document.body.style.overflow = "";
}

function openLoanScanner() {
  if (loanScanInProgress) {
    switchView("loans");
    toast("التحليل شغال بالخلفية — بنفتح لك المراجعة أول ما يخلص");
    return;
  }
  clearScannedImageURLs();
  setLoanScanState("idle");
  setLoanAnalysisStatus({ hidden: true });
  $("#loan-scan-form").reset();
  $("#loan-scan-error").textContent = "";
  $("#loan-scan-results").innerHTML = "";
  $("#save-scanned-loans").disabled = true;
  scannedLoanCandidates = [];
  openDialog($("#loan-scan-dialog"));
}

function setLoanAnalysisStatus({ hidden = false, title = "جاري تحليل الصور", message = "", progress = 0, error = false } = {}) {
  const panel = $("#loan-analysis-status");
  panel.hidden = hidden;
  panel.classList.toggle("error", error);
  $("#loan-analysis-retry").hidden = !error;
  if (hidden) return;
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  setText("#loan-analysis-title", title);
  setText("#ocr-progress-text", message);
  $("#ocr-progress-bar").style.width = `${safeProgress}%`;
  setText("#loan-analysis-percent", error ? "!" : `${Math.round(safeProgress).toLocaleString("ar-KW-u-nu-latn")}٪`);
}

async function prepareOCRImage(file) {
  if (!("createImageBitmap" in window)) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const maxDimension = 1800;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return file;
    context.filter = "grayscale(1) contrast(1.18)";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", 0.9));
  } catch (error) {
    console.warn("Image preparation failed; using original", error);
    return file;
  } finally {
    bitmap?.close?.();
  }
}

function renderScannedLoans() {
  $("#loan-scan-results").innerHTML = scannedLoanCandidates.map((loan, index) => `
    <article class="scan-card" data-scan-index="${index}">
      <div class="scan-card-head"><strong>القرض ${index + 1}</strong><span class="confidence ${loan.confidence}">${loan.confidence === "high" ? "قراءة واضحة" : loan.confidence === "medium" ? "راجع البيانات" : "أكمل البيانات"}</span></div>
      <div class="form-grid">
        <label class="field ${loan.name ? "" : "needs-review"}"><span>اسم القرض ${loan.name ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><input data-scan-field="name" maxlength="60" value="${escapeHTML(loan.name ?? "")}" placeholder="غير واضح — يرجى التأكيد"></label>
        <label class="field ${loan.lender ? "" : "needs-review"}"><span>البنك / الجهة ${loan.lender ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><input data-scan-field="lender" maxlength="60" value="${escapeHTML(loan.lender ?? "")}" placeholder="غير واضح — يرجى التأكيد"></label>
        <label class="field"><span>نوع القرض</span><select data-scan-field="type">${debtTypes.map((type) => `<option value="${escapeHTML(type)}" ${type === (loan.type ?? "أخرى") ? "selected" : ""}>${escapeHTML(type)}</option>`).join("")}</select></label>
        <label class="field ${loan.originalAmountFils ? "" : "needs-review"}"><span>المبلغ الأصلي ${loan.originalAmountFils ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — اختياري</small>'}</span><div class="money-field"><input data-scan-field="original" inputmode="decimal" value="${loan.originalAmountFils ? moneyInput(loan.originalAmountFils) : ""}" placeholder="غير واضح"><b>د.ك</b></div></label>
      </div>
      <div class="form-grid">
        <label class="field ${loan.balanceFils ? "" : "needs-review"}"><span>الرصيد المتبقي ${loan.balanceFils ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><div class="money-field"><input data-scan-field="balance" inputmode="decimal" value="${loan.balanceFils ? moneyInput(loan.balanceFils) : ""}" placeholder="غير واضح"><b>د.ك</b></div></label>
        <label class="field ${loan.installmentFils ? "" : "needs-review"}"><span>القسط الشهري ${loan.installmentFils ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><div class="money-field"><input data-scan-field="installment" inputmode="decimal" value="${loan.installmentFils ? moneyInput(loan.installmentFils) : ""}" placeholder="غير واضح"><b>د.ك</b></div></label>
        <label class="field ${loan.startDate ? "" : "needs-review"}"><span>تاريخ البداية ${loan.startDate ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — اختياري</small>'}</span><input data-scan-field="start" type="date" value="${escapeHTML(loan.startDate ?? "")}"></label>
        <label class="field ${loan.endDate ? "" : "needs-review"}"><span>تاريخ النهاية ${loan.endDate ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — اختياري</small>'}</span><input data-scan-field="end" type="date" value="${escapeHTML(loan.endDate ?? "")}"></label>
        <label class="field"><span>نسبة سنوية <small class="field-confidence">اتركها فارغة إذا غير واضحة</small></span><div class="money-field"><input data-scan-field="rate" type="number" min="0" max="100" step="0.25" value="${loan.interestRateKnown ? loan.annualRate : ""}" placeholder="غير واضح"><b>٪</b></div></label>
        <label class="field ${loan.dueDay ? "" : "needs-review"}"><span>يوم الاستحقاق ${loan.dueDay ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><input data-scan-field="day" type="number" min="1" max="31" value="${loan.dueDay ?? ""}" placeholder="غير واضح"></label>
      </div>
      <button class="remove-scan" type="button" data-remove-scan="${index}">حذف هذا القرض</button>
    </article>`).join("");
  $("#save-scanned-loans").disabled = !scannedLoanCandidates.length;
}

function addMissingScannedLoan() {
  scannedLoanCandidates.push({
    id: `manual-scan-${Date.now()}`, name: "", lender: "", type: "أخرى", originalAmountFils: null,
    balanceFils: null, installmentFils: null, annualRate: 0, interestRateKnown: false,
    dueDay: null, startDate: "", endDate: "", confidence: "low", fieldConfidence: {}
  });
  renderScannedLoans();
  $("#loan-scan-results").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function scanLoanScreenshots(files) {
  if (loanScanInProgress) return;
  const selected = [...files].filter((file) => file.type.startsWith("image/")).slice(0, 6);
  if (!selected.length) return;
  setLoanScanState("uploading");
  clearScannedImageURLs();
  scannedImageURLs = selected.map((file) => ({ name: file.name || "صورة قرض", url: URL.createObjectURL(file) }));
  renderImagePreviews();
  $("#loan-scan-error").textContent = "";
  $("#loan-scan-results").innerHTML = "";
  $("#save-scanned-loans").disabled = true;
  scannedLoanCandidates = [];
  closeDialog($("#loan-scan-dialog"));
  switchView("loans");
  loanScanInProgress = true;
  setLoanScanState("processing");
  let worker = null;
  let activeIndex = -1;
  let shownProgress = 2;
  setLoanAnalysisStatus({
    title: "جاري تجهيز قارئ الصور",
    message: "تقدر تكمل استخدام فلس، وبنفتح لك شاشة المراجعة أول ما نخلص.",
    progress: shownProgress
  });
  try {
    await loadOcrEngine();
    if (!window.Tesseract?.createWorker) throw new Error("OCR worker unavailable");
    worker = await window.Tesseract.createWorker(["ara", "eng"], 1, {
      // Engine, core and language files ship inside the app; nothing is fetched from another site.
      workerPath: new URL("./vendor/tesseract/worker.min.js", location.href).href,
      corePath: new URL("./vendor/tesseract/", location.href).href,
      langPath: new URL("./vendor/tesseract/lang", location.href).href,
      workerBlobURL: false,
      gzip: true,
      logger: (message) => {
        const fileProgress = Number.isFinite(message.progress) ? message.progress : 0;
        const calculated = activeIndex < 0
          ? 2 + (fileProgress * 10)
          : 12 + (((activeIndex + fileProgress) / selected.length) * 86);
        shownProgress = Math.max(shownProgress, calculated);
        const reading = activeIndex >= 0 && message.status === "recognizing text";
        setLoanAnalysisStatus({
          title: reading ? `جاري قراءة الصورة ${activeIndex + 1} من ${selected.length}` : "جاري تجهيز قارئ الصور",
          message: reading ? "نستخرج الرصيد المتبقي والقسط الشهري…" : "أول مرة قد تحتاج لحظات لتحميل لغة القراءة.",
          progress: shownProgress
        });
      }
    });
    for (let index = 0; index < selected.length; index += 1) {
      activeIndex = index;
      setLoanAnalysisStatus({
        title: `جاري تجهيز الصورة ${index + 1} من ${selected.length}`,
        message: "نصغّر الصورة ونوضح النص لتسريع القراءة…",
        progress: Math.max(shownProgress, 12 + ((index / selected.length) * 86))
      });
      const preparedImage = await prepareOCRImage(selected[index]);
      const result = await worker.recognize(preparedImage);
      scannedLoanCandidates.push(...parseLoanOCRLoans(result?.data?.text ?? "", scannedLoanCandidates.length));
    }
    await worker.terminate();
    worker = null;
    setLoanAnalysisStatus({ title: "خلص التحليل", message: "جهزنا القروض للمراجعة.", progress: 100 });
    renderScannedLoans();
    setLoanAnalysisStatus({ hidden: true });
    setLoanScanState("review");
    openDialog($("#loan-review-dialog"));
    toast("خلص التحليل — راجع الأرقام قبل الحفظ");
  } catch (error) {
    console.error(error);
    setLoanScanState("error");
    setLoanAnalysisStatus({
      title: "ما قدرنا نقرأ الصور",
      message: "تأكد من الإنترنت وجرّب صورة أوضح بدون قص المبالغ والعناوين.",
      progress: shownProgress,
      error: true
    });
    toast("تعذر تحليل الصور — تقدر تحاول مرة ثانية");
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch (error) { console.warn("Could not terminate OCR worker", error); }
    }
    loanScanInProgress = false;
    $("#loan-screenshots").value = "";
  }
}

function saveScannedLoans(event) {
  event.preventDefault();
  const cards = $$(".scan-card", $("#loan-scan-results"));
  const records = cards.map((card) => {
    const name = $("[data-scan-field='name']", card).value.trim();
    const lender = $("[data-scan-field='lender']", card).value.trim();
    const type = $("[data-scan-field='type']", card).value;
    const originalInput = $("[data-scan-field='original']", card).value.trim();
    const originalAmountFils = originalInput ? parseMoney(originalInput) : null;
    const balanceFils = parseMoney($("[data-scan-field='balance']", card).value);
    const installmentFils = parseMoney($("[data-scan-field='installment']", card).value);
    const rateInput = $("[data-scan-field='rate']", card).value.trim();
    const annualRate = rateInput === "" ? 0 : Number(rateInput);
    const dueDay = Number($("[data-scan-field='day']", card).value);
    const startDate = $("[data-scan-field='start']", card).value;
    const endDate = $("[data-scan-field='end']", card).value;
    if (!name || !balanceFils || !installmentFils || (originalAmountFils !== null && originalAmountFils < balanceFils) || !Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100 || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31 || (startDate && !validDate(startDate)) || (endDate && !validDate(endDate))) return null;
    const original = originalAmountFils ?? balanceFils;
    return {
      id: createId(), name: name.slice(0, 60), lender: lender.slice(0, 60), type: debtTypes.includes(type) ? type : "أخرى",
      originalAmountFils: original, originalAmountKnown: originalAmountFils !== null, balanceFils, installmentFils,
      annualRate, interestRateKnown: rateInput !== "", dueDay, startDate, endDate,
      remainingInstallments: null, totalPaidFils: Math.max(original - balanceFils, 0), status: "active"
    };
  });
  if (!records.length || records.some((record) => !record)) {
    $("#loan-scan-error").textContent = "راجع كل قرض: الاسم والرصيد والقسط ويوم الاستحقاق مطلوبة. المبلغ الأصلي والتواريخ اختيارية إذا لم تظهر بالصورة.";
    return;
  }
  state.loans.push(...records);
  setLoanScanState("success");
  saveState(); renderAll(); closeDialog($("#loan-review-dialog")); clearScannedImageURLs();
  toast(`تمت إضافة ${records.length.toLocaleString("ar-KW-u-nu-latn")} قرض`);
}

function openGoal(goal = null) {
  $("#goal-form").reset();
  $("#goal-error").textContent = "";
  $("#goal-dialog-title").textContent = goal ? "تعديل الهدف" : "هدف جديد";
  $("#goal-id").value = goal?.id ?? "";
  $("#goal-name").value = goal?.name ?? "";
  $("#goal-target").value = goal ? moneyInput(goal.targetFils) : "";
  $("#goal-saved").value = goal ? moneyInput(goal.savedFils) : "0.000";
  $("#goal-monthly").value = goal ? moneyInput(goal.monthlyFils) : "0.000";
  openDialog($("#goal-dialog"));
}

function submitGoal(event) {
  event.preventDefault();
  const name = $("#goal-name").value.trim();
  const targetFils = parseMoney($("#goal-target").value);
  const savedFils = parseMoney($("#goal-saved").value);
  const monthlyFils = parseMoney($("#goal-monthly").value);
  if (!name || !targetFils || savedFils === null || monthlyFils === null) {
    $("#goal-error").textContent = "راجع اسم الهدف وجميع المبالغ."; return;
  }
  const id = $("#goal-id").value;
  const existing = state.goals.find((item) => item.id === id);
  const record = { id: existing?.id ?? createId(), name: name.slice(0, 60), targetFils, savedFils, monthlyFils };
  if (existing) Object.assign(existing, record); else state.goals.push(record);
  saveState(); renderAll(); closeDialog($("#goal-dialog")); toast(existing ? "تم تعديل الهدف" : "تمت إضافة الهدف");
}

function openSettings() {
  $("#settings-error").textContent = "";
  $("#settings-income").value = moneyInput(state.settings.incomeFils);
  $("#settings-budget").value = moneyInput(state.settings.budgetFils);
  $("#settings-cash").value = moneyInput(state.settings.cashFils);
  $("#settings-salary-day").value = state.settings.salaryDay;
  $("#settings-safety-buffer").value = moneyInput(state.settings.safetyBufferFils);
  $("#settings-credit-card-reserve").value = moneyInput(state.settings.creditCardReserveFils);
  $("#settings-invested").value = moneyInput(state.settings.investedFils);
  $("#settings-assets").value = moneyInput(state.settings.assetsFils);
  renderSecuritySettings();
  openDialog($("#settings-dialog"));
}

let ocrEnginePromise = null;
function loadOcrEngine() {
  if (window.Tesseract?.createWorker) return Promise.resolve();
  ocrEnginePromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./vendor/tesseract/tesseract.min.js";
    script.onload = resolve;
    script.onerror = () => { ocrEnginePromise = null; reject(new Error("OCR engine failed to load")); };
    document.head.append(script);
  });
  return ocrEnginePromise;
}

async function importBankFile(file) {
  if (!file) return;
  if (file.size > 5_000_000) { toast("الملف كبير؛ اختر ملف fils-bank.txt"); return; }
  const text = await file.text();
  const summary = ingestBankText(text, { fromFile: true });
  if (!summary.total && !summary.alreadyRead) { toast("الملف فاضي؛ تأكد من إعداد الاختصار"); return; }
  reportBankSummary(summary);
}

async function pasteBankFromClipboard() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) return text;
  } catch { /* Safari may refuse; fall back to the paste box */ }
  return "";
}

function renderBankCard() {
  const pending = state.transactions.filter((item) => !item.reviewed).length;
  const pill = $("#bank-card-pending");
  pill.hidden = pending === 0;
  pill.textContent = `${pending.toLocaleString("ar-KW-u-nu-latn")} للمراجعة`;
  const review = $("#bank-card-review");
  review.hidden = pending === 0;
  review.textContent = pending === 1 ? "راجع العملية الجديدة" : `راجع ${pending.toLocaleString("ar-KW-u-nu-latn")} عمليات جديدة`;
}

const FIELD_LABELS = { title: "العنوان", subtitle: "العنوان الفرعي", body: "النص" };
function renderBankFieldOrder() {
  const order = state.ui.bankFieldOrder;
  $$("[data-bank-field]").forEach((select, index) => {
    select.innerHTML = `<option value="">—</option>` + BANK_FIELDS.map((field) => `<option value="${field}">${{ title: "العنوان", subtitle: "الفرعي", body: "النص" }[field]}</option>`).join("");
    select.value = order[index] ?? "";
  });
  setText("#bank-field-summary", order.map((field) => FIELD_LABELS[field]).join(" ← "));
}

function saveBankFieldOrder() {
  const picked = $$("[data-bank-field]").map((select) => select.value).filter(Boolean);
  if (!picked.length || new Set(picked).size !== picked.length) { toast("اختر كل حقل مرة وحدة"); renderBankFieldOrder(); return; }
  state.ui.bankFieldOrder = picked; saveState(); renderBankFieldOrder(); toast("تم حفظ ترتيب الحقول");
}

function openBankAutomationGuide() {
  if ($("#settings-dialog").open) closeDialog($("#settings-dialog"));
  openDialog($("#bank-automation-dialog"));
}


let pendingPortfolioImport = [];
function handlePortfolioLink() {
  if (!location.hash.startsWith("#stocks=")) return false;
  try {
    pendingPortfolioImport = parsePortfolioLink(location.hash);
    switchView("investment");
    $("#portfolio-import-list").innerHTML = pendingPortfolioImport.map(item => {
      const security = getKuwaitStock(item.securityCode);
      return `<article class="data-card"><h3>${escapeHTML(security.name)} · ${escapeHTML(security.ticker)}</h3><p>${item.quantity.toLocaleString("ar-KW-u-nu-latn")} سهم · متوسط التكلفة ${escapeHTML(formatSharePrice(item.purchasePriceTenths))} · السعر بالصورة ${escapeHTML(formatSharePrice(item.currentPriceTenths))}</p></article>`;
    }).join("");
    const count = newPortfolioHoldings(state.stockHoldings, pendingPortfolioImport).length;
    $("#portfolio-import-save").disabled = count === 0 || !storageAvailable;
    setText("#portfolio-import-status", !storageAvailable ? "التخزين غير متاح؛ افتح الرابط في Safari لحفظ الأسهم." : count ? `جاهز لإضافة ${count.toLocaleString("ar-KW-u-nu-latn")} أسهم. الأسهم الموجودة عندك لن تتغير.` : "هالأسهم موجودة عندك بالفعل؛ ما راح نكررها.");
    openDialog($("#portfolio-import-dialog"));
  } catch {
    history.replaceState(null, "", "#investment");
    switchView("investment", false);
    toast("رابط المحفظة غير صالح؛ لم تتغير بياناتك.");
  }
  return true;
}

function handleBankAutomationLink() {
  if (!location.hash.startsWith("#bank=")) return false;
  let bankText = "";
  try { bankText = decodeURIComponent(location.hash.slice(6)).trim().slice(0, 4000); }
  catch { bankText = ""; }
  history.replaceState(null, "", `${location.pathname}${location.search}#dashboard`);
  switchView("dashboard", false);
  if (!bankText) {
    toast("الإشعار وصل بدون نص");
    return true;
  }
  reportBankSummary(ingestBankText(bankText));
  return true;
}

function submitSettings(event) {
  event.preventDefault();
  const salaryDay = Number($("#settings-salary-day").value);
  const fields = {
    incomeFils: parseMoney($("#settings-income").value), budgetFils: parseMoney($("#settings-budget").value),
    cashFils: parseMoney($("#settings-cash").value), salaryDay,
    safetyBufferFils: parseMoney($("#settings-safety-buffer").value),
    creditCardReserveFils: parseMoney($("#settings-credit-card-reserve").value),
    investedFils: parseMoney($("#settings-invested").value),
    assetsFils: parseMoney($("#settings-assets").value)
  };
  if (Object.entries(fields).some(([key, value]) => key !== "salaryDay" && value === null) ||
      !Number.isInteger(salaryDay) || salaryDay < 1 || salaryDay > 31) {
    $("#settings-error").textContent = "راجع المبالغ ويوم نزول المعاش من ١ إلى ٣١."; return;
  }
  const additionalIncomes = state.incomes.filter((item) => !["legacy-primary-income", "primary-income"].includes(item.id));
  const additionalTotal = additionalIncomes.filter((item) => item.status !== "paused").reduce((sum, item) => sum + item.amountFils, 0);
  if (fields.incomeFils < additionalTotal) {
    $("#settings-error").textContent = "الدخل الكلي لا يمكن أن يكون أقل من مصادر الدخل الإضافية المسجلة.";
    return;
  }
  const primaryAmount = fields.incomeFils - additionalTotal;
  state.incomes = additionalIncomes;
  if (primaryAmount > 0) state.incomes.unshift({ id: "primary-income", name: "الدخل الأساسي", amountFils: primaryAmount, frequency: "monthly", status: "active" });
  state.settings = fields; saveState(); renderAll(); closeDialog($("#settings-dialog")); toast("تم حفظ الإعدادات");
}

function switchView(target, updateHash = true) {
  if (!$( `[data-view="${target}"]` )) target = "dashboard";
  $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === target));
  $$("[data-target]").forEach((button) => {
    const active = button.dataset.target === target;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const moreActive = ["advisor", "investment", "gold", "goals", "checkup", "spending"].includes(target);
  $("#more-nav-button").classList.toggle("active", moreActive);
  if (moreActive) $("#more-nav-button").setAttribute("aria-current", "page");
  else $("#more-nav-button").removeAttribute("aria-current");
  if (updateHash && location.hash !== `#${target}`) history.replaceState(null, "", `#${target}`);
  scrollTo({ top: 0, behavior: "smooth" });
}

async function removeRecord(collection, id, label) {
  if (!(await askConfirm(`متأكد تبي تحذف ${label}؟`, { okLabel: "احذف", danger: true }))) return;
  state[collection] = state[collection].filter((item) => item.id !== id);
  if (collection === "loans") {
    state.debtPayments = state.debtPayments.filter((item) => item.debtId !== id);
    state.extraPayments = state.extraPayments.filter((item) => item.debtId !== id);
  }
  if (collection === "monthlyCommitments") state.commitmentPayments = state.commitmentPayments.filter((item) => item.commitmentId !== id);
  saveState(); renderAll(); toast("تم الحذف");
}

function askAccountant(question) {
  if (/سلوك|عادات|آخر\s*12|12\s*شهر|السنة/i.test(question)) {
    const report = analyzeSpendingBehavior(state.transactions, { todayISO: todayISO(), salaryDay: state.settings.salaryDay });
    $("#accountant-question").value = question;
    $("#accountant-answer").hidden = false;
    if (!state.statementImport.importedCount || !report?.count) {
      $("#accountant-answer").innerHTML = '<span class="answer-kind">بيانات ناقصة</span><h3>أحتاج كشف الحساب أولاً</h3><p>استورد كشف معاملات آخر 12 شهر، وراجع التصنيفات المقترحة. بعدها أعرض لك الأنماط المسجلة بدون تخمين صفاتك.</p>';
      return;
    }
    const details = report.insights.length ? report.insights : ["ما ظهر نمط متكرر كافٍ حتى الآن."];
    details.push(`التحليل مبني على ${report.count.toLocaleString("ar-KW-u-nu-latn")} عملية مصروف معتمدة خلال الفترة المعروضة.`);
    $("#accountant-answer").innerHTML = `<span class="answer-kind">من معاملاتك الفعلية</span><h3>ملخص آخر 12 شهر</h3><p>إجمالي المصروفات ${escapeHTML(formatMoney(report.totalFils))}، ومتوسط الأشهر المسجلة ${escapeHTML(formatMoney(report.monthlyAverageFils))}.</p><ul>${details.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`;
    return;
  }
  const context = financialContext();
  context.alertCount = state.financialAlerts.filter((item) => item.active && !item.dismissedAt).length;
  const answer = answerFinancialQuestion(question, context);
  if (!answer) return;
  $("#accountant-question").value = question;
  $("#accountant-answer").hidden = false;
  $("#accountant-answer").innerHTML = `<span class="answer-kind">${escapeHTML(answer.label)}</span><h3>${escapeHTML(answer.title)}</h3><p>${escapeHTML(answer.message)}</p>${answer.details?.length ? `<ul>${answer.details.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : ""}`;
}

function captureFinancialSnapshot() {
  const today = todayISO();
  if (state.financialSnapshots.some((item) => item.date === today)) return;
  const context = financialContext(today);
  state.financialSnapshots.push({ date: today, cashFils: state.settings.cashFils, safeFils: context.safe?.safeFils ?? 0, debtFils: context.debts.totalBalanceFils, monthSpentFils: context.spentFils });
  state.financialSnapshots = state.financialSnapshots.slice(-400);
  saveState();
}

let confirmResolver = null;
function askConfirm(message, { okLabel = "نعم، كمّل", danger = false } = {}) {
  const dialog = $("#confirm-dialog");
  if (confirmResolver) confirmResolver(false);
  $("#confirm-message").textContent = message;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  ok.classList.toggle("primary", !danger);
  return new Promise((resolve) => {
    confirmResolver = resolve;
    openDialog(dialog);
  });
}
function settleConfirm(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  if ($("#confirm-dialog").open) closeDialog($("#confirm-dialog"));
  resolve?.(value);
}

const LOCK_KEY = "fils-lock-v1";
const SNAPSHOT_KEY = "fils-state-v1-prev";
let lockRecord = null;
let lockedNow = false;
let hiddenAtMs = null;
let lockTimer = null;

function readLockRecord() {
  try { return sanitizeLockRecord(JSON.parse(localStorage.getItem(LOCK_KEY) ?? "null")); } catch { return null; }
}
function writeLockRecord(record) {
  lockRecord = record;
  try {
    if (record) localStorage.setItem(LOCK_KEY, JSON.stringify(record)); else localStorage.removeItem(LOCK_KEY);
  } catch (error) { console.warn("Lock storage unavailable", error); }
}

function snapshotBeforeChange(reason) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), reason, state })); } catch (error) { console.warn("Snapshot failed", error); }
}
function readSnapshot() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "null");
    return parsed?.state && typeof parsed.savedAt === "string" ? parsed : null;
  } catch { return null; }
}
async function restoreSnapshot() {
  const snapshot = readSnapshot();
  if (!snapshot) { toast("ما فيه نسخة تلقائية للاسترجاع"); return; }
  if (!(await askConfirm(`نرجّع بياناتك كما كانت قبل ${snapshot.reason === "reset" ? "المسح" : "الاستيراد"} (${formatDate(snapshot.savedAt.slice(0, 10))})؟ بيانات اليوم الحالية تُستبدل.`, { okLabel: "استرجاع", danger: true }))) return;
  snapshotBeforeChange("restore");
  state = sanitizeState(snapshot.state);
  saveState(); renderAll({ investmentInputs: true }); closeDialog($("#settings-dialog")); toast("تم الاسترجاع");
}

function renderBackupReminder() {
  const card = $("#backup-reminder");
  if (!card) return;
  const status = backupStatus({
    lastBackupAt: state.ui.lastBackupAt, baselineAt: state.ui.backupBaselineAt, snoozedUntil: state.ui.backupSnoozedUntil,
    hasData: hasMeaningfulData(state), nowMs: Date.now()
  });
  card.hidden = !status.due || lockedNow;
  if (!card.hidden) setText("#backup-reminder-text", `${describeBackupAge(status)} بياناتك محفوظة على هذا الجهاز فقط، صدّر نسخة عشان ما تضيع.`);
}

function renderSecuritySettings() {
  const enabled = Boolean(lockRecord);
  setText("#lock-status", enabled ? "القفل مفعّل" : "القفل غير مفعّل");
  $("#lock-setup").textContent = enabled ? "تغيير الرمز" : "تفعيل القفل";
  $("#lock-disable").hidden = !enabled;
  $("#lock-now").hidden = !enabled;
  const snapshot = readSnapshot();
  $("#restore-snapshot").hidden = !snapshot;
  if (snapshot) $("#restore-snapshot").textContent = `استرجاع نسخة ما قبل ${snapshot.reason === "reset" ? "المسح" : snapshot.reason === "restore" ? "الاسترجاع" : "الاستيراد"}`;
}

/* ----- شاشة القفل ----- */
function lockApp() {
  if (!lockRecord || lockedNow) return;
  lockedNow = true;
  document.querySelectorAll("dialog[open]").forEach((dialog) => closeDialog(dialog));
  document.body.classList.add("is-locked");
  $("#lock-screen").hidden = false;
  $("#lock-pin").value = "";
  $("#lock-error").textContent = "";
  updateLockCountdown();
  setTimeout(() => $("#lock-pin").focus(), 50);
}
function unlockApp() {
  lockedNow = false;
  document.body.classList.remove("is-locked");
  $("#lock-screen").hidden = true;
  $("#lock-pin").value = "";
  clearInterval(lockTimer);
  renderBackupReminder();
}
function updateLockCountdown() {
  clearInterval(lockTimer);
  const tick = () => {
    const left = remainingLockMs(lockRecord, Date.now());
    $("#lock-submit").disabled = left > 0;
    if (left > 0) $("#lock-error").textContent = `محاولات كثيرة. جرّب بعد ${Math.ceil(left / 1000).toLocaleString("ar-KW-u-nu-latn")} ثانية.`;
    else { if ($("#lock-error").textContent.startsWith("محاولات")) $("#lock-error").textContent = ""; clearInterval(lockTimer); }
  };
  tick();
  if (remainingLockMs(lockRecord, Date.now()) > 0) lockTimer = setInterval(tick, 1000);
}
async function submitLock(event) {
  event.preventDefault();
  if (remainingLockMs(lockRecord, Date.now()) > 0) return;
  const pin = $("#lock-pin").value.trim();
  if (await verifyPin(pin, lockRecord)) { writeLockRecord(registerSuccess(lockRecord)); unlockApp(); return; }
  writeLockRecord(registerFailure(lockRecord, Date.now()));
  $("#lock-pin").value = "";
  $("#lock-error").textContent = "الرمز غير صحيح.";
  updateLockCountdown();
}
async function forgotPin() {
  if (!(await askConfirm("ما فيه طريقة لاسترجاع الرمز. نمسح كل بيانات فلس من هذا الجهاز ونفتح التطبيق بدون قفل. تقدر تستورد نسخة احتياطية بعدها. نكمل؟", { okLabel: "امسح وافتح", danger: true }))) return;
  writeLockRecord(null);
  // The automatic snapshot would otherwise restore everything without the PIN.
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* storage unavailable */ }
  state = defaultState();
  state.ui.initialPortfolioApplied = true;
  try { localStorage.removeItem(STORAGE_KEY); storageAvailable = true; } catch { storageAvailable = false; }
  saveState(); unlockApp(); renderAll({ investmentInputs: true }); toast("تم المسح. تقدر تستورد نسخة احتياطية من الإعدادات.");
}

/* ----- ضبط الرمز ----- */
let pinMode = "set";
function openPinDialog(mode) {
  pinMode = mode;
  $("#pin-form").reset();
  $("#pin-error").textContent = "";
  $("#pin-current-field").hidden = mode === "set";
  $("#pin-new-fields").hidden = mode === "disable";
  setText("#pin-title", mode === "disable" ? "إيقاف القفل" : mode === "change" ? "تغيير الرمز" : "تفعيل القفل");
  if ($("#settings-dialog").open) closeDialog($("#settings-dialog"));
  openDialog($("#pin-dialog"));
}
async function submitPin(event) {
  event.preventDefault();
  const error = $("#pin-error");
  if (pinMode !== "set" && !(await verifyPin($("#pin-current").value.trim(), lockRecord))) { error.textContent = "الرمز الحالي غير صحيح."; return; }
  if (pinMode === "disable") { writeLockRecord(null); closeDialog($("#pin-dialog")); renderSecuritySettings(); toast("تم إيقاف القفل"); return; }
  const next = $("#pin-new").value.trim();
  if (!PIN_PATTERN.test(next)) { error.textContent = "الرمز من ٤ إلى ٨ أرقام فقط."; return; }
  if (next !== $("#pin-confirm").value.trim()) { error.textContent = "الرمزان غير متطابقين."; return; }
  if (!cryptoAvailable()) { error.textContent = "المتصفح لا يدعم القفل هنا."; return; }
  writeLockRecord(await createLockRecord(next));
  closeDialog($("#pin-dialog")); renderSecuritySettings(); toast("تم تفعيل القفل");
}

function setupSafetyEvents() {
  $("#confirm-ok").addEventListener("click", () => settleConfirm(true));
  $("#confirm-cancel").addEventListener("click", () => settleConfirm(false));
  $("#confirm-dialog").addEventListener("close", () => settleConfirm(false));
  $("#lock-form").addEventListener("submit", submitLock);
  $("#lock-forgot").addEventListener("click", forgotPin);
  $("#pin-form").addEventListener("submit", submitPin);
  $("#lock-setup").addEventListener("click", () => openPinDialog(lockRecord ? "change" : "set"));
  $("#lock-disable").addEventListener("click", () => openPinDialog("disable"));
  $("#lock-now").addEventListener("click", () => { closeDialog($("#settings-dialog")); lockApp(); });
  $("#restore-snapshot").addEventListener("click", restoreSnapshot);
  $("#backup-export").addEventListener("click", exportData);
  $("#backup-snooze").addEventListener("click", () => {
    state.ui.backupSnoozedUntil = new Date(Date.now() + 3 * 86_400_000).toISOString();
    saveState(); renderBackupReminder(); toast("بذكّرك بعد ٣ أيام");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAtMs = Date.now();
    else if (lockRecord && shouldRelock({ hiddenAtMs, nowMs: Date.now() })) lockApp();
    if (document.visibilityState === "visible") renderBackupReminder();
  });
}

function exportData() {
  state.ui.lastBackupAt = new Date().toISOString();
  state.ui.backupSnoozedUntil = "";
  saveState(); renderBackupReminder();
  const data = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = `fils-backup-${todayISO()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("تم تجهيز النسخة الاحتياطية");
}

async function importData(file) {
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (![1, 2, 3, 4].includes(raw?.version)) throw new Error("Unsupported backup");
    if (!(await askConfirm("استيراد النسخة يستبدل البيانات الحالية. نحفظ لك نسخة تلقائية قبل الاستبدال لو احتجت ترجع. نكمل؟", { okLabel: "استيراد" }))) return;
    snapshotBeforeChange("import");
    state = sanitizeState(raw); saveState(); renderAll({ investmentInputs: true }); closeDialog($("#settings-dialog")); toast("تم استيراد البيانات");
  } catch (error) { $("#settings-error").textContent = "ملف النسخة غير صالح أو غير مدعوم."; console.error(error); }
  finally { $("#import-data").value = ""; }
}

async function resetData() {
  if (!(await askConfirm("هذا يمسح كل العمليات والالتزامات والقروض والأسهم والأهداف من هذا الجهاز. نحفظ لك نسخة تلقائية وحدة تقدر ترجع لها بعد المسح. متأكد؟", { okLabel: "امسح", danger: true }))) return;
  snapshotBeforeChange("reset");
  state = defaultState();
  state.ui.initialPortfolioApplied = true;
  try { localStorage.removeItem(STORAGE_KEY); storageAvailable = true; } catch { storageAvailable = false; }
  saveState(); renderAll({ investmentInputs: true }); closeDialog($("#settings-dialog")); toast("تم مسح البيانات");
}

function bindEvents() {
  $("#statement-import-dialog").addEventListener("close", () => {
    statementImportController?.abort();
    pendingStatementBatch = null;
  });
  $("#cooling-stock").addEventListener("change", () => updateCooling(true));
  $("#cooling-form").addEventListener("input", event => { if (event.target.id !== "cooling-stock") updateCooling(); });
  $("#cooling-form").addEventListener("submit", event => { event.preventDefault(); updateCooling(); });
  $("#portfolio-import-save").addEventListener("click", () => {
    const additions = newPortfolioHoldings(state.stockHoldings, pendingPortfolioImport);
    if (!storageAvailable || !additions.length) return;
    const now = new Date().toISOString();
    state.stockHoldings.push(...additions.map(item => ({ ...item, id: createId(), createdAt: now })));
    saveState(); renderAll(); closeDialog($("#portfolio-import-dialog"));
    pendingPortfolioImport = [];
    toast(`تمت إضافة ${additions.length.toLocaleString("ar-KW-u-nu-latn")} أسهم إلى محفظتك`);
  });
  $$("[data-target]").forEach((button) => button.addEventListener("click", () => {
    if ($("#more-dialog").open) closeDialog($("#more-dialog"));
    switchView(button.dataset.target);
  }));
  $$("[data-target-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.targetView)));
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action && action !== "open-more" && $("#more-dialog").open) closeDialog($("#more-dialog"));
    if (action === "open-more") openDialog($("#more-dialog"));
    if (action === "open-accountant") {
      $("#accountant-details").open = true;
      switchView("advisor");
      requestAnimationFrame(() => {
        const panel = document.querySelector(".accountant-panel");
        panel?.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => $("#accountant-question")?.focus({ preventScroll: true }), 260);
      });
    }
    const nudgeView = event.target.closest("[data-nudge-view]")?.dataset.nudgeView;
    if (nudgeView) switchView(nudgeView);
    if (action === "open-onboarding") openOnboarding();
    if (action === "new-transaction") openTransaction();
    if (action === "new-commitment") openCommitment();
    if (action === "review-pending") { $("#transaction-kind-filter").value = "all"; switchView("transactions"); }
    if (action === "paste-bank") {
      pasteBankFromClipboard().then((text) => {
        $("#bank-form").reset(); $("#bank-error").textContent = "";
        if (text) $("#bank-text").value = text;
        renderBankPreview(); openDialog($("#bank-dialog"));
      });
    }
    if (action === "import-bank") { $("#bank-form").reset(); $("#bank-error").textContent = ""; renderBankPreview(); openDialog($("#bank-dialog")); }
    if (action === "import-statement") openStatementImport();
    if (action === "bank-automation-guide") openBankAutomationGuide();
    if (action === "scan-loans") openLoanScanner();
    if (action === "new-loan") openLoan();
    if (action === "new-stock") openStock();
    if (action === "new-goal") openGoal();
  });
  $$(".close-dialog").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
  $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) closeDialog(dialog);
  }));
  $("#transaction-form").addEventListener("submit", submitTransaction);
  $("#commitment-form").addEventListener("submit", submitCommitment);
  $("#commitment-category").addEventListener("change", () => { $("#custom-category-field").hidden = $("#commitment-category").value !== "__custom"; });
  $("#loan-form").addEventListener("submit", submitLoan);
  $("#extra-payment-form").addEventListener("submit", submitExtraPayment);
  $("#extra-payment-amount").addEventListener("input", updateExtraPaymentSimulation);
  $("#loan-review-form").addEventListener("submit", saveScannedLoans);
  $("#add-missing-scanned-loan").addEventListener("click", addMissingScannedLoan);
  $("#loan-screenshots").addEventListener("change", (event) => scanLoanScreenshots(event.target.files ?? []));
  $("#loan-review-dialog").addEventListener("close", () => {
    scannedLoanCandidates = [];
    $("#loan-scan-results").innerHTML = "";
    $("#loan-scan-error").textContent = "";
    $("#save-scanned-loans").disabled = true;
    clearScannedImageURLs();
  });
  $("#loan-scan-results").addEventListener("click", (event) => {
    const index = Number(event.target.dataset.removeScan);
    if (!Number.isInteger(index)) return;
    scannedLoanCandidates.splice(index, 1);
    renderScannedLoans();
  });
  $("#loan-image-previews").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preview-image]");
    if (button) openImageLightbox(Number(button.dataset.previewImage));
  });
  $("#close-image-lightbox").addEventListener("click", closeImageLightbox);
  $("#image-lightbox").addEventListener("click", (event) => {
    if (event.target === $("#image-lightbox")) closeImageLightbox();
  });
  $("#goal-form").addEventListener("submit", submitGoal);
  $("#stock-form").addEventListener("submit", submitStock);
  $("#average-down-form").addEventListener("submit", (event) => { event.preventDefault(); updateAverageDown(); });
  $("#average-down-form").addEventListener("input", updateAverageDown);
  $("#stock-search").addEventListener("input", () => renderStockSelector($("#stock-search").value, $("#stock-security").value));
  ["#stock-security", "#stock-quantity", "#stock-purchase-price", "#stock-fees", "#stock-current-price"].forEach((selector) => {
    $(selector).addEventListener("input", updateStockPreview);
    $(selector).addEventListener("change", updateStockPreview);
  });
  $("#settings-form").addEventListener("submit", submitSettings);
  $("#settings-button").addEventListener("click", openSettings);
  $$("[data-bank-field]").forEach((select) => select.addEventListener("change", saveBankFieldOrder));
  $("#bank-field-reset").addEventListener("click", () => { state.ui.bankFieldOrder = [...DEFAULT_FIELD_ORDER]; saveState(); renderBankFieldOrder(); toast("رجع الترتيب الافتراضي"); });
  $("#bank-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    try { await importBankFile(file); } catch { toast("ما قدرت أقرأ الملف"); }
  });
  $("#bank-paste-clipboard").addEventListener("click", async () => {
    const text = await pasteBankFromClipboard();
    if (!text) { $("#bank-error").textContent = "اضغط مطولاً داخل المربع واختر «لصق»."; $("#bank-text").focus(); return; }
    $("#bank-text").value = text; $("#bank-error").textContent = ""; renderBankPreview();
  });
  $("#bank-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const summary = ingestBankText($("#bank-text").value);
    if (!summary.total) { $("#bank-error").textContent = "الصق نص إشعار واحد على الأقل."; return; }
    if (!summary.queued && !summary.duplicates && !summary.ignored.length) { $("#bank-error").textContent = manualBankMessage(summary.manual[0]); return; }
    closeDialog($("#bank-dialog"));
    reportBankSummary(summary);
  });
  $("#bank-text").addEventListener("input", renderBankPreview);
  $("#statement-file").addEventListener("change", (event) => prepareStatementImport(event.target.files?.[0]));
  $("#statement-import-form").addEventListener("submit", submitStatementImport);
  $("#statement-import-dialog").addEventListener("close", () => {
    pendingStatementBatch = null;
    $("#statement-file").value = "";
  });
  $("#transaction-search").addEventListener("input", renderTransactions);
  $("#transaction-kind-filter").addEventListener("change", renderTransactions);
  $("#commitment-search").addEventListener("input", renderCommitments);
  $("#commitment-category-filter").addEventListener("change", renderCommitments);
  $("#commitment-status-filter").addEventListener("change", renderCommitments);
  $("#pending-inbox-list").addEventListener("click", async (event) => {
    const approveId = event.target.dataset.approvePending;
    const reviewId = event.target.dataset.reviewPending;
    if (event.target.dataset.approveAll) {
      const ready = state.transactions.filter((item) => !item.reviewed && !item.possibleDuplicate);
      if (!ready.length) { toast("كلها تحتاج مراجعتك — فيها عمليات قد تكون مكررة"); return; }
      ready.forEach((item) => { item.reviewed = true; learnMerchant(item); });
      saveState(); renderAll(); toast(`تم اعتماد ${ready.length.toLocaleString("ar-KW-u-nu-latn")} عمليات`);
      return;
    }
    const syncId = event.target.dataset.syncBalance;
    if (syncId) {
      event.stopPropagation();
      const item = state.transactions.find((transaction) => transaction.id === syncId);
      if (!item?.notifBalanceFils) return;
      if (!(await askConfirm(`تحديث رصيدك المتاح إلى ${formatMoney(item.notifBalanceFils)}؟ تأكد أنه رصيد حسابك وليس رصيد بطاقة.`, { okLabel: "حدّث رصيدي" }))) return;
      state.settings.cashFils = item.notifBalanceFils;
      item.notifBalanceFils = null;
      saveState(); renderAll(); toast("تم تحديث رصيدك من الإشعار");
      return;
    }
    if (approveId) {
      const item = state.transactions.find((transaction) => transaction.id === approveId);
      if (!item) return;
      item.reviewed = true;
      item.possibleDuplicate = false;
      learnMerchant(item);
      saveState(); renderAll(); toast("تم اعتماد العملية وتعلّم اسم التاجر");
    }
    if (reviewId) {
      const item = state.transactions.find((transaction) => transaction.id === reviewId);
      if (item) openTransaction(item);
    }
  });
  $("#transaction-list").addEventListener("click", (event) => {
    const editId = event.target.dataset.editTransaction;
    const deleteId = event.target.dataset.deleteTransaction;
    if (editId) openTransaction(state.transactions.find((item) => item.id === editId));
    if (deleteId) removeRecord("transactions", deleteId, "العملية");
  });
  $("#commitment-list").addEventListener("click", (event) => {
    const editId = event.target.dataset.editCommitment;
    const deleteId = event.target.dataset.deleteCommitment;
    const toggleId = event.target.dataset.toggleCommitment;
    const paidId = event.target.dataset.toggleCommitmentPaid;
    if (editId) openCommitment(state.monthlyCommitments.find((item) => item.id === editId));
    if (deleteId) removeRecord("monthlyCommitments", deleteId, "الالتزام");
    if (toggleId) {
      const commitment = state.monthlyCommitments.find((item) => item.id === toggleId);
      if (commitment) {
        commitment.status = commitment.status === "paused" ? "active" : "paused";
        saveState(); renderAll(); toast(commitment.status === "active" ? "تمت إعادة تفعيل الالتزام" : "تم إيقاف الالتزام مؤقتاً");
      }
    }
    if (paidId) {
      const commitment = state.monthlyCommitments.find((item) => item.id === paidId);
      const dueDate = event.target.dataset.dueDate;
      if (!commitment || !validDate(dueDate)) return;
      const existingIndex = state.commitmentPayments.findIndex((item) => item.commitmentId === paidId && item.dueDate === dueDate && item.status !== "reversed");
      if (existingIndex >= 0) {
        state.commitmentPayments.splice(existingIndex, 1);
        toast("تم التراجع عن تسجيل الدفع");
      } else {
        state.commitmentPayments.push({ id: createId(), commitmentId: paidId, amountFils: commitment.amountFils, dueDate, paidAt: todayISO(), status: "paid" });
        toast("تم تسجيل الالتزام كمدفوع");
      }
      saveState(); renderAll();
    }
  });
  $("#loan-list").addEventListener("click", (event) => {
    const editId = event.target.dataset.editLoan;
    const deleteId = event.target.dataset.deleteLoan;
    const extraId = event.target.dataset.extraPayment;
    if (editId) openLoan(state.loans.find((item) => item.id === editId));
    if (deleteId) removeRecord("loans", deleteId, "القرض");
    if (extraId) openExtraPayment(state.loans.find((item) => item.id === extraId));
  });
  $("#goal-list").addEventListener("click", (event) => {
    const editId = event.target.dataset.editGoal;
    const deleteId = event.target.dataset.deleteGoal;
    if (editId) openGoal(state.goals.find((item) => item.id === editId));
    if (deleteId) removeRecord("goals", deleteId, "الهدف");
  });
  $("#stock-list").addEventListener("click", (event) => {
    const editId = event.target.dataset.editStock;
    const deleteId = event.target.dataset.deleteStock;
    const averageId = event.target.dataset.averageStock;
    if (averageId) {
      const input = event.target.closest(".stock-card")?.querySelector(".stock-adjustment-price");
      const buyPriceTenths = parseSharePriceTenths(input?.value ?? "");
      if (!buyPriceTenths) { toast("أدخل سعر شراء صحيح بالفلس"); input?.focus(); return; }
      openAverageDown(state.stockHoldings.find((item) => item.id === averageId), buyPriceTenths);
    }
    if (editId) openStock(state.stockHoldings.find((item) => item.id === editId));
    if (deleteId) removeRecord("stockHoldings", deleteId, "السهم");
  });
  $("#global-extra").addEventListener("change", () => {
    const value = parseMoney($("#global-extra").value);
    if (value === null) { toast("أدخل دفعة إضافية صحيحة"); $("#global-extra").value = moneyInput(state.ui.extraFils); return; }
    state.ui.extraFils = value; saveState(); renderLoans();
  });
  $("#financial-alert-list").addEventListener("click", (event) => {
    const alertId = event.target.dataset.dismissAlert;
    const alert = state.financialAlerts.find((item) => item.id === alertId);
    if (!alert) return;
    alert.dismissedAt = new Date().toISOString();
    alert.cooldownUntil = addDaysISO(todayISO(), 7);
    alert.active = false;
    saveState(); renderDashboard();
  });
  $("#accountant-prompts").addEventListener("click", (event) => {
    const question = event.target.closest("button")?.textContent?.trim();
    if (question) askAccountant(question);
  });
  $("#accountant-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const question = $("#accountant-question").value.trim();
    if (question) askAccountant(question);
  });
  $("#investment-form").addEventListener("input", () => renderInvestment(false));
  $("#export-data").addEventListener("click", exportData);
  $("#import-data").addEventListener("change", (event) => importData(event.target.files?.[0]));
  $("#reset-data").addEventListener("click", resetData);
  addEventListener("hashchange", () => {
    if (!handlePortfolioLink() && !handleBankAutomationLink()) switchView(location.hash.slice(1) || "dashboard", false);
  });
}

let deferredInstallPrompt = null;
function setupInstall() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const card = $("#install-card");
  card.hidden = standalone || state.ui.installDismissed;
  $("#dismiss-install").addEventListener("click", () => { state.ui.installDismissed = true; saveState(); card.hidden = true; });
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); deferredInstallPrompt = event;
    $("#install-button").hidden = false;
    $("#install-copy").textContent = "اضغط تثبيت لإضافة فلس إلى الشاشة الرئيسية.";
  });
  $("#install-button").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt(); deferredInstallPrompt = null; card.hidden = true;
  });
}


function initialize() {
  lockRecord = readLockRecord();
  if (!state.ui.backupBaselineAt) { state.ui.backupBaselineAt = new Date().toISOString(); saveState(); }
  setupSafetyEvents();
  $("#transaction-category").innerHTML = categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("");
  $("#loan-type").innerHTML = debtTypes.map((type) => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join("");
  updateCommitmentCategoryFilterOptions();
  bindEvents(); renderBankFieldOrder(); setupInstall(); renderAll({ investmentInputs: true }); captureFinancialSnapshot();
  const linkHandled = handlePortfolioLink() || handleBankAutomationLink();
  if (!linkHandled) switchView(location.hash.slice(1) || "dashboard", false);
  if (lockRecord) lockApp();
  else if (!linkHandled && !state.ui.onboarded && state.settings.incomeFils === 0) setTimeout(openOnboarding, 350);
  if (!storageAvailable) toast("التخزين المحلي غير متاح؛ البيانات لن تستمر بعد إغلاق الصفحة.");
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker registration failed", error));
  }
}

initialize();
