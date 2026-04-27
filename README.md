# Estonia Utility Bill Tracker

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)
![Node 18+](https://img.shields.io/badge/node-18%2B-green)

Upload any invoice or bill (image or PDF), get it parsed into structured line items, and explore spending patterns through a 12-section analytics dashboard.

Three extraction backends are available:
- **Local OCR** *(default)* — Tesseract + `pdfplumber`, optimized for Estonian utility bills. Runs entirely locally, no API key required.
- **Free AI via FreeLLMAPI** *(recommended for non-Estonian or unusual invoices)* — local OCR/PDF text extraction followed by routed LLM JSON extraction. Set `PARSER_BACKEND=freellmapi`.
- **Claude API** *(premium alternative)* — highest accuracy, paid. Set `PARSER_BACKEND=claude`.

## Features

- **Three extraction backends** — local OCR for Estonian utility bills, free AI (FreeLLMAPI) for anything else (rent, subscriptions, services, non-Estonian invoices, scanned docs with unusual layouts), Claude API as a premium option
- **Per-upload model picker** — the UI fetches FreeLLMAPI's enabled model list, the user picks one at upload time, and FreeLLMAPI routes across configured provider keys
- **Automatic quality detection** — if the local OCR can't read the invoice, the UI shows a warning banner directing the user to switch to an AI model
- **Open-source OCR pipeline**: Tesseract for images, `pdfplumber` for native-text PDFs, `pdf2image` + OCR fallback for scanned PDFs
- **Google Sign-In + multi-user data** — each Google account gets its own bill workspace, with optional `ALLOWED_EMAILS` for invite-only deployments
- **Community insights** — users can browse public bills and analytics across the community, while sensitive bills can be hidden with the lock toggle
- **Bring your own AI key** — users can save encrypted provider keys (OpenAI-compatible providers such as Google, Groq, Cerebras, NVIDIA NIM, OpenRouter, etc.) and use them directly for extraction
- **Supabase/Postgres persistence** — production data persists across Render restarts when `DATABASE_URL` is set
- **Hardcoded Estonian→English dictionary** (~180 terms) — no API call needed for translation when using the local backend
  - Utility services: electricity, gas, water, heating, telecom, waste
  - Korteriühistu line items: Haldusteenus, Küte, Remondifond, Tehnosüsteemide hooldusteenus…
  - Months (Jaanuar → January), weekdays, units, invoice field labels
  - Inline meter-reading format: `Alg: 9644 Löpp: 9726` → `[Start: 9644, End: 9726]`
- **12-section analytics dashboard** with trends, MoM/YoY %, unit-price tracking, price-vs-consumption decomposition
- **One-click PDF export** of the whole dashboard (client-side, no server round-trip) — paginates at chart boundaries so charts are never split mid-body
- **Light/dark theme toggle** — warm finance styling with a mobile-friendly layout and saved user preference

## Architecture

```
┌────────────────────┐      ┌─────────────────────┐      ┌────────────────────┐
│  React + Vite UI   │ ───► │  FastAPI backend    │ ───► │ Supabase Postgres  │
│  (Recharts, TSX)   │ ◄─── │  /api/bills/upload  │ ◄─── │ users/bills/keys   │
└────────────────────┘      │  /api/analytics/... │      └────────────────────┘
                            └─────────┬───────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
       ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
       │ Local OCR    │        │ FreeLLMAPI   │        │ BYOK direct  │
       │ Tesseract    │        │ fallback     │        │ provider key │
       └──────────────┘        └──────────────┘        └──────────────┘
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
3. **Authorized JavaScript origins**: add both
   - `http://localhost:5173`
   - `https://<your-vercel-host>.vercel.app`
4. Save. Copy the **Client ID** (looks like `123456-abc.apps.googleusercontent.com`). The same value goes into `GOOGLE_CLIENT_ID` (backend) and `VITE_GOOGLE_CLIENT_ID` (frontend).

### 1. Create a Supabase Postgres database

1. Open [Supabase](https://supabase.com) → **New project**.
2. Pick a region close to your Render backend.
3. Wait for provisioning to finish.
4. Project Settings → **Database** → **Connection string**.
5. Copy the **Transaction pooler** connection string if available (best for hosted web apps), otherwise the direct connection string. It looks like:
   ```
   postgresql://postgres.<project-ref>:<password>@aws-...pooler.supabase.com:6543/postgres
   ```

The backend creates/migrates its tables on startup (`users`, `bills`, `user_api_keys`) when `DATABASE_URL` is set.

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
   - `ALLOWED_EMAILS` = optional comma-separated allowlist, e.g. `you@gmail.com,friend@gmail.com`
   - `AUTH_SECRET` = a long random hex string — generate locally with:
     ```
     python -c "import secrets; print(secrets.token_hex(32))"
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

The bundled `frontend/vercel.json` provides SPA routing so deep links / refreshes don't 404.

### 4. CORS

The backend accepts requests from `*.vercel.app` by default. For a custom domain, set `CORS_ALLOW_ORIGINS` on the Render service:
```
CORS_ALLOW_ORIGINS=https://bills.example.com,https://www.bills.example.com
```

### 5. Sign in

Visiting the Vercel URL shows a Google Sign-In button. The first sign-in creates a row in the `users` table keyed on the Google `sub` claim. The app token is stored in `localStorage` and lasts 7 days (override with `TOKEN_TTL_SEC`). Rotate `AUTH_SECRET` to invalidate every existing session immediately.

To restrict who can sign in, set `ALLOWED_EMAILS` on Render. Anyone outside the list gets a clear `not on the allowlist` error and never reaches the app.

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
- `ALLOWED_EMAILS` — optional comma-separated allowlist (e.g. `you@gmail.com,friend@gmail.com`). When set, only those Google accounts can sign in.
- `DATABASE_URL` — optional locally, required in production for persistent Supabase/Postgres storage. If unset, the backend uses local SQLite at `DB_PATH`.
- `MAX_UPLOAD_BYTES` — hard cap on upload size in bytes per file (default 25 MB). Multi-file uploads are supported; each file is bounded by this limit.
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
2. Open the **Bills** tab. Each row has a globe (public) / lock (private) toggle — bills default to public so they show up in the Community tab.
3. Open **Analytics** to explore 12 dashboard sections for *your* bills — click **Download PDF** to export.
4. Open **Community** to browse every signed-in user's public bills and see aggregated insights across the whole community, or filter to a specific user.
5. Open **Settings** to add your own OpenAI-compatible API keys for direct extraction.

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
For non-Estonian or non-standard invoices, switch to the **AI (FreeLLMAPI)** backend. It uses the same local text extraction first, then asks your routed free LLM providers to structure the data.

## Dashboard sections

| # | Section | What it shows |
|---|---------|---------------|
| — | **KPI cards** | Total spend · latest month with MoM% · YoY change · rolling avg · highest bill |
| 1 | Monthly Trend | Line + area chart with 3-month rolling average overlay |
| 2 | MoM & YoY % | Bar charts + full change table with € and % deltas per month |
| 3 | Type Breakdown | Stacked bar + donut showing share of each utility category |
| 4 | Seasonal Patterns | Average bill by calendar month + 4-season radar profile |
| 5 | Annual Comparison | Year-over-year spend by category |
| 6 | Top Providers | Horizontal bar ranking suppliers by total spend |
| 7 | Per-Utility Trends | One line per utility type — spot individual spikes |
| 8 | Summary Statistics | Min/max/avg/consumption per utility type |
| 9 | Unit Price Trends | €/kWh, €/m², €/m³ over time — isolates tariff changes from usage |
| 10 | Line-Item Cost by Month | Stacked bars of every individual charge |
| 11 | Price vs Consumption Decomposition | price_effect vs vol_effect per line item per month |
| 12 | Month-vs-Month Comparison | Side-by-side table of two recent months with deltas |

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
├── main.py              FastAPI app, auth, upload, analytics, community, BYOK endpoints
├── db.py                SQLite/Postgres adapter (Supabase via DATABASE_URL)
├── parser.py            Tesseract OCR + pdfplumber + regex + column detector
├── parser_freellmapi.py FreeLLMAPI client for text-to-JSON extraction
├── parser_byok.py       User-saved key extraction path
├── byok.py              Provider catalogue + AES-GCM key encryption helpers
├── auth.py              HMAC-signed app tokens carrying Google identity
├── translation.py       180-term Estonian→English glossary + period parser
├── seed_demo.py         Seed 3 sample bills without any API call
├── render_preview.py    ASCII preview of the dashboard
├── test_auth.py         Unit tests for token roundtrip, tampering, expiry
├── test_claude_parser.py  Unit tests for the Claude parser branch
├── test_parser.py       End-to-end test on synthetic PNG
├── test_december.py     Validation on the December 2025 bill format
└── test_pdf.py          Validation on native-text PDFs
frontend/
└── src/
    ├── App.tsx
    ├── api.ts
    └── components/
        ├── UploadTab.tsx       Drag-and-drop upload + extraction result
        ├── BillsTab.tsx        List/edit/delete bills, per-bill detail view
        ├── AnalyticsTab.tsx    12-section dashboard + Download PDF button
        ├── CommunityTab.tsx    Community users, public bills and global insights
        ├── SettingsTab.tsx     User-saved BYOK provider keys
        └── HelpTab.tsx         Product help and glossary
```

## PDF export

The "Download PDF" button in the Analytics header captures the whole dashboard via **html2canvas** and serialises it through **jsPDF** into a multi-page A4 document. Fully client-side — works offline once the dashboard is loaded.

Filename: `utility-bills-dashboard-YYYY-MM-DD.pdf`

## Contributing

Bug reports, PRs and Estonian term additions are welcome. Fork, branch, send a pull request —
the codebase is small, tests live in `backend/test_*.py`, and the frontend type-checks with
`tsc --noEmit` and builds with `vite build`.

## License

[MIT](LICENSE) © 2026 Usman Haider.

Third-party components keep their own licenses: Tesseract is Apache-2.0; pdfplumber, pdf2image,
FastAPI, Recharts, html2canvas and jsPDF are MIT.
