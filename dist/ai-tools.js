// أدوات «المحاسب الذكي» التي تنفذ داخل التطبيق: دوال نقية تاخذ state وترجع نتيجة، بدون DOM وبدون شبكة.
// - أدوات القراءة: ترجع JSON محسوب بدوال التطبيق نفسها (المبالغ فلوس صحيحة + نص جاهز "display").
// - أدوات الاقتراح: ما تغيّر شيئاً. تبني «اقتراحاً» بمعاينة، والتغيير الفعلي يصير فقط في applyProposal بعد ضغط المستخدم «تنفيذ».
// - سجل التراجع: كل تنفيذ يرجع قيد فيه قيم ما قبل/بعد للحقول اللي لمسها فقط، والتراجع يرفض إذا تغير السجل بعدها.
// ما تغيّر الدوال هنا أي شي إلا داخل applyProposal/undoEntry، والتطبيق يلف النتيجة بـcommit().
import { categories, cutText, formatMoney, merchantKey, normalizeDigits, parseMoney } from "./finance-core.js";
import {
  INSTALLMENT_CATEGORY, addDaysISO, addMonthsISO, cashDeduction, commitmentOccurrences, commitmentRecurrences,
  commitmentSummary, debtOccurrences, debtSummary, endOfMonthForecast, livingBaseline, monthBounds,
  monthlyCommitmentEquivalent, monthlySurplus, paymentCashDeductedFils, remainingInstallments,
  safeToSpendEngine, sameDueMonth, totalMonthlyIncome
} from "./financial-engine.js";
import { EXPENSE_CATEGORIES, budgetReport, daysInMonth, monthKeyOf, shiftMonth, spendByCategory } from "./spending.js";
import {
  AI_EXPENSE_CATEGORIES, AI_INCOME_CATEGORIES, AI_OBLIGATION_CATEGORIES, AI_PAYMENT_METHODS, AI_READ_TOOL_NAMES, AI_RECURRENCES,
  AI_TOOL_NAMES, AI_WRITE_TOOL_NAMES
} from "./ai-tool-schemas.js";

export const MAX_RESULT_CHARS = 45_000;
const MIN_DATE = "2000-01-01";
const PAYMENT_METHOD_LABELS = { bank: "خصم من الحساب", credit_card: "بطاقة ائتمان", cash: "نقدي", other: "أخرى" };
const BIDI_AND_CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g;

/* ---------- أدوات صغيرة ---------- */
export function validISO(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
// نص قادم من بيانات المستخدم أو من النموذج: سطر واحد، بلا محارف تحكم، بطول محدد. (غير موثوق دائماً)
export function cleanText(value, max = 80) {
  return cutText(String(value ?? "").replace(BIDI_AND_CONTROL, " ").replace(/\s+/g, " ").trim(), max);
}
const money = (fils) => ({ fils, display: formatMoney(fils) });
const fail = (error, message) => ({ ok: false, error, message });
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isRefund = (item) => item.kind === "income" && /^استرداد/.test(item.merchant ?? "");
const reviewedRows = (state) => state.transactions.filter((item) => item?.reviewed !== false);
const onlyKeys = (input, allowed) => Object.keys(input).find((key) => !allowed.includes(key));
const toLocalISO = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const pad2 = (n) => String(n).padStart(2, "0");

function checkInput(input, allowed, required = []) {
  if (input === undefined || input === null) input = {};
  if (!isPlainObject(input)) return fail("bad_input", "المدخلات لازم تكون كائناً");
  const extra = onlyKeys(input, allowed);
  if (extra) return fail("bad_input", `حقل غير معروف: ${cleanText(extra, 30)}`);
  const missing = required.find((key) => input[key] === undefined || input[key] === null || input[key] === "");
  if (missing) return fail("bad_input", `الحقل المطلوب ناقص: ${missing}`);
  return { ok: true, input };
}

function parseAmount(value, { allowZero = false } = {}) {
  if (typeof value !== "string" && typeof value !== "number") return { error: "المبلغ لازم يكون نصاً بالدينار مثل 12.500" };
  const text = String(value).trim();
  if (!/^[\d٠-٩۰-۹]+(?:[.,٫][\d٠-٩۰-۹]{1,3})?$/.test(text)) return { error: "المبلغ بالدينار وبثلاث خانات بعد الفاصلة كحد أقصى، مثل 12.500" };
  const fils = parseMoney(text);
  if (fils === null) return { error: "المبلغ غير مفهوم أو كبير جداً" };
  if (fils === 0 && !allowZero) return { error: "المبلغ لازم يكون أكبر من صفر" };
  return { fils };
}

function lockedResult(ctx) {
  return ctx.isLocked?.() ? fail("locked", "التطبيق مقفل") : null;
}

/* ---------- حجم النتيجة: نقلّص الصفوف بدل ما نقص JSON من النص ---------- */
export function fitResult(result, maxChars = MAX_RESULT_CHARS) {
  let text = JSON.stringify(result);
  if (text.length <= maxChars) return { result, text };
  const copy = { ...result };
  const key = Array.isArray(copy.rows) ? "rows" : Array.isArray(copy.groups) ? "groups" : Array.isArray(copy.items) ? "items" : null;
  if (!key) return { result: { truncated: true, note: "النتيجة كبيرة" }, text: JSON.stringify({ truncated: true, note: "النتيجة كبيرة" }) };
  let rows = copy[key];
  while (rows.length > 1 && text.length > maxChars) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
    copy[key] = rows;
    copy.truncated = true;
    copy.returned = rows.length;
    text = JSON.stringify(copy);
  }
  return { result: copy, text };
}

/* ======================= أدوات القراءة ======================= */
function transactionRow(item) {
  return {
    id: item.id, date: item.date, ...(item.time ? { time: item.time } : {}), kind: item.kind,
    amount: money(item.amountFils), category: item.category, merchant: cleanText(item.merchant, 80)
  };
}

function toolOverview(ctx) {
  const { state, todayISO } = ctx;
  const key = monthKeyOf(todayISO);
  const bounds = monthBounds(todayISO);
  const spent = [...spendByCategory(state.transactions, key).values()].reduce((sum, row) => sum + row.totalFils, 0);
  const received = reviewedRows(state).filter((item) => item.kind === "income" && !isRefund(item) && monthKeyOf(item.date) === key)
    .reduce((sum, item) => sum + item.amountFils, 0);
  const report = budgetReport({ transactions: state.transactions, budgets: state.categoryBudgets, todayISO, key });
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const debts = debtSummary(state.loans, { incomeFils, todayISO, payments: state.debtPayments });
  const horizon = addDaysISO(todayISO, 14);
  const upcoming = [
    ...commitmentOccurrences(state.monthlyCommitments, { fromISO: bounds.startISO, toISO: horizon, payments: state.commitmentPayments })
      .filter((item) => !item.paid).map((item) => ({ type: "obligation", id: item.commitmentId, name: cleanText(item.name, 60), dueDate: item.dueDate, amount: money(item.amountFils), ...(item.partialPaidFils ? { partiallyPaid: true, note: "المبلغ هو الباقي بعد دفعة جزئية" } : {}) })),
    ...debtOccurrences(state.loans.filter((loan) => ["active", "overdue"].includes(loan.status)), { fromISO: bounds.startISO, toISO: horizon, payments: state.debtPayments })
      .filter((item) => !item.paid).map((item) => ({ type: "debt_installment", id: item.debtId ?? item.id, name: cleanText(item.name, 60), dueDate: item.dueDate, amount: money(item.installmentFils) }))
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 15);
  return {
    today: todayISO, month: key, daysLeftInMonth: Math.max(bounds.daysInMonth - bounds.dayOfMonth, 0),
    cashBalance: money(state.settings.cashFils),
    plannedMonthlyIncome: money(incomeFils),
    incomeReceivedThisMonth: money(received),
    spentThisMonth: { ...money(spent), basis: "كل المصروفات المراجعة هذا الشهر بما فيها فئة القسط بعد خصم المبالغ المستردة (نفس رقم صفحة المصروف)" },
    budgets: {
      categoriesWithBudget: report.rows.filter((row) => row.budgetFils > 0).length,
      over: report.rows.filter((row) => row.status === "over").length,
      atRisk: report.rows.filter((row) => row.status === "risk").length,
      spendingWithoutBudget: report.rows.filter((row) => row.status === "unbudgeted").length
    },
    upcomingIn14Days: upcoming,
    totalDebtRemaining: money(debts.totalBalanceFils),
    monthlyDebtInstallments: money(debts.monthlyPaymentsFils),
    unreviewedTransactions: state.transactions.filter((item) => item?.reviewed === false).length
  };
}

