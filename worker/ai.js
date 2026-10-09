// مسارات «المحاسب الذكي» (/api/ai/*): وسيط آمن لـ Claude. المفتاح ما يطلع من الـWorker،
// والعميل يرسل messages فقط؛ النظام والأدوات والنموذج كلها من عندنا.
// الأسرار (لا تُكتب بأي ملف): ANTHROPIC_API_KEY، AI_OWNER_CODE (12 حرفاً فأكثر).
// متغيرات اختيارية: AI_MODEL، AI_EFFORT، AI_MAX_TOKENS، AI_DAILY_USD_CAP، AI_MONTHLY_USD_CAP، AI_TOKEN_EPOCH (تغييره يبطل كل الرموز)،
// AI_ALLOWED_ORIGINS، AI_WEB_SEARCH_TOOL (web_search_20250305 فقط)، AI_FALLBACKS ("off" يوقفها)، AI_PRICE_IN_PER_MTOK،
// AI_PRICE_OUT_PER_MTOK، AI_PRICE_SEARCH_PER_K، AI_API_BASE (محلي للاختبار فقط).
// AI_PAIR_RESET: نص حتى 64 حرفاً يدخل في بصمة قفل الاقتران فقط؛ تغييره يفك القفل بدون إبطال أي رمز (المخرج لو أحد قفل الاقتران).
// بصمة القفل = AI_TOKEN_EPOCH + بصمات مقتطعة من رمز المالك ومفتاح Anthropic وAI_PAIR_RESET، فتدوير أي منها يفك القفل أيضاً.
// deps للاختبار والتشغيل: { fetch, now, sleep, timeoutMs, flags, waitUntil }. waitUntil (من ctx بنقطة الدخول) يبقي تحرير علامة الطلب
// شغّالاً حتى لو انقطع الاتصال، وهو اختياري.
import {
  AI_VERSION, AiError, DEVICE_PATTERN, MAX_CHAT_BYTES, MAX_PAIR_BYTES, MAX_UPSTREAM_BYTES, RETRY_DELAY_MS, UPSTREAM_TIMEOUT_MS, aiFlags, apiKeyOf, bearerToken, buildUpstream,
  costOf, errorBody, failureKind, hasThinking, isConfigured, mapUpstreamStatus, normalizeUsage, originAllowed, ownerCodeMatches, parseReply, readBodyCapped, readConfig,
  ownerCodeOf, pairFingerprint, round6, secretsOf, sha256Hex, signToken, stripThinking, validateMessages, verifyToken
} from "./ai-core.js";

const SECURITY = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };

// رمز خطأ قصير فقط في السجل؛ لا نصوص ولا أجسام ولا مفاتيح أبداً
const note = (code) => console.warn(`ai:${code}`);

function failure(error, headers) {
  let known = error;
  if (!(error instanceof AiError)) { note("internal"); known = new AiError(500, "server"); }
  const extra = {};
  if (Number.isFinite(known.retryAfter)) extra["retry-after"] = String(known.retryAfter);
  if (known.allow) extra.allow = known.allow;
  return new Response(JSON.stringify(errorBody(known)), { status: known.status, headers: { ...headers, ...extra } });
}

// الكائن الحارس: أي عطل فيه يوقف الطلب (نفشل مغلقين، ما نصرف بدون عدّ)
async function ask(env, op, payload) {
  let response;
  let data;
  try {
    response = await env.AI_GUARD.get(env.AI_GUARD.idFromName("main")).fetch("https://ai-guard.internal/op", { method: "POST", body: JSON.stringify({ op, ...payload }) });
    data = await response.json();
  } catch { throw new AiError(500, "server"); }
  if (!data?.ok) throw new AiError(response.status, data?.error ?? "server", data?.message, data?.retryAfter);
  return data;
}

// بدون مفتاح Anthropic أو رمز مالك صالح ما في طريقة نتحقق من أي رمز: 401
async function authenticate({ request, env, config, now }) {
  const token = bearerToken(request.headers.get("authorization"));
  const payload = token ? await verifyToken(secretsOf(env), token, { nowSec: Math.floor(now() / 1000), epoch: config.epoch }) : null;
  if (!payload) throw new AiError(401, "unauthorized", "pair this device first");
  return payload.did;
}

async function readJson(request, max, tooBig) {
  let bytes;
  try { bytes = await readBodyCapped(request, max); } catch (error) { throw tooBig ?? error; }
  try { return { bytes, data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }; }
  catch { throw new AiError(400, "bad_request", "the body must be valid JSON"); }
}

const status = ({ env, config }) => ({ body: { ok: true, configured: isConfigured(env), model: config.model, version: AI_VERSION, searchTool: config.searchTool } });

