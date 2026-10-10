// شاشة «المحاسب الذكي»: محادثة عربية RTL تنفذ حلقة الأدوات مع Claude عبر الـWorker.
// - حالة المحادثة في ذاكرة الصفحة فقط (تنمسح مع القفل والتبديل لمحادثة جديدة). المحفوظ على الجهاز: رمز الربط وسجل التغييرات للتراجع.
// - لا يغيّر أي بيانات إلا من زر «تنفيذ» على معاينة بناها كود التطبيق، وبفحص أن البيانات ما تغيّرت منذ المعاينة.
// - كل نص قادم من النموذج أو الإنترنت أو بيانات المستخدم يمر عبر esc()، والروابط https فقط مع rel=noopener.
import { createId as defaultCreateId } from "./finance-core.js";
import { AI_CONSENT_VERSION, JOURNAL_MAX, aiErrorMessage, compactMessages, createAiClient, readAiStore, tokenUsable, writeAiStore } from "./ai-client.js";
import { AI_READ_TOOL_NAMES, AI_WRITE_TOOL_NAMES } from "./ai-tool-schemas.js";
import { applyProposal, buildEvidence, buildProposal, checkNumbers, liveCashChoice, proposalToolResult, runReadTool, undoEntry } from "./ai-tools.js";

const MAX_STEPS = 10;
const MAX_INPUT = 2000;
const STEP_LABELS = {
  get_overview: "أراجع وضعك المالي", list_transactions: "أقرأ عملياتك", list_budgets: "أقرأ ميزانياتك", list_obligations: "أقرأ التزاماتك",
  list_debts: "أقرأ ديونك", analyze_spending: "أحسب مصروفك", financial_position: "أحلل وضعك المالي"
};
const EXAMPLES = [
  "كم صرفت هالشهر على المطاعم؟",
  "خلّ ميزانية المطاعم 80 دينار",
  "أضف التزام إنترنت 15 دينار يوم 25 من كل شهر",
  "شنو آخر سعر لسهم الجزيرة؟"
];

const esc = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));

export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return { href: url.href, host: url.hostname };
  } catch { return null; }
}

/* يطلع النص والمصادر وعمليات البحث من بلوكات رد Claude (نص مع citations، server_tool_use، web_search_tool_result) */
export function extractDisplay(content) {
  const texts = [];
  const sources = new Map();
  const searches = [];
  let searchError = "";
  const addSource = (url, title) => {
    const safe = safeUrl(url);
    if (!safe || sources.has(safe.href)) return;
    sources.set(safe.href, { href: safe.href, host: safe.host, title: String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || safe.host });
  };
  const cited = new Map();
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      for (const citation of Array.isArray(block.citations) ? block.citations : []) {
        addSource(citation?.url, citation?.title);
        const safe = safeUrl(citation?.url);
        if (safe) cited.set(safe.href, true);
      }
    } else if (block?.type === "server_tool_use" && block.name === "web_search") {
      const query = typeof block.input?.query === "string" ? block.input.query.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      if (query) searches.push(query);
    } else if (block?.type === "web_search_tool_result") {
      if (Array.isArray(block.content)) {
        for (const item of block.content.slice(0, 5)) if (item?.type === "web_search_result") addSource(item.url, item.title);
      } else if (block.content?.type === "web_search_tool_result_error") {
        searchError = String(block.content.error_code ?? "error").slice(0, 40);
      }
    }
  }
  const ordered = [...sources.values()];
  // نعرض المصادر المقتبسة أولاً؛ لو ما فيه اقتباس نعرض أول نتائج البحث
  const citedList = ordered.filter((item) => cited.has(item.href));
  return { text: texts.join("").trim(), sources: (citedList.length ? citedList : ordered).slice(0, 6), searches, searchError, usedSearch: searches.length > 0 || ordered.length > 0 };
}

function formatFetchedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try { return new Intl.DateTimeFormat("ar-KW-u-nu-latn", { timeZone: "Asia/Kuwait", dateStyle: "medium", timeStyle: "short" }).format(date); } catch { return date.toISOString(); }
}