function toolListTransactions(input, ctx) {
  const checked = checkInput(input, ["from", "to", "category", "kind", "search", "limit"]);
  if (!checked.ok) return checked;
  const { from, to, category, kind, search } = checked.input;
  if (from !== undefined && !validISO(from)) return fail("bad_input", "from لازم يكون تاريخاً YYYY-MM-DD");
  if (to !== undefined && !validISO(to)) return fail("bad_input", "to لازم يكون تاريخاً YYYY-MM-DD");
  if (kind !== undefined && !["expense", "income"].includes(kind)) return fail("bad_input", "kind إما expense أو income");
  if (category !== undefined && !categories.includes(category)) return fail("bad_input", `الفئة غير معروفة. المتاح: ${categories.join("، ")}`);
  const limit = checked.input.limit === undefined ? 30 : Number(checked.input.limit);
  if (!Number.isInteger(limit) || limit < 1) return fail("bad_input", "limit رقم صحيح موجب");
  const needle = search === undefined ? "" : normalizeDigits(cleanText(search, 60)).toLowerCase();
  const matched = reviewedRows(ctx.state).filter((item) =>
    (!from || item.date >= from) && (!to || item.date <= to) && (!category || item.category === category) && (!kind || item.kind === kind) &&
    (!needle || normalizeDigits(item.merchant).toLowerCase().includes(needle)));
  matched.sort((a, b) => b.date.localeCompare(a.date) || String(b.time ?? "").localeCompare(String(a.time ?? "")) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const expenseTotal = matched.filter((item) => item.kind === "expense").reduce((sum, item) => sum + item.amountFils, 0);
  const incomeTotal = matched.filter((item) => item.kind === "income").reduce((sum, item) => sum + item.amountFils, 0);
  const rows = matched.slice(0, Math.min(limit, 60)).map(transactionRow);
  return {
    matched: matched.length, returned: rows.length, truncated: matched.length > rows.length,
    totalsOfAllMatched: { expenses: money(expenseTotal), income: money(incomeTotal) },
    rows
  };
}

function toolListBudgets(ctx) {
  const { state, todayISO } = ctx;
  const key = monthKeyOf(todayISO);
  const report = budgetReport({ transactions: state.transactions, budgets: state.categoryBudgets, todayISO, key });
  return {
    month: key,
    categoriesAcceptingBudget: EXPENSE_CATEGORIES,
    overallMonthlyBudget: state.settings.budgetFils > 0 ? money(state.settings.budgetFils) : null,
    rows: report.rows.map((row) => ({
      category: row.category,
      budget: row.budgetFils > 0 ? money(row.budgetFils) : null,
      spentThisMonth: money(row.actualFils),
      remaining: row.budgetFils > 0 ? money(row.budgetFils - row.actualFils) : null,
      status: row.status
    })),
    totals: { budgets: money(report.budgetTotalFils), spent: money(report.actualTotalFils) }
  };
}

function obligationOccurrences(commitment, state, todayISO) {
  const bounds = monthBounds(todayISO);
  const inMonth = commitmentOccurrences([commitment], { fromISO: bounds.startISO, toISO: bounds.endISO, payments: state.commitmentPayments, includePaused: true });
  const current = inMonth.find((item) => !item.paid) ?? inMonth[0] ?? null;
  const next = commitmentOccurrences([commitment], { fromISO: bounds.startISO, toISO: addDaysISO(todayISO, 730), payments: state.commitmentPayments, includePaused: true }).find((item) => !item.paid) ?? null;
  return { current, next };
}

function toolListObligations(ctx) {
  const { state, todayISO } = ctx;
  const summary = commitmentSummary(state.monthlyCommitments, state.commitmentPayments, todayISO);
  const rows = state.monthlyCommitments.slice(0, 100).map((item) => {
    const { current, next } = obligationOccurrences(item, state, todayISO);
    return {
      id: item.id, name: cleanText(item.name, 80), category: cleanText(item.category, 60), amount: money(item.amountFils),
      recurrence: item.recurrence, recurrenceLabel: commitmentRecurrences[item.recurrence], dueDay: Number(String(item.dueDate).slice(8, 10)),
      status: item.status, paymentMethod: PAYMENT_METHOD_LABELS[item.paymentMethod] ?? PAYMENT_METHOD_LABELS.other,
      currentMonthOccurrence: current ? { dueDate: current.dueDate, paid: current.paid, ...(current.partialPaidFils ? { paidSoFar: money(current.partialPaidFils), remaining: money(current.paid ? 0 : current.amountFils) } : {}) } : null,
      nextUnpaidDueDate: next?.dueDate ?? null
    };
  });
  return {
    today: todayISO, count: state.monthlyCommitments.length, truncated: state.monthlyCommitments.length > rows.length,
    monthlyEquivalent: money(summary?.monthlyEquivalentFils ?? 0),
    remainingThisMonth: money(summary?.remainingThisMonthFils ?? 0),
    paidThisMonth: money(summary?.paidThisMonthFils ?? 0),
    rows
  };
}

function toolListDebts(ctx) {
  const { state, todayISO } = ctx;
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const summary = debtSummary(state.loans, { incomeFils, todayISO, payments: state.debtPayments });
  const rows = state.loans.slice(0, 50).map((loan) => ({
    id: loan.id, name: cleanText(loan.name, 60), type: loan.type, status: loan.status,
    remainingBalance: money(loan.balanceFils), monthlyInstallment: money(loan.installmentFils), dueDay: loan.dueDay,
    remainingInstallments: remainingInstallments(loan), endDate: loan.endDate || null,
    annualRatePercent: loan.interestRateKnown ? loan.annualRate : null
  }));
  return {
    today: todayISO, count: state.loans.length, truncated: state.loans.length > rows.length,
    totalRemaining: money(summary.totalBalanceFils), totalMonthlyInstallments: money(summary.monthlyPaymentsFils),
    expectedDebtFreeDate: summary.zeroDebtDate ?? null,
    rows
  };
}

/* ---- تحليل المصروف: نفس تعريف صفحة المصروف (مراجَع فقط، المسترد يُخصم، القسط داخل) ---- */
function periodRange(input, todayISO) {
  const key = monthKeyOf(todayISO);
  if (input.period === "this_month") return { from: `${key}-01`, to: `${key}-${pad2(daysInMonth(key))}`, label: "هذا الشهر", singleMonth: key };
  if (input.period === "last_month") {
    const previous = shiftMonth(key, -1);
    return { from: `${previous}-01`, to: `${previous}-${pad2(daysInMonth(previous))}`, label: "الشهر الماضي", singleMonth: previous };
  }
  if (input.period === "last_3_months") return { from: `${shiftMonth(key, -2)}-01`, to: todayISO, label: "هذا الشهر وآخر شهرين قبله", singleMonth: null };
  if (input.period === "custom") {
    if (!validISO(input.from) || !validISO(input.to)) return { error: "period=custom يحتاج from و to بصيغة YYYY-MM-DD" };
    if (input.from > input.to) return { error: "from لازم يكون قبل to أو يساويه" };
    if (input.from < MIN_DATE) return { error: "from قديم جداً" };
    return { from: input.from, to: input.to, label: "فترة محددة", singleMonth: null };
  }
  return { error: "period غير معروف" };
}

function weekStartOf(iso) {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() - date.getDay());
  return toLocalISO(date);
}

