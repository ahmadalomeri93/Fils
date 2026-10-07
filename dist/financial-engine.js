import { normalizeDigits, parseMoney, payoff } from "./finance-core.js";

const DAY_MS = 86_400_000;
const ACTIVE_DEBT_STATUSES = new Set(["active", "overdue"]);
const recurrenceMonths = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

export const commitmentRecurrences = Object.freeze({
  monthly: "شهري",
  quarterly: "كل 3 أشهر",
  semiannual: "كل 6 أشهر",
  annual: "سنوي",
  once: "مرة واحدة"
});

function validFils(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseISO(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function clampedDate(year, month, day) {
  const lastDay = new Date(year, month + 1, 0, 12).getDate();
  return new Date(year, month, Math.min(Math.max(day, 1), lastDay), 12);
}

export function addMonthsISO(iso, months) {
  const base = parseISO(iso);
  if (!base || !Number.isInteger(months)) return null;
  return toISO(clampedDate(base.getFullYear(), base.getMonth() + months, base.getDate()));
}

export function addDaysISO(iso, days) {
  const date = parseISO(iso);
  if (!date || !Number.isInteger(days)) return null;
  date.setDate(date.getDate() + days);
  return toISO(date);
}

export function daysBetween(fromISO, toISO) {
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to) return null;
  return Math.round((to - from) / DAY_MS);
}

export function monthBounds(todayISO) {
  const today = parseISO(todayISO);
  if (!today) return null;
  const first = new Date(today.getFullYear(), today.getMonth(), 1, 12);
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0, 12);
  return { startISO: toISO(first), endISO: toISO(last), daysInMonth: last.getDate(), dayOfMonth: today.getDate() };
}

export function nextIncomeDate(todayISO, salaryDay = 25) {
  const today = parseISO(todayISO);
  if (!today || !Number.isInteger(salaryDay) || salaryDay < 1 || salaryDay > 31) return null;
  let payday = clampedDate(today.getFullYear(), today.getMonth(), salaryDay);
  if (payday <= today) payday = clampedDate(today.getFullYear(), today.getMonth() + 1, salaryDay);
  return toISO(payday);
}

export function totalMonthlyIncome(incomes = [], legacyIncomeFils = 0) {
  const active = Array.isArray(incomes) ? incomes.filter((item) => item?.status !== "paused" && validFils(item?.amountFils)) : [];
  if (active.length) return active.reduce((sum, item) => sum + item.amountFils, 0);
  return validFils(legacyIncomeFils) ? legacyIncomeFils : 0;
}

export function monthlyCommitmentEquivalent(commitment) {
  const amount = validFils(commitment?.amountFils) ? commitment.amountFils : 0;
  if (commitment?.status === "paused" || commitment?.status === "completed") return 0;
  const divider = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }[commitment?.recurrence];
  return divider ? Math.round(amount / divider) : 0;
}

function occurrencePaid(payments, entityKey, entityId, dueDate) {
  return payments.some((payment) => payment?.[entityKey] === entityId && payment?.dueDate === dueDate && payment?.status !== "reversed");
}

export function commitmentOccurrences(commitments = [], { fromISO, toISO, payments = [], includePaused = false } = {}) {
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to || to < from) return [];
  const results = [];

  for (const commitment of commitments) {
    if (!commitment || !validFils(commitment.amountFils) || commitment.amountFils === 0) continue;
    if (!includePaused && commitment.status !== "active") continue;
    const anchor = parseISO(commitment.dueDate);
    if (!anchor) continue;
    if (commitment.recurrence === "once") {
      if (anchor >= from && anchor <= to) {
        const dueDate = toISODate(anchor);
        results.push({ ...commitment, commitmentId: commitment.id, dueDate, paid: occurrencePaid(payments, "commitmentId", commitment.id, dueDate) });
      }
      continue;
    }
    const interval = recurrenceMonths[commitment.recurrence];
    if (!interval) continue;
    for (let offset = 0; offset <= 1200; offset += interval) {
      const dueDate = addMonthsISO(commitment.dueDate, offset);
      const due = parseISO(dueDate);
      if (!due) break;
      if (due > to) break;
      if (due < from) continue;
      results.push({ ...commitment, commitmentId: commitment.id, dueDate, paid: occurrencePaid(payments, "commitmentId", commitment.id, dueDate) });
    }
  }
  return results.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function toISODate(date) {
  return toISO(date);
}

