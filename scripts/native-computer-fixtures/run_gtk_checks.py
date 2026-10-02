#!/usr/bin/env python3
"""Self-contained isolated GTK evaluation runner. No production gate claims."""
from pathlib import Path
import subprocess
import sys
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'apps/app-desktop/native/computer-control/linux/tests'))
from isolated_desktop import run_isolated

if not globals().get('_OWNED_DESKTOP_WORKER'):
    raise SystemExit(run_isolated(__file__))

for name in ('gtk_checks.py', 'gtk_atspi_checks.py', 'gtk_pipe_checks.py'):
    subprocess.run([sys.executable, str(HERE / name)], check=True, timeout=120)
print('PASS: isolated GTK evaluation runner; no production logind acceptance')