export function spendEntries(transactions, from, to) {
  const entries = [];
  for (const item of transactions) {
    if (!item || item.reviewed === false || item.date < from || item.date > to) continue;
    const refund = isRefund(item);
    if (item.kind !== "expense" && !refund) continue;
    entries.push({
      category: EXPENSE_CATEGORIES.includes(item.category) ? item.category : "أخرى",
      merchant: cleanText(item.merchant, 80), date: item.date, signedFils: refund ? -item.amountFils : item.amountFils, refund
    });
  }
  return entries;
}

function toolAnalyzeSpending(input, ctx) {
  const checked = checkInput(input, ["period", "from", "to", "group_by", "category", "top"], ["period"]);
  if (!checked.ok) return checked;
  const params = checked.input;
  const groupBy = params.group_by ?? "category";
  if (!["category", "merchant", "day", "week"].includes(groupBy)) return fail("bad_input", "group_by غير معروف");
  if (params.category !== undefined && !EXPENSE_CATEGORIES.includes(params.category)) return fail("bad_input", `الفئة غير معروفة. المتاح: ${EXPENSE_CATEGORIES.join("، ")}`);
  const top = params.top === undefined ? 10 : Number(params.top);
  if (!Number.isInteger(top) || top < 1) return fail("bad_input", "top رقم صحيح موجب");
  const range = periodRange(params, ctx.todayISO);
  if (range.error) return fail("bad_input", range.error);
  let entries = spendEntries(ctx.state.transactions, range.from, range.to);
  if (params.category) entries = entries.filter((entry) => entry.category === params.category);
  // المجموع الكلي دائماً بتعريف صفحة المصروف (مجموع كل فئة بعد خصم المسترد، وما ينزل تحت الصفر) مهما كان التجميع،
  // حتى ما يختلف الرقم لنفس الفترة. التجميعات الأخرى تعرض المصروف لكل مجموعة، والمسترد حقل منفصل بدل سالب.
  const byCategory = new Map();
  let grossFils = 0;
  let refundsFils = 0;
  for (const entry of entries) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + entry.signedFils);
    if (entry.refund) refundsFils += -entry.signedFils; else grossFils += entry.signedFils;
  }
  const grand = [...byCategory.values()].reduce((sum, value) => sum + Math.max(value, 0), 0);
  const groups = new Map();
  for (const entry of entries) {
    const key = groupBy === "category" ? entry.category : groupBy === "merchant" ? entry.merchant : groupBy === "day" ? entry.date : weekStartOf(entry.date);
    const row = groups.get(key) ?? { key, netFils: 0, spentFils: 0, refundFils: 0, count: 0 };
    row.netFils += entry.signedFils;
    if (entry.refund) row.refundFils += -entry.signedFils; else { row.spentFils += entry.signedFils; row.count += 1; }
    groups.set(key, row);
  }
  const rows = [...groups.values()].map((row) => ({ ...row, totalFils: groupBy === "category" ? Math.max(row.netFils, 0) : row.spentFils }));
  const shareBase = groupBy === "category" ? grand : grossFils;
  rows.sort((a, b) => b.totalFils - a.totalFils || String(a.key).localeCompare(String(b.key)));
  const kept = rows.slice(0, Math.min(top, 25));
  const omitted = rows.slice(kept.length);
  return {
    period: { from: range.from, to: range.to, label: range.label }, groupBy,
    basis: groupBy === "category"
      ? "المصروفات المراجعة فقط بما فيها فئة القسط، والمبالغ المستردة تُخصم من فئتها"
      : "المصروفات المراجعة فقط بما فيها فئة القسط. المبلغ الكلي (total) صافي بعد خصم المسترد مثل صفحة المصروف، وأرقام المجموعات مصروف بدون خصم المسترد",
    total: money(grand), grossExpenses: money(grossFils), refundsDeducted: money(refundsFils),
    transactionCount: entries.filter((entry) => !entry.refund).length,
    groups: kept.map((row) => ({
      key: groupBy === "week" ? `أسبوع يبدأ ${row.key}` : row.key, total: money(row.totalFils), count: row.count,
      ...(groupBy !== "category" && row.refundFils > 0 ? { refunds: money(row.refundFils) } : {}),
      sharePercent: shareBase > 0 ? `${((row.totalFils / shareBase) * 100).toFixed(1)}%` : null
    })),
    omittedGroups: omitted.length, omittedTotal: money(omitted.reduce((sum, row) => sum + row.totalFils, 0))
  };
}

function toolFinancialPosition(ctx) {
  const { state, todayISO } = ctx;
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  const commitments = commitmentSummary(state.monthlyCommitments, state.commitmentPayments, todayISO);
  const debts = debtSummary(state.loans, { incomeFils, todayISO, payments: state.debtPayments });
  const living = livingBaseline(state.transactions, todayISO, { months: 3, budgetFils: state.settings.budgetFils });
  const surplus = monthlySurplus({ incomeFils, debtPaymentsFils: debts.monthlyPaymentsFils, commitmentsFils: commitments?.monthlyEquivalentFils ?? 0, livingFils: living.amountFils });
  const safe = safeToSpendEngine({
    availableCashFils: state.settings.cashFils, safetyBufferFils: state.settings.safetyBufferFils, reservedCreditCardFils: state.settings.creditCardReserveFils,
    creditCards: state.creditCards, debts: state.loans, debtPayments: state.debtPayments, commitments: state.monthlyCommitments,
    commitmentPayments: state.commitmentPayments, salaryDay: state.settings.salaryDay, todayISO
  });
  const forecast = endOfMonthForecast({
    availableCashFils: state.settings.cashFils, transactions: state.transactions, debts: state.loans, debtPayments: state.debtPayments,
    commitments: state.monthlyCommitments, commitmentPayments: state.commitmentPayments,
    reservedCreditCardFils: safe?.reservedCreditCardFils ?? state.settings.creditCardReserveFils, incomeFils, salaryDay: state.settings.salaryDay, todayISO
  });
  const emergency = state.goals.find((goal) => /طوارئ|emergency/i.test(goal.name ?? ""));
  return {
    today: todayISO, cashBalance: money(state.settings.cashFils), monthlyIncome: money(incomeFils),
    monthlyObligations: money(commitments?.monthlyEquivalentFils ?? 0), monthlyDebtInstallments: money(debts.monthlyPaymentsFils),
    averageLivingCost: living.source === "missing"
      ? { available: false, reason: "تكلفة المعيشة غير معروفة (ما فيه 3 أشهر كاملة من المصاريف ولا ميزانية شهرية). لا تقدّر رقماً." }
      : { ...money(living.amountFils), source: living.source, months: living.months },
    monthlySurplusOrDeficit: living.source === "missing"
      ? { available: false, reason: "تكلفة المعيشة غير معروفة (ما فيه 3 أشهر كاملة من المصاريف ولا ميزانية شهرية)، فما أقدر أحسب الفائض أو العجز. لا تقدّر رقماً." }
      : { ...money(surplus.surplusFils), isDeficit: surplus.surplusFils < 0 },
    safeToSpendUntilPayday: safe ? {
      amount: money(safe.safeFils), shortfall: safe.shortfallFils > 0 ? money(safe.shortfallFils) : null, paydayDate: safe.paydayISO,
      daysUntilPayday: safe.daysUntilPayday, dailyAmount: money(safe.dailySafeFils), reservedForDueBeforePayday: money(safe.committedFils)
    } : null,
    endOfMonthForecast: forecast?.sufficient ? { estimated: true, availableAtMonthEnd: money(forecast.forecastAvailableFils), projectedSpending: money(forecast.projectedSpendingFils), basis: forecast.basis } : { estimated: true, available: false, reason: forecast?.reason ?? "بيانات غير كافية" },
    totalDebtRemaining: money(debts.totalBalanceFils),
    emergencyFund: emergency ? { saved: money(emergency.savedFils), target: money(emergency.targetFils) } : null
  };
}