export function commitmentSummary(commitments = [], payments = [], todayISO) {
  const bounds = monthBounds(todayISO);
  if (!bounds) return null;
  const occurrences = commitmentOccurrences(commitments, { fromISO: bounds.startISO, toISO: bounds.endISO, payments });
  const upcoming = commitmentOccurrences(commitments, { fromISO: todayISO, toISO: addDaysISO(todayISO, 366), payments })
    .filter((item) => !item.paid);
  const monthlyEquivalentFils = commitments.reduce((sum, item) => sum + monthlyCommitmentEquivalent(item), 0);
  return {
    monthlyEquivalentFils,
    dueThisMonthFils: occurrences.reduce((sum, item) => sum + item.amountFils, 0),
    paidThisMonthFils: occurrences.filter((item) => item.paid).reduce((sum, item) => sum + item.amountFils, 0),
    remainingThisMonthFils: occurrences.filter((item) => !item.paid).reduce((sum, item) => sum + item.amountFils, 0),
    dueThisMonth: occurrences,
    nextUpcoming: upcoming[0] ?? null
  };
}

function debtDueDateForMonth(debt, year, month) {
  return clampedDate(year, month, Number.isInteger(debt?.dueDay) ? debt.dueDay : 1);
}

export function debtOccurrences(debts = [], { fromISO, toISO, payments = [] } = {}) {
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  if (!from || !to || to < from) return [];
  const results = [];
  for (const debt of debts) {
    if (!debt || !ACTIVE_DEBT_STATUSES.has(debt.status ?? "active") || !validFils(debt.installmentFils) || debt.installmentFils === 0) continue;
    const start = parseISO(debt.startDate);
    const end = parseISO(debt.endDate);
    for (let monthOffset = 0; monthOffset <= 1200; monthOffset += 1) {
      const due = debtDueDateForMonth(debt, from.getFullYear(), from.getMonth() + monthOffset);
      if (due > to) break;
      if (due < from || (start && due < start) || (end && due > end)) continue;
      const dueDate = toISODate(due);
      const paid = occurrencePaid(payments, "debtId", debt.id, dueDate);
      results.push({ ...debt, debtId: debt.id, dueDate, paid });
    }
  }
  return results.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function remainingInstallments(debt) {
  if (!debt || debt.status === "completed" || debt.balanceFils === 0) return 0;
  if (Number.isInteger(debt.remainingInstallments) && debt.remainingInstallments >= 0) return debt.remainingInstallments;
  const result = payoff({
    balanceFils: debt.balanceFils,
    installmentFils: debt.installmentFils,
    annualRate: Number.isFinite(debt.annualRate) ? debt.annualRate : 0
  });
  return result?.months ?? null;
}

export function debtProgress(debt) {
  const original = validFils(debt?.originalAmountFils) && debt.originalAmountFils > 0
    ? debt.originalAmountFils
    : Math.max((debt?.balanceFils ?? 0) + (debt?.totalPaidFils ?? 0), debt?.balanceFils ?? 0);
  const remaining = validFils(debt?.balanceFils) ? debt.balanceFils : 0;
  const paidFromBalance = Math.max(original - remaining, 0);
  const paidFils = Math.max(validFils(debt?.totalPaidFils) ? debt.totalPaidFils : 0, paidFromBalance);
  const percent = original > 0 ? Math.min(Math.round((paidFils / original) * 100), 100) : 0;
  return { originalAmountFils: original, paidFils, percent };
}

export function debtSummary(debts = [], { incomeFils = 0, todayISO, payments = [] } = {}) {
  const considered = debts.filter((debt) => debt?.status !== "completed" && debt?.status !== "stopped");
  const active = debts.filter((debt) => ACTIVE_DEBT_STATUSES.has(debt?.status ?? "active"));
  const totalBalanceFils = considered.reduce((sum, debt) => sum + (validFils(debt.balanceFils) ? debt.balanceFils : 0), 0);
  const monthlyPaymentsFils = active.reduce((sum, debt) => sum + (validFils(debt.installmentFils) ? debt.installmentFils : 0), 0);
  const upcoming = debtOccurrences(active, { fromISO: todayISO, toISO: addDaysISO(todayISO, 62), payments }).filter((item) => !item.paid);
  let longestMonths = 0;
  let payoffKnown = true;
  for (const debt of active) {
    const months = remainingInstallments(debt);
    if (months === null) payoffKnown = false;
    else longestMonths = Math.max(longestMonths, months);
  }
  return {
    totalBalanceFils,
    monthlyPaymentsFils,
    activeCount: active.length,
    nextPayment: upcoming[0] ?? null,
    dtiPercent: incomeFils > 0 ? (monthlyPaymentsFils / incomeFils) * 100 : null,
    zeroDebtDate: payoffKnown && active.length ? addMonthsISO(todayISO, longestMonths) : active.length ? null : todayISO
  };
}

export function simulateExtraPayment(debt, extraFils, todayISO) {
  if (!debt || !validFils(extraFils) || extraFils <= 0 || !validFils(debt.balanceFils) || !validFils(debt.installmentFils) || debt.installmentFils === 0) return null;
  const beforeBalanceFils = debt.balanceFils;
  const appliedFils = Math.min(extraFils, beforeBalanceFils);
  const afterBalanceFils = beforeBalanceFils - appliedFils;
  const annualRate = Number.isFinite(debt.annualRate) ? debt.annualRate : 0;
  const current = payoff({ balanceFils: beforeBalanceFils, installmentFils: debt.installmentFils, annualRate });
  const next = payoff({ balanceFils: afterBalanceFils, installmentFils: debt.installmentFils, annualRate });
  if (!current || !next) return null;
  const currentMonths = remainingInstallments(debt) ?? current.months;
  return {
    beforeBalanceFils,
    afterBalanceFils,
    appliedFils,
    currentMonths,
    expectedMonths: next.months,
    monthsShortened: Math.max(currentMonths - next.months, 0),
    currentEndDate: debt.endDate || addMonthsISO(todayISO, currentMonths),
    expectedEndDate: addMonthsISO(todayISO, next.months),
    balanceDifferenceFils: appliedFils,
    estimatedChargeSavingsFils: annualRate > 0 && debt.interestRateKnown === true ? Math.max(current.chargesFils - next.chargesFils, 0) : null
  };
}

export function safeToSpendEngine({
  availableCashFils = 0,
  safetyBufferFils = 0,
  reservedCreditCardFils = 0,
  creditCards = [],
  debts = [],
  debtPayments = [],
  commitments = [],
  commitmentPayments = [],
  salaryDay = 25,
  todayISO
} = {}) {
  const paydayISO = nextIncomeDate(todayISO, salaryDay);
  if (!paydayISO) return null;
  const debtDue = debtOccurrences(debts, { fromISO: todayISO, toISO: paydayISO, payments: debtPayments }).filter((item) => !item.paid);
  const commitmentDue = commitmentOccurrences(commitments, { fromISO: todayISO, toISO: paydayISO, payments: commitmentPayments }).filter((item) => !item.paid);
  const cardReserve = creditCards.length
    ? creditCards.filter((card) => card?.status !== "paused").reduce((sum, card) => sum + (validFils(card.reservedPaymentFils) ? card.reservedPaymentFils : 0), 0)
    : (validFils(reservedCreditCardFils) ? reservedCreditCardFils : 0);
  const upcomingDebtPaymentsFils = debtDue.reduce((sum, item) => sum + item.installmentFils, 0);
  const upcomingCommitmentsFils = commitmentDue.reduce((sum, item) => sum + item.amountFils, 0);
  const committedFils = upcomingDebtPaymentsFils + upcomingCommitmentsFils + cardReserve + Math.max(safetyBufferFils, 0);
  const rawSafeFils = Math.max(availableCashFils, 0) - committedFils;
  const untilPayday = Math.max(daysBetween(todayISO, paydayISO) ?? 0, 1);
  const safeFils = Math.max(rawSafeFils, 0);
  return {
    paydayISO,
    daysUntilPayday: untilPayday,
    upcomingDebtPaymentsFils,
    upcomingCommitmentsFils,
    reservedCreditCardFils: cardReserve,
    safetyBufferFils: Math.max(safetyBufferFils, 0),
    committedFils,
    safeFils,
    shortfallFils: Math.max(-rawSafeFils, 0),
    dailySafeFils: Math.floor(safeFils / untilPayday),
    debtDue,
    commitmentDue
  };
}

function reviewedExpenses(transactions = []) {
  return transactions.filter((item) => item?.kind === "expense" && item?.reviewed !== false && validFils(item?.amountFils));
}

export function endOfMonthForecast({
  availableCashFils = 0,
  transactions = [],
  debts = [],
  debtPayments = [],
  commitments = [],
  commitmentPayments = [],
  reservedCreditCardFils = 0,
  todayISO
} = {}) {
  const bounds = monthBounds(todayISO);
  if (!bounds) return null;
  const expenses = reviewedExpenses(transactions).filter((item) => item.date >= bounds.startISO && item.date <= todayISO && item.category !== "قسط");
  const actualSpentFils = expenses.reduce((sum, item) => sum + item.amountFils, 0);
  const distinctDays = new Set(expenses.map((item) => item.date)).size;
  if (expenses.length < 3 || distinctDays < 2 || bounds.dayOfMonth < 3) {
    return { sufficient: false, reason: "نحتاج مصروفات معتمدة من يومين مختلفين على الأقل قبل بناء توقع موثوق.", actualSpentFils };
  }
  const averageDailyFils = Math.round(actualSpentFils / bounds.dayOfMonth);
  const daysRemaining = Math.max(bounds.daysInMonth - bounds.dayOfMonth, 0);
  const projectedSpendingFils = averageDailyFils * daysRemaining;
  const debtDue = debtOccurrences(debts, { fromISO: addDaysISO(todayISO, 1), toISO: bounds.endISO, payments: debtPayments }).filter((item) => !item.paid);
  const commitmentDue = commitmentOccurrences(commitments, { fromISO: addDaysISO(todayISO, 1), toISO: bounds.endISO, payments: commitmentPayments }).filter((item) => !item.paid);
  const upcomingDebtFils = debtDue.reduce((sum, item) => sum + item.installmentFils, 0);
  const upcomingCommitmentsFils = commitmentDue.reduce((sum, item) => sum + item.amountFils, 0);
  const forecastAvailableFils = availableCashFils - projectedSpendingFils - upcomingDebtFils - upcomingCommitmentsFils - Math.max(reservedCreditCardFils, 0);
  return {
    sufficient: true,
    actualSpentFils,
    averageDailyFils,
    daysRemaining,
    projectedSpendingFils,
    upcomingDebtFils,
    upcomingCommitmentsFils,
    forecastAvailableFils,
    label: "تقديري"
  };
}

export function spendingComparison(transactions = [], todayISO) {
  const today = parseISO(todayISO);
  if (!today) return null;
  const currentStart = toISO(new Date(today.getFullYear(), today.getMonth(), 1, 12));
  const previousStart = toISO(new Date(today.getFullYear(), today.getMonth() - 1, 1, 12));
  const previousEnd = toISO(clampedDate(today.getFullYear(), today.getMonth() - 1, today.getDate()));
  const expenses = reviewedExpenses(transactions);
  const currentFils = expenses.filter((item) => item.date >= currentStart && item.date <= todayISO).reduce((sum, item) => sum + item.amountFils, 0);
  const previousFils = expenses.filter((item) => item.date >= previousStart && item.date <= previousEnd).reduce((sum, item) => sum + item.amountFils, 0);
  return { currentFils, previousFils, differenceFils: currentFils - previousFils, percent: previousFils > 0 ? ((currentFils - previousFils) / previousFils) * 100 : null };
}

export function financialFlow({ incomeFils = 0, debtPaymentsFils = 0, commitmentFils = 0, expensesFils = 0 } = {}) {
  const availableFils = Math.max(incomeFils - debtPaymentsFils - commitmentFils - expensesFils, 0);
  return { incomeFils, debtPaymentsFils, commitmentFils, expensesFils, availableFils };
}

/** A cautious, deterministic starting allocation; the caller must provide a reviewed living-cost baseline. */
export function createAdvisorAllocation({
  incomeFils = 0, debtInstallmentsFils = 0, commitmentsFils = 0, livingCostFils = 0,
  cashFils = 0, totalDebtFils = 0, overdue = false, baselineReady = true
} = {}) {
  const safe = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const income = safe(incomeFils);
  const installments = safe(debtInstallmentsFils);
  const commitments = safe(commitmentsFils);
  const living = safe(livingCostFils);
  const cash = safe(cashFils);
  const debt = safe(totalDebtFils);
  const essentialMonthlyFils = installments + commitments + living;
  const surplusFils = income - essentialMonthlyFils;
  const emergencyTargetFils = essentialMonthlyFils * 3;
  const minimumReserveFils = essentialMonthlyFils;
  const result = {
    baselineReady: baselineReady && living > 0,
    incomeFils: income, debtInstallmentsFils: installments, commitmentsFils: commitments,
    livingCostFils: living, essentialMonthlyFils, surplusFils,
    deficitFils: Math.max(-surplusFils, 0), cashFils: cash,
    minimumReserveFils, emergencyTargetFils,
    reserveGapFils: Math.max(emergencyTargetFils - cash, 0),
    reserveAllocationFils: 0, extraDebtFils: 0, investmentFils: 0,
    phase: "needs_data"
  };
  if (!result.baselineReady) return result;
  if (surplusFils <= 0) {
    result.phase = "deficit";
    return result;
  }
  if (overdue && debt > 0) {
    result.phase = "overdue";
    result.extraDebtFils = surplusFils;
    return result;
  }
  if (cash < minimumReserveFils) {
    result.phase = "build_minimum_reserve";
    const minimumReserveGap = Math.max(minimumReserveFils - cash, 0);
    result.reserveAllocationFils = debt > 0 ? Math.min(minimumReserveGap, Math.round(surplusFils * 0.7)) : Math.min(minimumReserveGap, surplusFils);
    const remaining = surplusFils - result.reserveAllocationFils;
    result.extraDebtFils = debt > 0 ? remaining : 0;
    result.investmentFils = debt > 0 ? 0 : remaining;
    return result;
  }
  if (cash < emergencyTargetFils) {
    result.phase = "build_emergency_reserve";
    result.reserveAllocationFils = Math.min(result.reserveGapFils, Math.round(surplusFils * 0.1));
  }
  const afterReserve = surplusFils - result.reserveAllocationFils;
  if (debt > 0) {
    result.extraDebtFils = Math.round(afterReserve * 0.75);
    result.investmentFils = afterReserve - result.extraDebtFils;
  } else {
    result.investmentFils = afterReserve;
  }
  if (result.phase === "needs_data") result.phase = debt > 0 ? "debt_and_invest" : "invest_after_debt";
  return result;
}

function alertId(key) {
  return `alert-${String(key).replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 120)}`;
}

export function generateFinancialAlerts({
  todayISO,
  debts = [],
  debtPayments = [],
  commitments = [],
  commitmentPayments = [],
  transactions = [],
  budgetFils = 0,
  forecast = null
} = {}) {
  const weekEnd = addDaysISO(todayISO, 7);
  const alerts = [];
  const debtDue = debtOccurrences(debts, { fromISO: todayISO, toISO: weekEnd, payments: debtPayments }).filter((item) => !item.paid);
  debtDue.forEach((item) => {
    const days = daysBetween(todayISO, item.dueDate);
    alerts.push({ key: `debt:${item.debtId}:${item.dueDate}`, type: "debt_due", severity: days <= 2 ? "warning" : "info", title: `قسط قريب: ${item.name}`, message: `موعده بعد ${days} يوم.`, amountFils: item.installmentFils, dueDate: item.dueDate });
  });
  const commitmentDue = commitmentOccurrences(commitments, { fromISO: todayISO, toISO: weekEnd, payments: commitmentPayments }).filter((item) => !item.paid);
  if (commitmentDue.length) {
    const amountFils = commitmentDue.reduce((sum, item) => sum + item.amountFils, 0);
    const key = `commitments:${commitmentDue.map((item) => `${item.commitmentId}-${item.dueDate}`).join("|")}`;
    alerts.push({ key, type: "commitments_due", severity: "info", title: "التزامات هذا الأسبوع", message: `عندك ${commitmentDue.length} التزام خلال 7 أيام.`, amountFils, dueDate: commitmentDue[0].dueDate });
  }
  const bounds = monthBounds(todayISO);
  const monthSpent = bounds ? reviewedExpenses(transactions).filter((item) => item.date >= bounds.startISO && item.date <= todayISO).reduce((sum, item) => sum + item.amountFils, 0) : 0;
  if (budgetFils > 0 && monthSpent / budgetFils >= .8) {
    alerts.push({ key: `${bounds?.startISO}:budget-80`, type: "budget", severity: monthSpent > budgetFils ? "danger" : "warning", title: "ميزانية الشهر", message: `استخدمت ${Math.round(monthSpent / budgetFils * 100)}٪ من ميزانيتك.`, amountFils: monthSpent });
  }
  if (forecast?.sufficient && forecast.forecastAvailableFils < 0) {
    alerts.push({ key: `${bounds?.startISO}:forecast-shortfall`, type: "forecast", severity: "danger", title: "تنبيه مسار الصرف", message: "حسب معدل صرفك الحالي قد ينفد المتاح قبل نهاية الشهر.", amountFils: Math.abs(forecast.forecastAvailableFils) });
  }
  const comparison = spendingComparison(transactions, todayISO);
  if (comparison?.previousFils > 0 && Math.abs(comparison.percent) >= 10) {
    alerts.push({ key: `${bounds?.startISO}:spending-trend`, type: "trend", severity: comparison.differenceFils > 0 ? "warning" : "positive", title: "مقارنة الصرف", message: comparison.differenceFils > 0 ? "صرفك أعلى من نفس الفترة بالشهر الماضي." : "صرفك أقل من نفس الفترة بالشهر الماضي.", amountFils: Math.abs(comparison.differenceFils) });
  }
  return alerts;
}

export function mergeFinancialAlerts(existing = [], candidates = [], nowISO, cooldownDays = 7) {
  const now = parseISO(nowISO);
  if (!now) return existing;
  const byKey = new Map(existing.map((alert) => [alert.key, { ...alert }]));
  const activeKeys = new Set(candidates.map((candidate) => candidate.key));
  for (const candidate of candidates) {
    const prior = byKey.get(candidate.key);
    if (prior?.dismissedAt) {
      const cooldownUntil = parseISO(prior.cooldownUntil);
      if (cooldownUntil && cooldownUntil > now) continue;
    }
    byKey.set(candidate.key, {
      ...prior,
      ...candidate,
      id: prior?.id ?? alertId(candidate.key),
      createdAt: prior?.createdAt ?? new Date(`${nowISO}T12:00:00`).toISOString(),
      updatedAt: new Date(`${nowISO}T12:00:00`).toISOString(),
      dismissedAt: null,
      cooldownUntil: null,
      active: true
    });
  }
  for (const [key, alert] of byKey) {
    if (!activeKeys.has(key)) byKey.set(key, { ...alert, active: false });
  }
  return [...byKey.values()]
    .map((alert) => alert.dismissedAt && !alert.cooldownUntil ? { ...alert, cooldownUntil: addDaysISO(nowISO, cooldownDays) } : alert)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, 100);
}

