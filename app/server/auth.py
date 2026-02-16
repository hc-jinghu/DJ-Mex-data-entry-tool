"""Authentication config loading, credential validation, and session tracking."""

import json
import os

LIBRARY_DIR = os.path.join(os.getcwd(), '.library')
AUTH_CONFIG_PATH = os.path.join(LIBRARY_DIR, 'auth.json')
ACTIVE_SESSIONS_PATH = os.path.join(LIBRARY_DIR, 'active_sessions.json')
SECRET_KEY_PATH = os.path.join(LIBRARY_DIR, 'secret_key')


def load_auth_config():
    """Read .library/auth.json and return dict. Returns empty dict if missing."""
    if not os.path.exists(AUTH_CONFIG_PATH):
        return {}
    with open(AUTH_CONFIG_PATH, 'r') as f:
        return json.load(f)


def validate_credentials(role, username, password):
    """Check credentials against auth.json config.

    Config format:
    {
        "data_entry": {"username": "...", "password": "..."},
        "warehouse": {"username": "...", "password": "..."}
    }
    """
    config = load_auth_config()
    role_config = config.get(role)
    if not role_config:
        return False
    return (role_config.get('username') == username and
            role_config.get('password') == password)


def get_active_sessions():
    """Read active sessions from file. Returns dict like {role: {ip, username}}."""
    if not os.path.exists(ACTIVE_SESSIONS_PATH):
        return {}
    try:
        with open(ACTIVE_SESSIONS_PATH, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def set_active_session(role, ip, username):
    """Record an active session for a role."""
    sessions = get_active_sessions()
    sessions[role] = {'ip': ip, 'username': username}
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    with open(ACTIVE_SESSIONS_PATH, 'w') as f:
        json.dump(sessions, f, indent=2)


def clear_active_session(role):
    """Remove the active session for a role."""
    sessions = get_active_sessions()
    sessions.pop(role, None)
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    with open(ACTIVE_SESSIONS_PATH, 'w') as f:
        json.dump(sessions, f, indent=2)


def check_session_conflict(role, ip):
    """Return True if role has an active session from a different IP."""
    sessions = get_active_sessions()
    session = sessions.get(role)
    if not session:
        return False
    return session['ip'] != ip


def get_or_create_secret_key():
    """Return a stable secret key, generating one if needed."""
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    if os.path.exists(SECRET_KEY_PATH):
        with open(SECRET_KEY_PATH, 'r') as f:
            return f.read().strip()
    import secrets
    key = secrets.token_hex(32)
    with open(SECRET_KEY_PATH, 'w') as f:
        f.write(key)
    return key