const READERS = {
  get_overview: (input, ctx) => (checkInput(input, []).ok ? toolOverview(ctx) : checkInput(input, [])),
  list_transactions: toolListTransactions,
  list_budgets: (input, ctx) => (checkInput(input, []).ok ? toolListBudgets(ctx) : checkInput(input, [])),
  list_obligations: (input, ctx) => (checkInput(input, []).ok ? toolListObligations(ctx) : checkInput(input, [])),
  list_debts: (input, ctx) => (checkInput(input, []).ok ? toolListDebts(ctx) : checkInput(input, [])),
  analyze_spending: toolAnalyzeSpending,
  financial_position: (input, ctx) => (checkInput(input, []).ok ? toolFinancialPosition(ctx) : checkInput(input, []))
};

/* ينفذ أداة قراءة. يرجع { ok, text } حيث text هو JSON المرسل للنموذج، أو { ok:false, text } برسالة خطأ للنموذج. */
export function runReadTool(name, input, ctx) {
  const blocked = lockedResult(ctx);
  if (blocked) return { ok: false, text: JSON.stringify({ error: blocked.error }) };
  if (!AI_READ_TOOL_NAMES.has(name) || !READERS[name]) return { ok: false, text: JSON.stringify({ error: "unknown_tool" }) };
  let result;
  try { result = READERS[name](input, ctx); } catch { return { ok: false, text: JSON.stringify({ error: "tool_failed" }) }; }
  if (result && result.ok === false && result.error) return { ok: false, text: JSON.stringify({ error: result.error, message: result.message }) };
  const fitted = fitResult(result);
  return { ok: true, text: fitted.text, result: fitted.result };
}

/* ======================= الاقتراحات (بدون أي تغيير) ======================= */
function line(label, value) { return { label, value }; }
function change(label, before, after) { return { label, before, after }; }

function validateCategoryForKind(kind, category) {
  const allowed = kind === "income" ? AI_INCOME_CATEGORIES : AI_EXPENSE_CATEGORIES;
  return allowed.includes(category) ? null : `الفئة «${cleanText(category, 30)}» لا تناسب ${kind === "income" ? "الدخل (المتاح: راتب، أخرى)" : `المصروف (المتاح: ${AI_EXPENSE_CATEGORIES.join("، ")})`}`;
}

function tenTimesIncomeWarning(state, amountFils) {
  const incomeFils = totalMonthlyIncome(state.incomes, state.settings.incomeFils);
  return incomeFils > 0 && amountFils > incomeFils * 10 ? [`المبلغ أكبر من دخلك الشهري بعشر مرات. تأكد أن الفاصلة في مكانها قبل التنفيذ.`] : [];
}

function fingerprintOf(fields) { return fields.map((value) => String(value ?? "")).join("|"); }
const txFingerprint = (item) => fingerprintOf([item.amountFils, item.merchant, item.category, item.kind, item.date]);
const obligationFingerprint = (item) => fingerprintOf([item.name, item.amountFils, item.dueDate, item.recurrence, item.status]);

function buildAddTransaction(input, ctx) {
  const checked = checkInput(input, ["kind", "amount_kwd", "date", "category", "merchant"], ["kind", "amount_kwd", "date", "category", "merchant"]);
  if (!checked.ok) return checked;
  const { kind, amount_kwd: amountText, date, category } = checked.input;
  if (!["expense", "income"].includes(kind)) return fail("bad_input", "kind إما expense أو income");
  const amount = parseAmount(amountText);
  if (amount.error) return fail("bad_input", amount.error);
  if (!validISO(date)) return fail("bad_input", "date لازم يكون تاريخاً صالحاً YYYY-MM-DD");
  if (date > ctx.todayISO) return fail("bad_input", "ما نسجل عملية بتاريخ المستقبل");
  if (date < MIN_DATE) return fail("bad_input", "التاريخ قديم جداً");
  const categoryError = validateCategoryForKind(kind, category);
  if (categoryError) return fail("bad_input", categoryError);
  const merchant = cleanText(checked.input.merchant, 60);
  if (!merchant) return fail("bad_input", "اسم التاجر أو المصدر فاضي");
  const warnings = tenTimesIncomeWarning(ctx.state, amount.fils);
  if (ctx.state.transactions.some((item) => item.date === date && item.amountFils === amount.fils && merchantKey(item.merchant) === merchantKey(merchant))) {
    warnings.push("عندك عملية مشابهة بنفس اليوم والمبلغ والتاجر. تأكد أنها مو مكررة.");
  }
  const record = {
    id: ctx.createId(), amountFils: amount.fils, merchant, category, kind, date, time: "", reviewed: true, source: "manual",
    rawMerchant: "", fingerprint: "", createdAt: ctx.nowISO()
  };
  return {
    ok: true,
    proposal: {
      tool: "propose_add_transaction", title: kind === "income" ? "إضافة دخل" : "إضافة مصروف", warnings,
      lines: [line("المبلغ", formatMoney(amount.fils)), line("التاريخ", date), line("الفئة", category), line(kind === "income" ? "المصدر" : "التاجر", merchant)],
      action: { type: "add_transaction", record }
    }
  };
}

function buildUpdateTransaction(input, ctx) {
  const checked = checkInput(input, ["id", "kind", "amount_kwd", "date", "category", "merchant"], ["id"]);
  if (!checked.ok) return checked;
  const params = checked.input;
  const target = ctx.state.transactions.find((item) => item.id === params.id);
  if (!target) return fail("not_found", "ما لقيت عملية بهذا المعرّف. اقرأ العمليات من جديد بأداة list_transactions");
  if (target.reviewed === false) return fail("unsupported", "هذي عملية لسه ما انراجعت، يراجعها المستخدم من صفحة العمليات");
  const next = {};
  if (params.kind !== undefined) { if (!["expense", "income"].includes(params.kind)) return fail("bad_input", "kind إما expense أو income"); next.kind = params.kind; }
  if (params.amount_kwd !== undefined) { const amount = parseAmount(params.amount_kwd); if (amount.error) return fail("bad_input", amount.error); next.amountFils = amount.fils; }
  if (params.date !== undefined) {
    if (!validISO(params.date)) return fail("bad_input", "date لازم يكون تاريخاً صالحاً YYYY-MM-DD");
    if (params.date > ctx.todayISO) return fail("bad_input", "ما نسجل عملية بتاريخ المستقبل");
    if (params.date < MIN_DATE) return fail("bad_input", "التاريخ قديم جداً");
    next.date = params.date;
  }
  if (params.category !== undefined) next.category = params.category;
  if (params.merchant !== undefined) { const merchant = cleanText(params.merchant, 60); if (!merchant) return fail("bad_input", "اسم التاجر فاضي"); next.merchant = merchant; }
  const finalKind = next.kind ?? target.kind;
  const finalCategory = next.category ?? target.category;
  // سجل استرداد من استيراد كشف الحساب دخل بفئة مصروف: تعديل مبلغه أو تاريخه ما لازم يجبره على فئة دخل
  if (params.kind !== undefined || params.category !== undefined || (params.merchant !== undefined && isRefund(target))) {
    const categoryError = validateCategoryForKind(finalKind, finalCategory);
    if (categoryError) return fail("bad_input", categoryError);
  }
  const changes = {};
  const labels = { amountFils: "المبلغ", date: "التاريخ", category: "الفئة", merchant: "التاجر", kind: "النوع" };
  const shown = (field, value) => field === "amountFils" ? formatMoney(value) : field === "kind" ? (value === "income" ? "دخل" : "مصروف") : String(value);
  const lines = [line("العملية", `${cleanText(target.merchant, 40)} · ${formatMoney(target.amountFils)} · ${target.date}`)];
  for (const [field, after] of Object.entries(next)) {
    if (target[field] === after) continue;
    changes[field] = { before: target[field], after };
    lines.push(change(labels[field], shown(field, target[field]), shown(field, after)));
  }
  // الفئة لازم تناسب النوع الجديد حتى لو ما ذكرها النموذج (مثلاً مصروف «مطاعم» صار دخل)
  if (!Object.keys(changes).length) return fail("no_change", "القيم المطلوبة هي نفسها الحالية، ما في شي يتغير");
  if (changes.date && target.time) changes.time = { before: target.time, after: "" };
  const warnings = changes.amountFils ? tenTimesIncomeWarning(ctx.state, changes.amountFils.after) : [];
  return { ok: true, proposal: { tool: "propose_update_transaction", title: "تعديل عملية", warnings, lines, action: { type: "update_transaction", id: target.id, changes } } };
}

