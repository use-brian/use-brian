"""Disposable authenticated Xvfb + session D-Bus for development tests ONLY.

Never imports GTK or opens an inherited display. Xvfb chooses via a private
pipe; only a live owned PID and authenticated readiness permit the test worker.
"""
import os
import json
from pathlib import Path
import re
import secrets
import selectors
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time


class IsolationError(RuntimeError):
    pass


def private_environment(source, directory):
    env = dict(source)
    for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XAUTHORITY',
                'DBUS_SESSION_BUS_ADDRESS', 'DBUS_SESSION_BUS_PID', 'DBUS_SESSION_BUS_WINDOWID',
                'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'AT_SPI_BUS_ADDRESS', 'AT_SPI_DISPLAY', 'SESSION_MANAGER', 'DESKTOP_AUTOSTART_ID',
                'XDG_SESSION_ID', 'XDG_SEAT', 'XDG_VTNR', 'GDK_DISPLAY',
                'GTK_MODULES', 'GTK_PATH', 'XINITRC', 'XENVIRONMENT',
                'DESKTOP_STARTUP_ID', 'XDG_ACTIVATION_TOKEN', 'DESKTOP_SESSION', 'GDMSESSION'):
        env.pop(key, None)
    root = Path(directory)
    for key, name in (('HOME','home'), ('XDG_RUNTIME_DIR','runtime'),
                      ('XDG_CONFIG_HOME','config'), ('XDG_CACHE_HOME','cache'), ('XDG_DATA_HOME','data')):
        path = root / name
        path.mkdir(mode=0o700)
        env[key] = str(path)
    # Preserve packaging paths (GI_TYPELIB_PATH/XDG_DATA_DIRS), not host user
    # config, credentials, or inherited session/accessibility bus addresses.
    env.update(GDK_BACKEND='x11', QT_QPA_PLATFORM='xcb', XDG_SESSION_TYPE='x11',
               GTK_A11Y='always', NO_AT_BRIDGE='0', XDG_CURRENT_DESKTOP='',
               GTK_USE_PORTAL='0', GSETTINGS_BACKEND='memory')
    env['DBUS_SYSTEM_BUS_ADDRESS'] = 'unix:path=' + str(root / 'no-system-bus')
    return env


def write_authority(path, number, cookie):
    # Binary Xauthority: FamilyWild + MIT-MAGIC-COOKIE-1. No xauth dependency;
    # no inherited authority file is read or modified.
    fields = (b'', str(number).encode('ascii'), b'MIT-MAGIC-COOKIE-1', cookie)
    data = struct.pack('!H', 65535) + b''.join(struct.pack('!H', len(v))+v for v in fields)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


def read_displayfd(process, fd, timeout):
    deadline = time.monotonic() + timeout
    data = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while True:
            if process.poll() is not None:
                raise IsolationError('owned Xvfb exited before readiness')
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise IsolationError('owned Xvfb readiness timed out')
            if not selector.select(min(.05, remaining)):
                continue
            chunk = os.read(fd, 32)
            if not chunk:
                raise IsolationError('truncated Xvfb displayfd response')
            data.extend(chunk)
            if len(data) > 16:
                raise IsolationError('oversized Xvfb displayfd response')
            if b'\n' in data:
                if not re.fullmatch(rb'[0-9]{1,5}\n', data) or int(data) > 65535:
                    raise IsolationError('invalid Xvfb displayfd response')
                if process.poll() is not None:
                    raise IsolationError('owned Xvfb exited at readiness')
                return int(data)


def x_authenticated(number, cookie, timeout):
    """Read-only X11 setup handshake, no Xlib fallback/autolaunch/input calls."""
    protocol = b'MIT-MAGIC-COOKIE-1'
    def pad(value):
        return value + b'\0' * (-len(value) % 4)
    packet = struct.pack('<BBHHHHH', ord('l'), 0, 11, 0, len(protocol), len(cookie), 0)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(f'/tmp/.X11-unix/X{number}')
        connection.sendall(packet + pad(protocol) + pad(cookie))
        header = bytearray()
        while len(header) < 8:
            chunk = connection.recv(8-len(header))
            if not chunk:
                return False
            header.extend(chunk)
        return header[0] == 1 and struct.unpack_from('<H', header, 2)[0] == 11


def stop_process(process):
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def unreaped_status(process):
    # Keep the leader PID reserved until group cleanup completes. Popen.poll()
    # would reap it and permit PID/PGID reuse before our last group signal.
    result = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if result is None:
        return None
    return result.si_status if result.si_code == os.CLD_EXITED else -result.si_status


