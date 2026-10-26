/* ============================================================
   PLUTUS — Cloudflare Worker proxy (free tier) · v10
   • Adds CORS headers so the GitHub Pages site can call Yahoo
   • Handles Yahoo's cookie + "crumb" handshake (needed for
     quoteSummary: company profile, P/E, dividend, peers, etc.)
   • Only forwards to Yahoo Finance data hosts and Bing News RSS
     (not an open proxy)
   • Caches GET responses at the edge for 10 minutes
   • POST is forwarded to Yahoo's screener endpoint only
     (used to list companies in the same industry for peers)
   • ?og=<article url> returns { image } — the article's own
     picture (og:image), used for news thumbnails
   v10 — Hindi & Hinglish:
   • POST /ask takes "lang" ("en" | "hi" | "hinglish"; detected from the question if missing) and answers in that
     language — Hindi in Devanagari, Hinglish in English letters plus a Devanagari copy ("voice") for Hindi speech
   • POST /refine translates Hindi / Hinglish questions into an English question + English report search words
   • POST /speak takes "lang" ("en-IN" | "hi-IN") so Hindi answers are read by Sarvam's Hindi voice
   • saved answers are kept per language (an English answer is never served for a Hindi question)
   • the answer says ANSWERED: YES / NO explicitly, so "the report doesn't cover this" is detected in any language
   v8 — voice bot upgrades (see the "v8" notes in the voice block below):
   • POST /refine — turns a spoken / vague question into a clear one + annual-report search terms
   • POST /ask    — longer, structured, in-depth answers (more passages, bigger output budget)
   • POST /speak  — natural Indian-English voice (Sarvam AI "Bulbul"), with a daily character budget
   v7 — adds the Plutus voice bot: POST /ask and POST /prepare (see the "v7" block below). Everything above is unchanged.
   v6 — fewer "Signal lost" errors:
   • FIX: answers served from the edge cache carried a doubled
     "Access-Control-Allow-Origin: *, *" header, which browsers
     reject — every cache HIT failed like a network error
   • the cookie/crumb handshake is shared by requests arriving
     together (it used to run once PER request when the Worker
     was cold, which itself triggered Yahoo's rate limit)
   • a 429 / 5xx from Yahoo is retried once on its twin host
     (query1 ↔ query2)
   • a 24-hour "last good copy" is kept at the edge and served
     when Yahoo refuses (X-Cache: STALE)
   • Retry-After is passed through and readable by the site
   ============================================================ */

// After your site is live, lock this down, e.g. ['https://<user>.github.io']
const ALLOWED_ORIGINS = ['*'];
const ALLOWED_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const NEWS_HOSTS = ['www.bing.com'];
const NEWS_PATHS = ['/news/search'];
const ALLOWED_POST_PATHS = ['/v1/finance/screener'];
const CACHE_SECONDS = 600;          // fresh copy
const STALE_SECONDS = 24 * 3600;    // last good copy, served only when the live request fails
const OG_CACHE_SECONDS = 24 * 3600;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twinHost = (u) => { const x = new URL(u); x.hostname = x.hostname === 'query1.finance.yahoo.com' ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com'; return x.toString(); };

let session = null;        // { cookie, crumb, ts }
let pendingSession = null; // the handshake in progress, shared by every request that needs it
let sessionFailedAt = 0;   // don't hammer Yahoo with handshakes right after one failed

async function getSession(force) {
  if (!force && session && Date.now() - session.ts < 30 * 60e3) return session;
  if (pendingSession) return pendingSession;
  if (!force && Date.now() - sessionFailedAt < 60e3) return session; // may be null: some endpoints work without a crumb
  pendingSession = (async () => {
    const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
    const crumb = (await c.text()).trim();
    if (!c.ok || !crumb || crumb.includes('<') || crumb.length > 40) throw new Error('crumb handshake failed');
    session = { cookie, crumb, ts: Date.now() };
    return session;
  })().catch((e) => { sessionFailedAt = Date.now(); throw e; }).finally(() => { pendingSession = null; });
  return pendingSession;
}

// init (optional): { method, body } for POST requests
async function callYahoo(target, force, init) {
  let s = null;
  try { s = await getSession(force); } catch (e) { /* some endpoints work without a crumb */ }
  const u = new URL(target);
  if (s && s.crumb) u.searchParams.set('crumb', s.crumb);
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (s && s.cookie) headers.Cookie = s.cookie;
  const opts = { headers };
  if (init && init.method === 'POST') {
    opts.method = 'POST';
    opts.body = init.body;
    headers['Content-Type'] = 'application/json';
  }
  return fetch(u.toString(), opts);
}

// crumb refresh on 401/403; one retry on the twin host on 429 / 5xx
async function yahoo(target, init) {
  let res = await callYahoo(target, false, init);
  if (res.status === 401 || res.status === 403) res = await callYahoo(target, true, init);
  if (res.status === 429 || res.status >= 500) {
    await sleep(300 + Math.random() * 400);
    res = await callYahoo(twinHost(target), false, init);
  }
  return res;
}

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'Retry-After, X-Cache', Vary: 'Origin' };
}