function nextAnchorDate(dayOfMonth, todayISO) {
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = addMonthsISO(`${todayISO.slice(0, 8)}01`, offset);
    if (!candidate) continue;
    const dim = daysInMonth(candidate.slice(0, 7));
    if (dayOfMonth > dim) continue;
    const iso = `${candidate.slice(0, 8)}${pad2(dayOfMonth)}`;
    if (iso >= todayISO) return iso;
  }
  return null;
}

function buildAddObligation(input, ctx) {
  const checked = checkInput(input, ["name", "amount_kwd", "day_of_month", "recurrence", "category", "payment_method", "first_due_date", "note"], ["name", "amount_kwd", "day_of_month"]);
  if (!checked.ok) return checked;
  const params = checked.input;
  const name = cleanText(params.name, 60);
  if (!name) return fail("bad_input", "اسم الالتزام فاضي");
  const amount = parseAmount(params.amount_kwd);
  if (amount.error) return fail("bad_input", amount.error);
  const day = Number(params.day_of_month);
  if (!Number.isInteger(day) || day < 1 || day > 31) return fail("bad_input", "day_of_month رقم من 1 إلى 31");
  const recurrence = params.recurrence ?? "monthly";
  if (!AI_RECURRENCES.includes(recurrence)) return fail("bad_input", "recurrence غير معروف");
  const category = params.category ?? "أخرى";
  if (!AI_OBLIGATION_CATEGORIES.includes(category)) return fail("bad_input", `الفئة غير معروفة. المتاح: ${AI_OBLIGATION_CATEGORIES.join("، ")}`);
  const paymentMethod = params.payment_method ?? "bank";
  if (!AI_PAYMENT_METHODS.includes(paymentMethod)) return fail("bad_input", "payment_method غير معروف");
  const notes = params.note === undefined ? "" : cleanText(params.note, 120);
  let dueDate;
  if (params.first_due_date !== undefined) {
    if (!validISO(params.first_due_date)) return fail("bad_input", "first_due_date تاريخ غير صالح");
    if (Number(params.first_due_date.slice(8, 10)) !== day) return fail("bad_input", "يوم first_due_date لازم يطابق day_of_month");
    dueDate = params.first_due_date;
  } else if (recurrence === "once") {
    return fail("bad_input", "الالتزام لمرة واحدة يحتاج first_due_date");
  } else {
    dueDate = nextAnchorDate(day, ctx.todayISO);
  }
  if (!dueDate) return fail("bad_input", "ما قدرت أحدد أول استحقاق لهذا اليوم");
  if (dueDate < MIN_DATE || dueDate > addDaysISO(ctx.todayISO, 3653)) return fail("bad_input", "التاريخ لازم يكون بين سنة 2000 وعشر سنين من اليوم");
  const warnings = [];
  if (ctx.state.monthlyCommitments.some((item) => item.status === "active" && cleanText(item.name, 60) === name && item.amountFils === amount.fils)) {
    warnings.push("عندك التزام نشط بنفس الاسم والمبلغ. تأكد أنه مو مكرر.");
  }
  const record = {
    id: ctx.createId(), name, category, amountFils: amount.fils, dueDate, recurrence, paymentMethod, notes, status: "active", createdAt: ctx.nowISO()
  };
  return {
    ok: true,
    proposal: {
      tool: "propose_add_obligation", title: "إضافة التزام", warnings,
      lines: [
        line("الاسم", name), line("المبلغ", formatMoney(amount.fils)), line("التكرار", commitmentRecurrences[recurrence]),
        line(recurrence === "once" ? "تاريخ الاستحقاق" : "أول استحقاق", dueDate), line("الفئة", category), line("طريقة الدفع", PAYMENT_METHOD_LABELS[paymentMethod]),
        ...(notes ? [line("ملاحظة", notes)] : [])
      ],
      action: { type: "add_obligation", record }
    }
  };
}

function buildMarkPaid(input, ctx) {
  const checked = checkInput(input, ["id", "due_date", "paid"], ["id"]);
  if (!checked.ok) return checked;
  const params = checked.input;
  const commitment = ctx.state.monthlyCommitments.find((item) => item.id === params.id);
  if (!commitment) return fail("not_found", "ما لقيت التزاماً بهذا المعرّف. اقرأ الالتزامات من جديد بأداة list_obligations");
  const paid = params.paid === undefined ? true : params.paid;
  if (typeof paid !== "boolean") return fail("bad_input", "paid لازم يكون true أو false");
  const bounds = monthBounds(ctx.todayISO);
  const occurrences = commitmentOccurrences([commitment], { fromISO: addDaysISO(ctx.todayISO, -400), toISO: addDaysISO(ctx.todayISO, 740), payments: ctx.state.commitmentPayments, includePaused: true });
  let occurrence;
  if (params.due_date !== undefined) {
    if (!validISO(params.due_date)) return fail("bad_input", "due_date تاريخ غير صالح");
    occurrence = occurrences.find((item) => item.dueDate === params.due_date);
    if (!occurrence) return fail("bad_input", "هذا مو موعد استحقاق حقيقي للالتزام. استخدم التاريخ كما يرجع من list_obligations");
  } else {
    const inMonth = occurrences.filter((item) => item.dueDate >= bounds.startISO && item.dueDate <= bounds.endISO);
    occurrence = inMonth.find((item) => paid ? !item.paid : item.paid) ?? inMonth[0];
    if (!occurrence) return fail("bad_input", "ما في استحقاق لهذا الالتزام في الشهر الحالي. حدد due_date");
  }
  const existingIndex = ctx.state.commitmentPayments.findIndex((item) => item.commitmentId === commitment.id && sameDueMonth(item.dueDate, occurrence.dueDate) && item.status !== "reversed");
  const base = { commitmentId: commitment.id, dueDate: occurrence.dueDate, amountFils: commitment.amountFils, name: cleanText(commitment.name, 60) };
  // الدفع الجزئي (من صفحة الالتزامات) أدق يدوياً: ما أسجل ولا ألغي فوق دفعات جزئية
  if (ctx.state.commitmentPayments.some((item) => item.commitmentId === commitment.id && sameDueMonth(item.dueDate, occurrence.dueDate) && item.status !== "reversed" && item.partial === true)) {
    const part = occurrence.partialPaidFils ?? 0;
    return fail("partial_payments", `هذا الاستحقاق فيه دفعات جزئية (مدفوع ${formatMoney(part)} من ${formatMoney(commitment.amountFils)}). سجّل الباقي أو تراجع عنه من صفحة الالتزامات بنفسك.`);
  }
  if (paid) {
    if (existingIndex >= 0) return fail("already_paid", "هذا الاستحقاق مسجل كمدفوع من قبل");
    if (commitment.status !== "active") return fail("unsupported", "الالتزام موقوف أو مكتمل، ما أقدر أسجل عليه دفعة");
    const cashFils = ctx.state.settings.cashFils;
    const preview = cashDeduction(cashFils, commitment.amountFils);
    const lines = [line("الالتزام", base.name), line("المبلغ", formatMoney(commitment.amountFils)), line("تاريخ الاستحقاق", occurrence.dueDate)];
    return {
      ok: true,
      proposal: {
        tool: "propose_mark_obligation_paid", title: "تسجيل دفع التزام", warnings: preview.clamped && preview.deductedFils > 0 ? ["رصيدك النقدي أقل من المبلغ، لو اخترت الخصم ينخصم الموجود فقط."] : [], lines,
        cashChoice: preview.deductedFils > 0 ? { cashFils, deductFils: preview.deductedFils, cashAfterFils: preview.cashAfterFils, cashDisplay: formatMoney(cashFils), afterDisplay: formatMoney(preview.cashAfterFils), deductDisplay: formatMoney(preview.deductedFils) } : null,
        action: { type: "mark_paid", ...base, schedule: { dueDate: commitment.dueDate, recurrence: commitment.recurrence } }
      }
    };
  }
  if (existingIndex < 0) return fail("not_paid", "ما في دفعة مسجلة لهذا الاستحقاق عشان أحذفها");
  const payment = ctx.state.commitmentPayments[existingIndex];
  const restored = paymentCashDeductedFils(payment);
  return {
    ok: true,
    proposal: {
      tool: "propose_mark_obligation_paid", title: "إلغاء تسجيل دفعة", warnings: [],
      lines: [line("الالتزام", base.name), line("المبلغ", formatMoney(payment.amountFils)), line("تاريخ الاستحقاق", occurrence.dueDate), line("يرجع لرصيدك النقدي", formatMoney(restored))],
      action: { type: "unmark_paid", ...base, paymentId: payment.id }
    }
  };
}

