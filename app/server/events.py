"""Thread-safe SSE (Server-Sent Events) pub/sub hub.

Usage:
    # Publisher side (watcher thread):
    from .events import publish_event
    publish_event('root_changed', {})
    publish_event('folder_changed', {'path': 'BROA'})

    # Subscriber side (SSE endpoint, runs in request thread):
    from .events import subscribe, unsubscribe
    q = subscribe()
    try:
        event = q.get(timeout=25)   # blocks until event or timeout
    finally:
        unsubscribe(q)
"""

import queue
import threading

_lock = threading.Lock()
_subscribers: list[queue.Queue] = []


def subscribe() -> queue.Queue:
    """Register a new SSE subscriber. Returns a Queue to read events from."""
    q: queue.Queue = queue.Queue(maxsize=20)
    with _lock:
        _subscribers.append(q)
    return q


def unsubscribe(q: queue.Queue) -> None:
    """Remove a subscriber queue (called when the SSE connection closes)."""
    with _lock:
        try:
            _subscribers.remove(q)
        except ValueError:
            pass


def publish_event(event_type: str, data: dict) -> None:
    """Broadcast an event to all connected SSE subscribers.

    Drops the event for any subscriber whose queue is full (slow consumer)
    rather than blocking the watcher thread.
    """
    payload = {'type': event_type, 'data': data}
    with _lock:
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _subscribers.remove(q)
