"""Thumbnail generation using Pillow with EXIF orientation handling."""

import os

from PIL import Image, ImageOps

THUMB_SIZE = 300
THUMB_QUALITY = 85

COMPRESSION_THRESHOLD = 6 * 1024 * 1024  # 6 MB
COMPRESSION_QUALITY = 82
COMPRESSIBLE_EXTENSIONS = {'.jpg', '.jpeg'}
CONVERTIBLE_EXTENSIONS = {'.png'}


def compress_image(source_path):
    """Compress or convert a large image during import.

    - JPEG (>6MB): re-encoded at quality 82, same filename.
    - PNG  (>6MB): converted to JPEG, original .png deleted, .jpg path returned.
    - All other formats or files <=6MB: skipped.

    Returns the (possibly new) path on success, or None if skipped/failed.
    EXIF orientation and metadata are preserved.
    """
    size = os.path.getsize(source_path)
    name = os.path.basename(source_path)
    ext = os.path.splitext(source_path)[1].lower()

    if size <= COMPRESSION_THRESHOLD:
        print(f"compress_image: skip {name} ({size // 1024}KB <= threshold)")
        return None
    if ext not in COMPRESSIBLE_EXTENSIONS and ext not in CONVERTIBLE_EXTENSIONS:
        print(f"compress_image: skip {name} (ext {ext!r} not compressible)")
        return None

    is_png = ext in CONVERTIBLE_EXTENSIONS
    if is_png:
        new_path = os.path.splitext(source_path)[0] + '.jpg'
        tmp_path = new_path + '.tmp_compress'
    else:
        new_path = source_path
        tmp_path = source_path + '.tmp_compress'

    action = 'converting' if is_png else 'compressing'
    print(f"compress_image: {action} {name} ({size // 1024}KB)")
    try:
        with Image.open(source_path) as img:
            exif = img.getexif()  # Exif object; Pillow serialises it correctly on save
            if img.mode != 'RGB':
                img = img.convert('RGB')
            save_kwargs = {'quality': COMPRESSION_QUALITY, 'optimize': True}
            if exif:
                save_kwargs['exif'] = exif
            img.save(tmp_path, 'JPEG', **save_kwargs)
        compressed_size = os.path.getsize(tmp_path)
        if compressed_size < size:
            os.replace(tmp_path, new_path)
            if is_png:
                try:
                    os.unlink(source_path)
                except OSError as rm_err:
                    print(f"compress_image: warning — could not remove original {name}: {rm_err}")
            print(f"compress_image: {name} → {os.path.basename(new_path)} "
                  f"{size // 1024}KB → {compressed_size // 1024}KB")
            return new_path
        os.unlink(tmp_path)
        print(f"compress_image: skip {name} (compressed {compressed_size // 1024}KB not smaller)")
        return None
    except Exception as e:
        print(f"compress_image: FAILED for {name}: {e}")
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return None


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
