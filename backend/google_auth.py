"""Google ID token verification.

Wraps `google.oauth2.id_token.verify_oauth2_token` so the rest of the app
can stay agnostic of Google's SDK shape. Also enforces an optional
`ALLOWED_EMAILS` allowlist so a public Render deployment can't be signed
into by anyone with a Gmail account.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
ALLOWED_EMAILS = frozenset(
    e.strip().lower()
    for e in os.environ.get("ALLOWED_EMAILS", "").split(",")
    if e.strip()
)


class GoogleAuthError(Exception):
    pass


@dataclass(frozen=True)
class GoogleIdentity:
    sub: str
    email: str
    name: str | None
    picture: str | None


def verify_google_id_token(id_token_str: str) -> GoogleIdentity:
    """Validate the ID token's signature, audience, and email-verified claim."""
    if not GOOGLE_CLIENT_ID:
        raise GoogleAuthError("GOOGLE_CLIENT_ID is not configured on the server")

    # Lazy import keeps the rest of the app importable when google-auth is
    # not installed (e.g. during shared-utility-only test runs).
    from google.auth.transport import requests as g_requests
    from google.oauth2 import id_token as g_id_token

    try:
        payload = g_id_token.verify_oauth2_token(
            id_token_str,
            g_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except ValueError as e:
        raise GoogleAuthError(f"invalid Google ID token: {e}") from e

    if not payload.get("email_verified"):
        raise GoogleAuthError("Google account email is not verified")

    email = (payload.get("email") or "").lower()
    if not email:
        raise GoogleAuthError("Google ID token has no email claim")

    if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
        raise GoogleAuthError(f"{email} is not on the allowlist")

    sub = payload.get("sub")
    if not sub:
        raise GoogleAuthError("Google ID token has no sub claim")

    return GoogleIdentity(
        sub=str(sub),
        email=email,
        name=payload.get("name"),
        picture=payload.get("picture"),
    )
