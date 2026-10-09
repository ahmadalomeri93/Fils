// تعريف أدوات «المحاسب الذكي» (بصيغة Claude API). مصدر واحد للتطبيق وللـWorker:
// الـWorker يرسلها كما هي لClaude ويرفض أي اسم أداة غيرها، والتطبيق ينفذها بدوال التطبيق نفسها.
// أدوات القراءة تنفذ مباشرة وترجع نتائج محسوبة بكود التطبيق. أدوات propose_* ما تغيّر شيئاً أبداً:
// تنشئ «اقتراح» يظهر للمستخدم بمعاينة وزر «تنفيذ»، وما يتغير شي قبل موافقته.
// المبالغ دائماً نص بالدينار الكويتي بحد أقصى 3 منازل ("12.500")، والتطبيق يحوّلها لفلوس صحيحة بنفسه.

// قوائم ثابتة (يطابقها اختبار مع finance-core.js وتصنيفات الالتزامات في app.js حتى لا تنحرف)
export const AI_EXPENSE_CATEGORIES = ["مطاعم", "بقالة", "مواصلات", "تسوق", "سكن", "فواتير", "صحة", "ترفيه", "سفر", "قسط", "أخرى"];
export const AI_INCOME_CATEGORIES = ["راتب", "أخرى"];
export const AI_OBLIGATION_CATEGORIES = ["إيجار", "كهرباء وماء", "إنترنت", "هاتف", "تأمين", "اشتراكات", "مدرسة / حضانة", "عامل منزلي", "نادي", "سيارة", "عائلة", "أخرى"];
export const AI_RECURRENCES = ["monthly", "quarterly", "semiannual", "annual", "once"];
export const AI_PAYMENT_METHODS = ["bank", "credit_card", "cash", "other"];

