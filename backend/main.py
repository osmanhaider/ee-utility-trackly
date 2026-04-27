import base64
import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import Cookie, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

import auth as auth_mod
import byok as byok_mod
import db as db_mod
import google_auth as google_auth_mod
from parser import parse_bill as parse_bill_tesseract
from parser_byok import parse_bill_with_byok
from parser_freellmapi import parse_bill_with_freellmapi
from translation import classify_line_item, enrich_parsed

logger = logging.getLogger("utility_tracker")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

# Parser backend: "tesseract" (default, no API key), "claude" (Anthropic API),
# or "freellmapi" (FreeLLMAPI text-only proxy)
PARSER_BACKEND = os.environ.get("PARSER_BACKEND", "tesseract").lower()
FREELLMAPI_BASE_URL = os.environ.get("FREELLMAPI_BASE_URL", "http://localhost:3001")
FREELLMAPI_API_KEY = os.environ.get("FREELLMAPI_API_KEY") or None
FREELLMAPI_MODEL = os.environ.get("FREELLMAPI_MODEL", "auto")

DB_PATH = os.environ.get("DB_PATH", "bills.db")
UPLOADS_DIR = os.environ.get("UPLOADS_DIR", "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

# Connection-level busy timeout — SQLite serialises writes, so under
# concurrent uploads from multiple browsers a writer can otherwise hit
# "database is locked" almost immediately. 10 s is comfortably longer
# than any single write transaction in this app.
DB_BUSY_TIMEOUT_SEC = 10.0

def _db():
    """Open the configured database: Supabase/Postgres when DATABASE_URL is set,
    otherwise local SQLite for dev/tests."""
    return db_mod.connect(DB_PATH, sqlite_timeout=DB_BUSY_TIMEOUT_SEC)

# Hard cap on upload size — protects against memory exhaustion from huge files.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", 25 * 1024 * 1024))  # 25 MB

# Allowed filename extensions (lowercased). The MIME check below is the
# primary gate; this second check rejects mismatched / hostile filenames.
_ALLOWED_EXTS = {"jpg", "jpeg", "png", "gif", "webp", "pdf"}
_ALLOWED_MIME = {
    "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf",
}

# Only these BillUpdate fields can be written. Anything outside the set is
# rejected even if it slips into the Pydantic model.
_EDITABLE_BILL_COLUMNS = frozenset({
    "provider", "utility_type", "amount_eur", "consumption_kwh",
    "consumption_m3", "bill_date", "period_start", "period_end", "notes",
    "is_private",
})

# Analytics can be expensive once raw_json line items grow. Cache for a short
# window and clear on every bill mutation so navigation feels instant without
# serving stale post-edit/delete data.
_ANALYTICS_CACHE_TTL_SEC = int(os.environ.get("ANALYTICS_CACHE_TTL_SEC", 60))
_analytics_cache: dict[tuple[str | None, bool], tuple[float, dict]] = {}


def _clear_analytics_cache() -> None:
    _analytics_cache.clear()


async def init_db() -> None:
    async with _db() as db:
        if db_mod.is_postgres():
            logger.info("Database backend: postgres")
            await _init_postgres(db)
        else:
            logger.info("Database backend: sqlite")
            await _init_sqlite(db)
        await db.commit()


async def _init_sqlite(db) -> None:
    # WAL mode lets readers and a single writer proceed concurrently instead of
    # blocking each other. This is SQLite-only and skipped for Supabase.
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("""
        CREATE TABLE IF NOT EXISTS bills (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            upload_date TEXT NOT NULL,
            bill_date TEXT,
            provider TEXT,
            utility_type TEXT,
            amount_eur REAL,
            consumption_kwh REAL,
            consumption_m3 REAL,
            period_start TEXT,
            period_end TEXT,
            account_number TEXT,
            address TEXT,
            raw_json TEXT,
            notes TEXT,
            user_id TEXT,
            is_private INTEGER NOT NULL DEFAULT 0
        )
    """)
    await db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            name TEXT,
            picture_url TEXT,
            created_at TEXT NOT NULL
        )
    """)
    await db.execute("""
        CREATE TABLE IF NOT EXISTS user_api_keys (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            label TEXT NOT NULL,
            provider TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            iv TEXT NOT NULL,
            tag TEXT NOT NULL,
            default_model TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(user_id, label)
        )
    """)
    await db.execute(
        "CREATE INDEX IF NOT EXISTS user_api_keys_user_id_idx ON user_api_keys(user_id)"
    )
    async with db.execute("PRAGMA table_info(bills)") as c:
        cols = {row[1] for row in await c.fetchall()}
    if "user_id" not in cols:
        await db.execute("ALTER TABLE bills ADD COLUMN user_id TEXT")
    if "is_private" not in cols:
        await db.execute("ALTER TABLE bills ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0")
    await db.execute("CREATE INDEX IF NOT EXISTS bills_user_id_idx ON bills(user_id)")


async def _init_postgres(db) -> None:
    await db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            name TEXT,
            picture_url TEXT,
            created_at TEXT NOT NULL
        )
    """)
    await db.execute("""
        CREATE TABLE IF NOT EXISTS bills (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            upload_date TEXT NOT NULL,
            bill_date TEXT,
            provider TEXT,
            utility_type TEXT,
            amount_eur DOUBLE PRECISION,
            consumption_kwh DOUBLE PRECISION,
            consumption_m3 DOUBLE PRECISION,
            period_start TEXT,
            period_end TEXT,
            account_number TEXT,
            address TEXT,
            raw_json TEXT,
            notes TEXT,
            user_id TEXT,
            is_private BOOLEAN NOT NULL DEFAULT false
        )
    """)
    await db.execute("""
        CREATE TABLE IF NOT EXISTS user_api_keys (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            label TEXT NOT NULL,
            provider TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            iv TEXT NOT NULL,
            tag TEXT NOT NULL,
            default_model TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(user_id, label)
        )
    """)
    await db.execute("ALTER TABLE bills ADD COLUMN IF NOT EXISTS user_id TEXT")
    await db.execute("ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false")
    await db.execute("CREATE INDEX IF NOT EXISTS bills_user_id_idx ON bills(user_id)")
    await db.execute("CREATE INDEX IF NOT EXISTS user_api_keys_user_id_idx ON user_api_keys(user_id)")


