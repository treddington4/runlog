"""Ephemeral demo login (Phase 11.1-11.3). Gated entirely behind ENABLE_DEMO_LOGIN —
when unset/false, is_enabled() is False, /auth/demo/login 404s, and nothing else in
this module is ever reached from a real request. Meant for a separate, disposable
cloud deployment (Phase 11.4's Render template) with its own throwaway SQLite
volume — never intended to run alongside a real user's own production data.

Teardown relies on real DB-level ON DELETE CASCADE (see models.py's per-user tables'
`ForeignKey("users.id", ondelete="CASCADE")` + the PRAGMA foreign_keys=ON connect
event) — deleting the User row is enough for every table that carries a user_id FK.
sync_meta is the one exception (a flat key-value store with no user_id column at all;
per-user scoping is baked into the key string via user_key()) and needs its own
explicit cleanup here.
"""
import hashlib
import os
import random
import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone

from models import SessionLocal, User, ApiToken, SyncMeta
import seed_engine

ENABLE_DEMO_LOGIN = os.environ.get("ENABLE_DEMO_LOGIN", "false").lower() == "true"
DEMO_CAPACITY = int(os.environ.get("DEMO_CAPACITY", "5"))
DEMO_SESSION_HOURS = float(os.environ.get("DEMO_SESSION_HOURS", "2"))

_capacity_lock = threading.Lock()

_MOCK_CHAT_REPLIES = [
    "Nice work getting out there. Your recent mileage looks steady — keep stacking "
    "easy days and the fitness will follow.",
    "That effort fits right in with your last few weeks. I'd keep the next couple "
    "of runs easy and save the harder effort for later this week.",
    "Solid. Your training's trending in a good direction — consistency matters more "
    "than any single run.",
    "Good session. Make sure you're getting enough recovery between the harder "
    "efforts so the adaptation actually sticks.",
    "This is a demo account, so I'm working from synthetic data — but that's the "
    "kind of grounded, specific reply the real Coach gives from your actual history.",
]


def is_enabled() -> bool:
    return ENABLE_DEMO_LOGIN


def is_demo_user(db, user_id: str) -> bool:
    user = db.get(User, user_id)
    return bool(user and user.is_demo)


def mock_chat_reply(message: str) -> str:  # noqa: ARG001 — message unused, canned response
    return random.choice(_MOCK_CHAT_REPLIES)


def create_demo_session(db) -> dict:
    """Raises ValueError("capacity_full") if at/over DEMO_CAPACITY concurrent demo
    users. Seeding runs synchronously (seed_engine does zero external I/O, so it's
    fast) rather than as a background task — avoids a visitor landing on an empty
    Home tab before seeding finishes."""
    with _capacity_lock:
        active = db.query(User).filter(User.is_demo == True).count()  # noqa: E712
        if active >= DEMO_CAPACITY:
            raise ValueError("capacity_full")
        user_id = f"demo_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(hours=DEMO_SESSION_HOURS)
        db.add(User(
            id=user_id, is_demo=True, expires_at=expires_at.isoformat(),
            created_at=now.isoformat(),
        ))
        # This codebase deliberately never declares SQLAlchemy relationship()s (see
        # models.py) — without one, the unit-of-work has no ordering edge between the
        # User and ApiToken mappers, so a single flush can emit the ApiToken INSERT
        # before the User INSERT and trip the real ON DELETE CASCADE FK constraint on
        # a fresh (FK-enforcing) database. Force the parent row to flush first.
        db.flush()
        raw_token = secrets.token_urlsafe(32)
        db.add(ApiToken(
            id=f"tok_{uuid.uuid4().hex[:12]}", user_id=user_id,
            token_hash=hashlib.sha256(raw_token.encode()).hexdigest(),
            name="demo session", created_at=now.isoformat(),
        ))
        db.commit()

    seed_engine.seed_demo_user(db, user_id)
    return {"token": raw_token, "userId": user_id, "expiresAt": expires_at.isoformat()}


def delete_demo_user(db, user_id: str) -> None:
    """FK cascade (ON DELETE CASCADE) handles every real per-user table automatically
    once the User row is gone — sync_meta is the one exception, see module docstring."""
    db.query(SyncMeta).filter(SyncMeta.key.like(f"u:{user_id}:%")).delete(synchronize_session=False)
    user = db.get(User, user_id)
    if user:
        db.delete(user)
    db.commit()


def sweep_expired_demo_users() -> int:
    """Called periodically (main.py's scheduler) to catch users who close the tab
    without hitting /auth/demo/logout. Returns how many were swept."""
    db = SessionLocal()
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        expired = db.query(User).filter(User.is_demo == True, User.expires_at < now_iso).all()  # noqa: E712
        for user in expired:
            delete_demo_user(db, user.id)
        return len(expired)
    finally:
        db.close()
