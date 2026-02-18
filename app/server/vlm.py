"""VLM-based region detection using MiniCPM-V 2.6 via Ollama.

Overlays a labeled 8x8 grid (A1–H8) on the image and asks the VLM
which cells contain the tag label and scale display.  This turns
localization into a classification task that VLMs handle reliably.

Requires Ollama running locally with openbmb/minicpm-v2.6:8b pulled.
Falls back gracefully (returns None for both regions) on any failure.
"""

import base64
import math
import os
import re
import traceback

import cv2
import numpy as np
import requests

# ── Constants ─────────────────────────────────────────────────────────
_FONT = cv2.FONT_HERSHEY_SIMPLEX
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)
_CYAN = (255, 255, 0)
_YELLOW = (0, 255, 255)
_RED = (0, 0, 255)
_GREEN = (0, 255, 0)
_GRAY = (80, 80, 80)

_COL_LETTERS = 'ABCDEFGH'
_CELL_RE = re.compile(r'[A-H][1-8]')


# ── Image helpers ─────────────────────────────────────────────────────

def _downscale_image(img, max_pixels=1_800_000):
    """Resize BGR image so total pixel count fits within budget.

    Returns (resized_img, inv_scale_factor).
    """
    h, w = img.shape[:2]
    total = h * w
    if total <= max_pixels:
        return img, 1.0

    scale = math.sqrt(max_pixels / total)
    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    inv_scale = 1.0 / scale
    return resized, inv_scale


def _encode_image_base64(img):
    """Encode BGR image as base64 JPEG string for Ollama API."""
    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf).decode('utf-8')


# ── Grid helpers ──────────────────────────────────────────────────────

def _draw_grid(img, grid_size=8):
    """Draw a labeled grid on a copy of the image.

    Columns: A–H (left to right).
    Rows: 1–8 (top to bottom — matches visual layout for the VLM).

    Returns the annotated image (same size as input).
    """
    out = img.copy()
    h, w = out.shape[:2]
    cell_w = w / grid_size
    cell_h = h / grid_size

    # Grid lines
    for i in range(1, grid_size):
        x = int(i * cell_w)
        y = int(i * cell_h)
        cv2.line(out, (x, 0), (x, h), _WHITE, 1, cv2.LINE_AA)
        cv2.line(out, (0, y), (w, y), _WHITE, 1, cv2.LINE_AA)

    # Cell labels
    font_scale = min(cell_w, cell_h) / 120
    font_scale = max(0.25, min(font_scale, 0.6))
    for col in range(grid_size):
        for row in range(grid_size):
            label = f"{_COL_LETTERS[col]}{row + 1}"
            tx = int(col * cell_w + 3)
            ty = int(row * cell_h + cell_h * 0.35)
            # Dark outline for readability
            cv2.putText(out, label, (tx, ty), _FONT, font_scale, _BLACK, 2, cv2.LINE_AA)
            cv2.putText(out, label, (tx, ty), _FONT, font_scale, _WHITE, 1, cv2.LINE_AA)

    return out


def _parse_cell_names(text, grid_size=8):
    """Parse VLM response text to extract cell names per region.

    Looks for sections mentioning "tag" and "scale" and extracts
    cell names (A1–H8) from each section.

    Returns dict: {'tag_label': ['A1', ...], 'scale_display': ['B3', ...]}
    """
    result = {'tag_label': [], 'scale_display': []}

    # Split text into lines for section-based parsing
    lines = text.strip().split('\n')

    # Simple approach: scan each line and assign cells to the most recently
    # mentioned region keyword
    current_key = None
    for line in lines:
        lower = line.lower()
        # Detect which region this line refers to
        if 'tag' in lower and 'scale' not in lower:
            current_key = 'tag_label'
        elif 'scale' in lower and 'tag' not in lower:
            current_key = 'scale_display'
        elif 'tag' in lower and 'scale' in lower:
            # Line mentions both — extract cells per mention
            # Split at "scale" and assign cells before to tag, after to scale
            parts = re.split(r'(?i)scale', line, maxsplit=1)
            tag_cells = _CELL_RE.findall(parts[0])
            scale_cells = _CELL_RE.findall(parts[1]) if len(parts) > 1 else []
            result['tag_label'].extend(tag_cells)
            result['scale_display'].extend(scale_cells)
            continue

        cells = _CELL_RE.findall(line)
        if cells and current_key:
            result[current_key].extend(cells)

    # Deduplicate while preserving order
    for key in result:
        seen = set()
        deduped = []
        for c in result[key]:
            if c not in seen:
                seen.add(c)
                deduped.append(c)
        result[key] = deduped

    return result