function buildSetBudget(input, ctx) {
  const checked = checkInput(input, ["category", "limit_kwd"], ["category", "limit_kwd"]);
  if (!checked.ok) return checked;
  const { category } = checked.input;
  if (!EXPENSE_CATEGORIES.includes(category)) return fail("bad_input", `الفئة غير معروفة. المتاح: ${EXPENSE_CATEGORIES.join("، ")}`);
  const amount = parseAmount(checked.input.limit_kwd, { allowZero: true });
  if (amount.error) return fail("bad_input", amount.error);
  if (amount.fils > 1_000_000_000) return fail("bad_input", "المبلغ كبير جداً");
  const before = ctx.state.categoryBudgets?.[category] > 0 ? ctx.state.categoryBudgets[category] : 0;
  if (before === amount.fils) return fail("no_change", "الميزانية الحالية هي نفسها، ما في شي يتغير");
  return {
    ok: true,
    proposal: {
      tool: "propose_set_budget", title: amount.fils === 0 ? "حذف ميزانية فئة" : "تعديل ميزانية فئة", warnings: [],
      lines: [line("الفئة", category), change("الميزانية الشهرية", before > 0 ? formatMoney(before) : "بدون ميزانية", amount.fils > 0 ? formatMoney(amount.fils) : "بدون ميزانية")],
      action: { type: "set_budget", category, before, after: amount.fils }
    }
  };
}

const BUILDERS = {
  propose_add_transaction: buildAddTransaction,
  propose_update_transaction: buildUpdateTransaction,
  propose_add_obligation: buildAddObligation,
  propose_mark_obligation_paid: buildMarkPaid,
  propose_set_budget: buildSetBudget
};

/* يبني اقتراحاً بمعرّف جديد، وما يلمس state. proposal.status يبدأ pending. */
export function buildProposal(name, input, ctx) {
  const blocked = lockedResult(ctx);
  if (blocked) return blocked;
  if (!AI_WRITE_TOOL_NAMES.has(name) || !BUILDERS[name]) return fail("unknown_tool", "أداة غير معروفة");
  let built;
  try { built = BUILDERS[name](input, ctx); } catch { return fail("tool_failed", "تعذر تجهيز الاقتراح"); }
  if (!built.ok) return built;
  return { ok: true, proposal: { id: `p_${ctx.createId()}`, status: "pending", createdAt: ctx.nowISO(), ...built.proposal } };
}

/* النص اللي يرجع للنموذج بعد تجهيز الاقتراح: ما نقول إنه نُفّذ، ونعطيه المعاينة فقط. */
export function proposalToolResult(proposal) {
  return JSON.stringify({
    status: "awaiting_user_approval", proposal_id: proposal.id, title: proposal.title,
    preview: proposal.lines.map((item) => item.after !== undefined ? `${item.label}: ${item.before} ← ${item.after}` : `${item.label}: ${item.value}`),
    warnings: proposal.warnings
  });
}

/* ======================= التنفيذ والتراجع ======================= */
function applyFail(reason, message) { return { ok: false, reason, message }; }

function journalBase(proposal, ctx, op) {
  return {
    id: `j_${ctx.createId()}`, proposalId: proposal.id, tool: proposal.tool, title: proposal.title, at: ctx.nowISO(), undone: "",
    summary: proposal.lines.slice(0, 5).map((item) => item.after !== undefined ? `${item.label}: ${item.before} ← ${item.after}` : `${item.label}: ${item.value}`),
    op
  };
}

/* ينفذ اقتراحاً معلّقاً على ctx.state. يرجع { ok, entry, message } أو { ok:false, reason, message }.
   reason: locked | not_pending | stale | invalid. ما يستدعي commit؛ هذا شغل التطبيق. */
export function applyProposal(proposal, ctx, options = {}) {
  const result = applyInner(proposal, ctx, options);
  // الحالة تتحدد هنا بشكل متزامن: ضغطة ثانية على «تنفيذ» ما تنفذ مرتين أبداً
  if (proposal && result.ok) proposal.status = "executed";
  else if (proposal && result.reason === "stale") proposal.status = "stale";
  return result;
}

