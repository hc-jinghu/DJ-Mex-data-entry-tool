"""Flask app, route registration, and static serving."""

import atexit
import json
import os

from flask import Flask, jsonify, request, send_file, send_from_directory

from .database import get_connection, init_db, row_to_dict, rows_to_dicts

LIBRARY_ROOT = os.getcwd()
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # app/


def _clear_all_marks():
    """Reset all marked images to active on shutdown."""
    try:
        conn = get_connection()
        conn.execute(
            "UPDATE images SET status = 'active', modified_at = CURRENT_TIMESTAMP "
            "WHERE status IN ('marked_delete', 'marked_ocr')"
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


def _migrate_thumbnail_dirs():
    """Migrate thumbnail directories from name-based to ID-based.

    Old format: .library/thumbnails/<folder_name>/
    New format: .library/thumbnails/<folder_id>/
    Also updates thumbnail_path in the images table.
    """
    try:
        thumb_root = os.path.join(LIBRARY_ROOT, '.library', 'thumbnails')
        if not os.path.isdir(thumb_root):
            return

        conn = get_connection()
        folders = conn.execute("SELECT id, name FROM folders").fetchall()

        for f in folders:
            fid = str(f['id'])
            fname = f['name']
            old_dir = os.path.join(thumb_root, fname)
            new_dir = os.path.join(thumb_root, fid)

            # Already migrated or new-style
            if os.path.isdir(new_dir):
                continue

            # Old name-based dir exists — rename it
            if os.path.isdir(old_dir):
                os.rename(old_dir, new_dir)
                # Update thumbnail_path in images: "FolderName/file.jpg" → "id/file.jpg"
                conn.execute(
                    "UPDATE images SET thumbnail_path = REPLACE(thumbnail_path, ?, ?) WHERE folder_id = ?",
                    (fname + '/', fid + '/', f['id'])
                )

        conn.commit()
        conn.close()
    except Exception:
        pass


def create_app():
    """Create and configure the Flask application."""
    app = Flask(
        __name__,
        static_folder=os.path.join(APP_DIR, 'static'),
        static_url_path='/static',
    )

    init_db()
    _clear_all_marks()  # Clear stale marks from previous session
    _migrate_thumbnail_dirs()  # Move name-based thumb dirs to ID-based
    atexit.register(_clear_all_marks)

    # ── Static serving ──────────────────────────────────────────────

    @app.route('/')
    def index():
        return send_from_directory(app.static_folder, 'index.html')

    # ── Folder endpoints ────────────────────────────────────────────

    @app.route('/api/folders', methods=['GET'])
    def list_folders():
        """List all imported folders, plus unimported directories.

        Detects folder renames by matching file inodes from disk to the DB.
        When a rename is detected, updates the folder's name/path and all
        image filepaths — thumbnails stay put since they're keyed by folder ID.
        """
        conn = get_connection()
        imported = rows_to_dicts(conn.execute(
            "SELECT * FROM folders ORDER BY name"
        ).fetchall())

        # Build a set of inode->folder_id from DB for rename detection
        db_inodes = {}
        for f in imported:
            rows = conn.execute(
                "SELECT inode FROM images WHERE folder_id = ? AND status != 'deleted' LIMIT 5",
                (f['id'],)
            ).fetchall()
            for r in rows:
                if r['inode']:
                    db_inodes[r['inode']] = f['id']

        # Scan disk directories
        disk_dirs = []
        for entry in sorted(os.listdir(LIBRARY_ROOT)):
            full_path = os.path.join(LIBRARY_ROOT, entry)
            if not os.path.isdir(full_path) or entry.startswith('.') or entry in ('app', '__pycache__'):
                continue
            image_files = [
                fn for fn in os.listdir(full_path)
                if fn.lower().endswith(('.jpg', '.jpeg', '.png', '.tiff', '.heic'))
                and not fn.startswith('.')
            ]
            if image_files:
                disk_dirs.append((entry, full_path, image_files))

        matched_ids = set()
        all_folders = []

        for entry, full_path, image_files in disk_dirs:
            # Direct path match
            match = next((f for f in imported if f['path'] == entry), None)

            # If no direct match, try inode matching (folder was renamed)
            if not match:
                sample_inodes = set()
                for fn in image_files[:5]:
                    try:
                        sample_inodes.add(os.stat(os.path.join(full_path, fn)).st_ino)
                    except OSError:
                        pass
                for ino in sample_inodes:
                    if ino in db_inodes:
                        fid = db_inodes[ino]
                        match = next((f for f in imported if f['id'] == fid), None)
                        if match:
                            # Update the folder name/path in DB
                            old_path = match['path']
                            conn.execute(
                                "UPDATE folders SET name = ?, path = ? WHERE id = ?",
                                (entry, entry, match['id'])
                            )
                            conn.execute(
                                "UPDATE images SET filepath = REPLACE(filepath, ?, ?) WHERE folder_id = ?",
                                (old_path + '/', entry + '/', match['id'])
                            )
                            conn.commit()
                            match['name'] = entry
                            match['path'] = entry
                            break

            if match:
                matched_ids.add(match['id'])
                all_folders.append({**match, 'imported': True})
            else:
                all_folders.append({
                    'id': None,
                    'name': entry,
                    'path': entry,
                    'image_count': len(image_files),
                    'imported': False,
                })

        conn.close()
        return jsonify(all_folders)

    @app.route('/api/folders/import', methods=['POST'])
    def import_folder():
        """Import a folder: scan, insert to DB, generate thumbnails."""
        from .importer import import_folder as do_import

        data = request.get_json()
        folder_path = data.get('path')
        if not folder_path:
            return jsonify({'error': 'path is required'}), 400

        full_path = os.path.join(LIBRARY_ROOT, folder_path)
        if not os.path.isdir(full_path):
            return jsonify({'error': 'folder not found'}), 404

        try:
            result = do_import(LIBRARY_ROOT, folder_path)
            return jsonify(result)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return jsonify({'error': str(e)}), 500

    @app.route('/api/folders/<int:folder_id>', methods=['GET'])
    def get_folder(folder_id):
        conn = get_connection()
        folder = row_to_dict(conn.execute(
            "SELECT * FROM folders WHERE id = ?", (folder_id,)
        ).fetchone())
        conn.close()
        if not folder:
            return jsonify({'error': 'not found'}), 404
        return jsonify(folder)

    # ── Image endpoints ─────────────────────────────────────────────

    @app.route('/api/folders/<int:folder_id>/images', methods=['GET'])
    def list_images(folder_id):
        status_filter = request.args.get('status', 'active')
        conn = get_connection()
        if status_filter == 'all':
            images = rows_to_dicts(conn.execute(
                "SELECT * FROM images WHERE folder_id = ? ORDER BY sort_order",
                (folder_id,)
            ).fetchall())
        else:
            images = rows_to_dicts(conn.execute(
                "SELECT * FROM images WHERE folder_id = ? AND status = ? ORDER BY sort_order",
                (folder_id, status_filter)
            ).fetchall())
        conn.close()
        return jsonify(images)

    @app.route('/api/images/<int:image_id>', methods=['GET'])
    def get_image(image_id):
        conn = get_connection()
        image = row_to_dict(conn.execute(
            "SELECT * FROM images WHERE id = ?", (image_id,)
        ).fetchone())
        conn.close()
        if not image:
            return jsonify({'error': 'not found'}), 404
        return jsonify(image)

    @app.route('/api/images/<int:image_id>/thumbnail', methods=['GET'])
    def serve_thumbnail(image_id):
        conn = get_connection()
        image = row_to_dict(conn.execute(
            "SELECT * FROM images WHERE id = ?", (image_id,)
        ).fetchone())
        conn.close()
        if not image or not image['thumbnail_path']:
            return jsonify({'error': 'not found'}), 404

        thumb_path = os.path.join(LIBRARY_ROOT, '.library', 'thumbnails', image['thumbnail_path'])
        if not os.path.exists(thumb_path):
            return jsonify({'error': 'thumbnail file missing'}), 404
        return send_file(thumb_path, mimetype='image/jpeg')

    @app.route('/api/images/<int:image_id>/full', methods=['GET'])
    def serve_full_image(image_id):
        conn = get_connection()
        image = row_to_dict(conn.execute(
            "SELECT * FROM images WHERE id = ?", (image_id,)
        ).fetchone())
        conn.close()
        if not image:
            return jsonify({'error': 'not found'}), 404

        full_path = os.path.join(LIBRARY_ROOT, image['filepath'])
        if not os.path.exists(full_path):
            return jsonify({'error': 'file missing'}), 404
        return send_file(full_path)

    @app.route('/api/images/<int:image_id>/rename', methods=['PUT'])
    def rename_image(image_id):
        data = request.get_json()
        new_name = data.get('filename')
        if not new_name:
            return jsonify({'error': 'filename required'}), 400

        conn = get_connection()
        image = row_to_dict(conn.execute(
            "SELECT * FROM images WHERE id = ?", (image_id,)
        ).fetchone())
        if not image:
            conn.close()
            return jsonify({'error': 'not found'}), 404

        old_full = os.path.join(LIBRARY_ROOT, image['filepath'])
        folder_path = os.path.dirname(image['filepath'])
        new_filepath = os.path.join(folder_path, new_name)
        new_full = os.path.join(LIBRARY_ROOT, new_filepath)

        if os.path.exists(new_full):
            conn.close()
            return jsonify({'error': 'file already exists'}), 409

        os.rename(old_full, new_full)
        conn.execute(
            "UPDATE images SET filename = ?, filepath = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_name, new_filepath, image_id)
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'filepath': new_filepath})

    @app.route('/api/images/<int:image_id>/status', methods=['PUT'])
    def update_image_status(image_id):
        from .actions import sync_actions_file

        data = request.get_json()
        new_status = data.get('status')
        if new_status not in ('active', 'marked_delete', 'marked_ocr'):
            return jsonify({'error': 'invalid status'}), 400

        conn = get_connection()
        conn.execute(
            "UPDATE images SET status = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_status, image_id)
        )
        conn.commit()
        conn.close()

        sync_actions_file(LIBRARY_ROOT)
        return jsonify({'success': True})

    @app.route('/api/images/bulk-status', methods=['POST'])
    def bulk_update_status():
        from .actions import sync_actions_file

        data = request.get_json()
        image_ids = data.get('image_ids', [])
        new_status = data.get('status')
        if new_status not in ('active', 'marked_delete', 'marked_ocr'):
            return jsonify({'error': 'invalid status'}), 400
        if not image_ids:
            return jsonify({'error': 'no image_ids provided'}), 400

        conn = get_connection()
        placeholders = ','.join('?' for _ in image_ids)
        conn.execute(
            f"UPDATE images SET status = ?, modified_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
            [new_status] + image_ids
        )
        conn.commit()
        conn.close()

        sync_actions_file(LIBRARY_ROOT)
        return jsonify({'success': True, 'updated': len(image_ids)})

    # ── Action endpoints ────────────────────────────────────────────

    @app.route('/api/actions/pending', methods=['GET'])
    def get_pending_actions():
        from .actions import read_actions_file
        actions = read_actions_file(LIBRARY_ROOT)
        return jsonify(actions)

    @app.route('/api/actions/execute', methods=['POST'])
    def execute_actions():
        from .actions import execute_pending_actions
        result = execute_pending_actions(LIBRARY_ROOT)
        return jsonify(result)

    # ── Culling endpoints ───────────────────────────────────────────

    @app.route('/api/culling/start', methods=['POST'])
    def start_culling():
        data = request.get_json()
        image_ids = data.get('image_ids', [])
        folder_id = data.get('folder_id')
        if not image_ids or len(image_ids) < 2:
            return jsonify({'error': 'need at least 2 images'}), 400
        if not folder_id:
            return jsonify({'error': 'folder_id required'}), 400

        conn = get_connection()
        cur = conn.execute(
            "INSERT INTO culling_sessions (folder_id, image_ids, picked_image_id) VALUES (?, ?, ?)",
            (folder_id, json.dumps(image_ids), image_ids[0])
        )
        session_id = cur.lastrowid
        conn.commit()

        session = row_to_dict(conn.execute(
            "SELECT * FROM culling_sessions WHERE id = ?", (session_id,)
        ).fetchone())
        conn.close()
        session['image_ids'] = json.loads(session['image_ids'])
        return jsonify(session)

    @app.route('/api/culling/<int:session_id>', methods=['GET'])
    def get_culling_session(session_id):
        conn = get_connection()
        session = row_to_dict(conn.execute(
            "SELECT * FROM culling_sessions WHERE id = ?", (session_id,)
        ).fetchone())
        conn.close()
        if not session:
            return jsonify({'error': 'not found'}), 404
        session['image_ids'] = json.loads(session['image_ids'])
        return jsonify(session)

    @app.route('/api/culling/<int:session_id>/pick', methods=['PUT'])
    def pick_culling_image(session_id):
        data = request.get_json()
        picked_id = data.get('image_id')

        conn = get_connection()
        session = row_to_dict(conn.execute(
            "SELECT * FROM culling_sessions WHERE id = ?", (session_id,)
        ).fetchone())
        if not session:
            conn.close()
            return jsonify({'error': 'not found'}), 404

        image_ids = json.loads(session['image_ids'])
        if picked_id not in image_ids:
            conn.close()
            return jsonify({'error': 'image not in session'}), 400

        conn.execute(
            "UPDATE culling_sessions SET picked_image_id = ? WHERE id = ?",
            (picked_id, session_id)
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'picked_image_id': picked_id})

    # ── Folder unit endpoint ────────────────────────────────────────

    @app.route('/api/folders/<int:folder_id>/unit', methods=['PUT'])
    def set_folder_unit(folder_id):
        data = request.get_json()
        weight_unit = data.get('weight_unit')
        if weight_unit not in ('kg', 'lbs'):
            return jsonify({'error': 'weight_unit must be kg or lbs'}), 400

        conn = get_connection()
        folder = conn.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if not folder:
            conn.close()
            return jsonify({'error': 'not found'}), 404

        conn.execute("UPDATE folders SET weight_unit = ? WHERE id = ?", (weight_unit, folder_id))
        conn.commit()
        conn.close()
        return jsonify({'weight_unit': weight_unit})

    # ── Folder ROI endpoint ────────────────────────────────────────────

    @app.route('/api/folders/<int:folder_id>/roi', methods=['PUT'])
    def set_folder_roi(folder_id):
        data = request.get_json()
        cells = data.get('cells')
        if cells is None:
            return jsonify({'error': 'cells required'}), 400

        conn = get_connection()
        folder = conn.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if not folder:
            conn.close()
            return jsonify({'error': 'not found'}), 404

        roi_json = json.dumps(cells) if cells else None
        conn.execute("UPDATE folders SET ocr_roi = ? WHERE id = ?", (roi_json, folder_id))
        conn.commit()
        conn.close()
        return jsonify({'ocr_roi': roi_json})

    # ── OCR endpoints ────────────────────────────────────────────────

    @app.route('/api/ocr/process/<int:image_id>', methods=['POST'])
    def process_ocr_image(image_id):
        """Process a single image for OCR and return the result immediately."""
        from .ocr import process_image, save_ocr_result

        conn = get_connection()
        image = row_to_dict(conn.execute(
            "SELECT * FROM images WHERE id = ?", (image_id,)
        ).fetchone())
        if not image:
            conn.close()
            return jsonify({'error': 'image not found'}), 404

        # Look up folder's weight_unit and ocr_roi
        folder = row_to_dict(conn.execute(
            "SELECT weight_unit, ocr_roi FROM folders WHERE id = ?", (image['folder_id'],)
        ).fetchone())
        conn.close()
        weight_unit = (folder or {}).get('weight_unit') or 'kg'
        ocr_roi = None
        if folder and folder.get('ocr_roi'):
            try:
                ocr_roi = json.loads(folder['ocr_roi'])
            except (json.JSONDecodeError, TypeError):
                pass

        debug_dir = os.path.join(LIBRARY_ROOT, '.library', 'ocr_debug')

        try:
            result = process_image(LIBRARY_ROOT, image_id, debug_dir=debug_dir, weight_unit=weight_unit, ocr_roi=ocr_roi)
            save_ocr_result(image_id, result)
            resp = {
                'image_id': image_id,
                'filename': result.get('renamed') or image['filename'],
                'tag': result['tag'],
                'scale_weight': result['scale_weight'],
                'handwritten_weight': result['handwritten_weight'],
                'status': result['status'],
                'error_message': result.get('error_message'),
            }
            if result.get('renamed'):
                resp['renamed'] = result['renamed']
            return jsonify(resp)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return jsonify({'error': str(e)}), 500

    @app.route('/api/ocr/submit', methods=['POST'])
    def submit_ocr():
        """Submit images for OCR processing.

        Expects JSON: { image_ids: [1, 2, 3] }
        Creates pending ocr_results rows, then processes in-request.
        """
        from .ocr import process_batch, save_ocr_result

        data = request.get_json()
        image_ids = data.get('image_ids', [])
        if not image_ids:
            return jsonify({'error': 'no image_ids provided'}), 400

        # Create pending rows for all images first
        conn = get_connection()
        for iid in image_ids:
            conn.execute(
                """INSERT INTO ocr_results (image_id, status)
                   VALUES (?, 'pending')
                   ON CONFLICT(image_id) DO UPDATE SET
                       status = 'pending', processed_at = NULL""",
                (iid,)
            )
        conn.commit()
        conn.close()

        try:
            summary = process_batch(LIBRARY_ROOT, image_ids)
            return jsonify(summary)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return jsonify({'error': str(e)}), 500

    @app.route('/api/ocr/results/<int:folder_id>', methods=['GET'])
    def get_ocr_results(folder_id):
        """Get all OCR results for images in a folder."""
        conn = get_connection()
        results = rows_to_dicts(conn.execute(
            """SELECT o.*, i.filename, i.filepath
               FROM ocr_results o
               JOIN images i ON o.image_id = i.id
               WHERE i.folder_id = ?
               ORDER BY o.image_id""",
            (folder_id,)
        ).fetchall())
        conn.close()
        return jsonify(results)

    @app.route('/api/ocr/result/<int:image_id>', methods=['GET'])
    def get_ocr_result(image_id):
        """Get OCR result for a single image."""
        conn = get_connection()
        result = row_to_dict(conn.execute(
            """SELECT o.*, i.filename, i.filepath
               FROM ocr_results o
               JOIN images i ON o.image_id = i.id
               WHERE o.image_id = ?""",
            (image_id,)
        ).fetchone())
        conn.close()
        if not result:
            return jsonify({'error': 'no OCR result'}), 404
        return jsonify(result)

    @app.route('/api/ocr/tag-roi/<int:image_id>', methods=['GET'])
    def get_tag_roi(image_id):
        """Serve the saved Tag ROI crop image for a given image."""
        conn = get_connection()
        img = row_to_dict(conn.execute(
            "SELECT filename FROM images WHERE id = ?", (image_id,)
        ).fetchone())
        conn.close()
        if not img:
            return jsonify({'error': 'image not found'}), 404
        base = os.path.splitext(img['filename'])[0]
        path = os.path.join(LIBRARY_ROOT, '.library', 'tag_crops', f'{base}_tagroi.jpg')
        if not os.path.exists(path):
            return jsonify({'error': 'no tag ROI crop'}), 404
        return send_file(path, mimetype='image/jpeg')

    @app.route('/api/ocr/led-crop/<int:image_id>', methods=['GET'])
    def get_led_crop(image_id):
        """Serve the saved LED crop image for a given image."""
        conn = get_connection()
        img = row_to_dict(conn.execute(
            "SELECT filename FROM images WHERE id = ?", (image_id,)
        ).fetchone())
        conn.close()
        if not img:
            return jsonify({'error': 'image not found'}), 404
        base = os.path.splitext(img['filename'])[0]
        led_path = os.path.join(LIBRARY_ROOT, '.library', 'led_crops', f'{base}_ledcrop.jpg')
        if not os.path.exists(led_path):
            return jsonify({'error': 'no LED crop'}), 404
        return send_file(led_path, mimetype='image/jpeg')

    @app.route('/api/ocr/result/<int:image_id>', methods=['PUT'])
    def update_ocr_result(image_id):
        """Manually update OCR result (for human review corrections)."""
        data = request.get_json()
        conn = get_connection()

        fields = []
        values = []
        for key in ('tag', 'scale_weight', 'handwritten_weight', 'status'):
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])

        if not fields:
            conn.close()
            return jsonify({'error': 'no fields to update'}), 400

        values.append(image_id)
        conn.execute(
            f"UPDATE ocr_results SET {', '.join(fields)} WHERE image_id = ?",
            values
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True})

    @app.route('/api/ocr/export/<int:folder_id>', methods=['GET'])
    def export_ocr_xlsx(folder_id):
        """Export OCR results for a folder as .xlsx.

        Template: Item | Tag | Gross | Tare | Net | Description
        - Tag and Gross come from ocr_results.
        - Net is a formula: Gross - Tare.
        - Item, Tare, Description are left blank.
        """
        import io
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
        from openpyxl.utils import get_column_letter

        conn = get_connection()
        folder = row_to_dict(conn.execute(
            "SELECT name FROM folders WHERE id = ?", (folder_id,)
        ).fetchone())
        if not folder:
            conn.close()
            return jsonify({'error': 'folder not found'}), 404

        import re
        tag_pattern = re.compile(r'^[A-Za-z]{3}\d{3}$')

        all_rows = rows_to_dicts(conn.execute(
            """SELECT o.tag, o.scale_weight
               FROM ocr_results o
               JOIN images i ON o.image_id = i.id
               WHERE i.folder_id = ?
               ORDER BY i.sort_order""",
            (folder_id,)
        ).fetchall())
        conn.close()

        # Only export rows with valid tags (3 letters + 3 digits)
        rows = [r for r in all_rows if r['tag'] and tag_pattern.match(r['tag'])]

        wb = Workbook()
        ws = wb.active
        ws.title = folder['name'][:31]  # sheet name max 31 chars

        # Column widths
        ws.column_dimensions['A'].width = 8
        ws.column_dimensions['B'].width = 12
        ws.column_dimensions['C'].width = 12
        ws.column_dimensions['D'].width = 12
        ws.column_dimensions['E'].width = 12
        ws.column_dimensions['F'].width = 24

        # Header row
        headers = ['Item', 'Tag', 'Gross', 'Tare', 'Net', 'Description']
        header_font = Font(bold=True)
        header_fill = PatternFill(start_color='D9E1F2', end_color='D9E1F2', fill_type='solid')
        thin_border = Border(
            bottom=Side(style='thin', color='999999')
        )
        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=h)
            cell.font = header_font
            cell.fill = header_fill
            cell.border = thin_border
            cell.alignment = Alignment(horizontal='center')

        # Format column A (Item) as text
        from openpyxl.styles.numbers import FORMAT_TEXT
        for row_idx in range(2, len(rows) + 102):  # pre-format plenty of rows
            ws.cell(row=row_idx, column=1).number_format = FORMAT_TEXT

        # Data rows
        for i, r in enumerate(rows, 2):
            # A: Item (blank, text format already applied above)
            # B: Tag
            ws.cell(row=i, column=2, value=r['tag'])
            # C: Gross
            if r['scale_weight'] is not None:
                ws.cell(row=i, column=3, value=r['scale_weight'])
            # D: Tare (blank)
            # E: Net = Gross - Tare (formula)
            ws.cell(row=i, column=5, value=f'=C{i}-D{i}')
            # F: Description (blank)

        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)

        filename = f"{folder['name']}_ocr_export.xlsx"
        return send_file(
            buf,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=filename
        )

    @app.route('/api/culling/<int:session_id>/finalize', methods=['POST'])
    def finalize_culling(session_id):
        from .actions import sync_actions_file

        conn = get_connection()
        session = row_to_dict(conn.execute(
            "SELECT * FROM culling_sessions WHERE id = ?", (session_id,)
        ).fetchone())
        if not session:
            conn.close()
            return jsonify({'error': 'not found'}), 404

        image_ids = json.loads(session['image_ids'])
        picked_id = session['picked_image_id']

        # Mark all non-picked images for deletion
        non_picked = [iid for iid in image_ids if iid != picked_id]
        if non_picked:
            placeholders = ','.join('?' for _ in non_picked)
            conn.execute(
                f"UPDATE images SET status = 'marked_delete', modified_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
                non_picked
            )

        conn.execute(
            "UPDATE culling_sessions SET status = 'finalized' WHERE id = ?",
            (session_id,)
        )
        conn.commit()
        conn.close()

        sync_actions_file(LIBRARY_ROOT)
        return jsonify({'success': True, 'marked_for_deletion': len(non_picked), 'picked_image_id': picked_id})

    return app
