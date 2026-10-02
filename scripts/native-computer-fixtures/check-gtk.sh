#!/usr/bin/env bash
# Development runner: own authenticated Xvfb and own disposable D-Bus session.
# DBUS_TEST_CONFIG selects the Nix config; otherwise use the D-Bus default.
# No inherited DISPLAY/session-bus fallback or host-session changes.
set -euo pipefail
here="$(cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$here/run_gtk_checks.py"