const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
// Re-serve a cached response. Headers must be SET, not merged from a plain object: the cached copy already carries
// "access-control-allow-origin" (lower case), and merging the capitalised one on top makes "*, *" — a value browsers
// reject, so every cache HIT failed as "TypeError: Failed to fetch" (shown by the site as "Signal lost"). Fixed in v6.
function withCors(res, cors, tag) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  h.set('X-Cache', tag);
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---------- news thumbnails: the article's og:image / twitter:image ---------- */
async function readHead(res, limit) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let html = '';
  while (html.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  try { reader.cancel(); } catch (e) { /* ignore */ }
  return html;
}
async function ogImage(link) {
  let u;
  try { u = new URL(link); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (/^[\d.]+$|^\[|^localhost$/i.test(u.hostname)) return ''; // public sites only
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(u.toString(), { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok || !/html/i.test(res.headers.get('Content-Type') || '')) return '';
    const html = await readHead(res, 300000);
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const want of [/^og:image(:secure_url)?$/i, /^twitter:image(:src)?$/i]) {
      for (const t of tags) {
        const key = (t.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
        const val = (t.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (key && val && want.test(key.trim())) {
          try { const img = new URL(val.replace(/&amp;/g, '&').trim(), res.url || u.toString()); if (/^https?:$/.test(img.protocol)) return img.toString(); } catch (e) { /* bad url */ }
        }
      }
    }
    return '';
  } catch (e) { return ''; } finally { clearTimeout(timer); }
}

/* ============================================================
   v7 — PLUTUS VOICE BOT  (POST /ask · POST /prepare)
   • /ask     — answers a question about a company's annual report. The browser finds the best passages in the
                prepared report (data/reports/<SYMBOL>.json) and sends only those; this Worker adds the strict
                rules, calls a free AI model (Groq → Gemini → Workers AI, whichever has a key / quota left),
                checks every number in the answer against the passages, and returns the result.
   • /prepare — asks GitHub Actions to fetch + index a company's latest annual report (first request for a company).
   Settings (Worker → Settings → Variables and Secrets):
     secrets : free AI keys — add as many as you like; each one adds its own free daily allowance (v9):
                 GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, NVIDIA_API_KEY, GITHUB_MODELS_TOKEN, OPENROUTER_API_KEY, CEREBRAS_API_KEY
               GITHUB_TOKEN (report job)
               SARVAM_API_KEY  (v8, optional — the natural Indian-English voice; without it the browser's own voice is used)
     text    : GITHUB_REPO = "<user>/<repo>", GITHUB_REF = "main" (optional)
               PROVIDER_ORDER = "groq,gemini,mistral,cerebras,nvidia,github,openrouter,workersai" (optional)
               <NAME>_MODELS = "model-a,model-b" to pin models for one service (optional; otherwise they are discovered)
               GROQ_MODEL, GEMINI_MODEL, WORKERS_AI_MODEL (optional — tried first for that service)
               SARVAM_TTS_MODEL = "bulbul:v3", SARVAM_SPEAKER (optional), TTS_DAILY_CHARS = "150000" (optional)
     binding : AI → Workers AI (optional last cloud fallback)
   v9 — "never run out" on free tiers:
     • a pool of free services; each service's current models are discovered from its /models list (cached 12 h), so
       renamed / retired free models don't break anything. Several models per service are used, because most free tiers
       count their limits per model.
     • a service/model that answers 429 (limit reached) or 401/404 is skipped for a while ("cooldown"), so the next
       visitors go straight to one that still has allowance.
     • answers to stand-alone questions are cached at the edge for 30 days: a repeated question costs no tokens.
   ============================================================ */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.&^-]{0,19}$/;
const V = {
  maxQuestion: 600, maxExcerpts: 9, maxExcerptChars: 1600, maxHistory: 2, maxBody: 70000,
  askPerMinute: 8,            // per visitor (best-effort counter in the edge cache)
  refinePerMinute: 12,
  speakPerMinute: 40, ttsMaxChars: 1200, ttsDailyChars: 150000,
  preparePerHourPerIp: 6, prepareGlobalPerHour: 40, prepareCooldownSeconds: 20 * 60,
  providerTimeoutMs: 30000, refineTimeoutMs: 9000,
  maxAttempts: 7,               // service/model combinations tried per question before giving up
  answerCacheSeconds: 30 * 86400,
  defaults: { groq: 'openai/gpt-oss-120b', gemini: 'gemini-3.1-flash-lite', workersai: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' }
};

/* v8: the answer prompt asks for depth (several angles, management's reasons, what it means) while keeping the
   original honesty rules: facts only from the excerpts, cited, numbers quoted exactly (the number guard still checks them). */
const SYSTEM_PROMPT = `You are Plutus, a friendly, sharp analyst who explains ONE company's latest annual report to an everyday investor. You give thorough, insightful answers, never one-liners, while staying strictly faithful to the report.

UNDERSTANDING THE QUESTION
- The visitor's words may come from speech recognition and contain errors. Use the "interpreted question", the points to cover and the earlier conversation to work out what they really want to know, and answer that.
- If the question is broad (e.g. "how is the company doing?"), cover every angle the excerpts support: growth, profitability, cash, debt and what management says.

FACTS — follow strictly
1. Every fact about the company must come from the numbered excerpts. Never use outside knowledge about the company, its industry or the economy, and never invent a cause.
2. You MAY briefly explain what a financial term means in general (for example what operating cash flow measures) so a beginner can follow.
3. Quote numbers exactly as written in the excerpts, with their units and currency. You may say a figure rose or fell when both years are in the excerpts, but do NOT calculate new numbers (differences, percentages, ratios) yourself.
4. Keep what MANAGEMENT SAYS separate from plain figures, e.g. "Management attributes the fall to higher working capital [S1]."
5. If the excerpts answer only part of the question, answer that part fully and say plainly what they don't cover. If they don't answer it at all, write exactly "The annual report excerpts I searched don't explain this." as SPOKEN, and in DETAILED list the related information the excerpts do contain (if any), with citations.
6. If the question is about a period the excerpts do not cover, say which period they do cover.
7. Never recommend buying, selling or holding anything, and never predict the share price.

DEPTH
- Use every relevant excerpt, not just the first. Connect the dots: the figures, how they moved versus the previous year (as stated), the reasons management gives, related items (working capital, capex, borrowings, segments) and anything that qualifies the picture (risks, one-offs, accounting changes).
- Finish with what it means for an everyday investor, in plain words: an interpretation of the report's facts, never advice.

Reply in exactly this format and nothing else (keep the labels UNDERSTOOD, ANSWERED, SPOKEN, DETAILED in English):
UNDERSTOOD: <the visitor's question restated as one clear sentence, fixing any speech-recognition slips>
ANSWERED: <YES if the excerpts answer the question at least in part, NO if they don't answer it at all>
SPOKEN: <4 to 7 natural, conversational sentences (about 80 to 140 words). Answer the question directly first, then the key figures and the main reasons. It is read aloud, so: no markdown, no lists, no citation tags.>
DETAILED:
### <short heading>
- <point> [S#]
- <point> [S#]
### <short heading>
- <point> [S#]
(Use 2 to 4 headings that fit the question, such as "The numbers", "Why it changed", "What management says", "Risks and caveats", "What this means for investors", with 8 to 14 points in total. Every factual point ends with its [S#] citation; a closing "what this means" point may skip the citation only if it adds no new fact.)`;

/* v10: answer language. The labels stay in English (the browser parses them); everything the visitor reads is in their language. */
const NOT_EXPLAINED = { en: "The annual report excerpts I searched don't explain this.", hi: 'मैंने वार्षिक रिपोर्ट के जो अंश देखे, उनमें इसकी जानकारी नहीं है।', hinglish: 'Annual report ke jo excerpts maine dekhe, unmein iski jaankari nahi hai.' };
const LANG_RULES = {
  en: '',
  hi: `

LANGUAGE — the visitor asked in HINDI.
- Write UNDERSTOOD, SPOKEN and DETAILED (including every ### heading) in simple, natural, everyday Hindi in Devanagari script, the way a friendly Indian analyst would explain it on the phone — not formal or bookish Hindi.
- Keep English business terms that Indians normally use (revenue, EBITDA, cash flow, margin, segment, FY25) — written in Devanagari or English, whichever reads more naturally.
- Write every number with the digits 0-9 exactly as in the excerpts (never Devanagari digits), with its unit and currency (₹, crore, lakh, %, million, billion).
- If the excerpts don't answer the question, write ANSWERED: NO and SPOKEN exactly: "${NOT_EXPLAINED.hi}"`,
  hinglish: `

LANGUAGE — the visitor asked in HINGLISH (Hindi written in English letters, mixed with English words).
- Write UNDERSTOOD, SPOKEN and DETAILED (including every ### heading) in natural Hinglish using English (Latin) letters only — the way Indians chat, e.g. "Is saal company ka revenue 12% badha, mainly retail business ki wajah se." Never use Devanagari in these three.
- Use English for business terms (revenue, profit, cash flow, debt, margin). Write numbers exactly as in the excerpts.
- If the excerpts don't answer the question, write ANSWERED: NO and SPOKEN exactly: "${NOT_EXPLAINED.hinglish}"
- ALSO add, straight after SPOKEN and before DETAILED, one line: "VOICE: <the same text as SPOKEN, written in Devanagari script so a Hindi voice can read it aloud; English words transliterated into Devanagari; numbers as digits 0-9>".`
};
// same idea as js/voice.js: Devanagari → Hindi; Hindi words in English letters → Hinglish
const HI_STRONG = new Set(('kya kyu kyun kyon kaise kaisa kaisi kitna kitni kitne kab kaun kahan batao bataiye bataye samjhao samjhaiye hai hain nahi nahin ' +
  'kyunki lekin matlab iska iski iske uska uski uske unka unki unke raha rahi rahe gaya gayi hua hui hue mein aur kuch bahut zyada jyada chahiye sakta sakti ' +
  'sakte pichle pichhle saal munafa kamai nuksan nuksaan karza karz kijiye dijiye wala wali wale yeh woh tha thi hota hoti hote badha badhi ghata gira giri').split(' '));
const HI_WEAK = new Set('ka ki ke ko se ho ye wo ya par aap hum tum toh bhi'.split(' '));
function detectLang(t) {
  const s0 = String(t || '');
  const dev = (s0.match(/[\u0900-\u097F]/g) || []).length, lat = (s0.match(/[A-Za-z]/g) || []).length;
  if (dev) return dev >= lat * 0.5 ? 'hi' : 'hinglish';
  const w = s0.toLowerCase().match(/[a-z]+/g) || [];
  let st = 0, wk = 0;
  w.forEach((x) => { if (HI_STRONG.has(x)) st++; else if (HI_WEAK.has(x)) wk++; });
  return st * 2 + wk >= 3 || (st >= 1 && w.length <= 3) ? 'hinglish' : 'en';
}
const asciiDigits = (x) => String(x || '').replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)));
// split a reply into its labelled parts (labels may be bold, or several may share a line)
function replySections(text) {
  const t = String(text || '').replace(/[ \t]+(?=(?:\*\*)?(?:UNDERSTOOD|ANSWERED|SPOKEN|VOICE|DETAILED)(?:\*\*)?\s*:)/g, '\n');
  const out = {}; let cur = null;
  const LBL = /^\s*[*_#>\s]*(UNDERSTOOD|ANSWERED|SPOKEN|VOICE|DETAILED)[*_]*\s*:[*_]*\s*/;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(LBL);
    if (m) { cur = m[1]; out[cur] = line.slice(m[0].length); continue; }
    if (cur) out[cur] += '\n' + line;
  }
  Object.keys(out).forEach((k) => { out[k] = out[k].trim(); });
  return out;
}

