"""Filesystem watcher for IMAGE_ROOT using watchdog.

Watches IMAGE_ROOT recursively and debounces bursts of events into one
notification after 500 ms.  Hidden paths (starting with '.', e.g. .library/)
are filtered at the event level, so thumbnail directories are never watched.

Emits two distinct event types:
  root_changed   — a top-level entry was created or deleted (folder list changed)
  folder_changed — files inside a specific subfolder changed (content changed)
                   data: {"path": "<relative-folder-path>"}
"""

import os
import threading

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .events import publish_event

_DEBOUNCE_S = 0.5   # seconds to wait for the burst to settle


class _ImageRootHandler(FileSystemEventHandler):
    def __init__(self, image_root: str):
        super().__init__()
        self._image_root = image_root
        self._lock = threading.Lock()
        # Pending timers keyed by (event_type, relative_folder)
        self._timers: dict[tuple, threading.Timer] = {}

    def _schedule(self, event_type: str, folder_path: str | None) -> None:
        key = (event_type, folder_path)
        with self._lock:
            existing = self._timers.pop(key, None)
            if existing:
                existing.cancel()
            timer = threading.Timer(
                _DEBOUNCE_S,
                self._fire,
                args=(event_type, folder_path),
            )
            self._timers[key] = timer
            timer.daemon = True
            timer.start()

    def _fire(self, event_type: str, folder_path: str | None) -> None:
        with self._lock:
            self._timers.pop((event_type, folder_path), None)
        data = {'path': folder_path} if folder_path else {}
        publish_event(event_type, data)

    def _classify(self, rel: str) -> None:
        """Schedule the right event based on path depth.

        Top-level entries (depth 1) → root_changed  (folder list changed)
        Entries inside a folder (depth 2+) → folder_changed  (content changed)
        """
        if rel.startswith('.'):
            return
        parts = rel.split(os.sep)
        if len(parts) == 1:
            self._schedule('root_changed', None)
        else:
            # folder path is everything except the final filename
            folder_rel = os.sep.join(parts[:-1])
            self._schedule('folder_changed', folder_rel)

    def on_any_event(self, event) -> None:
        src = event.src_path
        rel = os.path.relpath(src, self._image_root)
        self._classify(rel)

        # Also fire for the destination of a move
        dest = getattr(event, 'dest_path', None)
        if dest:
            dest_rel = os.path.relpath(dest, self._image_root)
            self._classify(dest_rel)


_observer: Observer | None = None


def start_watcher(image_root: str) -> None:
    """Start the watchdog observer thread. Safe to call multiple times
    (subsequent calls are no-ops if already running)."""
    global _observer
    if _observer is not None and _observer.is_alive():
        return

    if not os.path.isdir(image_root):
        return  # IMAGE_ROOT doesn't exist yet; skip silently

    handler = _ImageRootHandler(image_root)
    _observer = Observer()
    _observer.schedule(handler, image_root, recursive=True)
    _observer.daemon = True
    _observer.start()


def stop_watcher() -> None:
    """Stop the watchdog observer (called via atexit)."""
    global _observer
    if _observer is not None and _observer.is_alive():
        _observer.stop()
        _observer.join(timeout=2)
    _observer = None
