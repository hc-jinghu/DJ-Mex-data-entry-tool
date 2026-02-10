"""Folder scanning, DB insertion, and thumbnail generation."""

import os

from .database import get_connection
from .thumbnails import generate_thumbnail, get_image_dimensions

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.tiff', '.heic'}


def import_folder(library_root, folder_path):
    """Import a folder of images into the library.

    Args:
        library_root: Absolute path to the library root.
        folder_path: Relative path of the folder (e.g. 'ALPHA').

    Returns:
        Dict with import results.
    """
    full_folder = os.path.join(library_root, folder_path)
    folder_name = os.path.basename(folder_path)

    # Collect image files
    image_files = sorted(
        f for f in os.listdir(full_folder)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS
        and not f.startswith('.')
    )

    if not image_files:
        return {'error': 'No images found in folder', 'count': 0}

    conn = get_connection()

    # Insert or get folder record
    existing = conn.execute(
        "SELECT id FROM folders WHERE path = ?", (folder_path,)
    ).fetchone()

    if existing:
        folder_id = existing['id']
        # Clear existing images for reimport
        conn.execute("DELETE FROM images WHERE folder_id = ?", (folder_id,))
        conn.execute(
            "UPDATE folders SET image_count = ?, imported_at = CURRENT_TIMESTAMP WHERE id = ?",
            (len(image_files), folder_id)
        )
    else:
        cur = conn.execute(
            "INSERT INTO folders (name, path, image_count) VALUES (?, ?, ?)",
            (folder_name, folder_path, len(image_files))
        )
        folder_id = cur.lastrowid

    # Thumbnail directory keyed by folder ID (stable across renames)
    thumb_dir = os.path.join(library_root, '.library', 'thumbnails', str(folder_id))

    imported_count = 0
    for idx, filename in enumerate(image_files):
        source_path = os.path.join(full_folder, filename)
        stat = os.stat(source_path)

        # Generate thumbnail
        thumb_filename = generate_thumbnail(source_path, thumb_dir, filename)
        thumb_rel = f"{folder_id}/{thumb_filename}" if thumb_filename else None

        # Get dimensions
        width, height = get_image_dimensions(source_path)

        filepath = os.path.join(folder_path, filename)

        conn.execute(
            """INSERT INTO images
               (folder_id, filename, filepath, thumbnail_path, width, height,
                file_size, inode, sort_order, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')""",
            (folder_id, filename, filepath, thumb_rel,
             width, height, stat.st_size, stat.st_ino, idx)
        )
        imported_count += 1

    conn.commit()
    conn.close()

    return {
        'folder_id': folder_id,
        'folder_name': folder_name,
        'imported': imported_count,
    }
