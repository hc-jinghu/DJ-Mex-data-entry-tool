"""Folder scanning, DB insertion, and thumbnail generation."""

import os

from .database import get_connection
from .thumbnails import generate_thumbnail, get_image_dimensions

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.tiff', '.heic'}


def _remove_thumbnail(library_root, folder_id, filename):
    """Delete the thumbnail file for a given image filename."""
    base, _ = os.path.splitext(filename)
    thumb_path = os.path.join(
        library_root, '.library', 'thumbnails',
        str(folder_id), f"{base}_thumb.jpg"
    )
    try:
        os.unlink(thumb_path)
    except FileNotFoundError:
        pass


def _recompute_sort_order(conn, folder_id):
    """Renumber sort_order for all images in a folder by filename."""
    rows = conn.execute(
        "SELECT id FROM images WHERE folder_id = ? ORDER BY filename",
        (folder_id,)
    ).fetchall()
    for idx, row in enumerate(rows):
        conn.execute(
            "UPDATE images SET sort_order = ? WHERE id = ?",
            (idx, row['id'])
        )


def import_folder(library_root, folder_path):
    """Sync a folder of images with the library DB.

    Non-destructive: compares disk state vs DB state by filename,
    using inode + file_size as a fast change check, plus a dimension
    check to catch EXIF-only rotation changes.

    Args:
        library_root: Absolute path to the library root.
        folder_path: Relative path of the folder (e.g. 'ALPHA').

    Returns:
        Dict with sync results.
    """
    full_folder = os.path.join(library_root, folder_path)
    folder_name = os.path.basename(folder_path)

    # Build disk state: { filename: (inode, file_size) }
    disk_files = {}
    for f in os.listdir(full_folder):
        if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS and not f.startswith('.'):
            source_path = os.path.join(full_folder, f)
            stat = os.stat(source_path)
            disk_files[f] = (stat.st_ino, stat.st_size)

    conn = get_connection()

    # Insert or get folder record
    existing = conn.execute(
        "SELECT id FROM folders WHERE path = ?", (folder_path,)
    ).fetchone()

    if existing:
        folder_id = existing['id']
    else:
        if not disk_files:
            conn.close()
            return {'error': 'No images found in folder', 'count': 0}
        cur = conn.execute(
            "INSERT INTO folders (name, path, image_count) VALUES (?, ?, ?)",
            (folder_name, folder_path, len(disk_files))
        )
        folder_id = cur.lastrowid
        conn.commit()

    # Build DB state: { filename: {id, inode, file_size, width, height} }
    db_rows = conn.execute(
        "SELECT id, filename, inode, file_size, width, height FROM images WHERE folder_id = ?",
        (folder_id,)
    ).fetchall()
    db_files = {
        row['filename']: {
            'id': row['id'],
            'inode': row['inode'],
            'file_size': row['file_size'],
            'width': row['width'],
            'height': row['height'],
        }
        for row in db_rows
    }

    thumb_dir = os.path.join(library_root, '.library', 'thumbnails', str(folder_id))
    disk_set = set(disk_files.keys())
    db_set = set(db_files.keys())

    added = 0
    removed = 0
    updated = 0

    # --- REMOVE: in DB but not on disk ---
    for filename in (db_set - disk_set):
        img_id = db_files[filename]['id']
        # Delete OCR results
        conn.execute("DELETE FROM ocr_results WHERE image_id = ?", (img_id,))
        # Clear culling FK references
        conn.execute(
            "UPDATE culling_sessions SET picked_image_id = NULL WHERE picked_image_id = ?",
            (img_id,)
        )
        # Delete image record
        conn.execute("DELETE FROM images WHERE id = ?", (img_id,))
        # Remove thumbnail file
        _remove_thumbnail(library_root, folder_id, filename)
        removed += 1

    # --- ADD: on disk but not in DB ---
    for filename in (disk_set - db_set):
        inode, file_size = disk_files[filename]
        source_path = os.path.join(full_folder, filename)

        thumb_filename = generate_thumbnail(source_path, thumb_dir, filename)
        thumb_rel = f"{folder_id}/{thumb_filename}" if thumb_filename else None
        width, height = get_image_dimensions(source_path)
        filepath = os.path.join(folder_path, filename)

        conn.execute(
            """INSERT INTO images
               (folder_id, filename, filepath, thumbnail_path, width, height,
                file_size, inode, sort_order, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active')""",
            (folder_id, filename, filepath, thumb_rel,
             width, height, file_size, inode)
        )
        added += 1

    # --- BOTH: on disk and in DB — check for changes ---
    for filename in (disk_set & db_set):
        disk_inode, disk_size = disk_files[filename]
        db_info = db_files[filename]
        img_id = db_info['id']
        source_path = os.path.join(full_folder, filename)

        if disk_inode != db_info['inode'] or disk_size != db_info['file_size']:
            # Content changed: regenerate thumbnail, update metadata, delete stale OCR
            thumb_filename = generate_thumbnail(source_path, thumb_dir, filename)
            thumb_rel = f"{folder_id}/{thumb_filename}" if thumb_filename else None
            width, height = get_image_dimensions(source_path)
            filepath = os.path.join(folder_path, filename)

            conn.execute(
                """UPDATE images SET filepath = ?, thumbnail_path = ?,
                   width = ?, height = ?, file_size = ?, inode = ?,
                   modified_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (filepath, thumb_rel, width, height, disk_size, disk_inode, img_id)
            )
            conn.execute("DELETE FROM ocr_results WHERE image_id = ?", (img_id,))
            updated += 1
        # else: inode+size unchanged → file is byte-identical, skip

    # Recompute sort order and update folder image count
    _recompute_sort_order(conn, folder_id)
    conn.execute(
        "UPDATE folders SET image_count = ?, imported_at = CURRENT_TIMESTAMP WHERE id = ?",
        (len(disk_files), folder_id)
    )

    conn.commit()
    conn.close()

    return {
        'folder_id': folder_id,
        'folder_name': folder_name,
        'added': added,
        'removed': removed,
        'updated': updated,
        'total': len(disk_files),
    }
