"""Compatibility entry point for the current UI regression suite.

Run: python scripts/e2e_check.py (or npm run test:e2e in the Python venv).
The suite lives in ui_check.py; this path remains stable for existing team commands.
"""
from ui_check import main

if __name__ == '__main__':
    raise SystemExit(main())
