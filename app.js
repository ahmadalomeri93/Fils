import { readPDFStatement } from "./pdf-statement.js";
import { SECTOR_OPTIONS, mountCheckup } from "./checkup.js";
import { mountOnboarding } from "./onboarding.js";
import { EXPENSE_CATEGORIES, budgetReport, categoryNudges, mountSpending, monthKeyOf } from "./spending.js";
import { fundGoals, mountSalaryPlan, salaryDue } from "./salary-plan.js";
import { PIN_PATTERN, backupStatus, createLockRecord, cryptoAvailable, describeBackupAge, hasMeaningfulData, registerFailure, registerSuccess,
  remainingLockMs, sanitizeLockRecord, shouldRelock, verifyPin } from "./safety.js";
import { GOLD_PRICE_URL, goldSummary, mountGold, priceFromApi, sanitizeGold } from "./gold.js";
import { decideUpdate, installedVersion, remoteVersion, staticCacheNames, versionLabel } from "./app-update.js";
import { NOTIFICATION_REASONS, NOTIFICATION_TYPE_LABELS, isOwnTransfer, notificationFingerprints, parseBankNotification, splitBankMessages, splitStamp, timeFromCompact, BANK_FIELDS, DEFAULT_FIELD_ORDER } from "./bank-notifications.js";
import { parsePortfolioLink, newPortfolioHoldings } from "./portfolio-import.js";
import { mountAssistant } from "./ai-assistant.js";
import { clearAiStore } from "./ai-client.js";
import { INBOX_BASE, ackInbox, agoLabel, claimInbox, fetchInbox, inboxErrorMessage, inboxLink, itemsToBankText, newInboxKey, parseInboxKey, readInboxConfig, unclaimInbox, writeInboxConfig } from "./inbox.js";
import {
  categories,
  commitmentMatches,
  countLabel,
  inferCategory,
  createId,
  cutText,
  formatMoney,
  genericMerchantKey,
  investmentProjection,
  merchantDefaults,
  merchantKey,
  moneyInput,
  monthKey,
  normalizeDigits,
  parseBankText,
  parseCount,
  parseMoney,
  parseRate,
  payoff,
  searchText,
  todayISO
} from "./finance-core.js";
import {
  INSTALLMENT_CATEGORY,
  addDaysISO,
  addMonthsISO,
  answerFinancialQuestion,
  cashDeduction,
  commitmentOccurrences,
  commitmentRecurrences,
  commitmentSummary,
  createAdvisorAllocation,
  debtEndDate,
  debtOccurrences,
  debtProgress,
  debtSummary,
  endOfMonthForecast,
  explainDailyBudget,
  financialFlow,
  generateFinancialAlerts,
  livingBaseline,
  mergeFinancialAlerts,
  monthBounds,
  monthlySurplus,
  monthlyCommitmentEquivalent,
  paymentCashDeductedFils,
  recentInstallmentPayment,
  remainingInstallments,
  safeToSpendEngine,
  sameDueMonth,
  simulateExtraPayment,
  spendingComparison,
  totalMonthlyIncome
} from "./financial-engine.js";
import { hasScanSignal, parseLoanOCRLoans, scanAmountWarnings } from "./loan-ocr.js";
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
/* تطبيق الآيفون (Capacitor): في الموقع هذا يرجع false وما يتغير أي شي. native-bridge.js يتحمّل فقط داخل التطبيق. */
const IS_NATIVE = globalThis.Capacitor?.isNativePlatform?.() === true;
if (IS_NATIVE) document.documentElement.classList.add("is-native");
let native = null;
let nativeRestored = false;
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
    bankDrafts: [],
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
    ui: { installDismissed: false, extraFils: 0, initialPortfolioApplied: false, onboarded: false, lastBackupAt: "", backupBaselineAt: "", backupSnoozedUntil: "", goldGramFils: 0, zakatOtherFils: 0, zakatGoldFils: 0, zakatDebtsFils: 0, inflationRate: 2.5, dividends: {}, sectorOverrides: {}, bankSeen: [], bankSeenUpTo: "", bankFieldOrder: ["title", "subtitle", "body"], goldSpreadPct: 3, goldUsdKwd: 0.307 }
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
function validTime(value) { return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function optionalTime(value) { return validTime(value) ? value : ""; }
function optionalInteger(value, minimum = 0, maximum = 1_000_000) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

let lastSanitizeStats = { rawTransactions: 0, keptTransactions: 0, cappedTransactions: 0, invalidTransactions: 0 };

function sanitizeState(raw) {
  const clean = defaultState();
  lastSanitizeStats = { rawTransactions: Array.isArray(raw?.transactions) ? raw.transactions.length : 0, keptTransactions: 0, cappedTransactions: 0, invalidTransactions: 0 };
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
    // تاريخ غير صالح ما يصير «اليوم» بالصمت: السجل يُرفض ويُحتسب في تقرير الاستيراد (F39)
    date: validDate(item?.date) ? item.date : "",
    // وقت العملية «HH:mm» لو وصل من إشعار فيه وقت (المسجّل قبل v43 بلا وقت)
    time: optionalTime(item?.time),
    reviewed: item?.reviewed !== false,
    source: ["bank-text", "bank-statement"].includes(item?.source) ? item.source : "manual",
    rawMerchant: typeof item?.rawMerchant === "string" ? item.rawMerchant.trim().slice(0, 80) : "",
    fingerprint: typeof item?.fingerprint === "string" ? item.fingerprint.slice(0, 180) : "",
    notifBalanceFils: optionalInteger(item?.notifBalanceFils, 1, 1_000_000_000_000),
    cardLast4: /^\d{4}$/.test(item?.cardLast4 ?? "") ? item.cardLast4 : "",
    cardKind: ["card", "account"].includes(item?.cardKind) ? item.cardKind : "",
    possibleDuplicate: item?.possibleDuplicate === true,
    createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString()
  })).filter((item) => item.amountFils > 0 && item.merchant && item.date) : [];
  lastSanitizeStats.keptTransactions = clean.transactions.length;
  lastSanitizeStats.cappedTransactions = Math.max(lastSanitizeStats.rawTransactions - 20_000, 0);
  lastSanitizeStats.invalidTransactions = Math.max(Math.min(lastSanitizeStats.rawTransactions, 20_000) - clean.transactions.length, 0);

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
    amountFils: finiteInteger(item?.amountFils), dueDate: optionalDate(item?.dueDate), paidAt: optionalDate(item?.paidAt), status: item?.status === "reversed" ? "reversed" : "paid",
    cashDeducted: item?.cashDeducted === true,
    // دفعة جزئية: تنجمع مع غيرها، والباقي يظل محجوز لين يكتمل
    ...(item?.partial === true ? { partial: true } : {}),
    // المبلغ اللي انخصم فعلاً من الرصيد (يقل عن amountFils لو الرصيد ما يكفي)؛ الدفعات القديمة بدونه تُقرأ من العلامة فقط
    ...(Number.isSafeInteger(item?.cashDeductedFils) && item.cashDeductedFils >= 0 ? { cashDeductedFils: Math.min(item.cashDeductedFils, finiteInteger(item?.amountFils)) } : {})
  })).filter((item) => item.commitmentId && item.dueDate && item.amountFils > 0) : [];

  clean.creditCards = Array.isArray(raw.creditCards) ? raw.creditCards.slice(0, 50).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    name: typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "بطاقة ائتمان",
    reservedPaymentFils: finiteInteger(item?.reservedPaymentFils), status: item?.status === "paused" ? "paused" : "active"
  })).filter((item) => item.name && item.reservedPaymentFils >= 0) : [];

  // F10: إشعارات ما قدرنا نقرأ مبلغها (عملة أجنبية أو صيغة جديدة) تنتظر المستخدم بدل ما تنضاع
  clean.bankDrafts = Array.isArray(raw.bankDrafts) ? raw.bankDrafts.slice(0, 200).map((item) => ({
    id: typeof item?.id === "string" ? item.id.slice(0, 100) : createId(),
    raw: typeof item?.raw === "string" ? item.raw.slice(0, 1_000) : "",
    reason: typeof item?.reason === "string" ? item.reason.slice(0, 40) : "unrecognized",
    merchant: typeof item?.merchant === "string" ? item.merchant.trim().slice(0, 80) : "",
    foreignCurrency: /^[A-Za-z]{3}$/.test(item?.foreignCurrency ?? "") ? item.foreignCurrency.toUpperCase() : "",
    foreignAmount: typeof item?.foreignAmount === "string" ? item.foreignAmount.slice(0, 24) : "",
    dateISO: optionalDate(item?.dateISO),
    time: optionalTime(item?.time),
    createdAt: typeof item?.createdAt === "string" ? item.createdAt.slice(0, 40) : new Date().toISOString()
  })).filter((item) => item.raw) : [];

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
    ...(item?.priceSource === "market" ? { priceSource: "market" } : {}),
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
  clean.ui.bankSeen = Array.isArray(raw.ui?.bankSeen) ? raw.ui.bankSeen.filter((item) => typeof item === "string" && /^[0-9a-z]{1,16}$/.test(item)).slice(-BANK_SEEN_LIMIT) : [];
  clean.ui.bankSeenUpTo = validDate(raw.ui?.bankSeenUpTo) ? raw.ui.bankSeenUpTo : "";
  const fieldOrder = Array.isArray(raw.ui?.bankFieldOrder) ? raw.ui.bankFieldOrder.filter((item, i, all) => BANK_FIELDS.includes(item) && all.indexOf(item) === i) : [];
  clean.ui.bankFieldOrder = fieldOrder.length ? fieldOrder : [...DEFAULT_FIELD_ORDER];
  clean.ui.goldSpreadPct = finiteNumber(raw.ui?.goldSpreadPct, 3, 0, 20);
  clean.ui.goldUsdKwd = finiteNumber(raw.ui?.goldUsdKwd, 0.307, 0.2, 0.5);
  Object.assign(clean, sanitizeGold(raw));
  clean.ui.sectorOverrides = {};
  if (raw.ui?.sectorOverrides && typeof raw.ui.sectorOverrides === "object") {
    for (const [code, sector] of Object.entries(raw.ui.sectorOverrides)) {
      const current = sector === "بنوك" ? "مالية" : sector; // الاسم القديم للقطاع قبل 8 أكتوبر 2026
      if (getKuwaitStock(code) && SECTOR_OPTIONS.includes(current)) clean.ui.sectorOverrides[code] = current;
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

const BANK_SEEN_LIMIT = 20_000;
let storageAvailable = true;
function renderStorageWarning() {
  const banner = document.getElementById("storage-warning");
  if (banner) banner.hidden = storageAvailable;
}
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

/* داخل التطبيق فقط: نحمّل الجسر، ولو التخزين المحلي فاضي والتطبيق عنده نسخة على ملف نرجّعها قبل أول قراءة.
   أي فشل هنا ما يوقف التطبيق: يكمل بدون ميزات الآيفون. */
const nativeHooks = {
  getState: () => state,
  hasPin: () => Boolean(lockRecord),
  isLocked: () => lockedNow,
  lock: () => lockApp(),
  unlock: () => unlockApp(),
  toast: (message, options) => toast(message, options)
};
if (IS_NATIVE) {
  try {
    native = (await import("./native-bridge.js")).createNativeBridge(nativeHooks);
    nativeRestored = await native.restoreIfEmpty();
  } catch (error) {
    console.warn("Native bridge unavailable", error);
    native = null;
  }
}

let state = loadState();
/* الحفظ يحاول في كل مرة: الفشل قد يكون مؤقتاً (مساحة ممتلئة أو نافذة خاصة)،
   فما نقفل الحفظ للأبد، ونخلي تحذيراً ظاهراً على الشاشة إلى أن ينجح (F11). */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageAvailable = true;
    renderStorageWarning();
    native?.stateSaved();
    return true;
  } catch (error) {
    storageAvailable = false;
    renderStorageWarning();
    console.error(error);
    native?.stateSaved(); // النسخة على ملف التطبيق قد تنجح حتى لو التخزين المحلي امتلأ
    return false;
  }
}

/* كل تغيير يمر من هنا: ما نقول «تم» إلا إذا الحفظ نجح فعلاً، ونعرض «تراجع» إذا توفر. */
function commit(message, { undo = null, render = true, investmentInputs = false } = {}) {
  const saved = saveState();
  if (render) renderAll({ investmentInputs });
  if (!saved) { toast("ما قدرت أحفظ على الجهاز. صدّر نسخة احتياطية قبل ما تسكر الصفحة."); return false; }
  if (message) toast(message, undo ? { undo } : {});
  return true;
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

const timeFormatter = new Intl.DateTimeFormat("ar-KW-u-nu-latn", { hour: "numeric", minute: "2-digit" });
// «2:35 م» من «14:35»؛ نص فاضي لو الوقت غير موجود أو غير صالح
function formatTime(value) {
  if (!validTime(value)) return "";
  return timeFormatter.format(new Date(`2000-01-01T${value}:00`));
}
// التاريخ ومعه الوقت لو معروف: «9 أكتوبر 2026 · 2:35 م»
function formatDateTime(dateISO, time) {
  const clock = formatTime(time);
  return clock ? `${formatDate(dateISO)} · ${clock}` : formatDate(dateISO);
}

function formatStockTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "غير مسجل" : stockDateTimeFormatter.format(date);
}

// «تحديث الأسعار»: آخر سعر لكل سهم بالمحفظة من خادم حوّش (Yahoo Finance)، بالفلس مع منزلة عشرية
let stockRefreshBusy = false;
async function refreshStockPrices() {
  if (stockRefreshBusy || IS_NATIVE) return;
  // رقم الشركة بالبورصة (101) → رمزها (NBK)، والخادم يسأل عن الرمز
  const tickerOf = (holding) => getKuwaitStock(holding.securityCode)?.ticker ?? "";
  const codes = [...new Set(state.stockHoldings.map(tickerOf).filter(Boolean))];
  if (!codes.length) { toast("ما عندك أسهم للتحديث. أضف سهم أول."); return; }
  stockRefreshBusy = true;
  const button = $("#stock-refresh");
  if (button) { button.disabled = true; button.textContent = "جاري التحديث…"; }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(`${INBOX_BASE}/api/stocks/quotes?codes=${encodeURIComponent(codes.slice(0, 40).join(","))}`, { signal: controller.signal }).finally(() => clearTimeout(timer));
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) { toast("ما قدرت أجيب الأسعار الحين. جرّب بعد شوي."); return; }
    // السعر السابق نحفظه للتراجع؛ والسقف نفسه سقف sanitizeState (فوقه يُحذف السهم عند التحميل)
    const before = new Map(state.stockHoldings.map((holding) => [holding.id, { currentPriceTenths: holding.currentPriceTenths, priceUpdatedAt: holding.priceUpdatedAt, priceSource: holding.priceSource }]));
    let updated = 0;
    for (const holding of state.stockHoldings) {
      const quote = data.quotes?.[tickerOf(holding)];
      const tenths = quote ? Math.round(Number(quote.priceFils) * 10) : 0;
      if (!Number.isSafeInteger(tenths) || tenths <= 0 || tenths > 100_000_000) continue;
      const quotedAt = Date.parse(quote.at ?? "");
      holding.currentPriceTenths = tenths;
      holding.priceUpdatedAt = Number.isNaN(quotedAt) ? new Date().toISOString() : new Date(quotedAt).toISOString();
      holding.priceSource = "market";
      updated += 1;
    }
    const missing = Array.isArray(data.missing) && data.missing.length ? ` · ما لقيت: ${data.missing.slice(0, 6).join("، ")}` : "";
    commit(updated ? `حدّثت أسعار ${countLabel(updated, "stock")}${missing}` : `ما لقيت أسعار جديدة${missing}`, updated ? { undo: () => {
      for (const holding of state.stockHoldings) {
        const old = before.get(holding.id);
        if (!old) continue;
        holding.currentPriceTenths = old.currentPriceTenths;
        holding.priceUpdatedAt = old.priceUpdatedAt;
        if (old.priceSource) holding.priceSource = old.priceSource; else delete holding.priceSource;
      }
      commit("رجّعت الأسعار السابقة");
    } } : {});
  } catch {
    toast("ما قدرت أوصل للأسعار. تأكد من النت.");
  } finally {
    stockRefreshBusy = false;
    if (button) { button.disabled = false; button.textContent = "↻ تحديث الأسعار"; }
  }
}

function formatSignedMoney(valueFils) {
  if (!valueFils) return formatMoney(0);
  return `${valueFils > 0 ? "\u200E+" : "\u200E−"}${formatMoney(Math.abs(valueFils))}`;
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value) || Math.abs(value) < .005) return "0٪";
  return `${value > 0 ? "\u200E+" : "\u200E−"}${Math.abs(value).toLocaleString("ar-KW-u-nu-latn", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}٪`;
}

function stockPriceInput(priceTenths) {
  if (!Number.isSafeInteger(priceTenths) || priceTenths <= 0) return "";
  return (priceTenths / 10).toFixed(priceTenths % 10 ? 1 : 0);
}

function parseShareQuantity(value) {
  return parseCount(value, { min: 1, max: 100_000_000 });
}

function formatDuration(months) {
  if (months === 0) return "مكتمل";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return countLabel(months, "month");
  return rest ? `${countLabel(years, "year")} و${countLabel(rest, "month")}` : countLabel(years, "year");
}

