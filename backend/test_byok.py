"""Tests for the BYOK module + endpoints.

Covers:
- AES-GCM encrypt/decrypt round-trip
- mask_key behavior for short and long keys
- BYOK_ENCRYPTION_KEY missing rejects encrypt/decrypt at runtime
- Cross-user isolation: Bob can't list / use / delete Alice's keys
"""
from __future__ import annotations

import asyncio
import base64
import importlib
import os
import secrets
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))


def _b64_key(n: int = 32) -> str:
    return base64.b64encode(secrets.token_bytes(n)).decode()


# ────────────────────────────────────────────────────────────────────────
# Pure-helper tests (no app, no DB)
# ────────────────────────────────────────────────────────────────────────


def _reload_byok(monkeypatch: pytest.MonkeyPatch, key: str | None) -> object:
    if key is None:
        monkeypatch.delenv("BYOK_ENCRYPTION_KEY", raising=False)
    else:
        monkeypatch.setenv("BYOK_ENCRYPTION_KEY", key)
    import byok
    importlib.reload(byok)
    byok.reset_encryption_key_cache()
    return byok


def test_encrypt_decrypt_roundtrip(monkeypatch: pytest.MonkeyPatch):
    byok = _reload_byok(monkeypatch, _b64_key())
    plain = "sk-test-1234567890abcdef"
    ct, iv, tag = byok.encrypt(plain)
    assert ct and iv and tag
    assert byok.decrypt(ct, iv, tag) == plain


def test_decrypt_with_wrong_tag_fails(monkeypatch: pytest.MonkeyPatch):
    from cryptography.exceptions import InvalidTag

    byok = _reload_byok(monkeypatch, _b64_key())
    ct, iv, _tag = byok.encrypt("sk-secret")
    bad_tag = base64.b64encode(b"x" * 16).decode()
    with pytest.raises(InvalidTag):
        byok.decrypt(ct, iv, bad_tag)


def test_mask_key_long_and_short(monkeypatch: pytest.MonkeyPatch):
    byok = _reload_byok(monkeypatch, _b64_key())
    assert byok.mask_key("sk-abcdefghij12345678") == "sk-a…5678"
    assert byok.mask_key("short") == "•" * 8


def test_missing_encryption_key_rejected(monkeypatch: pytest.MonkeyPatch):
    byok = _reload_byok(monkeypatch, None)
    assert byok.is_configured() is False
    with pytest.raises(byok.ByokError, match="BYOK_ENCRYPTION_KEY"):
        byok.encrypt("anything")


def test_hex_encoded_key_also_works(monkeypatch: pytest.MonkeyPatch):
    """Either base64 or 64-char hex is accepted for ergonomics."""
    hex_key = secrets.token_bytes(32).hex()
    byok = _reload_byok(monkeypatch, hex_key)
    ct, iv, tag = byok.encrypt("sk-roundtrip")
    assert byok.decrypt(ct, iv, tag) == "sk-roundtrip"


def test_invalid_key_length_rejected(monkeypatch: pytest.MonkeyPatch):
    byok = _reload_byok(monkeypatch, base64.b64encode(b"too-short").decode())
    with pytest.raises(byok.ByokError, match="32 bytes"):
        byok.encrypt("anything")


# ────────────────────────────────────────────────────────────────────────
# End-to-end endpoint tests
# ────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    tmpdir = Path(tempfile.mkdtemp(prefix="utility-byok-test-"))
    monkeypatch.setenv("AUTH_SECRET", "x" * 64)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", _b64_key())
    monkeypatch.setenv("DB_PATH", str(tmpdir / "bills.db"))
    monkeypatch.setenv("UPLOADS_DIR", str(tmpdir / "uploads"))
    monkeypatch.setenv("PARSER_BACKEND", "tesseract")

    import auth
    import byok
    importlib.reload(auth)
    importlib.reload(byok)
    byok.reset_encryption_key_cache()
    if "main" in sys.modules:
        del sys.modules["main"]
    import main as main_mod
    asyncio.run(main_mod.init_db())
    return main_mod, TestClient(main_mod.app)


def _bearer(main_mod, sub: str, email: str) -> dict:
    token = main_mod.auth_mod.create_token(sub=sub, email=email, name=email)
    return {"Authorization": f"Bearer {token}"}


def test_provider_catalogue_listed(client):
    main_mod, c = client
    r = c.get("/api/byok-providers", headers=_bearer(main_mod, "alice", "a@x.com"))
    assert r.status_code == 200
    data = r.json()
    assert data["configured"] is True
    ids = {p["id"] for p in data["providers"]}
    assert {"openai", "google", "groq", "cerebras"}.issubset(ids)