function topSpendingCategory(transactions, todayISO) {
  const bounds = monthBounds(todayISO);
  if (!bounds) return null;
  const map = new Map();
  reviewedExpenses(transactions).filter((item) => item.date >= bounds.startISO && item.date <= todayISO)
    .forEach((item) => map.set(item.category, (map.get(item.category) ?? 0) + item.amountFils));
  return [...map.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
}

export function answerFinancialQuestion(question, context) {
  const text = normalizeDigits(String(question ?? "")).trim().toLowerCase();
  if (!text) return null;
  const actual = (title, message, details = []) => ({ kind: "actual", label: "فعلي", title, message, details });
  const estimate = (title, message, details = []) => ({ kind: "forecast", label: "تقديري", title, message, details });
  const recommendation = (title, message, details = []) => ({ kind: "recommendation", label: "توصية", title, message, details });
  const format = context.formatMoney;
  const safe = context.safe;
  const debts = context.debts;
  const commitments = context.commitments;

  if (/كم.*(?:أصرف|اصرف).*اليوم|ميزاني.*اليوم/.test(text)) {
    return actual("ميزانيتك الآمنة اليوم", format(safe?.dailySafeFils ?? 0), [`المتاح حتى الدخل القادم: ${format(safe?.safeFils ?? 0)}`, `الأيام المتبقية: ${safe?.daysUntilPayday ?? 0}`]);
  }
  if (/كم.*(?:باقي|المتبقي).*(?:راتب|معاش)|كم باقي لي/.test(text)) {
    return actual("المتاح حتى الراتب", format(safe?.safeFils ?? 0), [`الرصيد الحالي: ${format(context.availableCashFils)}`, `المحجوز للالتزامات: ${format(safe?.committedFils ?? 0)}`]);
  }
  if (/(?:هذا|هال).*(?:أسبوع|اسبوع)|شنو علي.*أسبوع/.test(text)) {
    const due = context.weekDue;
    return actual("المستحق خلال 7 أيام", format(due.totalFils), [`${due.debtCount} قسط`, `${due.commitmentCount} التزام ثابت`]);
  }
  if (/(?:هذا|هال).*(?:شهر)|شنو علي.*شهر/.test(text)) {
    return actual("المتبقي عليك هذا الشهر", format(context.monthDueFils), [`أقساط والتزامات غير مدفوعة حتى نهاية الشهر`]);
  }
  if (/متى.*(?:أخلص|اخلص).*(?:دين|قرض)|صفر ديون/.test(text)) {
    return debts.zeroDebtDate
      ? estimate("الوصول المتوقع لصفر ديون", context.formatDate(debts.zeroDebtDate), ["الحساب يفترض استمرار الأقساط الحالية دون تعثر أو رسوم جديدة."])
      : estimate("موعد السداد غير متاح", "نحتاج رصيداً وقسطاً صحيحين لكل قرض لحساب الموعد.");
  }
  if (/أي.*قرض.*(?:أول|يخلص)|اي قرض/.test(text)) {
    const first = context.firstDebt;
    return first ? estimate("أول قرض متوقع يخلص", first.name, [`بعد نحو ${first.months} شهر`]) : actual("ما عندك قرض نشط", "ما توجد بيانات قرض نشط حالياً.");
  }
  if (/إذا.*دفعت|اذا.*دفعت|دفعة.*زيادة/.test(text)) {
    const amountMatch = text.match(/(\d[\d,]*(?:\.\d{1,3})?)/);
    const extraFils = amountMatch ? parseMoney(amountMatch[1]) : null;
    const debt = context.largestDebt;
    const simulation = debt && extraFils ? simulateExtraPayment(debt, extraFils, context.todayISO) : null;
    return simulation
      ? estimate(`محاكاة دفعة على ${debt.name}`, `تختصر تقريباً ${simulation.monthsShortened} شهر`, [`الرصيد بعدها: ${format(simulation.afterBalanceFils)}`, `النهاية المتوقعة: ${context.formatDate(simulation.expectedEndDate)}`])
      : recommendation("حدد مبلغ الدفعة", "اكتب مثال: إذا دفعت 500 د.ك زيادة شنو يصير؟");
  }
  if (/أعلى.*الشهر.*طاف|مقارن.*الشهر|صرفي.*الشهر/.test(text)) {
    const comparison = context.comparison;
    if (!comparison || comparison.previousFils === 0) return actual("المقارنة غير متاحة", "ما عندنا بيانات كافية من الشهر الماضي.");
    return actual("مقارنة الصرف", comparison.differenceFils > 0 ? `صرفك أعلى بـ ${format(comparison.differenceFils)}` : `صرفك أقل بـ ${format(Math.abs(comparison.differenceFils))}`, ["المقارنة حتى نفس يوم الشهر."]);
  }
  if (/وين.*(?:أكثر|اكثر).*صرف|أكثر شي.*أصرف|اكثر شي/.test(text)) {
    const top = topSpendingCategory(context.transactions, context.todayISO);
    return top ? actual("أعلى فئة هذا الشهر", top[0], [format(top[1])]) : actual("ما عندنا بيانات كافية", "أضف أو اعتمد مصروفاتك أولاً.");
  }
  if (/كم.*(?:أوفر|اوفر)|نهاية الشهر|استمر.*الصرف/.test(text)) {
    return context.forecast?.sufficient
      ? estimate("المتاح المتوقع بنهاية الشهر", format(context.forecast.forecastAvailableFils), [`متوسط الصرف اليومي: ${format(context.forecast.averageDailyFils)}`])
      : estimate("التوقع غير جاهز", context.forecast?.reason ?? "ما عندنا بيانات كافية.");
  }
  if (/التزام.*قريب|شي.*قريب/.test(text)) {
    const next = commitments?.nextUpcoming;
    return next ? actual("أقرب التزام", `${next.name} — ${format(next.amountFils)}`, [context.formatDate(next.dueDate)]) : actual("ما عندك التزام قريب", "لا توجد التزامات نشطة مسجلة.");
  }
  if (/خطة.*الشهر|سو.*خطة/.test(text)) {
    return recommendation("خطة هذا الشهر", `خل سقف صرفك اليومي ${format(safe?.dailySafeFils ?? 0)}`, [`احتفظ باحتياطي ${format(safe?.safetyBufferFils ?? 0)}`, `راجع ${context.alertCount} تنبيه مالي`]);
  }
  return recommendation("أقدر أحسبها لك", "جرّب تسأل عن المتاح اليوم، التزامات الأسبوع، موعد انتهاء الديون، أو توقع نهاية الشهر.");
}