/* v8: the refining step. A cheap call that cleans up a spoken question and suggests the words an annual report would use,
   so the browser's keyword search finds better passages. If it fails, the browser simply uses the question as typed. */
const REFINE_TAGS = ['cashflow', 'income', 'balance', 'notes', 'mdna', 'risk', 'business', 'directors', 'governance', 'auditor', 'esg'];
const REFINE_PROMPT = `You turn a visitor's question about ONE company's annual report into a clear search request. The question may come from speech recognition, so it can contain filler words, mis-heard terms ("cap ex" = capex, "e bit da" = EBITDA, "f y 25" = FY25, "net worth" vs "networth"), Indian-English phrasing, Hinglish, or be a vague follow-up.

Return ONLY a JSON object, no other text:
{"question": "...", "intent": "...", "keywords": ["..."], "sections": ["..."], "aspects": ["..."]}

- question: ONE clear, standalone question in plain English (at most 35 words). Fix recognition errors, resolve "it / that / this" using the earlier questions, keep the visitor's meaning and any year or period they mentioned. Never add a year they did not mention. Do not answer it.
- intent: 2 to 6 words naming what they want to know.
- keywords: 6 to 14 words or short phrases an annual report would use for this topic: formal accounting terms, synonyms and line-item names (e.g. "net cash from operating activities", "borrowings", "finance costs", "segment revenue").
- sections: 1 to 3 of: ${REFINE_TAGS.join(', ')}, where the answer is most likely to be.
- aspects: 2 to 4 short sub-questions a thorough answer should cover (e.g. the figures, the change versus last year, management's stated reasons, outlook or risks).
If the message is not about the company (e.g. a greeting), return the message unchanged as "question" with empty lists.
The message may be in Hindi (Devanagari script) or Hinglish (Hindi in English letters, e.g. "revenue kyun gira?"). The annual report is in English, so ALWAYS write question, intent, keywords and aspects in ENGLISH — translate the meaning faithfully (munafa / मुनाफ़ा = profit, kamai / आय = revenue or income, karz / क़र्ज़ = debt, jokhim / जोखिम = risk, kharcha / खर्च = expenses).`;

// Sarvam AI Bulbul v3 speakers (Indian voices). The browser offers a short list; anything else falls back to the default.
const SARVAM_V3_SPEAKERS = new Set(('aditya ritu priya neha rahul pooja rohan simran kavya amit dev ishita shreya ratan varun manan sumit roopa kabir aayan ' +
  'shubh ashutosh advait anand tanya tarun sunny mani gokul vijay shruti suhani mohit kavitha rehan soham rupali').split(' '));