const date = (description) => ({ type: "string", description: `${description} (YYYY-MM-DD)`, pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const money = (description) => ({ type: "string", description: `${description}. Amount in KWD as a string with up to 3 decimals, e.g. "80" or "12.500"`, pattern: "^\\d{1,9}(\\.\\d{1,3})?$" });

export const AI_READ_TOOLS = [
  {
    name: "get_overview",
    description: "Returns today's date, the current month, cash balance, this month's income and spending totals, budget status counts, upcoming payments in the next 14 days and total debt, all computed by the app. Call this first when the question depends on the date or on the general situation. Takes no input.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_transactions",
    description: "Lists the user's reviewed transactions (newest first) with their ids, dates, amounts, categories and merchants, plus the exact totals of everything that matched. Call it to answer questions about specific purchases or to find the exact id of a transaction before proposing an edit. Always narrow it with from/to, category or search; do not pull everything.",
    input_schema: {
      type: "object",
      properties: {
        from: date("Earliest date, inclusive"),
        to: date("Latest date, inclusive"),
        category: { type: "string", description: "Exact category label as returned by list_budgets or analyze_spending" },
        kind: { type: "string", enum: ["expense", "income"], description: "Only expenses or only income" },
        search: { type: "string", description: "Text to look for in the merchant (max 60 characters)" },
        limit: { type: "integer", description: "Maximum rows to return, default 30, maximum 60" }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_budgets",
    description: "Lists the monthly budget of each category with the limit, how much was spent this month, and how much remains, plus categories that have spending but no budget, and the exact category labels that accept a budget. Call it before proposing a budget change and for any question about budgets or what is left in a category.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_obligations",
    description: "Lists the user's fixed obligations (installments, subscriptions, regular payments) with id, name, amount, recurrence, due day, status, whether the occurrence of the current month is paid, and the next unpaid due date. Call it for questions about what is due and before proposing to mark an obligation paid.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_debts",
    description: "Lists the user's debts and loans with id, name, remaining balance, monthly installment, due day and end date, plus the total remaining and the total monthly installments. Call it for any question about debts, loans, or when they will be paid off.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "analyze_spending",
    description: "Computes spending totals in code, grouped by category, merchant, day or week, for a period. Call it for every question of the form \"how much did I spend on ...\", comparisons between periods, the biggest expenses, or averages. Never add up numbers yourself.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["this_month", "last_month", "last_3_months", "custom"], description: "Period to analyze. last_3_months means the current month so far plus the two previous calendar months. Use custom together with from and to" },
        from: date("Start date, only for period=custom"),
        to: date("End date, only for period=custom"),
        group_by: { type: "string", enum: ["category", "merchant", "day", "week"], description: "How to group the totals, default category" },
        category: { type: "string", description: "Restrict to one category label" },
        top: { type: "integer", description: "Keep only the biggest N groups, default 10, maximum 25" }
      },
      required: ["period"],
      additionalProperties: false
    }
  },
  {
    name: "financial_position",
    description: "Returns the user's overall financial position computed by the app: monthly income, committed obligations, debt installments, average living cost, the monthly surplus or deficit, the safe-to-spend amount until payday, an end-of-month forecast and the emergency-fund status. Call it for questions like \"how is my situation\", \"can I afford ...\", or \"how much can I save\".",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  }
];

export const AI_WRITE_TOOLS = [
  {
    name: "propose_add_transaction",
    description: "Prepares a NEW transaction for the user to approve. It does not save anything: the app shows a preview with an Execute button. Use it when the user asks to add an expense or income. Expense categories: مطاعم, بقالة, مواصلات, تسوق, سكن, فواتير, صحة, ترفيه, سفر, قسط, أخرى. Income categories: راتب, أخرى. The date cannot be in the future.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["expense", "income"] },
        amount_kwd: money("Transaction amount"),
        date: date("Transaction date"),
        category: { type: "string", enum: [...new Set([...AI_EXPENSE_CATEGORIES, ...AI_INCOME_CATEGORIES])], description: "Category label; income accepts only راتب or أخرى" },
        merchant: { type: "string", description: "Merchant or payee (or income source) name, 1 to 60 characters" }
      },
      required: ["kind", "amount_kwd", "date", "category", "merchant"],
      additionalProperties: false
    }
  },
  {
    name: "propose_update_transaction",
    description: "Prepares a change to ONE existing reviewed transaction for the user to approve. First find its exact id with list_transactions. Only include the fields that should change. It does not save anything: the app shows a preview with an Execute button.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Transaction id exactly as returned by list_transactions" },
        kind: { type: "string", enum: ["expense", "income"] },
        amount_kwd: money("New amount"),
        date: date("New date"),
        category: { type: "string", enum: [...new Set([...AI_EXPENSE_CATEGORIES, ...AI_INCOME_CATEGORIES])], description: "New category label" },
        merchant: { type: "string", description: "New merchant, 1 to 60 characters" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "propose_add_obligation",
    description: "Prepares a NEW fixed obligation (installment, subscription or regular payment) for the user to approve. For a monthly payment on the 25th use recurrence monthly and day_of_month 25. It does not save anything: the app shows a preview with an Execute button.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Obligation name, 1 to 60 characters, e.g. the service or creditor" },
        amount_kwd: money("Amount of each payment"),
        day_of_month: { type: "integer", description: "Day of the month it is due, 1 to 31" },
        recurrence: { type: "string", enum: AI_RECURRENCES, description: "How often it repeats, default monthly" },
        category: { type: "string", enum: AI_OBLIGATION_CATEGORIES, description: "Obligation category label, default أخرى" },
        payment_method: { type: "string", enum: AI_PAYMENT_METHODS, description: "bank = deducted from the account (default), credit_card, cash, other" },
        first_due_date: date("First due date. Optional: when omitted the app uses the next occurrence of day_of_month. Required for recurrence once. Its day must equal day_of_month"),
        note: { type: "string", description: "Optional note, max 120 characters" }
      },
      required: ["name", "amount_kwd", "day_of_month"],
      additionalProperties: false
    }
  },
  {
    name: "propose_mark_obligation_paid",
    description: "Prepares marking ONE existing obligation as paid (or as not paid) for one of its due dates, for the user to approve. First find its exact id and due date with list_obligations. It does not save anything: the app shows a preview with an Execute button where the user also chooses whether the amount is deducted from the cash balance.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Obligation id exactly as returned by list_obligations" },
        due_date: date("The due date of the occurrence, exactly as returned by list_obligations (defaults to the occurrence of the current month)"),
        paid: { type: "boolean", description: "true to mark paid (default), false to remove a recorded payment" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "propose_set_budget",
    description: "Prepares changing the monthly budget limit of ONE expense category for the user to approve. First read the current budgets with list_budgets to use the exact category label. A limit of \"0\" removes the budget. It does not save anything: the app shows a preview with an Execute button.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: AI_EXPENSE_CATEGORIES, description: "Exact category label" },
        limit_kwd: money("New monthly limit for the category (\"0\" removes it)")
      },
      required: ["category", "limit_kwd"],
      additionalProperties: false
    }
  }
];

export const AI_CLIENT_TOOLS = [...AI_READ_TOOLS, ...AI_WRITE_TOOLS];
export const AI_READ_TOOL_NAMES = new Set(AI_READ_TOOLS.map((tool) => tool.name));
export const AI_WRITE_TOOL_NAMES = new Set(AI_WRITE_TOOLS.map((tool) => tool.name));
export const AI_TOOL_NAMES = new Set(AI_CLIENT_TOOLS.map((tool) => tool.name));