async function pair(ctx) {
  const { request, env, config, now } = ctx;
  if (!isConfigured(env)) throw new AiError(503, "not_configured", "the AI accountant is not configured on the server");
  const { data } = await readJson(request, MAX_PAIR_BYTES, new AiError(400, "bad_request", "the body must be {code, device}"));
  if (data === null || typeof data !== "object" || typeof data.code !== "string" || typeof data.device !== "string" || !DEVICE_PATTERN.test(data.device)) {
    throw new AiError(400, "bad_request", "the body must be {code, device}");
  }
  // نقارن أولاً بزمن ثابت (الاثنان مقصوصان)، والحارس يقرر ذرّياً (القفل يمنع كشف صحة الرمز حتى لو جاء الصحيح).
  // بصمة الإعداد (epoch + بصمات مقتطعة من رمز المالك ومفتاح Anthropic وAI_PAIR_RESET)؛ تغيّرها يفك القفل
  const owner = ownerCodeOf(env);
  const fp = await pairFingerprint(config, owner, apiKeyOf(env));
  const verdict = await ask(env, "pairAttempt", { match: await ownerCodeMatches(data.code.trim(), owner), at: now(), fp });
  if (verdict.locked) throw new AiError(429, "locked", "too many wrong codes, try again later", verdict.retryAfter);
  if (!verdict.match) throw new AiError(401, "bad_code", "the code is not right");
  const iat = Math.floor(now() / 1000);
  const token = await signToken(secretsOf(env), { did: data.device, iat, epoch: config.epoch });
  const expiresAt = new Date((iat + 90 * 86_400) * 1000).toISOString();
  return { body: { ok: true, token, expiresAt, limits: { dailyUsd: config.dayCap, monthlyUsd: config.monthCap } } };
}

async function usage(ctx) {
  await authenticate(ctx);
  const used = await ask(ctx.env, "usage", { at: ctx.now() });
  const { dayUsd, monthUsd, dayRequests, daySearches } = used;
  return { body: { ok: true, dayUsd, monthUsd, dayCapUsd: ctx.config.dayCap, monthCapUsd: ctx.config.monthCap, dayRequests, daySearches } };
}

// يقرأ رد Claude بحد أقصى للحجم
async function readUpstream(response) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM_BYTES) { await reader.cancel().catch(() => {}); throw new AiError(502, "upstream_error", "the AI service failed"); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
  if (typeof response.text === "function") return response.text();
  return JSON.stringify(await response.json());
}