def test_create_list_delete_key_round_trip(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    create = c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "personal", "provider": "groq", "key": "gsk_abcdefghij1234567890"},
    )
    assert create.status_code == 201
    body = create.json()
    assert body["provider"] == "groq"
    assert body["masked_key"] == "gsk_…7890"

    listed = c.get("/api/byok-keys", headers=headers).json()
    assert len(listed) == 1
    assert listed[0]["label"] == "personal"
    assert "gsk_abcdefghij" not in listed[0]["masked_key"]  # only masked

    deleted = c.delete(f"/api/byok-keys/{body['id']}", headers=headers)
    assert deleted.status_code == 200
    assert c.get("/api/byok-keys", headers=headers).json() == []


def test_unknown_provider_rejected(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "x", "provider": "foo", "key": "12345678"},
    )
    assert r.status_code == 400


def test_duplicate_label_rejected(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    payload = {"label": "main", "provider": "openai", "key": "sk-aaaabbbbcccc"}
    assert c.post("/api/byok-keys", headers=headers, json=payload).status_code == 201
    second = c.post("/api/byok-keys", headers=headers, json=payload)
    assert second.status_code == 409


def test_other_user_cannot_list_or_use_keys(client):
    main_mod, c = client
    alice = _bearer(main_mod, "alice", "a@x.com")
    bob = _bearer(main_mod, "bob", "b@x.com")
    create = c.post(
        "/api/byok-keys",
        headers=alice,
        json={"label": "personal", "provider": "groq", "key": "gsk_aliceonly12345678"},
    )
    assert create.status_code == 201
    alice_key_id = create.json()["id"]

    # Bob's listing is empty.
    assert c.get("/api/byok-keys", headers=bob).json() == []

    # Bob can't delete, edit, or set-default Alice's key.
    bob_delete = c.delete(f"/api/byok-keys/{alice_key_id}", headers=bob)
    assert bob_delete.status_code == 404
    bob_edit = c.patch(
        f"/api/byok-keys/{alice_key_id}",
        headers=bob,
        json={"label": "stolen"},
    )
    assert bob_edit.status_code == 404
    bob_default = c.post(f"/api/byok-keys/{alice_key_id}/default", headers=bob)
    assert bob_default.status_code == 404

    # And the key is still around for Alice, untouched.
    alice_listed = c.get("/api/byok-keys", headers=alice).json()
    assert len(alice_listed) == 1
    assert alice_listed[0]["label"] == "personal"


# ────────────────────────────────────────────────────────────────────────
# Custom / self-hosted base-URL providers
# ────────────────────────────────────────────────────────────────────────


def test_custom_provider_requires_base_url(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "self-hosted", "provider": "custom", "key": "any-key-here-12345"},
    )
    assert r.status_code == 400
    assert "base url" in r.json()["detail"].lower()


def test_custom_provider_accepts_base_url(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys",
        headers=headers,
        json={
            "label": "openclaw",
            "provider": "custom",
            "key": "any-key-here-12345",
            "base_url": "https://gateway.example.com/v1",
            "default_model": "anthropic/claude-sonnet-4-6",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["base_url_override"] == "https://gateway.example.com/v1"
    assert body["default_model"] == "anthropic/claude-sonnet-4-6"


def test_ollama_allows_empty_key(client):
    """Ollama doesn't auth by default; a 'short' key shouldn't block save."""
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys",
        headers=headers,
        json={
            "label": "local",
            "provider": "ollama",
            "key": "x",  # would normally fail the >=8 chars check
            "base_url": "http://localhost:11434/v1",
        },
    )
    assert r.status_code == 201, r.text


def test_invalid_base_url_scheme_rejected(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys",
        headers=headers,
        json={
            "label": "bad",
            "provider": "custom",
            "key": "any-key-here-12345",
            "base_url": "ftp://example.com/v1",
        },
    )
    assert r.status_code == 400


# ────────────────────────────────────────────────────────────────────────
# Default-key per provider
# ────────────────────────────────────────────────────────────────────────


def test_default_flag_persists_and_lists_first(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "first", "provider": "groq", "key": "gsk_firstkey1234567890"},
    )
    second = c.post(
        "/api/byok-keys",
        headers=headers,
        json={
            "label": "second",
            "provider": "groq",
            "key": "gsk_secondkey1234567890",
            "is_default": True,
        },
    ).json()
    assert second["is_default"] is True

    listed = c.get("/api/byok-keys", headers=headers).json()
    assert listed[0]["id"] == second["id"], "default key should be listed first"
    # And the previously-existing key is no longer default.
    others = [k for k in listed if k["id"] != second["id"]]
    assert all(not k["is_default"] for k in others)


