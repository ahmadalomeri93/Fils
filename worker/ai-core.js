// منطق «المحاسب الذكي» بدون أي اعتماد على Cloudflare، حتى نفحصه بـ Node مباشرة:
// توقيع الرموز، فحص الرسائل، بناء طلب Claude، تحويل الرد، حساب الكلفة والمواعيد.
import { HttpError } from "./inbox-core.js";
import { SYSTEM_PROMPT } from "./ai-prompt.js";
import { AI_CLIENT_TOOLS } from "../dist/ai-tool-schemas.js";

export const AI_VERSION = 1;
export const DEFAULT_ORIGINS = ["https://broken-queen-f0ed.ahmadalomeri.workers.dev", "https://ahmadalomeri93.github.io"];
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_SEARCH_TOOL = "web_search_20250305";
export const DEFAULT_API_BASE = "https://api.anthropic.com";
// v46: بدون مفتاح Anthropic يشتغل المحاسب على Workers AI من Cloudflare (ربط AI بحسابه، مجاني ضمن 10 آلاف وحدة باليوم)
export const WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";
export const WORKERS_AI_KEY = "workers-ai-binding";
// أسعار Cloudflare الرسمية: 5500 وحدة لكل مليون توكن دخل و36400 خرج، والوحدة 0.011 دولار لكل ألف
export const WORKERS_AI_PRICES = { in: 0.0605, out: 0.4004, search: 0 };
export const TOKEN_TTL_SEC = 90 * 86_400;
export const MAX_CHAT_BYTES = 700_000;
export const MAX_PAIR_BYTES = 4096;
export const MAX_UPSTREAM_BYTES = 8_000_000;
export const UPSTREAM_TIMEOUT_MS = 85_000;
export const RETRY_DELAY_MS = 800;
export const RATE_MINUTE = 10;
export const RATE_HOUR = 120;
export const LOCK_FAILS = 5;
export const LOCK_MS = 15 * 60_000;
export const DUP_TTL_MS = 120_000;
// أقصى طلبات جارية بنفس الوقت لكل الأجهزة معاً (يحدّ تجاوز الميزانية حتى لو انقرنت أجهزة كثيرة)
export const MAX_INFLIGHT = 4;
export const DEVICE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const KUWAIT_OFFSET_MS = 3 * 3_600_000;
const MAX_MESSAGES = 80;
const MAX_BLOCKS = 200;
const TOOLU = /^toolu_[A-Za-z0-9_-]{1,100}$/;
const SRVTOOLU = /^srvtoolu_[A-Za-z0-9_-]{1,100}$/;
// اسم الأداة بالرد المُعاد: نفحص الشكل فقط (العميل يرد على الأدوات المجهولة بـ tool_result فيه is_error)
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const enc = new TextEncoder();

// خطأ بحالة HTTP ورمز ثابت؛ hint جملة إنجليزية قصيرة من عندنا (ما ننقل نص Anthropic أبداً)
export class AiError extends HttpError {
  constructor(status, code, hint = "", retryAfter = undefined) {
    super(status, code);
    this.hint = hint;
    this.retryAfter = retryAfter;
  }
}

export function errorBody(error) {
  const body = { ok: false, error: error.code };
  if (Number.isFinite(error.retryAfter)) body.retryAfter = error.retryAfter;
  if (error.hint) body.message = error.hint;
  return body;
}

