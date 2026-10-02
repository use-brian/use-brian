"""Mock OS guard tests; these do not establish native desktop acceptance."""
import os
from pathlib import Path
import sys
import threading
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, mock_open
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from safety import Safety, process_key, ordinary_credentials
from contract import mono, now
from atspi_backend import limited


class Exit(BaseException):
    def __init__(self, code):
        self.code = code


class Events:
    pending = False
    owner = 0
    def input_pending(self):
        result, self.pending = self.pending, False
        return result
    window = 10
    inside = True
    def foreground(self):
        return self.window
    def pointer_within(self, window):
        return self.inside
    def pid(self, window):
        return self.owner


def credential_status(uid=1000, gid=1000, **changes):
    fields = dict(Uid=f'{uid} {uid} {uid} {uid}', Gid=f'{gid} {gid} {gid} {gid}',
                  CapEff='0000000000000000', CapPrm='0000000000000000',
                  CapAmb='0000000000000000', CapInh='0000000000000000',
                  CapBnd='000001ffffffffff', Groups='999 1000 1234')
    fields.update(changes)
    return b'Name:\ttest\n' + b''.join(
        f'{key}:\t{value}\n'.encode() for key, value in fields.items() if value is not None)


class CredentialTests(unittest.TestCase):
    def setUp(self):
        channel = patch('safety.require_private_channel')
        channel.start(); self.addCleanup(channel.stop)
        for name, value in [('getuid', 1000), ('getgid', 1000),
                            ('getresuid', (1000, 1000, 1000)), ('getresgid', (1000, 1000, 1000))]:
            mocked = patch('safety.os.' + name, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def check(self, data, pid=None):
        with patch('safety.open', mock_open(read_data=data)) as opened:
            ordinary_credentials(pid)
            for call in opened.return_value.read.call_args_list:
                self.assertEqual(call.args, (65537,))
            return opened

    def test_ordinary_groups_and_bounding_set_are_not_elevation(self):
        opened = self.check(credential_status(), 42)
        self.assertEqual([call.args for call in opened.call_args_list],
                         [('/proc/thread-self/status', 'rb'), ('/proc/42/status', 'rb')])
        self.check(credential_status(CapBnd='0000000000000000', Groups=''))

    def test_all_four_uid_and_gid_slots_must_match(self):
        for key in ('Uid', 'Gid'):
            for slot in range(4):
                values = ['1000'] * 4
                values[slot] = '0' if key == 'Uid' else '999'
                with self.subTest(key=key, slot=slot), self.assertRaises(RuntimeError):
                    self.check(credential_status(**{key: ' '.join(values)}))
        with self.assertRaises(RuntimeError):
            self.check(credential_status(uid=0))

    def test_os_ids_independently_reject_root_or_saved_effective_changes(self):
        for name, value in [('getuid', 0), ('getresuid', (1000, 0, 1000)),
                            ('getresuid', (1000, 1000, 0)),
                            ('getresgid', (1000, 999, 1000)), ('getresgid', (1000, 1000, 999))]:
            with self.subTest(name=name, value=value), patch('safety.os.' + name, return_value=value):
                with self.assertRaises(RuntimeError):
                    self.check(credential_status())

    def test_each_authority_capability_set_refuses(self):
        for key in ('CapEff', 'CapPrm', 'CapAmb', 'CapInh'):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.check(credential_status(**{key: '0000000000000001'}))

    def test_missing_duplicate_malformed_and_oversized_state_refuses(self):
        for key in ('Uid', 'Gid', 'CapEff', 'CapPrm', 'CapAmb', 'CapInh'):
            for value in (None, '', 'invalid', '-1', '0', '0 0 0', '0 0 0 0 0', '0' * 17):
                with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                    self.check(credential_status(**{key: value}))
        for data in (b'', credential_status() + b'Uid: 1000 1000 1000 1000\n',
                     credential_status() + b'x' * 65536):
            with self.assertRaises(RuntimeError):
                self.check(data)
        for error in (FileNotFoundError(), PermissionError()):
            with patch('safety.open', side_effect=error), self.assertRaises(RuntimeError):
                ordinary_credentials(42)

    def test_target_state_independently_checked(self):
        for target in (credential_status(uid=0), credential_status(CapPrm='0000000000000001'), b''):
            def status(path, mode):
                return mock_open(read_data=credential_status() if path == '/proc/thread-self/status' else target)()
            with patch('safety.open', side_effect=status), self.assertRaises(RuntimeError):
                ordinary_credentials(42)
        for pid in (0, -1, '42', '../self', True):
            with self.assertRaises(RuntimeError):
                self.check(credential_status(), pid)

    def test_helper_refuses_before_native_setup_or_logind(self):
        from atspi_backend import Backend
        with patch('safety.os.getuid', return_value=0):
            with self.assertRaises(RuntimeError):
                Safety()
            with self.assertRaises(RuntimeError):
                Backend()
            # A later credential change also fences an already-created guard.
            with self.assertRaises(RuntimeError):
                Safety.__new__(Safety).check_session()


class GuardTests(unittest.TestCase):
    def setUp(self):
        channel = patch('safety.require_private_channel')
        channel.start(); self.addCleanup(channel.stop)
        self.s = Safety.__new__(Safety)
        self.s.lock = threading.RLock()
        self.s.parent = os.getppid()
        self.s.parent_key = process_key(self.s.parent)
        self.s.active = True
        self.s.approval = False
        self.s.approval_window = 0
        self.s.approval_deadline = float('inf')
        self.s.deadline = mono() + 60000
        self.s.wall_expiry = now() + 60000
        self.s.request_deadline = float('inf')
        self.s.check_session = lambda: None
        self.s.events = Events()
    def exits(self, code):
        def terminate(status):
            raise Exit(status)
        with patch('safety.os._exit', side_effect=terminate):
            with self.assertRaises(Exit) as caught:
                self.s.check()
        self.assertEqual(caught.exception.code, code)
    def test_raw_takeover(self):
        self.s.events.pending = True
        self.exits(73)
    def test_parent_owned_dialog_exception_only(self):
        self.s.approval = True
        self.s.events.pending = True
        self.s.events.owner = self.s.parent
        self.s.check()
        self.s.events.pending = True
        self.s.events.owner = self.s.parent + 1
        self.exits(73)
    def test_same_parent_other_window_revokes(self):
        self.s.approval = True
        self.s.events.owner = self.s.parent
        self.s.events.pending = True
        self.s.check()
        self.s.events.window = 11
        self.s.events.pending = True
        self.exits(73)
    def test_pointer_outside_parent_dialog_revokes(self):
        self.s.approval = True
        self.s.events.owner = self.s.parent
        self.s.events.inside = False
        self.s.events.pending = True
        self.exits(73)
    def test_restoration_has_no_input_exception(self):
        self.s.approval = True
        self.s.events.owner = self.s.parent
        self.s.close_approval()
        self.assertFalse(self.s.approval)
        self.s.events.pending = True
        self.exits(73)
    def test_expiry_even_without_commands(self):
        self.s.deadline = mono() - 1
        self.exits(70)
    def test_blocked_request_deadline(self):
        self.s.request_deadline = mono() - 1
        self.exits(70)
    def test_approval_timeout(self):
        self.s.approval = True
        self.s.approval_deadline = mono() - 1
        self.exits(70)
    def test_parent_instance_change(self):
        self.s.parent_key = 'reused pid'
        self.exits(70)
    def test_session_failure_propagates_to_watchdog(self):
        def locked():
            raise RuntimeError('locked or inaccessible logind')
        self.s.check_session = locked
        with self.assertRaises(RuntimeError):
            self.s.check()
    def test_utf16_protocol_limits(self):
        self.assertEqual(len(limited('\U0001f600' * 4096, 4096).encode('utf-16-le')), 8192)
        self.assertEqual(limited('a\U0001f600', 2), 'a')


class LeaseTests(unittest.TestCase):
    """Real temporary-directory/flock exclusion; only system logind is mocked."""
    def setUp(self):
        channel = patch('safety.require_private_channel')
        channel.start(); self.addCleanup(channel.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runtime = str(Path(self.tmp.name) / 'runtime')
        os.mkdir(self.runtime, 0o700)
        self.session = dict(LockedHint=False, Active=True, Remote=False, Type='x11',
                            User=(os.getuid(), '/user/owner'), Display=':mock')
        self.owner = dict(UID=os.getuid(), RuntimePath=self.runtime)
        self.env = patch.dict(os.environ, {'DISPLAY': ':mock'}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        gio = SimpleNamespace(DBusCallFlags=SimpleNamespace(NONE=0))
        modules = patch.dict(sys.modules, {'gi.repository': SimpleNamespace(Gio=gio)})
        modules.start()
        self.addCleanup(modules.stop)
        self.bus = Mock()
        def call(service, path, interface, method, args, *rest):
            self.assertEqual(service, 'org.freedesktop.login1')
            self.assertEqual(interface, 'org.freedesktop.DBus.Properties')
            self.assertEqual(method, 'GetAll')
            self.assertIn(path, ['/session/local', '/user/owner'])
            return SimpleNamespace(unpack=lambda: (self.session if path == '/session/local' else self.owner,))
        self.bus.call_sync.side_effect = call

    def guard(self):
        s = Safety.__new__(Safety)
        s.bus, s.path = self.bus, '/session/local'
        s.GLib = SimpleNamespace(Variant=lambda sig, val: val,
                                VariantType=SimpleNamespace(new=lambda sig: sig))
        s.lock, s.events, s.fd, s.active = threading.RLock(), Events(), None, False
        self.addCleanup(lambda: os.close(s.fd) if s.fd is not None else None)
        return s

    def test_private_logind_runtime_excludes_helpers_without_environment(self):
        first, second = self.guard(), self.guard()
        first.acquire(now() + 60000)
        self.assertTrue(first.active)
        with self.assertRaises(BlockingIOError):
            second.acquire(now() + 60000)
        self.assertFalse(second.active)
        # Closing the actual owner, not unlinking or stealing, permits reuse.
        os.close(first.fd)
        first.fd = None
        second.acquire(now() + 60000)
        self.assertTrue(second.active)

    def test_alternate_home_and_private_runtime_cannot_split_authority(self):
        first = self.guard()
        os.environ.update(HOME='/fake-a', XDG_RUNTIME_DIR=self.runtime)
        first.acquire(now() + 60000)
        for name in ['profile-a', 'profile-b']:
            alternate = str(Path(self.tmp.name) / name)
            os.mkdir(alternate, 0o700)
            os.environ.update(HOME=alternate, XDG_RUNTIME_DIR=alternate)
            contender = self.guard()
            with self.assertRaisesRegex(RuntimeError, 'runtime mismatch'):
                contender.acquire(now() + 60000)
            self.assertFalse(contender.active)
            self.assertEqual(list(Path(alternate).iterdir()), [])
        os.environ['XDG_RUNTIME_DIR'] = self.runtime
        with self.assertRaises(BlockingIOError):
            self.guard().acquire(now() + 60000)

    def test_missing_malformed_or_wrong_owner_runtime_fails_closed(self):
        for runtime in [None, '', '/', 'relative', '/a/../b', self.runtime + '/']:
            with self.subTest(runtime=runtime):
                self.owner['RuntimePath'] = runtime
                with self.assertRaises(RuntimeError):
                    self.guard().acquire(now() + 60000)
        self.owner = dict(UID=os.getuid() + 1, RuntimePath=self.runtime)
        with self.assertRaises(RuntimeError):
            self.guard().acquire(now() + 60000)
        self.bus.call_sync.side_effect = RuntimeError('logind unavailable')
        with self.assertRaises(RuntimeError):
            self.guard().acquire(now() + 60000)

    def test_unsafe_runtime_and_symlink_ancestors_fail_closed(self):
        os.chmod(self.runtime, 0o755)
        with self.assertRaises(RuntimeError):
            self.guard().acquire(now() + 60000)
        os.chmod(self.runtime, 0o700)
        link = str(Path(self.tmp.name) / 'link')
        os.symlink(self.runtime, link)
        os.mkdir(self.runtime + '/child', 0o700)
        for runtime in [link, link + '/child', self.runtime + '/missing']:
            self.owner['RuntimePath'] = runtime
            with self.assertRaises(OSError):
                self.guard().acquire(now() + 60000)
        self.owner['RuntimePath'] = self.runtime
        original = os.fstat
        def wrong_owner(fd):
            s = original(fd)
            return SimpleNamespace(st_mode=s.st_mode, st_uid=os.getuid() + 1)
        with patch('safety.os.fstat', side_effect=wrong_owner):
            with self.assertRaises(RuntimeError):
                self.guard().acquire(now() + 60000)

    def test_unsafe_lock_file_is_not_stolen(self):
        lock = Path(self.runtime) / 'use-brian-native-computer.lock'
        lock.touch(mode=0o666)
        lock.chmod(0o666)
        with self.assertRaises(RuntimeError):
            self.guard().acquire(now() + 60000)
        lock.unlink()
        os.symlink(Path(self.tmp.name) / 'absent', lock)
        with self.assertRaises(OSError):
            self.guard().acquire(now() + 60000)
        self.assertTrue(lock.is_symlink())

    def test_session_checks_and_runtime_change_remain_fail_closed(self):
        first = self.guard()
        first.acquire(now() + 60000)
        for key, value in [('LockedHint', True), ('Active', False), ('Remote', True),
                           ('Type', 'wayland'), ('User', (os.getuid() + 1, '/user/owner')),
                           ('Display', ':other')]:
            with self.subTest(key=key), patch.dict(self.session, {key: value}):
                with self.assertRaises(RuntimeError):
                    first.check_session()
        self.owner['RuntimePath'] = self.tmp.name
        with self.assertRaisesRegex(RuntimeError, 'runtime changed'):
            first.check_session()


if __name__ == '__main__':
    unittest.main()
