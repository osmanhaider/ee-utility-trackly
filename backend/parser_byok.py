"""
Bring-your-own-key (BYOK) invoice parser.

Resolves the user's saved API key, decrypts it, and sends the locally-extracted
bill text directly to whichever OpenAI-compatible provider they configured.
"""
from __future__ import annotations

from byok import PROVIDERS, ByokError
from parser import extract_bill_text
from parser_openai_compat import call_openai_compat_chat


def parse_bill_with_byok(
    file_path: str,
    *,
    provider_id: str,
    api_key: str,
    model: str | None = None,
    base_url_override: str | None = None,
) -> dict:
    provider = PROVIDERS.get(provider_id)
    if provider is None:
        raise ByokError(f"Unknown BYOK provider: {provider_id!r}")

    chosen_model = model or provider.default_model
    if not chosen_model:
        raise ByokError(
            "No model specified — set a default model on the saved key, or "
            "pass one in the upload form."
        )

    # User-supplied URL wins; falls back to the provider preset for the
    # well-known endpoints. `custom` and `ollama` presets ship with an
    # empty preset URL so the override is mandatory there.
    base_url = (base_url_override or provider.base_url or "").rstrip("/")
    if not base_url:
        raise ByokError(
            f"{provider.name} requires a base URL — edit the key in Settings."
        )

    extracted = extract_bill_text(file_path)
    invoice_text = extracted.text.strip()
    if len(invoice_text) < 20:
        raise RuntimeError(
            "Local text extraction produced too little text to send to your provider."
        )

    parsed, _headers = call_openai_compat_chat(
        invoice_text,
        base_url=base_url,
        api_key=api_key,
        model=chosen_model,
        source_name=provider.name,
    )
    parsed["_source"] = f"byok:{provider.id}"
    parsed["_text_source"] = extracted.source
    parsed["_model_used"] = chosen_model
    parsed["_routed_via"] = f"{provider.id}/{chosen_model}"
    return parsed
