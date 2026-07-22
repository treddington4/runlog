"""Dashboard summary (real computed stats, no LLM involved) — cache-first, backed by
stats.dashboard_summary()/stats.refresh_dashboard_cache() (see stats.py's dashboard-cache
section, populated by every sync path via stats.record_sync)."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from ..models import SessionLocal, get_sync_meta, set_sync_meta, user_key
from ..accounts import auth
from .. import stats

router = APIRouter()


@router.get("/api/dashboard/summary")
def dashboard_summary(user_id: str = Depends(auth.current_user_id)):
    cached = get_sync_meta(user_key(user_id, stats.DASHBOARD_CACHE_KEY))
    if cached:
        try:
            return json.loads(cached)
        except (TypeError, ValueError):
            pass  # corrupt cache entry — fall through to live compute below
    # Cache miss (fresh install, or the cache write never ran yet) — compute live once
    # and populate the cache so every subsequent load is a plain lookup.
    db = SessionLocal()
    try:
        summary = stats.dashboard_summary(db, user_id=user_id)
    finally:
        db.close()
    set_sync_meta(user_key(user_id, stats.DASHBOARD_CACHE_KEY), json.dumps(summary))
    set_sync_meta(user_key(user_id, stats.DASHBOARD_CACHE_UPDATED_AT_KEY), datetime.now(timezone.utc).isoformat())
    return summary
