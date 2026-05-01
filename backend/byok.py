"""
Bring-your-own-key (BYOK) support.

Each signed-in user can store API keys for OpenAI-compatible providers.
We encrypt at rest with AES-256-GCM using a server-side key from the
`BYOK_ENCRYPTION_KEY` env var, expose a strict allowlist of providers,
and never return plaintext to the frontend.
"""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    base_url: str
    default_model: str
    key_hint: str
    key_url: str
    # When True, the user must supply a base URL when adding a key with
    # this provider (e.g. self-hosted Ollama / OpenClaw / any custom
    # OpenAI-compatible gateway). The presets below leave this False
    # since their endpoints are well-known.
    requires_base_url: bool = False
    # When True, the provider's `/v1/models` endpoint is publicly
    # reachable without authentication, so the probe button can talk to
    # it without a key. Useful for local Ollama (no auth by default).
    allows_empty_key: bool = False


PROVIDERS: Final[dict[str, Provider]] = {
    p.id: p for p in [
        Provider(
            id="openai",
            name="OpenAI",
            base_url="https://api.openai.com/v1",
            default_model="gpt-4o-mini",
            key_hint="Starts with sk-",
            key_url="https://platform.openai.com/api-keys",
        ),
        Provider(
            id="google",
            name="Google (Gemini)",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai",
            default_model="gemini-2.5-flash",
            key_hint="Starts with AIzaSy",
            key_url="https://aistudio.google.com/app/apikey",
        ),
        Provider(
            id="groq",
            name="Groq",
            base_url="https://api.groq.com/openai/v1",
            default_model="llama-3.3-70b-versatile",
            key_hint="Starts with gsk_",
            key_url="https://console.groq.com/keys",
        ),
        Provider(
            id="cerebras",
            name="Cerebras",
            base_url="https://api.cerebras.ai/v1",
            default_model="llama-3.3-70b",
            key_hint="Starts with csk-",
            key_url="https://cloud.cerebras.ai/platform/keys",
        ),
        Provider(
            id="mistral",
            name="Mistral",
            base_url="https://api.mistral.ai/v1",
            default_model="mistral-small-latest",
            key_hint="Mistral API key",
            key_url="https://console.mistral.ai/api-keys/",
        ),
        Provider(
            id="openrouter",
            name="OpenRouter",
            base_url="https://openrouter.ai/api/v1",
            default_model="google/gemini-2.0-flash-exp:free",
            key_hint="Starts with sk-or-v1-",
            key_url="https://openrouter.ai/keys",
        ),
        Provider(
            id="together",
            name="Together AI",
            base_url="https://api.together.xyz/v1",
            default_model="meta-llama/Llama-3.3-70B-Instruct-Turbo",
            key_hint="Together AI key",
            key_url="https://api.together.ai/settings/api-keys",
        ),
        Provider(
            id="fireworks",
            name="Fireworks AI",
            base_url="https://api.fireworks.ai/inference/v1",
            default_model="accounts/fireworks/models/llama-v3p3-70b-instruct",
            key_hint="Starts with fw_",
            key_url="https://fireworks.ai/account/api-keys",
        ),
        Provider(
            id="nvidia",
            name="NVIDIA NIM",
            base_url="https://integrate.api.nvidia.com/v1",
            default_model="z-ai/glm4.7",
            key_hint="Starts with nvapi-",
            key_url="https://build.nvidia.com/settings/api-keys",
        ),
        Provider(
            id="ollama",
            name="Ollama (self-hosted)",
            base_url="",  # user-supplied; e.g. https://ollama.example.com/v1
            default_model="llama3.1:8b",
            key_hint="Often blank — Ollama doesn't auth by default",
            key_url="https://ollama.com/download",
            requires_base_url=True,
            allows_empty_key=True,
        ),
        Provider(
            id="custom",
            name="Custom (OpenAI-compatible)",
            base_url="",  # user-supplied
            default_model="",
            key_hint="API key for your endpoint",
            key_url="",
            requires_base_url=True,
        ),
    ]
}


class ByokError(Exception):
    """Raised when BYOK is misconfigured (missing/invalid encryption key)."""


def _load_encryption_key() -> bytes:
    """Decode the AES-256 key from env. Raises ByokError if missing/invalid.

    Accepts either base64 (preferred) or 64-char hex for ergonomics. Hex is
    detected first because a 64-char hex string is also valid base64 but
    decodes to the wrong length.
    """
    raw = os.environ.get("BYOK_ENCRYPTION_KEY", "").strip()
    if not raw:
        raise ByokError(
            "BYOK_ENCRYPTION_KEY is not set. Generate one with "
            "`python -c \"import secrets, base64; print(base64.b64encode(secrets.token_bytes(32)).decode())\"` "
            "and set it as an env var."
        )
    key: bytes | None = None
    if len(raw) == 64 and all(c in "0123456789abcdefABCDEF" for c in raw):
        try:
            key = bytes.fromhex(raw)
        except ValueError:
            key = None
    if key is None:
        try:
            key = base64.b64decode(raw, validate=True)
        except Exception as e:
            raise ByokError(
                "BYOK_ENCRYPTION_KEY must be base64- or hex-encoded 32 bytes."
            ) from e
    if len(key) != 32:
        raise ByokError(
            f"BYOK_ENCRYPTION_KEY must decode to exactly 32 bytes, got {len(key)}."
        )
    return key


_cached_key: bytes | None = None


def _key() -> bytes:
    """Lazy, cached so the env-var check happens at first use, not at import.
    Reset by calling `reset_encryption_key_cache()` (used in tests)."""
    global _cached_key
    if _cached_key is None:
        _cached_key = _load_encryption_key()
    return _cached_key


def reset_encryption_key_cache() -> None:
    global _cached_key
    _cached_key = None


def is_configured() -> bool:
    try:
        _key()
        return True
    except ByokError:
        return False


def encrypt(plaintext: str) -> tuple[str, str, str]:
    """Returns base64-encoded (ciphertext, iv, auth_tag)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aesgcm = AESGCM(_key())
    iv = os.urandom(12)  # 96-bit IV recommended for GCM
    ct_with_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), associated_data=None)
    # AESGCM appends a 16-byte tag to the ciphertext. Split for storage parity
    # with the FreeLLMAPI dashboard schema (encrypted_key, iv, tag).
    ct, tag = ct_with_tag[:-16], ct_with_tag[-16:]
    return (
        base64.b64encode(ct).decode("ascii"),
        base64.b64encode(iv).decode("ascii"),
        base64.b64encode(tag).decode("ascii"),
    )


def decrypt(ciphertext_b64: str, iv_b64: str, tag_b64: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aesgcm = AESGCM(_key())
    ct = base64.b64decode(ciphertext_b64)
    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    plaintext = aesgcm.decrypt(iv, ct + tag, associated_data=None)
    return plaintext.decode("utf-8")


def mask_key(plaintext: str) -> str:
    """Show only the first 4 and last 4 chars so the user can recognise their
    own key without exposing it. Falls back to a generic mask for very short
    keys (which would otherwise show too much)."""
    if len(plaintext) <= 8:
        return "•" * 8
    return f"{plaintext[:4]}…{plaintext[-4:]}"