def _cells_to_bbox(cells, img_w, img_h, grid_size=8):
    """Convert a list of cell names to a pixel bounding box.

    Returns (x1, y1, x2, y2) or None if cells is empty.
    """
    if not cells:
        return None

    cell_w = img_w / grid_size
    cell_h = img_h / grid_size

    min_col = grid_size
    max_col = 0
    min_row = grid_size
    max_row = 0

    for name in cells:
        col = _COL_LETTERS.index(name[0])
        row = int(name[1]) - 1  # 0-indexed
        min_col = min(min_col, col)
        max_col = max(max_col, col)
        min_row = min(min_row, row)
        max_row = max(max_row, row)

    x1 = int(min_col * cell_w)
    y1 = int(min_row * cell_h)
    x2 = int((max_col + 1) * cell_w)
    y2 = int((max_row + 1) * cell_h)

    # Clamp
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(img_w, x2)
    y2 = min(img_h, y2)

    return (x1, y1, x2, y2)


# ── Debug visualization ──────────────────────────────────────────────

def _fit_to_cell(img, cell_w, cell_h):
    """Resize img to fit inside cell_w x cell_h, preserving aspect ratio, pad to exact size."""
    h, w = img.shape[:2]
    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    scale = min(cell_w / max(w, 1), cell_h / max(h, 1))
    new_w, new_h = int(w * scale), int(h * scale)
    if new_w < 1 or new_h < 1:
        return np.zeros((cell_h, cell_w, 3), dtype=np.uint8)
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((cell_h, cell_w, 3), dtype=np.uint8)
    y_off = (cell_h - new_h) // 2
    x_off = (cell_w - new_w) // 2
    canvas[y_off:y_off + new_h, x_off:x_off + new_w] = resized
    return canvas


def _label_panel(panel, text):
    """Draw a label bar at the top of a panel."""
    cv2.rectangle(panel, (0, 0), (panel.shape[1], 28), _GRAY, -1)
    cv2.putText(panel, text, (8, 20), _FONT, 0.55, _WHITE, 1, cv2.LINE_AA)


def _highlight_cells_on_grid(gridded_img, cells, color, grid_size=8):
    """Draw semi-transparent highlight on cells in the gridded image."""
    out = gridded_img.copy()
    h, w = out.shape[:2]
    cell_w = w / grid_size
    cell_h = h / grid_size
    overlay = out.copy()

    for name in cells:
        col = _COL_LETTERS.index(name[0])
        row = int(name[1]) - 1
        x1 = int(col * cell_w)
        y1 = int(row * cell_h)
        x2 = int((col + 1) * cell_w)
        y2 = int((row + 1) * cell_h)
        cv2.rectangle(overlay, (x1, y1), (x2, y2), color, -1)

    cv2.addWeighted(overlay, 0.3, out, 0.7, 0, out)

    # Draw cell borders on top
    for name in cells:
        col = _COL_LETTERS.index(name[0])
        row = int(name[1]) - 1
        x1 = int(col * cell_w)
        y1 = int(row * cell_h)
        x2 = int((col + 1) * cell_w)
        y2 = int((row + 1) * cell_h)
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)

    return out


