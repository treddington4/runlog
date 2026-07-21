"""Web Push (PWA push notifications, Phase 0.11). Optional — degrades cleanly when
unconfigured (no VAPID keypair set), matching assistant.py's is_configured() pattern
for the Chat tab's Claude Pro/Max/API key setup.

send_push() is the one shared entrypoint any future feature that wants to notify a
user should call — same "single computation core, no duplicate implementation"
discipline as stats.py. Nothing calls it yet: Phase 0.11's own checklist names two
triggers (daily insight, generated workout) that don't exist as features yet, so
there's nothing real to wire up. The one real caller today is the manual "send test
notification" action, which exists specifically to verify the plumbing end-to-end
without waiting on those other features.
"""
import os
import json
import logging
import uuid
from datetime import datetime, timezone

from pywebpush import webpush, WebPushException

from models import PushSubscription

log = logging.getLogger("runlog")

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_CLAIMS_EMAIL = os.environ.get("VAPID_CLAIMS_EMAIL", "mailto:admin@example.com")


def is_configured() -> bool:
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)


def subscribe(db, user_id: str, endpoint: str, p256dh: str, auth_key: str) -> None:
    """Re-subscribing the same browser (e.g. after a permission reset) reuses the row —
    endpoint is unique, so this is an upsert keyed on it rather than always inserting."""
    existing = db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).first()
    if existing:
        existing.user_id = user_id
        existing.p256dh = p256dh
        existing.auth = auth_key
    else:
        db.add(PushSubscription(
            id=f"push_{uuid.uuid4().hex[:12]}", user_id=user_id, endpoint=endpoint,
            p256dh=p256dh, auth=auth_key, created_at=datetime.now(timezone.utc).isoformat(),
        ))
    db.commit()


def unsubscribe(db, user_id: str, endpoint: str) -> None:
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == endpoint, PushSubscription.user_id == user_id,
    ).delete()
    db.commit()


def send_push(db, user_id: str, title: str, body: str, url: str = "/") -> int:
    """Sends to every subscription this user has registered (multiple devices is the
    normal case). Returns how many sends succeeded. A subscription the push service
    reports as gone (410 Gone, or 404 for some services) is pruned immediately —
    same "don't keep dead state around" discipline used elsewhere in this codebase
    (e.g. revoked ApiTokens), rather than letting failed sends silently repeat forever.
    Catches broadly (not just WebPushException) per subscription — an unreachable
    endpoint or a transient network error raises a plain requests exception, not a
    WebPushException, and one bad/stale subscription must never block delivery to
    this user's other devices or 500 the whole request."""
    if not is_configured():
        return 0
    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
    payload = json.dumps({"title": title, "body": body, "url": url})
    sent = 0
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_CLAIMS_EMAIL},
            )
            sent += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                db.delete(sub)
            else:
                log.warning("push send failed (endpoint=%s): %s", sub.endpoint, e)
        except Exception as e:
            log.warning("push send failed (endpoint=%s): %s", sub.endpoint, e)
    db.commit()
    return sent
