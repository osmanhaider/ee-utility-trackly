"""Regression tests for the BYOK auto-fallback chain.

When a user uploads a bill without pinning a specific `byok_key_id`,
the backend rotates through their saved keys in LRU order, skipping
any that were just rate-limited / out-of-credits / auth-failed and
falling over to the next healthy one. This file pins down:

- The KeyExhaustedError → fall over → next key path
- LRU ordering (round-robin distributes uploads across healthy keys)
- 1-hour cooldown window (exhausted keys come back after 1h)
- Bookkeeping: `last_used_at` updates on success, `last_error` clears
- All-keys-exhausted ⇒ 422 with a clear summary
- Per-user isolation (Bob's exhausted state never affects Alice)

We monkeypatch `parse_bill_with_byok` so no real provider calls happen.
"""
from __future__ import annotations

import asyncio
import importlib
import io
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture()
def app(monkeypatch: pytest.MonkeyPatch):
    """Fresh FastAPI app + TestClient bound to a temp DB. BYOK is enabled
    via a throwaway encryption key so the create-key endpoints work."""
    tmpdir = Path(tempfile.mkdtemp(prefix="byok-fallback-test-"))
    monkeypatch.setenv("AUTH_SECRET", "x" * 64)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("BYOK_ENCRYPTION_KEY",
                       "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    monkeypatch.setenv("DB_PATH", str(tmpdir / "bills.db"))
    monkeypatch.setenv("UPLOADS_DIR", str(tmpdir / "uploads"))
    # The new UI always sends parser=byok, but for the bare-bones
    # TestClient calls below we let PARSER_BACKEND default it to
    # byok too — saves repeating `data={"parser": "byok"}` in every
    # `_upload` invocation.
    monkeypatch.setenv("PARSER_BACKEND", "byok")

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


def _add_key(client: TestClient, headers: dict, label: str, **overrides) -> str:
    body = {
        "label": label,
        "provider": overrides.pop("provider", "groq"),
        "key": overrides.pop("key", "sk-test-1234567890abcdef"),
        "is_default": overrides.pop("is_default", False),
        **overrides,
    }
    r = client.post("/api/byok-keys", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _fake_jpg() -> bytes:
    return b"\xff\xd8\xff\xe0fake-jpg-bytes"


def _upload(client: TestClient, headers: dict, filename: str = "x.jpg") -> dict:
    files = {"file": (filename, io.BytesIO(_fake_jpg()), "image/jpeg")}
    r = client.post("/api/bills/upload", files=files, headers=headers)
    return r


def _patch_byok_parser(main_mod, monkeypatch: pytest.MonkeyPatch, behaviours: list):
    """Each call to `parse_bill_with_byok` consumes the next entry from
    `behaviours` — either a dict to return or an Exception to raise.
    The test fully scripts what each key's attempt looks like, so we
    can simulate "key A is rate-limited but key B succeeds" cleanly."""
    queue = list(behaviours)
    calls: list[dict] = []

    def _fake(file_path: str, *, provider_id, api_key, model, base_url_override):
        calls.append({"provider": provider_id, "model": model, "key": api_key})
        assert queue, "parser called more times than the test scripted"
        next_step = queue.pop(0)
        if isinstance(next_step, BaseException):
            raise next_step
        return next_step

    monkeypatch.setattr(main_mod, "parse_bill_with_byok", _fake)
    return calls


def _ok_parsed(provider: str = "Test Provider") -> dict:
    """A minimally valid parsed-bill dict that survives the upload
    pipeline's "has_useful_data" gate."""
    return {
        "provider": provider,
        "utility_type": "electricity",
        "amount_eur": 25.0,
        "period_start": "2026-04-01",
        "period_end": "2026-04-30",
    }


def _list_keys(client: TestClient, headers: dict) -> list[dict]:
    r = client.get("/api/byok-keys", headers=headers)
    assert r.status_code == 200
    return r.json()


# ───────────── KeyExhaustedError vs RuntimeError discrimination ─────────────

def test_key_exhausted_error_carries_kind():
    """The exception class needs both a user-facing message AND a stable
    `kind` field so the chain can record what tripped each key."""
    from parser_openai_compat import KeyExhaustedError

    e = KeyExhaustedError("rate limited", kind=KeyExhaustedError.KIND_RATE_LIMIT)
    assert isinstance(e, RuntimeError)
    assert str(e) == "rate limited"
    assert e.kind == "rate_limit"


def test_classify_key_exhaustion_recognises_typed_error_envelopes():
    """`_classify_key_exhaustion` is the heuristic that decides whether
    a non-200 response is key-specific (try another) or generic
    (fail the upload). It must catch the typed error codes the major
    OpenAI-compatible providers use."""
    from parser_openai_compat import KeyExhaustedError, _classify_key_exhaustion

    # OpenAI's "out of credits" body comes back as 429 sometimes,
    # 400 with `insufficient_quota` other times — both should resolve
    # to "out of credits" and get the chain to fall over.
    body = {"error": {"code": "insufficient_quota", "message": "..."}}
    assert _classify_key_exhaustion(400, body) == KeyExhaustedError.KIND_OUT_OF_CREDITS

    # 401 with `invalid_api_key` → auth failed
    body = {"error": {"code": "invalid_api_key", "message": "..."}}
    assert _classify_key_exhaustion(401, body) == KeyExhaustedError.KIND_AUTH_FAILED

    # Plain 429 → rate limited (no body needed)
    assert _classify_key_exhaustion(429, None) == KeyExhaustedError.KIND_RATE_LIMIT

    # Generic 500 with no typed body → None (don't try another key,
    # this is upstream flake not a key issue)
    assert _classify_key_exhaustion(500, "Internal Server Error") is None


# ─────────────────── Round-robin / LRU ordering ───────────────────

def test_first_upload_picks_least_recently_used_key(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Two keys, both freshly created (NULL `last_used_at`). Tie-break
    on `created_at`, so the older one is picked first. After it
    succeeds, the second upload hits the OTHER key (LRU rotation)."""
    main_mod, client = app
    headers = _bearer(main_mod)

    a = _add_key(client, headers, "groq-a", key="sk-key-aaaaaaaaaa")
    _add_key(client, headers, "groq-b", key="sk-key-bbbbbbbbbb")  # noqa: F841 — id checked via call inspection

    calls = _patch_byok_parser(main_mod, monkeypatch, [
        _ok_parsed(),
        _ok_parsed(),
    ])

    r1 = _upload(client, headers, "first.jpg")
    assert r1.status_code == 200, r1.text
    r2 = _upload(client, headers, "second.jpg")
    assert r2.status_code == 200, r2.text

    # First call should have used the older key (a), then rotated to b
    # because a's last_used_at is now newer than b's NULL.
    assert calls[0]["key"] == "sk-key-aaaaaaaaaa"
    assert calls[1]["key"] == "sk-key-bbbbbbbbbb"

    # And the bookkeeping: both keys have `last_used_at` set, both have
    # cleared `last_error`, and the first-used key (a) shows up before
    # the second since it was used earlier.
    keys_now = {k["label"]: k for k in _list_keys(client, headers)}
    assert keys_now["groq-a"]["last_used_at"]
    assert keys_now["groq-b"]["last_used_at"]
    assert keys_now["groq-a"]["last_used_at"] < keys_now["groq-b"]["last_used_at"]
    assert keys_now["groq-a"]["last_error"] is None
    assert keys_now["groq-b"]["last_error"] is None
    assert all(not k["is_exhausted"] for k in keys_now.values())
    # Cross-check against the row id we inserted first.
    assert any(k["id"] == a for k in keys_now.values())


# ─────────────────── Fallback on KeyExhaustedError ───────────────────

def test_rate_limited_first_key_falls_over_to_second_key(
    app, monkeypatch: pytest.MonkeyPatch
):
    """The first-tried key returns 429; the chain catches
    `KeyExhaustedError`, marks that key exhausted in the DB, and
    immediately retries with the next key. The user sees a clean 200
    upload result — they never know the first key tripped."""
    from parser_openai_compat import KeyExhaustedError

    main_mod, client = app
    headers = _bearer(main_mod)
    _add_key(client, headers, "groq-a", key="sk-key-aaaaaaaaaa")
    _add_key(client, headers, "groq-b", key="sk-key-bbbbbbbbbb")

    calls = _patch_byok_parser(main_mod, monkeypatch, [
        KeyExhaustedError(
            "groq rate limit hit", kind=KeyExhaustedError.KIND_RATE_LIMIT,
        ),
        _ok_parsed(),
    ])

    r = _upload(client, headers, "test.jpg")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parsed"]["provider"] == "Test Provider"

    assert len(calls) == 2  # one failed attempt, then one succeeded
    keys = {k["label"]: k for k in _list_keys(client, headers)}
    assert keys["groq-a"]["is_exhausted"] is True
    assert keys["groq-a"]["last_error"].startswith("rate_limit:")
    assert keys["groq-b"]["is_exhausted"] is False
    assert keys["groq-b"]["last_error"] is None


def test_out_of_credits_falls_over_with_typed_kind(
    app, monkeypatch: pytest.MonkeyPatch
):
    """An out-of-credits failure should mark the key with the
    `out_of_credits` kind (not `rate_limit`), so the Settings tab can
    show a different badge."""
    from parser_openai_compat import KeyExhaustedError

    main_mod, client = app
    headers = _bearer(main_mod)
    _add_key(client, headers, "openai-a", provider="openai", key="sk-key-aaaaaaaaaa")
    _add_key(client, headers, "openai-b", provider="openai", key="sk-key-bbbbbbbbbb")

    _patch_byok_parser(main_mod, monkeypatch, [
        KeyExhaustedError(
            "out of credits", kind=KeyExhaustedError.KIND_OUT_OF_CREDITS,
        ),
        _ok_parsed(),
    ])

    r = _upload(client, headers)
    assert r.status_code == 200, r.text

    keys = {k["label"]: k for k in _list_keys(client, headers)}
    assert keys["openai-a"]["last_error"].startswith("out_of_credits:")
    assert keys["openai-a"]["is_exhausted"] is True


def test_all_keys_exhausted_returns_422_with_summary(
    app, monkeypatch: pytest.MonkeyPatch
):
    """When every key in the chain raises KeyExhaustedError, the upload
    must surface a 422 with `all_keys_exhausted: True` and a list of
    per-key failures so the frontend can show a clear "all keys
    rate-limited" banner."""
    from parser_openai_compat import KeyExhaustedError

    main_mod, client = app
    headers = _bearer(main_mod)
    _add_key(client, headers, "groq-a", key="sk-key-aaaaaaaaaa")
    _add_key(client, headers, "groq-b", key="sk-key-bbbbbbbbbb")

    _patch_byok_parser(main_mod, monkeypatch, [
        KeyExhaustedError("a rate limited", kind=KeyExhaustedError.KIND_RATE_LIMIT),
        KeyExhaustedError("b rate limited", kind=KeyExhaustedError.KIND_RATE_LIMIT),
    ])

    r = _upload(client, headers)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["all_keys_exhausted"] is True
    assert len(detail["failures"]) == 2
    labels = {f["label"] for f in detail["failures"]}
    assert labels == {"groq-a", "groq-b"}

    # Both keys are now flagged in the listing so the Settings tab
    # can render two red badges.
    keys = {k["label"]: k for k in _list_keys(client, headers)}
    assert keys["groq-a"]["is_exhausted"] is True
    assert keys["groq-b"]["is_exhausted"] is True


def test_no_keys_at_all_returns_helpful_422(app, monkeypatch: pytest.MonkeyPatch):
    """A user with zero keys hitting the auto-fallback chain should
    get a clear 'add a key first' error rather than the generic
    'all keys exhausted' message — the frontend's onboarding gate
    should normally prevent this, but the backend defends in depth."""
    main_mod, client = app
    headers = _bearer(main_mod)
    _patch_byok_parser(main_mod, monkeypatch, [])

    r = _upload(client, headers)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail.get("no_keys") is True


# ─────────────────── Cooldown window ───────────────────

def test_exhausted_key_skipped_until_cooldown_expires(
    app, monkeypatch: pytest.MonkeyPatch
):
    """A key whose `last_error_at` is within the 1-hour cooldown is
    skipped at the start of the next request. After the cooldown
    elapses (we simulate it by writing an old `last_error_at`
    directly), the key is treated as healthy again and tried first
    (LRU favours not-recently-used)."""
    from parser_openai_compat import KeyExhaustedError

    main_mod, client = app
    headers = _bearer(main_mod)
    a = _add_key(client, headers, "groq-a", key="sk-key-aaaaaaaaaa")
    _add_key(client, headers, "groq-b", key="sk-key-bbbbbbbbbb")

    # First upload: a is rate-limited, b succeeds.
    _patch_byok_parser(main_mod, monkeypatch, [
        KeyExhaustedError("rate limit", kind=KeyExhaustedError.KIND_RATE_LIMIT),
        _ok_parsed(),
    ])
    r = _upload(client, headers, "first.jpg")
    assert r.status_code == 200

    # Second upload: a is still in cooldown, so the chain skips it
    # entirely and goes straight to b.
    calls = _patch_byok_parser(main_mod, monkeypatch, [_ok_parsed()])
    r = _upload(client, headers, "second.jpg")
    assert r.status_code == 200
    assert len(calls) == 1
    assert calls[0]["key"] == "sk-key-bbbbbbbbbb"

    # Now expire a's cooldown by backdating `last_error_at` past 1 hour.
    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    async def _backdate():
        async with main_mod._db() as db:
            await db.execute(
                "UPDATE user_api_keys SET last_error_at = ? WHERE id = ?",
                (old, a),
            )
            await db.commit()
    asyncio.run(_backdate())

    # Third upload: a should now be tried first (LRU — its
    # `last_used_at` is older / null compared to b's recent one).
    calls = _patch_byok_parser(main_mod, monkeypatch, [_ok_parsed()])
    r = _upload(client, headers, "third.jpg")
    assert r.status_code == 200
    assert calls[0]["key"] == "sk-key-aaaaaaaaaa"


# ─────────────────── Per-user isolation ───────────────────

def test_one_users_exhausted_keys_dont_affect_another_user(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Bob's keys must not be visible to or affected by Alice's
    upload, ever — the same per-user scoping invariant we test for
    bills extends to BYOK key state."""
    from parser_openai_compat import KeyExhaustedError

    main_mod, client = app
    alice = _bearer(main_mod, "alice-sub", "alice@x")
    bob = _bearer(main_mod, "bob-sub", "bob@x")

    _add_key(client, alice, "alice-key", key="sk-alice-aaaaaaaaaa")
    _add_key(client, bob, "bob-key", key="sk-bob-bbbbbbbbbb")

    # Alice's upload exhausts her only key. Bob's key must remain
    # untouched in the DB.
    _patch_byok_parser(main_mod, monkeypatch, [
        KeyExhaustedError("alice rate limit", kind=KeyExhaustedError.KIND_RATE_LIMIT),
    ])
    r = _upload(client, alice)
    assert r.status_code == 422

    alice_keys = _list_keys(client, alice)
    bob_keys = _list_keys(client, bob)
    assert alice_keys[0]["is_exhausted"] is True
    assert bob_keys[0]["is_exhausted"] is False
    assert bob_keys[0]["last_error"] is None


# ─────────────────── Pinned-key behaviour (no fallback) ───────────────────

def test_explicit_byok_key_id_does_not_fall_over(
    app, monkeypatch: pytest.MonkeyPatch
):
    """When the user pins a specific `byok_key_id` (legacy explicit
    pick), the auto-fallback chain is bypassed and the upload fails if
    that one key fails. The exhausted state is still recorded so the
    Settings badge updates, but no other key is tried."""
    from parser_openai_compat import KeyExhaustedError

    main_mod, client = app
    headers = _bearer(main_mod)
    a = _add_key(client, headers, "groq-a", key="sk-key-aaaaaaaaaa")
    _add_key(client, headers, "groq-b", key="sk-key-bbbbbbbbbb")  # exists but should NOT be tried

    calls = _patch_byok_parser(main_mod, monkeypatch, [
        KeyExhaustedError("rate limit", kind=KeyExhaustedError.KIND_RATE_LIMIT),
    ])

    files = {"file": ("x.jpg", io.BytesIO(_fake_jpg()), "image/jpeg")}
    r = client.post(
        "/api/bills/upload",
        files=files,
        data={"parser": "byok", "byok_key_id": a},
        headers=headers,
    )
    assert r.status_code == 422
    assert len(calls) == 1, "Pinned byok_key_id must not fall over to other keys"

    # The pinned key's exhausted flag is still set so the user can see
    # in Settings what just happened.
    keys = {k["label"]: k for k in _list_keys(client, headers)}
    assert keys["groq-a"]["is_exhausted"] is True
    assert keys["groq-b"]["is_exhausted"] is False