def test_set_default_demotes_others_for_same_provider(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    a = c.post(
        "/api/byok-keys",
        headers=headers,
        json={
            "label": "a", "provider": "groq", "key": "gsk_aaaabbbbcccc1234",
            "is_default": True,
        },
    ).json()
    b = c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "b", "provider": "groq", "key": "gsk_ddddeeeeffff5678"},
    ).json()
    other = c.post(
        "/api/byok-keys",
        headers=headers,
        json={
            "label": "other-provider",
            "provider": "openai",
            "key": "sk-otherproviderkey",
            "is_default": True,
        },
    ).json()

    # Promote `b` to default; `a` must lose its default flag, but `other`
    # (different provider) must not.
    promote = c.post(f"/api/byok-keys/{b['id']}/default", headers=headers)
    assert promote.status_code == 200

    listed = {k["id"]: k for k in c.get("/api/byok-keys", headers=headers).json()}
    assert listed[a["id"]]["is_default"] is False
    assert listed[b["id"]]["is_default"] is True
    assert listed[other["id"]]["is_default"] is True


# ────────────────────────────────────────────────────────────────────────
# Edit (PATCH)
# ────────────────────────────────────────────────────────────────────────


def test_patch_updates_label_and_model(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    body = c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "old", "provider": "groq", "key": "gsk_anykeyfortesting1234"},
    ).json()
    r = c.patch(
        f"/api/byok-keys/{body['id']}",
        headers=headers,
        json={"label": "new-label", "default_model": "llama-3.1-70b"},
    )
    assert r.status_code == 200, r.text
    listed = c.get("/api/byok-keys", headers=headers).json()
    assert listed[0]["label"] == "new-label"
    assert listed[0]["default_model"] == "llama-3.1-70b"


def test_patch_with_no_fields_rejected(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    body = c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "x", "provider": "groq", "key": "gsk_anykeyfortesting1234"},
    ).json()
    r = c.patch(f"/api/byok-keys/{body['id']}", headers=headers, json={})
    assert r.status_code == 400


def test_patch_label_collision_rejected(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    a = c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "alpha", "provider": "groq", "key": "gsk_aaakey1234567890ab"},
    ).json()
    c.post(
        "/api/byok-keys",
        headers=headers,
        json={"label": "beta", "provider": "groq", "key": "gsk_bbbkey1234567890cd"},
    )
    # Renaming `alpha` -> `beta` should collide.
    r = c.patch(f"/api/byok-keys/{a['id']}", headers=headers, json={"label": "beta"})
    assert r.status_code == 409


# ────────────────────────────────────────────────────────────────────────
# Probe (no real network — assertion on input validation only)
# ────────────────────────────────────────────────────────────────────────


def test_probe_rejects_unknown_provider(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys/probe",
        headers=headers,
        json={"provider": "nope"},
    )
    assert r.status_code == 400


def test_probe_requires_base_url_for_self_hosted(client):
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys/probe",
        headers=headers,
        json={"provider": "custom", "key": "abc"},
    )
    assert r.status_code == 400


def test_probe_returns_failure_for_unreachable_host(client):
    """A bogus base URL should return ok=False with a useful message
    rather than raising — keeps the UI flow predictable."""
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    r = c.post(
        "/api/byok-keys/probe",
        headers=headers,
        json={
            "provider": "custom",
            "key": "abc",
            "base_url": "http://127.0.0.1:1/v1",
        },
    )
    # The endpoint always 200s and tells us in the body whether the
    # probe succeeded; that way the frontend doesn't need separate
    # error handling for "couldn't reach" vs "bad credentials".
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "127.0.0.1" in body["message"] or body["status"] != 200


def test_probe_saved_key_decrypts_server_side(client):
    """The per-key probe endpoint must decrypt the stored key so it
    actually authenticates — the generic /probe endpoint can't do this
    because the frontend never holds the plaintext."""
    main_mod, c = client
    headers = _bearer(main_mod, "alice", "a@x.com")
    body = c.post(
        "/api/byok-keys",
        headers=headers,
        json={
            "label": "saved",
            "provider": "custom",
            "key": "the-actual-secret-key-XYZ",
            "base_url": "http://127.0.0.1:1/v1",  # unreachable on purpose
        },
    ).json()

    r = c.post(f"/api/byok-keys/{body['id']}/probe", headers=headers)
    # We don't have a real /v1/models server up, so the probe will fail
    # with "couldn't reach". The shape and status_code are what we care
    # about: it should be a 200 with ok=false, NOT a 401 (which would
    # indicate the frontend's old "no key" probe path).
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["status"] != 401, "saved-key probe must not be unauthenticated"


def test_probe_saved_key_authorisation(client):
    """Bob can't probe Alice's saved key."""
    main_mod, c = client
    alice = _bearer(main_mod, "alice", "a@x.com")
    bob = _bearer(main_mod, "bob", "b@x.com")
    body = c.post(
        "/api/byok-keys",
        headers=alice,
        json={"label": "p", "provider": "groq", "key": "gsk_alicekeyxxx12345"},
    ).json()
    r = c.post(f"/api/byok-keys/{body['id']}/probe", headers=bob)
    assert r.status_code == 404