async def _upsert_user(db, identity: google_auth_mod.GoogleIdentity) -> None:
    """Create-or-update a row in the users table from a verified Google identity."""
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        """
        INSERT INTO users (id, email, name, picture_url, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            name = excluded.name,
            picture_url = excluded.picture_url
        """,
        (identity.sub, identity.email, identity.name, identity.picture, now),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Estonia Utility Bill Tracker", lifespan=lifespan)

# CORS. Defaults cover local dev + any *.vercel.app deployment (each
# preview branch gets its own hostname, so wildcarding avoids having to
# list them). Override CORS_ALLOW_ORIGINS / CORS_ALLOW_ORIGIN_REGEX for
# stricter production rules or to add a custom domain.
_DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://localhost:4173"
_DEFAULT_CORS_ORIGIN_REGEX = r"https://.*\.vercel\.app"
CORS_ALLOW_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ALLOW_ORIGINS", _DEFAULT_CORS_ORIGINS).split(",") if o.strip()
]
CORS_ALLOW_ORIGIN_REGEX = os.environ.get("CORS_ALLOW_ORIGIN_REGEX", _DEFAULT_CORS_ORIGIN_REGEX) or None

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_origin_regex=CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Paths that bypass the bearer-token check. `/api/auth/google` is the
# entry point that exchanges a Google ID token for an app token; everything
# else (including the legacy /api/auth/status probe still used by older
# frontend builds) requires a valid bearer.
_AUTH_EXEMPT_PATHS = frozenset({
    "/api/auth/google",
    "/api/auth/google-redirect",
    "/api/auth/status",
})


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # CORS preflights must pass through untouched — the browser strips
    # custom headers (including Authorization) before sending them.
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") or path in _AUTH_EXEMPT_PATHS:
        return await call_next(request)
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return JSONResponse({"detail": "Missing bearer token"}, status_code=401)
    try:
        payload = auth_mod.verify_token(header[7:].strip())
    except auth_mod.AuthError as e:
        return JSONResponse({"detail": f"Invalid token: {e}"}, status_code=401)
    request.state.user_id = payload["sub"]
    request.state.user_email = payload.get("email")
    request.state.user_name = payload.get("name")
    request.state.user_picture = payload.get("picture")
    return await call_next(request)


def get_user_id(request: Request) -> str:
    """Resolve the caller's user_id, set by auth_middleware."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    return user_id


if not auth_mod.AUTH_SECRET:
    raise RuntimeError(
        "AUTH_SECRET is required. Generate one with "
        "`python -c 'import secrets; print(secrets.token_hex(32))'`"
    )


class GoogleLoginRequest(BaseModel):
    id_token: str


@app.get("/api/auth/status")
async def auth_status():
    """Frontend-friendly status probe: tells the UI whether Google sign-in is
    wired up (so it can show a clear configuration error if not)."""
    return {
        "auth_required": True,
        "google_configured": bool(google_auth_mod.GOOGLE_CLIENT_ID),
    }


@app.post("/api/auth/google")
async def auth_google(body: GoogleLoginRequest):
    """Exchange a Google ID token for an app session token."""
    try:
        identity = google_auth_mod.verify_google_id_token(body.id_token)
    except google_auth_mod.GoogleAuthError as e:
        raise HTTPException(401, str(e)) from e

    async with _db() as db:
        await _upsert_user(db, identity)
        await db.commit()

    token = auth_mod.create_token(
        sub=identity.sub,
        email=identity.email,
        name=identity.name,
        picture=identity.picture,
    )
    return {
        "token": token,
        "user": {
            "id": identity.sub,
            "email": identity.email,
            "name": identity.name,
            "picture": identity.picture,
        },
    }


@app.post("/api/auth/google-redirect")
async def auth_google_redirect(
    credential: str = Form(...),
    g_csrf_token: str = Form(...),
    csrf_cookie: str | None = Cookie(default=None, alias="g_csrf_token"),
):
    """Server-side endpoint for Google Identity Services' redirect (`ux_mode`)
    flow.

    Used by clients that can't reliably receive credentials via the
    iframe/popup flow — most notably iOS Safari running as a standalone
    home-screen PWA, where storage partitioning and cross-origin
    postMessage restrictions cause the popup-based flow to fail with
    "try again" right after the user confirms.

    Google posts a form-encoded body containing `credential` (the ID
    token) and `g_csrf_token`. CSRF protection requires the form's
    `g_csrf_token` to equal the same-named cookie Google sets, per
    https://developers.google.com/identity/gsi/web/guides/verify-google-id-token.
    """
    frontend_url = (os.environ.get("FRONTEND_URL") or "/").rstrip("/")

    def _bounce(error: str) -> RedirectResponse:
        # Send the user back to the SPA with an error in the fragment so
        # the in-page handler can surface it next to the sign-in button.
        return RedirectResponse(
            f"{frontend_url}/auth/callback#error={error}",
            status_code=303,
        )

    if not csrf_cookie or csrf_cookie != g_csrf_token:
        return _bounce("csrf")

    try:
        identity = google_auth_mod.verify_google_id_token(credential)
    except google_auth_mod.GoogleAuthError as e:
        logger.warning("google-redirect verify failed: %s", e)
        return _bounce("invalid-token")

    async with _db() as db:
        await _upsert_user(db, identity)
        await db.commit()

    token = auth_mod.create_token(
        sub=identity.sub,
        email=identity.email,
        name=identity.name,
        picture=identity.picture,
    )

    # Token in the URL fragment so it never leaves the browser (fragments
    # aren't sent in the HTTP request line / proxies / server logs).
    return RedirectResponse(
        f"{frontend_url}/auth/callback#token={token}",
        status_code=303,
    )


@app.get("/api/auth/me")
async def auth_me(request: Request, user_id: str = Depends(get_user_id)):
    return {
        "id": user_id,
        "email": getattr(request.state, "user_email", None),
        "name": getattr(request.state, "user_name", None),
        "picture": getattr(request.state, "user_picture", None),
    }


class BillUpdate(BaseModel):
    provider: str | None = None
    utility_type: str | None = None
    amount_eur: float | None = None
    consumption_kwh: float | None = None
    consumption_m3: float | None = None
    bill_date: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    notes: str | None = None
    is_private: bool | None = None


def encode_image(path: str) -> tuple[str, str]:
    ext = path.rsplit(".", 1)[-1].lower()
    media_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                 "gif": "image/gif", "webp": "image/webp", "pdf": "application/pdf"}
    media_type = media_map.get(ext, "image/jpeg")
    with open(path, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode("utf-8")
    return data, media_type


_claude_client = None


def _get_claude_client():
    """Return a cached Anthropic client. Imports lazily so the tesseract
    backend doesn't require the anthropic package at runtime."""
    global _claude_client
    if _claude_client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "PARSER_BACKEND=claude requires ANTHROPIC_API_KEY to be set."
            )
        import anthropic  # noqa: WPS433 — intentional lazy import
        _claude_client = anthropic.Anthropic(api_key=api_key)
    return _claude_client


