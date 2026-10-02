"""Internal worker: OwnedDisplay launches it inside a disposable D-Bus."""
import os
import json
import stat
from pathlib import Path
import runpy
import subprocess
import sys
import time
from isolated_desktop import IsolationError, stop_process


def main():
    if len(sys.argv) < 3:
        raise IsolationError('worker requires an inherited supervisor ticket')
    fd = int(sys.argv[1])
    if not stat.S_ISFIFO(os.fstat(fd).st_mode):
        raise IsolationError('invalid supervisor ticket pipe')
    ticket = json.loads(os.read(fd,4096))
    os.close(fd)
    if ticket.get('display') != os.environ.get('DISPLAY') or ticket.get('authority') != os.environ.get('XAUTHORITY'):
        raise IsolationError('desktop differs from supervisor ticket')
    os.kill(ticket['server'],0)  # supervisor independently monitors exact Popen
    if not os.environ.get('DISPLAY') or not os.environ.get('XAUTHORITY') or not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        raise IsolationError('missing disposable desktop environment')
    # Normal entry scripts ALWAYS create a fresh supervisor, regardless of
    # inherited DISPLAY/bus/marker variables. This is not a direct entry point.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from x11 import X11
    x = X11()
    wm = subprocess.Popen(['openbox', '--sm-disable'], stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic()+10
        while not x.prop(x.root, '_NET_SUPPORTING_WM_CHECK'):
            if wm.poll() is not None or time.monotonic() >= deadline:
                raise IsolationError('owned window manager not ready')
            time.sleep(.02)
        script = str(Path(sys.argv[2]).resolve())
        sys.argv = [script, *sys.argv[3:]]
        # A runpy global, NOT an environment flag/inherited-display bypass.
        runpy.run_path(script, run_name='__main__', init_globals={'_OWNED_DESKTOP_WORKER': True})
        return 0
    finally:
        stop_process(wm)


if __name__ == '__main__':
    sys.exit(main())
