"""SQLite database schema, connection helpers, and queries."""

import os
import sqlite3

LIBRARY_DIR = os.path.join(os.getcwd(), '.library')
DB_PATH = os.path.join(LIBRARY_DIR, 'library.db')


def get_connection():
    """Get a SQLite connection with row factory."""
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create tables if they don't exist."""
    conn = get_connection()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS folders (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            path        TEXT NOT NULL UNIQUE,
            image_count INTEGER DEFAULT 0,
            imported_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS images (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id      INTEGER NOT NULL REFERENCES folders(id),
            filename       TEXT NOT NULL,
            filepath       TEXT NOT NULL,
            thumbnail_path TEXT,
            width          INTEGER,
            height         INTEGER,
            file_size      INTEGER,
            inode          INTEGER,
            sort_order     INTEGER,
            status         TEXT DEFAULT 'active',
            created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            modified_at    TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(folder_id, filename)
        );

        CREATE TABLE IF NOT EXISTS culling_sessions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id       INTEGER NOT NULL REFERENCES folders(id),
            image_ids       TEXT NOT NULL,
            picked_image_id INTEGER REFERENCES images(id),
            status          TEXT DEFAULT 'active',
            created_at      TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS ocr_results (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id           INTEGER NOT NULL UNIQUE REFERENCES images(id),
            tag                TEXT,
            scale_weight       REAL,
            handwritten_weight REAL,
            status             TEXT DEFAULT 'pending',
            raw_output         TEXT,
            error_message      TEXT,
            processed_at       TEXT,
            created_at         TEXT DEFAULT CURRENT_TIMESTAMP
        );
    """)
    conn.commit()

    # Migrations — add columns that may not exist yet
    try:
        conn.execute("ALTER TABLE folders ADD COLUMN weight_unit TEXT DEFAULT 'kg'")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # Column already exists

    try:
        conn.execute("ALTER TABLE folders ADD COLUMN ocr_roi TEXT DEFAULT NULL")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # Column already exists

    try:
        conn.execute("ALTER TABLE folders ADD COLUMN manual_reviewed BOOLEAN DEFAULT FALSE")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # Column already exists

    try:
        conn.execute("ALTER TABLE ocr_results ADD COLUMN item TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # Column already exists

    try:
        conn.execute("ALTER TABLE images ADD COLUMN original_filename TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # Column already exists

    # Backfill original_filename from current filename (strip extension)
    rows = conn.execute(
        "SELECT id, filename FROM images WHERE original_filename IS NULL"
    ).fetchall()
    if rows:
        for row in rows:
            base = os.path.splitext(row['filename'])[0]
            conn.execute(
                "UPDATE images SET original_filename = ? WHERE id = ?",
                (base, row['id'])
            )
        conn.commit()

    conn.close()


def row_to_dict(row):
    """Convert a sqlite3.Row to a dict."""
    if row is None:
        return None
    return dict(row)


def rows_to_dicts(rows):
    """Convert a list of sqlite3.Row to a list of dicts."""
    return [dict(r) for r in rows]
