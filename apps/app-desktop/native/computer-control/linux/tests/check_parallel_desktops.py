"""Run all three real GTK harnesses concurrently; require disjoint owned displays.
Run in the development Nix shell. This is isolation coverage, NOT logind gates.
"""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[5]
JOBS = [
    ('gtk', [str(REPO/'scripts/native-computer-fixtures/check-gtk.sh')]),
    ('xvfb', [sys.executable,str(HERE/'native_xvfb.py')]),
    ('focus', [sys.executable,str(HERE/'native_focus.py')]),
]


def check():
    children = []
    with tempfile.TemporaryDirectory(prefix='native-parallel-') as directory:
        try:
            # Files avoid pipe backpressure; do not print tested Unicode/AX data.
            for name, argv in JOBS:
                log = Path(directory)/name
                with log.open('wb') as stream:
                    child = subprocess.Popen(argv,stdout=stream,stderr=subprocess.STDOUT)
                children.append((name,child,log))
            # All must reach readiness while every supervisor is still running.
            deadline = time.monotonic()+30
            ready = {}
            while len(ready) != len(children):
                for name, child, log in children:
                    text = log.read_text(errors='replace')
                    match = re.search(r'ISOLATED_DISPLAY display=:(\d+) xvfb_pid=(\d+)',text)
                    if match:
                        ready[name] = (int(match[1]),int(match[2]))
                    if child.poll() is not None:
                        raise AssertionError(f'{name}: exited before concurrent readiness, code={child.returncode}')
                if time.monotonic() > deadline:
                    raise AssertionError('parallel readiness timed out')
                time.sleep(.01)
            displays = [number for number,pid in ready.values()]
            pids = [pid for number,pid in ready.values()]
            assert len(set(displays)) == len(children), 'display collision'
            assert len(set(pids)) == len(children), 'shared server process'
            for pid in pids:
                os.kill(pid,0)
            print('PASS: simultaneous owned Xvfb readiness on distinct displays ' + ', '.join(':'+str(n) for n in sorted(displays)),flush=True)
            with ThreadPoolExecutor(max_workers=3) as pool:
                codes = list(pool.map(lambda row: row[1].wait(timeout=150),children))
            for (name,child,log),code in zip(children,codes):
                if code:
                    # Local disposable logs only; no tested AX/string dumps.
                    raise AssertionError(f'{name}: harness failed with code={code}')
                print(f'PASS: concurrent {name} GTK harness')
            for pid in pids:
                try:
                    os.kill(pid,0)
                except ProcessLookupError:
                    continue
                raise AssertionError('owned Xvfb survived supervisor cleanup')
            print('PASS: owned Xvfb processes cleaned up; no production logind acceptance')
        finally:
            for name,child,log in children:
                if child.poll() is None:
                    # Supervisor handles SIGTERM and cleans up ONLY its children.
                    child.send_signal(signal.SIGTERM)
                    child.wait(timeout=10)


def check_server_death():
    from isolated_desktop import IsolationError, OwnedDisplay
    # The unaffected server is also ours; never attach to a host display.
    with OwnedDisplay() as survivor, OwnedDisplay() as victim:
        marker = Path(victim.temporary.name)/'worker-ready'
        def terminate_owned_server():
            deadline = time.monotonic()+20
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            victim.process.terminate()
        killer = threading.Thread(target=terminate_owned_server)
        killer.start()
        try:
            try:
                victim.run(__file__,['--hold-worker',str(marker)],timeout=30)
            except IsolationError:
                pass
            else:
                raise AssertionError('server death did not revoke test worker')
            assert marker.exists(), 'worker did not reach hold point'
            survivor.require_alive()
            assert victim.worker is None, 'owned worker group not cleaned up'
        finally:
            killer.join(timeout=22)
    print('PASS: actual owned server death revokes blocked worker; other owned server survives')


if __name__=='__main__':
    if sys.argv[1:2]==['--hold-worker'] and globals().get('_OWNED_DESKTOP_WORKER'):
        Path(sys.argv[2]).write_text('ready')
        time.sleep(120)
    else:
        check()
        check_server_death()