export function mountAssistant(root, hooks) {
  const client = hooks.client ?? createAiClient({ base: hooks.base, fetchImpl: hooks.fetchImpl, storage: hooks.storage, now: hooks.now });
  const storage = hooks.storage ?? globalThis.localStorage;
  const nowMs = hooks.now ?? (() => Date.now());
  const createId = hooks.createId ?? defaultCreateId;
  const S = {
    phase: "boot", note: "", messages: [], thread: [], proposals: new Map(), notes: [], banner: null, cost: null,
    busy: false, busyLabel: "", controller: null, epoch: 0, pairing: false, pairError: "", lastText: "", booting: false, trimNoticeShown: false
  };

  root.innerHTML = `
    <div class="ai-shell">
      <section class="panel ai-gate" data-ai-gate hidden></section>
      <section class="ai-chat" data-ai-chat hidden>
        <div class="ai-thread" data-ai-thread role="log" aria-live="polite" aria-label="محادثة المحاسب الذكي"></div>
        <div class="ai-banner" data-ai-banner role="alert" hidden></div>
        <form class="ai-composer" data-ai-composer novalidate>
          <textarea data-ai-input rows="2" maxlength="${MAX_INPUT}" aria-label="اكتب سؤالك للمحاسب الذكي" placeholder="اسأل عن مصاريفك أو اطلب تعديلاً"></textarea>
          <div class="ai-composer-actions">
            <button type="button" class="ghost" data-ai-act="new">محادثة جديدة</button>
            <button type="submit" class="primary" data-ai-send>إرسال</button>
          </div>
        </form>
        <p class="hint ai-meta" data-ai-meta></p>
      </section>
      <section class="panel ai-journal" data-ai-journal hidden></section>
    </div>`;
  const $q = (selector) => root.querySelector(selector);
  const gate = $q("[data-ai-gate]");
  const chat = $q("[data-ai-chat]");
  const threadEl = $q("[data-ai-thread]");
  const banner = $q("[data-ai-banner]");
  const input = $q("[data-ai-input]");
  const sendButton = $q("[data-ai-send]");
  const metaEl = $q("[data-ai-meta]");
  const journalEl = $q("[data-ai-journal]");

  const locked = () => Boolean(hooks.isLocked?.());
  const context = () => ({ state: hooks.getState(), todayISO: hooks.todayISO(), nowISO: () => new Date(nowMs()).toISOString(), createId, isLocked: locked });

  /* ---------- العرض ---------- */
  function renderGate() {
    gate.hidden = S.phase === "chat";
    chat.hidden = S.phase !== "chat";
    if (S.phase === "chat") return;
    if (S.phase === "boot") gate.innerHTML = `<p class="hint" role="status">أجهّز المحاسب الذكي…</p>`;
    else if (S.phase === "unavailable") {
      gate.innerHTML = `<h2>المحاسب الذكي غير جاهز</h2><p>${esc(S.note)}</p><div class="dialog-actions-inline"><button type="button" class="secondary" data-ai-act="recheck">تحقق من جديد</button></div>`;
    } else if (S.phase === "consent") {
      gate.innerHTML = `
        <span class="eyebrow">قبل ما تبدأ</span>
        <h2>وين تروح بياناتك؟</h2>
        <ul class="ai-disclosure">
          <li>${S.provider === "workers-ai"
            ? "المحاسب الذكي يعمل بنموذج ذكاء اصطناعي مفتوح يشتغل على خدمة Workers AI من Cloudflare بحسابك. أسئلتك تُرسل لخدمة حوّش على Cloudflare ومنها للنموذج لتوليد الرد. تقول Cloudflare إنها ما تستخدم محتواك لتدريب النماذج، ولا تعلن أنها لا تحتفظ به."
            : "المحاسب الذكي يعمل بنموذج Claude من شركة Anthropic. أسئلتك تُرسل لخدمة حوّش على Cloudflare ومنها للنموذج لتوليد الرد."}</li>
          <li>النموذج ما يشوف كل بياناتك. التطبيق يرسل فقط الجزء الذي يطلبه لجواب سؤالك، مثل عمليات فترة معيّنة (التاريخ والمبلغ والفئة واسم التاجر) أو الميزانيات أو الالتزامات أو الديون.</li>
          <li>لا يُرسل أبداً: ملف النسخة الاحتياطية، نصوص الإشعارات الخام، أرقام البطاقات.</li>
          <li>${S.provider === "workers-ai"
            ? "البحث في الإنترنت غير متاح في هذي النسخة المجانية، فما يجيب لك أسعاراً من النت."
            : "البحث في الإنترنت يتم بكلمات عامة مثل اسم سهم، بدون بياناتك الشخصية، وتظهر لك المصادر ووقت الجلب."}</li>
          <li>لا يتغير شي في بياناتك إلا بعد ما تشوف معاينة وتضغط «تنفيذ»، وتقدر ترجّع التغيير بزر «تراجع».</li>
          <li>الأرقام يحسبها كود التطبيق لا النموذج، وإذا ظهر رقم لا نقدر نطابقه مع بياناتك أو مع مصدر نعلّمك بتنبيه.</li>
          <li>المحادثة تبقى في ذاكرة الصفحة فقط وتنمسح عند قفل التطبيق. المحفوظ على جهازك: رمز الربط وسجل آخر التغييرات.</li>
          <li>للخدمة حدّ تكلفة يومي وشهري يحدده صاحب التطبيق.</li>
        </ul>
        <div class="dialog-actions-inline"><button type="button" class="primary" data-ai-act="consent">أوافق وأكمل</button></div>`;
    } else if (S.phase === "pair") {
      gate.innerHTML = `
        <span class="eyebrow">ربط هذا الجهاز</span>
        <h2>اكتب رمز الربط</h2>
        <p>الرمز الذي حددته أنت في إعدادات الخدمة. يُطلب مرة واحدة لكل جهاز ويبقى الجهاز مربوطاً لمدة 90 يوماً.</p>
        <form data-ai-pair novalidate>
          <label class="field"><span>رمز الربط</span><input type="password" data-ai-code autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="200" ${S.pairing ? "disabled" : ""}></label>
          <p class="form-error" role="alert">${esc(S.pairError)}</p>
          <div class="dialog-actions-inline"><button type="submit" class="primary" ${S.pairing ? "disabled" : ""}>${S.pairing ? "أربط…" : "ربط"}</button></div>
        </form>`;
    }
  }

  function renderProposal(proposal) {
    const ui = proposal.ui ?? {};
    const lines = proposal.lines.map((item) => item.after !== undefined
      ? `<div><dt>${esc(item.label)}</dt><dd><bdi>${esc(item.before)}</bdi> ← <bdi>${esc(item.after)}</bdi></dd></div>`
      : `<div><dt>${esc(item.label)}</dt><dd><bdi>${esc(item.value)}</bdi></dd></div>`).join("");
    const warnings = proposal.warnings.map((text) => `<p class="warn-hint">⚠ ${esc(text)}</p>`).join("");
    const disabled = S.busy ? " disabled" : "";
    let footer;
    if (proposal.status === "pending") {
      // أرقام الخصم تُحسب من الرصيد الحالي كل مرة نرسم، واختيار المستخدم محفوظ على الاقتراح فما يرجع للافتراضي مع إعادة الرسم
      const live = proposal.cashChoice ? liveCashChoice(proposal, context()) : null;
      const cash = live
        ? `<label class="ai-check"><input type="checkbox" data-ai-cash="${esc(proposal.id)}"${proposal.deductCash === false ? "" : " checked"}> <span>اخصم <bdi>${esc(live.deductDisplay)}</bdi> من رصيدي النقدي (<bdi>${esc(live.cashDisplay)}</bdi> ← <bdi>${esc(live.afterDisplay)}</bdi>)</span></label>` : "";
      footer = `${cash}<div class="ai-proposal-actions"><button type="button" class="primary" data-ai-act="exec" data-id="${esc(proposal.id)}"${disabled}>تنفيذ</button><button type="button" class="secondary" data-ai-act="cancel" data-id="${esc(proposal.id)}"${disabled}>إلغاء</button></div>`;
    } else if (proposal.status === "executed") {
      const entry = ui.entryId ? readAiStore(storage).journal.find((item) => item.id === ui.entryId) : null;
      footer = `<p class="ai-status ok" role="status">✓ ${esc(ui.message ?? "تم التنفيذ")}</p>${entry && !entry.undone ? `<button type="button" class="secondary" data-ai-act="undo" data-eid="${esc(entry.id)}">تراجع</button>` : entry?.undone ? `<p class="ai-status">تم التراجع عن هذا التغيير</p>` : ""}`;
    } else if (proposal.status === "cancelled") footer = `<p class="ai-status">أُلغي الاقتراح</p>`;
    else if (proposal.status === "stale") footer = `<p class="ai-status warn" role="alert">تغيّرت البيانات منذ المعاينة فما نفّذت شي. اطلب مني الاقتراح من جديد.</p>`;
    else footer = `<p class="ai-status warn" role="alert">${esc(ui.message ?? "ما قدرت أنفّذ")}</p>`;
    return `<article class="ai-proposal" data-pid="${esc(proposal.id)}" data-status="${esc(proposal.status)}" aria-label="${esc(proposal.title)}">
      <div class="ai-proposal-head"><span class="pill">اقتراح</span><h3>${esc(proposal.title)}</h3></div>
      <dl class="ai-lines">${lines}</dl>${warnings}${footer}</article>`;
  }

  function renderItem(item) {
    if (item.kind === "user") return `<div class="ai-msg ai-user"><p class="ai-text">${esc(item.text)}</p></div>`;
    if (item.kind === "notice") return `<p class="ai-notice${item.warn ? " warn" : ""}">${esc(item.text)}</p>`;
    if (item.kind === "proposal") { const proposal = S.proposals.get(item.id); return proposal ? renderProposal(proposal) : ""; }
    const searches = item.searches.length ? `<p class="ai-searches">${item.searches.map((query) => `<span class="ai-chip">بحث: ${esc(query)}</span>`).join(" ")}</p>` : "";
    const flag = item.unmatched?.length ? `<p class="ai-flag warn-hint" role="note">⚠ ما قدرت أطابق هذه الأرقام مع بياناتك أو مع مصدر مذكور: ${item.unmatched.map((number) => `<bdi>${esc(number)}</bdi>`).join("، ")}. لا تعتمد عليها قبل ما تتأكد.</p>` : "";
    const sources = item.sources.length
      ? `<div class="ai-sources"><strong>المصادر</strong><ul>${item.sources.map((source) => `<li><a href="${esc(source.href)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a> <bdi class="ai-host">${esc(source.host)}</bdi></li>`).join("")}</ul>${item.fetchedAt ? `<small>وقت الجلب: <bdi>${esc(item.fetchedAt)}</bdi> بتوقيت الكويت. السعر المعروض هو ما يظهر في المصدر وقد يكون متأخراً.</small>` : ""}</div>`
      : item.searchError ? `<p class="ai-notice warn">ما قدرت أبحث في الإنترنت الحين.</p>`
        : item.usedSearch ? `<p class="ai-notice warn">ما ظهرت مصادر بروابط آمنة مع هذا الرد، فلا تعتمد على أي رقم فيه قبل ما تتأكد منه.${item.fetchedAt ? ` وقت الجلب: <bdi>${esc(item.fetchedAt)}</bdi> بتوقيت الكويت.` : ""}</p>` : "";
    return `<div class="ai-msg ai-bot">${item.text ? `<p class="ai-text">${esc(item.text)}</p>` : ""}${searches}${flag}${sources}</div>`;
  }

  function renderThread() {
    if (S.phase !== "chat") return;
    const items = S.thread.map(renderItem).join("");
    const empty = !S.thread.length && !S.busy
      ? `<div class="ai-empty"><p>اسألني عن مصاريفك وميزانياتك والتزاماتك وديونك، أو اطلب مني تجهيز تعديل تراجعه وتنفّذه بنفسك.</p><div class="ai-examples">${EXAMPLES.map((text) => `<button type="button" class="ghost" data-ai-act="example" data-text="${esc(text)}">${esc(text)}</button>`).join("")}</div></div>` : "";
    const busy = S.busy ? `<p class="ai-busy" role="status"><span class="ai-dots" aria-hidden="true"></span> ${esc(S.busyLabel || "المحاسب يفكر")}… <button type="button" class="link-button" data-ai-act="stop">إيقاف</button></p>` : "";
    threadEl.innerHTML = `${empty}${items}${busy}`;
    sendButton.disabled = S.busy;
    input.disabled = false;
    renderBanner();
    renderMeta();
  }

  function renderBanner() {
    if (!S.banner) { banner.hidden = true; banner.innerHTML = ""; return; }
    banner.hidden = false;
    const actions = [S.banner.retry ? `<button type="button" class="secondary" data-ai-act="retry">إعادة المحاولة</button>` : "", S.banner.pair ? `<button type="button" class="secondary" data-ai-act="repair">ربط الجهاز</button>` : ""].join("");
    banner.innerHTML = `<p>${esc(S.banner.text)}</p>${actions ? `<div class="ai-banner-actions">${actions}</div>` : ""}`;
  }

  function renderMeta() {
    const parts = [];
    if (S.cost && Number.isFinite(S.cost.dayUsd)) parts.push(`تقدير تكلفة اليوم: <bdi>$${S.cost.dayUsd.toFixed(3)}</bdi> من حد <bdi>$${Number(S.cost.dayCapUsd).toFixed(2)}</bdi>`);
    parts.push(`<button type="button" class="link-button" data-ai-act="unpair">فصل هذا الجهاز</button>`);
    metaEl.innerHTML = parts.join(" · ");
  }

  function renderJournal() {
    const store = readAiStore(storage);
    const entries = store.journal.slice(0, 8);
    journalEl.hidden = S.phase !== "chat" || entries.length === 0;
    if (journalEl.hidden) { journalEl.innerHTML = ""; return; }
    journalEl.innerHTML = `<h2>آخر التغييرات من المحاسب</h2><ul class="ai-journal-list">${entries.map((entry) => `
      <li><div><strong>${esc(entry.title)}</strong><small><bdi>${esc(formatFetchedAt(entry.at) || entry.at.slice(0, 16).replace("T", " "))}</bdi></small>
      ${entry.summary.slice(0, 3).map((text) => `<small>${esc(text)}</small>`).join("")}</div>
      ${entry.undone ? `<span class="pill">تم التراجع</span>` : `<button type="button" class="secondary" data-ai-act="undo" data-eid="${esc(entry.id)}">تراجع</button>`}</li>`).join("")}</ul>`;
  }

  function renderAll() { renderGate(); renderThread(); renderJournal(); }

  /* ---------- حالة المحادثة ---------- */
  function resetConversation({ keepCost = true } = {}) {
    S.epoch += 1;
    S.controller?.abort();
    S.controller = null;
    S.busy = false; S.busyLabel = "";
    S.messages = []; S.thread = []; S.proposals = new Map(); S.notes = []; S.banner = null; S.lastText = ""; S.trimNoticeShown = false;
    if (!keepCost) S.cost = null;
  }

  function rollbackTurn(messageCount, threadCount, keepUserBubble) {
    S.messages.length = messageCount;
    for (const item of S.thread.slice(threadCount + (keepUserBubble ? 1 : 0))) if (item.kind === "proposal") S.proposals.delete(item.id);
    S.thread.length = threadCount + (keepUserBubble ? 1 : 0);
  }

  // أخطاء ما تفيد معها إعادة المحاولة الفورية (الربط، حجم المحادثة، حدود التكلفة، الخدمة غير مفعّلة، موقع غير مسموح)
  const NO_RETRY_ERRORS = new Set(["unauthorized", "too_large", "bad_request", "budget_day", "budget_month", "not_configured", "upstream_not_configured", "origin"]);

  function failTurn(result, checkpoint, { keepBubble = true } = {}) {
    rollbackTurn(checkpoint.messages, checkpoint.thread, keepBubble);
    S.banner = { text: aiErrorMessage(result), retry: !NO_RETRY_ERRORS.has(result.error), pair: result.error === "unauthorized" };
    if (result.error === "unauthorized") { S.phase = "pair"; S.pairError = ""; }
    if (result.error === "aborted") { S.banner = null; S.thread.push({ kind: "notice", text: "أوقفت الطلب." }); }
  }

  /* ---------- حلقة الأدوات ---------- */
  function runTool(block) {
    const ctx = context();
    if (AI_READ_TOOL_NAMES.has(block.name)) {
      const outcome = runReadTool(block.name, block.input ?? {}, ctx);
      return { type: "tool_result", tool_use_id: block.id, content: outcome.text, ...(outcome.ok ? {} : { is_error: true }) };
    }
    if (AI_WRITE_TOOL_NAMES.has(block.name)) {
      const built = buildProposal(block.name, block.input ?? {}, ctx);
      if (!built.ok) return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ status: "rejected", error: built.error, message: built.message }), is_error: true };
      S.proposals.set(built.proposal.id, built.proposal);
      S.thread.push({ kind: "proposal", id: built.proposal.id });
      return { type: "tool_result", tool_use_id: block.id, content: proposalToolResult(built.proposal) };
    }
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: "unknown_tool" }), is_error: true };
  }

  async function runTurn(text) {
    if (S.busy || S.phase !== "chat" || locked()) return;
    const clean = String(text ?? "").trim().slice(0, MAX_INPUT);
    if (!clean) return;
    S.busy = true; S.busyLabel = "المحاسب يفكر"; S.banner = null; S.lastText = clean;
    const epoch = S.epoch;
    const checkpoint = { messages: S.messages.length, thread: S.thread.length };
    const noteLine = S.notes.length ? `\n[ملاحظات من التطبيق: ${S.notes.join(" ")}]` : "";
    const notesSent = S.notes.length;
    S.messages.push({ role: "user", content: [{ type: "text", text: `[التاريخ اليوم: ${hooks.todayISO()}]${noteLine}\n${clean}` }] });
    S.thread.push({ kind: "user", text: clean });
    S.controller = new AbortController();
    renderThread();
    const signal = S.controller.signal;
    const stale = () => S.epoch !== epoch || locked();
    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const packed = compactMessages(S.messages);
        if (!packed.fits) { failTurn({ error: "too_large" }, checkpoint); break; }
        if (packed.dropped) {
          S.messages = packed.messages; checkpoint.messages = Math.max(checkpoint.messages - packed.dropped, 0);
          if (!S.trimNoticeShown) { S.trimNoticeShown = true; S.thread.push({ kind: "notice", text: "المحادثة طالت، فنسيت أقدم الأسئلة عشان أكمل. تبقى ظاهرة هنا." }); }
        }
        const result = await client.chat(S.messages, { signal });
        if (stale()) return;
        if (!result.ok) { failTurn(result, checkpoint); break; }
        const reply = result.message;
        if (!reply || !Array.isArray(reply.content)) { failTurn({ error: "upstream_error" }, checkpoint); break; }
        // رد مقطوع بحد الطول أو مرفوض: ما نخزن نداء أداة ناقص (ما له ردّ) ولا رسالة فاضية، لأن الـWorker يرفض هذا السجل وتنكسر المحادثة
        const completeCalls = reply.stop_reason === "tool_use" || reply.stop_reason === "pause_turn";
        let stored = completeCalls ? reply.content : reply.content.filter((block) => block?.type !== "tool_use");
        if (!stored.some((block) => block && block.type !== "thinking" && block.type !== "redacted_thinking")) stored = [...stored, { type: "text", text: "(لم يكتمل الرد)" }];
        // بعد pause_turn نرسل رد المساعد المتوقف كما هو، والرد الجديد يكمله: نخزنهما رسالة وحدة حتى يبقى تناوب الأدوار سليماً
        const previous = S.messages.at(-1);
        if (previous?.role === "assistant") S.messages[S.messages.length - 1] = { role: "assistant", content: [...previous.content, ...stored] };
        else S.messages.push({ role: "assistant", content: stored });
        S.cost = result.cost ?? S.cost;
        const display = extractDisplay(reply.content);
        if (display.text || display.sources.length || display.searches.length || display.searchError) {
          const check = display.text ? checkNumbers(display.text, buildEvidence(S.messages)) : { unmatched: [] };
          S.thread.push({ kind: "assistant", ...display, unmatched: check.unmatched, fetchedAt: display.usedSearch ? formatFetchedAt(result.fetchedAt) : "" });
        }
        if (Array.isArray(result.warnings) && result.warnings.includes("search_unavailable") && !S.thread.some((item) => item.kind === "notice" && item.search)) {
          const free = S.provider === "workers-ai";
          S.thread.push({ kind: "notice", search: true, warn: !free, text: free ? "المحاسب هنا يجاوب من بياناتك فقط وما يبحث بالإنترنت، فلا تعتمد عليه بالأسعار." : "البحث في الإنترنت غير متاح حالياً، فالرد من بياناتك فقط." });
        }
        const calls = reply.content.filter((block) => block?.type === "tool_use");
        if (reply.stop_reason === "tool_use" && calls.length) {
          S.busyLabel = calls.some((block) => AI_WRITE_TOOL_NAMES.has(block.name)) ? "أجهّز الاقتراح" : (STEP_LABELS[calls[0].name] ?? "أراجع بياناتك");
          renderThread();
          S.messages.push({ role: "user", content: calls.map(runTool) });
          if (stale()) return;
          continue;
        }
        if (reply.stop_reason === "pause_turn") { S.busyLabel = "أبحث في الإنترنت"; renderThread(); continue; }
        // رد منتهي بدون أي نص ولا اقتراح ولا مصدر: ما نخلي المحادثة تبدو ردّت، نرجّع للنقطة السليمة ونعرض «إعادة المحاولة»
        if (reply.stop_reason !== "max_tokens" && reply.stop_reason !== "refusal" && !S.thread.slice(checkpoint.thread + 1).some((item) => item.kind === "assistant" || item.kind === "proposal")) {
          failTurn({ error: "empty_reply" }, checkpoint); break;
        }
        if (reply.stop_reason === "max_tokens") S.thread.push({ kind: "notice", text: "انقطع الرد لأنه طويل. اطلب مني أختصر أو أسأل سؤال أضيق.", warn: true });
        if (reply.stop_reason === "refusal") S.thread.push({ kind: "notice", text: "المساعد رفض يكمل هذا الطلب.", warn: true });
        S.notes.splice(0, notesSent);
        break;
      }
      if (S.messages.length && S.messages.at(-1).role === "user" && S.messages.at(-1).content.some?.((block) => block.type === "tool_result")) {
        // خرجنا بحد الخطوات وآخر رسالة ردود أدوات: نرجّع المحادثة لنقطة سليمة ونعلّم المستخدم
        rollbackTurn(checkpoint.messages, checkpoint.thread, true);
        S.banner = { text: "الطلب احتاج خطوات أكثر من المسموح. جرب سؤالاً أضيق.", retry: false };
      }
    } finally {
      if (S.epoch === epoch) {
        S.busy = false; S.busyLabel = ""; S.controller = null;
        renderAll();
        if (!stale()) input.focus({ preventScroll: true });
      }
    }
  }

  /* ---------- التنفيذ والتراجع ---------- */
  function saveEntry(entry) {
    const store = readAiStore(storage);
    store.journal = [entry, ...store.journal.filter((item) => item.id !== entry.id)].slice(0, JOURNAL_MAX);
    writeAiStore(store, storage);
  }

  function markEntryUndone(entryId) {
    const store = readAiStore(storage);
    const entry = store.journal.find((item) => item.id === entryId);
    if (entry) { entry.undone = new Date(nowMs()).toISOString(); writeAiStore(store, storage); }
  }

  function executeProposal(id) {
    const proposal = S.proposals.get(id);
    if (!proposal || proposal.status !== "pending" || S.busy) return;
    if (locked()) { hooks.toast?.("افتح القفل أولاً."); return; }
    const deductCash = Boolean(proposal.cashChoice) && proposal.deductCash !== false;
    const ctx = context();
    const result = applyProposal(proposal, ctx, { deductCash });
    proposal.ui = { message: result.message };
    if (!result.ok) { renderThread(); return; }
    const saved = hooks.commit(result.message);
    if (!saved) {
      undoEntry(result.entry, ctx);
      proposal.status = "failed";
      proposal.ui = { message: "ما انحفظ التغيير على الجهاز فتراجعت عنه." };
      hooks.refresh?.();
      renderAll();
      return;
    }
    saveEntry(result.entry);
    proposal.ui = { message: result.message, entryId: result.entry.id };
    S.notes.push(`المستخدم نفّذ الاقتراح ${proposal.id} (${proposal.title}).`);
    renderAll();
  }

  function cancelProposal(id) {
    const proposal = S.proposals.get(id);
    if (!proposal || proposal.status !== "pending") return;
    proposal.status = "cancelled";
    S.notes.push(`المستخدم ألغى الاقتراح ${proposal.id} (${proposal.title}).`);
    renderAll();
  }

  function undoJournal(entryId) {
    if (locked()) return;
    const entry = readAiStore(storage).journal.find((item) => item.id === entryId);
    if (!entry || entry.undone) return;
    const result = undoEntry(entry, context());
    if (!result.ok) { hooks.toast?.(result.message); return; }
    hooks.commit(result.message);
    markEntryUndone(entryId);
    S.notes.push(`المستخدم تراجع عن التغيير (${entry.title}).`);
    renderAll();
  }

  /* ---------- التفعيل والربط ---------- */
  async function activate() {
    if (locked() || S.booting) return;
    if (S.phase === "chat") { renderAll(); return; }
    S.booting = true;
    const store = readAiStore(storage);
    S.phase = "boot"; renderAll();
    const status = await client.status();
    S.booting = false;
    if (locked()) return;
    S.provider = status.ok && status.provider === "workers-ai" ? "workers-ai" : "anthropic";
    if (!status.ok) {
      S.phase = "unavailable";
      S.note = aiErrorMessage(status);
    } else if (!status.configured) {
      S.phase = "unavailable";
      S.note = "المحاسب الذكي غير مفعّل بعد على الخدمة. يلزم إضافة رمز المالك في Cloudflare، ومفتاح Claude اختياري.";
    } else if (store.consentVersion < AI_CONSENT_VERSION) S.phase = "consent";
    else if (!tokenUsable(store, nowMs())) { S.phase = "pair"; S.pairError = ""; }
    else S.phase = "chat";
    renderAll();
  }

  function giveConsent() {
    const store = readAiStore(storage);
    writeAiStore({ ...store, consentVersion: AI_CONSENT_VERSION, consentAt: new Date(nowMs()).toISOString() }, storage);
    S.phase = tokenUsable(readAiStore(storage), nowMs()) ? "chat" : "pair";
    renderAll();
  }

  async function submitPair(form) {
    if (S.pairing) return;
    const field = form.querySelector("[data-ai-code]");
    const code = field.value;
    S.pairing = true; S.pairError = ""; renderGate();
    const result = await client.pair(code);
    S.pairing = false;
    if (locked()) return;
    let resend = "";
    if (result.ok) {
      S.phase = "chat"; S.pairError = "";
      // انتهى الربط بعد ما فشل سؤال بسبب «انتهت الصلاحية»: الطلب ما وصل Claude ولا انحسب، فنعيده تلقائياً بدل ما يكتبه المستخدم من جديد
      if (S.banner?.pair && S.lastText && !S.busy && S.thread.at(-1)?.kind === "user") { resend = S.lastText; rollbackTurn(S.messages.length, S.thread.length - 1, false); }
      S.banner = null;
    } else S.pairError = aiErrorMessage(result);
    renderAll();
    if (resend) runTurn(resend);
  }

  /* ---------- الأحداث ---------- */
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ai-act]");
    if (!button || !root.contains(button)) return;
    const act = button.dataset.aiAct;
    if (act === "consent") giveConsent();
    else if (act === "recheck") { S.phase = "boot"; activate(); }
    else if (act === "exec") executeProposal(button.dataset.id);
    else if (act === "cancel") cancelProposal(button.dataset.id);
    else if (act === "undo") undoJournal(button.dataset.eid);
    else if (act === "stop") S.controller?.abort();
    else if (act === "new") { resetConversation(); renderAll(); }
    else if (act === "example") { input.value = button.dataset.text ?? ""; input.focus(); }
    else if (act === "retry") { const text = S.lastText; rollbackTurn(S.messages.length, S.thread.length - 1, false); S.banner = null; runTurn(text); }
    else if (act === "repair") { S.phase = "pair"; S.pairError = ""; renderAll(); }
    else if (act === "unpair") { resetConversation(); client.unpair(); S.phase = "consent"; renderAll(); }
  });
  root.addEventListener("change", (event) => {
    const box = event.target.closest?.("[data-ai-cash]");
    const proposal = box ? S.proposals.get(box.dataset.aiCash) : null;
    if (proposal && proposal.status === "pending") proposal.deductCash = box.checked;
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.target.matches("[data-ai-pair]")) submitPair(event.target);
    else if (event.target.matches("[data-ai-composer]")) {
      const text = input.value;
      if (!text.trim() || S.busy || S.phase !== "chat" || locked()) return;
      input.value = ""; input.style.height = "";
      runTurn(text);
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $q("[data-ai-composer]").requestSubmit(); }
  });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });

  /* يفضّي الشاشة كلها (المحادثة، المسودة، الرمز المكتوب، السجل) من الـDOM. المحفوظ على القرص ما يتغير هنا. */
  function clearView() {
    input.value = ""; input.style.height = "";
    threadEl.innerHTML = ""; banner.innerHTML = ""; banner.hidden = true; journalEl.innerHTML = ""; journalEl.hidden = true; gate.innerHTML = ""; metaEl.innerHTML = "";
    const code = root.querySelector("[data-ai-code]");
    if (code) code.value = "";
  }
  function reset() {
    resetConversation({ keepCost: false });
    clearView();
    S.phase = "boot"; S.booting = false; S.pairing = false; S.pairError = "";
    renderGate();
  }

  return {
    activate,
    /* القفل: نوقف الطلب الجاري ونمسح المحادثة والاقتراحات والمسودة من الذاكرة والـDOM. سجل التراجع يبقى على القرص.
       بعد الفتح يعيد التطبيق تفعيل الشاشة (activate) فتتحقق من الخدمة والموافقة والربط من جديد. */
    onLock: reset,
    /* مسح البيانات أو «نسيت الرمز»: نفس التنظيف، والتطبيق يعيد التفعيل لو الشاشة مفتوحة. */
    wipe: reset,
    debug: () => ({ phase: S.phase, busy: S.busy, messages: S.messages.length, thread: S.thread.length, proposals: S.proposals.size })
  };
}
