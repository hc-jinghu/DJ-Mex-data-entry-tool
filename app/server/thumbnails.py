"""Thumbnail generation using Pillow with EXIF orientation handling."""

import os

from PIL import Image, ImageOps

THUMB_SIZE = 300
THUMB_QUALITY = 85


def generate_thumbnail(source_path, thumb_dir, filename):
    """Generate a thumbnail for a single image.

    Args:
        source_path: Full path to the source image.
        thumb_dir: Directory to write the thumbnail into.
        filename: Original filename (used to derive thumbnail name).

    Returns:
        Relative thumbnail path (from .library/thumbnails/) or None on failure.
    """
    os.makedirs(thumb_dir, exist_ok=True)

    base, _ = os.path.splitext(filename)
    thumb_filename = f"{base}_thumb.jpg"
    thumb_path = os.path.join(thumb_dir, thumb_filename)

    try:
        with Image.open(source_path) as img:
            # Apply EXIF orientation
            img = ImageOps.exif_transpose(img)

            # Thumbnail preserving aspect ratio
            img.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)

            # Convert to RGB if necessary (handles RGBA, P mode, etc.)
            if img.mode not in ('RGB',):
                img = img.convert('RGB')

            img.save(thumb_path, 'JPEG', quality=THUMB_QUALITY)

        return thumb_filename
    except Exception as e:
        print(f"Thumbnail generation failed for {filename}: {e}")
        return None


def get_image_dimensions(filepath):
    """Get image width and height, respecting EXIF orientation."""
    try:
        with Image.open(filepath) as img:
            img = ImageOps.exif_transpose(img)
            return img.width, img.height
    except Exception:
        return None, None