def save_debug(debug_dir, filename, original_img, gridded_img,
               vlm_regions, parsed_cells, raw_vlm_text, tag_crop, scale_crop,
               error_msg=None):
    """Save a composite VLM debug image: {filename}_VLMdebug.jpg

    Layout (2x2 + summary row):
      Row 1: Gridded image (with highlighted cells) | Original with bounding boxes
      Row 2: Tag crop                               | Scale crop
      Row 3: Summary (full width) — raw VLM text, parsed cell names, errors
    """
    os.makedirs(debug_dir, exist_ok=True)

    h_orig, w_orig = original_img.shape[:2]
    CELL_W = min(800, w_orig)
    CELL_H = int(CELL_W * 3 / 4)
    SUMMARY_H = CELL_H // 2

    # ── Panel 1: Gridded image with highlighted cells ─────────
    highlighted = gridded_img.copy()
    if parsed_cells:
        tag_cells = parsed_cells.get('tag_label', [])
        scale_cells = parsed_cells.get('scale_display', [])
        if tag_cells:
            highlighted = _highlight_cells_on_grid(highlighted, tag_cells, _CYAN)
        if scale_cells:
            highlighted = _highlight_cells_on_grid(highlighted, scale_cells, _YELLOW)

    gh, gw = gridded_img.shape[:2]
    p1 = _fit_to_cell(highlighted, CELL_W, CELL_H)
    _label_panel(p1, f"VLM INPUT — 8x8 GRID ({gw}x{gh})")

    # ── Panel 2: Original with final bounding boxes ───────────
    p2_img = original_img.copy()
    for key, color, label in [('tag_label', _CYAN, 'TAG'),
                               ('scale_display', _YELLOW, 'SCALE')]:
        bbox = vlm_regions.get(key)
        if bbox:
            x1, y1, x2, y2 = bbox
            cv2.rectangle(p2_img, (x1, y1), (x2, y2), color, 4)
            cv2.putText(p2_img, f"VLM {label}", (x1 + 8, y1 + 30),
                        _FONT, 0.7, color, 2, cv2.LINE_AA)
            bw, bh = x2 - x1, y2 - y1
            cv2.putText(p2_img, f"{bw}x{bh}px", (x1 + 8, y2 - 10),
                        _FONT, 0.5, color, 1, cv2.LINE_AA)
    p2 = _fit_to_cell(p2_img, CELL_W, CELL_H)
    _label_panel(p2, f"ORIGINAL ({w_orig}x{h_orig}) + VLM BOXES")

    # ── Panel 3: Tag crop ─────────────────────────────────────
    if tag_crop is not None and tag_crop.size > 0:
        th, tw = tag_crop.shape[:2]
        p3 = _fit_to_cell(tag_crop, CELL_W, CELL_H)
        _label_panel(p3, f"TAG CROP ({tw}x{th})")
    else:
        p3 = np.zeros((CELL_H, CELL_W, 3), dtype=np.uint8)
        _label_panel(p3, "TAG CROP — NOT DETECTED")

    # ── Panel 4: Scale crop ───────────────────────────────────
    if scale_crop is not None and scale_crop.size > 0:
        sh, sw = scale_crop.shape[:2]
        p4 = _fit_to_cell(scale_crop, CELL_W, CELL_H)
        _label_panel(p4, f"SCALE CROP ({sw}x{sh})")
    else:
        p4 = np.zeros((CELL_H, CELL_W, 3), dtype=np.uint8)
        _label_panel(p4, "SCALE CROP — NOT DETECTED")

    # ── Panel 5: Summary ──────────────────────────────────────
    p5 = np.zeros((SUMMARY_H, CELL_W * 2, 3), dtype=np.uint8)
    _label_panel(p5, "VLM DETECTION SUMMARY")

    x, y = 12, 48
    line_h = 20
    chunk_size = 90

    def _put(label_text, value_text, color=_WHITE):
        nonlocal y
        if y > SUMMARY_H - 10:
            return
        cv2.putText(p5, label_text, (x, y), _FONT, 0.45, (150, 150, 150), 1, cv2.LINE_AA)
        cv2.putText(p5, str(value_text), (x + 160, y), _FONT, 0.45, color, 1, cv2.LINE_AA)
        y += line_h

    _put("filename:", filename)
    _put("original:", f"{w_orig}x{h_orig} ({w_orig*h_orig/1e6:.1f}MP)")

    tag_cells_str = ', '.join(parsed_cells.get('tag_label', [])) if parsed_cells else 'none'
    scale_cells_str = ', '.join(parsed_cells.get('scale_display', [])) if parsed_cells else 'none'
    _put("tag cells:", tag_cells_str, _CYAN if tag_cells_str != 'none' else _RED)
    _put("scale cells:", scale_cells_str, _YELLOW if scale_cells_str != 'none' else _RED)

    tag_bbox = vlm_regions.get('tag_label')
    scale_bbox = vlm_regions.get('scale_display')
    _put("tag bbox:", str(tag_bbox) if tag_bbox else "NOT FOUND",
         _CYAN if tag_bbox else _RED)
    _put("scale bbox:", str(scale_bbox) if scale_bbox else "NOT FOUND",
         _YELLOW if scale_bbox else _RED)

    # Raw VLM text on right column
    rx = CELL_W + 12
    ry = 48
    cv2.putText(p5, "raw VLM response:", (rx, ry), _FONT, 0.45, (150, 150, 150), 1, cv2.LINE_AA)
    ry += line_h
    if raw_vlm_text:
        for i in range(0, len(raw_vlm_text), chunk_size):
            if ry > SUMMARY_H - 10:
                break
            cv2.putText(p5, raw_vlm_text[i:i+chunk_size], (rx, ry),
                        _FONT, 0.35, _GREEN, 1, cv2.LINE_AA)
            ry += line_h
    else:
        cv2.putText(p5, "(no response)", (rx, ry), _FONT, 0.45, _RED, 1, cv2.LINE_AA)
        ry += line_h

    if error_msg:
        if ry <= SUMMARY_H - 10:
            cv2.putText(p5, "error:", (rx, ry), _FONT, 0.45, (150, 150, 150), 1, cv2.LINE_AA)
            ry += line_h
        for i in range(0, len(error_msg), chunk_size):
            if ry > SUMMARY_H - 10:
                break
            cv2.putText(p5, error_msg[i:i+chunk_size], (rx, ry),
                        _FONT, 0.35, _RED, 1, cv2.LINE_AA)
            ry += line_h

    # ── Compose grid ──────────────────────────────────────────
    top_row = np.hstack([p1, p2])
    mid_row = np.hstack([p3, p4])
    composite = np.vstack([top_row, mid_row, p5])

    base = os.path.splitext(filename)[0]
    out_path = os.path.join(debug_dir, f"{base}_VLMdebug.jpg")
    cv2.imwrite(out_path, composite, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return out_path


# ── Main detection ────────────────────────────────────────────────────

def detect_regions(img, ollama_url='http://localhost:11434', debug_dir=None, filename=None):
    """Detect tag label and scale display regions using VLM with 8x8 grid.

    Overlays a labeled 8x8 grid on the downscaled image, asks the VLM
    which cells contain the tag and scale, then converts cell names to
    pixel bounding boxes on the original image.

    Args:
        img: Full-resolution BGR image.
        ollama_url: Ollama server URL.
        debug_dir: If set, save VLM debug panels to this directory.
        filename: Image filename (used for debug output naming).

    Returns:
        dict with 'tag_label' and 'scale_display', each either
        (x1, y1, x2, y2) in original image pixel coords or None.
    """
    result = {'tag_label': None, 'scale_display': None}
    gridded_img = img  # fallback for debug
    parsed_cells = None
    raw_vlm_text = None
    error_msg = None

    try:
        downscaled, inv_scale = _downscale_image(img)
        h_orig, w_orig = img.shape[:2]

        # Draw labeled 8x8 grid on the downscaled image
        gridded_img = _draw_grid(downscaled)
        img_b64 = _encode_image_base64(gridded_img)

        prompt = (
            "This image has an 8x8 grid overlay with columns A-H (left to right) "
            "and rows 1-8 (top to bottom). Each cell is labeled (e.g. A1, B3, H8).\n\n"
            "Find these two regions and list which grid cells they occupy:\n\n"
            "1. tag_label: A small WHITE rectangular warehouse label with BLACK printed text. "
            "It contains the word 'EXPORT' and a 6-character code (exactly 3 letters followed "
            "by 3 digits, like EVU004 or ABC123). IMPORTANT: This label does NOT have any "
            "QR code or barcode — labels with QR codes are supplier labels, not the warehouse "
            "tag. The tag is small, usually fits within 1-2 grid cells. "
            "Lighting may make the white appear yellowish or dim.\n\n"
            "2. scale_display: A digital LED scale display showing weight digits. "
            "It has red or bright glowing digits on a dark/black background. "
            "Usually mounted on a post or stand near the cargo.\n\n"
            "RULES:\n"
            "- Each region must occupy a rectangular block of adjacent cells (e.g. D4, D5, E4, E5). "
            "Never list scattered or diagonal cells.\n"
            "- There is only ONE correct warehouse tag label per image.\n"
            "- Ignore any large printed text, brand names, shipping labels, or handwriting.\n\n"
            "Format your answer EXACTLY as:\n"
            "tag_label: [cell names]\n"
            "scale_display: [cell names]\n"
            "If a region is not visible, write 'none'."
        )

        resp = requests.post(
            f'{ollama_url}/api/chat',
            json={
                'model': 'openbmb/minicpm-v2.6:8b',
                'messages': [{
                    'role': 'user',
                    'content': prompt,
                    'images': [img_b64],
                }],
                'stream': False,
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()

        raw_vlm_text = data['message']['content']
        parsed_cells = _parse_cell_names(raw_vlm_text)

        # Convert cell names → bounding boxes on original image
        for key in ('tag_label', 'scale_display'):
            cells = parsed_cells.get(key, [])
            if not cells:
                continue

            # Get bbox on downscaled image, then scale to original
            dh, dw = downscaled.shape[:2]
            bbox_down = _cells_to_bbox(cells, dw, dh)
            if bbox_down is None:
                continue

            dx1, dy1, dx2, dy2 = bbox_down
            # Scale to original resolution
            px_x1 = int(dx1 * inv_scale)
            px_y1 = int(dy1 * inv_scale)
            px_x2 = int(dx2 * inv_scale)
            px_y2 = int(dy2 * inv_scale)

            # Clamp to image bounds
            px_x1 = max(0, px_x1)
            px_y1 = max(0, px_y1)
            px_x2 = min(w_orig, px_x2)
            px_y2 = min(h_orig, px_y2)

            if px_x2 > px_x1 and px_y2 > px_y1:
                result[key] = (px_x1, px_y1, px_x2, px_y2)

    except Exception:
        error_msg = traceback.format_exc()

    # Save debug output if requested
    if debug_dir and filename:
        tag_crop = None
        scale_crop = None
        if result['tag_label']:
            x1, y1, x2, y2 = result['tag_label']
            tag_crop = img[y1:y2, x1:x2]
        if result['scale_display']:
            x1, y1, x2, y2 = result['scale_display']
            scale_crop = img[y1:y2, x1:x2]
        try:
            save_debug(debug_dir, filename, img, gridded_img,
                       result, parsed_cells, raw_vlm_text,
                       tag_crop, scale_crop, error_msg=error_msg)
        except Exception:
            traceback.print_exc()

    return result


def crop_region(img, bbox):
    """Crop image to bounding box (x1, y1, x2, y2)."""
    x1, y1, x2, y2 = bbox
    return img[y1:y2, x1:x2]