let toastTimer;
function toast(message, { undo = null, undoLabel = "تراجع" } = {}) {
  const element = $("#toast");
  element.textContent = "";
  element.append(document.createTextNode(message));
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-undo";
    button.textContent = undoLabel;
    button.addEventListener("click", () => { hideToast(); undo(); });
    element.append(button);
  }
  // النافذة المفتوحة في الطبقة العلوية تغطي أي شيء في الصفحة، فالتوست ينتقل داخلها (F22)
  const open = [...document.querySelectorAll("dialog[open]")];
  const host = open.length ? open[open.length - 1] : document.body;
  if (element.parentElement !== host) host.append(element);
  element.classList.add("show");
  element.classList.toggle("has-action", Boolean(undo));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 7000 : 2600);
}
function hideToast() {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.classList.remove("show", "has-action");
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

function wouldRenameOthers(record) {
  const key = merchantKey(record.rawMerchant);
  // وصف عام ما نتعلّم منه أصلاً، فلا نسأل عنه (F28)
  if (!key || genericMerchantKey(key)) return 0;
  return state.transactions.filter((item) => item.id !== record.id && item.rawMerchant &&
    merchantKey(item.rawMerchant) === key && item.merchant !== record.merchant).length;
}
function learnMerchant(record) {
  if (!["bank-text", "bank-statement"].includes(record.source) || !record.rawMerchant) return;
  const key = merchantKey(record.rawMerchant);
  if (genericMerchantKey(key)) return;
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

/* الحذف الصامت لازم يكون مبنياً على شيء يميّز العملية فعلاً: مرجع أو رصيد أو وقت.
   بدونها، شراءان بنفس المبلغ من نفس التاجر في نفس اليوم عمليتان مختلفتان،
   فنضيفها ونعلّمها «قد تكون مكررة» ونخلي القرار للمستخدم (F8). */
function findNotificationDuplicate(fingerprints, { kind = null, balanceFils = null } = {}) {
  if (fingerprints.distinctive) {
    const exact = state.transactions.find((item) => item.fingerprint && item.fingerprint === fingerprints.full);
    if (exact) return { duplicate: exact };
  }
  // الاسترداد (دخل) مو تكرار للشراء (مصروف) بنفس المبلغ واليوم، وشراءان برصيدين مختلفين بعدهما عمليتان أكيد (F8)
  return { possibleDuplicate: state.transactions.some((item) => (!kind || item.kind === kind) && bankItemBase(item) === fingerprints.base &&
    !(balanceFils && item.notifBalanceFils && item.notifBalanceFils !== balanceFils)) };
}

function queueNotification(notification) {
  const learned = notification.type === "purchase"
    ? applyMerchantKnowledge({ merchant: notification.rawMerchant, category: notification.category })
    : { merchant: notification.merchant, rawMerchant: notification.rawMerchant, category: notification.category };
  const fingerprints = notificationFingerprints({ ...notification, rawMerchant: learned.rawMerchant });
  const found = findNotificationDuplicate(fingerprints, notification);
  if (found.duplicate) return { status: "duplicate", record: found.duplicate };
  const record = {
    id: createId(), amountFils: notification.amountFils, merchant: learned.merchant, rawMerchant: learned.rawMerchant,
    category: learned.category, kind: notification.kind, date: notification.dateISO, time: optionalTime(notification.timeHM), reviewed: false, source: "bank-text",
    fingerprint: fingerprints.full, notifBalanceFils: notification.balanceFils, cardLast4: notification.cardLast4 ?? "",
    cardKind: notification.cardKind ?? "",
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

/* الرسائل الترويجية والتحيات ما تصير مسودات: المسودة لإشعار فيه مبلغ ما قدرنا نقرأه. */
function looksFinancial(raw) {
  const text = normalizeDigits(String(raw ?? "")).replaceAll("٫", ".");
  return /\d/.test(text) && /(?:KWD|KD|د\.ك|دينار|USD|EUR|GBP|AED|SAR|\b[A-Z]{3}\b)/i.test(text);
}

// وقت الإشعار «HH:mm»: من سطر الطابع (وقت وصوله على جوالك)، وإلا من وقت مكتوب بنص الإشعار نفسه.
// ما نخترع وقتاً: رسالة ملصوقة بلا طابع ولا وقت بنصها تبقى بلا وقت. ولو التاريخ المحفوظ غير تاريخ الطابع
// (اخترت تاريخاً ثانياً، أو الطابع بالمستقبل) وقت الطابع ما ينطبق عليه. وإذا نص الإشعار فيه تاريخ ثاني
// (رسالة وصلت متأخرة أو عبر منتصف الليل) نأخذ وقته من نصه هو، ولو ما فيه وقت يبقى بلا وقت.
function notificationClock(notification, stampISO, stampTime, usedStamp) {
  const stampDateUsed = Boolean(stampISO) && usedStamp === stampISO && usedStamp <= todayISO();
  if (stampISO && !stampDateUsed) return "";
  if (stampISO && notification.dateISO !== stampISO) return timeFromCompact(notification.time);
  return stampTime || timeFromCompact(notification.time);
}

function draftFromNotification(notification, stampISO) {
  return {
    id: createId(), raw: String(notification.raw ?? "").slice(0, 1_000), reason: notification.reason ?? "unrecognized",
    merchant: notification.rawMerchant || notification.merchant || "",
    foreignCurrency: notification.foreign?.currency ?? "", foreignAmount: notification.foreign?.amount ?? "",
    dateISO: stampISO || "", time: stampISO ? optionalTime(notification.timeHM) : "", createdAt: new Date().toISOString()
  };
}

function ingestBankText(raw, { fromFile = false, dateOverrideISO = "" } = {}) {
  const today = todayISO();
  const all = splitBankMessages(raw);
  const seen = new Set(state.ui.bankSeen);
  const messages = all.filter((message) => !seen.has(bankMessageHash(message)));
  const summary = { total: messages.length, alreadyRead: all.length - messages.length, queued: 0, duplicates: 0, possible: 0, drafts: 0, ignored: [], manual: [] };
  const read = [];
  const batch = new Set();
  for (const message of messages) {
    const { stampISO, stampTime, body } = splitStamp(message);
    // نفس الإشعار بنفس الطابع وبنفس الوقت مرتين بالملف (الاختصار اشتغل مرتين) = إشعار واحد.
    // بدون وقت بالطابع ما نحكم، لأن شراءين حقيقيين بنفس المبلغ ممكنين (F8).
    const hash = bankMessageHash(message);
    if (stampISO && /\d{1,2}:\d{2}/.test(normalizeDigits(message.split("\n")[0])) && batch.has(hash)) {
      summary.duplicates += 1; read.push(message); continue;
    }
    batch.add(hash);
    const stamp = dateOverrideISO && validDate(dateOverrideISO) && dateOverrideISO <= today ? dateOverrideISO : stampISO;
    const notification = withOwnTransferRule(parseBankNotification(body, { todayISO: stamp && stamp <= today ? stamp : today, fieldOrder: state.ui.bankFieldOrder }));
    notification.timeHM = notificationClock(notification, stampISO, stampTime, stamp);
    if (notification.ignored) { summary.ignored.push(NOTIFICATION_REASONS[notification.reason]); read.push(message); continue; }
    if (notification.needsManual) {
      summary.manual.push(notification);
      // من ملف الاختصار ما فيه أحد يقرأ الشاشة، فنحفظها مسودة بدل ما تُنسى (F10).
      // رسالة بلا مبلغ (تحية أو عرض) ما تصير مسودة، لكنها تُعدّ مقروءة حتى ما تتكرر كل جلب.
      if (fromFile) {
        if (looksFinancial(notification.raw) && state.bankDrafts.length < 200 && !state.bankDrafts.some((item) => item.raw === notification.raw)) {
          state.bankDrafts.push(draftFromNotification(notification, stamp));
          summary.drafts += 1;
        }
        read.push(message);
      }
      continue;
    }
    const result = queueNotification(notification);
    if (result.status === "duplicate") summary.duplicates += 1;
    else { summary.queued += 1; if (result.record.possibleDuplicate) summary.possible += 1; }
    read.push(message);
  }
  if (fromFile) {
    // الملف يُقرأ كل مرة من أوله، فنتذكر الرسائل اللي عالجناها فقط — لا كل اللي شفناها (F10 · F30)
    state.ui.bankSeen = [...state.ui.bankSeen, ...read.map(bankMessageHash)].slice(-BANK_SEEN_LIMIT);
    state.ui.bankSeenUpTo = today;
  }
  if (summary.queued || summary.drafts || fromFile) { saveState(); renderAll(); }
  return summary;
}

// تحويل بين حساباتك ما ينسجّل: نقارن الطرف الثاني بحساباتك اللي عرفناها من إشعاراتك السابقة.
function withOwnTransferRule(notification) {
  if (notification.ignored || notification.needsManual) return notification;
  // المصروفات فقط: حساب المصروف هو حسابك أنت، أما الدخل القديم فقد يحمل رقم حساب المرسل
  const accounts = state.transactions.filter((item) => item.kind === "expense" && item.cardKind === "account" && item.cardLast4).map((item) => item.cardLast4);
  return isOwnTransfer(notification, accounts) ? { ...notification, ignored: true, reason: "own_transfer" } : notification;
}

function manualBankMessage(notification) {
  if (notification.reason === "no_amount") return "النص ناقص أو ما فيه مبلغ. انسخ الرسالة كاملة من أولها لآخرها (فيها «مبلغ … د.ك»)، أو أضفها يدويًا.";
  if (notification.reason === "foreign" && notification.foreign) {
    return `عملة أجنبية: ${notification.foreign.currency} ${notification.foreign.amount} — أضفها يدوياً بالدينار حسب مبلغ كشف حسابك.`;
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

function reportBankSummary(summary, { auto = false } = {}) {
  const parts = [];
  if (summary.queued) parts.push(summary.queued === 1 && summary.total === 1 ? "وصل إشعار — راجعه واعتمده" : `أضفت ${countLabel(summary.queued, "transaction")} للمراجعة`);
  if (summary.possible) parts.push(`${countLabel(summary.possible, "transaction")} قد تكون مكررة`);
  if (summary.duplicates) parts.push(`${countLabel(summary.duplicates, "transaction")} مكررة تجاهلتها`);
  if (summary.drafts) parts.push(`${countLabel(summary.drafts, "notification")} تحتاج مبلغاً بالدينار${auto ? " (افتح «العمليات»)" : ""}`);
  if (summary.ignored.length) parts.push(summary.ignored[0] + (summary.ignored.length > 1 ? ` (+${(summary.ignored.length - 1).toLocaleString("ar-KW-u-nu-latn")})` : ""));
  if (!parts.length && summary.alreadyRead && !summary.manual.length) parts.push("ما فيه رسائل جديدة من آخر مرة");
  // الجلب التلقائي ما ينقلك لصفحة ثانية ولا يفتح نافذة وانت فاتح التطبيق لشي ثاني
  if ((summary.queued || summary.drafts) && !auto) switchView("transactions");
  if (parts.length) toast(parts.join(" · "));
  if (summary.manual.length && !summary.drafts && !auto) showBankManual(summary.manual[0]);
}

function describeNotification(notification) {
  if (notification.ignored || notification.needsManual) return `⚠ ${escapeHTML((notification.reason === "foreign" && notification.foreign) || notification.reason === "no_amount" ? manualBankMessage(notification) : (NOTIFICATION_REASONS[notification.reason] ?? "غير معروف"))}`;
  const sign = notification.kind === "income" ? "\u200E+" : "\u200E−";
  const bits = [
    NOTIFICATION_TYPE_LABELS[notification.type] ?? "عملية",
    `${sign}${formatMoney(notification.amountFils)}`,
    `${notification.merchant} (${notification.category})`,
    `${formatDateTime(notification.dateISO, notification.timeHM)}${notification.dateAssumed ? " (اليوم افتراضياً)" : ""}`
  ];
  if (notification.balanceFils) bits.push(`رصيد ${formatMoney(notification.balanceFils)}`);
  if (notification.cardLast4) bits.push(`${notification.cardKind === "account" ? "حساب" : "بطاقة"} ••${notification.cardLast4}`);
  return `✓ ${bits.map(escapeHTML).join(" · ")}`;
}

function revealBankFeedback() {
  const target = $("#bank-error").textContent ? $("#bank-error") : $("#bank-preview");
  if (!target.textContent.trim()) return;
  // الأزرار ثابتة بأسفل النافذة، فنمرّر لو الرسالة صارت تحتها
  requestAnimationFrame(() => {
    const footer = $("#bank-dialog .dialog-actions")?.getBoundingClientRect();
    if (footer && target.getBoundingClientRect().bottom > footer.top - 8) target.scrollIntoView({ block: "end" });
  });
}

function inBrowserTab() {
  if (IS_NATIVE) return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !(matchMedia("(display-mode: standalone)").matches || navigator.standalone === true);
}

function renderBankPreview() {
  const box = $("#bank-preview");
  if (!box) return;
  const browserNote = $("#bank-browser-note");
  if (browserNote) browserNote.hidden = !inBrowserTab();
  const messages = splitBankMessages($("#bank-text").value);
  const today = todayISO();
  const override = $("#bank-date")?.value ?? "";
  box.innerHTML = messages.slice(0, 5).map((message) => {
    const { stampISO, stampTime, body } = splitStamp(message);
    // المعاينة تستخدم نفس تاريخ الحفظ (الطابع أو ما يختاره المستخدم) حتى ما يفاجئه الفرق (F32)
    const stamp = validDate(override) && override <= today ? override : stampISO;
    const notification = withOwnTransferRule(parseBankNotification(body, { todayISO: stamp && stamp <= today ? stamp : today, fieldOrder: state.ui.bankFieldOrder }));
    // التاريخ جا من سطر الطابع أو من خانة التاريخ، فما هو «اليوم افتراضياً» (F32)
    if (stamp && stamp <= today && notification.dateISO === stamp) notification.dateAssumed = false;
    notification.timeHM = notificationClock(notification, stampISO, stampTime, stamp);
    let flag = "";
    if (!notification.ignored && !notification.needsManual) {
      const found = findNotificationDuplicate(notificationFingerprints(notification), notification);
      if (found.duplicate) flag = ' <b class="preview-dup">⚠ موجودة من قبل</b>';
      else if (found.possibleDuplicate) flag = ' <b class="preview-dup">⚠ قد تكون مكررة</b>';
    }
    return `<div>${describeNotification(notification)}${flag}</div>`;
  }).join("") +
    (messages.length > 5 ? `<div>… و${countLabel(messages.length - 5, "notification")} أخرى</div>` : "");
  revealBankFeedback();
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
    // نفس منطق المتاح الآمن: المعاش يُحسب إذا يوم نزوله لسه قدّام هذا الشهر (v35)
    incomeFils,
    salaryDay: state.settings.salaryDay,
    todayISO: today
  });
  const bounds = monthBounds(today);
  const living = advisorLivingBaseline(today);
  // «قسط» داخل الأقساط الشهرية أصلاً، فما يُحسب مرة ثانية في مصروف الشهر والميزانية (F3)
  const expenses = currentMonthTransactions("expense").filter((item) => item.category !== INSTALLMENT_CATEGORY);
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
    // F5: الفائض/العجز الشهري من نفس الدالة اللي يستخدمها الخطة والفحص وخطة الأهداف
    living,
    surplus: monthlySurplus({ incomeFils, debtPaymentsFils: debts.monthlyPaymentsFils, commitmentsFils: commitments?.monthlyEquivalentFils ?? 0, livingFils: living.amountFils }),
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

/* صافي الثروة: النقد والأصول + قيمة ما تتابعه فعلاً (أسهم وذهب) − كل الدين المتبقي.
   «قيمة الاستثمارات» في الإعدادات رقم يدوي، فنستخدمه فقط إذا ما فيه محفظة متابَعة حتى لا يُحتسب مرتين (F19). */
function trackedInvestmentFils() {
  const stocksFils = state.stockHoldings.reduce((sum, holding) => sum + (calculateStockPosition(holding)?.currentValueFils ?? 0), 0);
  const goldFils = goldSummary(state.goldPurchases, state.goldPrices.at(-1)?.fils24).valueFils ?? 0;
  const tracked = stocksFils + goldFils;
  return { stocksFils, goldFils, tracked, usedFils: tracked > 0 ? tracked : state.settings.investedFils };
}
function netWorthFils(debts) {
  const investments = trackedInvestmentFils();
  // المتوقف ما يزول: debtSummary يحتسب رصيده ضمن الإجمالي
  return state.settings.cashFils + state.settings.assetsFils + investments.usedFils - debts.totalBalanceFils;
}

function renderDashboard() {
  const context = financialContext();
  syncFinancialAlerts(context);
  context.alertCount = state.financialAlerts.filter((item) => item.active && !item.dismissedAt).length;
  const todaySpent = context.expenses.filter((item) => item.date === context.todayISO).reduce((sum, item) => sum + item.amountFils, 0);
  const netWorth = netWorthFils(context.debts);
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
  setText("#safe-payday-due", formatMoney(context.safe?.paydayDueFils ?? 0));
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
  // بدون دخل ولا رصيد مسجل، «18 يوم للراتب» رقم بلا معنى (F61)
  const hasBasics = context.incomeFils > 0 || state.settings.cashFils > 0;
  setText("#days-remaining", context.safe && hasBasics ? context.safe.daysUntilPayday.toLocaleString("ar-KW-u-nu-latn") : "—");
  $("#daily-progress").style.width = `${Math.min(Math.max(dailyRatio * 100, 0), 100)}%`;
  dailyCard.classList.toggle("over-budget", dailyRemaining < 0);
  if (!context.incomeFils || !state.settings.cashFils) {
    setText("#daily-status", "بيانات ناقصة");
    setText("#daily-guidance", "أضف دخلك ورصيدك الحالي من الإعدادات حتى نحسب المتاح اليوم بدقة.");
  } else if (context.safe?.shortfallFils > 0 || dailyRemaining < 0) {
    setText("#daily-status", "يحتاج انتباه");
    setText("#daily-guidance", explainDailyBudget({ safe: context.safe, cashFils: state.settings.cashFils, todaySpentFils: todaySpent, dailyRemainingFils: dailyRemaining }, formatMoney));
  } else {
    setText("#daily-status", "ضمن المسار");
    setText("#daily-guidance", `تقدر تصرف حتى ${formatMoney(Math.max(dailyRemaining, 0))} اليوم وتبقى التزاماتك محجوزة.`);
  }

  // F5: نفس رقم الخطة والفحص والأهداف (monthlySurplus)، والمعيشة متوسط آخر 3 أشهر مكتملة بدون «قسط»
  const surplus = context.surplus;
  const livingKnown = context.living.source !== "missing";
  setText("#flow-income", formatMoney(surplus.incomeFils));
  setText("#flow-debts", formatMoney(surplus.debtPaymentsFils));
  setText("#flow-commitments", formatMoney(surplus.commitmentsFils));
  setText("#flow-expenses", livingKnown ? formatMoney(surplus.livingFils) : "—");
  // العجز قد يكون سالباً: نعرضه بعلامته لا مقصوصاً على صفر (F4)
  setText("#flow-available-label", livingKnown && surplus.surplusFils < 0 ? "ينقصك" : "يبقى لك");
  setText("#flow-available", livingKnown ? formatMoney(Math.abs(surplus.surplusFils)) : "—"); // «ينقصك» مع رقم موجب: لا ننحرج بسالب مع «ينقصك»
  $("#flow-available").classList.toggle("amount-negative", livingKnown && surplus.surplusFils < 0);
  $("#flow-available").parentElement.classList.toggle("is-deficit", livingKnown && surplus.surplusFils < 0);
  setText("#flow-caption", (context.living.source === "transactions"
    ? `معيشتك = متوسط صرفك آخر ${countLabel(context.living.months, "month")} بدون الأقساط.`
    : context.living.source === "budget"
      ? "معيشتك من الميزانية اللي سجلتها."
      : "سجّل صرف 3 أشهر أو حدد ميزانيتك بالإعدادات عشان نحسب كم يبقى لك.") +
    ` صرفك هالشهر لين الحين: ${formatMoney(context.spentFils)}.`);

  if (context.forecast?.sufficient) {
    setText("#forecast-status", "تقديري");
    setText("#forecast-balance", formatMoney(context.forecast.forecastAvailableFils));
    const salaryNote = context.forecast.salaryFils > 0 ? ` يشمل معاشك ${formatMoney(context.forecast.salaryFils)} بتاريخ ${formatDate(context.forecast.salaryDateISO)}، وبعد خصم أقساطك والتزاماتك ودفعة البطاقات مرة وحدة.` : "";
    setText("#forecast-message", `إذا استمر صرفك بمتوسط ${formatMoney(context.forecast.averageDailyFils)} يومياً، فهذا هو المتاح المتوقع بنهاية الشهر.${salaryNote}`);
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
  if (pending) message = `عندك ${countLabel(pending, "transaction")} تحتاج مراجعة قبل تدخل في حساباتك.`;
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
  // F25: المتوسط من الأشهر المكتملة فقط، والشهر الجاري يُستثنى حتى لا يكسر المقارنة
  setText("#behavior-average-caption", report.partialMonth ? `بدون الشهر الجاري (${report.partialMonth})` : "من الأشهر المسجلة");
  setText("#behavior-top-category", report.categories[0]?.name ?? "—");
  const maximum = Math.max(...report.monthly.map((item) => item.totalFils), 1);
  $("#behavior-month-chart").innerHTML = report.monthly.map((item) => `
    <div class="behavior-month-row"><span>${escapeHTML(item.label)}</span><div class="behavior-month-bar"><i style="width:${Math.max(item.totalFils ? 3 : 0, item.totalFils / maximum * 100)}%"></i></div><strong>${escapeHTML(formatMoney(item.totalFils))}</strong></div>`).join("");
  const insights = report.insights.length ? report.insights : ["ما ظهر نمط متكرر كافٍ حتى الآن؛ راجع التصنيفات بعد الاستيراد لتتحسن القراءة."];
  $("#behavior-insights").innerHTML = insights.map((item) => `<li>${escapeHTML(item)}</li>`).join("");
  const repeated = report.merchants.slice(0, 3);
  $("#behavior-repeat-section").hidden = repeated.length === 0;
  $("#behavior-repeat-list").innerHTML = repeated.map((item) => `
    <div class="behavior-repeat-row"><span><strong>${escapeHTML(item.merchant)}</strong><small>${countLabel(item.count, "transaction")} · ${countLabel(item.months, "month")}</small></span><strong>${escapeHTML(formatMoney(item.averagePerRecordedMonthFils))}<small>لكل شهر ظهر فيه</small></strong></div>`).join("");
  $("#behavior-category-change-section").hidden = report.categoryChanges.length === 0;
  $("#behavior-category-change-list").innerHTML = report.categoryChanges.map((item) => `
    <div class="behavior-repeat-row"><span><strong>${escapeHTML(item.name)}</strong><small>متوسط الشهر: ${escapeHTML(formatMoney(item.previousAverageFils))} ← ${escapeHTML(formatMoney(item.recentAverageFils))}</small></span><strong class="behavior-change">+${Math.round(item.changePercent).toLocaleString("ar-KW-u-nu-latn")}٪</strong></div>`).join("");
  const importedStart = state.statementImport.coverageStartISO || report.fromISO;
  const importedEnd = state.statementImport.coverageEndISO || report.toISO;
  const firstTransaction = report.recordedStartISO ? formatDate(report.recordedStartISO) : formatDate(importedStart);
  const lastTransaction = report.recordedEndISO ? formatDate(report.recordedEndISO) : formatDate(importedEnd);
  setText("#behavior-coverage", `نافذة التحليل: ${formatDate(report.fromISO)} إلى ${formatDate(report.toISO)} · أقدم وآخر حركة مسجلة: ${firstTransaction} إلى ${lastTransaction} · ${countLabel(report.activeMonths, "month")} فيها مصروفات من ${countLabel(report.count, "transaction")} معتمدة. تأكد أن ملف الكشف يغطي الفترة كاملة؛ الشهر الخالي من العمليات قد يكون بلا صرف أو خارج الملف.`);
}

const sourceLabel = (source) => source === "manual" ? "يدوي" : source === "bank-statement" ? "من الكشف" : "من الإشعار";
// كل جزء من السطر الصغير يبقى بسطر وحد (ما ينقطع «من / الإشعار»)، والسطر نفسه يلتف بدل ما ينقص بنقاط
const cardChip = (item) => item.cardLast4 ? ` · <span class="meta-keep">${item.cardKind === "account" ? (/^تحويل/.test(item.merchant) ? (item.kind === "income" ? "إلى حساب" : "من حساب") : "حساب") : "بطاقة"} ••${escapeHTML(item.cardLast4)}</span>` : "";
const metaLine = (item) => `${escapeHTML(item.category)} · <span class="meta-keep">${escapeHTML(formatDateTime(item.date, item.time))}</span> · <span class="meta-keep">${escapeHTML(sourceLabel(item.source))}</span>${cardChip(item)}`;

/* البحث يشمل الاسم الخام والتصنيف والتاريخ والمبلغ، ويوحّد الأرقام والفواصل العربية قبل المقارنة (F50). */
function transactionMatches(item, query) {
  if (!query) return true;
  const haystack = searchText(`${item.merchant} ${item.rawMerchant} ${item.category} ${item.date} ${moneyInput(item.amountFils)} ${formatDate(item.date)} ${sourceLabel(item.source)}`);
  return haystack.includes(query);
}

function draftLine(draft) {
  const foreign = draft.foreignCurrency ? `${draft.foreignCurrency} ${draft.foreignAmount}` : "";
  return `<article class="bank-draft" data-draft-id="${escapeHTML(draft.id)}">
    <strong>${escapeHTML(draft.merchant || "إشعار عملية")}</strong>
    <p>${escapeHTML(cutText(draft.raw, 220))}</p>
    <small>${escapeHTML(foreign ? `بعملة ${foreign} — أدخل المبلغ بالدينار من كشف حسابك` : (NOTIFICATION_REASONS[draft.reason] ?? "ما قدرت أحدد المبلغ"))}${draft.dateISO ? ` · ${escapeHTML(formatDateTime(draft.dateISO, draft.time))}` : ""}</small>
    <div class="row">
      <button type="button" class="primary small" data-draft-amount="${escapeHTML(draft.id)}">أدخل المبلغ بالدينار</button>
      <button type="button" class="ghost small" data-draft-delete="${escapeHTML(draft.id)}">تجاهل</button>
    </div>
  </article>`;
}

function renderTransactions() {
  const query = searchText($("#transaction-search").value).trim();
  const filter = $("#transaction-kind-filter").value;
  const filtered = state.transactions
    .filter((item) => transactionMatches(item, query))
    .filter((item) => filter === "all" || (filter === "pending" ? !item.reviewed : item.kind === filter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const pendingItems = state.transactions
    .filter((item) => !item.reviewed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = pendingItems.length;
  const drafts = state.bankDrafts;
  $("#pending-inbox").hidden = pending === 0 && drafts.length === 0;
  setText("#pending-count", (pending + drafts.length).toLocaleString("ar-KW-u-nu-latn"));
  renderBankCard();
  $("#pending-inbox-list").innerHTML = drafts.map(draftLine).join("") +
    (pending > 1 ? `<button type="button" class="secondary approve-all" data-approve-all="1">اعتماد الكل (بدون المشكوك فيها)</button>` : "") + pendingItems.map((item) => `
    <article class="pending-inbox-item">
      <div><strong>${escapeHTML(item.merchant)}</strong><small>${metaLine(item)}</small>${item.possibleDuplicate ? '<span class="pending-badge">قد تكون مكررة</span>' : ""}</div>
      <div class="pending-inbox-amount ${item.kind === "income" ? "income" : ""}">${item.kind === "income" ? "\u200E+" : "\u200E−"}${escapeHTML(formatMoney(item.amountFils))}</div>
      ${item.notifBalanceFils ? `<button type="button" class="ghost small sync-balance" data-sync-balance="${escapeHTML(item.id)}">الرصيد بالإشعار ${escapeHTML(formatMoney(item.notifBalanceFils))} — تحديث رصيدي</button>` : ""}
      <div class="pending-inbox-actions">
        <button type="button" class="primary" data-approve-pending="${escapeHTML(item.id)}">اعتماد</button>
        <button type="button" class="secondary" data-review-pending="${escapeHTML(item.id)}">تعديل</button>
        <button type="button" class="danger" data-delete-pending="${escapeHTML(item.id)}">حذف</button>
      </div>
    </article>`).join("");
  const pendingNotice = $("#pending-notice");
  pendingNotice.hidden = true;
  pendingNotice.textContent = "";
  $("#transaction-empty").hidden = state.transactions.length > 0;
  $("#transaction-list").innerHTML = filtered.length ? filtered.map((item) => `
    <article class="transaction-item" data-id="${escapeHTML(item.id)}">
      <div class="transaction-icon ${item.kind === "income" ? "income" : ""}">${item.kind === "income" ? "↓" : "↑"}</div>
      <div class="transaction-main">
        <strong>${escapeHTML(item.merchant)}</strong>
        <small>${metaLine(item)}</small>
        ${item.reviewed ? "" : '<span class="pending-badge">تحتاج مراجعة</span>'}
      </div>
      <div>
        <div class="transaction-amount ${item.kind === "income" ? "income" : ""}">${item.kind === "income" ? "\u200E+" : "\u200E−"}${escapeHTML(formatMoney(item.amountFils))}</div>
        <div class="item-actions"><button data-edit-transaction="${escapeHTML(item.id)}">${item.reviewed ? "تعديل" : "مراجعة"}</button><button class="delete" data-delete-transaction="${escapeHTML(item.id)}">حذف</button></div>
      </div>
    </article>`).join("") : (state.transactions.length ? '<div class="empty-inline">ما في نتائج تطابق بحثك أو الفلتر.</div>' : "");
}

function paymentMethodLabel(value) {
  return { bank: "خصم من الحساب", credit_card: "بطاقة ائتمان", cash: "نقدي", other: "أخرى" }[value] ?? "أخرى";
}

function commitmentStatusInfo(commitment, today = todayISO()) {
  const bounds = monthBounds(today);
  const monthOccurrences = bounds ? commitmentOccurrences([commitment], { fromISO: bounds.startISO, toISO: bounds.endISO, payments: state.commitmentPayments, includePaused: true }) : [];
  const current = monthOccurrences.find((item) => !item.paid) ?? monthOccurrences[0] ?? null;
  if (commitment.status === "paused") return { key: "paused", label: "متوقف مؤقتاً", occurrence: current };
  if (commitment.status === "completed") return { key: "completed", label: "مكتمل", occurrence: current };
  const late = monthOccurrences.find((item) => !item.paid && item.dueDate < today);
  // مرّ موعده في هذا الشهر وما سُجّل دفعه: «متأخر» لا «نشط» (F14)
  if (late) return { key: "overdue", label: "متأخر", occurrence: late };
  if (current?.paid) return { key: "paid", label: "مدفوع هذا الشهر", occurrence: current };
  return { key: "active", label: "نشط", occurrence: current };
}

/* الاستحقاق القادم يبدأ من أول الشهر لا من اليوم، وإلا اختفى التزام موعده أمس (F14). */
function nextCommitmentOccurrence(commitment, today = todayISO()) {
  const bounds = monthBounds(today);
  const fromISO = bounds ? bounds.startISO : today;
  return commitmentOccurrences([commitment], { fromISO, toISO: addDaysISO(today, 730), payments: state.commitmentPayments, includePaused: true })
    .find((item) => !item.paid) ?? null;
}

/* «3 أقساط · 802.300» أوضح من اسم قسط واحد لما تنزل كلها بنفس اليوم (F60). */
function sameDayLabel(list, unit, formatOne) {
  if (!list?.length) return null;
  if (list.length === 1) return formatOne(list[0]);
  const total = list.reduce((sum, item) => sum + (item.amountFils ?? item.installmentFils ?? 0), 0);
  return `${countLabel(list.length, unit)} · ${formatMoney(total)}`;
}

/* F18: تسجيل الدفع كان يحجز المبلغ فقط ولا ينقص الكاش، فالرصيد يبقى أعلى من الحقيقة.
   نسأل مرة ونحفظ الجواب على الدفعة حتى يُعكس عند التراجع. */
async function markCommitmentPaid(commitmentId, dueDate) {
  const commitment = state.monthlyCommitments.find((item) => item.id === commitmentId);
  if (!commitment || !validDate(dueDate)) return;
  const occurrence = commitmentOccurrences([commitment], { fromISO: dueDate, toISO: dueDate, payments: state.commitmentPayments, includePaused: true })[0];
  // آخر دفعة للشهر (لو فيه دفعات جزئية، التراجع يشيل آخر وحدة بس)
  let index = -1;
  state.commitmentPayments.forEach((item, i) => { if (item.commitmentId === commitmentId && sameDueMonth(item.dueDate, dueDate) && item.status !== "reversed") index = i; });
  // التراجع عن آخر دفعة للشهر (من زر «مدفوع» أو من نافذة الدفع لما يكون الدفع جزئي)
  const removeLastPayment = () => {
    let index = -1;
    state.commitmentPayments.forEach((item, i) => { if (item.commitmentId === commitmentId && sameDueMonth(item.dueDate, dueDate) && item.status !== "reversed") index = i; });
    if (index < 0) return;
    const [payment] = state.commitmentPayments.splice(index, 1);
    // نرجّع بالضبط اللي انخصم فعلاً، مو مبلغ الالتزام: لو الرصيد كان أقل انقصّ للصفر وما نخترع الباقي
    const restoredFils = paymentCashDeductedFils(payment);
    state.settings.cashFils += restoredFils;
    // التزام «مرة وحدة» اكتمل بهذي الدفعة: يرجع نشط مع التراجع (ويكتمل من جديد لو تراجعت عن التراجع)
    const reopened = commitment.recurrence === "once" && commitment.status === "completed";
    if (reopened) commitment.status = "active";
    commit(restoredFils > 0 ? `رجّعت الدفع و${formatMoney(restoredFils)} للرصيد` : "تم التراجع عن تسجيل الدفع", { undo: () => {
      state.commitmentPayments.splice(index, 0, payment);
      if (reopened) commitment.status = "completed";
      const again = cashDeduction(state.settings.cashFils, restoredFils);
      state.settings.cashFils = again.cashAfterFils;
      if (restoredFils > 0) { payment.cashDeductedFils = again.deductedFils; payment.cashDeducted = again.deductedFils > 0; }
      commit("رجّعت التسجيل");
    } });
  };
  // مدفوع بالكامل → نفس التراجع القديم. غير مدفوع أو مدفوع جزء → نسأل: كامل ولا جزء؟
  if (index >= 0 && occurrence?.paid) { removeLastPayment(); return; }
  const remainingFils = occurrence ? occurrence.amountFils : commitment.amountFils;
  const choice = await askPayment(commitment, remainingFils, occurrence?.partialPaidFils ?? 0, index >= 0 ? state.commitmentPayments[index].amountFils : 0);
  if (!choice) return;
  if (choice.undo) { removeLastPayment(); return; }
  const payFils = choice.amountFils;
  const partial = payFils < remainingFils;
  const preview = cashDeduction(state.settings.cashFils, payFils);
  const name = cutText(commitment.name, 24);
  const deduct = preview.deductedFils > 0 &&
    await askConfirm(preview.clamped
      ? `رصيدك (${formatMoney(state.settings.cashFils)}) أقل من ${formatMoney(payFils)}. نخصم ${formatMoney(preview.deductedFils)} فقط ويصير رصيدك ${formatMoney(preview.cashAfterFils)} لأنك دفعت ${name}؟`
      : `نخصم ${formatMoney(payFils)} من رصيدك (${formatMoney(state.settings.cashFils)}) لأنك دفعت ${name}؟`, { okLabel: "اخصم من رصيدي" });
  // نعيد الحساب بعد انتظار التأكيد: الرصيد ممكن يتغير (إشعار عملية مثلاً) والمخزّن لازم يكون اللي انخصم فعلاً
  const taken = deduct ? cashDeduction(state.settings.cashFils, payFils) : { deductedFils: 0, cashAfterFils: state.settings.cashFils };
  const payment = { id: createId(), commitmentId, amountFils: payFils, dueDate, paidAt: todayISO(), status: "paid", cashDeducted: taken.deductedFils > 0, cashDeductedFils: taken.deductedFils, ...(partial || occurrence?.partialPaidFils ? { partial: true } : {}) };
  state.commitmentPayments.push(payment);
  state.settings.cashFils = taken.cashAfterFils;
  if (commitment.recurrence === "once" && !partial) commitment.status = "completed";
  const partialNote = partial ? ` (دفعة جزئية، باقي ${formatMoney(remainingFils - payFils)})` : "";
  commit(taken.deductedFils > 0 ? `سجّلت الدفع${partialNote} وخصمت ${formatMoney(taken.deductedFils)} من رصيدك` : (partial ? `سجّلت دفعة جزئية ${formatMoney(payFils)}، والباقي ${formatMoney(remainingFils - payFils)} محجوز` : "تم تسجيل الالتزام كمدفوع"), { undo: () => {
    state.commitmentPayments = state.commitmentPayments.filter((item) => item.id !== payment.id);
    state.settings.cashFils += taken.deductedFils;
    if (commitment.recurrence === "once" && !partial) commitment.status = "active";
    commit("رجّعت التسجيل");
  } });
}

function renderCommitments() {
  const today = todayISO();
  const summary = commitmentSummary(state.monthlyCommitments, state.commitmentPayments, today);
  const income = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const debts = debtSummary(state.loans, { incomeFils: income, todayISO: today, payments: state.debtPayments });
  setText("#commitments-monthly-total", formatMoney(summary?.monthlyEquivalentFils ?? 0));
  setText("#commitments-paid-total", formatMoney(summary?.paidThisMonthFils ?? 0));
  setText("#commitments-remaining-total", formatMoney(summary?.remainingThisMonthFils ?? 0));
  const afterFixedFils = income - debts.monthlyPaymentsFils - (summary?.monthlyEquivalentFils ?? 0);
  setText("#income-after-fixed", formatMoney(afterFixedFils));
  $("#income-after-fixed").classList.toggle("amount-negative", afterFixedFils < 0);
  setText("#income-after-fixed-label", afterFixedFils < 0 ? "عجز شهري بعد الأقساط والالتزامات" : "بعد الأقساط والالتزامات");
  const sameDay = summary?.nextUpcomingSameDay ?? [];
  setText("#next-commitment-name", sameDay.length > 1 ? countLabel(sameDay.length, "commitment") : (summary?.nextUpcoming?.name ?? "لا يوجد"));
  setText("#next-commitment-detail", summary?.nextUpcoming
    ? `${formatDate(summary.nextUpcoming.dueDate)} · ${sameDayLabel(sameDay, "commitment", (item) => formatMoney(item.amountFils))}${sameDay.length > 1 ? ` (${sameDay.map((item) => cutText(item.name, 18)).join("، ")})` : ""}`
    : "ما عندك التزام نشط قادم.");

  const query = searchText($("#commitment-search").value).trim();
  const categoryFilter = $("#commitment-category-filter").value;
  const statusFilter = $("#commitment-status-filter").value;
  const filtered = state.monthlyCommitments.filter((commitment) => {
    const status = commitmentStatusInfo(commitment, today);
    return commitmentMatches(commitment, query) &&
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
        ${commitment.status !== "paused" && markOccurrence ? `<button class="commitment-paid-toggle ${markOccurrence.paid ? "is-paid" : ""}" role="checkbox" aria-checked="${markOccurrence.paid ? "true" : markOccurrence.partialPaidFils ? "mixed" : "false"}" aria-label="${markOccurrence.paid ? "إلغاء تسجيل دفع" : markOccurrence.partialPaidFils ? `دفعت ${escapeHTML(formatMoney(markOccurrence.partialPaidFils))} وباقي ${escapeHTML(formatMoney(markOccurrence.amountFils))}، تسجيل دفعة أو تراجع` : "تسجيل الدفع"}: ${escapeHTML(commitment.name)}" data-toggle-commitment-paid="${escapeHTML(commitment.id)}" data-due-date="${escapeHTML(markOccurrence.dueDate)}"><span aria-hidden="true">${markOccurrence.paid ? "✓" : markOccurrence.partialPaidFils ? "◐" : "○"}</span>${markOccurrence.paid ? "مدفوع" : markOccurrence.partialPaidFils ? `دفعت ${escapeHTML(formatMoney(markOccurrence.partialPaidFils))} · باقي ${escapeHTML(formatMoney(markOccurrence.amountFils))}` : "تم الدفع"}</button>` : ""}
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
  setText("#next-installment", summary.nextPayment
    ? `${sameDayLabel(summary.nextPaymentSameDay, "installment", (item) => formatMoney(item.installmentFils))} · ${formatDate(summary.nextPayment.dueDate)}`
    : (state.loans.length ? "لا يوجد" : "—"));
  setText("#zero-debt-date", state.loans.length ? (summary.activeCount ? (summary.zeroDebtDate ? formatDate(summary.zeroDebtDate) : "بيانات ناقصة") : "بدون ديون 🎉") : "—");
  setText("#debt-income-ratio", summary.dtiPercent === null ? "—" : `${Math.round(summary.dtiPercent).toLocaleString("ar-KW-u-nu-latn")}٪`);
  setText("#dti-caption", dtiDescription(summary.dtiPercent));
  $("#global-extra").value = moneyInput(state.ui.extraFils);
  $("#loan-empty").hidden = state.loans.length > 0;
  $("#loan-list").innerHTML = state.loans.map((loan) => {
    const progress = debtProgress(loan);
    const remaining = remainingInstallments(loan);
    // كان الحساب «اليوم + عدد الأقساط» فيقدّم النهاية شهراً كاملاً عن موعد الخصم (F15)
    // المكتمل والمتوقف ما لهم نهاية تقديرية (كانت تطلع بتاريخ اليوم وتتغير كل يوم) — F15
    const estimable = ["active", "overdue"].includes(loan.status);
    const calculatedEnd = loan.endDate || (estimable && remaining !== null ? debtEndDate(loan, today, remaining) : "");
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
        <div class="detail"><span>إجمالي المدفوع</span><strong>${escapeHTML(formatMoney(Math.max(progress.totalPaidFils, progress.paidFils)))}</strong></div>
        ${progress.totalPaidFils > progress.paidFils ? `<div class="detail"><span>منها أرباح ورسوم مدفوعة</span><strong>${escapeHTML(formatMoney(progress.totalPaidFils - progress.paidFils))}</strong></div>` : ""}
        <div class="detail"><span>القسط القادم</span><strong>${next ? escapeHTML(formatDate(next.dueDate)) : "—"}</strong></div>
        <div class="detail"><span>النهاية ${loan.endDate ? "المسجلة" : "التقديرية"}</span><strong>${calculatedEnd ? escapeHTML(formatDate(calculatedEnd)) : estimable ? "غير واضحة" : "—"}</strong></div>
      </div>${globalSimulation}</details>
      <div class="item-actions"><button data-edit-loan="${escapeHTML(loan.id)}">تعديل</button>${["active", "overdue"].includes(loan.status) && next ? `<button data-pay-installment="${escapeHTML(loan.id)}" data-due-date="${escapeHTML(next.dueDate)}">تم دفع القسط</button>` : ""}${["active", "overdue"].includes(loan.status) ? `<button data-extra-payment="${escapeHTML(loan.id)}">دفعة إضافية</button>` : ""}<button class="delete" data-delete-loan="${escapeHTML(loan.id)}">حذف</button></div>
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
  // السعر هنا مكتوب بيدك: ما يظل موسوم «من البورصة» لو كان جاي من «تحديث الأسعار»
  if (existing) { Object.assign(existing, record); delete existing.priceSource; } else state.stockHoldings.push(record);
  saveState(); renderAll(); closeDialog($("#stock-dialog"));
  toast(existing ? `تم تحديث ${security.name}` : `تمت إضافة ${security.name}`);
}

function openAverageDown(holding, buyPriceTenths = null) {
  if (!holding) return;
  $("#average-down-form").reset();
  $("#average-stock-id").value = holding.id;
  setText("#average-stock-name", getKuwaitStock(holding.securityCode)?.name ?? "");
  const position = calculateStockPosition(holding);
  setText("#average-current-summary", `تملك ${countLabel(holding.quantity, "stock")} · تكلفة السهم مع الرسوم: ${formatSharePrice(position.averageCostPriceTenths)} · آخر سعر مسجل: ${formatSharePrice(holding.currentPriceTenths)}`);
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
      <p class="stock-updated">${holding.priceSource === "market" ? "آخر سعر من البورصة" : "آخر سعر أدخلته"}: ${escapeHTML(formatStockTimestamp(holding.priceUpdatedAt))}</p>
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
    return `<option value="${escapeHTML(holding.id)}">${escapeHTML(security.name)} · ${escapeHTML(security.ticker)} · ${countLabel(holding.quantity, "stock")}</option>`;
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
  setText("#cooling-position", `الكمية الحالية: ${countLabel(holding.quantity, "stock")} · آخر سعر مسجل: ${formatSharePrice(holding.currentPriceTenths)}`);
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

// حدود منطقية حتى ما تطلع أرقام فلكية (مليار دينار بعائد 50٪ لـ 60 سنة) — F42
const INVESTMENT_LIMITS = { initialFils: 10_000_000_000, monthlyFils: 1_000_000_000, minRate: -50, maxRate: 30, maxYears: 50 };
function investmentFromInputs() {
  const initialFils = parseMoney($("#investment-initial").value);
  const monthlyFils = parseMoney($("#investment-monthly").value);
  const annualRate = parseRate($("#investment-rate").value, { min: INVESTMENT_LIMITS.minRate, max: INVESTMENT_LIMITS.maxRate });
  const years = parseCount($("#investment-years").value, { min: 1, max: INVESTMENT_LIMITS.maxYears });
  if (initialFils === null || monthlyFils === null || annualRate === null || years === null) return null;
  if (initialFils > INVESTMENT_LIMITS.initialFils || monthlyFils > INVESTMENT_LIMITS.monthlyFils) return null;
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
    setText("#investment-duration", "—");
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
  setText("#investment-duration", countLabel(values.years, "year"));
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
    else if (goal.monthlyFils > 0) caption = `باقي تقريباً ${countLabel(Math.ceil(remaining / goal.monthlyFils), "month")} بدون عائد`;
    return `<article class="data-card">
      <div class="card-head"><div><h3>${escapeHTML(goal.name)}</h3><span class="eyebrow">${escapeHTML(caption)}</span></div><span class="amount">${Math.round(percent).toLocaleString("ar-KW-u-nu-latn")}٪</span></div>
      <div class="goal-progress"><div class="progress"><span style="width:${percent}%"></span></div><div class="goal-meta"><span>${escapeHTML(formatMoney(goal.savedFils))}</span><span>${escapeHTML(formatMoney(goal.targetFils))}</span></div></div>
      <div class="item-actions"><button data-edit-goal="${escapeHTML(goal.id)}">تعديل</button><button class="delete" data-delete-goal="${escapeHTML(goal.id)}">حذف</button></div>
    </article>`;
  }).join("");
}

/* متوسط المعيشة من عمليات «فئة قسط» مستبعدة، لأن الأقساط تُخصم لحالها.
   كانت الحسبة القديمة تجمع كل المصروف ثم تخصم الثوابت مرة ثانية في بعض الصفحات (F3 · F5). */
function advisorLivingBaseline(today = todayISO()) {
  return livingBaseline(state.transactions, today, { months: 3, budgetFils: state.settings.budgetFils });
}

function renderAdvisor() {
  const today = todayISO();
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const debt = debtSummary(state.loans, { incomeFils, todayISO: today, payments: state.debtPayments });
  const commitmentsFils = state.monthlyCommitments.reduce((sum, item) => sum + monthlyCommitmentEquivalent(item), 0);
  const baseline = advisorLivingBaseline(today);
  const emergencyGoalFils = state.goals.find((item) => /طوارئ|emergency/i.test(item.name ?? ""))?.targetFils ?? 0;
  const plan = createAdvisorAllocation({
    incomeFils, debtInstallmentsFils: debt.monthlyPaymentsFils, commitmentsFils,
    livingCostFils: baseline.amountFils, cashFils: state.settings.cashFils,
    totalDebtFils: debt.totalBalanceFils,
    emergencyGoalFils,
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
  // العجز يظهر بعلامته لا مصفّراً، وإلا بدت الخطة كأنها متوازنة (F4)
  setText("#advisor-surplus", plan.baselineReady ? formatMoney(plan.surplusFils) : "—");
  $("#advisor-surplus").classList.toggle("amount-negative", plan.baselineReady && plan.surplusFils < 0);
  setText("#advisor-surplus-label", plan.surplusFils < 0 ? "العجز بعد الأساسيات" : "المتبقي للأهداف");
  setText("#advisor-reserve-allocation", formatMoney(plan.reserveAllocationFils));
  setText("#advisor-debt-allocation", formatMoney(plan.extraDebtFils));
  setText("#advisor-investment-allocation", formatMoney(plan.investmentFils));
  // المرحلة الأولى احتياطي أولي صغير، والثانية 3 أشهر كاملة — نسمّي الاثنين بالمبلغ (F43)
  setText("#advisor-reserve-caption", `المرحلة 1: ${formatMoney(plan.minimumReserveFils ?? plan.stageOneTargetFils ?? 0)} · المرحلة 2 (3 أشهر): ${formatMoney(plan.emergencyTargetFils)} · رصيدك النقدي: ${formatMoney(state.settings.cashFils)}`);
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
    ? `المعيشة ${formatMoney(baseline.amountFils)} محسوبة من متوسط آخر ${countLabel(baseline.months, "month")} مكتملة فيها مصروفات معتمدة، بدون الأقساط (تُخصم لحالها). عدّل ميزانية الشهر من الإعدادات إذا كان المتوسط لا يمثل احتياجك القادم.`
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
  else if (plan.phase === "overdue") actionMessages.push("سدّد المتأخرات أولاً بعد تغطية الاحتياجات والأقساط الحالية؛ الخطة لا تفترض رسوم التأخير أو شروط جهة التمويل.");
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
      getFixedFils: monthlyFixedFils,
      onApply: applyStarterPlan,
      onSkip: () => { state.ui.onboarded = true; saveState(); closeDialog(dialog); }
    });
  }
  onboardingController.start();
  openDialog(dialog);
}

/* أقساط القروض النشطة + الالتزامات الشهرية — نفس مدخلات monthlySurplus في صفحة الخطة (F27) */
function monthlyFixedFils() {
  const commitmentsFils = state.monthlyCommitments.reduce((sum, item) => sum + monthlyCommitmentEquivalent(item), 0);
  return commitmentsFils + debtSummary(state.loans, { todayISO: todayISO(), payments: state.debtPayments }).monthlyPaymentsFils;
}

async function applyStarterPlan(plan) {
  // الخطة تكتب فوق أرقام قد تكون مضبوطة من قبل، فنعرض «قبل ← بعد» ونطلب الموافقة (F27)
  const before = state.settings;
  const emergencyGoal = state.goals.find((item) => item.name === "صندوق الطوارئ");
  const rows = [
    ["الدخل الشهري", before.incomeFils, plan.incomeFils],
    ["ميزانية المصروف", before.budgetFils, plan.budgetFils],
    ["رصيد الكاش", before.cashFils, plan.savingsFils],
    ["احتياطي الأمان", before.safetyBufferFils, plan.safetyBufferFils],
    ["هدف صندوق الطوارئ", emergencyGoal?.targetFils ?? 0, plan.emergencyTargetFils],
    ["إضافة الطوارئ الشهرية", emergencyGoal?.monthlyFils ?? 0, plan.monthlySaveFils]
  ].filter(([, from, to]) => from !== to);
  const fixedFils = plan.fixedFils ?? monthlyFixedFils();
  const warning = fixedFils > 0
    ? `\nالخطة محسوبة بعد أقساطك والتزاماتك المسجلة (${formatMoney(fixedFils)} شهرياً).`
    : "";
  // أول تشغيل (كل القيم صفر) ما فيه شي ينكتب فوقه، فما نسأل
  if (rows.some(([, from]) => from > 0) && !(await askConfirm(`نطبّق الخطة المبدئية؟\n${rows.map(([label, from, to]) => `${label}: ${formatMoney(from)} ← ${formatMoney(to)}`).join("\n")}${warning}`, { okLabel: "طبّق الخطة" }))) return;
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
  closeDialog($("#onboarding-dialog"));
  switchView("dashboard");
  commit(keptIncomes ? "طبّقت الخطة. عندك أكثر من دخل مسجل فما غيّرتها، راجعها من الإعدادات." : "تم ترتيب كل شي حسب معاشك ✅", { investmentInputs: true });
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
    debtPaymentsFils: base.debtPaymentsFils, livingFils: base.livingFils, todayISO: todayISO(), salaryDay: state.settings.salaryDay };
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
        const before = state.goals;
        state.goals = result.goals;
        commit(`أضفت ${formatMoney(result.addedFils)} لـ ${countLabel(result.count, "goal")}`, { undo: () => { state.goals = before; commit("رجّعت التحويل"); } });
      },
      onApplySuggestion: async ({ allocation, changes }) => {
        if (!changes.length) { toast("المقترح نفس إضافاتك الحالية"); return; }
        const lines = changes.map((change) => `${change.name}: ${formatMoney(change.fromFils)} ← ${formatMoney(change.toFils)}`).join("\n");
        if (!(await askConfirm(`نغيّر الإضافة الشهرية لهذه الأهداف (الطوارئ أولاً)؟\n${lines}`, { okLabel: "طبّق" }))) return;
        const before = state.goals.map((goal) => ({ id: goal.id, monthlyFils: goal.monthlyFils }));
        state.goals.forEach((goal) => { if (allocation[goal.id] !== undefined) goal.monthlyFils = allocation[goal.id]; });
        commit("تم تحديث إضافات الأهداف", { undo: () => {
          before.forEach((row) => { const goal = state.goals.find((item) => item.id === row.id); if (goal) goal.monthlyFils = row.monthlyFils; });
          commit("رجّعت الإضافات");
        } });
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
  // المتوسط نفسه بلا خصم ثانٍ للثوابت: فئة «قسط» مستبعدة أصلاً من متوسط المعيشة (F5)
  const livingFils = baseline.amountFils;
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
let assistantController = null;
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

/* «المحاسب الذكي»: خارج renderAll عمداً حتى لا تضيع المحادثة ومعاينات «تنفيذ» مع كل commit. يتحدث من أحداثه فقط. للويب فقط. */
function renderAssistant() {
  if (IS_NATIVE) return;
  const root = $("#assistant-root");
  if (!root) return;
  assistantController ??= mountAssistant(root, {
    getState: () => state, commit: (message) => commit(message), refresh: () => renderAll(), isLocked: () => lockedNow, todayISO, toast
  });
  assistantController.activate();
}

// بعد فتح القفل أو مسح البيانات: لو شاشة المحاسب هي المفتوحة نعيد تفعيلها (تتحقق من الخدمة والموافقة والربط من جديد)
function refreshAssistantView() {
  if (!IS_NATIVE && $("#assistant-view")?.classList.contains("active")) renderAssistant();
}

function renderAll({ investmentInputs = false } = {}) {
  // مستخدم جديد بدون دخل ولا عمليات: بدل الأصفار نعطيه خطوة واضحة
  const homeStart = $("#home-start");
  if (homeStart) homeStart.hidden = !(state.settings.incomeFils === 0 && state.transactions.length === 0);
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

/* F33: الخانة الغلط تتعلّم (حد أحمر + aria-invalid) وتشير لرسالة الخطأ، وتنمسح العلامة أول ما يعدّلها */
function invalidField(selector, errorSelector, focusOptions = {}) {
  const input = $(selector);
  if (!input) return;
  input.setAttribute("aria-invalid", "true");
  if (errorSelector) input.setAttribute("aria-describedby", errorSelector.slice(1));
  input.focus(focusOptions);
}
function clearInvalid(root) {
  root?.querySelectorAll?.('[aria-invalid="true"]').forEach((input) => input.removeAttribute("aria-invalid"));
}

function openDialog(dialog) {
  clearInvalid(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

let pendingTransactionSource = "manual";
let pendingTransactionTime = "";
let pendingTransactionTimeDate = "";
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
    // «قد تكون مكررة» ما تنضاف ولا تنحسب إلا إذا علّم عليها المستخدم (v35)؛ ونحفظ عدّاد البصمات وقت المعاينة للحارس الأخير
    parsed.pickedPossible = new Set();
    parsed.fingerprintsAtParse = fingerprintCounts(state.transactions);
    pendingStatementBatch = parsed;
    renderStatementPossible(parsed);
    renderStatementPreview(parsed);
    $("#statement-import-preview").hidden = false;
  } catch (error) {
    if (!controller.signal.aborted) $("#statement-import-error").textContent = error instanceof Error ? error.message : "تعذر قراءة الملف.";
  } finally {
    if (statementImportController === controller) $("#statement-import-progress").hidden = true;
  }
}

/* الصفوف اللي بتنضاف فعلاً: المؤكدة + اللي علّم عليها المستخدم من «قد تكون مكررة». */
function statementCounted(batch) {
  return batch.transactions.filter((item, position) => !item.possibleDuplicate || batch.pickedPossible?.has(position));
}

function fingerprintCounts(list) {
  const counts = new Map();
  for (const item of list) {
    const fingerprint = item.fingerprint || transactionFingerprint({ amountFils: item.amountFils, merchant: item.rawMerchant || item.merchant, date: item.date });
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function renderStatementPossible(batch) {
  const possible = batch.transactions.map((item, position) => ({ item, position })).filter(({ item }) => item.possibleDuplicate);
  $("#statement-possible").hidden = possible.length === 0;
  $("#statement-possible-list").innerHTML = possible.map(({ item, position }) => `
    <label class="statement-possible-item"><input type="checkbox" data-possible-index="${position}" ${batch.pickedPossible.has(position) ? "checked" : ""}>
      <span>${escapeHTML(item.merchant)}<small>${escapeHTML(item.category)} · ${escapeHTML(formatDate(item.date))}</small></span><strong>−${escapeHTML(formatMoney(item.amountFils))}</strong></label>`).join("");
}

function renderStatementPreview(batch) {
  const { stats } = batch;
  const counted = statementCounted(batch);
  const totalFils = counted.reduce((sum, item) => sum + item.amountFils, 0);
  const possibleTotal = stats.possibleDuplicates ?? 0;
  setText("#statement-preview-period", counted.length ? `${formatDate(counted[0].date)} — ${formatDate(counted.at(-1).date)}` : possibleTotal ? "ما في مصروفات مؤكدة جديدة" : "كل المصروفات الموجودة مضافة من قبل");
  setText("#statement-preview-count", countLabel(counted.length, "transaction"));
  setText("#statement-preview-total", formatMoney(totalFils));
  setText("#statement-match-summary", `طابقت ${stats.duplicates.toLocaleString("ar-KW-u-nu-latn")} من عملياتك المحفوظة، وناقص ${counted.length.toLocaleString("ar-KW-u-nu-latn")} بنضيفها${possibleTotal ? ` (و${possibleTotal.toLocaleString("ar-KW-u-nu-latn")} قد تكون مكررة، ما تنضاف إلا إذا علّمت عليها)` : ""}.`);
  setText("#statement-preview-duplicates", stats.duplicates.toLocaleString("ar-KW-u-nu-latn"));
  setText("#statement-preview-excluded", `${(stats.credits + stats.transfers).toLocaleString("ar-KW-u-nu-latn")}${stats.transfersFils ? ` · منها مصروفات مستبعدة ${formatMoney(stats.transfersFils)}` : ""}`);
  setText("#statement-preview-skipped", (stats.invalidRows + stats.outOfRange).toLocaleString("ar-KW-u-nu-latn"));
  const picked = batch.pickedPossible?.size ?? 0;
  setText("#statement-preview-possible", `${possibleTotal.toLocaleString("ar-KW-u-nu-latn")}${picked ? ` · معلّمة ${picked.toLocaleString("ar-KW-u-nu-latn")}` : ""}`);
  setText("#statement-possible-hint", `ما انضافت ولا انحسبت. علّم على اللي تبيه فعلاً (مجموعها ${formatMoney(stats.possibleFils ?? 0)}).`);
  setText("#statement-possible-all", picked && picked === possibleTotal ? "إلغاء التحديد" : "تحديد الكل");
  const repeated = stats.repeatedInFile ? ` ${countLabel(stats.repeatedInFile, "transaction")} متكررة داخل الملف نفسه (نفس اليوم والمبلغ والوصف) اعتبرناها مشتريات حقيقية.` : "";
  setText("#statement-preview-note", (stats.hasBalanceColumn
    ? "الملف فيه عمود الرصيد، فالمقارنة بالرصيد بعد العملية تفرّق بين شراءين متشابهين في نفس اليوم."
    : "ما فيه عمود رصيد في الملف، فنقارن بالعدد: لو الملف فيه صفين متطابقين وعندك واحد مثلهم نضيف الثاني فقط، وما نشيل أي شراء حقيقي.") + repeated);
  $("#statement-preview-list").innerHTML = counted.slice(-12).reverse().map((item) => `
    <div class="statement-preview-item"><span>${escapeHTML(item.merchant)}<small>${escapeHTML(item.category)} · ${escapeHTML(formatDate(item.date))}</small></span><strong>−${escapeHTML(formatMoney(item.amountFils))}</strong></div>`).join("");
  $("#statement-import-confirm").disabled = counted.length === 0;
}

function toggleStatementPossible(position, checked) {
  const batch = pendingStatementBatch;
  if (!batch?.transactions[position]?.possibleDuplicate) return;
  if (checked) batch.pickedPossible.add(position); else batch.pickedPossible.delete(position);
  renderStatementPreview(batch);
}

function submitStatementImport(event) {
  event.preventDefault();
  const batch = pendingStatementBatch;
  if (!batch) return;
  // الحارس الأخير: نحذف فقط الصفوف اللي ظهر لها مثيل جديد بعد المعاينة (إشعار عملية مثلاً). المقارنة بالعدد، مو بالوجود،
  // لأن الصف الثالث من 3 متطابقة وعندك اثنتان هو شراء حقيقي له نفس بصمة الاثنتين.
  const appeared = new Map();
  for (const [fingerprint, count] of fingerprintCounts(state.transactions)) {
    const extra = count - (batch.fingerprintsAtParse?.get(fingerprint) ?? 0);
    if (extra > 0) appeared.set(fingerprint, extra);
  }
  const picked = statementCounted(batch).filter((item) => item.possibleDuplicate).length;
  const transactions = statementCounted(batch).filter((item) => {
    const left = appeared.get(item.fingerprint) ?? 0;
    if (left > 0) { appeared.set(item.fingerprint, left - 1); return false; }
    return true;
  }).map((item) => item.possibleDuplicate ? { ...item, possibleDuplicate: false } : item);
  if (!transactions.length) {
    $("#statement-import-error").textContent = "كل العمليات الجديدة صارت موجودة من قبل؛ ما كررناها.";
    return;
  }
  if (transactions.length + state.transactions.length > 20_000) {
    $("#statement-import-error").textContent = "عدد العمليات يتجاوز سعة السجل الحالي. صدّر نسخة وقلّل السجلات قبل الاستيراد.";
    return;
  }
  const matchedCount = pendingStatementBatch.stats.duplicates ?? 0;
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
  /* نفتح التحليل بعد الحفظ حتى يرى المستخدم أثر الاستيراد فوراً */
  switchView("dashboard");
  $("#behavior-panel").closest("details").open = true;
  requestAnimationFrame(() => $("#behavior-panel").scrollIntoView({ behavior: "smooth", block: "start" }));
  const matched = matchedCount.toLocaleString("ar-KW-u-nu-latn");
  commit(`طابقت ${matched} من عملياتك المحفوظة وأضفت ${transactions.length.toLocaleString("ar-KW-u-nu-latn")} ناقصة${picked ? ` · منها ${countLabel(picked, "transaction")} كانت «قد تكون مكررة» وعلّمت عليها بنفسك` : ""}`, { render: false });
}

const INCOME_CATEGORIES = ["راتب", "أخرى"];
function renderTransactionCategories(kind, selected = "") {
  // التصنيفات المخصصة للمصروف ما تنفع للدخل («مطاعم» ليست مصدر دخل) — F52
  const list = kind === "income" ? INCOME_CATEGORIES : categories.filter((category) => category !== "راتب");
  $("#transaction-category").innerHTML = list.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("");
  $("#transaction-category").value = list.includes(selected) ? selected : (kind === "income" ? "راتب" : "أخرى");
}

let pendingDraftId = "";
let categoryTouched = false;
function openTransaction(item = null, imported = null, draft = null) {
  const form = $("#transaction-form");
  form.reset();
  $("#transaction-error").textContent = "";
  $("#transaction-dialog-title").textContent = item ? "تعديل العملية" : draft ? "أدخل المبلغ بالدينار" : imported ? "راجع العملية" : "عملية جديدة";
  $("#transaction-id").value = item?.id ?? "";
  const kind = item?.kind ?? imported?.kind ?? "expense";
  $("#transaction-kind").value = kind;
  $("#transaction-amount").value = item ? moneyInput(item.amountFils) : imported ? moneyInput(imported.amountFils) : "";
  $("#transaction-merchant").value = item?.merchant ?? imported?.merchant ?? draft?.merchant ?? "";
  renderTransactionCategories(kind, item?.category ?? imported?.category ?? (draft?.merchant ? inferCategory(draft.merchant) : ""));
  $("#transaction-date").value = item?.date ?? draft?.dateISO ?? todayISO();
  $("#transaction-date").max = todayISO();
  $("#transaction-reviewed").checked = item ? true : !imported;
  pendingTransactionSource = item?.source ?? (imported ? "bank-text" : "manual");
  // الوقت يرافق تاريخه: لو غيّرت التاريخ بالنافذة ينشال الوقت
  pendingTransactionTime = item?.time ?? draft?.time ?? imported?.timeHM ?? "";
  pendingTransactionTimeDate = item?.date ?? draft?.dateISO ?? imported?.dateISO ?? "";
  renderTransactionTimeNote();
  pendingDraftId = draft?.id ?? "";
  categoryTouched = Boolean(item || imported);
  updateMoneyPreviews(form);
  openDialog($("#transaction-dialog"));
}

function renderTransactionTimeNote() {
  const note = $("#transaction-time-note");
  if (!note) return;
  const show = validTime(pendingTransactionTime) && $("#transaction-date").value === pendingTransactionTimeDate;
  note.hidden = !show;
  note.textContent = show ? `وقت العملية ${formatTime(pendingTransactionTime)}` : "";
}

async function submitTransaction(event) {
  event.preventDefault();
  const amountFils = parseMoney($("#transaction-amount").value);
  const merchant = $("#transaction-merchant").value.trim();
  const date = $("#transaction-date").value;
  const today = todayISO();
  // رسالة لكل حقل بدل جملة واحدة عامة (F33)
  if (amountFils === null) { $("#transaction-error").textContent = "المبلغ بالدينار وبثلاث خانات بعد الفاصلة كحد أقصى، مثل 12.500."; invalidField("#transaction-amount", "#transaction-error"); return; }
  if (!amountFils) { $("#transaction-error").textContent = "المبلغ لازم يكون أكبر من صفر."; invalidField("#transaction-amount", "#transaction-error"); return; }
  if (!merchant) { $("#transaction-error").textContent = "اكتب اسم التاجر أو مصدر الدخل."; invalidField("#transaction-merchant", "#transaction-error"); return; }
  if (!validDate(date)) { $("#transaction-error").textContent = "اختر تاريخاً صالحاً."; invalidField("#transaction-date", "#transaction-error"); return; }
  if (date > today) { $("#transaction-error").textContent = "ما نسجل عملية بتاريخ المستقبل."; invalidField("#transaction-date", "#transaction-error"); return; }
  if (date < "2000-01-01") { $("#transaction-error").textContent = "التاريخ قديم جداً؛ راجع السنة."; invalidField("#transaction-date", "#transaction-error"); return; }
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  // مبلغ أكبر من عشرة أضعاف الدخل غالباً خطأ في الفاصلة (12500 بدل 12.500) — F42
  if (incomeFils > 0 && amountFils > incomeFils * 10 &&
      !(await askConfirm(`${formatMoney(amountFils)} أكبر من دخلك الشهري بعشر مرات. متأكد أن الفاصلة في مكانها؟`, { okLabel: "نعم، المبلغ صحيح" }))) {
    $("#transaction-amount").focus();
    return;
  }
  const id = $("#transaction-id").value;
  const existing = state.transactions.find((item) => item.id === id);
  const record = {
    id: existing?.id ?? createId(), amountFils, merchant: merchant.slice(0, 80),
    category: categories.includes($("#transaction-category").value) ? $("#transaction-category").value : "أخرى",
    kind: $("#transaction-kind").value === "income" ? "income" : "expense", date,
    time: validTime(pendingTransactionTime) && date === pendingTransactionTimeDate ? pendingTransactionTime : "",
    reviewed: $("#transaction-reviewed").checked, source: pendingTransactionSource,
    rawMerchant: existing?.rawMerchant ?? (["bank-text", "bank-statement"].includes(pendingTransactionSource) ? merchant.slice(0, 80) : ""),
    fingerprint: existing?.fingerprint ?? "",
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };
  if (["bank-text", "bank-statement"].includes(record.source)) {
    record.fingerprint = transactionFingerprint({ amountFils: record.amountFils, merchant: record.rawMerchant || record.merchant, date: record.date });
  }
  // الفحص للسجل الجديد فقط: تعديل سجل موجود ما يصير «مكرراً لنفسه» (F29)
  if (!existing && ["bank-text", "bank-statement"].includes(record.source) && state.transactions.some((item) =>
    item.id !== existing?.id && (item.fingerprint === record.fingerprint ||
    (item.amountFils === record.amountFils && item.date === record.date &&
    merchantKey(item.rawMerchant || item.merchant) === merchantKey(record.rawMerchant || record.merchant))))) {
    $("#transaction-error").textContent = "في عملية مستوردة مطابقة بنفس اليوم. راجع القائمة قبل إضافتها مرة ثانية.";
    return;
  }
  if (record.reviewed) {
    const affected = wouldRenameOthers(record);
    if (affected >= 2 && !(await askConfirm(`عندك ${countLabel(affected, "transaction")} غيرها بنفس الاسم اللي وصل بالإشعار أو الكشف. نخلي «${cutText(record.merchant, 30)}» هو الاسم المتعلَّم لكل عملية قادمة بهذا الاسم؟`, { okLabel: "نعم، تعلّمه" }))) {
      // ما نتعلم القاعدة، لكن نحفظ تعديل هذه العملية
    } else {
      learnMerchant(record);
    }
  }
  if (existing && record.reviewed) existing.possibleDuplicate = false;
  if (existing) Object.assign(existing, record); else state.transactions.push(record);
  if (pendingDraftId) { state.bankDrafts = state.bankDrafts.filter((item) => item.id !== pendingDraftId); pendingDraftId = ""; }
  closeDialog($("#transaction-dialog"));
  commit(existing ? "تم تعديل العملية" : "تمت إضافة العملية");
}

/* F7: معاينة مباشرة «= 12.500 د.ك» تحت كل خانة دينار، حتى يبيّن خطأ الفاصلة قبل الحفظ. */
function moneyPreviewFor(input) {
  const unit = input.closest(".money-field")?.querySelector("b")?.textContent?.trim();
  if (unit !== "د.ك") return null;
  const raw = input.value.trim();
  if (!raw) return { text: "", bad: false };
  const fils = parseMoney(raw);
  if (fils === null) return { text: "ما فهمت المبلغ — اكتبه مثل 12.500", bad: true };
  return { text: `= ${formatMoney(fils)}`, bad: false };
}
function updateMoneyPreview(input) {
  const info = moneyPreviewFor(input);
  if (!info) return;
  const field = input.closest(".money-field");
  let preview = field.nextElementSibling;
  if (!preview?.classList?.contains("money-preview")) {
    preview = document.createElement("small");
    preview.className = "money-preview";
    field.after(preview);
  }
  preview.textContent = info.text;
  preview.classList.toggle("is-bad", info.bad);
  preview.hidden = !info.text;
}
function updateMoneyPreviews(root) {
  $$(".money-field input", root).forEach(updateMoneyPreview);
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
  $("#commitment-status").value = ["paused", "completed"].includes(commitment?.status) ? commitment.status : "active";
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
  if (!name) { $("#commitment-error").textContent = "اكتب اسم الالتزام."; invalidField("#commitment-name", "#commitment-error"); return; }
  if (!category) { $("#commitment-error").textContent = "اختر تصنيفاً أو اكتب تصنيفاً مخصصاً."; return; }
  if (amountFils === null) { $("#commitment-error").textContent = "المبلغ بالدينار مثل 250.000."; invalidField("#commitment-amount", "#commitment-error"); return; }
  if (!amountFils) { $("#commitment-error").textContent = "المبلغ لازم يكون أكبر من صفر."; invalidField("#commitment-amount", "#commitment-error"); return; }
  if (!validDate(dueDate)) { $("#commitment-error").textContent = "اختر تاريخ استحقاق صالحاً."; invalidField("#commitment-due-date", "#commitment-error"); return; }
  // حدود منطقية: 1900 أو 9999 غالباً خطأ بالسنة (F42)
  if (dueDate < "2000-01-01" || dueDate > addDaysISO(todayISO(), 3653)) { $("#commitment-error").textContent = "راجع السنة: التاريخ لازم يكون بين 2000 وعشر سنين من اليوم."; invalidField("#commitment-due-date", "#commitment-error"); return; }
  if (categoryValue === "__custom" && !state.customCommitmentCategories.includes(category)) state.customCommitmentCategories.push(category.slice(0, 60));
  const id = $("#commitment-id").value;
  const existing = state.monthlyCommitments.find((item) => item.id === id);
  const record = {
    id: existing?.id ?? createId(), name: name.slice(0, 80), category: category.slice(0, 60), amountFils, dueDate,
    recurrence: Object.hasOwn(commitmentRecurrences, $("#commitment-recurrence").value) ? $("#commitment-recurrence").value : "monthly",
    paymentMethod: ["bank", "credit_card", "cash", "other"].includes($("#commitment-payment-method").value) ? $("#commitment-payment-method").value : "other",
    notes: $("#commitment-notes").value.trim().slice(0, 500),
    status: ["paused", "completed"].includes($("#commitment-status").value) ? $("#commitment-status").value : "active",
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };
  if (existing) Object.assign(existing, record); else state.monthlyCommitments.push(record);
  updateCommitmentCategoryFilterOptions();
  closeDialog($("#commitment-dialog"));
  commit(existing ? "تم تعديل الالتزام" : "تمت إضافة الالتزام");
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
  $("#loan-rate").value = loan ? (loan.interestRateKnown ? loan.annualRate : "") : "";
  $("#loan-day").value = loan?.dueDay ?? 1;
  $("#loan-remaining-installments").value = loan?.remainingInstallments ?? "";
  $("#loan-start-date").value = loan?.startDate ?? "";
  $("#loan-end-date").value = loan?.endDate ?? "";
  $("#loan-start-date").max = todayISO();
  updateMoneyPreviews($("#loan-form"));
  openDialog($("#loan-dialog"));
}

async function submitLoan(event) {
  event.preventDefault();
  const name = $("#loan-name").value.trim();
  const originalAmountFils = parseMoney($("#loan-original").value);
  const balanceFils = parseMoney($("#loan-balance").value);
  const installmentFils = parseMoney($("#loan-installment").value);
  const totalPaidInput = parseMoney($("#loan-paid").value);
  const rateRaw = $("#loan-rate").value.trim();
  const annualRate = rateRaw === "" ? 0 : parseRate(rateRaw, { min: 0, max: 100 });
  const dueDay = parseCount($("#loan-day").value, { min: 1, max: 31 });
  const remainingRaw = $("#loan-remaining-installments").value.trim();
  const remainingInstallmentCount = remainingRaw === "" ? null : parseCount(remainingRaw, { min: 0, max: 1200 });
  const startDate = $("#loan-start-date").value;
  const endDate = $("#loan-end-date").value;
  const status = $("#loan-status").value;
  const error = $("#loan-error");
  if (!name) { error.textContent = "اكتب اسم القرض."; invalidField("#loan-name", "#loan-error"); return; }
  if (!originalAmountFils) { error.textContent = "المبلغ الأصلي بالدينار وأكبر من صفر."; invalidField("#loan-original", "#loan-error"); return; }
  if (balanceFils === null) { error.textContent = "الرصيد المتبقي بالدينار مثل 1500.000."; invalidField("#loan-balance", "#loan-error"); return; }
  // المرابحة يزيد مستحقها عن أصل المبلغ، فهذا وضع طبيعي ما يُرفض — نكتفي بالتنبيه (F45)
  if (!installmentFils && balanceFils > 0) { error.textContent = "القسط الشهري بالدينار وأكبر من صفر."; invalidField("#loan-installment", "#loan-error"); return; }
  if (totalPaidInput === null) { error.textContent = "إجمالي المدفوع بالدينار، أو 0.000."; invalidField("#loan-paid", "#loan-error"); return; }
  if (annualRate === null) { error.textContent = "النسبة السنوية رقم من 0 إلى 100، مثل 4.25."; invalidField("#loan-rate", "#loan-error"); return; }
  if (dueDay === null) { error.textContent = "يوم الخصم من 1 إلى 31."; invalidField("#loan-day", "#loan-error"); return; }
  if (remainingRaw !== "" && remainingInstallmentCount === null) { error.textContent = "الأقساط المتبقية عدد صحيح من 0 إلى 1200، أو اتركها فارغة."; invalidField("#loan-remaining-installments", "#loan-error"); return; }
  if (startDate && !validDate(startDate)) { error.textContent = "تاريخ البداية غير صالح."; invalidField("#loan-start-date", "#loan-error"); return; }
  if (endDate && !validDate(endDate)) { error.textContent = "تاريخ النهاية غير صالح."; invalidField("#loan-end-date", "#loan-error"); return; }
  if (startDate && endDate && endDate < startDate) { error.textContent = "تاريخ النهاية قبل تاريخ البداية."; invalidField("#loan-end-date", "#loan-error"); return; }
  if (status === "completed" && balanceFils !== 0) { error.textContent = "القرض المكتمل رصيده صفر."; invalidField("#loan-balance", "#loan-error"); return; }
  error.textContent = "";
  // قسط أكبر من الرصيد كله غالباً خطأ كتابة (9000 بدل 90.000) — تأكيد ناعم بدل الحفظ بصمت (F42)
  if (balanceFils > 0 && installmentFils > balanceFils &&
      !(await askConfirm(`القسط الشهري (${formatMoney(installmentFils)}) أكبر من الرصيد المتبقي كله (${formatMoney(balanceFils)}). متأكد من الرقمين؟`, { okLabel: "نعم، صحيح" }))) {
    invalidField("#loan-installment", "#loan-error");
    return;
  }
  const id = $("#loan-id").value;
  const existing = state.loans.find((item) => item.id === id);
  const record = {
    id: existing?.id ?? createId(), name: name.slice(0, 60), lender: $("#loan-lender").value.trim().slice(0, 60),
    type: debtTypes.includes($("#loan-type").value) ? $("#loan-type").value : "أخرى",
    originalAmountFils, originalAmountKnown: true, balanceFils, installmentFils, annualRate, interestRateKnown: rateRaw !== "", dueDay, startDate, endDate,
    remainingInstallments: remainingInstallmentCount,
    totalPaidFils: Math.max(totalPaidInput, Math.max(originalAmountFils - balanceFils, 0)),
    // رصيد صفر يعني القرض انتهى، فما يبقى «نشطاً» بقسط شهري (F49)
    status: balanceFils === 0 ? "completed" : (["active", "overdue", "stopped"].includes(status) ? status : "active")
  };
  if (existing) Object.assign(existing, record); else state.loans.push(record);
  closeDialog($("#loan-dialog"));
  const murabaha = balanceFils > originalAmountFils;
  commit(existing ? "تم تعديل القرض" : "تمت إضافة القرض");
  if (murabaha) toast("الرصيد أكبر من أصل المبلغ — طبيعي في المرابحة، لأن المستحق يشمل الربح.");
}

/* F17: ما كان فيه أي طريقة تسجّل خصم القسط، فالرصيد يبقى قديماً والأقساط المتبقية ما تنقص. */
async function payLoanInstallment(loanId, dueDate) {
  let loan = state.loans.find((item) => item.id === loanId);
  if (!loan || !validDate(dueDate)) return;
  const alreadyPaid = () => state.debtPayments.some((item) => item.debtId === loanId && sameDueMonth(item.dueDate, dueDate) && item.status !== "reversed");
  if (alreadyPaid()) {
    toast("القسط مسجّل مدفوعاً من قبل");
    return;
  }
  // لمسة ثانية بعد تسجيل قسط هذا الشهر كانت تسجّل قسط الشهر الجاي بصمت: نسأل، والافتراضي ما نسجّل (F17)
  const recent = recentInstallmentPayment(state.debtPayments, loanId, todayISO(), dueDate);
  if (recent) {
    const confirmed = await askConfirm(`قسط ${formatDate(recent.dueDate)} مسجّل مدفوع من قبل. تسجّل قسط ${formatDate(dueDate)} كمان؟ إذا لمستها مرتين بالغلط اضغط إلغاء.`, { okLabel: "سجّل القسط التالي" });
    if (!confirmed) return;
    loan = state.loans.find((item) => item.id === loanId);
    if (!loan || alreadyPaid()) return;
  }
  const applied = Math.min(loan.installmentFils, loan.balanceFils);
  const payment = { id: createId(), debtId: loanId, amountFils: loan.installmentFils, dueDate, paidAt: todayISO(), status: "paid" };
  const before = { balanceFils: loan.balanceFils, totalPaidFils: loan.totalPaidFils, remainingInstallments: loan.remainingInstallments, status: loan.status };
  state.debtPayments.push(payment);
  loan.balanceFils = Math.max(loan.balanceFils - applied, 0);
  loan.totalPaidFils = (loan.totalPaidFils ?? 0) + applied;
  if (Number.isInteger(loan.remainingInstallments)) loan.remainingInstallments = Math.max(loan.remainingInstallments - 1, 0);
  if (loan.balanceFils === 0) loan.status = "completed";
  commit(`سجّلت قسط ${cutText(loan.name, 24)} · ${formatMoney(applied)}`, { undo: () => {
    state.debtPayments = state.debtPayments.filter((item) => item.id !== payment.id);
    Object.assign(loan, before);
    commit("رجّعت القسط");
  } });
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
    ${simulation.unusedFils > 0 ? `<div><span>المطبّق من دفعتك</span><strong>${escapeHTML(formatMoney(simulation.appliedFils))} <small>(${escapeHTML(formatMoney(simulation.unusedFils))} أكثر من الرصيد)</small></strong></div>` : `<div><span>المطبّق من دفعتك</span><strong>${escapeHTML(formatMoney(simulation.appliedFils))}</strong></div>`}
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
  // الدفعة الإضافية ما تأخّر النهاية: ما نزيد الأقساط المتبقية ولا نكتب تاريخاً أبعد من المسجل (F15)
  loan.remainingInstallments = Number.isInteger(loan.remainingInstallments)
    ? Math.min(loan.remainingInstallments, simulation.expectedMonths) : simulation.expectedMonths;
  if (loan.balanceFils === 0) loan.endDate = todayISO();
  else if (!loan.endDate || (simulation.expectedEndDate && simulation.expectedEndDate < loan.endDate)) loan.endDate = simulation.expectedEndDate;
  if (loan.balanceFils === 0) loan.status = "completed";
  closeDialog($("#extra-payment-dialog"));
  commit(simulation.unusedFils > 0
    ? `سجّلت ${formatMoney(simulation.appliedFils)} — الباقي ${formatMoney(simulation.unusedFils)} أكثر من الرصيد`
    : "تم تسجيل الدفعة الإضافية");
}

let scannedLoanCandidates = [];
let discardingLoanScan = false;
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
  // نافذة المراجعة في الطبقة العلوية، فعنصر عادي يختفي تحتها: الصورة لازم تكون dialog كذلك (F22)
  openDialog($("#image-lightbox"));
}

function closeImageLightbox() {
  const lightbox = $("#image-lightbox");
  if (!lightbox) return;
  if (lightbox.open) closeDialog(lightbox);
  $("#lightbox-image").removeAttribute("src");
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
  const amountTag = (warning, value, missing) => warning ? `<small class="field-confidence">${warning}</small>` : value ? '<small class="field-confidence clear">مقروء</small>' : `<small class="field-confidence">${missing}</small>`;
  $("#loan-scan-results").innerHTML = scannedLoanCandidates.map((loan, index) => {
    const warn = scanAmountWarnings(loan);
    const confidence = loan.confidence === "high" && Object.keys(warn).length ? "medium" : loan.confidence;
    return `
    <article class="scan-card" data-scan-index="${index}">
      <div class="scan-card-head"><strong>القرض ${index + 1}</strong><span class="confidence ${confidence}">${confidence === "high" ? "قراءة واضحة" : confidence === "medium" ? "راجع البيانات" : "أكمل البيانات"}</span></div>
      <div class="form-grid">
        <label class="field ${loan.name ? "" : "needs-review"}"><span>اسم القرض ${loan.name ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><input data-scan-field="name" maxlength="60" value="${escapeHTML(loan.name ?? "")}" placeholder="غير واضح — يرجى التأكيد"></label>
        <label class="field ${loan.lender ? "" : "needs-review"}"><span>الجهة المقرضة ${loan.lender ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><input data-scan-field="lender" maxlength="60" value="${escapeHTML(loan.lender ?? "")}" placeholder="غير واضح — يرجى التأكيد"></label>
        <label class="field"><span>نوع القرض</span><select data-scan-field="type">${debtTypes.map((type) => `<option value="${escapeHTML(type)}" ${type === (loan.type ?? "أخرى") ? "selected" : ""}>${escapeHTML(type)}</option>`).join("")}</select></label>
        <label class="field ${loan.originalAmountFils && !warn.original ? "" : "needs-review"}"><span>المبلغ الأصلي ${amountTag(warn.original, loan.originalAmountFils, "غير واضح — اختياري")}</span><div class="money-field"><input data-scan-field="original" inputmode="decimal" value="${loan.originalAmountFils ? moneyInput(loan.originalAmountFils) : ""}" placeholder="غير واضح"><b>د.ك</b></div></label>
      </div>
      <div class="form-grid">
        <label class="field ${loan.balanceFils && !warn.balance ? "" : "needs-review"}"><span>الرصيد المتبقي ${amountTag(warn.balance, loan.balanceFils, "غير واضح — يرجى التأكيد")}</span><div class="money-field"><input data-scan-field="balance" inputmode="decimal" value="${loan.balanceFils ? moneyInput(loan.balanceFils) : ""}" placeholder="غير واضح"><b>د.ك</b></div></label>
        <label class="field ${loan.installmentFils && !warn.installment ? "" : "needs-review"}"><span>القسط الشهري ${amountTag(warn.installment, loan.installmentFils, "غير واضح — يرجى التأكيد")}</span><div class="money-field"><input data-scan-field="installment" inputmode="decimal" value="${loan.installmentFils ? moneyInput(loan.installmentFils) : ""}" placeholder="غير واضح"><b>د.ك</b></div></label>
        <label class="field ${loan.startDate ? "" : "needs-review"}"><span>تاريخ البداية ${loan.startDate ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — اختياري</small>'}</span><input data-scan-field="start" type="date" value="${escapeHTML(loan.startDate ?? "")}"></label>
        <label class="field ${loan.endDate ? "" : "needs-review"}"><span>تاريخ النهاية ${loan.endDate ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — اختياري</small>'}</span><input data-scan-field="end" type="date" value="${escapeHTML(loan.endDate ?? "")}"></label>
        <label class="field"><span>نسبة سنوية <small class="field-confidence">اتركها فارغة إذا غير واضحة</small></span><div class="money-field"><input data-scan-field="rate" type="text" inputmode="decimal" value="${loan.interestRateKnown ? loan.annualRate : ""}" placeholder="غير واضح"><b>٪</b></div></label>
        <label class="field ${loan.dueDay ? "" : "needs-review"}"><span>يوم الاستحقاق ${loan.dueDay ? '<small class="field-confidence clear">مقروء</small>' : '<small class="field-confidence">غير واضح — يرجى التأكيد</small>'}</span><input data-scan-field="day" type="text" inputmode="numeric" maxlength="2" value="${loan.dueDay ?? ""}" placeholder="غير واضح"></label>
      </div>
      <button class="remove-scan" type="button" data-remove-scan="${index}">حذف هذا القرض</button>
    </article>`;
  }).join("");
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
  const all = [...files];
  const images = all.filter((file) => file.type.startsWith("image/"));
  if (all.length && !images.length) { toast("اختر صوراً PNG أو JPG — الملف اللي اخترته مو صورة"); return; }
  if (images.length < all.length) toast(`تجاهلت ${all.length - images.length} ملف مو صورة`);
  if (images.length > 6) toast("أقرأ 6 صور في المرة — أخذت أول 6");
  const selected = images.slice(0, 6);
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
    message: "تقدر تكمل استخدام حوّش، وبنفتح لك شاشة المراجعة أول ما نخلص.",
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
      scannedLoanCandidates.push(...parseLoanOCRLoans(result?.data?.text ?? "", scannedLoanCandidates.length).filter(hasScanSignal));
    }
    if (!scannedLoanCandidates.length) {
      // قراءة فاضية ما تعني نجاحاً: نقول السبب بدل ما نفتح شاشة مراجعة خالية (F59)
      await worker.terminate();
      worker = null;
      setLoanScanState("error");
      setLoanAnalysisStatus({ title: "ما لقيت أرقام قرض في الصور", message: "تأكد أن الصورة تبيّن الرصيد المتبقي والقسط الشهري بدون قص، أو أدخل القرض يدوياً.", progress: 100, error: true });
      toast("ما لقيت بيانات قرض بالصور — جرّب صورة أوضح أو الإدخال اليدوي");
      return;
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
    const annualRate = rateInput === "" ? 0 : parseRate(rateInput, { min: 0, max: 100 });
    const dueDay = parseCount($("[data-scan-field='day']", card).value, { min: 1, max: 31 });
    const startDate = $("[data-scan-field='start']", card).value;
    const endDate = $("[data-scan-field='end']", card).value;
    // رصيد أكبر من أصل المبلغ طبيعي في المرابحة، فما نرفض الصف بسببه (F45)
    if (!name || !balanceFils || !installmentFils || annualRate === null || dueDay === null || (startDate && !validDate(startDate)) || (endDate && !validDate(endDate))) return null;
    const original = originalAmountFils ?? balanceFils;
    return {
      id: createId(), name: name.slice(0, 60), lender: lender.slice(0, 60), type: debtTypes.includes(type) ? type : "أخرى",
      originalAmountFils: original, originalAmountKnown: originalAmountFils !== null, balanceFils, installmentFils,
      annualRate, interestRateKnown: rateInput !== "", dueDay, startDate, endDate,
      remainingInstallments: null, totalPaidFils: Math.max(original - balanceFils, 0), status: balanceFils === 0 ? "completed" : "active"
    };
  });
  if (!records.length || records.some((record) => !record)) {
    $("#loan-scan-error").textContent = "راجع كل قرض: الاسم والرصيد والقسط ويوم الاستحقاق مطلوبة. المبلغ الأصلي والتواريخ اختيارية إذا لم تظهر بالصورة.";
    return;
  }
  state.loans.push(...records);
  setLoanScanState("success");
  discardingLoanScan = true;
  closeDialog($("#loan-review-dialog"));
  clearScannedImageURLs();
  const murabaha = records.filter((record) => record.balanceFils > record.originalAmountFils).length;
  commit(`تمت إضافة ${countLabel(records.length, "loan")}`);
  if (murabaha) toast("في قرض رصيده أكبر من أصل المبلغ — طبيعي في المرابحة لأن المستحق يشمل الربح.");
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

/* الحجز الفعلي: إذا عند المستخدم بطاقة واحدة مسجلة فالمحرك يستخدم رقمها ويتجاهل رقم الإعدادات،
   فنعرض ونكتب رقم البطاقة نفسه حتى يكون لتعديله أثر (F6). */
function singleCreditCard() {
  return state.creditCards.length === 1 ? state.creditCards[0] : null;
}
function effectiveCardReserveFils() {
  if (!state.creditCards.length) return state.settings.creditCardReserveFils;
  return state.creditCards.filter((card) => card.status !== "paused").reduce((sum, card) => sum + card.reservedPaymentFils, 0);
}

function openSettings() {
  $("#settings-error").textContent = "";
  $("#settings-income").value = moneyInput(state.settings.incomeFils);
  $("#settings-budget").value = moneyInput(state.settings.budgetFils);
  $("#settings-cash").value = moneyInput(state.settings.cashFils);
  $("#settings-salary-day").value = state.settings.salaryDay;
  $("#settings-safety-buffer").value = moneyInput(state.settings.safetyBufferFils);
  $("#settings-credit-card-reserve").value = moneyInput(effectiveCardReserveFils());
  $("#settings-credit-card-reserve").disabled = state.creditCards.length > 1;
  $("#settings-invested").value = moneyInput(state.settings.investedFils);
  $("#settings-assets").value = moneyInput(state.settings.assetsFils);
  renderSecuritySettings();
  renderBankFieldOrder();
  updateMoneyPreviews($("#settings-form"));
  openDialog($("#settings-dialog"));
  renderUpdateStatus();
}

/* ----- زر «تحديث التطبيق» (الإعدادات) -----
   يفحص ./sw.js من الشبكة (بلا كاش): إذا فشل ما في إنترنت وما نغيّر شي. إذا فيه نسخة أحدث نمسح كاشات فلس بس
   ونلغي تسجيل الـ service worker ونعيد تحميل الصفحة. ما نلمس localStorage ولا أي بيانات للمستخدم.
   رقم النسخة من اسم كاش الـ service worker (fils-static-v34 → v34). */
const UPDATE_FETCH_TIMEOUT_MS = 10_000;
const UPDATE_RELOAD_DELAY_MS = 900;
const UPDATE_NOTE_KEY = "fils-update-note"; // sessionStorage فقط (يبقى بعد إعادة التحميل ويختفي بإغلاق التطبيق)
const updateTimeFormatter = new Intl.DateTimeFormat("ar-KW-u-nu-latn", { hour: "numeric", minute: "2-digit" });
let lastUpdateCheck = null; // { at, text }
let startupVersion = null;  // نسخة الكاش لما انفتحت هذي الصفحة
let updateBusy = false;

function updateSupported() {
  // في التطبيق التحديث يجي من App Store، ما فيه كاش ولا service worker
  return !IS_NATIVE && "serviceWorker" in navigator && typeof caches !== "undefined" && location.protocol !== "file:";
}

async function readInstalledVersion() {
  if (!updateSupported()) return null;
  try { return installedVersion(await caches.keys()); } catch { return null; }
}

async function renderUpdateStatus() {
  const line = $("#update-status");
  if (!updateSupported()) { line.textContent = "الزر يشتغل بس على نسخة الموقع المثبتة، مو على هذا الملف."; return; }
  const version = await readInstalledVersion();
  const parts = [version === null ? "النسخة غير معروفة" : `النسخة ${versionLabel(version)}`];
  parts.push(lastUpdateCheck ? `آخر فحص ${updateTimeFormatter.format(lastUpdateCheck.at)}: ${lastUpdateCheck.text}` : "ما فحصت لين الحين");
  line.textContent = parts.join(" · ");
}

function finishUpdateCheck(text, { toastMessage = text } = {}) {
  lastUpdateCheck = { at: new Date(), text };
  if (toastMessage) toast(toastMessage);
  return renderUpdateStatus();
}

/* نجيب sw.js من الشبكة مباشرة. الرابط فيه رقم متغير حتى لو كان عند الجهاز service worker قديم
   يخزن الردود، ما يرجّع لنا نسخة مخزنة ونظنها إنترنت (نجاح الجلب = فيه إنترنت فعلاً). */
async function fetchRemoteWorker() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`./sw.js?check=${Date.now()}`, { cache: "no-store", signal: controller.signal });
    return { online: true, source: response.ok ? await response.text() : "" };
  } catch {
    return { online: false, source: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function checkForUpdate() {
  if (updateBusy) return;
  if (!updateSupported()) { toast("الزر يشتغل بس على نسخة الموقع المثبتة"); return; }
  updateBusy = true;
  const button = $("#update-app");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  $("#update-status").textContent = "جاري الفحص…";
  let reloading = false;
  try {
    const remote = await fetchRemoteWorker();
    if (!remote.online) { await finishUpdateCheck("ما في إنترنت، جرب لما يرجع"); return; }
    const decision = decideUpdate({ installed: await readInstalledVersion(), remote: remoteVersion(remote.source), loaded: startupVersion });
    if (decision.action === "unreadable") { await finishUpdateCheck("ما قدرت أعرف آخر نسخة، جرب بعد شوي"); return; }
    if (decision.action === "current") { await finishUpdateCheck(`عندك آخر نسخة (${versionLabel(decision.version)})`); return; }
    const label = versionLabel(decision.to);
    await finishUpdateCheck(decision.reason === "stale-page" ? `النسخة ${label} نزلت، بنعيد تشغيل التطبيق` : `في نسخة أحدث (${label})، جاري التحديث…`);
    try {
      await Promise.all(staticCacheNames(await caches.keys()).map((name) => caches.delete(name)));
      await Promise.all((await navigator.serviceWorker.getRegistrations()).map((registration) => registration.unregister()));
    } catch (error) {
      console.warn("Update failed", error);
      await finishUpdateCheck("ما قدرت أكمل التحديث، جرب مرة ثانية");
      return;
    }
    try { sessionStorage.setItem(UPDATE_NOTE_KEY, JSON.stringify({ to: decision.to })); } catch { /* التأكيد بعد الإعادة اختياري */ }
    reloading = true;
    setTimeout(() => location.reload(), UPDATE_RELOAD_DELAY_MS);
    // لو الإعادة ما صارت لأي سبب، الزر يرجع يشتغل
    setTimeout(() => { updateBusy = false; button.disabled = false; button.removeAttribute("aria-busy"); }, 10_000);
  } finally {
    if (!reloading) {
      updateBusy = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

/* بعد إعادة التحميل: ننتظر الـ service worker الجديد يفعّل وبعدها نأكد النسخة اللي تثبتت */
async function confirmUpdateAfterReload() {
  let note = null;
  try {
    note = JSON.parse(sessionStorage.getItem(UPDATE_NOTE_KEY) ?? "null");
    sessionStorage.removeItem(UPDATE_NOTE_KEY);
  } catch { /* بدون تأكيد */ }
  if (!note || !updateSupported()) return;
  try {
    await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    const version = await readInstalledVersion();
    if (version !== note.to) return;
    startupVersion = version;
    await finishUpdateCheck(`تم التحديث إلى ${versionLabel(version)}`, { toastMessage: `تم تحديث التطبيق إلى النسخة ${versionLabel(version)}` });
  } catch { /* التأكيد اختياري */ }
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
  if (file.size > 5_000_000) { toast(IS_NATIVE ? "الملف كبير؛ اختر ملفاً نصياً أصغر" : "الملف كبير؛ اختر ملف fils-bank.txt"); return; }
  // ملف صورة أو PDF يرجع حروفاً غير مقروءة فتظهر رسائل وهمية (F51)
  const textish = !file.type || file.type.startsWith("text/") || /\.(?:txt|log|csv)$/i.test(file.name ?? "");
  if (!textish) { toast(IS_NATIVE ? "الملف مو نصي؛ اختر ملفاً نصياً (txt)" : "الملف مو نصي؛ اختر fils-bank.txt من مجلد Shortcuts"); return; }
  const text = await file.text();
  const summary = ingestBankText(text, { fromFile: true });
  if (!summary.total && !summary.alreadyRead) { toast(IS_NATIVE ? "ما لقيت إشعارات في الملف" : "الملف فاضي؛ تأكد من إعداد الاختصار"); return; }
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
  review.textContent = pending === 1 ? "راجع العملية الجديدة" : `راجع ${countLabel(pending, "transaction")} جديدة`;
  // بطاقة الإشعارات صارت داخل «المزيد»: نقطة على الزر تقول إن في عمليات تنتظر المراجعة
  const badge = $("#more-badge");
  badge.hidden = pending === 0;
  badge.textContent = pending > 9 ? "9+" : pending.toLocaleString("ar-KW-u-nu-latn");
  $("#bank-card").classList.toggle("has-pending", pending > 0);
  $("#more-nav-button").setAttribute("aria-label", pending ? `المزيد، ${countLabel(pending, "transaction")} للمراجعة` : "المزيد");
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

function previewBankFieldOrder() {
  const picked = $$("[data-bank-field]").map((select) => select.value).filter(Boolean);
  if (!picked.length || new Set(picked).size !== picked.length) { setText("#bank-field-summary", "اختر كل حقل مرة وحدة"); return; }
  setText("#bank-field-summary", picked.map((field) => FIELD_LABELS[field]).join(" ← "));
}

function openBankAutomationGuide() {
  if ($("#settings-dialog").open) closeDialog($("#settings-dialog"));
  openDialog($("#bank-automation-dialog"));
}

/* ===== الاستقبال التلقائي: صندوق على موقعك يستقبل نص الإشعار من الاختصار، وحوّش يجلبه ويؤكد استلامه ===== */
const BANK_CARD_COPY_WEB = "الآيفون يجمع إشعارات عملياتك أو رسائل SMS في ملف، اضغط «جلب الإشعارات» واختره.";
const BANK_CARD_COPY_INBOX = "الإشعارات توصلك تلقائياً أول ما تفتح حوّش. تقدر برضو تلصق رسالة أو ترفع ملف.";
const storedInbox = IS_NATIVE ? null : readInboxConfig();
let inboxConfig = storedInbox && !storedInbox.pending ? storedInbox : null;
let inboxPendingKey = storedInbox?.pending ? storedInbox.key : "";
let inboxBusy = false;
let inboxLastAutoMs = 0;
let inboxMeta = null;
let inboxAuthWarned = false;

function renderInbox() {
  if (IS_NATIVE) return;
  const on = Boolean(inboxConfig);
  $("#inbox-off").hidden = on;
  $("#inbox-on").hidden = !on;
  // في تبويب Safari التخزين غير تخزين أيقونة الشاشة الرئيسية: ما نفعّل ولا نجلب من هناك
  const inTab = inBrowserTab();
  $("#inbox-browser-note").hidden = !inTab;
  $("#inbox-enable").disabled = inTab;
  $("#inbox-restore").disabled = inTab;
  const copy = $("#bank-card-copy .web-only");
  if (copy) copy.textContent = on ? BANK_CARD_COPY_INBOX : BANK_CARD_COPY_WEB;
  if (!on) return;
  const last = inboxMeta?.lastReceivedAt ? `آخر إشعار وصل الصندوق ${agoLabel(inboxMeta.lastReceivedAt)}` : "لسا ما وصل الصندوق أي إشعار";
  const synced = inboxConfig.lastSyncAt ? ` · آخر جلب ${agoLabel(inboxConfig.lastSyncAt)}` : "";
  setText("#inbox-status", `✓ مفعّل (…${inboxConfig.key.slice(-4)}). ${last}${synced}`);
  const empty = inboxMeta?.emptyCount ?? 0;
  const warning = $("#inbox-empty-warning");
  warning.hidden = empty === 0;
  if (empty) warning.textContent = `وصلت الصندوق إشعارات بدون نص (${empty.toLocaleString("ar-KW-u-nu-latn")}). افتح الأتمتة واختر Title وSubtitle وBody من Notification، لا تحط Notification كاملة.`;
}

function openInbox() {
  if (IS_NATIVE) return;
  if ($("#bank-automation-dialog").open) closeDialog($("#bank-automation-dialog"));
  $("#inbox-error").textContent = "";
  $("#inbox-link-field").hidden = true;
  renderInbox();
  openDialog($("#inbox-dialog"));
  if (inboxConfig) syncInbox({ manual: true, quiet: true });
}

async function syncInbox({ manual = false, quiet = false, force = false } = {}) {
  if (IS_NATIVE || !inboxConfig) return;
  if (inboxBusy) { if (manual && !quiet) toast("جاري الجلب…"); return; }
  if (lockedNow || inBrowserTab()) return; // القفل: يُعاد بعد فتحه. تبويب Safari: تخزينه غير تخزين الأيقونة
  if (!manual && !force && Date.now() - inboxLastAutoMs < 15_000) return;
  inboxBusy = true;
  inboxLastAutoMs = Date.now();
  let succeeded = false;
  const note = (message) => { if (manual && !quiet) toast(message); };
  try {
    const total = { total: 0, alreadyRead: 0, queued: 0, duplicates: 0, possible: 0, drafts: 0, ignored: [], manual: [] };
    let received = 0;
    for (let round = 0; round < 5; round += 1) {
      const result = await fetchInbox(inboxConfig.key);
      if (!result.ok) {
        if (manual) $("#inbox-error").textContent = inboxErrorMessage(result.error);
        else if (result.error === "unauthorized" && !inboxAuthWarned) { inboxAuthWarned = true; toast("الاستقبال التلقائي وقف: الصندوق ما يعرف مفتاحك. افتح «المزيد» ← «طريقة الربط» وفعّله من جديد."); }
        return;
      }
      if (manual) $("#inbox-error").textContent = "";
      inboxMeta = result.data.meta ?? null;
      const items = Array.isArray(result.data.items) ? result.data.items : [];
      if (!items.length) break;
      const summary = ingestBankText(itemsToBankText(items), { fromFile: true });
      // ما نأكّد الاستلام إلا إذا انحفظ عندك فعلاً؛ لو فشل الحفظ يبقى الإشعار في الصندوق
      if (!storageAvailable) { toast("ما قدرت أحفظ على الجهاز. الإشعارات باقية في الصندوق."); return; }
      received += items.length;
      for (const field of ["total", "alreadyRead", "queued", "duplicates", "possible", "drafts"]) total[field] += summary[field];
      total.ignored.push(...summary.ignored);
      total.manual.push(...summary.manual);
      await ackInbox(inboxConfig.key, items.map((item) => item.id));
      if (!result.data.more) break;
    }
    inboxConfig = { ...inboxConfig, lastSyncAt: new Date().toISOString(), lastCount: received };
    writeInboxConfig(inboxConfig);
    if (received) reportBankSummary(total, { auto: true });
    else note("ما فيه إشعارات جديدة بالصندوق");
    succeeded = true;
  } finally {
    inboxBusy = false;
    if (!succeeded) inboxLastAutoMs = 0; // الفشل ما يحبس المحاولة الجاية خمس عشرة ثانية
    renderInbox();
  }
}

async function enableInbox() {
  const button = $("#inbox-enable");
  const error = $("#inbox-error");
  error.textContent = "";
  if (inBrowserTab()) { renderInbox(); return; }
  button.disabled = true;
  try {
    const key = inboxPendingKey || newInboxKey();
    // نحفظ المفتاح قبل الطلب: لو الخادم حجز الصندوق وضاع الرد، نعيد بنفس المفتاح (الحجز نفسه مرتين يمر)
    if (!writeInboxConfig({ key, enabledAt: "", lastSyncAt: "", lastCount: 0, pending: true })) {
      error.textContent = "ما قدرت أحفظ المفتاح على الجهاز. افتح حوّش من أيقونة الشاشة الرئيسية وجرّب مرة ثانية.";
      return;
    }
    inboxPendingKey = key;
    const result = await claimInbox(key);
    if (!result.ok) {
      if (result.error === "taken" || result.error === "unauthorized") { inboxPendingKey = ""; writeInboxConfig(null); }
      const retry = result.error === "network" || result.error === "service" || result.error === "server" ? " اضغط «تفعيل الاستقبال» مرة ثانية." : "";
      error.textContent = inboxErrorMessage(result.error) + retry;
      return;
    }
    inboxConfig = { key, enabledAt: new Date().toISOString(), lastSyncAt: "", lastCount: 0, pending: false };
    inboxPendingKey = "";
    if (!writeInboxConfig(inboxConfig)) {
      inboxConfig = null;
      error.textContent = "ما قدرت أحفظ المفتاح على الجهاز. افتح حوّش من أيقونة الشاشة الرئيسية وجرّب مرة ثانية.";
      await unclaimInbox(key);
      writeInboxConfig(null);
      return;
    }
    inboxMeta = null;
    renderInbox();
  } finally { button.disabled = inBrowserTab(); }
}

async function restoreInbox() {
  const error = $("#inbox-error");
  error.textContent = "";
  if (inBrowserTab()) { renderInbox(); return; }
  const key = parseInboxKey($("#inbox-paste").value);
  if (!key) { error.textContent = "هذا مو رابط الاستقبال. انسخه كامل من خانة URL في الاختصار (يحتوي على /api/in/)."; return; }
  const result = await claimInbox(key);
  if (!result.ok) { error.textContent = inboxErrorMessage(result.error); return; }
  inboxConfig = { key, enabledAt: new Date().toISOString(), lastSyncAt: "", lastCount: 0, pending: false };
  inboxPendingKey = "";
  writeInboxConfig(inboxConfig);
  $("#inbox-paste").value = "";
  inboxMeta = null;
  renderInbox();
  syncInbox({ manual: true, quiet: true });
}

async function stopInbox() {
  if (!inboxConfig) return;
  // لو انقفل التطبيق وانت تجاوب، ما نفتح النافذة فوق شاشة القفل
  const reopen = () => { if (!lockedNow) openDialog($("#inbox-dialog")); };
  const ok = await askConfirm("توقف الاستقبال التلقائي؟ يتمسح الصندوق من موقعك (اللي ما وصل جوالك يضيع) والرابط القديم يوقف يشتغل.", { okLabel: "نعم، أوقفه", danger: true });
  if (!ok) { reopen(); return; }
  const result = await unclaimInbox(inboxConfig.key);
  if (!result.ok && result.error !== "unauthorized") {
    $("#inbox-error").textContent = inboxErrorMessage(result.error);
    reopen();
    return;
  }
  inboxConfig = null;
  inboxMeta = null;
  inboxPendingKey = "";
  writeInboxConfig(null);
  reopen();
  renderInbox();
  toast("وقفت الاستقبال التلقائي");
}

async function copyInboxLink() {
  if (!inboxConfig) return;
  const link = inboxLink(inboxConfig.key, INBOX_BASE);
  try {
    await navigator.clipboard.writeText(link);
    $("#inbox-link-field").hidden = true;
    toast("نسخت الرابط. الصقه في خانة URL بالاختصار");
  } catch {
    const field = $("#inbox-link");
    $("#inbox-link-field").hidden = false;
    field.value = link;
    field.focus(); field.select();
    toast("اضغط مطولاً على الرابط واختر «نسخ»");
  }
}

function bindInboxEvents() {
  if (IS_NATIVE) return;
  $("#inbox-open").addEventListener("click", openInbox);
  $("#inbox-enable").addEventListener("click", enableInbox);
  $("#inbox-restore").addEventListener("click", restoreInbox);
  $("#inbox-copy").addEventListener("click", copyInboxLink);
  $("#inbox-sync").addEventListener("click", () => syncInbox({ manual: true }));
  $("#inbox-stop").addEventListener("click", () => { closeDialog($("#inbox-dialog")); stopInbox(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncInbox(); });
  window.addEventListener("online", () => syncInbox({ force: true }));
  renderInbox();
}


let pendingPortfolioImport = [];
function handlePortfolioLink() {
  if (!location.hash.startsWith("#stocks=")) return false;
  try {
    pendingPortfolioImport = parsePortfolioLink(location.hash);
    switchView("investment");
    $("#portfolio-import-list").innerHTML = pendingPortfolioImport.map(item => {
      const security = getKuwaitStock(item.securityCode);
      return `<article class="data-card"><h3>${escapeHTML(security.name)} · ${escapeHTML(security.ticker)}</h3><p>${countLabel(item.quantity, "stock")} · متوسط التكلفة ${escapeHTML(formatSharePrice(item.purchasePriceTenths))} · السعر بالصورة ${escapeHTML(formatSharePrice(item.currentPriceTenths))}</p></article>`;
    }).join("");
    const count = newPortfolioHoldings(state.stockHoldings, pendingPortfolioImport).length;
    $("#portfolio-import-save").disabled = count === 0 || !storageAvailable;
    setText("#portfolio-import-status", !storageAvailable ? (IS_NATIVE ? "التخزين غير متاح على الجهاز الحين. سكّر التطبيق وافتحه من جديد." : "التخزين غير متاح؛ افتح الرابط في Safari لحفظ الأسهم.") : count ? `جاهز لإضافة ${countLabel(count, "stock")}. الأسهم الموجودة عندك لن تتغير.` : "هالأسهم موجودة عندك بالفعل؛ ما راح نكررها.");
    openDialog($("#portfolio-import-dialog"));
  } catch {
    history.replaceState(null, "", "#investment");
    switchView("investment", false);
    toast("رابط المحفظة غير صالح؛ لم تتغير بياناتك.");
  }
  return true;
}

let deferredBankText = "";
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
  if (lockedNow) {
    // كان الإشعار يُحفظ ويُعرض خلف شاشة القفل، والعنوان يُمسح فيضيع النص (F46)
    deferredBankText = bankText;
    $("#lock-error").textContent = "وصل إشعار — افتح القفل عشان أسجّله.";
    return true;
  }
  reportBankSummary(ingestBankText(bankText));
  return true;
}

function settingsError(message, selector) {
  const box = $("#settings-error");
  box.textContent = message;
  // الخطأ كان ينزل أسفل نافذة طويلة فما يشوفه أحد (F33)
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  if (selector) invalidField(selector, "#settings-error", { preventScroll: true });
}

function submitSettings(event) {
  event.preventDefault();
  const salaryDay = parseCount($("#settings-salary-day").value, { min: 1, max: 31 });
  const amounts = {
    incomeFils: ["#settings-income", "الدخل الشهري"], budgetFils: ["#settings-budget", "ميزانية المصروف"],
    cashFils: ["#settings-cash", "رصيد الكاش"], safetyBufferFils: ["#settings-safety-buffer", "احتياطي الأمان"],
    creditCardReserveFils: ["#settings-credit-card-reserve", "دفعات البطاقات"],
    investedFils: ["#settings-invested", "قيمة الاستثمارات"], assetsFils: ["#settings-assets", "قيمة الأصول"]
  };
  const fields = { salaryDay };
  const optional = new Set(["cashFils", "safetyBufferFils", "creditCardReserveFils", "investedFils", "assetsFils"]);
  for (const [key, [selector, label]] of Object.entries(amounts)) {
    // الخانة الاختيارية الفاضية = صفر (F33)
    const raw = $(selector).value.trim();
    const value = optional.has(key) && raw === "" ? 0 : parseMoney(raw);
    if (value === null) { settingsError(`${label}: اكتب المبلغ بالدينار مثل 1500.000 (ثلاث خانات كحد أقصى).`, selector); return; }
    fields[key] = value;
  }
  if (salaryDay === null) { settingsError("يوم نزول المعاش من 1 إلى 31.", "#settings-salary-day"); return; }

  // F13: دخل واحد مسجل؟ نعدّله مباشرة. أكثر من واحد؟ الأول هو الأساسي ويستوعب الفرق.
  if (state.incomes.length <= 1) {
    if (fields.incomeFils === 0) state.incomes = [];
    else if (state.incomes.length === 1) state.incomes[0].amountFils = fields.incomeFils;
    else state.incomes = [{ id: "primary-income", name: "الدخل الأساسي", amountFils: fields.incomeFils, frequency: "monthly", status: "active" }];
  } else {
    const others = state.incomes.slice(1);
    const othersTotal = others.filter((item) => item.status !== "paused").reduce((sum, item) => sum + item.amountFils, 0);
    if (fields.incomeFils < othersTotal) {
      settingsError(`الدخل الكلي لا يقل عن مصادر الدخل الإضافية المسجلة (${formatMoney(othersTotal)}).`, "#settings-income");
      return;
    }
    const primaryAmount = fields.incomeFils - othersTotal;
    if (primaryAmount > 0) state.incomes[0].amountFils = primaryAmount;
    else state.incomes = others;
  }

  const card = singleCreditCard();
  if (card) card.reservedPaymentFils = fields.creditCardReserveFils;
  state.settings = fields;
  // F54: ترتيب حقول الإشعار يُثبّت مع زر الحفظ لا بمجرد تغيير القائمة
  const picked = $$("[data-bank-field]").map((select) => select.value).filter(Boolean);
  if (picked.length && new Set(picked).size === picked.length) state.ui.bankFieldOrder = picked;
  closeDialog($("#settings-dialog"));
  commit("تم حفظ الإعدادات");
}

function switchView(target, updateHash = true) {
  if (!$( `[data-view="${target}"]` ) || (target === "assistant" && IS_NATIVE)) target = "dashboard";
  $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === target));
  $$("[data-target]").forEach((button) => {
    const active = button.dataset.target === target || button.dataset.activeFor === target;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const moreActive = ["advisor", "goals", "checkup", "spending", "assistant"].includes(target);
  $("#more-nav-button").classList.toggle("active", moreActive);
  if (moreActive) $("#more-nav-button").setAttribute("aria-current", "page");
  else $("#more-nav-button").removeAttribute("aria-current");
  if (updateHash && location.hash !== `#${target}`) history.replaceState(null, "", `#${target}`);
  if (target === "assistant") renderAssistant();
  scrollTo({ top: 0, behavior: "smooth" });
}

async function removeRecord(collection, id, label) {
  const record = state[collection].find((item) => item.id === id);
  if (!record) return;
  const name = record.merchant || record.name || "";
  // المبلغ مع الاسم حتى يميّز المستخدم بين سجلين بنفس الاسم (F58)
  const amount = Number.isSafeInteger(record.amountFils) ? record.amountFils : Number.isSafeInteger(record.balanceFils) ? record.balanceFils : Number.isSafeInteger(record.targetFils) ? record.targetFils : null;
  if (!(await askConfirm(`متأكد تبي تحذف ${label}${name ? ` «${cutText(name, 40)}»` : ""}${amount !== null ? ` (${formatMoney(amount)})` : ""}؟`, { okLabel: "احذف", danger: true }))) return;
  const index = state[collection].findIndex((item) => item.id === id);
  const removedDebtPayments = collection === "loans" ? state.debtPayments.filter((item) => item.debtId === id) : [];
  const removedExtraPayments = collection === "loans" ? state.extraPayments.filter((item) => item.debtId === id) : [];
  const removedCommitmentPayments = collection === "monthlyCommitments" ? state.commitmentPayments.filter((item) => item.commitmentId === id) : [];
  state[collection] = state[collection].filter((item) => item.id !== id);
  if (collection === "loans") {
    state.debtPayments = state.debtPayments.filter((item) => item.debtId !== id);
    state.extraPayments = state.extraPayments.filter((item) => item.debtId !== id);
  }
  if (collection === "monthlyCommitments") state.commitmentPayments = state.commitmentPayments.filter((item) => item.commitmentId !== id);
  commit("تم الحذف", { undo: () => {
    state[collection].splice(Math.max(index, 0), 0, record);
    state.debtPayments.push(...removedDebtPayments);
    state.extraPayments.push(...removedExtraPayments);
    state.commitmentPayments.push(...removedCommitmentPayments);
    commit("رجّعت السجل");
  } });
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
    details.push(`التحليل مبني على ${countLabel(report.count, "transaction")} مصروف معتمدة خلال الفترة المعروضة.`);
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
let confirmPhrase = "";
function askConfirm(message, { okLabel = "نعم، كمّل", danger = false, phrase = "" } = {}) {
  const dialog = $("#confirm-dialog");
  if (confirmResolver) settleConfirm(false);
  $("#confirm-message").textContent = message;
  confirmPhrase = phrase;
  const field = $("#confirm-phrase-field");
  const input = $("#confirm-phrase");
  field.hidden = !phrase;
  input.value = "";
  if (phrase) setText("#confirm-phrase-label", `اكتب «${phrase}» للتأكيد`);
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  ok.classList.toggle("primary", !danger);
  ok.disabled = Boolean(phrase);
  return new Promise((resolve) => {
    confirmResolver = resolve;
    openDialog(dialog);
    if (phrase) setTimeout(() => input.focus(), 60);
  });
}
// «تم الدفع»: كامل المتبقي أو جزء منه. يرجّع { amountFils } أو null لو ألغى
function askPayment(commitment, remainingFils, alreadyPaidFils = 0, lastPaymentFils = 0) {
  const dialog = $("#pay-dialog");
  const input = $("#pay-partial-amount");
  const error = $("#pay-error");
  setText("#pay-title", `دفع «${cutText(commitment.name, 30)}»`);
  setText("#pay-summary", alreadyPaidFils > 0
    ? `دفعت قبل ${formatMoney(alreadyPaidFils)} من ${formatMoney(commitment.amountFils)}. الباقي ${formatMoney(remainingFils)}.`
    : `المبلغ المستحق ${formatMoney(remainingFils)}.`);
  setText("#pay-full", alreadyPaidFils > 0 ? `دفعت الباقي كامل (${formatMoney(remainingFils)})` : `دفعت المبلغ كامل (${formatMoney(remainingFils)})`);
  input.value = "";
  input.removeAttribute("aria-invalid");
  error.hidden = true;
  updateMoneyPreviews(dialog);
  // دفعة جزئية سابقة: نعطيه طريق يتراجع عنها (وإلا ما فيه طريق لتصحيح مبلغ غلط)
  const undo = $("#pay-undo");
  undo.hidden = !(alreadyPaidFils > 0 && lastPaymentFils > 0);
  undo.textContent = `تراجع عن آخر دفعة (${formatMoney(lastPaymentFils)})`;
  return new Promise((resolve) => {
    const done = (value) => {
      $("#pay-full").onclick = $("#pay-partial").onclick = $("#pay-cancel").onclick = undo.onclick = null;
      dialog.onclose = null;
      if (dialog.open) closeDialog(dialog);
      resolve(value);
    };
    $("#pay-full").onclick = () => done({ amountFils: remainingFils });
    $("#pay-partial").onclick = () => {
      const fils = parseMoney(input.value);
      const reject = (message) => { error.textContent = message; error.hidden = false; input.setAttribute("aria-invalid", "true"); input.focus(); };
      if (!fils || fils <= 0) { reject(!input.value.trim() ? "اكتب المبلغ اللي دفعته." : /^[0٠.,٫\s]*$/.test(input.value) ? "المبلغ لازم يكون أكثر من صفر." : "ما فهمت المبلغ. اكتب رقم مثل 40 أو 25.5."); return; }
      if (fils > remainingFils) { reject(`المبلغ أكبر من الباقي (${formatMoney(remainingFils)}).`); return; }
      done({ amountFils: fils });
    };
    $("#pay-cancel").onclick = () => done(null);
    undo.onclick = () => done({ undo: true });
    dialog.onclose = () => done(null);
    openDialog(dialog);
  });
}

function settleConfirm(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  confirmPhrase = "";
  $("#confirm-phrase-field").hidden = true;
  $("#confirm-ok").disabled = false;
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
    native?.lockChanged(record);
    return true;
  } catch (error) { console.warn("Lock storage unavailable", error); return false; }
}

function snapshotBeforeChange(reason) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), reason, state })); return true; }
  catch (error) { console.warn("Snapshot failed", error); return false; }
}
function readSnapshot() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "null");
    return parsed?.state && typeof parsed.savedAt === "string" ? parsed : null;
  } catch { return null; }
}
const SNAPSHOT_LABELS = { reset: "المسح", import: "الاستيراد", restore: "الاسترجاع", pin: "تغيير الرمز" };
async function restoreSnapshot() {
  const snapshot = readSnapshot();
  if (!snapshot) { toast("ما فيه نسخة تلقائية للاسترجاع"); return; }
  const label = SNAPSHOT_LABELS[snapshot.reason] ?? "الاستيراد";
  if (!(await askConfirm(`نرجّع بياناتك كما كانت قبل ${label} (${formatDate(snapshot.savedAt.slice(0, 10))})؟ بيانات اليوم الحالية تُستبدل.`, { okLabel: "استرجاع", danger: true }))) return;
  if (!snapshotBeforeChange("restore")) {
    if (!(await askConfirm("ما قدرت أحفظ نسخة رجوع قبل الاسترجاع. صدّر نسخة احتياطية أولاً، أو نكمل بدون شبكة أمان؟", { okLabel: "كمّل بدون نسخة", danger: true }))) return;
  }
  state = sanitizeState(snapshot.state);
  closeDialog($("#settings-dialog"));
  commit("تم الاسترجاع", { investmentInputs: true });
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
  if (snapshot) $("#restore-snapshot").textContent = `استرجاع نسخة ما قبل ${SNAPSHOT_LABELS[snapshot.reason] ?? "الاستيراد"}`;
  native?.renderSettings();
}

/* ----- شاشة القفل ----- */
function lockApp() {
  if (!lockRecord || lockedNow) return;
  lockedNow = true;
  assistantController?.onLock();
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
  document.body.classList.remove("is-locked", "is-private");
  $("#lock-screen").hidden = true;
  $("#lock-pin").value = "";
  clearInterval(lockTimer);
  renderBackupReminder();
  renderNudges();
  refreshAssistantView();
  if (deferredBankText) {
    const text = deferredBankText;
    deferredBankText = "";
    reportBankSummary(ingestBankText(text));
  }
  syncInbox();
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
  // F38: ضغطتين كانت تكفي لمسح كل شي؛ الحين لازم تنكتب «امسح» والتنبيه واضح لمن ما عنده ملف نسخة
  if (!(await askConfirm("ما فيه طريقة لاسترجاع الرمز. نمسح كل بيانات حوّش من هذا الجهاز (مع نسخة الرجوع التلقائية) ونفتح التطبيق بدون قفل. إذا ما عندك ملف نسخة احتياطية مصدّر، بياناتك تروح نهائياً. نكمل؟", { okLabel: "امسح وافتح", danger: true, phrase: "امسح" }))) return;
  writeLockRecord(null);
  // The automatic snapshot would otherwise restore everything without the PIN.
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* storage unavailable */ }
  // سجل تراجع المحاسب الذكي فيه قيم مالية: يُمسح مع المسح الكامل حتى لا يصير طريقاً حول الرمز
  clearAiStore(); assistantController?.wipe();
  state = defaultState();
  state.ui.initialPortfolioApplied = true;
  try { localStorage.removeItem(STORAGE_KEY); storageAvailable = true; } catch { storageAvailable = false; }
  saveState(); unlockApp(); renderAll({ investmentInputs: true }); toast("تم المسح. تقدر تستورد نسخة احتياطية من الإعدادات.");
  // الترحيب يفتح مباشرة بدل ما ينتظر إعادة التحميل (F38)
  setTimeout(openOnboarding, 350);
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
  if (pinMode !== "set") {
    // إيقاف القفل وتغييره كانا بلا حد للمحاولات، فيمكن تخمين الرمز بلا عقوبة (F47)
    const waiting = remainingLockMs(lockRecord, Date.now());
    if (waiting > 0) { error.textContent = `محاولات كثيرة. جرّب بعد ${Math.ceil(waiting / 1000).toLocaleString("ar-KW-u-nu-latn")} ثانية.`; return; }
    if (!(await verifyPin($("#pin-current").value.trim(), lockRecord))) {
      writeLockRecord(registerFailure(lockRecord, Date.now()));
      $("#pin-current").value = "";
      const left = remainingLockMs(lockRecord, Date.now());
      error.textContent = left > 0
        ? `الرمز الحالي غير صحيح. محاولات كثيرة — جرّب بعد ${Math.ceil(left / 1000).toLocaleString("ar-KW-u-nu-latn")} ثانية.`
        : "الرمز الحالي غير صحيح.";
      return;
    }
    writeLockRecord(registerSuccess(lockRecord));
  }
  if (pinMode === "disable") { writeLockRecord(null); closeDialog($("#pin-dialog")); renderSecuritySettings(); toast("تم إيقاف القفل"); return; }
  const next = $("#pin-new").value.trim();
  if (!PIN_PATTERN.test(normalizeDigits(next))) { error.textContent = "الرمز من 4 إلى 8 أرقام فقط."; return; }
  if (normalizeDigits(next) !== normalizeDigits($("#pin-confirm").value.trim())) { error.textContent = "الرمزان غير متطابقين."; return; }
  if (!cryptoAvailable()) { error.textContent = IS_NATIVE ? "القفل ما يشتغل على هالجهاز." : "المتصفح لا يدعم القفل هنا."; return; }
  const changing = Boolean(lockRecord);
  const previousRecord = lockRecord;
  // التخزين المحظور: «تم تفعيل القفل» كانت تطلع والرمز ما ينحفظ، فيفتح التطبيق بدون قفل بعد إعادة التحميل (F11)
  if (!writeLockRecord(await createLockRecord(next))) {
    lockRecord = previousRecord;
    error.textContent = "ما قدرت أحفظ الرمز على هذا الجهاز (التخزين محظور أو ممتلئ)، فالقفل ما راح يشتغل. " + (IS_NATIVE ? "تأكد إن في مساحة فاضية على الجهاز وجرّب مرة ثانية." : "افتح حوّش في Safari العادي وجرّب مرة ثانية.");
    return;
  }
  closeDialog($("#pin-dialog")); renderSecuritySettings();
  toast(changing ? "تم تغيير الرمز" : "تم تفعيل القفل");
}

function setupSafetyEvents() {
  $("#confirm-ok").addEventListener("click", () => settleConfirm(true));
  $("#confirm-cancel").addEventListener("click", () => settleConfirm(false));
  // حدث close يوصل متأخر (task): لو انفتح تأكيد ثاني بعده مباشرة (مثل «ما قدرت أحفظ نسخة رجوع»)
  // كان يلغيه بصمت فما يشوف المستخدم أي رسالة. نتجاهله إذا النافذة مفتوحة من جديد.
  $("#confirm-dialog").addEventListener("close", () => { if (!$("#confirm-dialog").open) settleConfirm(false); });
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
    saveState(); renderBackupReminder(); toast("بذكّرك بعد 3 أيام");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAtMs = Date.now();
      // صورة مبدّل التطبيقات تُلتقط بعد الخروج: نضبّب الأرقام إذا كان القفل مفعّلاً (F48)
      if (lockRecord) document.body.classList.add("is-private");
      return;
    }
    document.body.classList.remove("is-private");
    if (lockRecord && shouldRelock({ hiddenAtMs, nowMs: Date.now() })) lockApp();
    renderBackupReminder();
  });
}

async function exportData() {
  const before = { lastBackupAt: state.ui.lastBackupAt, backupSnoozedUntil: state.ui.backupSnoozedUntil };
  state.ui.lastBackupAt = new Date().toISOString();
  state.ui.backupSnoozedUntil = "";
  saveState(); renderBackupReminder();
  const data = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
  if (native) {
    // التطبيق: ملف مؤقت ثم شاشة المشاركة (ملفات، AirDrop). لو أُلغيت المشاركة ما نحسبها نسخة احتياطية.
    const outcome = await native.shareBackup(data, `fils-backup-${todayISO()}.json`);
    if (outcome === "shared") { toast("تم تجهيز النسخة الاحتياطية"); return; }
    state.ui.lastBackupAt = before.lastBackupAt;
    state.ui.backupSnoozedUntil = before.backupSnoozedUntil;
    saveState(); renderBackupReminder();
    toast(outcome === "cancelled" ? "ما انحفظت النسخة الاحتياطية" : "ما قدرت أفتح المشاركة. جرّب مرة ثانية");
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = `fils-backup-${todayISO()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("تم تجهيز النسخة الاحتياطية");
}

/* F39: ملخص الملف قبل الاستبدال (كم عملية وقرض والتزام…) مع المرفوض وسببه، وتحذير لو الملف فاضي. */
function backupSummaryLines(snapshot, stats = null) {
  const lines = [
    `العمليات: ${(snapshot.transactions?.length ?? 0).toLocaleString("ar-KW-u-nu-latn")}`,
    `القروض: ${(snapshot.loans?.length ?? 0).toLocaleString("ar-KW-u-nu-latn")} · الالتزامات: ${(snapshot.monthlyCommitments?.length ?? 0).toLocaleString("ar-KW-u-nu-latn")}`,
    `الأهداف: ${(snapshot.goals?.length ?? 0).toLocaleString("ar-KW-u-nu-latn")} · الأسهم: ${(snapshot.stockHoldings?.length ?? 0).toLocaleString("ar-KW-u-nu-latn")}`
  ];
  if (stats?.cappedTransactions) lines.push(`⚠ الملف فيه ${countLabel(stats.rawTransactions, "transaction")} والحد ${(20_000).toLocaleString("ar-KW-u-nu-latn")}، فما راح ينقرا ${countLabel(stats.cappedTransactions, "transaction")}.`);
  if (stats?.invalidTransactions) lines.push(`⚠ ${countLabel(stats.invalidTransactions, "transaction")} مرفوضة (تاريخ غير صالح أو مبلغ غير صحيح).`);
  return lines;
}

async function importData(file) {
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (Number.isInteger(raw?.version) && raw.version > 4) {
      settingsError(`النسخة من إصدار أحدث من حوّش (${raw.version}). حدّث التطبيق (أعد فتحه وهو متصل) وبعدها استوردها.`);
      return;
    }
    if (![1, 2, 3, 4].includes(raw?.version)) throw new Error("Unsupported backup");
    const next = sanitizeState(raw);
    const stats = { ...lastSanitizeStats };
    const empty = !hasMeaningfulData(next);
    const exported = typeof raw.exportedAt === "string" && validDate(raw.exportedAt.slice(0, 10)) ? ` (${formatDate(raw.exportedAt.slice(0, 10))})` : "";
    const message = [
      `الملف${exported}:`, ...backupSummaryLines(next, stats),
      "", "بياناتك الحالية:", ...backupSummaryLines(state),
      "", empty
        ? "⚠ الملف ما فيه بيانات، فالاستيراد يمسح بياناتك الحالية."
        : "الاستيراد يستبدل البيانات الحالية، ونحفظ لك نسخة تلقائية قبل الاستبدال لو احتجت ترجع. نكمل؟"
    ].join("\n");
    if (!(await askConfirm(message, { okLabel: empty ? "استبدل بملف فاضي" : "استيراد", danger: empty }))) return;
    // ما نستبدل بيانات المستخدم بدون شبكة أمان إلا بعلمه (F12)
    if (!snapshotBeforeChange("import")) {
      settingsError("ما قدرت أحفظ نسخة رجوع على الجهاز (المساحة ممتلئة؟). صدّر نسخة احتياطية أولاً، وبعدها أعد الاستيراد.");
      return;
    }
    const previous = state;
    state = next;
    // F12: يا ينحفظ كامل يا نرجع للحالة السابقة — ما نقول «تم» وهو بالذاكرة بس
    if (!saveState()) {
      state = previous;
      saveState();
      renderAll({ investmentInputs: true });
      settingsError(`ما قدرت أحفظ النسخة المستوردة (${countLabel(next.transactions.length, "transaction")}) — ${IS_NATIVE ? "مساحة الجهاز" : "مساحة المتصفح"} ما تكفي. رجّعت بياناتك السابقة كما هي.`);
      return;
    }
    closeDialog($("#settings-dialog"));
    const dropped = stats.cappedTransactions + stats.invalidTransactions;
    commit(dropped
      ? `قرأت ${countLabel(stats.rawTransactions, "transaction")} واعتمدت ${countLabel(stats.keptTransactions, "transaction")} — ${[stats.invalidTransactions ? `${countLabel(stats.invalidTransactions, "transaction")} مرفوضة` : "", stats.cappedTransactions ? `${countLabel(stats.cappedTransactions, "transaction")} فوق الحد` : ""].filter(Boolean).join(" و")}`
      : `تم استيراد البيانات · ${countLabel(stats.keptTransactions, "transaction")}`, { investmentInputs: true });
  } catch (error) { settingsError("ملف النسخة غير صالح أو غير مدعوم."); console.error(error); }
  finally { $("#import-data").value = ""; }
}

async function resetData({ permanent = false } = {}) {
  const message = permanent
    ? "مسح نهائي: نمسح كل بياناتك ونمسح معها النسخة التلقائية، فما يبقى شي تقدر ترجع له من الجهاز."
    : "هذا يمسح كل العمليات والالتزامات والقروض والأسهم والأهداف من هذا الجهاز. نحفظ لك نسخة تلقائية وحدة تقدر ترجع لها بعد المسح. متأكد؟";
  // F38: كتابة الكلمة تمنع المسح بضغطة غلط
  if (!(await askConfirm(message, { okLabel: permanent ? "امسح نهائياً" : "امسح", danger: true, phrase: "امسح" }))) return;
  if (!permanent && !snapshotBeforeChange("reset")) {
    if (!(await askConfirm("ما قدرت أحفظ نسخة رجوع. صدّر نسخة احتياطية أولاً، أو نمسح بدون شبكة أمان؟", { okLabel: "امسح بدون نسخة", danger: true }))) return;
  }
  if (permanent) { try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* storage unavailable */ } clearAiStore(); }
  assistantController?.wipe();
  state = defaultState();
  state.ui.initialPortfolioApplied = true;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  closeDialog($("#settings-dialog"));
  commit(permanent ? "تم المسح النهائي" : "تم مسح البيانات", { investmentInputs: true });
  refreshAssistantView();
  setTimeout(openOnboarding, 350);
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
    toast(`تمت إضافة ${countLabel(additions.length, "stock")} إلى محفظتك`);
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
    if (action === "refresh-stock-prices") refreshStockPrices();
    if (action === "new-goal") openGoal();
  });
  $$(".close-dialog").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
  $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (dialog.id === "loan-review-dialog") return;
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) closeDialog(dialog);
  }));
  // F7: معاينة المبلغ تحت أي خانة دينار، في كل النوافذ
  document.addEventListener("input", (event) => {
    if (event.target.matches?.(".money-field input")) updateMoneyPreview(event.target);
    if (event.target.getAttribute?.("aria-invalid") === "true") event.target.removeAttribute("aria-invalid");
  });
  // F38: زر التأكيد يفتح فقط لما تُكتب الكلمة المطلوبة
  $("#confirm-phrase").addEventListener("input", () => {
    if (!confirmPhrase) return;
    $("#confirm-ok").disabled = $("#confirm-phrase").value.trim() !== confirmPhrase;
  });
  // F52: التصنيف يُقترح من اسم التاجر، وقائمة الدخل غير قائمة المصروف
  $("#transaction-category").addEventListener("change", () => { categoryTouched = true; });
  $("#transaction-kind").addEventListener("change", () => {
    renderTransactionCategories($("#transaction-kind").value, $("#transaction-category").value);
    categoryTouched = false;
  });
  $("#transaction-merchant").addEventListener("input", () => {
    if (categoryTouched || $("#transaction-kind").value === "income") return;
    const merchant = $("#transaction-merchant").value.trim();
    if (merchant.length < 3) return;
    const guess = inferCategory(merchant);
    if (guess && guess !== "أخرى") $("#transaction-category").value = guess;
  });
  $("#bank-date").addEventListener("change", renderBankPreview);
  $("#reset-data-hard").addEventListener("click", () => resetData({ permanent: true }));
  $("#storage-warning-export").addEventListener("click", exportData);
  $("#storage-warning-retry").addEventListener("click", () => { if (saveState()) toast("تم الحفظ على الجهاز ✅"); else toast("ما زال الحفظ متعذراً — صدّر نسخة احتياطية"); });
  $("#transaction-form").addEventListener("submit", submitTransaction);
  $("#transaction-date").addEventListener("input", renderTransactionTimeNote);
  $("#commitment-form").addEventListener("submit", submitCommitment);
  $("#commitment-category").addEventListener("change", () => { $("#custom-category-field").hidden = $("#commitment-category").value !== "__custom"; });
  $("#loan-form").addEventListener("submit", submitLoan);
  $("#extra-payment-form").addEventListener("submit", submitExtraPayment);
  $("#extra-payment-amount").addEventListener("input", updateExtraPaymentSimulation);
  $("#loan-review-form").addEventListener("submit", saveScannedLoans);
  $("#add-missing-scanned-loan").addEventListener("click", addMissingScannedLoan);
  $("#loan-screenshots").addEventListener("change", (event) => scanLoanScreenshots(event.target.files ?? []));
  // Escape أو ضغطة خارج النافذة كانت تلغي كل التعديلات بلا سؤال (F21)
  $("#loan-review-dialog").addEventListener("cancel", (event) => {
    if (discardingLoanScan) return;
    event.preventDefault();
    toast("اضغط «إلغاء» إذا تبي تتخلى عن المراجعة");
  });
  $("#loan-review-dialog").addEventListener("close", () => {
    if (!discardingLoanScan) return;
    discardingLoanScan = false;
    scannedLoanCandidates = [];
    $("#loan-scan-results").innerHTML = "";
    $("#loan-scan-error").textContent = "";
    $("#save-scanned-loans").disabled = true;
    clearScannedImageURLs();
  });
  $$(".discard-loan-scan").forEach((button) => button.addEventListener("click", () => { discardingLoanScan = true; }));
  // F21: كل حرف يكتبه المستخدم يرجع للمرشّح نفسه، فإعادة الرسم ما تمسحه
  $("#loan-scan-results").addEventListener("input", (event) => {
    const card = event.target.closest("[data-scan-index]");
    const field = event.target.dataset.scanField;
    const candidate = scannedLoanCandidates[Number(card?.dataset.scanIndex)];
    if (!candidate || !field) return;
    const value = event.target.value;
    if (field === "name") candidate.name = value.trim();
    else if (field === "lender") candidate.lender = value.trim();
    else if (field === "type") candidate.type = value;
    else if (field === "original") candidate.originalAmountFils = parseMoney(value);
    else if (field === "balance") candidate.balanceFils = parseMoney(value);
    else if (field === "installment") candidate.installmentFils = parseMoney(value);
    else if (field === "start") candidate.startDate = value;
    else if (field === "end") candidate.endDate = value;
    else if (field === "rate") { const rate = parseRate(value, { min: 0, max: 100 }); candidate.annualRate = rate ?? 0; candidate.interestRateKnown = value.trim() !== "" && rate !== null; }
    else if (field === "day") candidate.dueDay = parseCount(value, { min: 1, max: 31 });
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
  $("#update-app").addEventListener("click", checkForUpdate);
  $$("[data-bank-field]").forEach((select) => select.addEventListener("change", previewBankFieldOrder));
  $("#bank-field-reset").addEventListener("click", () => {
    $$("[data-bank-field]").forEach((select, index) => { select.value = DEFAULT_FIELD_ORDER[index] ?? ""; });
    previewBankFieldOrder();
    toast("رجع الترتيب الافتراضي — اضغط حفظ لتثبيته");
  });
  $("#bank-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if ($("#more-dialog").open) closeDialog($("#more-dialog"));
    try { await importBankFile(file); } catch { toast("ما قدرت أقرأ الملف"); }
  });
  $("#bank-paste-clipboard").addEventListener("click", async () => {
    const text = await pasteBankFromClipboard();
    if (!text) { $("#bank-error").textContent = "اضغط مطولاً داخل المربع واختر «لصق»."; invalidField("#bank-text", "#bank-error"); revealBankFeedback(); return; }
    $("#bank-text").value = text; $("#bank-error").textContent = ""; renderBankPreview();
  });
  $("#bank-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const summary = ingestBankText($("#bank-text").value, { dateOverrideISO: $("#bank-date").value });
    if (!summary.total) { $("#bank-error").textContent = "الصق نص إشعار واحد على الأقل."; revealBankFeedback(); return; }
    if (!summary.queued && !summary.duplicates && !summary.ignored.length) { $("#bank-error").textContent = manualBankMessage(summary.manual[0]); revealBankFeedback(); return; }
    closeDialog($("#bank-dialog"));
    reportBankSummary(summary);
  });
  $("#bank-text").addEventListener("input", () => { $("#bank-error").textContent = ""; renderBankPreview(); });
  $("#statement-file").addEventListener("change", (event) => prepareStatementImport(event.target.files?.[0]));
  $("#statement-import-form").addEventListener("submit", submitStatementImport);
  $("#statement-possible-list").addEventListener("change", (event) => {
    const position = Number(event.target.dataset?.possibleIndex);
    if (Number.isInteger(position)) toggleStatementPossible(position, event.target.checked);
  });
  $("#statement-possible-all").addEventListener("click", () => {
    const batch = pendingStatementBatch;
    if (!batch) return;
    const positions = batch.transactions.map((item, position) => item.possibleDuplicate ? position : -1).filter((position) => position >= 0);
    const all = positions.every((position) => batch.pickedPossible.has(position));
    batch.pickedPossible = new Set(all ? [] : positions);
    renderStatementPossible(batch);
    renderStatementPreview(batch);
  });
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
    event.stopPropagation();
    const approveId = event.target.dataset.approvePending;
    const reviewId = event.target.dataset.reviewPending;
    const deletePendingId = event.target.dataset.deletePending;
    if (deletePendingId) {
      // نفس حذف قائمة العمليات: يسأل تأكيد ويعرض «تراجع»
      removeRecord("transactions", deletePendingId, "العملية");
      return;
    }
    if (event.target.dataset.approveAll) {
      const ready = state.transactions.filter((item) => !item.reviewed && !item.possibleDuplicate);
      if (!ready.length) { toast("كلها تحتاج مراجعتك — فيها عمليات قد تكون مكررة"); return; }
      const totalFils = ready.reduce((sum, item) => sum + (item.kind === "income" ? 0 : item.amountFils), 0);
      // «اعتماد الكل» يدخل مبالغ في كل الحسابات، فنقول العدد والمجموع أولاً (F31)
      if (!(await askConfirm(`نعتمد ${countLabel(ready.length, "transaction")} بمصروف ${formatMoney(totalFils)}؟ تدخل كلها في الميزانية والمتاح للصرف.`, { okLabel: "اعتمد الكل" }))) return;
      const ids = ready.map((item) => item.id);
      ready.forEach((item) => { item.reviewed = true; learnMerchant(item); });
      commit(`تم اعتماد ${countLabel(ids.length, "transaction")} · ${formatMoney(totalFils)}`, { undo: () => {
        ids.forEach((id) => { const item = state.transactions.find((row) => row.id === id); if (item) item.reviewed = false; });
        commit("رجّعتها لقائمة المراجعة");
      } });
      return;
    }
    const draftAmountId = event.target.dataset.draftAmount;
    if (draftAmountId) {
      const draft = state.bankDrafts.find((item) => item.id === draftAmountId);
      if (draft) openTransaction(null, null, draft);
      return;
    }
    const draftDeleteId = event.target.dataset.draftDelete;
    if (draftDeleteId) {
      const draft = state.bankDrafts.find((item) => item.id === draftDeleteId);
      if (!draft) return;
      state.bankDrafts = state.bankDrafts.filter((item) => item.id !== draftDeleteId);
      commit("تجاهلت الإشعار", { undo: () => { state.bankDrafts.push(draft); commit("رجّعت الإشعار"); } });
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
      commit("تم اعتماد العملية", { undo: () => { item.reviewed = false; commit("رجّعتها للمراجعة"); } });
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
    const paidButton = event.target.closest("[data-toggle-commitment-paid]");
    const paidId = paidButton?.dataset.toggleCommitmentPaid;
    if (editId) openCommitment(state.monthlyCommitments.find((item) => item.id === editId));
    if (deleteId) removeRecord("monthlyCommitments", deleteId, "الالتزام");
    if (toggleId) {
      const commitment = state.monthlyCommitments.find((item) => item.id === toggleId);
      if (commitment) {
        commitment.status = commitment.status === "paused" ? "active" : "paused";
        saveState(); renderAll(); toast(commitment.status === "active" ? "تمت إعادة تفعيل الالتزام" : "تم إيقاف الالتزام مؤقتاً");
      }
    }
    if (paidId) markCommitmentPaid(paidId, paidButton.dataset.dueDate);
  });
  $("#loan-list").addEventListener("click", (event) => {
    const editId = event.target.dataset.editLoan;
    const deleteId = event.target.dataset.deleteLoan;
    const extraId = event.target.dataset.extraPayment;
    const payId = event.target.dataset.payInstallment;
    if (editId) openLoan(state.loans.find((item) => item.id === editId));
    if (deleteId) removeRecord("loans", deleteId, "القرض");
    if (extraId) openExtraPayment(state.loans.find((item) => item.id === extraId));
    if (payId) payLoanInstallment(payId, event.target.dataset.dueDate);
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
  if (IS_NATIVE) return; // التطبيق مثبّت أصلاً: ما فيه شي نثبّته
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const card = $("#install-card");
  card.hidden = standalone || state.ui.installDismissed;
  $("#dismiss-install").addEventListener("click", () => { state.ui.installDismissed = true; saveState(); card.hidden = true; });
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); deferredInstallPrompt = event;
    $("#install-button").hidden = false;
    $("#install-copy").textContent = "اضغط تثبيت لإضافة حوّش إلى الشاشة الرئيسية.";
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
  bindEvents(); bindInboxEvents(); renderBankFieldOrder(); setupInstall(); renderAll({ investmentInputs: true }); captureFinancialSnapshot();
  if (lockRecord) lockApp();
  const linkHandled = handlePortfolioLink() || handleBankAutomationLink();
  if (!linkHandled && !lockedNow) switchView(location.hash.slice(1) || "dashboard", false);
  if (!lockRecord && !linkHandled && !state.ui.onboarded && state.settings.incomeFils === 0) setTimeout(openOnboarding, 350);
  renderStorageWarning();
  if (!storageAvailable) toast("التخزين المحلي غير متاح؛ البيانات لن تستمر بعد إغلاق الصفحة.");
  navigator.storage?.persist?.().catch(() => {});
  if (!IS_NATIVE && "serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker registration failed", error));
  }
  // نسخة الكاش وقت فتح الصفحة (إذا الصفحة خاضعة لـ service worker): نعرف بعدين لو الملفات تحدّثت والصفحة لسا قديمة
  if (updateSupported() && navigator.serviceWorker.controller) readInstalledVersion().then((version) => { startupVersion = version; });
  confirmUpdateAfterReload();
  startNative();
  syncInbox();
}

/* داخل التطبيق: نربط البصمة والتذكيرات ونعلم المستخدم لو رجّعنا بياناته من النسخة المحفوظة */
function startNative() {
  if (!native) return;
  native.start().catch((error) => console.warn("Native start failed", error));
  if (nativeRestored) toast("رجّعنا بياناتك من نسخة حفظها التطبيق على جهازك.");
}

initialize();
