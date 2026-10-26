# Plutus voice bot — setup guide

A floating **Ask Plutus** button appears on every stock page. Visitors ask by voice or by typing
("Why did cash flow fall in FY26?", "revenue kyun badha?", "कंपनी पर कितना कर्ज़ है?") and Plutus answers
**only from the company's latest annual report**, in the language they asked in, shows where each answer comes from,
and reads it aloud.

Everything runs on free tiers. After the one-time setup below there is nothing to do by hand:
the first time anyone opens the bot for a company, the report is fetched, read and indexed automatically;
a nightly job picks up newly published reports.

## How it works

```
 browser (js/voice.js)                    Cloudflare Worker (worker/worker.js)         GitHub Actions
 ─────────────────────                    ────────────────────────────────────         ──────────────
 stock page → "Ask Plutus"
   │ is data/reports/<SYMBOL>.json there?
   │ no ──────────────────────────────►  POST /prepare ─────────────────────────────►  scripts/prepare_report.py
   │                                                                                    1 find latest annual report
   │ ◄──── polls every 15 s ◄───────────────────────── commits data/reports/<SYMBOL>.json 2 read text + tables
   │ yes                                                                                3 split into labelled chunks
   │ finds the best passages (BM25)
   │ ── question + passages ──────────────► POST /ask → Groq → Gemini → Workers AI
   │ ◄── spoken answer, details, sources ── number check: every figure must appear in the passages
   speaks it (browser voice)
```

* **US companies:** SEC EDGAR (10-K / 20-F) — official API, no key.
* **Indian companies (.NS / .BO):** NSE annual-reports API → BSE API → the company's own website (found via Yahoo).
* **Anything else:** `data/report_sources.json` lets you pin a direct PDF/HTML link for a symbol,
  e.g. `{ "TCS.NS": "https://…/annual-report.pdf" }`. Optional.

## One-time setup (about 20 minutes)

### 1. Get free AI keys (one works; every extra one adds its own free daily allowance)
All of these are free, need no card, and are used in this order. Each key goes into the Worker as a **Secret** (step 4).

| Secret name | Where to get it | Free allowance (roughly — check the service) |
|---|---|---|
| `GROQ_API_KEY` | console.groq.com → API Keys | ~1,000 requests / day **per model**; the Worker uses up to 3 models |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key | separate daily quota per model; the Worker uses up to 3 (Gemini Flash-Lite, Flash, Gemma) |
| `MISTRAL_API_KEY` | console.mistral.ai → choose the free "Experiment" plan (phone check) → API keys | very large monthly allowance, 1 request / second |
| `NVIDIA_API_KEY` | build.nvidia.com → sign in → Get API key (phone check) | ~40 requests / minute |
| `GITHUB_MODELS_TOKEN` | github.com → Settings → Developer settings → Fine-grained token with **Models: read** | ~150 requests / day for the best models |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys | 50 requests / day on its free models |
| `CEREBRAS_API_KEY` | cloud.cerebras.ai (only if your account has a free plan) | varies |

Free-tier prompts may be used by these companies to improve their products; the questions and report passages are public information, but keep that in mind.
You never need to type model names: the Worker reads each service's current model list and picks good ones, so it keeps working when free models are renamed or retired. To pin models, add a text variable such as `GROQ_MODELS = "openai/gpt-oss-120b,llama-3.3-70b-versatile"`.

### 2. Put the files in your GitHub repo
Upload this folder's contents to the repo that hosts the site (same level as `index.html`):

| File | What it is |
|---|---|
| `js/voice.js`, `css/voice.css` | the button, panel, search, speech, Hindi / Hinglish |
| `js/app.js`, `css/style.css` | updated: the sticky section bar (tabs above the company name) |
| `js/config.js`, `index.html`, `sw.js` | updated (two new settings, two new tags, cache version 23) |
| `scripts/prepare_report.py`, `scripts/requirements.txt` | the report job |
| `.github/workflows/prepare-report.yml` | runs the job |
| `data/reports/`, `data/report_sources.json` | where results are saved |
| `worker/worker.js` | Worker v10 (paste into Cloudflare, step 4) |

If the web uploader skips the `.github` folder: **Add file → Create new file**, type
`.github/workflows/prepare-report.yml` as the name, and paste the file's contents.

### 3. GitHub settings
1. **Settings → Secrets and variables → Actions → Variables → New repository variable**
   * `SEC_USER_AGENT` = `Plutus YourName your-email@example.com` (the SEC requires a real contact in the User-Agent)
   * `WORKER_URL` = your Worker's URL (used to look up company websites for the fallback)
