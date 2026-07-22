"""Auth middleware (Phase 1.3). A single FastAPI dependency, `current_user_id()`,
that every endpoint will eventually depend on instead of hardcoding
`DEFAULT_USER_ID` (see Phase 1.4 for that threading pass — this module doesn't
change any endpoint's behavior by itself).

Three outcomes, controlled by the `AUTH_MODE` env var:
  - `"disabled"` (default): always returns `DEFAULT_USER_ID` — zero behavior
    change from today's single-user reality; every deployment stays on this
    until real login is actually configured.
  - `X-Api-Token` header present: looked up by its SHA-256 hash against
    `ApiToken` (Phase 1.2), `last_used_at` stamped on success.
  - `Authorization: Bearer <jwt>` header present: validated against an external
    OIDC provider (`OIDC_ISSUER`/`OIDC_AUDIENCE`/`OIDC_JWKS_URL` env vars), a
    `User` row auto-provisioned on first valid `sub` claim.
Anything else when `AUTH_MODE` isn't `"disabled"` -> 401.
"""
import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone

import jwt
import requests
from fastapi import Header, HTTPException

from .models import SessionLocal, User, ApiToken, DEFAULT_USER_ID

AUTH_MODE = os.environ.get("AUTH_MODE", "disabled")
OIDC_ISSUER = os.environ.get("OIDC_ISSUER", "")
OIDC_AUDIENCE = os.environ.get("OIDC_AUDIENCE", "")
OIDC_JWKS_URL = os.environ.get("OIDC_JWKS_URL", "")

JWKS_CACHE_TTL_SEC = 3600
_jwks_cache: dict = {"keys": None, "fetched_at": 0.0}


def _get_jwks(force: bool = False) -> list:
    """Cached JWKS fetch — refetched at most once an hour (or immediately if `force`,
    used when a token's `kid` isn't found in the current cache, e.g. right after the
    IdP rotates its signing keys) rather than hitting the IdP on every request."""
    now = time.monotonic()
    if force or _jwks_cache["keys"] is None or (now - _jwks_cache["fetched_at"]) > JWKS_CACHE_TTL_SEC:
        resp = requests.get(OIDC_JWKS_URL, timeout=10)
        resp.raise_for_status()
        _jwks_cache["keys"] = resp.json()["keys"]
        _jwks_cache["fetched_at"] = now
    return _jwks_cache["keys"]


def _verify_oidc_jwt(token: str) -> str:
    """Returns the token's `sub` claim once its signature, issuer, and audience are
    all confirmed valid; raises HTTPException(401) otherwise."""
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Malformed token: {e}")

    jwk = next((k for k in _get_jwks() if k.get("kid") == kid), None)
    if jwk is None:
        jwk = next((k for k in _get_jwks(force=True) if k.get("kid") == kid), None)
    if jwk is None:
        raise HTTPException(401, "Unknown signing key")

    try:
        public_key = jwt.PyJWK.from_json(json.dumps(jwk)).key
        payload = jwt.decode(
            token, key=public_key, algorithms=[jwk.get("alg", "RS256")],
            audience=OIDC_AUDIENCE, issuer=OIDC_ISSUER,
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid token: {e}")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(401, "Token missing sub claim")
    return sub


def _get_or_create_user_by_oidc_sub(sub: str) -> str:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.oidc_subject == sub).first()
        if user:
            return user.id
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        db.add(User(id=user_id, oidc_subject=sub, created_at=datetime.now(timezone.utc).isoformat()))
        db.commit()
        return user_id
    finally:
        db.close()


def _verify_api_token(token: str) -> str:
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    db = SessionLocal()
    try:
        row = db.query(ApiToken).filter(ApiToken.token_hash == token_hash).first()
        if not row:
            raise HTTPException(401, "Invalid API token")
        row.last_used_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        return row.user_id
    finally:
        db.close()


async def current_user_id(
    authorization: str | None = Header(default=None),
    x_api_token: str | None = Header(default=None, alias="X-Api-Token"),
) -> str:
    if AUTH_MODE == "disabled":
        return DEFAULT_USER_ID

    if x_api_token:
        return _verify_api_token(x_api_token)

    if authorization and authorization.startswith("Bearer "):
        token = authorization[len("Bearer "):]
        sub = _verify_oidc_jwt(token)
        return _get_or_create_user_by_oidc_sub(sub)

    raise HTTPException(401, "Authentication required")
