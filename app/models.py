"""Database models. SQLite file lives at /data/runlog.db (mounted volume)."""
from sqlalchemy import create_engine, Column, String, Float, Integer, Boolean, Text
from sqlalchemy.orm import declarative_base, sessionmaker
import os

DB_PATH = os.environ.get("DB_PATH", "/data/runlog.db")
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class Run(Base):
    __tablename__ = "runs"

    id = Column(String, primary_key=True)  # e.g. "strava_19268494216" or "garmin_..."
    source = Column(String)                # "strava" | "garmin"
    date = Column(String)                  # YYYY-MM-DD
    start_time = Column(String)            # HH:MM local
    name = Column(String)
    distance_mi = Column(Float)
    moving_time_sec = Column(Integer)
    elev_gain_ft = Column(Float)
    avg_hr = Column(Integer, nullable=True)
    max_hr = Column(Integer, nullable=True)
    avg_cadence = Column(Float, nullable=True)   # true steps/min (already doubled)
    avg_pace_sec_per_mi = Column(Float)
    is_treadmill = Column(Boolean, default=False)
    temp_f = Column(Float, nullable=True)
    weather_condition = Column(String, nullable=True)
    heat_index_f = Column(Float, nullable=True)
    wet_bulb_f = Column(Float, nullable=True)
    suggested_type = Column(String, default="Easy")
    type_override = Column(String, nullable=True)
    rpe = Column(Integer, nullable=True)
    notes = Column(Text, nullable=True)
    splits_json = Column(Text, default="[]")      # JSON string: list of per-mile splits
    intervals_json = Column(Text, default="[]")   # JSON string: list of raw interval reps


class OAuthToken(Base):
    __tablename__ = "oauth_tokens"

    provider = Column(String, primary_key=True)  # "strava"
    access_token = Column(String)
    refresh_token = Column(String)
    expires_at = Column(Integer)  # unix timestamp


class SyncMeta(Base):
    __tablename__ = "sync_meta"

    key = Column(String, primary_key=True)
    value = Column(String)


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    Base.metadata.create_all(engine)
    _migrate_add_missing_columns()


def _migrate_add_missing_columns():
    """SQLAlchemy's create_all() only creates tables that don't exist yet — it
    won't add new columns to a table that's already there. Since this project
    has no migration framework, patch that gap with a plain ALTER TABLE for
    any model column SQLite doesn't have yet."""
    with engine.connect() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(runs)")}
        for col in Run.__table__.columns:
            if col.name not in existing:
                col_type = "TEXT" if isinstance(col.type, (String, Text)) else \
                    "INTEGER" if isinstance(col.type, (Integer, Boolean)) else "REAL"
                conn.exec_driver_sql(f"ALTER TABLE runs ADD COLUMN {col.name} {col_type}")
        conn.commit()