def parse_bill_with_claude(file_path: str) -> dict:
    client = _get_claude_client()
    data, media_type = encode_image(file_path)

    prompt = """You are an expert at reading invoices and bills of any type — utilities \
(electricity, gas, water, heating, internet, waste), subscriptions, services, rent, \
housing association fees, or any other kind.

Extract structured data from this invoice. Return ONLY a valid JSON object:
{
  "provider": "issuing company or supplier name",
  "utility_type": "best-fit category — one of: electricity, gas, water, heating, internet, waste, other",
  "amount_eur": numeric total amount due (use the invoice currency; convert symbol to number if needed),
  "consumption_kwh": numeric kWh consumed if applicable (null otherwise),
  "consumption_m3": numeric m³ consumed if applicable (null otherwise),
  "bill_date": "YYYY-MM-DD invoice date",
  "period_start": "YYYY-MM-DD billing period start (null if not shown)",
  "period_end": "YYYY-MM-DD billing period end (null if not shown)",
  "account_number": "customer / account / contract number",
  "address": "service or billing address",
  "period": "raw period text exactly as printed on the invoice — do NOT translate",
  "vat_amount": numeric VAT/tax amount,
  "amount_without_vat": numeric subtotal before VAT/tax,
  "meter_reading_start": numeric opening meter reading if shown,
  "meter_reading_end": numeric closing meter reading if shown,
  "due_date": "YYYY-MM-DD payment due date",
  "line_items": [
    {
      "description_et": "line item description exactly as printed on the invoice",
      "description_en": "English translation or plain-English rephrasing of the description",
      "amount_eur": numeric line amount,
      "quantity": numeric quantity,
      "unit": "unit of measure (kWh, m³, pcs, months, etc.)"
    }
  ],
  "confidence": "high/medium/low"
}

List every charge line visible. Use null for any field you cannot determine. Return only the JSON."""

    if media_type == "application/pdf":
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {"type": "base64", "media_type": "application/pdf", "data": data},
                    },
                    {"type": "text", "text": prompt},
                ]
            }]
        )
    else:
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}},
                    {"type": "text", "text": prompt}
                ]
            }]
        )

    text = message.content[0].text.strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return json.loads(text)


