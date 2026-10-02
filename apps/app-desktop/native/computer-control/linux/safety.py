"""Independent watchdog, XI2 takeover, logind lock/session and per-user lease."""
import fcntl
import os
import re
import select
import stat
import threading
import time
from contract import mono, now
from x11 import X11


def private_channel_alive(input_fd=0, output_fd=1):
    """Non-consuming kernel peer check, including buffered commands after EOF.

    Never use readability/byte counts as proof of connection. HUP/ERR/NVAL is
    fatal on either inherited endpoint; files/TTYs and failed probes are denied.
    """
    try:
        poller = select.poll()
        for fd, events in ((input_fd, select.POLLIN), (output_fd, select.POLLOUT)):
            mode = os.fstat(fd).st_mode
            if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
                return False
            poller.register(fd, events)
        return not any(events & (select.POLLHUP | select.POLLERR | select.POLLNVAL)
                       for _, events in poller.poll(0))
    except (OSError, ValueError):
        return False


def require_private_channel():
    if not private_channel_alive():
        os._exit(70)


# Bounded kernel status, not environment claims or /proc directory ownership.
# CapBnd only limits future capabilities; normal users may have a full set.
_STATUS_LIMIT = 65536
_CREDENTIAL_FIELDS = {b'Uid', b'Gid', b'CapEff', b'CapPrm', b'CapAmb', b'CapInh'}


def _check_credentials(path, uid, gid):
    with open(path, 'rb') as source:
        data = source.read(_STATUS_LIMIT + 1)
    if len(data) > _STATUS_LIMIT:
        raise RuntimeError('oversized process status')
    fields = {}
    for line in data.splitlines():
        key, separator, value = line.partition(b':')
        if key not in _CREDENTIAL_FIELDS:
            continue
        if not separator or key in fields:
            raise RuntimeError('malformed process credentials')
        fields[key] = value.split()
    if fields.keys() != _CREDENTIAL_FIELDS:
        raise RuntimeError('missing process credentials')
    for key, expected in ((b'Uid', uid), (b'Gid', gid)):
        values = fields[key]
        if len(values) != 4 or any(not re.fullmatch(rb'[0-9]{1,10}', v) for v in values):
            raise RuntimeError('malformed process IDs')
        # real/effective/saved/filesystem IDs must all match the ordinary
        # helper account. Supplementary groups are deliberately not restricted.
        if any(int(v) != expected for v in values):
            raise RuntimeError('elevated or mismatched process IDs')
    for key in (b'CapEff', b'CapPrm', b'CapAmb', b'CapInh'):
        values = fields[key]
        if len(values) != 1 or not re.fullmatch(rb'[0-9a-fA-F]{16}', values[0]):
            raise RuntimeError('malformed process capabilities')
        if int(values[0], 16):
            raise RuntimeError('process capabilities unsupported')


def ordinary_credentials(pid=None):
    """Refuse uncertain/elevated helper or target credentials before AX access.

    Re-read on every admission/live check: birth identity alone cannot detect
    set-ID/capability changes. This is a point-in-time fence, not a sandbox.
    """
    uid, gid = os.getuid(), os.getgid()
    if uid == 0 or os.getresuid() != (uid, uid, uid) or os.getresgid() != (gid, gid, gid):
        raise RuntimeError('ordinary helper credentials required')
    try:
        # Thread-specific status covers the calling watchdog/main thread too.
        _check_credentials('/proc/thread-self/status', uid, gid)
        if pid is not None:
            if type(pid) is not int or pid <= 0:
                raise RuntimeError('invalid process ID')
            _check_credentials(f'/proc/{pid}/status', uid, gid)
    except (OSError, ValueError) as error:
        raise RuntimeError('process credentials unavailable') from error


def process_key(pid):
    with open(f'/proc/{pid}/stat') as f:
        # comm may contain spaces and parentheses.
        start = f.read().rsplit(')', 1)[1].split()[19]
    with open('/proc/sys/kernel/random/boot_id') as f:
        return f'{pid}:{start}:{f.read().strip()}'