export const round6 = (value) => Math.round(value * 1e6) / 1e6;
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---- الإعدادات (أسرار ومتغيرات Cloudflare) ----
function num(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
const money = (value, fallback) => { const n = num(value, fallback); return n >= 0 ? n : fallback; };
const word = (value, pattern, fallback) => (typeof value === "string" && pattern.test(value.trim()) ? value.trim() : fallback);

// نسمح بالتجاوز فقط لعنوان محلي (للاختبار)؛ أي شي ثاني يرجع لعنوان Anthropic الحقيقي
function apiBase(value) {
  if (typeof value !== "string") return DEFAULT_API_BASE;
  let url;
  try { url = new URL(value.trim()); } catch { return DEFAULT_API_BASE; }
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && !url.username && !url.password;
  return local ? url.origin + url.pathname.replace(/\/+$/, "") : DEFAULT_API_BASE;
}

export function readConfig(env) {
  const e = env ?? {};
  const origins = new Set(DEFAULT_ORIGINS);
  // نقبل أصولاً كاملة فقط (مخطط + مضيف)، فلا يتسلل نجمة أو مسار
  for (const raw of String(e.AI_ALLOWED_ORIGINS ?? "").split(",")) {
    const origin = raw.trim().replace(/\/+$/, "").toLowerCase();
    if (/^https?:\/\/[^\s/*?#@]+$/.test(origin)) origins.add(origin);
  }
  const effort = String(e.AI_EFFORT ?? "").trim().toLowerCase();
  const provider = providerOf(e);
  const free = provider === "workers-ai";
  return {
    provider,
    model: free ? word(e.AI_MODEL, /^@cf\/[\w.-]{1,40}\/[\w.-]{1,60}$/, WORKERS_AI_MODEL) : word(e.AI_MODEL, /^[\w.:-]{1,100}$/, DEFAULT_MODEL),
    effort: ["low", "medium", "high"].includes(effort) ? effort : "medium",
    maxTokens: Math.min(16000, Math.max(1024, Math.floor(num(e.AI_MAX_TOKENS, 6000)))),
    // المجاني: 10 آلاف وحدة باليوم = 0.11 دولار، فنوقف عند 0.10 قبل ما يرفض Cloudflare
    dayCap: money(e.AI_DAILY_USD_CAP, free ? 0.1 : 1),
    monthCap: money(e.AI_MONTHLY_USD_CAP, free ? 3 : 15),
    epoch: (String(e.AI_TOKEN_EPOCH ?? "").trim() || "0").slice(0, 32),
    // علامة تدخل في بصمة قفل الاقتران فقط: تغييرها يفك القفل بدون إبطال الرموز
    pairReset: String(e.AI_PAIR_RESET ?? "").trim().slice(0, 64),
    origins,
    // نسخة البحث الوحيدة المقبولة؛ أي قيمة ثانية تُهمل (النسخ الأحدث ترجع كتل code_execution ما تمر بقائمة الرد المُعاد)
    searchTool: word(e.AI_WEB_SEARCH_TOOL, /^web_search_20250305$/, DEFAULT_SEARCH_TOOL),
    fallbacks: String(e.AI_FALLBACKS ?? "").trim().toLowerCase() !== "off",
    prices: free
      ? { in: money(e.AI_PRICE_IN_PER_MTOK, WORKERS_AI_PRICES.in), out: money(e.AI_PRICE_OUT_PER_MTOK, WORKERS_AI_PRICES.out), search: 0 }
      : { in: money(e.AI_PRICE_IN_PER_MTOK, 2), out: money(e.AI_PRICE_OUT_PER_MTOK, 10), search: money(e.AI_PRICE_SEARCH_PER_K, 10) },
    apiBase: apiBase(e.AI_API_BASE)
  };
}

// رمز المالك يُقرأ دائماً مقصوصاً (سطر جديد أو مسافة بالسر ما تكسر الاقتران)؛ نص فاضي لو غير موجود
export const ownerCodeOf = (env) => (typeof env?.AI_OWNER_CODE === "string" ? env.AI_OWNER_CODE.trim() : "");
export const ownerCodeValid = (code) => typeof code === "string" && code.length >= 12;
export const apiKeyOf = (env) => (typeof env?.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.trim() : "");
export const hasWorkersAi = (env) => Boolean(env?.AI) && typeof env.AI.run === "function";
// مفتاح Anthropic إن وُجد يغلب؛ وإلا ربط Workers AI؛ وإلا لا شي
export const providerOf = (env) => (apiKeyOf(env) ? "anthropic" : hasWorkersAi(env) ? "workers-ai" : "none");
export const secretsOf = (env) => ({ apiKey: apiKeyOf(env) || (hasWorkersAi(env) ? WORKERS_AI_KEY : ""), ownerCode: ownerCodeOf(env) });
export const isConfigured = (env) => providerOf(env) !== "none" && ownerCodeValid(ownerCodeOf(env));
export const originAllowed = (origin, config) => typeof origin === "string" && config.origins.has(origin);

// ---- تشفير: base64url وHMAC ----
export function b64u(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return null; }
}

const HMAC = { name: "HMAC", hash: "SHA-256" };
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, HMAC, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

// مفتاح توقيع الرموز يُشتق من السرّين معاً: HMAC-SHA256(مفتاح = ANTHROPIC_API_KEY، رسالة = "fils-ai-token-v1|" + رمز المالك).
// فلا يكفي رمز مسروق للتخمين خارجياً على رمز المالك بدون مفتاح Anthropic. تدوير أي واحد من السرّين يبطل كل الرموز (تُقرن الأجهزة من جديد).
// النسخة (isolate) تحتفظ بآخر مفتاح مشتق حتى لا تعيد الاشتقاق كل طلب.
let tokenKeyCache = null;
async function tokenKey({ apiKey, ownerCode }) {
  if (tokenKeyCache && tokenKeyCache.apiKey === apiKey && tokenKeyCache.ownerCode === ownerCode) return tokenKeyCache.key;
  const raw = await hmac(enc.encode(apiKey), `fils-ai-token-v1|${ownerCode}`);
  const key = await crypto.subtle.importKey("raw", raw, HMAC, false, ["sign", "verify"]);
  tokenKeyCache = { apiKey, ownerCode, key };
  return key;
}

export async function sha256Hex(...parts) {
  const chunks = parts.map((part) => (typeof part === "string" ? enc.encode(part) : part));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length + 1; }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// مقارنة رمز الاقتران: نقارن بصمتي HMAC للنصين (بمفتاح عشوائي لكل نسخة) بدل النصين نفسيهما، وبزمن ثابت
let compareKey = null;
export async function ownerCodeMatches(given, owner) {
  compareKey ??= crypto.getRandomValues(new Uint8Array(32));
  const [a, b] = await Promise.all([hmac(compareKey, String(given)), hmac(compareKey, String(owner))]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// بصمة الإعداد المحفوظة داخل حالة قفل الاقتران: epoch + 16 خانة من SHA-256 لكل من رمز المالك ومفتاح Anthropic وعلامة AI_PAIR_RESET.
// أي تغيير فيها يمسح القفل والعدّاد فوراً؛ الأسرار نفسها ما تُحفظ أبداً (فقط بصمات مقتطعة).
export async function pairFingerprint(config, ownerCode, apiKey) {
  const short = async (label, value) => (await sha256Hex(label, value)).slice(0, 16);
  return [config.epoch, await short("fils-ai-pair-fp-v1", ownerCode), await short("fils-ai-pair-fp-key-v1", apiKey), config.pairReset ? await short("fils-ai-pair-fp-reset-v1", config.pairReset) : ""].join("|");
}

// ---- الرمز: v1.<payload>.<توقيع>؛ iat وexp بالثواني ----
export async function signToken(secrets, { did, iat, epoch }) {
  const head = `v1.${b64u(enc.encode(JSON.stringify({ did, iat, exp: iat + TOKEN_TTL_SEC, ep: String(epoch) })))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await tokenKey(secrets), enc.encode(head)));
  return `${head}.${b64u(signature)}`;
}

// يرجع محتوى الرمز أو null؛ التحقق بـ crypto.subtle.verify (زمن ثابت) قبل قراءة المحتوى
export async function verifyToken(secrets, token, { nowSec, epoch }) {
  if (typeof token !== "string" || token.length > 1024 || !secrets?.apiKey || !ownerCodeValid(secrets.ownerCode)) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const signature = unb64u(parts[2]);
  if (!signature || signature.length !== 32 || b64u(signature) !== parts[2]) return null;
  if (!(await crypto.subtle.verify("HMAC", await tokenKey(secrets), signature, enc.encode(`v1.${parts[1]}`)))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
    const ok = isPlain(payload) && DEVICE_PATTERN.test(String(payload.did)) && Number.isFinite(payload.iat) && Number.isFinite(payload.exp)
      && payload.exp > nowSec && String(payload.ep) === String(epoch);
    return ok ? { did: payload.did, iat: payload.iat, exp: payload.exp, ep: String(payload.ep) } : null;
  } catch { return null; }
}

export function bearerToken(header) {
  const match = /^Bearer\s+([A-Za-z0-9_.-]{1,1024})$/i.exec(String(header ?? "").trim());
  return match ? match[1] : "";
}

// ---- أيام الكويت (UTC+3) ----
export const kuwaitDay = (ms) => new Date(ms + KUWAIT_OFFSET_MS).toISOString().slice(0, 10);
export const kuwaitMonth = (ms) => kuwaitDay(ms).slice(0, 7);
export function secondsToKuwaitMidnight(ms) {
  const local = ms + KUWAIT_OFFSET_MS;
  return Math.max(1, Math.ceil((Math.floor(local / 86_400_000) * 86_400_000 + 86_400_000 - local) / 1000));
}
export function secondsToKuwaitMonthEnd(ms) {
  const local = ms + KUWAIT_OFFSET_MS;
  const date = new Date(local);
  return Math.max(1, Math.ceil((Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - local) / 1000));
}

// ---- قراءة الجسم بحد أقصى حتى لو ما جاء Content-Length ----
export async function readBodyCapped(request, max) {
  if (Number(request.headers.get("content-length") ?? 0) > max) throw new AiError(413, "too_large", "request body is too large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new AiError(413, "too_large", "request body is too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// ---- فحص الرسائل: ما يوصل لClaude إلا الصحيح، وكتل المساعد تمر كما هي بلا أي تعديل ----
const bad = (why) => new AiError(400, "bad_request", why);
const only = (object, keys) => Object.keys(object).every((key) => keys.includes(key));

function userBlock(block, where) {
  if (!isPlain(block) || typeof block.type !== "string") throw bad(`${where} must be a block object`);
  if (block.type === "text") {
    if (!only(block, ["type", "text"])) throw bad(`${where} has keys that are not allowed`);
    if (typeof block.text !== "string" || !block.text.trim() || block.text.length > 8000) throw bad(`${where}.text must be 1 to 8000 characters`);
  } else if (block.type === "tool_result") {
    if (!only(block, ["type", "tool_use_id", "content", "is_error"])) throw bad(`${where} has keys that are not allowed`);
    if (typeof block.tool_use_id !== "string" || !TOOLU.test(block.tool_use_id)) throw bad(`${where}.tool_use_id is malformed`);
    if (typeof block.content !== "string" || block.content.length > 60000) throw bad(`${where}.content must be a string of at most 60000 characters`);
    if (block.is_error !== undefined && typeof block.is_error !== "boolean") throw bad(`${where}.is_error must be a boolean`);
  } else throw bad(`${where}.type is not allowed in user messages`);
}

function assistantBlock(block, where, uses) {
  if (!isPlain(block) || typeof block.type !== "string") throw bad(`${where} must be a block object`);
  switch (block.type) {
    case "text": {
      if (typeof block.text !== "string" || block.text.length > 20000) throw bad(`${where}.text must be a string of at most 20000 characters`);
      const cites = block.citations;
      if (cites !== undefined && cites !== null && (!Array.isArray(cites) || cites.length > 20 || !cites.every((cite) => isPlain(cite) && cite.type === "web_search_result_location"))) throw bad(`${where}.citations is not valid`);
      return;
    }
    case "tool_use":
      if (typeof block.id !== "string" || !TOOLU.test(block.id)) throw bad(`${where}.id is malformed`);
      if (typeof block.name !== "string" || !TOOL_NAME.test(block.name)) throw bad(`${where}.name is malformed`);
      if (!isPlain(block.input) || JSON.stringify(block.input).length > 8000) throw bad(`${where}.input must be an object of at most 8000 characters`);
      if (uses.has(block.id)) throw bad(`${where}.id is repeated`);
      uses.add(block.id);
      return;
    case "server_tool_use":
      if (typeof block.id !== "string" || !SRVTOOLU.test(block.id)) throw bad(`${where}.id is malformed`);
      if (block.name !== "web_search") throw bad(`${where}.name is not allowed`);
      if (!isPlain(block.input) || typeof block.input.query !== "string" || block.input.query.length > 400 || JSON.stringify(block.input).length > 8000) throw bad(`${where}.input.query must be a string of at most 400 characters`);
      return;
    case "web_search_tool_result":
      if (typeof block.tool_use_id !== "string" || !SRVTOOLU.test(block.tool_use_id)) throw bad(`${where}.tool_use_id is malformed`);
      if (!Array.isArray(block.content) && !isPlain(block.content)) throw bad(`${where}.content must be an array or an object`);
      return;
    case "thinking":
      if (typeof block.thinking !== "string" || typeof block.signature !== "string") throw bad(`${where} needs string thinking and signature`);
      return;
    case "redacted_thinking":
      if (typeof block.data !== "string") throw bad(`${where}.data must be a string`);
      return;
    case "fallback": return;
    default: throw bad(`${where}.type is not allowed in assistant messages`);
  }
}

// رسالة المستخدم: تُرجع معرّفات tool_use المطلوب ردها (فاضية دائماً بعدها)
function userTurn(content, where, owed) {
  const mustAnswer = `${where} must answer every tool_use of the previous assistant message with a tool_result`;
  if (typeof content === "string") {
    if (!content.trim() || content.length > 8000) throw bad(`${where}.content must be 1 to 8000 characters`);
    if (owed.size) throw bad(mustAnswer);
    return new Set();
  }
  if (!Array.isArray(content) || content.length < 1 || content.length > MAX_BLOCKS) throw bad(`${where}.content must be a string or 1 to ${MAX_BLOCKS} blocks`);
  const answered = new Set();
  let sawText = false;
  content.forEach((block, j) => {
    userBlock(block, `${where}.content[${j}]`);
    if (block.type === "text") { sawText = true; return; }
    if (sawText) throw bad(`${where}.content[${j}]: tool_result blocks must come before text blocks`);
    if (answered.has(block.tool_use_id)) throw bad(`${where}.content[${j}].tool_use_id is repeated`);
    answered.add(block.tool_use_id);
  });
  if (answered.size !== owed.size || [...answered].some((id) => !owed.has(id))) throw bad(owed.size ? mustAnswer : `${where} has a tool_result that matches no tool_use in the previous assistant message`);
  return new Set();
}

function assistantTurn(content, where) {
  if (!Array.isArray(content) || content.length < 1 || content.length > MAX_BLOCKS) throw bad(`${where}.content must be 1 to ${MAX_BLOCKS} blocks`);
  const uses = new Set();
  content.forEach((block, j) => assistantBlock(block, `${where}.content[${j}]`, uses));
  return uses;
}

// يرمي AiError(400) لو في خلل؛ ويرجع المصفوفة نفسها (بدون نسخ) لو سليمة
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) throw bad(`messages must be an array of 1 to ${MAX_MESSAGES} items`);
  try {
    let owed = new Set();
    messages.forEach((message, i) => {
      const where = `messages[${i}]`;
      if (!isPlain(message) || !only(message, ["role", "content"])) throw bad(`${where} must be an object with only role and content`);
      if (message.role !== "user" && message.role !== "assistant") throw bad(`${where}.role must be "user" or "assistant"`);
      const expected = i % 2 === 0 ? "user" : "assistant";
      if (message.role !== expected) throw bad(`${where}.role must be "${expected}": roles alternate and start with user`);
      owed = message.role === "user" ? userTurn(message.content, where, owed) : assistantTurn(message.content, where);
    });
    // آخر رسالة مساعد = استئناف pause_turn؛ ما يصلح تبقى فيها أداة تنتظر ردها
    if (owed.size) throw bad("the last assistant message has tool_use blocks that nothing answers");
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw bad("messages could not be validated");
  }
  return messages;
}

const THINKING = new Set(["thinking", "redacted_thinking"]);
export const hasThinking = (messages) => messages.some((m) => m.role === "assistant" && m.content.some((b) => THINKING.has(b.type)));
export function stripThinking(messages) {
  return messages.map((m) => (m.role === "assistant" ? { ...m, content: m.content.filter((b) => !THINKING.has(b.type)) } : m));
}

// ---- طلب Claude: نبنيه بأنفسنا؛ من العميل فقط messages ----
export function buildUpstream(config, apiKey, messages, { search = true, fallbacks = true } = {}) {
  const tools = [...AI_CLIENT_TOOLS];
  if (search) tools.push({ type: config.searchTool, name: "web_search", max_uses: 3, user_location: { type: "approximate", timezone: "Asia/Kuwait" } });
  const body = { model: config.model, max_tokens: config.maxTokens, system: [{ type: "text", text: SYSTEM_PROMPT }], tools, output_config: { effort: config.effort } };
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (fallbacks) { body.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; }
  body.messages = messages;
  return { url: `${config.apiBase}/v1/messages`, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

// ما نتعلمه من رفض Claude نحتفظ به لعمر النسخة (isolate) حتى ما نكرر المحاولة الفاشلة كل طلب
export const aiFlags = { noFallbacks: false, noSearch: false, dropThinking: false };
export function resetAiFlags() { Object.assign(aiFlags, { noFallbacks: false, noSearch: false, dropThinking: false }); }

function upstreamMessage(text) {
  try { const data = JSON.parse(text); return String(data?.error?.message ?? data?.message ?? "").slice(0, 2000); }
  catch { return String(text).slice(0, 2000); }
}

// أي تعديل دفاعي نجرّبه بعد رفض Claude؟ كل نوع مرة وحدة لكل طلب
export function failureKind(status, text, { fallbacks, search, thinking, tried }) {
  if ((status === 500 || status === 503 || status === 529) && !tried.has("transient")) return "transient";
  if (status !== 400) return null;
  const message = upstreamMessage(text);
  // رفض الـthinking أولاً: رسالته قد تذكر ترويسة beta، وما نبي يُحسب رفضاً للـfallbacks أبداً
  const thinkingHit = (/signature/i.test(message) && /thinking/i.test(message)) || /bound to a different conversation|block_binding/i.test(message);
  if (thinkingHit) return thinking && !tried.has("thinking") ? "thinking" : null;
  if (fallbacks && !tried.has("fallbacks") && /anthropic-beta|\bfallbacks?\b|server-side-fallback/i.test(message)) return "fallbacks";
  if (search && !tried.has("search") && /web[_ ]?search/i.test(message) && /enabled|support|available|allowed|permission|organization|disabled|does not match|unknown|invalid/i.test(message)) return "search";
  return null;
}

export function retryAfterSeconds(header) {
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.ceil(n)) : undefined;
}

// حالة Claude -> خطأنا؛ نص Claude ما ينقل أبداً
export function mapUpstreamStatus(status, retryAfterHeader) {
  const wait = retryAfterSeconds(retryAfterHeader);
  if (status === 401 || status === 403 || status === 404) return new AiError(502, "upstream_not_configured", "service not configured");
  if (status === 413) return new AiError(413, "too_large", "the conversation is too large");
  if (status === 429) return new AiError(429, "rate_limited", "the AI service is busy, try again later", wait ?? 30);
  if (status === 503 || status === 529) return new AiError(503, "upstream_overloaded", "the AI service is overloaded, try again later", wait);
  return new AiError(502, "upstream_error", "the AI service failed");
}

export function normalizeUsage(usage) {
  const n = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  return {
    input_tokens: n(usage?.input_tokens),
    output_tokens: n(usage?.output_tokens),
    cache_read_input_tokens: n(usage?.cache_read_input_tokens),
    cache_creation_input_tokens: n(usage?.cache_creation_input_tokens),
    web_searches: n(usage?.server_tool_use?.web_search_requests)
  };
}

// تقدير الكلفة بالدولار بالأسعار الرسمية (الإعدادات تغيّرها)
export function costOf(usage, prices) {
  return round6(
    usage.input_tokens * prices.in / 1e6 + usage.output_tokens * prices.out / 1e6
    + usage.cache_read_input_tokens * 0.1 * prices.in / 1e6 + usage.cache_creation_input_tokens * 1.25 * prices.in / 1e6
    + usage.web_searches * prices.search / 1000
  );
}

// ---- Workers AI: تحويل رسائلنا (شكل Anthropic) لشكل الدردشة العام (OpenAI) وردّه لشكلنا ----
const NO_SEARCH_NOTE = `\n\nIMPORTANT FOR THIS DEPLOYMENT: there is no web_search tool here. For any public price or rate, say in Arabic that you cannot look it up now (do not guess a price). Use only the tools provided.`;
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "");

export function toWorkersAiMessages(messages) {
  const out = [{ role: "system", content: SYSTEM_PROMPT + NO_SEARCH_NOTE }];
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") { out.push({ role: "user", content: message.content }); continue; }
      for (const block of message.content) {
        if (block.type === "tool_result") out.push({ role: "tool", tool_call_id: block.tool_use_id, content: (block.is_error ? "ERROR: " : "") + (textOf(block.content) || "(empty)") });
      }
      const text = textOf(message.content);
      if (text) out.push({ role: "user", content: text });
    } else {
      const text = textOf(message.content);
      const calls = message.content.filter((b) => b?.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const entry = { role: "assistant", content: text || (calls.length ? "" : "...") };
      if (calls.length) entry.tool_calls = calls;
      out.push(entry);
    }
  }
  return out;
}

export function buildWorkersAiInput(config, messages) {
  const tools = AI_CLIENT_TOOLS.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
  return { messages: toWorkersAiMessages(messages), tools, max_tokens: Math.min(config.maxTokens, 3000), temperature: 0.2 };
}

const newToolId = () => `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
function callInput(args) {
  if (isPlain(args)) return args;
  if (typeof args === "string" && args.trim()) { try { const parsed = JSON.parse(args); return isPlain(parsed) ? parsed : {}; } catch { return {}; } }
  return {};
}

// يقبل الشكلين: {choices:[{message}]} الحديث و{response, tool_calls} القديم. null لو ما فيه نص ولا استدعاء.
export function parseWorkersAiReply(result, config, sentChars = 0) {
  const choice = Array.isArray(result?.choices) ? result.choices[0] : null;
  const message = choice?.message ?? result ?? {};
  const raw = message.content ?? result?.response ?? "";
  const text = (typeof raw === "string" ? raw : textOf(raw)).trim().slice(0, 19000);
  const finish = choice?.finish_reason;
  // رد انقطع بحد الطول: الوسائط ناقصة وقد تنفّذ أداة بفلتر ناقص، فنتجاهل الاستدعاءات
  const found = finish === "length" ? [] : Array.isArray(message.tool_calls) ? message.tool_calls : Array.isArray(result?.tool_calls) ? result.tool_calls : [];
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of found.slice(0, 8)) {
    const fn = call?.function ?? call;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!TOOL_NAME.test(name)) continue;
    const input = callInput(fn.arguments ?? fn.input);
    // فاحص الرسائل عندنا يرفض وسائط أطول من 8000 حرف، فلا نرجّع شيئاً ينكسر به الطلب التالي
    if (JSON.stringify(input).length > 7500) continue;
    content.push({ type: "tool_use", id: newToolId(), name, input });
  }
  if (!content.length) return null;
  const toolUse = content.some((b) => b.type === "tool_use");
  const usage = result?.usage ?? {};
  const inTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : Math.ceil(sentChars / 3);
  const outTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : Math.ceil(JSON.stringify(content).length / 3);
  return {
    content,
    stop_reason: toolUse ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
    stop_details: null,
    model: config.model,
    usage: { input_tokens: inTokens, output_tokens: outTokens }
  };
}

// رد Claude الناجح -> نص الرد للعميل؛ null لو الشكل غير متوقع
export function parseReply(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  return isPlain(data) && Array.isArray(data.content) ? data : null;
}
