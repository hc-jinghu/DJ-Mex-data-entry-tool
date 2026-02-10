#!/usr/bin/env python3
"""Entry point for the Master Photo Library server."""

import os
import sys

# app/ directory (where this script and server/ live)
APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Library root is the parent directory (where image folders and .library/ live)
LIBRARY_ROOT = os.path.dirname(APP_DIR)
os.chdir(LIBRARY_ROOT)

# Add app/ to Python path so 'server' package is importable
sys.path.insert(0, APP_DIR)

from server.app import create_app

if __name__ == '__main__':
    app = create_app()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Master Photo Library running at http://localhost:{port}")
    app.run(host='127.0.0.1', port=port, debug=True)