function applyInner(proposal, ctx, options) {
  const blocked = lockedResult(ctx);
  if (blocked) return applyFail("locked", "التطبيق مقفل. افتح القفل وجرب من جديد");
  if (!proposal || proposal.status !== "pending") return applyFail("not_pending", "هذا الاقتراح نُفّذ أو أُلغي من قبل");
  const { state } = ctx;
  const action = proposal.action;
  const stale = () => applyFail("stale", "تغيّرت البيانات منذ المعاينة. اطلب مني الاقتراح من جديد");
  switch (action.type) {
    case "add_transaction": {
      const record = action.record;
      if (state.transactions.some((item) => item.id === record.id)) return applyFail("not_pending", "هذي العملية انضافت من قبل");
      if (record.date > ctx.todayISO) return applyFail("invalid", "التاريخ صار بالمستقبل");
      state.transactions.push({ ...record });
      return { ok: true, message: "تمت إضافة العملية", entry: journalBase(proposal, ctx, { kind: "tx_add", id: record.id, fp: txFingerprint(record) }) };
    }
    case "update_transaction": {
      const target = state.transactions.find((item) => item.id === action.id);
      if (!target) return stale();
      for (const [field, pair] of Object.entries(action.changes)) if (target[field] !== pair.before) return stale();
      if (target.reviewed === false) return stale();
      for (const [field, pair] of Object.entries(action.changes)) target[field] = pair.after;
      return { ok: true, message: "تم تعديل العملية", entry: journalBase(proposal, ctx, { kind: "tx_update", id: action.id, changes: action.changes }) };
    }
    case "add_obligation": {
      const record = action.record;
      if (state.monthlyCommitments.some((item) => item.id === record.id)) return applyFail("not_pending", "هذا الالتزام انضاف من قبل");
      state.monthlyCommitments.push({ ...record });
      return { ok: true, message: "تمت إضافة الالتزام", entry: journalBase(proposal, ctx, { kind: "ob_add", id: record.id, fp: obligationFingerprint(record) }) };
    }
    case "mark_paid": {
      const commitment = state.monthlyCommitments.find((item) => item.id === action.commitmentId);
      if (!commitment || commitment.amountFils !== action.amountFils || commitment.status !== "active") return stale();
      if (action.schedule && (commitment.dueDate !== action.schedule.dueDate || commitment.recurrence !== action.schedule.recurrence)) return stale();
      if (state.commitmentPayments.some((item) => item.commitmentId === commitment.id && sameDueMonth(item.dueDate, action.dueDate) && item.status !== "reversed")) return stale();
      const taken = options.deductCash ? cashDeduction(state.settings.cashFils, commitment.amountFils) : { deductedFils: 0, cashAfterFils: state.settings.cashFils };
      const payment = {
        id: ctx.createId(), commitmentId: commitment.id, amountFils: commitment.amountFils, dueDate: action.dueDate, paidAt: ctx.todayISO,
        status: "paid", cashDeducted: taken.deductedFils > 0, cashDeductedFils: taken.deductedFils
      };
      state.commitmentPayments.push(payment);
      state.settings.cashFils = taken.cashAfterFils;
      const completedNow = commitment.recurrence === "once";
      if (completedNow) commitment.status = "completed";
      return {
        ok: true,
        message: taken.deductedFils > 0 ? `سجّلت الدفع وخصمت ${formatMoney(taken.deductedFils)} من رصيدك` : "تم تسجيل الالتزام كمدفوع",
        entry: journalBase(proposal, ctx, { kind: "pay_add", paymentId: payment.id, commitmentId: commitment.id, dueDate: action.dueDate, amountFils: payment.amountFils, deductedFils: taken.deductedFils, completedNow })
      };
    }
    case "unmark_paid": {
      const index = state.commitmentPayments.findIndex((item) => item.id === action.paymentId && item.status !== "reversed");
      if (index < 0) return stale();
      const commitment = state.monthlyCommitments.find((item) => item.id === action.commitmentId);
      if (!commitment) return stale();
      const [payment] = state.commitmentPayments.splice(index, 1);
      const restored = paymentCashDeductedFils(payment);
      state.settings.cashFils += restored;
      const reopened = commitment.recurrence === "once" && commitment.status === "completed";
      if (reopened) commitment.status = "active";
      return {
        ok: true, message: restored > 0 ? `رجّعت الدفع و${formatMoney(restored)} للرصيد` : "تم التراجع عن تسجيل الدفع",
        entry: journalBase(proposal, ctx, { kind: "pay_remove", payment: { ...payment }, restoredFils: restored, commitmentId: commitment.id, reopened })
      };
    }
    case "set_budget": {
      const current = state.categoryBudgets?.[action.category] > 0 ? state.categoryBudgets[action.category] : 0;
      if (current !== action.before) return stale();
      state.categoryBudgets ??= {};
      if (action.after > 0) state.categoryBudgets[action.category] = action.after; else delete state.categoryBudgets[action.category];
      return { ok: true, message: action.after > 0 ? "تم تعديل الميزانية" : "تم حذف الميزانية", entry: journalBase(proposal, ctx, { kind: "budget", category: action.category, before: action.before, after: action.after }) };
    }
    default:
      return applyFail("invalid", "نوع الاقتراح غير معروف");
  }
}

/* تراجع آمن: يرفض إذا السجل تغيّر بعد التنفيذ، ولا يرجّع نسخة كاملة من البيانات أبداً. */
export function undoEntry(entry, ctx) {
  const blocked = lockedResult(ctx);
  if (blocked) return { ok: false, reason: "locked", message: "التطبيق مقفل. افتح القفل وجرب من جديد" };
  if (!entry || entry.undone) return { ok: false, reason: "already_undone", message: "تم التراجع عن هذا التغيير من قبل" };
  const { state } = ctx;
  const op = entry.op;
  const conflict = (message) => ({ ok: false, reason: "conflict", message });
  switch (op.kind) {
    case "tx_add": {
      const index = state.transactions.findIndex((item) => item.id === op.id);
      if (index < 0) return conflict("العملية ما عادت موجودة (غالباً انحذفت)");
      if (txFingerprint(state.transactions[index]) !== op.fp) return conflict("العملية تعدّلت بعد إضافتها. عدّلها أو احذفها يدوياً");
      state.transactions.splice(index, 1);
      return { ok: true, message: "تم التراجع وحذفت العملية" };
    }
    case "tx_update": {
      const target = state.transactions.find((item) => item.id === op.id);
      if (!target) return conflict("العملية ما عادت موجودة (غالباً انحذفت)");
      for (const [field, pair] of Object.entries(op.changes)) if (target[field] !== pair.after) return conflict("العملية تعدّلت بعد تعديلي. ما أقدر أرجّعها بدون ما أضيّع تعديلك");
      for (const [field, pair] of Object.entries(op.changes)) target[field] = pair.before;
      return { ok: true, message: "تم التراجع ورجّعت قيم العملية" };
    }
    case "ob_add": {
      const index = state.monthlyCommitments.findIndex((item) => item.id === op.id);
      if (index < 0) return conflict("الالتزام ما عاد موجود (غالباً انحذف)");
      if (obligationFingerprint(state.monthlyCommitments[index]) !== op.fp) return conflict("الالتزام تعدّل بعد إضافته. عدّله أو احذفه يدوياً");
      if (state.commitmentPayments.some((item) => item.commitmentId === op.id)) return conflict("عليه دفعات مسجلة. احذفه يدوياً إذا تبي");
      state.monthlyCommitments.splice(index, 1);
      return { ok: true, message: "تم التراجع وحذفت الالتزام" };
    }
    case "pay_add": {
      const index = state.commitmentPayments.findIndex((item) => item.id === op.paymentId);
      if (index < 0) return conflict("الدفعة ما عادت موجودة");
      const payment = state.commitmentPayments[index];
      if (payment.amountFils !== op.amountFils || payment.dueDate !== op.dueDate) return conflict("الدفعة تعدّلت بعد تسجيلها");
      state.commitmentPayments.splice(index, 1);
      state.settings.cashFils += op.deductedFils;
      const commitment = state.monthlyCommitments.find((item) => item.id === op.commitmentId);
      if (op.completedNow && commitment?.status === "completed") commitment.status = "active";
      return { ok: true, message: "تم التراجع عن تسجيل الدفع" };
    }
    case "pay_remove": {
      const commitment = state.monthlyCommitments.find((item) => item.id === op.commitmentId);
      if (!commitment) return conflict("الالتزام ما عاد موجود");
      if (state.commitmentPayments.some((item) => item.commitmentId === op.commitmentId && sameDueMonth(item.dueDate, op.payment.dueDate) && item.status !== "reversed")) return conflict("في دفعة مسجلة لهذا الاستحقاق من جديد");
      const again = cashDeduction(state.settings.cashFils, op.restoredFils);
      const payment = { ...op.payment };
      if (op.restoredFils > 0) { payment.cashDeductedFils = again.deductedFils; payment.cashDeducted = again.deductedFils > 0; }
      state.commitmentPayments.push(payment);
      state.settings.cashFils = again.cashAfterFils;
      if (op.reopened && commitment.status === "active") commitment.status = "completed";
      return { ok: true, message: "تم التراجع ورجّعت تسجيل الدفعة" };
    }
    case "budget": {
      const current = state.categoryBudgets?.[op.category] > 0 ? state.categoryBudgets[op.category] : 0;
      if (current !== op.after) return conflict("الميزانية تغيّرت بعد تعديلي");
      state.categoryBudgets ??= {};
      if (op.before > 0) state.categoryBudgets[op.category] = op.before; else delete state.categoryBudgets[op.category];
      return { ok: true, message: "تم التراجع ورجّعت الميزانية" };
    }
    default:
      return { ok: false, reason: "invalid", message: "نوع التغيير غير معروف" };
  }
}

