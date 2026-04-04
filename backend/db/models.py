# backend/db/models.py

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path("backend/db/professors.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # dict-like access
    conn.execute("PRAGMA journal_mode=WAL")  # better concurrent reads
    return conn


def init_db():
    """Create tables if they don't exist. Call once on startup."""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS professors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            name_normalized TEXT NOT NULL,
            department TEXT,
            rmp_quality REAL,
            rmp_difficulty REAL,
            rmp_would_take_again REAL,
            rmp_num_ratings INTEGER DEFAULT 0,
            rmp_tags TEXT,
            found INTEGER DEFAULT 1,
            error TEXT,
            last_scraped TIMESTAMP NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_prof_name
        ON professors(name_normalized)
    """)
    conn.commit()
    conn.close()


def normalize_name(name: str) -> str:
    """
    Normalize for cache lookups.
    'Gillespie, Gary' and 'Gary Gillespie' should both hit cache.
    """
    # Lowercase, strip extra whitespace
    name = name.lower().strip()
    # Handle 'Last, First' format common in Schedule of Classes
    if "," in name:
        parts = [p.strip() for p in name.split(",", 1)]
        name = f"{parts[1]} {parts[0]}"
    return name


def get_cached_professor(
    name: str,
    max_age_days: int = 30,
) -> dict | None:
    """
    Check cache. Returns the row if it exists and is fresh enough.
    Returns None if not cached or stale.
    """
    conn = get_db()
    row = conn.execute(
        """
        SELECT * FROM professors
        WHERE name_normalized = ?
        ORDER BY last_scraped DESC
        LIMIT 1
        """,
        (normalize_name(name),),
    ).fetchone()
    conn.close()

    if row is None:
        return None

    last_scraped = datetime.fromisoformat(row["last_scraped"])
    if datetime.now() - last_scraped > timedelta(days=max_age_days):
        return None  # stale, needs re-scrape

    return dict(row)


def save_professor(rating) -> None:
    """Save a ProfessorRating to the cache."""
    import json

    conn = get_db()
    conn.execute(
        """
        INSERT INTO professors
        (name, name_normalized, department, rmp_quality, rmp_difficulty,
         rmp_would_take_again, rmp_num_ratings, rmp_tags, found, error,
         last_scraped)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            rating.name,
            normalize_name(rating.name),
            rating.department,
            rating.overall_quality,
            rating.difficulty,
            rating.would_take_again,
            rating.num_ratings,
            json.dumps(rating.top_tags),
            1 if rating.found else 0,
            rating.error,
            datetime.now().isoformat(),
        ),
    )
    conn.commit()
    conn.close()