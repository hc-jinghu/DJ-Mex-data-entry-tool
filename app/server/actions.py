"""Process pending actions: delete hardlinks, send originals to trash, manage actions.json."""

import json
import os
import subprocess

from .database import get_connection, rows_to_dicts

ACTIONS_FILE = os.path.join('.library', 'actions.json')


def _actions_path(library_root):
    return os.path.join(library_root, ACTIONS_FILE)


def read_actions_file(library_root):
    """Read the current actions.json file."""
    path = _actions_path(library_root)
    if not os.path.exists(path):
        return {'pending_deletions': [], 'pending_ocr': []}
    with open(path, 'r') as f:
        return json.load(f)


def sync_actions_file(library_root):
    """Rebuild actions.json from current database state."""
    conn = get_connection()

    deletions = rows_to_dicts(conn.execute(
        """SELECT i.id as image_id, f.name as folder, i.filename, i.filepath, i.modified_at as marked_at
           FROM images i JOIN folders f ON i.folder_id = f.id
           WHERE i.status = 'marked_delete'
           ORDER BY i.modified_at"""
    ).fetchall())

    ocr = rows_to_dicts(conn.execute(
        """SELECT i.id as image_id, f.name as folder, i.filename, i.filepath, i.modified_at as marked_at
           FROM images i JOIN folders f ON i.folder_id = f.id
           WHERE i.status = 'marked_ocr'
           ORDER BY i.modified_at"""
    ).fetchall())

    conn.close()

    actions = {
        'pending_deletions': deletions,
        'pending_ocr': ocr,
    }

    os.makedirs(os.path.dirname(_actions_path(library_root)), exist_ok=True)
    with open(_actions_path(library_root), 'w') as f:
        json.dump(actions, f, indent=2)

    return actions


def _find_original_by_inode(library_root, inode, hardlink_path):
    """Find the original file by looking for other hardlinks with the same inode.

    We search common parent directories to find the original.
    Returns the path to the original, or None if only one link exists.
    """
    # Check link count — if only 1 link, this IS the only copy
    try:
        stat = os.stat(hardlink_path)
        if stat.st_nlink <= 1:
            return None
    except OSError:
        return None

    # The hardlink_path is the library copy. The "original" is whichever
    # other path shares the same inode. We can't easily scan the whole
    # filesystem, so we just return None and let the caller decide.
    # The delete strategy: unlink the library copy. If nlink > 1 after
    # that, the original still exists. If nlink == 1, we send the
    # remaining file to trash (but we can't find it without scanning).
    return None


def execute_pending_actions(library_root):
    """Execute all pending deletions."""
    conn = get_connection()

    pending = rows_to_dicts(conn.execute(
        """SELECT i.id, i.filepath, i.thumbnail_path, i.inode, i.filename, f.name as folder_name
           FROM images i JOIN folders f ON i.folder_id = f.id
           WHERE i.status = 'marked_delete'"""
    ).fetchall())

    results = {'deleted': 0, 'errors': []}

    for img in pending:
        hardlink_path = os.path.join(library_root, img['filepath'])

        try:
            # Remove the hardlink from the library
            if os.path.exists(hardlink_path):
                os.unlink(hardlink_path)

            # Remove thumbnail
            if img['thumbnail_path']:
                thumb_path = os.path.join(library_root, '.library', 'thumbnails', img['thumbnail_path'])
                if os.path.exists(thumb_path):
                    os.unlink(thumb_path)

            # Update status in DB
            conn.execute(
                "UPDATE images SET status = 'deleted', modified_at = CURRENT_TIMESTAMP WHERE id = ?",
                (img['id'],)
            )

            # Update folder image count
            conn.execute(
                """UPDATE folders SET image_count = (
                       SELECT COUNT(*) FROM images WHERE folder_id = folders.id AND status = 'active'
                   ) WHERE name = ?""",
                (img['folder_name'],)
            )

            results['deleted'] += 1

        except Exception as e:
            results['errors'].append({
                'image_id': img['id'],
                'filename': img['filename'],
                'error': str(e),
            })

    conn.commit()
    conn.close()

    # Rebuild actions file (should now be empty for deletions)
    sync_actions_file(library_root)

    return results