@app.post("/api/bills/upload")
async def upload_bill(
    file: UploadFile = File(...),
    parser: str | None = Form(None),
    model: str | None = Form(None),
    byok_key_id: str | None = Form(None),
    user_id: str = Depends(get_user_id),
):
    if file.content_type not in _ALLOWED_MIME:
        raise HTTPException(400, "Unsupported file type. Upload an image or PDF.")

    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "jpg"
    if ext not in _ALLOWED_EXTS:
        raise HTTPException(400, f"Unsupported file extension: .{ext}")

    # Stream the upload to disk in chunks so an oversize file doesn't blow
    # up the process, and enforce MAX_UPLOAD_BYTES as we go.
    bill_id = str(uuid.uuid4())
    save_path = os.path.join(UPLOADS_DIR, f"{bill_id}.{ext}")
    total = 0
    with open(save_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                f.close()
                try:
                    os.remove(save_path)
                except OSError:
                    pass
                raise HTTPException(
                    413,
                    f"File too large. Limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
                )
            f.write(chunk)

    effective_parser = (parser or PARSER_BACKEND).lower()
    if byok_key_id:
        # `byok_key_id` always wins regardless of `parser`, since the user
        # explicitly picked a saved key and providing one only makes sense
        # in BYOK mode.
        effective_parser = "byok"
    parse_error: str | None = None
    try:
        parsed = await _parse_uploaded_bill(
            effective_parser=effective_parser,
            save_path=save_path,
            user_id=user_id,
            byok_key_id=byok_key_id,
            model=model,
        )
        parsed = enrich_parsed(parsed)  # add translations locally — no API call
    except Exception as e:
        logger.exception("Bill parsing failed for %s (backend=%s)", filename, effective_parser)
        parse_error = f"{type(e).__name__}: {e}"
        parsed = {
            "error": parse_error,
            "_source": effective_parser,
            "_low_quality": True,
        }

    # Fail closed: if extraction errored out, or if the parser returned
    # something completely useless (no provider, no amount, no line items),
    # don't insert a half-empty row that would clutter the Bills tab as
    # "Unknown Provider €—". The user gets a clear error and can retry.
    has_useful_data = (
        bool(parsed.get("provider"))
        or parsed.get("amount_eur") is not None
        or bool(parsed.get("line_items"))
    )
    if parse_error is not None or not has_useful_data:
        try:
            os.remove(save_path)
        except OSError:
            pass
        message = parse_error or (
            "The parser couldn't read this invoice — no provider, amount, "
            "or line items detected. Try a clearer scan or switch parser."
        )
        raise HTTPException(
            status_code=422,
            detail={
                "message": message,
                "parser": effective_parser,
                "filename": filename,
            },
        )

    now = datetime.now(timezone.utc).isoformat()
    provider = parsed.get("provider")
    period_start = parsed.get("period_start")
    account_number = parsed.get("account_number")

    replaced = False
    replaced_id: str | None = None

    async with _db() as db:
        # All dedupe lookups are scoped to the caller's user_id so one
        # user's upload can never overwrite another user's bill.
        # 1st priority: same filename → same physical file uploaded again
        existing_row = None
        async with db.execute(
            "SELECT id, filename FROM bills WHERE filename = ? AND user_id = ? "
            "ORDER BY upload_date DESC LIMIT 1",
            (file.filename, user_id),
        ) as c:
            existing_row = await c.fetchone()

        # 2nd priority: same provider (case-insensitive) + same billing period
        if not existing_row and provider and period_start:
            async with db.execute(
                "SELECT id, filename FROM bills "
                "WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?)) AND period_start = ? AND user_id = ? "
                "ORDER BY upload_date DESC LIMIT 1",
                (provider, period_start, user_id),
            ) as c:
                existing_row = await c.fetchone()

        # 3rd priority: same provider (case-insensitive) + same account number
        if not existing_row and provider and account_number:
            async with db.execute(
                "SELECT id, filename FROM bills "
                "WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?)) AND account_number = ? AND user_id = ? "
                "ORDER BY upload_date DESC LIMIT 1",
                (provider, account_number, user_id),
            ) as c:
                existing_row = await c.fetchone()

        if existing_row:
            # Overwrite the matching row in place. Keep its id so any links hold.
            replaced = True
            replaced_id = existing_row[0]
            old_filename = existing_row[1]
            # Delete the previously stored file if it was a different one
            if old_filename:
                for ext_try in ("pdf", "png", "jpg", "jpeg", "gif", "webp"):
                    old_path = os.path.join(UPLOADS_DIR, f"{replaced_id}.{ext_try}")
                    if os.path.exists(old_path) and old_path != save_path:
                        try:
                            os.remove(old_path)
                        except OSError:
                            pass
            # Rename the newly uploaded file to use the original id so paths stay stable
            new_path = os.path.join(UPLOADS_DIR, f"{replaced_id}.{ext}")
            if new_path != save_path:
                try:
                    os.replace(save_path, new_path)
                    save_path = new_path
                except OSError:
                    pass
            bill_id = replaced_id

            await db.execute("""
                UPDATE bills SET
                    filename = ?, upload_date = ?, bill_date = ?, provider = ?,
                    utility_type = ?, amount_eur = ?, consumption_kwh = ?,
                    consumption_m3 = ?, period_start = ?, period_end = ?,
                    account_number = ?, address = ?, raw_json = ?
                WHERE id = ? AND user_id = ?
            """, (
                file.filename, now,
                parsed.get("bill_date"),
                parsed.get("provider"),
                parsed.get("utility_type"),
                parsed.get("amount_eur"),
                parsed.get("consumption_kwh"),
                parsed.get("consumption_m3"),
                parsed.get("period_start"),
                parsed.get("period_end"),
                parsed.get("account_number"),
                parsed.get("address"),
                json.dumps(parsed),
                replaced_id,
                user_id,
            ))
        else:
            await db.execute("""
                INSERT INTO bills (id, filename, upload_date, bill_date, provider, utility_type,
                    amount_eur, consumption_kwh, consumption_m3, period_start, period_end,
                    account_number, address, raw_json, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                bill_id, file.filename, now,
                parsed.get("bill_date"),
                parsed.get("provider"),
                parsed.get("utility_type"),
                parsed.get("amount_eur"),
                parsed.get("consumption_kwh"),
                parsed.get("consumption_m3"),
                parsed.get("period_start"),
                parsed.get("period_end"),
                parsed.get("account_number"),
                parsed.get("address"),
                json.dumps(parsed),
                user_id,
            ))
        await db.commit()

    _clear_analytics_cache()
    return {"id": bill_id, "parsed": parsed, "replaced": replaced}


async def _parse_uploaded_bill(
    *,
    effective_parser: str,
    save_path: str,
    user_id: str,
    byok_key_id: str | None,
    model: str | None,
) -> dict:
    """Run blocking OCR/LLM extraction in a worker thread.

    The parsers do CPU-ish OCR work and synchronous HTTP calls, so running them
    directly inside the FastAPI event loop blocks other users while a bill is
    being processed.
    """
    if effective_parser == "claude":
        return await asyncio.to_thread(parse_bill_with_claude, save_path)
    if effective_parser == "freellmapi":
        return await asyncio.to_thread(
            parse_bill_with_freellmapi,
            save_path,
            base_url=FREELLMAPI_BASE_URL,
            api_key=FREELLMAPI_API_KEY,
            model=model or FREELLMAPI_MODEL,
        )
    if effective_parser == "byok":
        byok_row = await _resolve_byok_key(user_id, byok_key_id or "")
        try:
            plaintext_key = byok_mod.decrypt(
                byok_row["encrypted_key"], byok_row["iv"], byok_row["tag"],
            )
        except Exception as e:
            raise RuntimeError(
                "Couldn't decrypt your saved API key. Re-add it from Settings."
            ) from e
        return await asyncio.to_thread(
            parse_bill_with_byok,
            save_path,
            provider_id=byok_row["provider"],
            api_key=plaintext_key,
            model=model or byok_row.get("default_model"),
        )
    return await asyncio.to_thread(parse_bill_tesseract, save_path)


@app.get("/api/bills")
async def list_bills(user_id: str = Depends(get_user_id)):
    async with _db() as db:
        async with db.execute(
            "SELECT * FROM bills WHERE user_id = ? "
            "ORDER BY bill_date DESC, upload_date DESC",
            (user_id,),
        ) as cursor:
            rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/bills/{bill_id}")
async def get_bill(bill_id: str, user_id: str = Depends(get_user_id)):
    async with _db() as db:
        async with db.execute(
            "SELECT * FROM bills WHERE id = ? AND user_id = ?",
            (bill_id, user_id),
        ) as cursor:
            row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Bill not found")
    return dict(row)


@app.put("/api/bills/{bill_id}")
async def update_bill(
    bill_id: str,
    update: BillUpdate,
    user_id: str = Depends(get_user_id),
):
    # Filter to editable columns only. Even though BillUpdate pins the shape,
    # the explicit allowlist prevents future field additions from silently
    # becoming writable at the HTTP layer.
    fields = {
        k: v for k, v in update.model_dump().items()
        if v is not None and k in _EDITABLE_BILL_COLUMNS
    }
    if not fields:
        raise HTTPException(400, "No fields to update")
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [bill_id, user_id]
    # The `AND user_id = ?` clause is the cross-user authorization gate —
    # even if a bill_id from another user leaks into the URL, the UPDATE
    # matches zero rows and we return 404 below.
    async with _db() as db:
        async with db.execute(
            f"UPDATE bills SET {set_clause} WHERE id = ? AND user_id = ?",
            values,
        ) as cursor:
            affected = cursor.rowcount
        await db.commit()
    if affected == 0:
        raise HTTPException(404, "Bill not found")
    _clear_analytics_cache()
    return {"status": "updated"}


@app.delete("/api/bills/{bill_id}")
async def delete_bill(bill_id: str, user_id: str = Depends(get_user_id)):
    # Same cross-user guard as the UPDATE: scope by user_id, then 404 if
    # the row didn't belong to the caller.
    async with _db() as db:
        async with db.execute(
            "DELETE FROM bills WHERE id = ? AND user_id = ?",
            (bill_id, user_id),
        ) as cursor:
            affected = cursor.rowcount
        await db.commit()
    if affected == 0:
        raise HTTPException(404, "Bill not found")
    _clear_analytics_cache()
    return {"status": "deleted"}


# In-memory cache of FreeLLMAPI's model list. The list is DB-backed and
# changes when the user edits the FreeLLM dashboard, so a short cache keeps
# the upload tab responsive without hiding updates for long.
_freellmapi_cache: dict = {"expires": 0.0, "models": []}
_FREELLMAPI_CACHE_TTL = 60  # 1 minute
_FREELLMAPI_FALLBACK = [
    {"id": "auto", "label": "Auto (FreeLLMAPI router)"},
]


def _freellmapi_v1_url(path: str) -> str:
    base = FREELLMAPI_BASE_URL.rstrip("/")
    if base.endswith("/v1"):
        return f"{base}{path}"
    return f"{base}/v1{path}"


async def _fetch_freellmapi_models() -> list[dict]:
    """Return the cached (or freshly fetched) list of FreeLLMAPI models."""
    now = time.time()
    if _freellmapi_cache["expires"] > now and _freellmapi_cache["models"]:
        return _freellmapi_cache["models"]

    try:
        headers = {}
        if FREELLMAPI_API_KEY:
            headers["Authorization"] = f"Bearer {FREELLMAPI_API_KEY}"
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(_freellmapi_v1_url("/models"), headers=headers)
            r.raise_for_status()
            data = r.json()
    except Exception:
        logger.exception("Failed to fetch FreeLLMAPI model list")
        return _FREELLMAPI_FALLBACK

    models: list[dict] = [{"id": "auto", "label": "Auto (FreeLLMAPI router)"}]
    seen = {"auto"}
    for m in data.get("data", []):
        mid = m.get("id")
        if not mid or mid in seen:
            continue
        owner = m.get("owned_by")
        name = m.get("name") or mid
        label = f"{name} ({owner})" if owner else name
        models.append({"id": mid, "label": label})
        seen.add(mid)

    if len(models) == 1:
        models = _FREELLMAPI_FALLBACK

    _freellmapi_cache["models"] = models
    _freellmapi_cache["expires"] = now + _FREELLMAPI_CACHE_TTL
    return models


@app.get("/api/freellmapi-models")
async def freellmapi_models():
    """Return currently-enabled models from FreeLLMAPI."""
    cached_at = _freellmapi_cache["expires"]
    models = await _fetch_freellmapi_models()
    return {"models": models, "cached": cached_at > time.time()}


def _build_bill_filter(
    user_id_filter: str | None,
    public_only: bool,
    extra_clauses: list[str] | None = None,
) -> tuple[str, list]:
    """Compose the WHERE clause + bound params for analytics queries.
    `user_id_filter=None` means "every user" (community view). `public_only`
    excludes bills the owner marked is_private."""
    clauses = list(extra_clauses or [])
    params: list = []
    if user_id_filter is not None:
        clauses.append("user_id = ?")
        params.append(user_id_filter)
    if public_only:
        clauses.append(db_mod.public_condition())
    where_sql = " AND ".join(clauses) if clauses else "1=1"
    return where_sql, params


async def _compute_analytics(user_id_filter: str | None, public_only: bool) -> dict:
    """Full analytics aggregation. The personal endpoint passes the caller's
    own user_id with public_only=False (their own private bills count). The
    community endpoint passes a target user_id (or None for "all users") with
    public_only=True."""
    where_amt, params_amt = _build_bill_filter(
        user_id_filter, public_only, ["amount_eur IS NOT NULL"]
    )
    where_provider, params_provider = _build_bill_filter(
        user_id_filter, public_only, ["amount_eur IS NOT NULL", "provider IS NOT NULL"]
    )
    async with _db() as db:

        # Fetch every bill so we can split korteriühistu bills into their
        # individual line-item categories (electricity, water, heating,
        # waste, building management, …). For single-service bills we
        # attribute the whole amount to the bill's utility_type.
        async with db.execute(f"""
            SELECT id, utility_type, amount_eur, consumption_kwh, consumption_m3,
                   period_start, bill_date, upload_date, raw_json
            FROM bills
            WHERE {where_amt}
        """, params_amt) as c:
            all_bills = [dict(r) for r in await c.fetchall()]

        async with db.execute(f"""
            SELECT
                provider,
                COUNT(*) as bill_count,
                SUM(amount_eur) as total_eur,
                AVG(amount_eur) as avg_eur
            FROM bills
            WHERE {where_provider}
            GROUP BY provider
            ORDER BY total_eur DESC
        """, params_provider) as c:
            by_provider = [dict(r) for r in await c.fetchall()]

        # DB-neutral replacement for SQLite's strftime('%Y-%m', ...). Fetching
        # all candidate bills is already required above for line-item analytics,
        # so computing monthly totals in Python avoids dialect-specific SQL.
        monthly_totals_by_month: dict[str, float] = {}
        for bill in all_bills:
            date_key = bill["period_start"] or bill["bill_date"] or bill["upload_date"]
            amount = bill["amount_eur"]
            if not date_key or len(date_key) < 7 or amount is None:
                continue
            month = str(date_key)[:7]
            monthly_totals_by_month[month] = monthly_totals_by_month.get(month, 0.0) + float(amount)
        monthly_total = [
            {"month": month, "total_eur": round(total, 2)}
            for month, total in sorted(monthly_totals_by_month.items())
        ]

    # ────────────────────────────────────────────────────────────────────
    # Per-category breakdown.
    # Split each korteriühistu bill (utility_type="other") into its
    # individual line-item categories so the Type Breakdown chart shows a
    # meaningful split instead of one giant "other" slice. Single-service
    # bills contribute their whole amount under their utility_type.
    #
    # We aggregate at the *bill-category* level, not the *line-item* level:
    # a single bill with 3 water line items contributes ONE water entry
    # whose amount is the sum of the 3 lines. That way bill_count and
    # min/max/avg per type remain bill-level stats.
    # ────────────────────────────────────────────────────────────────────
    from collections import defaultdict

    # bill_cat_totals[(bill_id, category)] = summed line-item amount
    bill_cat_totals: dict[tuple[str, str], float] = defaultdict(float)
    bill_meta: dict[str, dict] = {}

    for bill in all_bills:
        date_key = bill["period_start"] or bill["bill_date"] or bill["upload_date"]
        if not date_key or len(date_key) < 7:
            continue
        bid = bill["id"]
        bill_meta[bid] = {
            "month": date_key[:7],
            "year": date_key[:4],
            "month_num": date_key[5:7],
            "utility_type": bill["utility_type"] or "other",
            "amount_eur": bill["amount_eur"],
            "consumption_kwh": bill["consumption_kwh"],
            "consumption_m3": bill["consumption_m3"],
        }
        bill_type = bill["utility_type"] or "other"

        # For korteriühistu bills, split by line-item category; single-
        # service bills attribute their total to the bill's utility_type.
        if bill_type == "other" and bill["raw_json"]:
            try:
                raw = json.loads(bill["raw_json"])
            except (json.JSONDecodeError, TypeError):
                raw = {}
            items = raw.get("line_items") or []
            attributed = False
            for item in items:
                amt = item.get("amount_eur")
                if amt is None:
                    continue
                cat = classify_line_item(item.get("description_et") or "")
                bill_cat_totals[(bid, cat)] += float(amt)
                attributed = True
            if attributed and bill["amount_eur"] is not None:
                # Reconcile line-item splits to the headline bill amount.
                # Real korteriühistu invoices include VAT, rounding,
                # prepaid balances and fees that aren't surfaced as
                # classified line items, so the residual is bucketed
                # under "other" to keep per-category aggregations
                # summing to amount_eur.
                attributed_total = sum(
                    v for (b, _), v in bill_cat_totals.items() if b == bid
                )
                residual = round(float(bill["amount_eur"]) - attributed_total, 2)
                if abs(residual) > 0.01:
                    bill_cat_totals[(bid, "other")] += residual
            elif not attributed and bill["amount_eur"] is not None:
                bill_cat_totals[(bid, "other")] = float(bill["amount_eur"])
        elif bill["amount_eur"] is not None:
            bill_cat_totals[(bid, bill_type)] = float(bill["amount_eur"])

    # Build type-level aggregation from bill-category totals
    type_amts: dict[str, list[float]] = defaultdict(list)
    type_kwh: dict[str, float] = defaultdict(float)
    type_m3: dict[str, float] = defaultdict(float)
    type_has_kwh: set[str] = set()
    type_has_m3: set[str] = set()

    month_agg: dict[tuple[str, str], float] = defaultdict(float)
    month_bill_count: dict[tuple[str, str], int] = defaultdict(int)
    year_agg: dict[tuple[str, str], list[float]] = defaultdict(list)
    seasonal_agg: dict[tuple[str, str], list[float]] = defaultdict(list)

    for (bid, cat), amt in bill_cat_totals.items():
        amt_r = round(amt, 2)
        meta = bill_meta[bid]
        type_amts[cat].append(amt_r)
        month_agg[(meta["month"], cat)] += amt_r
        month_bill_count[(meta["month"], cat)] += 1
        year_agg[(meta["year"], cat)].append(amt_r)
        seasonal_agg[(meta["month_num"], cat)].append(amt_r)

    # Consumption attribution: kWh belongs to electricity, m³ belongs to water.
    # For single-service bills, use the bill's own utility_type.
    for bid, meta in bill_meta.items():
        if meta["consumption_kwh"] is not None:
            target = meta["utility_type"] if meta["utility_type"] != "other" else "electricity"
            type_kwh[target] += float(meta["consumption_kwh"])
            type_has_kwh.add(target)
        if meta["consumption_m3"] is not None:
            target = meta["utility_type"] if meta["utility_type"] != "other" else "water"
            type_m3[target] += float(meta["consumption_m3"])
            type_has_m3.add(target)

    def _stats(amts: list[float]) -> dict:
        return {
            "bill_count": len(amts),
            "total_eur": round(sum(amts), 2),
            "avg_eur": round(sum(amts) / len(amts), 2) if amts else 0.0,
            "min_eur": round(min(amts), 2) if amts else 0.0,
            "max_eur": round(max(amts), 2) if amts else 0.0,
        }

    by_type = []
    all_categories = set(type_amts.keys()) | type_has_kwh | type_has_m3
    for utype in sorted(all_categories, key=lambda t: -sum(type_amts.get(t, []))):
        s = _stats(type_amts.get(utype, []))
        by_type.append({
            "utility_type": utype,
            **s,
            "total_kwh": round(type_kwh[utype], 2) if utype in type_has_kwh else None,
            "total_m3": round(type_m3[utype], 2) if utype in type_has_m3 else None,
        })

    by_month = sorted(
        [{"month": m, "utility_type": t, "total_eur": round(v, 2),
          "bill_count": month_bill_count[(m, t)]}
         for (m, t), v in month_agg.items()],
        key=lambda r: (r["month"], r["utility_type"]),
    )

    by_year = sorted(
        [{"year": y, "utility_type": t, "total_eur": round(sum(amts), 2),
          # avg_per_bill_eur reflects the average amount per bill-category
          # row (one row per bill split into its category portion); it is
          # NOT a per-calendar-month average.
          "avg_per_bill_eur": round(sum(amts) / len(amts), 2) if amts else 0.0,
          "bill_count": len(amts)}
         for (y, t), amts in year_agg.items()],
        key=lambda r: (r["year"], r["utility_type"]),
    )

    annual_rollup: dict[str, dict] = {}
    for meta in bill_meta.values():
        amount = meta["amount_eur"]
        year = meta["year"]
        if amount is None or not year:
            continue
        row = annual_rollup.setdefault(
            year,
            {"year": year, "bill_count": 0, "total_eur": 0.0},
        )
        # Distinct bill-level rollup: one bill contributes exactly once, even
        # when its line items are split across multiple utility categories for
        # `by_year`.
        row["bill_count"] += 1
        row["total_eur"] += float(amount)
    annual_total = [
        {
            "year": year,
            "bill_count": row["bill_count"],
            "total_eur": round(row["total_eur"], 2),
            "avg_bill_eur": round(row["total_eur"] / row["bill_count"], 2)
            if row["bill_count"]
            else 0.0,
        }
        for year, row in sorted(annual_rollup.items())
    ]

    seasonal = sorted(
        [{"month_num": mn, "utility_type": t,
          "avg_eur": round(sum(amts) / len(amts), 2) if amts else 0.0,
          # total_eur and bill_count let the frontend radar compute weighted
          # season averages (Σtotal / Σcount) instead of averaging averages.
          "total_eur": round(sum(amts), 2),
          "bill_count": len(amts)}
         for (mn, t), amts in seasonal_agg.items()],
        key=lambda r: (r["month_num"], r["utility_type"]),
    )

    # Bill-level totals (distinct from by_type which is category-level)
    bill_amounts = [
        float(m["amount_eur"]) for m in bill_meta.values()
        if m["amount_eur"] is not None
    ]
    if bill_amounts:
        totals = {
            "bill_count": len(bill_amounts),
            "total_eur": round(sum(bill_amounts), 2),
            "avg_eur": round(sum(bill_amounts) / len(bill_amounts), 2),
            "min_eur": round(min(bill_amounts), 2),
            "max_eur": round(max(bill_amounts), 2),
        }
    else:
        totals = {"bill_count": 0, "total_eur": 0.0, "avg_eur": 0.0,
                  "min_eur": 0.0, "max_eur": 0.0}

    def _prev_month_key(month_key: str) -> str:
        y, m = month_key.split("-")
        yi, mi = int(y), int(m)
        if mi == 1:
            return f"{yi - 1:04d}-12"
        return f"{yi:04d}-{mi - 1:02d}"

    month_map = {r["month"]: r["total_eur"] for r in monthly_total}

    # Calendar-aware rolling 3-month average — averages months in
    # [m-2, m-1, m] that have data. Sparse data still produces a sensible
    # value (it equals m's own value when only m has data) without
    # silently spanning many calendar months as the row-based window did.
    for row in monthly_total:
        keys = [row["month"]]
        p = row["month"]
        for _ in range(2):
            p = _prev_month_key(p)
            keys.append(p)
        values = [month_map[k] for k in keys if k in month_map]
        row["rolling_avg_3m"] = (
            round(sum(values) / len(values), 2) if values else 0.0
        )

    # Calendar-aware MoM — compares the full monthly totals across the
    # immediately preceding calendar month. When that month has no data
    # the deltas are null so a 6-month gap can't masquerade as "MoM".
    for row in monthly_total:
        prev = month_map.get(_prev_month_key(row["month"]))
        if prev is None or prev == 0:
            row["mom_delta_eur"] = None
            row["mom_delta_pct"] = None
        else:
            row["mom_delta_eur"] = round(row["total_eur"] - prev, 2)
            row["mom_delta_pct"] = round((row["total_eur"] - prev) / prev * 100, 1)

    # YoY against the full monthly total a year earlier.
    for row in monthly_total:
        y, m = row["month"].split("-")
        prev_year_key = f"{int(y) - 1}-{m}"
        prev = month_map.get(prev_year_key)
        row["yoy_delta_eur"] = round(row["total_eur"] - prev, 2) if prev else None
        row["yoy_delta_pct"] = round((row["total_eur"] - prev) / prev * 100, 1) if prev else None

    # Line-item level trends — aggregated per (month, item) so duplicate
    # rows (multi-tariff electricity, multiple bills in the same month, etc.)
    # combine into a single point with a quantity-weighted unit price.
    import re as _re_li
    _suffix_en = _re_li.compile(r"\s*\[Start:.*?\]\s*$")
    _suffix_et = _re_li.compile(r"\s+[Aa]lg[:\s].*$")

    li_acc: dict[tuple[str, str], dict] = {}

    for row_li in (r for r in all_bills if r.get("raw_json")):
        date_str = row_li["period_start"] or row_li["bill_date"] or row_li["upload_date"]
        if not date_str:
            continue
        month = date_str[:7]
        try:
            raw_data = json.loads(row_li["raw_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        for item in raw_data.get("line_items") or []:
            en = (item.get("description_en") or "").strip()
            et = (item.get("description_et") or "").strip()
            amount = item.get("amount_eur")
            qty = item.get("quantity")
            unit = (item.get("unit") or "").lower()
            if not en or amount is None:
                continue
            # Strip per-bill meter-reading suffixes so the same item
            # aggregates across months.
            en_key = _suffix_en.sub("", en).strip()
            et_key = _suffix_et.sub("", et).strip()
            slot = li_acc.setdefault(
                (month, en_key),
                {
                    "month": month,
                    "description_en": en_key,
                    "description_et": et_key,
                    "amount_eur": 0.0,
                    "quantity": 0.0,
                    "has_quantity": False,
                    "unit": unit,
                },
            )
            slot["amount_eur"] += float(amount)
            # Only sum quantity-bearing rows so the weighted unit price is
            # well-defined; rows without quantity still contribute to the
            # period's amount.
            if qty is not None and qty != 0:
                slot["quantity"] += float(qty)
                slot["has_quantity"] = True
            if unit and not slot["unit"]:
                slot["unit"] = unit

    line_item_trends: list[dict] = []
    for slot in li_acc.values():
        qty_total = slot["quantity"] if slot["has_quantity"] else None
        unit_price = (
            round(slot["amount_eur"] / qty_total, 4)
            if qty_total
            else None
        )
        line_item_trends.append({
            "month": slot["month"],
            "description_en": slot["description_en"],
            "description_et": slot["description_et"],
            "amount_eur": round(slot["amount_eur"], 2),
            "quantity": round(qty_total, 4) if qty_total is not None else None,
            "unit": slot["unit"],
            "unit_price": unit_price,
        })

    # Sort so frontend always gets chronological order
    line_item_trends.sort(key=lambda r: (r["month"], r["description_en"]))

    return {
        "totals": totals,
        "by_type": by_type,
        "by_month": by_month,
        "by_year": by_year,
        "annual_total": annual_total,
        "seasonal": seasonal,
        "by_provider": by_provider,
        "monthly_total": monthly_total,
        "line_item_trends": line_item_trends,
    }


@app.get("/api/analytics/summary")
async def analytics_summary(user_id: str = Depends(get_user_id)):
    """Personal analytics: caller's bills, both private and public."""
    return await _get_cached_analytics(user_id, public_only=False)


@app.get("/api/community/users")
async def community_users(_user_id: str = Depends(get_user_id)):
    """List every signed-up user with a count of their public bills."""
    async with _db() as db:
        async with db.execute(
            f"""
            SELECT u.id, u.name, u.email, u.picture_url,
                   COALESCE(b.bill_count, 0) AS bill_count
            FROM users u
            LEFT JOIN (
                SELECT user_id, COUNT(*) AS bill_count
                FROM bills
                WHERE {db_mod.public_condition()}
                GROUP BY user_id
            ) b ON b.user_id = u.id
            ORDER BY bill_count DESC, LOWER(COALESCE(u.name, ''))
            """
        ) as c:
            rows = await c.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/community/bills")
async def community_bills(
    target_user_id: str | None = None,
    _user_id: str = Depends(get_user_id),
):
    """List public bills across the whole community, optionally scoped to one user."""
    async with _db() as db:
        public_bills = db_mod.public_condition("b")
        if target_user_id:
            sql = f"""
                SELECT b.*, u.name AS owner_name, u.picture_url AS owner_picture
                FROM bills b
                LEFT JOIN users u ON u.id = b.user_id
                WHERE b.user_id = ? AND {public_bills}
                ORDER BY COALESCE(b.bill_date, b.upload_date) DESC
            """
            params: tuple = (target_user_id,)
        else:
            sql = f"""
                SELECT b.*, u.name AS owner_name, u.picture_url AS owner_picture
                FROM bills b
                LEFT JOIN users u ON u.id = b.user_id
                WHERE {public_bills}
                ORDER BY COALESCE(b.bill_date, b.upload_date) DESC
            """
            params = ()
        async with db.execute(sql, params) as c:
            rows = await c.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/community/analytics")
async def community_analytics(
    target_user_id: str | None = None,
    _user_id: str = Depends(get_user_id),
):
    """Aggregate analytics across the whole community, or one user. Public bills only."""
    return await _get_cached_analytics(target_user_id, public_only=True)


async def _get_cached_analytics(user_id_filter: str | None, public_only: bool) -> dict:
    key = (user_id_filter, public_only)
    now = time.time()
    cached = _analytics_cache.get(key)
    if cached and cached[0] > now:
        return cached[1]
    data = await _compute_analytics(user_id_filter, public_only)
    _analytics_cache[key] = (now + _ANALYTICS_CACHE_TTL_SEC, data)
    return data


# ────────────────────────────────────────────────────────────────────────
# Bring-your-own-key (BYOK) endpoints.
# Each user can store API keys for OpenAI-compatible providers, encrypted
# at rest with AES-GCM. Plaintext never leaves the backend.
# ────────────────────────────────────────────────────────────────────────


def _require_byok_configured() -> None:
    if not byok_mod.is_configured():
        raise HTTPException(
            503,
            "BYOK is disabled because BYOK_ENCRYPTION_KEY is not set on the server.",
        )


async def _resolve_byok_key(user_id: str, key_id: str) -> dict:
    """Fetch a user's saved key row, scoped by user_id. Raises 404 otherwise."""
    _require_byok_configured()
    async with _db() as db:
        async with db.execute(
            "SELECT id, user_id, label, provider, encrypted_key, iv, tag, default_model "
            "FROM user_api_keys WHERE id = ? AND user_id = ?",
            (key_id, user_id),
        ) as c:
            row = await c.fetchone()
    if not row:
        raise HTTPException(404, "API key not found.")
    return dict(row)


class ByokKeyCreate(BaseModel):
    label: str
    provider: str
    key: str
    default_model: str | None = None


@app.get("/api/byok-providers")
async def byok_providers(_user_id: str = Depends(get_user_id)):
    """Public catalogue of supported OpenAI-compatible providers."""
    return {
        "configured": byok_mod.is_configured(),
        "providers": [
            {
                "id": p.id,
                "name": p.name,
                "default_model": p.default_model,
                "key_hint": p.key_hint,
                "key_url": p.key_url,
            }
            for p in byok_mod.PROVIDERS.values()
        ],
    }


@app.get("/api/byok-keys")
async def byok_keys_list(user_id: str = Depends(get_user_id)):
    """Return the caller's saved keys with masked values — never plaintext."""
    _require_byok_configured()
    async with _db() as db:
        async with db.execute(
            "SELECT id, label, provider, encrypted_key, iv, tag, default_model, created_at "
            "FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        ) as c:
            rows = await c.fetchall()
    out = []
    for row in rows:
        try:
            plain = byok_mod.decrypt(row["encrypted_key"], row["iv"], row["tag"])
            masked = byok_mod.mask_key(plain)
        except Exception:
            masked = "(decrypt failed)"
        out.append({
            "id": row["id"],
            "label": row["label"],
            "provider": row["provider"],
            "masked_key": masked,
            "default_model": row["default_model"],
            "created_at": row["created_at"],
        })
    return out


@app.post("/api/byok-keys", status_code=201)
async def byok_keys_create(
    body: ByokKeyCreate,
    user_id: str = Depends(get_user_id),
):
    _require_byok_configured()
    if body.provider not in byok_mod.PROVIDERS:
        raise HTTPException(400, f"Unknown provider: {body.provider!r}")
    label = body.label.strip()
    plain = body.key.strip()
    if not label:
        raise HTTPException(400, "Label is required.")
    if len(plain) < 8:
        raise HTTPException(400, "API key looks too short to be valid.")

    try:
        ct, iv, tag = byok_mod.encrypt(plain)
    except byok_mod.ByokError as e:
        raise HTTPException(503, str(e)) from e

    new_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    try:
        async with _db() as db:
            await db.execute(
                """
                INSERT INTO user_api_keys
                    (id, user_id, label, provider, encrypted_key, iv, tag, default_model, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (new_id, user_id, label, body.provider, ct, iv, tag,
                 (body.default_model or "").strip() or None, now),
            )
            await db.commit()
    except db_mod.IntegrityError as e:
        raise HTTPException(409, f"You already have a key with label {label!r}.") from e

    return {
        "id": new_id,
        "label": label,
        "provider": body.provider,
        "masked_key": byok_mod.mask_key(plain),
        "default_model": (body.default_model or "").strip() or None,
        "created_at": now,
    }


@app.delete("/api/byok-keys/{key_id}")
async def byok_keys_delete(key_id: str, user_id: str = Depends(get_user_id)):
    _require_byok_configured()
    async with _db() as db:
        async with db.execute(
            "DELETE FROM user_api_keys WHERE id = ? AND user_id = ?",
            (key_id, user_id),
        ) as cursor:
            affected = cursor.rowcount
        await db.commit()
    if affected == 0:
        raise HTTPException(404, "API key not found.")
    return {"status": "deleted"}