class Safety:
    def __init__(self):
        require_private_channel()
        ordinary_credentials()
        from gi.repository import Gio, GLib
        self.GLib = GLib
        self.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        session = os.environ.get('XDG_SESSION_ID', '')
        if not session or '/' in session:
            raise RuntimeError('logind session required')
        self.path = self.bus.call_sync('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'GetSession', GLib.Variant('(s)', (session,)),
            GLib.VariantType.new('(o)'), Gio.DBusCallFlags.NONE, 300, None).unpack()[0]
        self.events = X11(events=True)
        self.parent = os.getppid()
        self.parent_key = process_key(self.parent)
        self.active = False
        self.approval = False
        self.approval_window = 0
        self.approval_deadline = float('inf')
        self.deadline = float('inf')
        self.wall_expiry = float('inf')
        self.request_deadline = float('inf')
        self.lock = threading.RLock()
        self.fd = None
        self.check_session()
        self.events.input_pending()
        threading.Thread(target=self.watch_channel, daemon=True).start()
        threading.Thread(target=self.watch, daemon=True).start()

    def check_session(self):
        ordinary_credentials()
        from gi.repository import Gio
        values = self.bus.call_sync('org.freedesktop.login1', self.path,
            'org.freedesktop.DBus.Properties', 'GetAll',
            self.GLib.Variant('(s)', ('org.freedesktop.login1.Session',)),
            self.GLib.VariantType.new('(a{sv})'), Gio.DBusCallFlags.NONE, 300, None).unpack()[0]
        if values.get('LockedHint') is not False or values.get('Active') is not True or values.get('Remote') is not False or values.get('Type') != 'x11':
            raise RuntimeError('unlocked active local X11 session required')
        user = values.get('User', ())
        if len(user) != 2 or user[0] != os.getuid():
            raise RuntimeError('wrong session owner')
        if values.get('Display') != os.environ.get('DISPLAY'):
            raise RuntimeError('logind display mismatch')
        # User object comes from the validated session on the SYSTEM bus, not
        # from the caller's environment (nor GetSessionByPID: user services may
        # legitimately live outside the graphical session's scope).
        owner = self.bus.call_sync('org.freedesktop.login1', user[1],
            'org.freedesktop.DBus.Properties', 'GetAll',
            self.GLib.Variant('(s)', ('org.freedesktop.login1.User',)),
            self.GLib.VariantType.new('(a{sv})'), Gio.DBusCallFlags.NONE, 300, None).unpack()[0]
        runtime = owner.get('RuntimePath')
        if owner.get('UID') != os.getuid() or not isinstance(runtime, str) or not runtime.startswith('/') or runtime == '/' or '\x00' in runtime:
            raise RuntimeError('logind private runtime required')
        if os.path.normpath(runtime) != runtime:
            raise RuntimeError('unsafe logind runtime path')
        if os.environ.get('XDG_RUNTIME_DIR', runtime) != runtime:
            raise RuntimeError('logind runtime mismatch')
        if getattr(self, 'runtime', runtime) != runtime:
            raise RuntimeError('logind runtime changed')
        return runtime

    def acquire(self, expiry):
        runtime = self.check_session()
        # Walk without following symlinks, then validate the opened directory,
        # not a path stat that could race the open.
        directory = os.open('/', os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            for component in runtime.split('/')[1:]:
                child = os.open(component, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
                os.close(directory)
                directory = child
            s = os.fstat(directory)
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
                raise RuntimeError('private runtime directory required')
        except BaseException:
            os.close(directory)
            raise
        try:
            fd = os.open('use-brian-native-computer.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        finally:
            os.close(directory)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or s.st_mode & 0o077:
                raise RuntimeError('unsafe lease file')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.lock:
                if self.check_session() != runtime:
                    raise RuntimeError('logind runtime changed')
                self.runtime = runtime
                self.events.input_pending()  # input before consent is not authority
                self.fd = fd
                self.deadline = mono() + expiry - now()
                self.wall_expiry = expiry
                self.active = True
        except BaseException:
            os.close(fd)
            raise

    def close_approval(self):
        with self.lock:
            self.check()  # drain only already-authorized dialog input
            self.approval = False
            self.approval_window = 0

    def check(self):
        require_private_channel()
        with self.lock:
            if os.getppid() != self.parent or process_key(self.parent) != self.parent_key:
                os._exit(70)
            if mono() >= self.request_deadline:
                os._exit(70)
            if not self.active:
                self.events.input_pending()
                return
            if self.approval and mono() >= self.approval_deadline:
                os._exit(70)
            if mono() >= self.deadline or now() >= self.wall_expiry:
                os._exit(70)
            self.check_session()
            if self.events.input_pending():
                # Never exempt the target, renderer processes, or arbitrary input.
                # Dialog must belong to the exact trusted pipe parent process.
                foreground = self.events.foreground()
                if (not self.approval or not foreground or self.events.pid(foreground) != self.parent
                        or (self.approval_window and foreground != self.approval_window)
                        or not self.events.pointer_within(foreground)):
                    os._exit(73)
                self.approval_window = foreground
            require_private_channel()

    def watch_channel(self):
        # No safety lock, AX, X11 or logind call may delay channel revocation.
        while True:
            require_private_channel()
            time.sleep(.025)

    def watch(self):
        previous = mono()
        while True:
            time.sleep(.025)
            current = mono()
            if self.active and current - previous > 1000:
                os._exit(71)  # suspend/scheduling stall: require fresh local Resume
            previous = current
            try:
                require_private_channel()
                self.check()
            except BaseException:
                os._exit(71)
