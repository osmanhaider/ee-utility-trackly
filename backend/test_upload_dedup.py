"""Regression tests for the upload dedup logic in `POST /api/bills/upload`.

The upload endpoint tries three matchers, in order:
  1. Same filename for the same user
  2. Same provider + same period_start for the same user
  3. Same provider + same account_number for the same user — but only
     as a fallback when the new upload has NO period_start to match on,
     and the existing row also has no period_start

Priority 3 used to fire whenever priority 2 missed, which silently
collapsed two bills from the same account but different billing periods
(e.g. January electric vs February electric) into one row, overwriting
the older month. This file pins the corrected behaviour down.

We don't drive a real PDF/Tesseract here; the parser is monkeypatched
to return controlled dicts so the tests are deterministic and fast.
"""
from __future__ import annotations

import importlib
import io
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture()
def app(monkeypatch: pytest.MonkeyPatch):
    """A fresh FastAPI app + TestClient bound to a temp DB and uploads dir.

    The TestClient is entered as a context manager so the app's lifespan
    handler runs and `init_db()` actually creates the `bills` table.
    """
    tmpdir = Path(tempfile.mkdtemp(prefix="utility-dedup-test-"))
    monkeypatch.setenv("AUTH_SECRET", "x" * 64)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
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


def _fake_jpg() -> bytes:
    """Tiny payload that satisfies the upload size + content-type checks.

    The byte content doesn't matter — `_parse_uploaded_bill` is patched out,
    so the file is never actually decoded.
    """
    return b"\xff\xd8\xff\xe0fake-jpg-bytes"


def _upload(client: TestClient, headers: dict, filename: str) -> dict:
    files = {"file": (filename, io.BytesIO(_fake_jpg()), "image/jpeg")}
    r = client.post("/api/bills/upload", files=files, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _patch_parser(main_mod, monkeypatch: pytest.MonkeyPatch, results: list[dict]):
    """Make `_parse_uploaded_bill` return the next dict from `results`
    on each call (FIFO). Lets each test script the parser output."""
    queue = list(results)

    async def _fake(**_kwargs):
        assert queue, "parser called more times than the test scripted"
        return queue.pop(0)

    monkeypatch.setattr(main_mod, "_parse_uploaded_bill", _fake)


def _list_bills(client: TestClient, headers: dict) -> list[dict]:
    r = client.get("/api/bills", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_same_provider_and_account_but_different_periods_do_not_merge(
    app, monkeypatch: pytest.MonkeyPatch
):
    """The bug: uploading February's bill while January is on file
    used to overwrite January because both shared provider+account.
    With the fix, they must both survive as distinct rows."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Eesti Energia",
            "amount_eur": 50.0,
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
            "account_number": "ACC-123",
        },
        {
            "provider": "Eesti Energia",
            "amount_eur": 65.0,
            "period_start": "2026-02-01",
            "period_end": "2026-02-28",
            "account_number": "ACC-123",
        },
    ])

    jan = _upload(client, headers, "january.jpg")
    feb = _upload(client, headers, "february.jpg")

    assert jan["replaced"] is False
    assert feb["replaced"] is False, (
        "February must be a new row, not a replacement of January"
    )
    assert jan["id"] != feb["id"]

    bills = _list_bills(client, headers)
    periods = sorted(b["period_start"] for b in bills)
    assert periods == ["2026-01-01", "2026-02-01"]


def test_same_provider_and_period_replaces_existing(app, monkeypatch: pytest.MonkeyPatch):
    """Re-uploading the same month's bill (e.g. a clearer scan) should
    update the existing row in place, keeping its id."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Eesti Energia",
            "amount_eur": 50.0,
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
            "account_number": "ACC-123",
        },
        {
            "provider": "Eesti Energia",
            "amount_eur": 51.42,  # corrected amount on the cleaner scan
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
            "account_number": "ACC-123",
        },
    ])

    first = _upload(client, headers, "jan-blurry.jpg")
    second = _upload(client, headers, "jan-clear.jpg")

    assert first["replaced"] is False
    assert second["replaced"] is True
    assert first["id"] == second["id"]

    bills = _list_bills(client, headers)
    assert len(bills) == 1
    assert bills[0]["amount_eur"] == 51.42


def test_same_filename_replaces_existing_even_without_period(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Priority 1 (filename) should still catch a literal re-upload of
    the same file even when the parser couldn't extract a period."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Tallinna Vesi",
            "amount_eur": 18.0,
            "account_number": "ACC-9",
        },
        {
            "provider": "Tallinna Vesi",
            "amount_eur": 18.0,
            "account_number": "ACC-9",
        },
    ])

    first = _upload(client, headers, "water.jpg")
    second = _upload(client, headers, "water.jpg")

    assert first["replaced"] is False
    assert second["replaced"] is True
    assert first["id"] == second["id"]


def test_account_number_fallback_only_when_neither_has_period(
    app, monkeypatch: pytest.MonkeyPatch
):
    """If both uploads have no period_start, the provider+account
    fallback may merge them (parser-failure re-upload of the same bill).
    Filename differs so priority 1 doesn't trigger."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {"provider": "Gasum", "amount_eur": 30.0, "account_number": "G-7"},
        {"provider": "Gasum", "amount_eur": 30.0, "account_number": "G-7"},
    ])

    first = _upload(client, headers, "gas-a.jpg")
    second = _upload(client, headers, "gas-b.jpg")

    assert first["replaced"] is False
    assert second["replaced"] is True
    assert first["id"] == second["id"]


def test_account_number_fallback_does_not_overwrite_when_existing_has_period(
    app, monkeypatch: pytest.MonkeyPatch
):
    """If the existing row has a period but the new upload doesn't, we
    can't tell whether they're the same bill — default to inserting a
    new row rather than silently overwriting the dated one."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Gasum",
            "amount_eur": 30.0,
            "period_start": "2026-03-01",
            "period_end": "2026-03-31",
            "account_number": "G-7",
        },
        {"provider": "Gasum", "amount_eur": 30.0, "account_number": "G-7"},
    ])

    first = _upload(client, headers, "gas-march.jpg")
    second = _upload(client, headers, "gas-unknown.jpg")

    assert first["replaced"] is False
    assert second["replaced"] is False
    assert first["id"] != second["id"]


def test_one_users_upload_never_overwrites_another_users_bill(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Dedup must be scoped per-user. Even with identical provider,
    account and period, Bob's upload should not touch Alice's row."""
    main_mod, client = app

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Eesti Energia",
            "amount_eur": 50.0,
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
            "account_number": "ACC-123",
        },
        {
            "provider": "Eesti Energia",
            "amount_eur": 99.0,
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
            "account_number": "ACC-123",
        },
    ])

    alice = _upload(client, _bearer(main_mod, "alice-sub", "alice@x"), "jan.jpg")
    bob = _upload(client, _bearer(main_mod, "bob-sub", "bob@x"), "jan.jpg")

    assert alice["replaced"] is False
    assert bob["replaced"] is False
    assert alice["id"] != bob["id"]

    alice_bills = _list_bills(client, _bearer(main_mod, "alice-sub", "alice@x"))
    assert len(alice_bills) == 1
    assert alice_bills[0]["amount_eur"] == 50.0
