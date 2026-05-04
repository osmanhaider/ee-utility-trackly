# Estonia Utility Bill Tracker

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)
![Node 18+](https://img.shields.io/badge/node-18%2B-green)

Upload any invoice or bill (image or PDF), get it parsed into structured line items, and explore spending patterns through a 13-section analytics dashboard. Multi-user with Google Sign-In, optional community insights, and an installable iOS web app.

This project is **open source**. Contributions, bug reports, feature ideas, parser improvements, provider additions, and Estonian utility-bill edge cases are very welcome.

## Extraction backends

The system has three first-party backends plus per-user "bring your own key" (BYOK):

- **Local OCR** *(default)* — Tesseract + `pdfplumber`, optimised for Estonian utility bills. Runs entirely locally, no API key required.
- **Free AI via FreeLLMAPI** *(recommended for non-Estonian or unusual invoices)* — local OCR/PDF text extraction followed by routed LLM JSON extraction. Set `PARSER_BACKEND=freellmapi`.
- **Claude API** *(premium alternative)* — highest accuracy, paid. Set `PARSER_BACKEND=claude`.
- **BYOK** *(per-user)* — every signed-in user can save their own keys to OpenAI-compatible providers (Groq, Cerebras, Gemini, OpenRouter, NVIDIA NIM, Mistral, Together AI, Fireworks, OpenAI, Ollama, or any custom OpenAI-compatible gateway like OpenClaw / vLLM / LiteLLM) and use them directly from the Upload tab.

## Features

- **Multi-user Google Sign-In** — each Google account gets its own bill workspace. Optional `ALLOWED_EMAILS` allowlist for invite-only deployments. iOS Safari and the standalone home-screen PWA use a redirect-mode flow that works around iOS's storage-partitioning of the popup-based GIS flow.
- **Installable iOS Home-Screen app** — `manifest.webmanifest` + apple-touch-icon + safe-area handling let users add the app to their home screen and launch it in standalone mode (no Safari chrome).
- **Bring your own AI key (BYOK)** — encrypted-at-rest provider keys, multiple keys per user, **Edit** / **Set as default per provider** / **Test connection** controls. Custom URL field unlocks self-hosted endpoints (Ollama, OpenClaw gateway, vLLM, etc.).
- **Community insights** — browse other signed-in users' public bill collections and per-user dashboards. Privacy is opt-out: any bill can be marked private with a single toggle.
- **Per-upload model picker** — the Upload tab fetches FreeLLMAPI's enabled model list and routes through configured provider keys; the user can pick a model per upload, BYOK or otherwise.
- **Automatic quality detection** — when local OCR can't read an invoice, the UI prompts to switch to an AI backend.
- **Open-source OCR pipeline** — Tesseract for images, `pdfplumber` for native-text PDFs, `pdf2image` + OCR fallback for scanned PDFs.
- **Hardcoded Estonian→English dictionary** (~180 terms) — no API call needed for translation when using the local backend. Months, weekdays, units, korteriühistu line items, inline meter-reading parsing.
- **13-section analytics dashboard** — trends, calendar-aware MoM/YoY, weighted seasonal patterns, **Bennet** price-vs-consumption decomposition (price + volume sum exactly to total Δ), per-utility unit-price tracking, annual rollup, and more.
- **One-click PDF export** — client-side via html2canvas + jsPDF; paginates at chart boundaries so charts are never split mid-body.
- **Light / dark / system theme** with warm-finance styling, mobile-first layouts, and saved preference.
- **Per-device-timezone timestamps** — bill upload times render in the viewer's local timezone via `Intl.DateTimeFormat` (no hardcoded zone).
- **Supabase / Postgres persistence** — production data persists across Render restarts when `DATABASE_URL` is set; local dev falls back to SQLite.
- **No-store API responses** — every `/api/*` response carries `Cache-Control: no-store, must-revalidate` so iOS Safari and the PWA shell can't serve stale numbers after a delete or edit.

## Architecture

```
                   ┌──────────────────────┐         ┌────────────────────┐
                   │  React + Vite SPA    │ ──────► │  Supabase Postgres │
                   │  (Recharts, TSX)     │         │  users / bills /   │
 iOS Home-screen   │  Vercel-hosted       │ ◄────── │  user_api_keys     │
 PWA + manifest ──►│                      │         └─────────┬──────────┘
                   └──────────┬───────────┘                   │
                              │ HTTPS                         │
                              ▼                               │
              ┌─────────────────────────────────┐             │
              │  FastAPI backend (Render)       │ ────────────┘
              │  /api/auth/{google,me,...}      │
              │  /api/bills/{upload,update,...} │
              │  /api/byok-keys/{,probe,...}    │
              │  /api/analytics/summary         │
              │  /api/community/{users,bills,…} │
              └─────────┬───────────────────────┘
                        │
   ┌────────────────────┼────────────────────┬─────────────────────┐
   ▼                    ▼                    ▼                     ▼
┌──────────┐     ┌──────────────┐    ┌──────────────┐     ┌─────────────────┐
│ Local OCR│     │ FreeLLMAPI   │    │ Claude API   │     │ BYOK direct     │
│ Tesseract│     │ proxy router │    │ Anthropic    │     │ (Groq, Gemini,  │
│ pdfplumber│    │ (free LLMs)  │    │ (paid)       │     │  Ollama, custom)│
└──────────┘     └──────────────┘    └──────────────┘     └─────────────────┘
```

## Run with Docker (easiest)

```bash
# Tesseract backend (default):
docker compose up --build

# Free AI via FreeLLMAPI (recommended for non-Estonian invoices):
PARSER_BACKEND=freellmapi docker compose up --build

# Claude backend (paid):
ANTHROPIC_API_KEY=sk-ant-... PARSER_BACKEND=claude docker compose up --build
```

> Add provider keys in the FreeLLMAPI dashboard at http://localhost:3001, then use the utility app at http://localhost:5173.

Open **http://localhost:5173**. Local Docker uses SQLite in a named volume (`backend-data`). Production should set `DATABASE_URL` to Supabase/Postgres for persistence.

## Deploy (free tier)

A free-tier cloud setup: **Vercel** for the frontend, **Render** for the backend, **Supabase Postgres** for persistent data, and **Google Sign-In** for auth.

> Multi-user: every Google account that signs in gets its own private bill workspace. By default uploaded bills are public — visible in the **Community** tab to every other signed-in user. Mark a bill private with the lock toggle on the Bills tab to keep it to yourself. Set `ALLOWED_EMAILS` on the backend to restrict sign-in to a list of accounts you trust.

### 0. Create a Google OAuth Client ID

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. **Create Credentials** → **OAuth client ID** → Application type **Web application**.
3. **Authorized JavaScript origins** — add both:
   - `http://localhost:5173`
   - `https://<your-vercel-host>.vercel.app`
4. **Authorized redirect URIs** — add the backend redirect endpoint (required for the iOS sign-in flow):
   - `https://<your-render-host>.onrender.com/api/auth/google-redirect`
5. Save. Copy the **Client ID** (looks like `123456-abc.apps.googleusercontent.com`). The same value goes into `GOOGLE_CLIENT_ID` (backend) and `VITE_GOOGLE_CLIENT_ID` (frontend).

### 1. Create a Supabase Postgres database

1. Open [Supabase](https://supabase.com) → **New project**.
2. Pick a region close to your Render backend.
3. Wait for provisioning to finish.
4. Project Settings → **Database** → **Connection string**.
5. Copy the **Transaction pooler** connection string if available (best for hosted web apps), otherwise the direct connection string. It looks like:
   ```
   postgresql://postgres.<project-ref>:<password>@aws-...pooler.supabase.com:6543/postgres
   ```

The backend creates and migrates its tables on startup (`users`, `bills`, `user_api_keys`) when `DATABASE_URL` is set — including idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migrations for newer columns (`is_private`, `is_default`, `base_url_override`).

### 2. Backend on Render

1. Log in to [Render](https://render.com) → **New** → **Web Service** → pick this repo.
2. Settings:
   - **Root Directory**: `backend`
   - **Environment**: `Docker` (uses `backend/Dockerfile`)
   - **Instance Type**: `Free`
3. Add environment variables:
   - `PARSER_BACKEND` = `freellmapi`
   - `FREELLMAPI_BASE_URL` = your FreeLLMAPI server URL
   - `FREELLMAPI_API_KEY` = your FreeLLMAPI unified key *(if auth is enforced)*
   - `FREELLMAPI_MODEL` = `auto` *(optional; overridable per upload)*
   - `DATABASE_URL` = the Supabase connection string from step 1
   - `GOOGLE_CLIENT_ID` = the Web Client ID from step 0
   - `FRONTEND_URL` = `https://<your-vercel-host>.vercel.app` *(required for the iOS sign-in redirect to come back to the SPA)*
   - `ALLOWED_EMAILS` = optional comma-separated allowlist, e.g. `you@gmail.com,friend@gmail.com`
   - `AUTH_SECRET` = a long random hex string — generate locally with:
     ```
     python -c "import secrets; print(secrets.token_hex(32))"
     ```
   - `BYOK_ENCRYPTION_KEY` = base64- or hex-encoded 32-byte key for at-rest encryption of user API keys. Without it, BYOK is disabled and Settings shows a warning. Generate locally with:
     ```
     python -c "import secrets, base64; print(base64.b64encode(secrets.token_bytes(32)).decode())"
     ```
4. Click **Create Web Service**. First build takes ~5 min. Copy the generated URL (e.g. `https://ee-utility-trackly.onrender.com`).

The free tier spins down after 15 minutes of inactivity. The first request after a cold start takes ~30 s. Data survives restarts/redeploys because rows live in Supabase Postgres when `DATABASE_URL` is set. Uploaded original files in `UPLOADS_DIR` are still ephemeral; the app mainly relies on parsed DB data.

### 3. Frontend on Vercel

1. Log in to [Vercel](https://vercel.com) → **Add New** → **Project** → import this repo.
2. Settings:
   - **Root Directory**: `frontend`
   - **Framework**: `Vite` *(auto-detected)*
3. Environment variables:
   - `VITE_API_URL` = the Render URL from step 1 (no trailing slash)
   - `VITE_GOOGLE_CLIENT_ID` = the Web Client ID from step 0
4. Click **Deploy**. Your app is live at `https://<project>.vercel.app`.

The bundled `frontend/vercel.json` provides SPA routing so deep links / refreshes don't 404. The `apple-touch-icon.png` and `manifest.webmanifest` ship from `frontend/public/`, making the deployed site installable as an iOS home-screen app.

### 4. CORS

The backend accepts requests from `*.vercel.app` by default. For a custom domain, set `CORS_ALLOW_ORIGINS` on the Render service:
```
CORS_ALLOW_ORIGINS=https://bills.example.com,https://www.bills.example.com
```

### 5. Sign in

Visiting the Vercel URL shows a Google Sign-In button. The first sign-in creates a row in the `users` table keyed on the Google `sub` claim. The app token is stored in `localStorage` and lasts 7 days (override with `TOKEN_TTL_SEC`). Rotate `AUTH_SECRET` to invalidate every existing session immediately.

To restrict who can sign in, set `ALLOWED_EMAILS` on Render. Anyone outside the list gets a clear `not on the allowlist` error and never reaches the app.

**Two sign-in flows:**
- **Desktop / Android** — popup-based GIS flow (lower friction, in-page).
- **iOS Safari and the standalone PWA** — full-page redirect flow that POSTs the credential to `/api/auth/google-redirect` on the backend, which mints the app token and redirects to `/auth/callback#token=…` on the frontend. Required because iOS partitions standalone-PWA storage from Safari, breaking the popup flow's postMessage credential delivery.

## Install on iPhone (PWA)

1. Open `https://<your-vercel-host>.vercel.app` in **Safari** on iOS (Chrome's iOS "Add to Home Screen" produces a regular bookmark, not a standalone app — must be Safari).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch the new icon — it opens in standalone mode (no Safari URL bar / nav), respects the notch via safe-area padding, and remembers your sign-in across launches.

## Run locally

### Prerequisites

You need **Python 3.10+** and **Node.js 18+**. Verify with:
```bash
python3 --version
node --version
```

### 1. Clone the repo

```bash
git clone https://github.com/usmanhaider/ee-utility-trackly.git
cd ee-utility-trackly
```

### 2. Install system dependencies

Pick the block for your OS — this installs Tesseract (OCR engine), the **Estonian** language pack, and poppler (PDF rasteriser):

<details>
<summary><strong>macOS (Homebrew)</strong></summary>

```bash
brew install tesseract tesseract-lang poppler
```
`tesseract-lang` bundles the Estonian training data. Verify with `tesseract --list-langs` — you should see `est` in the output.
</details>

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-est tesseract-ocr-eng \
                        poppler-utils
```
</details>

<details>
<summary><strong>Fedora / RHEL</strong></summary>

```bash
sudo dnf install -y tesseract tesseract-langpack-est poppler-utils
```
</details>

Sanity check:
```bash
tesseract --list-langs        # must include 'est'
which pdftoppm                # must print a path
```

### 3. Start the backend

```bash
cd backend
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

# Optional — seed 3 demo bills so the dashboard is populated immediately
./venv/bin/python seed_demo.py

# Run the API server (leave this terminal open)
./venv/bin/uvicorn main:app --port 8000
```

Backend is now at **http://localhost:8000**.

Backend env vars (see `backend/.env.example` for the full list):
- `PARSER_BACKEND=tesseract` *(default)* — open-source, local, no API key. Best on Estonian utility bills and korteriühistu invoices.
- `PARSER_BACKEND=freellmapi` — local OCR/PDF text extraction plus FreeLLMAPI structured JSON extraction. Requires `FREELLMAPI_BASE_URL` to point at a running FreeLLMAPI server. Optionally set `FREELLMAPI_API_KEY` and `FREELLMAPI_MODEL` (`auto` by default); users can still override the model per upload in the UI.
- `PARSER_BACKEND=claude` — Anthropic Claude API, requires `ANTHROPIC_API_KEY` (paid). Highest accuracy; use only if FreeLLMAPI isn't getting the job done.
- `AUTH_SECRET` — required. 64-char hex, generate with `python -c "import secrets; print(secrets.token_hex(32))"`. Used to sign app session tokens.
- `GOOGLE_CLIENT_ID` — required. OAuth Web Client ID from Google Cloud Console (same value as the frontend's `VITE_GOOGLE_CLIENT_ID`).
- `FRONTEND_URL` — required for production iOS sign-in (the redirect flow lands the user back here after Google auth). Local dev defaults to `/` if unset.
- `ALLOWED_EMAILS` — optional comma-separated allowlist (e.g. `you@gmail.com,friend@gmail.com`). When set, only those Google accounts can sign in.
- `BYOK_ENCRYPTION_KEY` — optional. Base64- or hex-encoded 32 bytes. Required if you want the BYOK feature enabled (Settings tab); without it, the BYOK UI shows a warning and saving keys is blocked.
- `DATABASE_URL` — optional locally, required in production for persistent Supabase/Postgres storage. If unset, the backend uses local SQLite at `DB_PATH`.
- `MAX_UPLOAD_BYTES` — hard cap on upload size in bytes per file (default 25 MB). Multi-file uploads are supported; each file is bounded by this limit.
- `ANALYTICS_CACHE_TTL_SEC` — in-memory analytics cache TTL (default 60 s). The cache is also wiped on every bill mutation.
- `BYOK_PROBE_MAX_PER_MIN` — per-user rate limit on BYOK probe endpoints (default 10 / 60 s). The probe issues a server-side outbound request to a user-controlled URL, so this caps the DoS / SSRF-amplification surface.
- `BYOK_ALLOW_PRIVATE_BASE_URL` — set to `1` / `true` to allow probing private / loopback / link-local addresses (e.g. self-hosted Ollama on `localhost:11434`). Default: blocked when `DATABASE_URL` is set (production) and allowed when not (local dev). Without this guard a signed-in user could portscan the platform's internal network or hit cloud metadata.
- `DB_PATH`, `UPLOADS_DIR`, `LOG_LEVEL` — override storage paths and log verbosity.

Frontend env vars (see `frontend/.env.example`):
- `VITE_API_URL` — base URL of the backend. Defaults to `http://localhost:8000`.
- `VITE_GOOGLE_CLIENT_ID` — Google OAuth Web Client ID. Same value as the backend's `GOOGLE_CLIENT_ID`.

> Auth is always required. For local dev, create a Google OAuth client with `http://localhost:5173` as an authorized origin (see "Create a Google OAuth Client ID" in the **Deploy** section), then put the same Client ID in both `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`. Setting `ALLOWED_EMAILS=you@gmail.com` restricts sign-in to your own account.

### 4. Start the frontend (in a second terminal)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser. After Google sign-in you'll see six tabs: **Upload**, **Bills**, **Analytics**, **Community**, **Settings**, **Help**.

### 5. Try it

1. Go to **Upload** → pick an extraction method (Local OCR, FreeLLMAPI, or your own saved API key) and drag in your invoice. The local parser handles Estonian utility bills out of the box; for any other format, switch to an AI path.
2. Open the **Bills** tab. Each row has a globe (public) / lock (private) toggle — bills default to public so they show up in the Community tab. Upload timestamps render in your device's local timezone; tap a row to expand it for full metadata + line items.
3. Open **Analytics** to explore 13 dashboard sections for *your* bills — click **Download PDF** to export.
4. Open **Community** to browse other signed-in users' public bills and per-user dashboards.
5. Open **Settings** to add OpenAI-compatible API keys. Each key supports a custom **Default model**, **Set as default** for its provider, **Test connection** (decrypted server-side), in-place **Edit**, and an optional **Base URL** for self-hosted endpoints (Ollama, OpenClaw, vLLM…).

## Bring your own key (BYOK)

The Settings tab lets each signed-in user save their own provider API keys. Backed by `byok.py`'s provider catalogue and AES-256-GCM at-rest encryption (`BYOK_ENCRYPTION_KEY`), exposed via:

- `GET /api/byok-providers` — public catalogue with `requires_base_url` and `allows_empty_key` flags.
- `GET /api/byok-keys` — masked listing of the caller's saved keys, defaults first.
- `POST /api/byok-keys` — create with optional `base_url`, optional `is_default`.
- `PATCH /api/byok-keys/{id}` — edit `label` / `default_model` / `base_url`. The encrypted key value itself isn't editable (delete + re-add to rotate).
- `POST /api/byok-keys/{id}/default` — atomically promote one key to default-for-its-provider.
- `POST /api/byok-keys/probe` — pre-save connectivity probe with a plaintext key.
- `POST /api/byok-keys/{id}/probe` — saved-key connectivity probe; the key is decrypted server-side so the frontend never holds plaintext.
- `DELETE /api/byok-keys/{id}` — delete.

Built-in provider presets:

| Provider | Model | Notes |
|---|---|---|
| OpenAI | `gpt-4o-mini` | |
| Google (Gemini) | `gemini-2.5-flash` | Free tier available |
| Groq | `llama-3.3-70b-versatile` | Free tier; **fastest** option |
| Cerebras | `llama-3.3-70b` | Free tier |
| Mistral | `mistral-small-latest` | |
| OpenRouter | `google/gemini-2.0-flash-exp:free` | Many models behind one key |
| Together AI | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | |
| Fireworks AI | `accounts/fireworks/models/llama-v3p3-70b-instruct` | |
| NVIDIA NIM | `z-ai/glm4.7` | |
| **Ollama (self-hosted)** | `llama3.1:8b` | Requires base URL; key may be blank |
| **Custom (OpenAI-compatible)** | *(any)* | Requires base URL; works with OpenClaw / vLLM / LiteLLM / any `/v1/chat/completions` endpoint |

## Troubleshooting

**`tesseract: command not found`**
Tesseract isn't installed. Re-run step 2 for your OS.

**`est.traineddata not found` / only `eng` listed**
The Estonian language pack is missing. On macOS: `brew install tesseract-lang`. On Ubuntu: `sudo apt-get install tesseract-ocr-est`.

**`pip install` fails with `401 Error, Credentials not correct`**
Your pip is pointing at a private corporate index (e.g. AWS CodeArtifact). Bypass it for this one command:
```bash
./venv/bin/pip install --index-url https://pypi.org/simple/ -r requirements.txt
```

**`Failed to fetch` / CORS error in browser**
The backend must be on port 8000 — the frontend is hardcoded to that URL in `frontend/src/api.ts`. If you change the port, update `BASE` there too.

**Port already in use (`[Errno 48] Address already in use`)**
Something else is on port 8000. Either kill it (`lsof -ti:8000 | xargs kill`) or change the port: `./venv/bin/uvicorn main:app --port 8001` + update `BASE` in `frontend/src/api.ts`.

**Dashboard shows no data**
Either no bills uploaded yet, or the backend isn't running. Check the **Upload** tab works, or run `python seed_demo.py` to load three sample bills.

**Amber "OCR couldn't read this invoice" warning**
The local Tesseract parser couldn't extract enough data — typically means the invoice is non-Estonian, has an unusual layout, or is a low-quality scan. Switch the **Extraction method** toggle on the Upload tab to **🤖 AI (FreeLLMAPI)** and re-upload. FreeLLMAPI still relies on local OCR text first, so very poor scans may need a better source file.

**Amber "File saved, but data couldn't be extracted" after AI upload**
The selected FreeLLMAPI model failed, no provider keys are healthy, or the model returned a non-JSON response. The error text in the banner tells you which. Open the FreeLLMAPI dashboard, check provider key health/fallback order, or pick a different model from the dropdown and try again.

**`FreeLLMAPI request failed`**
The utility backend can reach FreeLLMAPI but the proxy rejected or could not route the request. Confirm FreeLLMAPI is running, provider keys are configured, and `FREELLMAPI_API_KEY` matches your unified key if you enforce auth.

**iOS sign-in shows "Something went wrong" or hangs after entering password**
The redirect URI isn't whitelisted in Google Cloud Console. Add `https://<your-render-host>.onrender.com/api/auth/google-redirect` under **Authorized redirect URIs** for your OAuth client, and confirm `FRONTEND_URL` is set on the Render backend.

**Saved BYOK key always reports HTTP 401 when I tap Test connection**
Make sure both the backend (Render) and frontend (Vercel) have redeployed after the BYOK feature additions; the Test button calls a per-key endpoint that decrypts the saved key server-side. If you previously tested before that endpoint shipped, hard-refresh the page or remove + re-add the home-screen icon.

**Analytics dashboard doesn't reflect a delete / edit**
Backend cache is cleared on every bill mutation and `Cache-Control: no-store` is sent on every `/api/*` response. If numbers still look stale: hard-refresh the page (or remove + re-add the home-screen icon on iOS) so a stale Vercel bundle isn't being served.

## Parser accuracy

Tested on real Tallinn korteriühistu invoices:

| Bill | Line items | Extraction | Total match |
|---|---|---|---|
| December 2025 | 11 | 11 / 11 | ✓ €208.49 exact |
| January 2026  | 14 | 14 / 14 | ✓ €294.46 exact |
| February 2026 | 15 | 15 / 15 | ✓ €308.77 exact |
| March 2026    | 15 | 15 / 15 | ✓ €217.29 exact |

Native-text PDFs give **high confidence** (pdfplumber, 100% character accuracy).
Scanned PDFs and images give **medium confidence** (Tesseract OCR, occasional accent drops).
For non-Estonian or non-standard invoices, switch to the **AI (FreeLLMAPI)** backend, or use a BYOK key for direct provider access. All AI paths still use the local text extraction first.

## Dashboard sections

| #  | Section | What it shows |
|----|---------|---------------|
| —  | **KPI cards** | Total spend · latest month with MoM% · YoY change · 3-month rolling avg · highest bill · avg per active month · total kWh |
| 1  | Monthly Trend | Line + area chart with calendar-aware 3-month rolling average overlay |
| 2  | MoM & YoY %  | Bar charts + full change table with € and % deltas per month |
| 3  | Type Breakdown | Stacked bar + donut showing share of each utility category (line-items reconciled to bill total) |
| 4  | Seasonal Patterns | Average bill by calendar month + 4-season radar profile (weighted, Σtotal/Σcount) |
| 5  | Annual Comparison | Year-over-year spend by category |
| 6  | Top Providers | Horizontal bar ranking suppliers by total spend |
| 7  | Per-Utility Trends | One line per utility type — spot individual spikes |
| 8  | Summary Statistics | Bills, total, avg/bill, min/max/consumption per utility type |
| 9  | Unit Price Trends | €/unit over time — isolates tariff changes from usage |
| 10 | Line-Item Cost by Month | Stacked bars of every individual charge (last 12 months only, top 8 + "Other") |
| 11 | Price vs Consumption Decomposition | Bennet-symmetric decomposition (price + volume sums exactly to total Δ) for the latest two months |
| 12 | Month-vs-Month Comparison | Side-by-side table of two recent months with deltas |
| 13 | Total Spend by Year | Bar chart + table — annual rollup at the **bill** level (each bill counted once even when split across categories) |

## Estonian translation coverage

Glossary (`backend/translation.py`) includes:

- **180+ utility terms** — Elektrienergia, Võrgutasu, Aktsiis, Taastuvenergia tasu, Käibemaks, Kuupäev, Tähtaeg, Viitenumber, Neto pind, Tasumisele kuulub, …
- **Housing association (korteriühistu) vocabulary** — Haldusteenus, Raamatupidamisteenus, Tehnosüsteemide hooldusteenus, Sise-ja väliskoristus, Porivaiba renditeenus, Prügivedu, Üldelekter, Üldvesi, Küte, Vee soojendamine, Remondifond
- **Months + abbreviations + OCR variants** — Jaanuar/Jaan, Veebruar/Veeb, Märts/Marts, Aprill/Apr, …
- **Weekdays** — full names (Esmaspäev → Monday) and single-letter forms (E, T, K, N, R, L, P)
- **Known providers** — Eesti Energia, Elektrilevi, Elering, Eesti Gaas, Tallinna Vesi, Gasum, Telia, Elisa, Tele2, Adven, Utilitas, Ragn-Sells, …

## Directory layout

```
backend/
├── main.py                       FastAPI app, auth, upload, analytics, community,
│                                 BYOK endpoints, no-store + auth middleware
├── auth.py                       HMAC-signed app tokens carrying Google identity
├── google_auth.py                Google ID-token verification + email allowlist
├── byok.py                       Provider catalogue + AES-256-GCM key encryption helpers
├── db.py                         SQLite/Postgres adapter (Supabase via DATABASE_URL)
├── parser.py                     Tesseract OCR + pdfplumber + regex + column detector
├── parser_openai_compat.py      Shared OpenAI-compatible HTTP client with retries,
│                                 truncation detection, HTML-error sanitisation
├── parser_freellmapi.py          FreeLLMAPI parser branch
├── parser_byok.py                User-saved key parser branch (uses base_url_override)
├── translation.py                ~180-term Estonian→English glossary + period parser
├── seed_demo.py                  Seed 3 sample bills without any API call
├── render_preview.py             ASCII preview of the dashboard
├── test_auth.py                  App-token round-trip / tampering / expiry
├── test_google_auth.py           Mocked Google ID-token verification
├── test_byok.py                  BYOK encrypt/decrypt + endpoint coverage
│                                 (create, edit, default, probe, custom URL, isolation)
├── test_cross_user_isolation.py Bills + BYOK cross-user authorisation
├── test_db_adapter.py            SQLite / Postgres adapter shape
├── test_claude_parser.py         Claude parser branch unit tests
├── test_parser.py                End-to-end test on synthetic PNG (manual smoke)
├── test_december.py              Validation on December 2025 bill format (manual smoke)
└── test_pdf.py                   Validation on native-text PDFs (manual smoke)

frontend/
├── public/
│   ├── apple-touch-icon.png      180×180 home-screen icon (iOS PWA)
│   ├── manifest.webmanifest      Installable PWA manifest
│   └── favicon.svg
├── index.html                    Apple PWA meta tags, theme-color (light/dark), viewport-fit
└── src/
    ├── App.tsx                   Tab routing, sticky safe-top header, profile portal,
    │                             auth callback bootstrap
    ├── main.tsx                  consumeAuthCallback() before <App/> mounts
    ├── api.ts                    Axios client + cache-busting on analytics fetches
    ├── auth.ts                   Token storage + iOS redirect-callback handler
    ├── google.ts                 Lazy GIS loader + iOS detection
    ├── theme.ts                  light/dark/system theme hook
    ├── styles/theme.css          CSS vars + .safe-top utility for iOS notch
    └── components/
        ├── UploadTab.tsx         Drag-and-drop upload with parser-mode picker
        ├── BillsTab.tsx          List/edit/delete bills, mobile action drawer,
        │                         Intl-formatted upload timestamps
        ├── AnalyticsTab.tsx      13-section dashboard + Download PDF + "Refreshing" pill
        ├── CommunityTab.tsx      Per-user community dashboards
        ├── SettingsTab.tsx       BYOK CRUD + Edit modal + Set-default + Test
        ├── LoginScreen.tsx       Google Sign-In with iOS redirect-mode fallback
        ├── ThemeToggle.tsx       Sun/moon/monitor cycle button
        └── ErrorBoundary.tsx     Themed crash boundary
```

## PDF export

The "Download PDF" button in the Analytics header captures the whole dashboard via **html2canvas** and serialises it through **jsPDF** into a multi-page A4 document. Fully client-side — works offline once the dashboard is loaded.

Filename: `utility-bills-dashboard-YYYY-MM-DD.pdf`

## Contributing

This utility app is open source and contributions are welcome. Good first contributions include:

- adding or improving Estonian utility-bill parsing examples,
- expanding the translation glossary in `backend/translation.py`,
- adding AI provider presets for BYOK extraction in `backend/byok.py`,
- improving mobile UX, accessibility, and dashboard readability,
- writing focused tests for parser or analytics edge cases.

Fork the repo, create a branch, and send a pull request. The codebase is intentionally small:

- Backend tests: `cd backend && AUTH_SECRET=$(printf 'x%.0s' {1..64}) ./venv/bin/python -m pytest -q`
- Frontend type-check + lint + build: `cd frontend && npx tsc --noEmit && npx eslint src --max-warnings=0 && npx vite build`

## License

[MIT](LICENSE) © 2026 Usman Haider.

Third-party components keep their own licenses: Tesseract is Apache-2.0; pdfplumber, pdf2image,
FastAPI, Recharts, html2canvas and jsPDF are MIT.