def stop_group(process):
    # Only OUR Popen(start_new_session=True) creates this group. Its leader is
    # deliberately unreaped until after the last group signal, reserving PGID.
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic()+2
    while unreaped_status(process) is None and time.monotonic() < deadline:
        time.sleep(.02)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=2)


class OwnedDisplay:
    def __init__(self, timeout=10, screen='1280x1024x24'):
        self.timeout, self.screen = timeout, screen
        self.process = None
        self.worker = None
        self.temporary = None
        self.log = None
        self.env = None
        self.number = None

    def __enter__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='brian-native-test-')
        read_fd = write_fd = None
        try:
            directory = Path(self.temporary.name)
            self.env = private_environment(os.environ, directory)
            cookie = secrets.token_bytes(16)
            server_auth = directory / 'server.auth'
            client_auth = directory / 'client.auth'
            # Server loads the cookie irrespective of display number. Client
            # authority is written with the actual allocated number after ready.
            write_authority(server_auth, 0, cookie)
            self.env['XAUTHORITY'] = str(client_auth)
            self.log = (directory / 'xvfb.log').open('wb')
            read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
            self.process = subprocess.Popen(
                ['Xvfb', '-displayfd', str(write_fd), '-screen', '0', self.screen,
                 '-nolisten', 'tcp', '-auth', str(server_auth), '-noreset'],
                pass_fds=(write_fd,), env=self.env, stdin=subprocess.DEVNULL,
                stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
            os.close(write_fd)
            write_fd = None
            self.number = read_displayfd(self.process, read_fd, self.timeout)
            self.require_alive()
            if x_authenticated(self.number, secrets.token_bytes(16), min(self.timeout, 2)):
                raise IsolationError('Xvfb did not enforce private authentication')
            if not x_authenticated(self.number, cookie, min(self.timeout, 2)):
                raise IsolationError('owned Xvfb authentication/readiness failed')
            self.require_alive()
            write_authority(client_auth, self.number, cookie)
            self.env['DISPLAY'] = ':' + str(self.number)
            return self
        except BaseException:
            self.close()
            raise
        finally:
            for fd in (read_fd, write_fd):
                if fd is not None:
                    os.close(fd)

    def require_alive(self):
        if self.process is None or self.process.poll() is not None:
            raise IsolationError('owned Xvfb is not running')

    def run(self, script, args=(), timeout=180):
        self.require_alive()
        bus = ['dbus-run-session']
        if self.env.get('DBUS_TEST_CONFIG'):
            bus.append('--config-file=' + self.env['DBUS_TEST_CONFIG'])
        worker = Path(__file__).with_name('_desktop_worker.py')
        read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
        try:
            ticket = dict(display=self.env['DISPLAY'], authority=self.env['XAUTHORITY'], server=self.process.pid)
            os.write(write_fd, json.dumps(ticket).encode())
            os.close(write_fd)
            write_fd = None
            argv = bus + ['--', sys.executable, str(worker), str(read_fd), str(Path(script).resolve()), *args]
            self.worker = subprocess.Popen(argv, env=self.env, stdin=subprocess.DEVNULL,
                                           pass_fds=(read_fd,), start_new_session=True)
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)
        print(f'ISOLATED_DISPLAY display=:{self.number} xvfb_pid={self.process.pid} harness={Path(script).name}', flush=True)
        deadline = time.monotonic()+timeout
        try:
            while True:
                # Independently revoke a blocked GI/test process if OUR server
                # dies. Never reconnect or choose an inherited display/bus.
                self.require_alive()
                if time.monotonic() >= deadline:
                    raise IsolationError('disposable test worker timed out')
                code = unreaped_status(self.worker)
                if code is not None:
                    return code
                time.sleep(.02)
        finally:
            worker, self.worker = self.worker, None
            stop_group(worker)

    def close(self):
        try:
            stop_group(self.worker)
        finally:
            self.worker = None
            try:
                stop_process(self.process)
            finally:
                self.process = None
                if self.log is not None:
                    self.log.close()
                    self.log = None
                if self.temporary is not None:
                    self.temporary.cleanup()
                    self.temporary = None

    def __exit__(self, *_):
        self.close()


def run_isolated(script, args=()):
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        with OwnedDisplay() as desktop:
            return desktop.run(script, args)
    except KeyboardInterrupt:
        return 130
    except IsolationError as error:
        print(f'FAIL: {error}; no existing display/session fallback', file=sys.stderr)
        return 1
    except OSError:
        print('FAIL: disposable desktop unavailable; no existing display/session fallback', file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)
