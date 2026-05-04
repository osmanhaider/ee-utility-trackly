"""Regression tests for the audit-batch-1 fixes.

Each test pins down a specific behaviour the README promises but that the
production code was getting wrong. Keep this file dense and focused —
one or two assertions per behaviour, no broad integration tests.
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture()
def app(monkeypatch: pytest.MonkeyPatch):
    """Fresh FastAPI app + TestClient bound to a temp DB and uploads dir.

    The TestClient is entered as a context manager so the app's lifespan
    handler runs and `init_db()` actually creates the tables (and our
    new partial unique index).
    """
    tmpdir = Path(tempfile.mkdtemp(prefix="utility-audit-test-"))
    monkeypatch.setenv("AUTH_SECRET", "x" * 64)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
    # Throwaway 32-byte base64 key so BYOK is enabled in these tests.
    monkeypatch.setenv("BYOK_ENCRYPTION_KEY",
                       "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    monkeypatch.setenv("DB_PATH", str(tmpdir / "bills.db"))
    monkeypatch.setenv("UPLOADS_DIR", str(tmpdir / "uploads"))
    monkeypatch.setenv("PARSER_BACKEND", "tesseract")

    import auth
    importlib.reload(auth)
    if "main" in sys.modules:
        del sys.modules["main"]
    import main as main_mod
    with TestClient(main_mod.app) as client:
        yield main_mod, client


def _bearer(main_mod, sub: str = "alice-sub", email: str = "alice@x") -> dict:
    token = main_mod.auth_mod.create_token(sub=sub, email=email, name=email)
    return {"Authorization": f"Bearer {token}"}


# ─────────────────────────── Fix #2: no-store on 401 ──────────────────────────

def test_no_store_headers_on_missing_bearer_token(app):
    """The README promises every /api/* response carries no-store cache
    headers so iOS Safari / PWA can't serve stale data. That MUST hold
    for auth-failure responses too — those are the ones most likely to
    be cached by a heuristic browser cache."""
    _, client = app
    r = client.get("/api/bills")
    assert r.status_code == 401
    assert r.headers.get("cache-control") == "no-store, max-age=0, must-revalidate"
    assert r.headers.get("pragma") == "no-cache"


def test_no_store_headers_on_invalid_bearer_token(app):
    _, client = app
    r = client.get("/api/bills", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401
    assert r.headers.get("cache-control") == "no-store, max-age=0, must-revalidate"
    assert r.headers.get("pragma") == "no-cache"


def test_no_store_headers_on_authenticated_success(app):
    """Sanity: the original middleware still works on the happy path."""
    main_mod, client = app
    r = client.get("/api/bills", headers=_bearer(main_mod))
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "no-store, max-age=0, must-revalidate"


# ─────────────── Fix #4: PATCH cannot wipe a required base_url ────────────────

def _create_byok_key(client: TestClient, headers: dict, **overrides) -> str:
    """Helper: create a BYOK key, return its id."""
    body = {
        "label": overrides.pop("label", "test-key"),
        "provider": overrides.pop("provider", "ollama"),
        "key": overrides.pop("key", "ignored-by-ollama"),
        "base_url": overrides.pop("base_url", "http://localhost:11434/v1"),
        **overrides,
    }
    r = client.post("/api/byok-keys", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_patch_rejects_clearing_required_base_url(app):
    """Ollama requires a base URL. PATCHing with `base_url: ""` used to
    silently set it to NULL, leaving the next probe / parse to fail
    because there's no recoverable URL. That should now be rejected."""
    main_mod, client = app
    headers = _bearer(main_mod)
    key_id = _create_byok_key(client, headers)

    r = client.patch(
        f"/api/byok-keys/{key_id}",
        json={"base_url": ""},
        headers=headers,
    )
    assert r.status_code == 400, r.text
    assert "requires a base URL" in r.json()["detail"]


def test_patch_allows_clearing_optional_base_url(app):
    """OpenAI provider doesn't require a custom URL, so clearing the
    override is fine — the request should succeed and the row should
    keep its other fields."""
    main_mod, client = app
    headers = _bearer(main_mod)
    key_id = _create_byok_key(
        client, headers,
        label="openai-key", provider="openai",
        key="sk-test-12345678", base_url="https://custom.example.com/v1",
    )
    r = client.patch(
        f"/api/byok-keys/{key_id}",
        json={"base_url": ""},
        headers=headers,
    )
    assert r.status_code == 200, r.text


def test_patch_allows_changing_required_base_url(app):
    """Switching from one valid base URL to another for a required-URL
    provider should still work — only the empty-string / null case is
    blocked."""
    main_mod, client = app
    headers = _bearer(main_mod)
    key_id = _create_byok_key(client, headers)
    r = client.patch(
        f"/api/byok-keys/{key_id}",
        json={"base_url": "http://other-host:11434/v1"},
        headers=headers,
    )
    assert r.status_code == 200, r.text


# ────────── Fix #5: probe error message must not echo upstream key ──────────

def test_probe_error_does_not_echo_upstream_body_with_secrets(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Some upstream gateways reflect the bearer they received into
    their error JSON. The probe handler must not pass that through —
    we'd be leaking the user's plaintext API key back through the API."""
    main_mod, client = app
    headers = _bearer(main_mod)

    leaked_key = "sk-supersecretkeyabcdef0123456789"

    class _FakeResp:
        status_code = 401
        text = (
            f'{{"error": {{"message": "Invalid auth header: Bearer {leaked_key}"}}}}'
        )
        def json(self):
            import json as _json
            return _json.loads(self.text)

    class _FakeClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def get(self, *_a, **_kw): return _FakeResp()

    monkeypatch.setattr(main_mod.httpx, "AsyncClient", _FakeClient)

    r = client.post(
        "/api/byok-keys/probe",
        json={
            "provider": "openai",
            "key": leaked_key,
            "base_url": "https://api.openai.com/v1",
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["status"] == 401
    # The leaked key must not appear anywhere in the response, even via
    # the upstream `error.message` channel.
    assert leaked_key not in body["message"]
    assert "[redacted]" in body["message"] or "Authentication failed" in body["message"]


def test_probe_error_uses_canned_headline_for_known_status(
    app, monkeypatch: pytest.MonkeyPatch
):
    """For known status codes (401, 429, …) the probe should surface a
    fixed, user-friendly headline rather than dumping arbitrary
    upstream text — that's both safer (no key echo) and clearer."""
    main_mod, client = app
    headers = _bearer(main_mod)

    class _FakeResp:
        status_code = 429
        text = "rate limited, you sent too many requests, sk-mykey-12345"
        def json(self):
            raise ValueError("not json")

    class _FakeClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def get(self, *_a, **_kw): return _FakeResp()

    monkeypatch.setattr(main_mod.httpx, "AsyncClient", _FakeClient)

    r = client.post(
        "/api/byok-keys/probe",
        json={"provider": "openai", "key": "sk-x", "base_url": None},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == 429
    assert "Rate limited" in body["message"]
    assert "sk-mykey-12345" not in body["message"]


# ────── Fix #6: at most one default per (user, provider) under load ──────

def test_creating_default_key_demotes_previous_default(app):
    """Single-thread sanity: creating key B with is_default=true should
    leave A with is_default=false and B as the sole default."""
    main_mod, client = app
    headers = _bearer(main_mod)

    a = _create_byok_key(client, headers, label="ollama-a", is_default=True)
    b = _create_byok_key(client, headers, label="ollama-b", is_default=True)

    r = client.get("/api/byok-keys", headers=headers)
    assert r.status_code == 200
    keys_by_id = {k["id"]: k for k in r.json()}
    assert keys_by_id[a]["is_default"] is False
    assert keys_by_id[b]["is_default"] is True
    # And there's exactly one default per (user, provider).
    defaults = [k for k in r.json() if k["is_default"] and k["provider"] == "ollama"]
    assert len(defaults) == 1


def test_set_default_uses_single_atomic_statement(app):
    """The fix collapses demote+promote into one UPDATE. After flipping
    the default twice, only the latest pick should be `is_default=true`."""
    main_mod, client = app
    headers = _bearer(main_mod)
    a = _create_byok_key(client, headers, label="ollama-a")
    b = _create_byok_key(client, headers, label="ollama-b")
    c = _create_byok_key(client, headers, label="ollama-c")

    assert client.post(f"/api/byok-keys/{a}/default", headers=headers).status_code == 200
    assert client.post(f"/api/byok-keys/{c}/default", headers=headers).status_code == 200

    keys = {k["id"]: k for k in client.get("/api/byok-keys", headers=headers).json()}
    assert keys[a]["is_default"] is False
    assert keys[b]["is_default"] is False
    assert keys[c]["is_default"] is True


def test_partial_unique_index_blocks_two_defaults_at_storage_layer(app):
    """Even if the application logic regressed, the partial unique index
    we added in init_db() should refuse a second is_default=true row
    for the same (user, provider). Verifying this directly via the DB
    catches future regressions in the SQL flow."""
    import asyncio

    main_mod, _ = app

    async def _attempt() -> Exception | None:
        async with main_mod._db() as db:
            await db.execute(
                "INSERT INTO user_api_keys "
                "(id, user_id, label, provider, encrypted_key, iv, tag, is_default, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("k-a", "alice", "a", "ollama", "ct", "iv", "tag", True, "2026-01-01"),
            )
            try:
                await db.execute(
                    "INSERT INTO user_api_keys "
                    "(id, user_id, label, provider, encrypted_key, iv, tag, is_default, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("k-b", "alice", "b", "ollama", "ct", "iv", "tag", True, "2026-01-02"),
                )
                await db.commit()
                return None
            except Exception as e:
                return e

    err = asyncio.run(_attempt())
    assert err is not None, (
        "Partial unique index should have prevented two defaults for the "
        "same (user_id, provider)"
    )