// يتصل بClaude مع المحاولات الدفاعية (مرة لكل نوع): بدون fallbacks، بدون بحث، بدون thinking، أو بعد 800ms لخطأ 5xx
async function callClaude({ env, config, deps }, messages, signal) {
  const doFetch = deps.fetch ?? ((...args) => fetch(...args));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const flags = deps.flags ?? aiFlags;
  const apiKey = apiKeyOf(env);
  const state = { fallbacks: config.fallbacks && !flags.noFallbacks, search: !flags.noSearch };
  let dropped = flags.dropThinking && hasThinking(messages);
  let sent = dropped ? stripThinking(messages) : messages;
  const tried = new Set();
  const learned = [];
  const controller = new AbortController();
  let timer;
  // مهلة واحدة (85 ثانية) تشمل كل المحاولات؛ نقطعها حتى لو الـfetch تجاهل الإشارة
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new AiError(504, "upstream_timeout", "the AI service did not answer in time")); }, deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  });
  deadline.catch(() => {});
  // العميل قطع الطلب (إيقاف، محادثة جديدة، قفل التطبيق): نوقف اتصال Claude فوراً ونخرج بدون تسجيل أي كلفة
  const closedError = () => new AiError(499, "client_closed", "the client closed the request");
  let onAbort;
  const closed = new Promise((_, reject) => {
    if (!signal) return;
    onAbort = () => { controller.abort(); reject(closedError()); };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  closed.catch(() => {});
  try {
    for (;;) {
      if (signal?.aborted) throw closedError();
      const request = buildUpstream(config, apiKey, sent, state);
      const attempt = (async () => {
        // redirect: manual — لو حوّلنا أحد لمكان ثاني ما يتبع التحويل ومعه المفتاح
        const response = await doFetch(request.url, { ...request.init, redirect: "manual", signal: controller.signal });
        return { status: response.status, retryHeader: response.headers?.get?.("retry-after"), text: await readUpstream(response) };
      })();
      attempt.catch(() => {});
      let result;
      try { result = await Promise.race([attempt, deadline, closed]); } catch (error) {
        // انقطاع العميل أولاً: حتى لو رفض الـfetch برسالة AbortError قبل `closed` يبقى الجواب 499 لا 504
        if (signal?.aborted) throw closedError();
        if (error instanceof AiError && error.status !== 504) throw error;
        if (error instanceof AiError || controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") { note("timeout"); throw new AiError(504, "upstream_timeout", "the AI service did not answer in time"); }
        note("network");
        throw new AiError(502, "upstream_error", "the AI service failed");
      }
      const { status, text, retryHeader } = result;
      if (status === 200) {
        const reply = parseReply(text);
        if (!reply) { note("bad_reply"); throw new AiError(502, "upstream_error", "the AI service failed"); }
        // نجح بعد التعديل: نحفظه للطلبات الجاية
        if (learned.includes("fallbacks")) flags.noFallbacks = true;
        if (learned.includes("search")) flags.noSearch = true;
        if (learned.includes("thinking")) flags.dropThinking = true;
        const warnings = [];
        if (config.fallbacks && !state.fallbacks) warnings.push("fallback_unavailable");
        if (!state.search) warnings.push("search_unavailable");
        if (dropped) warnings.push("thinking_dropped");
        return { reply, warnings };
      }
      const kind = failureKind(status, text, { fallbacks: state.fallbacks, search: state.search, thinking: hasThinking(sent), tried });
      if (!kind) { note(`upstream_${status}`); throw mapUpstreamStatus(status, retryHeader); }
      tried.add(kind);
      if (kind === "transient") await sleep(RETRY_DELAY_MS);
      else if (kind === "thinking") { sent = stripThinking(sent); dropped = true; learned.push(kind); }
      else { state[kind] = false; learned.push(kind); }
    }
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); }
}

async function chat(ctx) {
  const { request, env, config, now } = ctx;
  const did = await authenticate(ctx);
  const { bytes, data } = await readJson(request, MAX_CHAT_BYTES);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new AiError(400, "bad_request", "the body must be {messages}");
  const messages = validateMessages(data.messages);
  const hash = await sha256Hex(did, bytes);
  const before = await ask(env, "check", { did, hash, caps: { dayUsd: config.dayCap, monthUsd: config.monthCap }, at: now() });
  // من هنا العلامة لنا. تُحرَّر أو تُسجَّل مرة وحدة فقط (settle): عند انقطاع العميل، أو بعد الرد، أو عند أي خطأ.
  // بعد الانقطاع ما نسجّل كلفة ولا نحرر ثانية، فلا يلمس طلب متأخر علامة طلب جديد بنفس الجسم.
  const signal = request.signal;
  let settled = false;
  const settle = (op, payload) => { if (settled) return null; settled = true; return ask(env, op, payload); };
  const keep = (promise) => {
    const safe = promise.catch(() => {});
    try { ctx.deps.waitUntil?.(safe); } catch { /* ما في waitUntil: الوعد شغّال أصلاً */ }
  };
  const onAbort = () => { const releasing = settle("release", { hash }); if (releasing) keep(releasing); };
  if (signal?.aborted) { onAbort(); throw new AiError(499, "client_closed", "the client closed the request"); }
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const { reply, warnings } = await callClaude(ctx, messages, signal);
    const fetchedAt = new Date(now()).toISOString();
    const counts = normalizeUsage(reply.usage);
    const usd = costOf(counts, config.prices);
    const tokens = counts.input_tokens + counts.output_tokens + counts.cache_read_input_tokens + counts.cache_creation_input_tokens;
    let totals = { dayUsd: round6(before.dayUsd + usd), monthUsd: round6(before.monthUsd + usd) };
    const recording = settle("record", { usd, tokens, searches: counts.web_searches, did, hash, at: now() });
    if (recording) {
      // فشل التسجيل ما يضيع الرد: نقدّر المجموع ونحاول نحرر العلامة
      try { totals = await recording; } catch { await ask(env, "release", { hash }).catch(() => {}); }
    }
    return {
      body: {
        ok: true,
        message: {
          role: "assistant",
          content: reply.content,
          stop_reason: reply.stop_reason ?? null,
          stop_details: reply.stop_details ?? null,
          model: typeof reply.model === "string" ? reply.model : config.model
        },
        usage: counts,
        cost: { usd, dayUsd: totals.dayUsd, monthUsd: totals.monthUsd, dayCapUsd: config.dayCap, monthCapUsd: config.monthCap },
        fetchedAt,
        warnings
      }
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    const leaving = settle("release", { hash });
    if (leaving) await leaving.catch(() => {});
  }
}

const ROUTES = new Map([
  ["/api/ai/status", ["GET", status]],
  ["/api/ai/pair", ["POST", pair]],
  ["/api/ai/usage", ["GET", usage]],
  ["/api/ai/chat", ["POST", chat]]
]);

export async function handleAi(request, env, deps = {}) {
  const config = readConfig(env);
  const origin = request.headers.get("origin");
  const allowed = origin !== null && originAllowed(origin, config);
  const headers = { ...SECURITY, ...JSON_TYPE, vary: "Origin" };
  // CORS: نعكس الأصل فقط لو هو بالقائمة، ما نستخدم "*" أبداً
  if (allowed) Object.assign(headers, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "86400" });
  try {
    if (origin !== null && !allowed) throw new AiError(403, "origin", "this origin is not allowed");
    if (request.method === "OPTIONS") {
      const { "content-type": _skip, ...plain } = headers;
      return new Response(null, { status: 204, headers: plain });
    }
    const route = ROUTES.get(new URL(request.url).pathname);
    if (!route) throw new AiError(404, "not_found", "unknown path");
    if (request.method !== route[0]) throw Object.assign(new AiError(405, "method_not_allowed", `use ${route[0]}`), { allow: `${route[0]}, OPTIONS` });
    const ctx = { request, env, config, deps: deps ?? {}, now: () => Number((deps?.now ?? Date.now)()) };
    const { body } = await route[1](ctx);
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch (error) { return failure(error, headers); }
}