const cleanStr = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').slice(0, max);

async function softCounter(cache, key, ttlSeconds, inc) {
  const k = new Request('https://plutus-cache/rl/' + encodeURIComponent(key));
  const hit = await cache.match(k);
  const n = (hit ? parseInt(await hit.text(), 10) || 0 : 0) + (inc || 1);
  await cache.put(k, new Response(String(n), { headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` } }));
  return n;
}
async function hasMarker(cache, key) { return !!(await cache.match(new Request('https://plutus-cache/mk/' + encodeURIComponent(key)))); }
async function setMarker(cache, key, ttlSeconds) {
  await cache.put(new Request('https://plutus-cache/mk/' + encodeURIComponent(key)), new Response('1', { headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` } }));
}
const clientIp = (req) => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';

function originAllowed(req) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(req.headers.get('Origin') || '');
}

async function readJson(req, cors) {
  const text = await req.text();
  if (text.length > V.maxBody) return { err: json({ error: 'request too large' }, 413, cors) };
  try { return { body: JSON.parse(text) }; } catch (e) { return { err: json({ error: 'bad json' }, 400, cors) }; }
}

/* ---------- POST /prepare ---------- */
async function handlePrepare(req, env, cors, cache) {
  if (!originAllowed(req)) return json({ error: 'origin not allowed' }, 403, cors);
  const r = await readJson(req, cors); if (r.err) return r.err;
  const symbol = String(r.body.symbol || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return json({ error: 'bad symbol' }, 400, cors);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json({ error: 'not_configured' }, 503, cors);
  const force = r.body.force === true;
  if (!force && await hasMarker(cache, 'prep/' + symbol)) return json({ ok: true, status: 'already_requested' }, 200, cors);
  const hour = Math.floor(Date.now() / 3600e3);
  if (await softCounter(cache, `prepip/${clientIp(req)}/${hour}`, 3600) > V.preparePerHourPerIp) return json({ error: 'rate_limited' }, 429, cors);
  if (await softCounter(cache, `prepall/${hour}`, 3600) > V.prepareGlobalPerHour) return json({ error: 'busy' }, 429, cors);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/prepare-report.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'plutus-worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs: { symbol, force: force ? 'true' : 'false' } })
  });
  if (res.status !== 204) return json({ error: 'dispatch_failed', status: res.status }, 502, cors);
  await setMarker(cache, 'prep/' + symbol, V.prepareCooldownSeconds);
  return json({ ok: true, status: 'started' }, 200, cors);
}

/* ---------- number guard ---------- */
const numTokens = (s) => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => String(Number(x.replace(/,/g, '').replace(/\.$/, ''))));
function unverifiedNumbers(answer, allowedText) {
  const allowed = new Set(numTokens(allowedText));
  const seen = new Set(), bad = [];
  for (const raw of (String(answer).replace(/\[S\d+\]/g, ' ').match(/\d[\d,]*(?:\.\d+)?/g) || [])) {
    const n = String(Number(raw.replace(/,/g, '').replace(/\.$/, '')));
    if (seen.has(n)) continue; seen.add(n);
    const v = Number(n);
    if (!Number.isFinite(v)) continue;
    if (Number.isInteger(v) && v < 10) continue;                   // "3 sentences", list numbers
    if (Number.isInteger(v) && v >= 1990 && v <= 2100) continue;   // years
    if (!allowed.has(n)) bad.push(raw);
  }
  return bad;
}

/* ---------- AI providers (all free tiers) ---------- */
async function withTimeout(fn, ms) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms || V.providerTimeoutMs);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}
/* ---------- v9: the free-service pool ----------
   OpenAI-compatible services share one caller. `prefer` lists, best first, which of the service's current models to use
   (one model per pattern, up to `max`); `fallback` is used only if the model list can't be read. */
