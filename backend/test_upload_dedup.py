"""Regression tests for the upload dedup logic in `POST /api/bills/upload`.

The upload endpoint tries three matchers, in order:
  1. Same filename for the same user
  2. Same provider + same period_start + same utility_type for the same user
  3. Same provider + same account_number + same utility_type for the same
     user — but only as a fallback when the new upload has NO period_start
     to match on, and the existing row also has no period_start

Two real-world failure modes pinned down here:

A. Priority 3 used to fire whenever priority 2 missed, which silently
   collapsed two bills from the same account but different billing
   periods (Jan electric vs Feb electric) into one row, overwriting
   the older month.

B. Priority 2 used to ignore utility_type, which silently collapsed
   two distinct services from the same provider in the same month
   (Telia phone + Telia internet, or Eesti Gaas heating + cooking)
   into one row, overwriting the first.

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


def test_same_provider_different_utility_types_do_not_merge(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Real bug from a user report: one provider sending two distinct
    bills for two distinct services in the same month (e.g. Telia
    phone + Telia internet) used to be collapsed into one row by
    priority-2 dedup, which only considered (provider, period). The
    second upload silently overwrote the first.

    Now: priority 2 also requires utility_type to match, so both bills
    survive and the user can see / aggregate them separately."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Telia",
            "utility_type": "telecom",
            "amount_eur": 20.0,
            "period_start": "2026-03-01",
            "period_end": "2026-03-31",
        },
        {
            "provider": "Telia",
            "utility_type": "internet",
            "amount_eur": 30.0,
            "period_start": "2026-03-01",
            "period_end": "2026-03-31",
        },
    ])

    phone = _upload(client, headers, "telia-phone.jpg")
    internet = _upload(client, headers, "telia-internet.jpg")

    assert phone["replaced"] is False
    assert internet["replaced"] is False, (
        "Telia internet must be a new row, not a replacement of Telia phone"
    )
    bills = _list_bills(client, headers)
    types = sorted((b["utility_type"], b["amount_eur"]) for b in bills)
    assert types == [("internet", 30.0), ("telecom", 20.0)]


def test_same_provider_same_type_same_period_still_dedupes(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Sanity: the utility_type guard must not break the legitimate
    same-bill-uploaded-twice case. A re-upload with the same
    (provider, period, type) should still UPDATE in place rather than
    inserting a duplicate row."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Eesti Energia", "utility_type": "electricity",
            "amount_eur": 50.0,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
        {
            "provider": "Eesti Energia", "utility_type": "electricity",
            "amount_eur": 51.42,  # corrected on the cleaner re-scan
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
    ])

    first = _upload(client, headers, "eesti-blurry.jpg")
    second = _upload(client, headers, "eesti-clear.jpg")

    assert first["replaced"] is False
    assert second["replaced"] is True
    assert first["id"] == second["id"]

    bills = _list_bills(client, headers)
    assert len(bills) == 1
    assert bills[0]["amount_eur"] == 51.42


def test_one_known_type_and_one_null_type_do_not_merge(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Edge case: if the parser correctly classified one bill as
    `electricity` and failed to classify another (NULL type) from the
    same provider in the same month, those are most likely two
    different bills (one of which the parser misclassified) — not the
    same bill uploaded twice. The strict COALESCE(...) = COALESCE(...)
    rule keeps them as separate rows so the user can sort it out
    manually rather than silently losing one."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Eesti Energia", "utility_type": "electricity",
            "amount_eur": 50.0,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
        {
            "provider": "Eesti Energia", "utility_type": None,
            "amount_eur": 80.0,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
    ])

    a = _upload(client, headers, "a.jpg")
    b = _upload(client, headers, "b.jpg")

    assert a["replaced"] is False
    assert b["replaced"] is False
    assert a["id"] != b["id"]
    assert len(_list_bills(client, headers)) == 2


def test_two_null_types_with_same_provider_and_period_still_dedupe(
    app, monkeypatch: pytest.MonkeyPatch
):
    """Symmetry check: two re-uploads where the parser failed to
    classify both should still collapse into one row (same bill, same
    parser failure). NULL == NULL via COALESCE-to-empty-string."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Mystery Co", "utility_type": None,
            "amount_eur": 12.34,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
        {
            "provider": "Mystery Co", "utility_type": None,
            "amount_eur": 12.34,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
    ])

    first = _upload(client, headers, "first.jpg")
    second = _upload(client, headers, "second.jpg")

    assert first["replaced"] is False
    assert second["replaced"] is True
    assert len(_list_bills(client, headers)) == 1


# ───────── Aggregation: multiple distinct bills in the same month ─────────

def test_multiple_distinct_bills_in_one_month_aggregate_correctly(
    app, monkeypatch: pytest.MonkeyPatch
):
    """User scenario: separate electricity, heating, and water bills
    uploaded individually for the same month should all survive and
    aggregate cleanly in the analytics dashboard:

    - monthly_total: sum of all three amounts for that month
    - by_type: each bill contributes to its own utility_type row
    - bill counts and per-type stats: per-bill (not collapsed)

    This is the common multi-utility household case — the README
    promises it works and this test pins it down."""
    main_mod, client = app
    headers = _bearer(main_mod)

    _patch_parser(main_mod, monkeypatch, [
        {
            "provider": "Eesti Energia", "utility_type": "electricity",
            "amount_eur": 50.0,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
        {
            "provider": "Adven", "utility_type": "heating",
            "amount_eur": 80.0,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
        {
            "provider": "Tallinna Vesi", "utility_type": "water",
            "amount_eur": 30.0,
            "period_start": "2026-03-01", "period_end": "2026-03-31",
        },
    ])

    _upload(client, headers, "electricity.jpg")
    _upload(client, headers, "heating.jpg")
    _upload(client, headers, "water.jpg")

    bills = _list_bills(client, headers)
    assert len(bills) == 3, "All three distinct bills must survive"

    r = client.get("/api/analytics/summary", headers=headers)
    assert r.status_code == 200
    payload = r.json()

    by_month = {row["month"]: row for row in payload["monthly_total"]}
    assert "2026-03" in by_month
    assert by_month["2026-03"]["total_eur"] == 160.0, (
        "Monthly total should be sum of all three bills (50 + 80 + 30 = 160)"
    )

    by_type = {row["utility_type"]: row for row in payload["by_type"]}
    assert by_type["electricity"]["total_eur"] == 50.0
    assert by_type["heating"]["total_eur"] == 80.0
    assert by_type["water"]["total_eur"] == 30.0
    for utype in ("electricity", "heating", "water"):
        assert by_type[utype]["bill_count"] == 1, (
            f"{utype} should have exactly one contributing bill"
        )

    by_provider = {row["provider"]: row for row in payload["by_provider"]}
    assert {"Eesti Energia", "Adven", "Tallinna Vesi"}.issubset(by_provider.keys())
    assert by_provider["Eesti Energia"]["total_eur"] == 50.0
    assert by_provider["Adven"]["total_eur"] == 80.0
    assert by_provider["Tallinna Vesi"]["total_eur"] == 30.0

    annual = {row["year"]: row for row in payload["annual_total"]}
    assert annual["2026"]["bill_count"] == 3
    assert annual["2026"]["total_eur"] == 160.0
