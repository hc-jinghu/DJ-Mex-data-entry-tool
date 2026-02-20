"""OCR processing for shipment photos.

Extracts:
  - Printed tag (3 letters + 3 digits, e.g. EVS001) — via Doctr
  - Scale display weight (bright red digits) — via Doctr (red channel threshold)

Standalone CLI usage:
    python -m server                          # default: --folder TestOCR
    python -m server --image-ids 1 2 3        # process specific images
    python -m server --folder-id 1            # process all OCR-marked in folder
    python -m server --folder TestOCR --debug # debug output to .library/ocr_debug/
"""

import json
import os
import re
import subprocess
import tempfile
import traceback
from datetime import datetime

import cv2
import numpy as np

from .database import get_connection, row_to_dict, rows_to_dicts

# Tag pattern: 3 uppercase letters + 3 digits (used for debug visualization)
TAG_PATTERN = re.compile(r'[A-Z]{3}\d{3}')
# EVS tag: exactly 3 letters + 3 digits — a valid pallet identifier
EVS_TAG_PATTERN = re.compile(r'^[A-Za-z]{3}\d{3}$')
# Weight pattern: integer or decimal number
WEIGHT_PATTERN = re.compile(r'\d+\.?\d*')
# Fixed scale ROI on 8x8 grid: columns 3-6, rows 6-8 (top-middle region)
# Origin is bottom-left: y=1 is bottom row, y=8 is top row.
# Cols 3-6 ≈ center-horizontal, rows 6-8 ≈ top ~3/8 of image.
SCALE_ROI = [
    [3,6],[3,7],[3,8],
    [4,6],[4,7],[4,8],
    [5,6],[5,7],[5,8],
    [6,6],[6,7],[6,8],
]
# Common 7-segment LED misreads → correct digit
LED_SUBS = str.maketrans(
    'ODQ'       # → 0
    'lIi|:'     # → 1
    'Zz'        # → 2
    'E'         # → 3
    'AHh'       # → 4
    'Ss'        # → 5
    'Gb'        # → 6
    'T?'        # → 7
    'B'         # → 8
    'gq',       # → 9
    '000'
    '11111'
    '22'
    '3'
    '444'
    '55'
    '66'
    '77'
    '8'
    '99'
)

# Lazy-loaded Doctr model singleton (tag pipeline)
_doctr_model = None

def _get_doctr_model():
    """Return the Doctr OCR predictor, loading it on first call.

    Model weights are cached in .library/doctr_cache/ so they are shared
    across devices (alongside the DB and thumbnails) and only need to be
    downloaded once.
    """
    global _doctr_model
    if _doctr_model is None:
        # Point doctr at the project-local cache BEFORE importing doctr,
        # because it reads DOCTR_CACHE_DIR at import time.
        cache_dir = os.path.join(os.getcwd(), '.library', 'doctr_cache')
        os.makedirs(cache_dir, exist_ok=True)
        os.environ.setdefault('DOCTR_CACHE_DIR', cache_dir)

        print(f"[OCR] Loading doctr model (cache: {cache_dir})", flush=True)
        from doctr.models import ocr_predictor
        _doctr_model = ocr_predictor(pretrained=True)
        print("[OCR] doctr model ready", flush=True)
    return _doctr_model




def _load_image(filepath):
    """Load image with OpenCV, return BGR array."""
    img = cv2.imread(filepath)
    if img is None:
        raise ValueError(f"Could not read image: {filepath}")
    return img