const OPENAI_SERVICES = {
  groq: { base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY', pin: 'GROQ_MODEL', max: 3,
    prefer: [/gpt-oss-120b/i, /llama-3\.3-70b/i, /qwen[\w.-]*-(2\d|3\d)b/i, /llama-4/i, /gpt-oss-20b/i], fallback: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'] },
  cerebras: { base: 'https://api.cerebras.ai/v1', key: 'CEREBRAS_API_KEY', max: 2,
    prefer: [/gpt-oss-120b/i, /qwen[\w.-]*-(2\d|3\d|235)b/i, /llama-3\.3-70b/i], fallback: ['gpt-oss-120b'] },
  mistral: { base: 'https://api.mistral.ai/v1', key: 'MISTRAL_API_KEY', max: 2,
    prefer: [/^mistral-medium-latest$/, /^mistral-large-latest$/, /^mistral-small-latest$/], fallback: ['mistral-small-latest'] },
  nvidia: { base: 'https://integrate.api.nvidia.com/v1', key: 'NVIDIA_API_KEY', max: 2,
    prefer: [/llama-3\.3-70b-instruct/i, /nemotron[\w.-]*super/i, /deepseek[\w.-]*(v3|v4)/i, /qwen[\w.-]*-(2\d|3\d|235)b/i], fallback: ['meta/llama-3.3-70b-instruct'] },
  github: { base: 'https://models.github.ai/inference', key: 'GITHUB_MODELS_TOKEN', catalog: 'https://models.github.ai/catalog/models', max: 2,
    prefer: [/gpt-4\.1-mini/i, /gpt-4o-mini/i, /llama-3\.3-70b/i, /mistral-(medium|small)/i], fallback: ['openai/gpt-4.1-mini'] },
  openrouter: { base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', freeOnly: true, max: 2,
    prefer: [/gpt-oss-120b/i, /llama-3\.3-70b/i, /deepseek/i, /qwen/i, /nemotron/i, /./], fallback: [] }
};
const NOT_CHAT = /whisper|tts|speech|audio|transcri|guard|embed|rerank|moderat|image|vision|[-_]vl\b|ocr|realtime|search|safety|reward|retriev|parse|code(stral)?|coder|-e\d+b|\b(0\.\d|1|2|3|4)b\b/i;

const memo = {};   // model lists, per Worker instance (also kept in the edge cache)
const cfg = (env, k) => String(env[k] || '').trim();
const pickModels = (ids, svc) => {
  const ok = ids.filter((id) => typeof id === 'string' && !NOT_CHAT.test(id) && (!svc.freeOnly || /:free$/.test(id)));
  const out = [];
  for (const rx of svc.prefer) { const m = ok.find((id) => rx.test(id) && !out.includes(id)); if (m) out.push(m); if (out.length >= svc.max) break; }
  return out;
};
async function discover(name, svc, env, cache) {
  const pinned = cfg(env, name.toUpperCase() + '_MODELS');
  if (pinned) return pinned.split(',').map((s) => s.trim()).filter(Boolean);
  const m = memo[name]; if (m && Date.now() - m.ts < 3600e3) return m.list;
  const key = new Request('https://plutus-cache/models/' + name);
  const hit = await cache.match(key);
  if (hit) { const list = await hit.json(); memo[name] = { ts: Date.now(), list }; return list; }
  let ids = [];
  try {
    const res = await withTimeout((signal) => fetch(svc.catalog || svc.base + '/models', { signal, headers: { Authorization: `Bearer ${env[svc.key]}`, Accept: 'application/json' } }), 8000);
    if (res.ok) { const j = await res.json(); const arr = Array.isArray(j) ? j : (j.data || j.models || []); ids = arr.map((x) => (typeof x === 'string' ? x : x && (x.id || x.name))); }
  } catch (e) { /* use the fallback list */ }
  let list = pickModels(ids, svc);
  if (!list.length) list = svc.fallback.slice();
  const pin = svc.pin && cfg(env, svc.pin); if (pin) list = [pin].concat(list.filter((x) => x !== pin));
  memo[name] = { ts: Date.now(), list };
  await cache.put(key, new Response(JSON.stringify(list), { headers: { 'Cache-Control': `public, max-age=${ids.length ? 12 * 3600 : 600}` } }));
  return list;
}
async function discoverGemini(env, cache) {
  const pinned = cfg(env, 'GEMINI_MODELS');
  if (pinned) return pinned.split(',').map((s) => s.trim()).filter(Boolean);
  const m = memo.gemini; if (m && Date.now() - m.ts < 3600e3) return m.list;
  const key = new Request('https://plutus-cache/models/gemini');
  const hit = await cache.match(key);
  if (hit) { const list = await hit.json(); memo.gemini = { ts: Date.now(), list }; return list; }
  let ids = [];
  try {
    const res = await withTimeout((signal) => fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { signal, headers: { 'x-goog-api-key': env.GEMINI_API_KEY } }), 8000);
    if (res.ok) {
      const j = await res.json();
      ids = (j.models || []).filter((x) => (x.supportedGenerationMethods || []).includes('generateContent')).map((x) => String(x.name || '').replace(/^models\//, ''));
    }
  } catch (e) { /* fallback below */ }
  ids = ids.filter((id) => !/tts|image|live|embed|aqa|audio|computer|robotics|learnlm|nano|veo|imagen|exp|-e\d+b|-1b|-4b|preview-\d\d-\d\d/i.test(id));
  // each Gemini / Gemma model has its own free daily quota, so three of them triple the allowance
  const list = [];
  for (const rx of [/^gemini-[\d.]+-flash-lite$/, /^gemini-[\d.]+-flash$/, /^gemini-flash-lite-latest$/, /^gemma-\d+-27b-it$/, /^gemma-\d+-12b-it$/, /^gemini-[\d.]+-flash-lite/, /^gemini-[\d.]+-flash/]) {
    const hitId = ids.filter((id) => rx.test(id)).sort().reverse().find((id) => !list.includes(id)); // newest version first
    if (hitId) list.push(hitId); if (list.length >= 3) break;
  }
  if (!list.length) list.push(V.defaults.gemini);
  const pin = cfg(env, 'GEMINI_MODEL'); const out = pin ? [pin].concat(list.filter((x) => x !== pin)) : list;
  memo.gemini = { ts: Date.now(), list: out };
  await cache.put(key, new Response(JSON.stringify(out), { headers: { 'Cache-Control': `public, max-age=${ids.length ? 12 * 3600 : 600}` } }));
  return out;
}

const httpErr = (name, res) => Object.assign(new Error(name + ' ' + res.status), { status: res.status, retryAfter: Number(res.headers.get('Retry-After')) || 0 });
// o (optional): { kind: 'answer' | 'refine', big } — the refine step uses a small output budget and temperature 0;
// big = a Hindi / Hinglish answer (Devanagari takes several times more tokens than English, and Hinglish adds a VOICE copy)
async function callOpenAI(svc, name, model, env, system, user, o) {
  const refine = o && o.kind === 'refine', big = !!(o && o.big);
  const body = { model, temperature: refine ? 0 : 0.2, max_tokens: refine ? 700 : big ? 3800 : 2400, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (name === 'groq') { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  if (/gpt-oss/i.test(model) && (name === 'groq' || name === 'cerebras')) body.reasoning_effort = 'low';
  const res = await withTimeout((signal) => fetch(svc.base + '/chat/completions', {
    method: 'POST', signal, headers: { Authorization: `Bearer ${env[svc.key]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), refine ? V.refineTimeoutMs : 0);
  if (!res.ok) throw httpErr(name, res);
  const j = await res.json();
  const msg = ((j.choices || [])[0] || {}).message || {};
  return { text: typeof msg.content === 'string' ? msg.content : '', model };
}
async function callGemini(model, env, system, user, o) {
  const refine = o && o.kind === 'refine', big = !!(o && o.big);
  const generationConfig = { temperature: refine ? 0 : 0.2, maxOutputTokens: refine ? 700 : big ? 4800 : 3000 };
  if (refine && !/gemma/i.test(model)) generationConfig.responseMimeType = 'application/json';
  // Gemma models on the Gemini API don't take a system instruction: put the rules at the top of the message instead
  const req = /gemma/i.test(model)
    ? { contents: [{ role: 'user', parts: [{ text: system + '\n\n---\n\n' + user }] }], generationConfig }
    : { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig };
  const res = await withTimeout((signal) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal, headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(req) }), refine ? V.refineTimeoutMs : 0);
  if (!res.ok) throw httpErr('gemini', res);
  const j = await res.json();
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return { text: parts.filter((p) => !p.thought).map((p) => p.text || '').join(''), model };
}
async function callWorkersAI(env, system, user, o) {
  const refine = o && o.kind === 'refine', big = !!(o && o.big);
  const model = env.WORKERS_AI_MODEL || V.defaults.workersai;
  const out = await env.AI.run(model, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: refine ? 500 : big ? 2600 : 1600, temperature: refine ? 0 : 0.2 });
  const text = typeof out === 'string' ? out : (out && (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content))) || '';
  return { text, model };
}

// every usable service+model, in PROVIDER_ORDER, minus the ones resting after a limit/error ("cooldown")
async function providerList(env, cache) {
  const order = String(env.PROVIDER_ORDER || 'groq,gemini,mistral,cerebras,nvidia,github,openrouter,workersai').split(',').map((s) => s.trim().toLowerCase());
  const out = [];
  for (const name of order) {
    if (name === 'gemini' && env.GEMINI_API_KEY) {
      (await discoverGemini(env, cache)).forEach((model) => out.push({ name, model, fn: (e, s, u, o) => callGemini(model, e, s, u, o) }));
    } else if (name === 'workersai' && env.AI) {
      out.push({ name, model: env.WORKERS_AI_MODEL || V.defaults.workersai, fn: callWorkersAI });
    } else if (OPENAI_SERVICES[name] && env[OPENAI_SERVICES[name].key]) {
      const svc = OPENAI_SERVICES[name];
      (await discover(name, svc, env, cache)).forEach((model) => out.push({ name, model, fn: (e, s, u, o) => callOpenAI(svc, name, model, e, s, u, o) }));
    }
  }
  const resting = await Promise.all(out.map((p) => cache.match(new Request(`https://plutus-cache/cool/${p.name}/${encodeURIComponent(p.model)}`))));
  return out.filter((_, i) => !resting[i]);
}
async function coolDown(cache, p, e) {
  const st = (e && e.status) || 0;
  let secs = 120;                                                     // network error / timeout / 5xx
  if (st === 429) secs = Math.min(Math.max(e.retryAfter || 0, 600), 6 * 3600);   // limit reached: at least 10 min
  else if (st === 401 || st === 403) secs = 6 * 3600;                 // bad key / no access
  else if (st === 404 || st === 400) { secs = 6 * 3600; delete memo[p.name]; await cache.delete(new Request('https://plutus-cache/models/' + p.name)); } // model retired: re-discover
  await cache.put(new Request(`https://plutus-cache/cool/${p.name}/${encodeURIComponent(p.model)}`), new Response('1', { headers: { 'Cache-Control': `public, max-age=${secs}` } }));
}
// try the pool in order until one answers; `accept(text)` decides whether an answer is usable
async function runPool(env, cache, system, user, o, accept) {
  const pool = await providerList(env, cache);
  const errors = [];
  for (const p of pool.slice(0, V.maxAttempts)) {
    try {
      const out = await p.fn(env, system, user, o);
      const text = String(out.text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const ok = text && (!accept || accept(text));
      if (ok) return { result: { text, model: out.model, provider: p.name, parsed: ok }, pool };
      errors.push(`${p.name}/${p.model}: empty`);
    } catch (e) {
      errors.push(`${p.name}/${p.model}: ${String(e.message || e).slice(0, 60)}`);
      await coolDown(cache, p, e);
    }
  }
  return { result: null, errors, pool };
}

/* ---------- POST /ask ---------- */
const hasAnyAI = (env) => !!(env.AI || env.GEMINI_API_KEY || Object.values(OPENAI_SERVICES).some((s) => env[s.key]));
const ANS_STOP = new Set('a an the of and or to in on for with by at from is are was were be it its this that what why how did does do has have had can could would should will me my we our you your they their about tell please company companys'.split(' '));
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function handleAsk(req, env, cors, cache, ctx) {
  if (!originAllowed(req)) return json({ error: 'origin not allowed' }, 403, cors);
  if (!hasAnyAI(env)) return json({ error: 'not_configured' }, 503, cors);
  const r = await readJson(req, cors); if (r.err) return r.err;
  const b = r.body || {};
  const symbol = String(b.symbol || '').trim().toUpperCase();
  const question = cleanStr(b.question, V.maxQuestion).trim();
  if (!SYMBOL_RE.test(symbol) || question.length < 2) return json({ error: 'bad request' }, 400, cors);
  const ex = (Array.isArray(b.excerpts) ? b.excerpts : []).slice(0, V.maxExcerpts).map((e) => ({
    section: cleanStr(e && e.section, 90), page: Number.isInteger(e && e.page) ? e.page : null, text: cleanStr(e && e.text, V.maxExcerptChars)
  })).filter((e) => e.text.length > 20);
  if (!ex.length) return json({ error: 'no excerpts' }, 400, cors);
  const meta = b.meta || {};
  const rep = meta.report || {};
  const rf0 = b.refined && typeof b.refined === 'object' ? b.refined : {};
  const lang = ['en', 'hi', 'hinglish'].includes(b.lang) ? b.lang : detectLang(question);

  // v9: a stand-alone question (no conversation history) asked again — same company, same report, same passages —
  // is answered from the edge cache: no AI call, no tokens. Word order and small words don't matter.
  const histIn = Array.isArray(b.history) ? b.history.filter((h) => h && h.q) : [];
  let cacheKey = null;
  if (!histIn.length) {
    // v10: Unicode words (Hindi questions have no a-z letters at all) and the answer language are part of the key
    const words = [...new Set(String(rf0.question || question).toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [])].filter((w) => w.length > 1 && !ANS_STOP.has(w)).sort();
    cacheKey = new Request('https://plutus-cache/ans2/' + await sha256([lang, symbol, cleanStr(rep.period_label, 50), cleanStr(rep.filed, 12), words.join(' '), ex.map((e) => e.text.slice(0, 120)).join('|')].join('\n')));
    const hit = await cache.match(cacheKey);
    if (hit) { try { return json({ ...(await hit.json()), cached: true }, 200, cors); } catch (e) { /* bad entry: answer afresh */ } }
  }
  const minute = Math.floor(Date.now() / 60e3);
  if (await softCounter(cache, `askip/${clientIp(req)}/${minute}`, 90) > V.askPerMinute) return json({ error: 'rate_limited' }, 429, cors);

  const header = [
    `Company: ${cleanStr(meta.company || symbol, 90)}`,
    `Report: ${cleanStr(rep.form || 'Annual report', 30)}${rep.period_label ? ', ' + cleanStr(rep.period_label, 50) : ''}${rep.filed ? ', filed ' + cleanStr(rep.filed, 12) : ''}${rep.source ? ' (source: ' + cleanStr(rep.source, 40) + ')' : ''}`
  ].join('\n');
  const hist = histIn.slice(-V.maxHistory)
    .map((h) => `Earlier question: ${cleanStr(h && h.q, 300)}\nEarlier answer: ${cleanStr(h && h.a, 400)}`).join('\n');
  const excerptText = ex.map((e, i) => `[S${i + 1}] Section: ${e.section}${e.page ? ' · page ' + e.page : ''}\n${e.text}`).join('\n\n');
  // v8: the browser also sends the refined reading of the question and the points a full answer should cover
  const rf = rf0;
  const interpreted = cleanStr(rf.question, 400).trim();
  const aspects = (Array.isArray(rf.aspects) ? rf.aspects : []).slice(0, 4).map((a) => cleanStr(a, 160).trim()).filter(Boolean);
  const qBlock = [
    `Visitor's words (typed or from speech recognition, may contain errors): ${question}`,
    interpreted && interpreted.toLowerCase() !== question.toLowerCase() ? `Interpreted question: ${interpreted}` : '',
    aspects.length ? 'A thorough answer should cover:\n' + aspects.map((a) => '- ' + a).join('\n') : ''
  ].filter(Boolean).join('\n');
  const user = `${header}\n${hist ? hist + '\n' : ''}\n${qBlock}\n\nExcerpts:\n${excerptText}`;

  // an answer without the SPOKEN / DETAILED shape (a weak or cut-off reply) is passed over for the next service
  const shaped = (t) => { const x = replySections(t); return !!(x.SPOKEN && x.DETAILED !== undefined) && (lang !== 'hi' || /[\u0900-\u097F]/.test(x.SPOKEN)); };
  const { result, errors } = await runPool(env, cache, SYSTEM_PROMPT + LANG_RULES[lang], user, { kind: 'answer', big: lang !== 'en' }, shaped);
  if (!result) return json({ error: 'all_providers_failed', details: errors }, 503, cors);

  const sec = replySections(result.text);
  const understood = cleanStr(asciiDigits(sec.UNDERSTOOD || '').split('\n')[0], 300).replace(/\*\*/g, '').trim();
  const strip = (s) => s.replace(/\[S(\d+)\]/g, (all, n) => (+n >= 1 && +n <= ex.length ? all : '')).replace(/\*\*/g, '');
  const spoken = strip(asciiDigits(sec.SPOKEN)).replace(/\[S\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
  const detailed = strip(asciiDigits(sec.DETAILED || ''));
  const voice = lang === 'hinglish' && sec.VOICE ? cleanStr(asciiDigits(sec.VOICE), 2000).replace(/\[S\d+\]/g, '').replace(/[*_#`]/g, '').replace(/\s{2,}/g, ' ').trim() : '';
  const cites = [...new Set((detailed.match(/\[S(\d+)\]/g) || []).map((x) => +x.slice(2, -1)))].sort((x, y) => x - y);
  const allowedText = excerptText + ' ' + question + ' ' + interpreted + ' ' + JSON.stringify(rep) + ' ' + cleanStr(meta.company, 90);
  const unverified = unverifiedNumbers(spoken + ' ' + detailed, allowedText);
  const flag = String(sec.ANSWERED || '').trim().toUpperCase();
  const answered = flag.startsWith('NO') ? false : flag.startsWith('YES') ? true : !/don['’]?t explain this|जानकारी नहीं है|jaankari nahi hai/i.test(spoken);
  const out = { understood, spoken, detailed, cites, unverified, answered, lang, provider: result.provider };
  if (voice && /[\u0900-\u097F]/.test(voice)) out.voice = voice;
  if (cacheKey && answered && spoken.length > 40) {
    const put = cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${V.answerCacheSeconds}` } }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  }
  return json(out, 200, cors);
}

/* ---------- v8: POST /refine ---------- */
function parseRefine(text, fallbackQ) {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch (e) { return null; }
  if (!j || typeof j !== 'object') return null;
  const list = (x, n, max) => (Array.isArray(x) ? x : []).map((s) => cleanStr(s, max).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, n);
  const question = cleanStr(j.question, 400).replace(/\s+/g, ' ').trim() || fallbackQ;
  return {
    question,
    intent: cleanStr(j.intent, 60).trim(),
    keywords: list(j.keywords, 14, 48),
    sections: list(j.sections, 3, 20).map((s) => s.toLowerCase()).filter((s) => REFINE_TAGS.includes(s)),
    aspects: list(j.aspects, 4, 160)
  };
}
async function handleRefine(req, env, cors, cache) {
  if (!originAllowed(req)) return json({ error: 'origin not allowed' }, 403, cors);
  if (!hasAnyAI(env)) return json({ error: 'not_configured' }, 503, cors);
  const r = await readJson(req, cors); if (r.err) return r.err;
  const b = r.body || {};
  const question = cleanStr(b.question, V.maxQuestion).replace(/\s+/g, ' ').trim();
  if (question.length < 2) return json({ error: 'bad request' }, 400, cors);
  const minute = Math.floor(Date.now() / 60e3);
  if (await softCounter(cache, `refip/${clientIp(req)}/${minute}`, 90) > V.refinePerMinute) return json({ error: 'rate_limited' }, 429, cors);
  const hist = (Array.isArray(b.history) ? b.history : []).slice(-V.maxHistory)
    .map((h) => `Earlier question: ${cleanStr(h && h.q, 300)}\nEarlier answer (start): ${cleanStr(h && h.a, 200)}`).join('\n');
  const lang = ['en', 'hi', 'hinglish'].includes(b.lang) ? b.lang : detectLang(question);
  const langName = { en: 'English', hi: 'Hindi (Devanagari) — translate to English', hinglish: 'Hinglish (Hindi in English letters) — translate to English' }[lang];
  const user = `Company: ${cleanStr(b.company || b.symbol || '', 90)}\nLanguage of the message: ${langName}\n${hist ? hist + '\n' : ''}Visitor's message: ${question}`;
  const { result, errors } = await runPool(env, cache, REFINE_PROMPT, user, { kind: 'refine' }, (t) => parseRefine(t, question));
  if (result) return json({ ...result.parsed, provider: result.provider }, 200, cors);
  return json({ error: 'all_providers_failed', details: errors }, 503, cors);
}

/* ---------- v8: POST /speak — natural Indian-English voice (Sarvam AI Bulbul) ----------
   Body: { text, speaker, lang: "en-IN" | "hi-IN" }. Returns the audio (mp3). Errors use the codes the browser already understands:
   not_configured (no key), rate_limited (this visitor is too fast), tts_budget (daily character budget used up). */
function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function handleSpeak(req, env, cors, cache) {
  if (!originAllowed(req)) return json({ error: 'origin not allowed' }, 403, cors);
  if (!env.SARVAM_API_KEY) return json({ error: 'not_configured' }, 503, cors);
  const r = await readJson(req, cors); if (r.err) return r.err;
  const b = r.body || {};
  const text = cleanStr(b.text, V.ttsMaxChars).replace(/\s+/g, ' ').trim();
  if (!text) return json({ error: 'bad request' }, 400, cors);
  const minute = Math.floor(Date.now() / 60e3), day = Math.floor(Date.now() / 86400e3);
  if (await softCounter(cache, `spkip/${clientIp(req)}/${minute}`, 90) > V.speakPerMinute) return json({ error: 'rate_limited' }, 429, cors);
  const budget = Number(env.TTS_DAILY_CHARS) || V.ttsDailyChars;
  if (await softCounter(cache, `ttsday/${day}`, 26 * 3600, text.length) > budget) return json({ error: 'tts_budget' }, 429, cors);

  const model = env.SARVAM_TTS_MODEL || 'bulbul:v3';
  const language = /^hi(-in)?$/i.test(String(b.lang || '')) ? 'hi-IN' : 'en-IN'; // v10: Hindi answers use Sarvam's Hindi voice
  const body = { text, language_code: language, model, speech_sample_rate: 24000, output_audio_codec: 'mp3' };
  const asked = String(b.speaker || '').toLowerCase();
  if (env.SARVAM_SPEAKER) body.speaker = env.SARVAM_SPEAKER;
  else if (/^bulbul:v3/.test(model)) body.speaker = SARVAM_V3_SPEAKERS.has(asked) ? asked : 'shubh';
  let res;
  try {
    res = await withTimeout((signal) => fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST', signal, headers: { 'api-subscription-key': env.SARVAM_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), 20000);
  } catch (e) { return json({ error: 'tts_failed' }, 502, cors); }
  if (res.status === 429) return json({ error: 'tts_budget' }, 429, cors);          // provider quota / credits
  if (res.status === 401 || res.status === 403) return json({ error: 'not_configured' }, 503, cors); // bad / missing key
  if (!res.ok) return json({ error: 'tts_failed', status: res.status }, 502, cors);
  let j; try { j = await res.json(); } catch (e) { return json({ error: 'tts_failed' }, 502, cors); }
  const audios = Array.isArray(j && j.audios) ? j.audios : [];
  if (!audios.length) return json({ error: 'tts_failed' }, 502, cors);
  const bytes = b64ToBytes(audios.join(''));
  const isWav = bytes.length > 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // "RIFF"
  return new Response(bytes, { status: 200, headers: { 'Content-Type': isWav ? 'audio/wav' : 'audio/mpeg', 'Cache-Control': 'no-store', ...cors } });
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'GET or POST only' }, 405, cors);
    const params = new URL(req.url).searchParams;
    const cache = caches.default;

    // ---- v7: voice bot routes ----
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    const routes = { '/ask': handleAsk, '/prepare': handlePrepare, '/refine': handleRefine, '/speak': handleSpeak };
    if (routes[path]) {
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
      try { return await routes[path](req, env, cors, cache, ctx); }
      catch (e) { return json({ error: 'server_error' }, 500, cors); }
    }

    // ---- ?og=<article url>: news thumbnail lookup (cached for a day) ----
    const og = params.get('og');
    if (og && req.method === 'GET') {
      const key = new Request('https://plutus-cache/og/' + encodeURIComponent(og));
      const hit = await cache.match(key);
      if (hit) return withCors(hit, cors, 'HIT');
      const out = json({ image: await ogImage(og) }, 200, { 'Cache-Control': `public, max-age=${OG_CACHE_SECONDS}` });
      ctx.waitUntil(cache.put(key, out.clone()));
      return withCors(out, cors, 'MISS');
    }

    const target = params.get('url');
    if (!target) return json({ ok: true, usage: '?url=<encoded Yahoo Finance or Bing News RSS URL> | ?og=<article URL>' }, 200, cors);
    let parsed;
    try { parsed = new URL(target); } catch (e) { return json({ error: 'bad url' }, 400, cors); }
    const isNews = NEWS_HOSTS.includes(parsed.hostname) && NEWS_PATHS.includes(parsed.pathname);
    if (parsed.protocol !== 'https:' || !(ALLOWED_HOSTS.includes(parsed.hostname) || isNews)) return json({ error: 'host not allowed' }, 403, cors);

    // ---- POST: screener only (no edge caching) ----
    if (req.method === 'POST') {
      if (isNews || !ALLOWED_POST_PATHS.includes(parsed.pathname)) return json({ error: 'POST not allowed for this path' }, 403, cors);
      const body = await req.text();
      if (body.length > 20000) return json({ error: 'body too large' }, 413, cors);
      const res = await yahoo(parsed.toString(), { method: 'POST', body });
      const text = await res.text();
      const extra = res.headers.get('Retry-After') ? { 'Retry-After': res.headers.get('Retry-After') } : {};
      return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...extra, ...cors } });
    }

    // ---- GET (cached; last good copy kept for when Yahoo / Bing refuse) ----
    const cacheKey = new Request('https://plutus-cache/' + encodeURIComponent(parsed.toString()));
    const staleKey = new Request('https://plutus-cache/stale/' + encodeURIComponent(parsed.toString()));
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached, cors, 'HIT');

    let res;
    try {
      res = isNews
        ? await fetch(parsed.toString(), { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' } })
        : await yahoo(parsed.toString());
    } catch (e) { res = new Response(JSON.stringify({ error: 'upstream unreachable' }), { status: 502 }); }
    const type = isNews ? 'application/rss+xml; charset=utf-8' : 'application/json';
    const body = await res.text();
    if (res.ok) {
      const out = new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${CACHE_SECONDS}`, ...cors, 'X-Cache': 'MISS' } });
      ctx.waitUntil(Promise.all([
        cache.put(cacheKey, out.clone()),
        cache.put(staleKey, new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${STALE_SECONDS}` } }))
      ]));
      return out;
    }
    // refused / failed: an older good copy is better than an error ("not found" stays an error)
    if (res.status !== 400 && res.status !== 404) {
      const stale = await cache.match(staleKey);
      if (stale) return withCors(stale, cors, 'STALE');
    }
    const extra = res.headers.get('Retry-After') ? { 'Retry-After': res.headers.get('Retry-After') } : {};
    return new Response(body, { status: res.status, headers: { 'Content-Type': type, ...extra, ...cors } });
  }
};