/* ======================= حارس الأرقام ======================= */
// الفكرة: أي مبلغ يكتبه النموذج لازم يطابق رقماً جاء من أدوات التطبيق (حقل fils أو نص display)، أو كتبه المستخدم، أو ورد في اقتباس مصدر ويب.
// ما نحسب «الأدلة» من نص النتيجة الخام: التواريخ والمعرّفات وأيام الشهر والعدّادات ما تصير دليلاً على مبلغ.
const NUMBER_PATTERN = /(?<![\d.,])(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const toMillis = (text) => Math.round(Number(text.replaceAll(",", "")) * 1000);
const normalizeText = (value) => normalizeDigits(String(value ?? "")).replaceAll("٫", ".").replaceAll("٬", ",");
const CURRENCY_WORD = "(?:د\\s*\\.?\\s*ك|دينار|دنانير|KWD|KD)";
const CURRENCY_AFTER = new RegExp(`^\\s*${CURRENCY_WORD}`, "i");
const CURRENCY_BEFORE = new RegExp(`(?<![\\d.,]\\s*)${CURRENCY_WORD}\\s*[:：]?\\s*$`, "i"); // «100 د.ك 3 مرات»: العملة تخص 100 مو 3
const CURRENCY_ANYWHERE = new RegExp(CURRENCY_WORD, "i");
const FILS_AFTER = /^\s*(?:فلس|فلوس|fils)/i;
const PERCENT_AFTER = /^\s*(?:[%٪]|بالمئة|بالمائة|في\s*المئة|في\s*المائة|percent)/i;
// سطر التاريخ وسطر ملاحظات التطبيق في أول رسالة المستخدم ليسا من كلام المستخدم
const USER_HEADER = /^\[التاريخ اليوم:[^\]]*\](?:\n\[ملاحظات من التطبيق:[^\]]*\])?\n/;

function numberTokens(text) {
  return [...normalizeText(text).matchAll(NUMBER_PATTERN)].map((match) => ({ text: match[0], index: match.index, end: match.index + match[0].length }));
}

function harvestToolResult(text, evidence) {
  const raw = String(text ?? "");
  for (const match of raw.matchAll(/"fils":\s*(-?\d+)/g)) evidence.money.add(Math.abs(Number(match[1])));
  // أي نص (display أو سطر معاينة أو تحذير) فيه عملة: أرقامه مبالغ معروضة
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    if (!CURRENCY_ANYWHERE.test(match[1])) continue;
    for (const token of numberTokens(match[1])) evidence.money.add(toMillis(token.text));
  }
  // باقي الأرقام (نسب، أعداد...) تُقبل فقط لرقم بدون عملة
  for (const match of raw.matchAll(/"([A-Za-z_]+)":\s*(-?\d+(?:\.\d+)?)(?=\s*[,}\]])/g)) {
    if (match[1] !== "fils") evidence.numbers.add(Math.round(Math.abs(Number(match[2])) * 1000));
  }
  // أرقام داخل نصوص الأسماء والملاحظات (تاجر «فرع 5.500»...) دليل لرقم بدون عملة فقط، مو مبلغ
  for (const match of raw.matchAll(/"(?:merchant|name|note|title|label|source)[A-Za-z_]*":\s*"((?:[^"\\]|\\.)*)"/gi)) {
    for (const token of numberTokens(match[1])) evidence.numbers.add(toMillis(token.text));
  }
}

/* يبني الأدلة من رسائل المحادثة: money (فلوس) للمبالغ بعملة، وnumbers لأرقام أخرى بدون عملة. */
export function buildEvidence(messages) {
  const evidence = { money: new Set(), numbers: new Set() };
  const addBoth = (text) => {
    const clean = normalizeText(text);
    for (const token of numberTokens(clean)) {
      const value = toMillis(token.text);
      evidence.money.add(value); evidence.numbers.add(value);
      // «500 فلس» يُكتب بالفلس مباشرة، فيدخل الدليل بالفلس مو بالدينار
      if (FILS_AFTER.test(clean.slice(token.end, token.end + 16))) evidence.money.add(Math.round(Number(token.text.replaceAll(",", ""))));
    }
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (message.role === "user") {
        if (block?.type === "text") addBoth(String(block.text ?? "").replace(USER_HEADER, ""));
        else if (block?.type === "tool_result" && typeof block.content === "string") harvestToolResult(block.content, evidence);
      } else if (message.role === "assistant") {
        for (const citation of Array.isArray(block?.citations) ? block.citations : []) addBoth(`${citation?.cited_text ?? ""} ${citation?.title ?? ""}`);
      }
    }
  }
  return evidence;
}

/* يطلع الأرقام «الشبيهة بالمبالغ» من رد النموذج ويطابقها مع الأدلة. الشبيه بالمبلغ: بجانبه عملة (قبل أو بعد) أو «فلس»،
   أو فيه كسر عشري، أو عدد صحيح من 4 خانات فأكثر (غير سنة). النسب المئوية والتواريخ ما تُفحص. غير المطابق يعرضه التطبيق للمستخدم كتنبيه.
   evidence: كائن من buildEvidence، أو مصفوفة نصوص (يُعتبر كل رقم فيها دليلاً). */
export function checkNumbers(answer, evidence) {
  let known = evidence;
  if (Array.isArray(evidence)) {
    known = { money: new Set(), numbers: new Set() };
    for (const item of evidence) for (const token of numberTokens(item)) { known.money.add(toMillis(token.text)); known.numbers.add(toMillis(token.text)); }
  }
  const text = normalizeText(answer);
  const dateSpans = [...text.matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/g)].map((match) => [match.index, match.index + match[0].length]);
  const unmatched = [];
  for (const token of numberTokens(text)) {
    if (dateSpans.some(([from, to]) => token.index >= from && token.end <= to)) continue;
    const after = text.slice(token.end, token.end + 16);
    if (PERCENT_AFTER.test(after)) continue;
    const value = Number(token.text.replaceAll(",", ""));
    const hasDecimal = token.text.includes(".");
    const isYear = Number.isInteger(value) && value >= 1900 && value <= 2200 && !token.text.includes(",");
    const currency = CURRENCY_AFTER.test(after) || CURRENCY_BEFORE.test(text.slice(Math.max(0, token.index - 24), token.index));
    const inFils = FILS_AFTER.test(after);
    const moneyLike = currency || inFils || hasDecimal || (Number.isInteger(value) && value >= 1000 && !isYear);
    if (!moneyLike) continue;
    const millis = toMillis(token.text);
    const found = inFils ? known.money.has(Math.round(value)) : currency ? known.money.has(millis) : (known.money.has(millis) || known.numbers.has(millis));
    if (!found) unmatched.push(token.text);
  }
  return { ok: unmatched.length === 0, unmatched: [...new Set(unmatched)] };
}

/* أرقام الخصم من الرصيد النقدي كما هي الحين (مو وقت المعاينة): تتغير لو نُفّذ اقتراح قبلها أو تغيّر الرصيد */
export function liveCashChoice(proposal, ctx) {
  if (proposal?.action?.type !== "mark_paid" || !proposal.cashChoice) return null;
  const cashFils = ctx.state.settings.cashFils;
  const preview = cashDeduction(cashFils, proposal.action.amountFils);
  if (!(preview.deductedFils > 0)) return null;
  return { cashDisplay: formatMoney(cashFils), afterDisplay: formatMoney(preview.cashAfterFils), deductDisplay: formatMoney(preview.deductedFils) };
}

export { AI_TOOL_NAMES, AI_READ_TOOL_NAMES, AI_WRITE_TOOL_NAMES };