def _deskew(img):
    """Deskew image if it's rotated. Returns corrected image."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Threshold to get binary image
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Find coordinates of non-zero pixels
    coords = np.column_stack(np.where(binary > 0))
    if len(coords) < 50:
        return img

    # Get the minimum area bounding rectangle
    angle = cv2.minAreaRect(coords)[-1]

    # Correct the angle
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle

    # Only deskew if angle is significant but not extreme
    if abs(angle) < 0.5 or abs(angle) > 15:
        return img

    h, w = img.shape[:2]
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_REPLICATE)
    return rotated


# ── OCR extraction pipelines ────────────────────────────────────────


def _ocr_tag(img):
    """Extract tag text from the ROI crop.

    Pipeline:
      1. Feed ROI crop directly to Doctr
      2. If any word matches EVS pattern [A-Za-z]{3}\\d{3}, return it immediately
      3. Otherwise return the longest detected word (up to 30 chars)

    Returns (tag_string_or_None, preprocessed_img, tag_results_list).
    """
    all_results = []
    model = _get_doctr_model()
    img_h, img_w = img.shape[:2]

    # Run Doctr on the ROI crop directly (model accepts list of numpy arrays)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    result = model([rgb])
    export = result.export()

    best_word = None
    best_len = 0

    # Extract words with bboxes in pixel coords of the input image
    for page in export['pages']:
        for block in page['blocks']:
            for line in block['lines']:
                for word in line['words']:
                    text = word['value']
                    conf = word['confidence']
                    (x1n, y1n), (x2n, y2n) = word['geometry']
                    wx1 = int(x1n * img_w)
                    wy1 = int(y1n * img_h)
                    wx2 = int(x2n * img_w)
                    wy2 = int(y2n * img_h)
                    bbox = [[wx1, wy1], [wx2, wy1], [wx2, wy2], [wx1, wy2]]
                    all_results.append((bbox, text, conf))

                    # Prefer EVS tag match — return immediately
                    upper = text.upper().strip()
                    if EVS_TAG_PATTERN.match(upper):
                        return upper, img, all_results

                    # Track longest word as fallback
                    cleaned = text.strip()[:30]
                    if len(cleaned) > best_len:
                        best_word = cleaned
                        best_len = len(cleaned)

    return best_word, img, all_results


def _deskew_led(crop):
    """Perspective-correct an LED crop using the bright-red digit pixels.

    Finds the minimum-area rotated rectangle around the red pixels and
    warps the crop so that rectangle is axis-aligned.  Returns the
    deskewed image (same size as input).
    """
    # Red channel is where LED digits are brightest
    r_ch = crop[:, :, 2] if len(crop.shape) == 3 else crop
    _, mask = cv2.threshold(r_ch, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    pts = cv2.findNonZero(mask)
    if pts is None or len(pts) < 20:
        return crop  # not enough pixels to deskew

    rect = cv2.minAreaRect(pts)
    angle = rect[-1]

    # minAreaRect returns angles in [-90, 0).  Normalise to a small
    # correction: if angle < -45 the box is "tall", so rotate +90.
    if angle < -45:
        angle += 90

    # Only correct if there's a meaningful skew (>0.5°) but not crazy (>20°)
    if abs(angle) < 0.5 or abs(angle) > 20:
        return crop

    h, w = crop.shape[:2]
    center = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    deskewed = cv2.warpAffine(crop, M, (w, h),
                              flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_REPLICATE)
    return deskewed


def _ocr_scale_weight(img):
    """Extract weight from scale display (red LED digits).

    Pipeline:
      1. Isolate LED display region (red-on-dark contour scoring)
      2. Perspective-correct (deskew) the LED crop
      3. Extract red channel + upscale 4x
      4. Run ssocr for seven-segment digit recognition

    Returns (weight_or_None, led_crop_img, ssocr_input_img, results_list).
    The third element is the preprocessed image actually fed to ssocr (for debug).
    """
    scale_crop = _crop_to_roi(img, SCALE_ROI)

    # Step 1: Build red mask (bright, saturated red in HSV)
    hsv = cv2.cvtColor(scale_crop, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    red_hue = ((h < 10) | (h > 170)).astype(np.uint8)
    high_sat = (s > 100).astype(np.uint8)
    bright = (v > 80).astype(np.uint8)
    red_mask = (red_hue & high_sat & bright).astype(np.uint8) * 255

    if cv2.findNonZero(red_mask) is None:
        return None, scale_crop, None, []

    # Step 2: "Black Box" contrast filter — keep red pixels near dark pixels
    # LED displays are red-on-black; fire extinguishers are red-on-white/concrete
    dark_mask = (v < 50).astype(np.uint8) * 255
    dk = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    dark_dilated = cv2.dilate(dark_mask, dk, iterations=2)
    red_near_dark = cv2.bitwise_and(red_mask, dark_dilated)

    # Step 3: Cluster red-near-dark pixels and score candidates
    # Moderate dilation to merge LED digit segments into one contour
    merge_k = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 5))
    merged = cv2.dilate(red_near_dark, merge_k, iterations=3)
    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    mh, mw = scale_crop.shape[:2]
    best_score = -1
    best_rect = None

    edges = cv2.Canny(red_mask, 50, 150)

    for cnt in contours:
        x, y, w, h_c = cv2.boundingRect(cnt)
        bbox_area = w * h_c

        # Filter 1: Size — reject too large (>8% of image) or too small
        if bbox_area < 50 or bbox_area > mw * mh * 0.08:
            continue

        # Filter 2: Minimum width — LED digits span meaningful distance
        if w < mw * 0.02:
            continue

        # Filter 3: Aspect ratio — LED displays are wider than tall
        aspect = w / max(h_c, 1)
        if aspect < 1.2 or aspect > 8.0:
            continue

        # Filter 4: Red fill ratio within bounding box
        roi_red = red_mask[y:y+h_c, x:x+w]
        red_fill = cv2.countNonZero(roi_red) / max(bbox_area, 1)
        if red_fill > 0.45:
            continue

        # Filter 5: Edge density — LED is choppy, fire equipment is smooth
        roi_edges = edges[y:y+h_c, x:x+w]
        edge_density = cv2.countNonZero(roi_edges) / max(bbox_area, 1)

        # Filter 6: Solidity
        hull = cv2.convexHull(cnt)
        hull_area = cv2.contourArea(hull)
        solidity = cv2.contourArea(cnt) / max(hull_area, 1)

        # Score: edge density * size, penalize high solidity
        solidity_bonus = 1.0 if solidity < 0.6 else 0.4
        score = edge_density * solidity_bonus * bbox_area

        if score > best_score:
            best_score = score
            best_rect = (x, y, w, h_c)

    if best_rect is None:
        # Fallback: heatmap peak on red-near-dark (or red_mask)
        src = red_near_dark if cv2.findNonZero(red_near_dark) is not None else red_mask
        if cv2.findNonZero(src) is None:
            return None, scale_crop, None, []
        blur_k = max(mw // 10, 31)
        if blur_k % 2 == 0:
            blur_k += 1
        heatmap = cv2.GaussianBlur(src, (blur_k, blur_k), 0)
        _, _, _, max_loc = cv2.minMaxLoc(heatmap)
        cx, cy = max_loc
        crop_w = int(mw * 0.18)
        crop_h = int(crop_w * 0.4)
        best_rect = (cx - crop_w // 2, cy - crop_h // 2, crop_w, crop_h)

    # Crop with padding
    bx, by, bw, bh = best_rect
    pad_x = max(10, int(bw * 0.4))
    pad_y = max(10, int(bh * 0.6))
    x1 = max(0, bx - pad_x)
    y1 = max(0, by - pad_y)
    x2 = min(mw, bx + bw + pad_x)
    y2 = min(mh, by + bh + pad_y)
    screen_crop = scale_crop[y1:y2, x1:x2]

    sh, sw = screen_crop.shape[:2]
    if sh < 5 or sw < 5:
        return None, screen_crop, None, []

    # Step 4: Perspective correction (deskew)
    deskewed = _deskew_led(screen_crop)

    # Step 5: Red channel isolation + 4x upscale for ssocr
    r_ch = deskewed[:, :, 2]
    r_ch_up = cv2.resize(r_ch, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)

    # This is the image ssocr will actually process — save for debug
    ssocr_input = r_ch_up.copy()

    # Save to temp file and run ssocr
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        tmp_path = tmp.name
        cv2.imwrite(tmp_path, r_ch_up)

    try:
        result = subprocess.run(
            ['ssocr', '-d', '-1', '-T', '-c', 'decimal',
             'grayscale', 'invert', tmp_path],
            capture_output=True, text=True, timeout=10
        )
        raw_text = result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        raw_text = ''
    finally:
        os.unlink(tmp_path)

    # Parse ssocr output
    weight = None
    all_results = [([], raw_text, 1.0)] if raw_text else []
    if raw_text:
        cleaned = raw_text.replace(' ', '').replace('_', '')
        nums = WEIGHT_PATTERN.findall(cleaned)
        for n in nums:
            try:
                val = float(n)
                if 1 <= val <= 99999:
                    weight = val
                    break
            except ValueError:
                pass

    return weight, screen_crop, ssocr_input, all_results


def _ocr_scale_weight_from_crop(scale_crop):
    """Extract weight from a pre-cropped scale display region (from VLM).

    Same pipeline as _ocr_scale_weight but skips the _crop_to_roi step
    since the VLM already identified the scale region.

    Returns (weight_or_None, led_crop_img, ssocr_input_img, results_list).
    """
    # Step 1: Build red mask (bright, saturated red in HSV)
    hsv = cv2.cvtColor(scale_crop, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    red_hue = ((h < 10) | (h > 170)).astype(np.uint8)
    high_sat = (s > 100).astype(np.uint8)
    bright = (v > 80).astype(np.uint8)
    red_mask = (red_hue & high_sat & bright).astype(np.uint8) * 255

    if cv2.findNonZero(red_mask) is None:
        return None, scale_crop, None, []

    # Step 2: "Black Box" contrast filter
    dark_mask = (v < 50).astype(np.uint8) * 255
    dk = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    dark_dilated = cv2.dilate(dark_mask, dk, iterations=2)
    red_near_dark = cv2.bitwise_and(red_mask, dark_dilated)

    # Step 3: Cluster and score candidates
    merge_k = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 5))
    merged = cv2.dilate(red_near_dark, merge_k, iterations=3)
    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    mh, mw = scale_crop.shape[:2]
    best_score = -1
    best_rect = None

    edges = cv2.Canny(red_mask, 50, 150)

    for cnt in contours:
        x, y, w, h_c = cv2.boundingRect(cnt)
        bbox_area = w * h_c

        if bbox_area < 50 or bbox_area > mw * mh * 0.08:
            continue
        if w < mw * 0.02:
            continue
        aspect = w / max(h_c, 1)
        if aspect < 1.2 or aspect > 8.0:
            continue
        roi_red = red_mask[y:y+h_c, x:x+w]
        red_fill = cv2.countNonZero(roi_red) / max(bbox_area, 1)
        if red_fill > 0.45:
            continue
        roi_edges = edges[y:y+h_c, x:x+w]
        edge_density = cv2.countNonZero(roi_edges) / max(bbox_area, 1)
        hull = cv2.convexHull(cnt)
        hull_area = cv2.contourArea(hull)
        solidity = cv2.contourArea(cnt) / max(hull_area, 1)
        solidity_bonus = 1.0 if solidity < 0.6 else 0.4
        score = edge_density * solidity_bonus * bbox_area

        if score > best_score:
            best_score = score
            best_rect = (x, y, w, h_c)

    if best_rect is None:
        src = red_near_dark if cv2.findNonZero(red_near_dark) is not None else red_mask
        if cv2.findNonZero(src) is None:
            return None, scale_crop, None, []
        blur_k = max(mw // 10, 31)
        if blur_k % 2 == 0:
            blur_k += 1
        heatmap = cv2.GaussianBlur(src, (blur_k, blur_k), 0)
        _, _, _, max_loc = cv2.minMaxLoc(heatmap)
        cx, cy = max_loc
        crop_w = int(mw * 0.18)
        crop_h = int(crop_w * 0.4)
        best_rect = (cx - crop_w // 2, cy - crop_h // 2, crop_w, crop_h)

    # Crop with padding
    bx, by, bw, bh = best_rect
    pad_x = max(10, int(bw * 0.4))
    pad_y = max(10, int(bh * 0.6))
    x1 = max(0, bx - pad_x)
    y1 = max(0, by - pad_y)
    x2 = min(mw, bx + bw + pad_x)
    y2 = min(mh, by + bh + pad_y)
    screen_crop = scale_crop[y1:y2, x1:x2]

    sh, sw = screen_crop.shape[:2]
    if sh < 5 or sw < 5:
        return None, screen_crop, None, []

    # Step 4: Perspective correction (deskew)
    deskewed = _deskew_led(screen_crop)

    # Step 5: Red channel isolation + 4x upscale for ssocr
    r_ch = deskewed[:, :, 2]
    r_ch_up = cv2.resize(r_ch, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    ssocr_input = r_ch_up.copy()

    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        tmp_path = tmp.name
        cv2.imwrite(tmp_path, r_ch_up)

    try:
        result = subprocess.run(
            ['ssocr', '-d', '-1', '-T', '-c', 'decimal',
             'grayscale', 'invert', tmp_path],
            capture_output=True, text=True, timeout=10
        )
        raw_text = result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        raw_text = ''
    finally:
        os.unlink(tmp_path)

    weight = None
    all_results = [([], raw_text, 1.0)] if raw_text else []
    if raw_text:
        cleaned = raw_text.replace(' ', '').replace('_', '')
        nums = WEIGHT_PATTERN.findall(cleaned)
        for n in nums:
            try:
                val = float(n)
                if 1 <= val <= 99999:
                    weight = val
                    break
            except ValueError:
                pass

    return weight, screen_crop, ssocr_input, all_results


def _doctr_find_weight(img):
    """Run Doctr on an image and extract weight candidates.

    Returns (weight_or_None, img, results_list).
    Bboxes are in pixel coords of the input image.
    """
    model = _get_doctr_model()
    img_h, img_w = img.shape[:2]

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    result = model([rgb])
    export = result.export()

    all_results = []
    candidates = []
    for page in export['pages']:
        for block in page['blocks']:
            for line in block['lines']:
                for word in line['words']:
                    text = word['value']
                    conf = word['confidence']
                    (x1n, y1n), (x2n, y2n) = word['geometry']
                    wx1 = int(x1n * img_w)
                    wy1 = int(y1n * img_h)
                    wx2 = int(x2n * img_w)
                    wy2 = int(y2n * img_h)
                    bbox = [[wx1, wy1], [wx2, wy1], [wx2, wy2], [wx1, wy2]]
                    all_results.append((bbox, text, conf))

                    # Fix common 7-segment LED misreads before matching
                    cleaned = text.strip().translate(LED_SUBS)
                    nums = WEIGHT_PATTERN.findall(cleaned)
                    for n in nums:
                        try:
                            val = float(n)
                            if 1 <= val <= 99999:
                                candidates.append((val, conf))
                        except ValueError:
                            pass

    weight = None
    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        weight = candidates[0][0]

    return weight, img, all_results



# ── Debug visualization ──────────────────────────────────────────────
_FONT = cv2.FONT_HERSHEY_SIMPLEX
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)
_GREEN = (0, 255, 0)
_CYAN = (255, 255, 0)
_YELLOW = (0, 255, 255)
_RED = (0, 0, 255)
_GRAY = (80, 80, 80)


def _fit_to_cell(img, cell_w, cell_h):
    """Resize img to fit inside cell_w x cell_h, preserving aspect ratio, pad to exact size."""
    h, w = img.shape[:2]
    # Convert grayscale to BGR for compositing
    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    scale = min(cell_w / w, cell_h / h)
    new_w, new_h = int(w * scale), int(h * scale)
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


def _save_ocr_result_image(debug_dir, filename, img,
                           tag_preprocessed, tag_results,
                           scale_preprocessed, ssocr_input, scale_results,
                           result):
    """Save a composite debug image: {filename}_OCRresult.jpg

    Layout (2x3):
      Row 1: Original (with ROI boxes) | Tag pipeline (Doctr)
      Row 2: LED crop (color)          | ssocr input (what ssocr sees)
      Row 3: Results summary (full width)
    """
    os.makedirs(debug_dir, exist_ok=True)

    h_orig, w_orig = img.shape[:2]
    CELL_W = min(800, w_orig)
    CELL_H = int(CELL_W * 3 / 4)
    HALF_H = CELL_H // 2  # shorter row for summary

    # ── Panel 1: Original image with ROI boxes ───────────────
    p1 = _fit_to_cell(img, CELL_W, CELL_H)
    _label_panel(p1, "ORIGINAL (with ROI)")

    # ── Panel 2: Tag pipeline ────────────────────────────────
    p2_img = tag_preprocessed.copy() if tag_preprocessed is not None else img.copy()
    for (bbox, text, conf) in tag_results:
        upper = text.upper().strip()
        color = _CYAN if TAG_PATTERN.search(upper) else _GREEN
        pts = np.array(bbox, dtype=np.int32)
        cv2.polylines(p2_img, [pts], True, color, 2)
        label = f"{text} {conf:.2f}"
        cv2.putText(p2_img, label, (pts[0][0], pts[0][1] - 4),
                    _FONT, 0.45, color, 1, cv2.LINE_AA)
    p2 = _fit_to_cell(p2_img, CELL_W, CELL_H)
    _label_panel(p2, "TAG PIPELINE (Doctr)")
    cv2.putText(p2, "cyan=tag match  green=other", (8, CELL_H - 10),
                _FONT, 0.4, (180, 180, 180), 1, cv2.LINE_AA)

    # ── Panel 3: LED crop (color) ────────────────────────────
    if scale_preprocessed is not None and scale_preprocessed.size > 0:
        p3 = _fit_to_cell(scale_preprocessed, CELL_W, CELL_H)
        _label_panel(p3, "LED CROP (deskewed)")
    else:
        p3 = np.zeros((CELL_H, CELL_W, 3), dtype=np.uint8)
        _label_panel(p3, "LED CROP — NOT FOUND")

    # ── Panel 4: ssocr input (what ssocr actually processes) ─
    ssocr_text = scale_results[0][1] if scale_results else '(no read)'
    if ssocr_input is not None and ssocr_input.size > 0:
        p4 = _fit_to_cell(ssocr_input, CELL_W, CELL_H)
        _label_panel(p4, f"SSOCR INPUT (red ch 4x) | result: {ssocr_text}")
    else:
        p4 = np.zeros((CELL_H, CELL_W, 3), dtype=np.uint8)
        _label_panel(p4, "SSOCR INPUT — N/A")

    # ── Panel 5: Results summary (full width) ────────────────
    p5 = np.zeros((HALF_H, CELL_W * 2, 3), dtype=np.uint8)
    _label_panel(p5, "RESULTS SUMMARY")

    tag = result.get('tag')
    sw = result.get('scale_weight')
    status = result.get('status', '?')
    err = result.get('error_message')

    # Left column: main results
    x, y = 12, 48
    line_h = 20
    items = [
        ("filename:", filename, _WHITE),
        ("status:", status, _GREEN if status == 'done' else _YELLOW),
        ("tag:", tag or "NOT FOUND", _CYAN if tag else _RED),
        ("scale_weight:", str(sw) if sw is not None else "NOT FOUND",
         _WHITE if sw is not None else _RED),
    ]
    if err:
        items.append(("error:", err, _YELLOW))
    for (label, value, color) in items:
        if y > HALF_H - 10:
            break
        cv2.putText(p5, label, (x, y), _FONT, 0.45, (150, 150, 150), 1, cv2.LINE_AA)
        cv2.putText(p5, value, (x + 140, y), _FONT, 0.5, color, 1, cv2.LINE_AA)
        y += line_h

    # Right column: ssocr raw output
    rx = CELL_W + 12
    ry = 48
    cv2.putText(p5, "ssocr raw:", (rx, ry), _FONT, 0.45, (150, 150, 150), 1, cv2.LINE_AA)
    raw_val = repr(scale_results[0][1]) if scale_results else "(no LED crop)"
    raw_color = _YELLOW if scale_results else _RED
    cv2.putText(p5, raw_val, (rx + 140, ry), _FONT, 0.5, raw_color, 1, cv2.LINE_AA)

    # ── Compose grid ─────────────────────────────────────────
    top_row = np.hstack([p1, p2])
    mid_row = np.hstack([p3, p4])
    composite = np.vstack([top_row, mid_row, p5])

    base = os.path.splitext(filename)[0]
    out_path = os.path.join(debug_dir, f"{base}_OCRresult.jpg")
    cv2.imwrite(out_path, composite, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return out_path


# ── Main processing ──────────────────────────────────────────────────


def _crop_to_roi(img, ocr_roi, grid_size=8):
    """Crop image to the bounding box of selected ROI cells.

    Grid is grid_size x grid_size (default 8x8).
    X axis = columns 1..grid_size (left to right),
    Y axis = rows 1..grid_size (bottom to top, origin at bottom-left).

    Args:
        img: BGR image array.
        ocr_roi: List of [x, y] cell coordinates.
        grid_size: Grid dimension (default 8).

    Returns cropped BGR image.
    """
    img_h, img_w = img.shape[:2]
    cell_w = img_w / grid_size
    cell_h = img_h / grid_size

    xs = [c[0] for c in ocr_roi]
    ys = [c[1] for c in ocr_roi]

    px_x1 = int((min(xs) - 1) * cell_w)
    px_x2 = int(max(xs) * cell_w)
    px_y1 = int(img_h - max(ys) * cell_h)
    px_y2 = int(img_h - (min(ys) - 1) * cell_h)

    return img[px_y1:px_y2, px_x1:px_x2]


def process_image(library_root, image_id, debug_dir=None, weight_unit='kg', ocr_roi=None, image_root=None):
    """Process a single image for OCR.

    Args:
        library_root: Path to library root (where .library/ lives).
        image_id: Database image ID.
        debug_dir: If set, save annotated debug images to this directory.
        weight_unit: 'kg' or 'lbs' — affects scale weight whitelist.
        ocr_roi: Optional list of [x,y] grid cells for ROI cropping.
        image_root: Path where image folders live. Defaults to library_root.

    Returns a dict with tag, scale_weight, handwritten_weight, status, error_message.
    """
    if image_root is None:
        image_root = library_root
    conn = get_connection()
    image = row_to_dict(conn.execute(
        "SELECT * FROM images WHERE id = ?", (image_id,)
    ).fetchone())
    conn.close()

    if not image:
        return {'tag': None, 'scale_weight': None, 'handwritten_weight': None,
                'status': 'needs_review', 'error_message': 'Image not found in database',
                'raw_output': {}}

    filepath = os.path.join(image_root, image['filepath'])
    if not os.path.exists(filepath):
        return {'tag': None, 'scale_weight': None, 'handwritten_weight': None,
                'status': 'needs_review', 'error_message': 'Image file not found on disk',
                'raw_output': {}}

    result = {
        'tag': None,
        'scale_weight': None,
        'handwritten_weight': None,
        'status': 'needs_review',
        'error_message': None,
        'raw_output': {},
    }

    try:
        img = _load_image(filepath)
        img = _deskew(img)

        # Crop tag region: grid ROI if provided, else full image
        if ocr_roi:
            tag_crop = _crop_to_roi(img, ocr_roi)
        else:
            tag_crop = img

        # Track which pipeline is being used for each region
        tag_pipeline = 'grid_roi' if ocr_roi else 'full_image'
        scale_pipeline = 'grid_roi'
        result['pipeline'] = {'tag': tag_pipeline, 'scale': scale_pipeline}

        # Pipeline 1: Tag extraction via Doctr
        tag, tag_preprocessed, tag_results = _ocr_tag(tag_crop)
        if tag is None and tag_crop is not img:
            tag, tag_preprocessed, tag_results = _ocr_tag(img)
            tag_crop = img
        result['tag'] = tag
        result['raw_output']['tag_raw'] = tag

        # Rename file to {tag}.ext only if tag is a valid EVS tag
        is_evs = tag and EVS_TAG_PATTERN.match(tag)
        if is_evs:
            ext = os.path.splitext(image['filename'])[1]
            new_name = f"{tag}{ext}"
            if new_name != image['filename']:
                folder_path = os.path.dirname(image['filepath'])
                new_filepath = os.path.join(folder_path, new_name)
                new_full = os.path.join(image_root, new_filepath)
                if not os.path.exists(new_full):
                    os.rename(filepath, new_full)
                    conn2 = get_connection()
                    conn2.execute(
                        "UPDATE images SET filename = ?, filepath = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?",
                        (new_name, new_filepath, image_id)
                    )
                    conn2.commit()
                    conn2.close()
                    image['filename'] = new_name
                    image['filepath'] = new_filepath
                    result['renamed'] = new_name

        # Save Tag crop for viewer panel
        if tag_crop is not None and tag_crop.size > 0:
            tag_dir = os.path.join(library_root, '.library', 'tag_crops')
            os.makedirs(tag_dir, exist_ok=True)
            tag_base = os.path.splitext(image['filename'])[0]
            cv2.imwrite(os.path.join(tag_dir, f'{tag_base}_tagroi.jpg'),
                        tag_crop, [cv2.IMWRITE_JPEG_QUALITY, 90])

        # Pipeline 2: Scale weight via Doctr on SCALE_ROI crop
        scale_crop = _crop_to_roi(img, SCALE_ROI)
        scale_weight, scale_img, scale_results = _doctr_find_weight(scale_crop)
        result['raw_output']['scale_weight_raw'] = scale_weight
        if scale_weight is not None:
            result['scale_weight'] = round(scale_weight)

        # Save scale display crop for viewer panel
        if scale_crop is not None and scale_crop.size > 0:
            led_dir = os.path.join(library_root, '.library', 'led_crops')
            os.makedirs(led_dir, exist_ok=True)
            base = os.path.splitext(image['filename'])[0]
            cv2.imwrite(os.path.join(led_dir, f'{base}_ledcrop.jpg'),
                        scale_crop, [cv2.IMWRITE_JPEG_QUALITY, 90])

        # Pipeline 3: Handwritten weight — postponed
        hw_weight = None
        hw_preprocessed = None
        hw_results = []

        # Non-EVS tags: null out weight fields (not a valid pallet)
        if tag and not is_evs:
            result['scale_weight'] = None
            result['handwritten_weight'] = None

        # Determine status
        errors = []
        if tag is None:
            errors.append('tag not found')
        if scale_weight is None:
            errors.append('scale weight not found')

        if errors:
            result['status'] = 'needs_review'
            result['error_message'] = '; '.join(errors)
        else:
            result['status'] = 'done'

        # Save debug output if requested
        if debug_dir:
            debug_img = img.copy()
            img_h, img_w = img.shape[:2]
            cell_w = img_w / 8
            cell_h = img_h / 8
            if ocr_roi:
                xs = [c[0] for c in ocr_roi]
                ys = [c[1] for c in ocr_roi]
                px_x1 = int((min(xs) - 1) * cell_w)
                px_x2 = int(max(xs) * cell_w)
                px_y1 = int(img_h - max(ys) * cell_h)
                px_y2 = int(img_h - (min(ys) - 1) * cell_h)
                cv2.rectangle(debug_img, (px_x1, px_y1), (px_x2, px_y2), _CYAN, 4)
                cv2.putText(debug_img, "TAG ROI", (px_x1 + 8, px_y1 + 30),
                            _FONT, 0.8, _CYAN, 2, cv2.LINE_AA)
            sxs = [c[0] for c in SCALE_ROI]
            sys_ = [c[1] for c in SCALE_ROI]
            spx_x1 = int((min(sxs) - 1) * cell_w)
            spx_x2 = int(max(sxs) * cell_w)
            spx_y1 = int(img_h - max(sys_) * cell_h)
            spx_y2 = int(img_h - (min(sys_) - 1) * cell_h)
            cv2.rectangle(debug_img, (spx_x1, spx_y1), (spx_x2, spx_y2), _YELLOW, 4)
            cv2.putText(debug_img, "SCALE ROI", (spx_x1 + 8, spx_y1 + 30),
                        _FONT, 0.8, _YELLOW, 2, cv2.LINE_AA)
            _save_ocr_result_image(
                debug_dir, image['filename'], debug_img,
                tag_preprocessed, tag_results,
                scale_img, None, scale_results,
                result
            )

    except Exception as e:
        result['status'] = 'needs_review'
        result['error_message'] = str(e)
        result['raw_output']['exception'] = traceback.format_exc()

    return result


def save_ocr_result(image_id, result):
    """Save OCR result to the database."""
    conn = get_connection()

    raw_json = json.dumps(result.get('raw_output', {}))

    # Upsert: insert or replace existing result
    conn.execute(
        """INSERT INTO ocr_results (image_id, tag, scale_weight, handwritten_weight,
                                     status, raw_output, error_message, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(image_id) DO UPDATE SET
               tag = excluded.tag,
               scale_weight = excluded.scale_weight,
               handwritten_weight = excluded.handwritten_weight,
               status = excluded.status,
               raw_output = excluded.raw_output,
               error_message = excluded.error_message,
               processed_at = excluded.processed_at""",
        (image_id, result['tag'], result['scale_weight'],
         result['handwritten_weight'], result['status'],
         raw_json, result.get('error_message'),
         datetime.now().isoformat())
    )
    conn.commit()
    conn.close()


def process_batch(library_root, image_ids, progress_callback=None, debug_dir=None, weight_unit='kg', ocr_roi=None, image_root=None):
    """Process a batch of images for OCR.

    Args:
        library_root: Path to library root (where .library/ lives).
        image_ids: List of image IDs to process.
        progress_callback: Optional fn(image_id, index, total, result) called after each.
        debug_dir: If set, save annotated debug images to this directory.
        weight_unit: 'kg' or 'lbs' — affects scale weight whitelist.
        ocr_roi: Optional list of [x,y] grid cells for ROI cropping.
        image_root: Path where image folders live. Defaults to library_root.

    Returns:
        Summary dict with counts.
    """
    summary = {'total': len(image_ids), 'done': 0, 'needs_review': 0, 'errors': 0}

    for idx, image_id in enumerate(image_ids):
        result = process_image(library_root, image_id, debug_dir=debug_dir, weight_unit=weight_unit, ocr_roi=ocr_roi, image_root=image_root)
        save_ocr_result(image_id, result)

        if result['status'] == 'done':
            summary['done'] += 1
        else:
            summary['needs_review'] += 1
            if result.get('error_message'):
                summary['errors'] += 1

        if progress_callback:
            progress_callback(image_id, idx, len(image_ids), result)

    return summary


def get_pending_ocr_ids(library_root=None):
    """Get image IDs that are marked for OCR but haven't been processed."""
    conn = get_connection()
    rows = conn.execute(
        """SELECT i.id FROM images i
           LEFT JOIN ocr_results o ON i.id = o.image_id
           WHERE i.status = 'marked_ocr' AND o.id IS NULL
           ORDER BY i.id"""
    ).fetchall()
    conn.close()
    return [r['id'] for r in rows]


def get_folder_ocr_ids(folder_id):
    """Get image IDs marked for OCR in a specific folder."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT id FROM images WHERE folder_id = ? AND status = 'marked_ocr' ORDER BY id",
        (folder_id,)
    ).fetchall()
    conn.close()
    return [r['id'] for r in rows]


def get_folder_all_ids(folder_name):
    """Look up a folder by name and return all non-deleted image IDs in it."""
    conn = get_connection()
    folder = conn.execute(
        "SELECT id FROM folders WHERE name = ?", (folder_name,)
    ).fetchone()
    if not folder:
        conn.close()
        return None
    rows = conn.execute(
        "SELECT id FROM images WHERE folder_id = ? AND status != 'deleted' ORDER BY id",
        (folder['id'],)
    ).fetchall()
    conn.close()
    return [r['id'] for r in rows]


def get_folder_unit(folder_name):
    """Look up a folder's weight_unit by name."""
    conn = get_connection()
    row = conn.execute(
        "SELECT weight_unit FROM folders WHERE name = ?", (folder_name,)
    ).fetchone()
    conn.close()
    if row:
        return row['weight_unit'] or 'kg'
    return 'kg'


def get_folder_roi(folder_name):
    """Look up a folder's ocr_roi by name. Returns parsed list or None."""
    conn = get_connection()
    row = conn.execute(
        "SELECT ocr_roi FROM folders WHERE name = ?", (folder_name,)
    ).fetchone()
    conn.close()
    if row and row['ocr_roi']:
        try:
            return json.loads(row['ocr_roi'])
        except (json.JSONDecodeError, TypeError):
            pass
    return None


# ── CLI entry point ──────────────────────────────────────────────────


def main():
    """CLI entry point for standalone OCR processing."""
    import argparse

    parser = argparse.ArgumentParser(description='OCR processing for shipment photos')
    parser.add_argument('--image-ids', nargs='+', type=int, help='Specific image IDs to process')
    parser.add_argument('--folder-id', type=int, help='Process all OCR-marked images in folder')
    parser.add_argument('--folder', type=str, help='Folder name to process ALL images in (default: TestOCR)')
    parser.add_argument('--debug', action='store_true', help='Save debug images to .library/ocr_debug/')
    parser.add_argument('--library-root', default=os.getcwd(), help='Library root path')
    parser.add_argument('--unit', choices=['kg', 'lbs'], default=None, help='Weight unit (default: from folder DB setting)')
    args = parser.parse_args()

    library_root = args.library_root
    debug_dir = os.path.join(library_root, '.library', 'ocr_debug') if args.debug else None

    # Determine weight unit and OCR ROI
    weight_unit = args.unit  # May be None — resolved below
    ocr_roi = None

    # Determine which images to process
    if args.image_ids:
        image_ids = args.image_ids
        if weight_unit is None:
            weight_unit = 'kg'
    elif args.folder_id:
        image_ids = get_folder_ocr_ids(args.folder_id)
        if weight_unit is None:
            weight_unit = 'kg'
    elif args.folder:
        image_ids = get_folder_all_ids(args.folder)
        if image_ids is None:
            print(f"Folder '{args.folder}' not found in database.")
            return
        if weight_unit is None:
            weight_unit = get_folder_unit(args.folder)
        ocr_roi = get_folder_roi(args.folder)
    else:
        # Default: --folder TestOCR
        image_ids = get_folder_all_ids('TestOCR')
        if image_ids is None:
            print("Default folder 'TestOCR' not found. Use --folder, --folder-id, or --image-ids.")
            return
        if weight_unit is None:
            weight_unit = get_folder_unit('TestOCR')
        ocr_roi = get_folder_roi('TestOCR')

    if not image_ids:
        print("No images to process.")
        return

    roi_str = f", roi={ocr_roi}" if ocr_roi else ""
    print(f"Processing {len(image_ids)} image(s) [unit={weight_unit}{roi_str}]...")
    if debug_dir:
        print(f"Debug output → {debug_dir}")

    def progress(image_id, idx, total, result):
        status = result['status']
        tag = result.get('tag') or '???'
        sw = result.get('scale_weight')
        hw = result.get('handwritten_weight')
        sw_str = str(int(sw)) if sw is not None else '???'
        hw_str = str(int(hw)) if hw is not None else '???'
        err = f" — {result['error_message']}" if result.get('error_message') else ''
        print(f"  [{idx+1}/{total}] Image {image_id}: {status} | tag={tag} scale={sw_str} hw={hw_str}{err}")

    summary = process_batch(library_root, image_ids, progress_callback=progress,
                            debug_dir=debug_dir, weight_unit=weight_unit, ocr_roi=ocr_roi)

    print(f"\nDone: {summary['done']} OK, {summary['needs_review']} needs review, {summary['errors']} errors")


if __name__ == '__main__':
    main()