2. **Settings → Actions → General → Workflow permissions →** *Read and write permissions* (only needed if the job's push is refused).
3. Create a token for the Worker: **Profile → Settings → Developer settings → Fine-grained tokens → Generate**
   * Repository access: *Only select repositories* → your Plutus repo
   * Permissions → Repository → **Actions: Read and write**
   * Copy the token.

### 4. Cloudflare Worker (v10)
1. Workers → your worker → **Edit code** → paste `worker/worker.js` → **Deploy**. (Keep a copy of your old code first.)
2. **Settings → Variables and Secrets** — add:

| Name | Type | Value |
|---|---|---|
| `GROQ_API_KEY` | Secret | your Groq key |
| `GEMINI_API_KEY` | Secret | your Gemini key |
| `MISTRAL_API_KEY`, `NVIDIA_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY` | Secret | any other free keys from step 1 (optional, each adds allowance) |
| `GITHUB_TOKEN` | Secret | the token from step 3 |
| `GITHUB_REPO` | Text | `your-username/your-repo` |
| `GITHUB_REF` | Text | `main` (only if your branch has another name) |

3. *(Optional third fallback)* Settings → Bindings → Add → **Workers AI**, variable name `AI`.
4. *(Recommended — natural Indian voice)* Sign up at **dashboard.sarvam.ai** → API keys → create a key, and add it as a
   **Secret** named `SARVAM_API_KEY`. Answers are then read out in a natural Indian-English voice — and Hindi / Hinglish answers in a natural Hindi voice (Sarvam AI "Bulbul v3";
   visitors can pick Shubh, Aditya, Rahul, Kabir, Priya, Ritu, Neha, Kavya or Shreya in ⚙). Sarvam is the one paid piece: new accounts come with free
   starter credits; check Sarvam's pricing page for the current amount. Without the key, the bot uses the visitor's own
   device voice, choosing an Indian-English one when the device has it.
   Optional text variables: `TTS_DAILY_CHARS` (default `150000` — a daily cap on characters sent for speech, to protect your
   credits), `SARVAM_TTS_MODEL` (default `bulbul:v3`), `SARVAM_SPEAKER` (force one voice for everyone).
4. *(Recommended)* In `worker.js`, set `ALLOWED_ORIGINS = ['https://<user>.github.io']` and redeploy. With a real allow-list, `/ask` and `/prepare` refuse other websites.

### 5. Go live
Commit everything, wait for GitHub Pages to publish, then hard-refresh the site once
(the new service-worker version cleans out the old cache). Open a company, tap **Ask Plutus**.
For a company with no processed report you will see "Plutus is reading the annual report…" for a few minutes;
then the bot says hello and offers starter questions.

## Behaviour worth knowing
* **Honest by design.** The AI may only use the passages it is given, must cite them, and must say
  "the annual report excerpts I searched don't explain this" when they don't. Every number in an answer is
  checked against the passages; unmatched numbers get a visible ⚠ warning.
* **Period check.** If someone asks about FY26 and the newest report held is FY25, the bot says so
  instead of answering from the wrong year (a report shows the previous year too, so FY25 vs FY24 works).
* **Sources.** "Details & sources" shows the exact excerpt, section and page. HTML filings show an approximate page (≈); PDFs show the PDF page number.
* **Voice.** Speech recognition works in Chrome, Edge and Safari (it is off by default in Firefox, and usually sends audio to the browser vendor's service). Typing always works. Tapping the mic while Plutus is talking interrupts it. The speaker icon mutes spoken answers.
* **Listening.** The mic stays open while the visitor talks and sends after a pause — Short (1.5 s, the default since v10), Normal (2.6 s) or Long (4.2 s), chosen in ⚙. Tapping the mic or the orb again sends straight away. Speech is recognised as Indian English (`VOICE_LANG` in `js/config.js`) unless the visitor picks Hindi (below).
* **Hindi & Hinglish (v10).**
  * *Speaking:* the picker next to the mic — **EN · हिंदी · Hinglish** (also in ⚙ → "I'll speak in") — switches speech recognition to Hindi (`hi-IN`), which also understands English words mixed in. The English recognizer used before turned Hindi speech into nonsense English, which is why Hindi questions weren't understood. Until a visitor picks one, the mic follows the language of their typed questions (and starts on Hinglish if their browser language is Hindi).
  * *Answering:* a question typed in Devanagari is answered in Hindi (Devanagari); one typed in Hinglish ("cash flow kyun gira?") in Hinglish (English letters); a spoken one in the language picked for the mic. The report is in English, so Hindi / Hinglish questions always go through the `/refine` step to become an English question + English search words (one small AI call); if that fails, a built-in Hindi→English finance word list (munafa → profit, karz / क़र्ज़ → debt …) is used. The "Understood as" line shows the English reading.
  * *Reading aloud:* Hindi answers use Sarvam's Hindi voice (`hi-IN`); Hinglish answers come with a Devanagari copy written by the AI, so the Hindi voice pronounces them properly. With the device voice, the best Hindi voice on the device is used (pick it in ⚙); devices without one fall back to the English voice.
  * Saved answers are kept per language, numbers in Hindi answers are written with 0–9 digits and pass the same number check, and "the report doesn't cover this" is detected in every language (the AI now states ANSWERED: YES / NO).
  * Needs Worker **v10**. With an older Worker, Hindi questions still work but are answered in English.
* **Understanding the question.** The answer's first line restates the question clearly ("Understood as: …" under the visitor's question), at no extra cost. An optional extra AI step (`VOICE_REFINE: true` in `js/config.js`) also rewrites English questions *before* searching — slightly better for messy speech, but it costs one more AI call per question. Hindi / Hinglish questions always use it.
* **From the dashboard.** The Corporate Governance section's question buttons (board, auditor, related-party deals, pay, pledged shares, legal cases) open this panel and ask the question as soon as the report is ready.
* **Detailed answers (v8).** Up to 9 passages are searched, and the answer comes as a 4–7 sentence spoken summary plus an open breakdown under headings (the numbers, why they changed, what management says, risks, what it means), every point cited.
* **Never running out (v9) — three layers, all free:**
  1. **Saved answers.** A stand-alone question that was asked before (same company, same report) is answered from Cloudflare's edge cache for 30 days — no AI call. The starter questions cost tokens only the first time. Saved answers are labelled "Saved answer".
  2. **A pool of free services.** Every key you add (step 1) is another daily allowance, and most services count limits per model, so the Worker spreads questions over several models per service.
  3. **Skip-ahead.** A service that says "limit reached" is rested for at least 10 minutes (or as long as it asks), so visitors go straight to one that still has allowance instead of waiting.
  (v10: the on-device AI option has been removed. If every cloud service is used up, Plutus says so and asks the visitor to try again later — add more free keys from step 1 to make that rarer.)
  Each visitor is also limited to 8 questions a minute.
* **Voice output stays free:** without `SARVAM_API_KEY` the answers are read by the device's own (Indian-English where available) voice, which has no limits.
* **Nightly refresh** (03:00 IST) re-checks reports older than 7 days and retries failed ones after 3 days. It never touches more than 10 companies per night.
* **Hide it** any time with `VOICE_BOT: false` in `js/config.js`.

## Troubleshooting

| You see | Likely cause |
|---|---|
| "…isn't switched on for this site yet (the Worker needs its GitHub settings)" | `GITHUB_TOKEN` / `GITHUB_REPO` missing in the Worker |
| Stays on "reading the annual report" for 15 min | Open the repo's **Actions** tab: the *Prepare annual report* run shows why (red = failed step). Check the token has *Actions: Read and write* |
| "I couldn't find the company's latest annual report automatically" | Pin a link in `data/report_sources.json`, then tap **Try again** |
| "…almost no selectable text (it may be a scanned document)" | The PDF is an image; there is no OCR in the free job |
| "Heads-up: Cash-flow statement not detected" | The report loaded but its layout confused the parser; answers about cash flow may be thin |
| "…free AI services are busy or out of quota" | Daily/minute caps reached; add the second provider's key or wait for the reset |
| Button missing | `VOICE_BOT` is false, `WORKER_URL` is empty, or you are on the home page (it only shows on stock pages) |
| Hindi questions answered in English | The Worker is older than v10 — paste the new `worker/worker.js` and deploy |
| "Hindi speech recognition isn't available in this browser" | Use Chrome, Edge or Safari for Hindi speech; typing in Hindi / Hinglish works everywhere |
| Hindi answers not read aloud | The device has no Hindi voice and `SARVAM_API_KEY` isn't set; add the key (step 4) or install a Hindi voice on the device |

## Status of this build
Tested here: the report job on a generated 10-K-style HTML filing and a generated PDF (page numbers, a cash-flow table, fiscal-year detection, failure paths, refresh logic); the Worker with simulated AI providers (fallback, number check, rate limits, origin lock, `/prepare`); the panel in a real browser engine (desktop, phone, light, dark) with simulated speech.
**Not tested here:** the live SEC, NSE and BSE endpoints (no internet in the build environment) and real AI model output. The Indian sources are the least certain part — NSE and BSE can change or block automated requests — so run one US and one Indian company first and read the Actions log. The Yahoo-based company-website fallback and `report_sources.json` are your safety nets.

The report text and your visitors' questions pass through GitHub, Cloudflare and the AI provider you enable. This is educational information, not investment advice.
