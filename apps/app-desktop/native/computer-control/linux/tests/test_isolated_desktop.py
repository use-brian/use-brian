"""Pure startup/liveness failure tests: never open a display or launch GTK."""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import isolated_desktop as D


class FakeXvfb:
    pid = 987654
    def __init__(self, fd, data=b'', exit_code=None, eof=False):
        self.writer = os.dup(fd)
        self.returncode = exit_code
        self.stopped = False
        if data:
            os.write(self.writer,data)
        if eof:
            os.close(self.writer)
            self.writer = None
    def poll(self):
        return self.returncode
    def terminate(self):
        self.stopped = True
        self.returncode = -15
        if self.writer is not None:
            os.close(self.writer)
            self.writer = None
    kill = terminate
    def wait(self,timeout=None):
        # Fake exit also closes its server end of the private ready pipe.
        if self.writer is not None:
            os.close(self.writer)
            self.writer = None
        return self.returncode


class IsolationTests(unittest.TestCase):
    def failure(self, *, data=b'', exit_code=None, eof=False, spawn_error=False, message=None):
        launches, processes, homes = [], [], []
        def spawn(argv, **kwargs):
            launches.append(argv[0])
            self.assertEqual(argv[0],'Xvfb')
            self.assertNotIn('DISPLAY',kwargs['env'])
            self.assertNotIn('DBUS_SESSION_BUS_ADDRESS',kwargs['env'])
            self.assertNotIn('WAYLAND_DISPLAY',kwargs['env'])
            homes.append(Path(kwargs['env']['HOME']).parent)
            self.assertEqual(argv[1],'-displayfd')
            self.assertNotIn('-ac',argv)
            if spawn_error:
                raise OSError('simulated unavailable executable')
            p = FakeXvfb(kwargs['pass_fds'][0],data,exit_code,eof)
            processes.append(p)
            return p
        start = time.monotonic()
        with patch.object(D.subprocess,'Popen',side_effect=spawn), patch.object(D,'x_authenticated') as probe:
            with self.assertRaises((D.IsolationError,OSError)) as caught:
                with D.OwnedDisplay(timeout=.03) as desktop:
                    desktop.run('must-not-launch.py')
            if message:
                self.assertIn(message,str(caught.exception))
            probe.assert_not_called()
        self.assertEqual(launches,['Xvfb'], 'no WM, D-Bus worker or fixture may start')
        self.assertLess(time.monotonic()-start,1)
        self.assertTrue(all(not p.exists() for p in homes))
        for p in processes:
            # Already exited fakes need no signal; live fakes must be stopped.
            self.assertTrue(p.stopped or exit_code is not None)
            p.wait()  # finish the already-exited fake's FD, as a kernel would
    def test_spawn_failure_never_launches_worker(self):
        self.failure(spawn_error=True)
    def test_early_exit_even_with_complete_displayfd_never_launches_worker(self):
        self.failure(data=b'123\n',exit_code=1,message='exited')
    def test_truncated_displayfd_never_launches_worker(self):
        self.failure(data=b'123',eof=True,message='truncated')
    def test_empty_displayfd_never_launches_worker(self):
        self.failure(eof=True,message='truncated')
    def test_timeout_never_launches_worker(self):
        self.failure(message='timed out')
    def test_invalid_displayfd_never_launches_worker(self):
        for data in (b':123\n',b'1\n2\n',b'-1\n',b'65536\n',b'x'*17):
            with self.subTest(length=len(data)):
                self.failure(data=data)
    def test_inherited_desktop_and_buses_removed(self):
        inherited = dict(DISPLAY=':host',WAYLAND_DISPLAY='host',XAUTHORITY='host',
            DBUS_SESSION_BUS_ADDRESS='unix:path=host',AT_SPI_BUS_ADDRESS='host',
            XDG_SESSION_ID='host',DBUS_TEST_CONFIG='packaged-config',GI_TYPELIB_PATH='packaged-typelibs')
        with tempfile.TemporaryDirectory() as directory:
            env = D.private_environment(inherited,directory)
            for key in ('DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','AT_SPI_BUS_ADDRESS','XDG_SESSION_ID'):
                self.assertNotIn(key,env)
            self.assertEqual(env['DBUS_TEST_CONFIG'],'packaged-config')
            self.assertEqual(env['GI_TYPELIB_PATH'],'packaged-typelibs')
            self.assertEqual(os.stat(env['XDG_RUNTIME_DIR']).st_mode & 0o777,0o700)
        self.assertEqual(inherited['DISPLAY'],':host')
    def test_private_authority_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'client.auth'
            D.write_authority(path,123,b'c'*16)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertIn(b'MIT-MAGIC-COOKIE-1',path.read_bytes())
    def test_authentication_failure_never_launches_worker(self):
        calls = []
        def spawn(argv,**kwargs):
            calls.append(argv[0])
            return FakeXvfb(kwargs['pass_fds'][0],b'123\n')
        with patch.object(D.subprocess,'Popen',side_effect=spawn), patch.object(D,'x_authenticated',return_value=True):
            with self.assertRaisesRegex(D.IsolationError,'private authentication'):
                with D.OwnedDisplay() as desktop:
                    desktop.run('must-not-launch.py')
        self.assertEqual(calls,['Xvfb'])
    def test_server_dies_after_readiness_before_worker(self):
        calls=[]
        def spawn(argv,**kwargs):
            calls.append(argv[0])
            return FakeXvfb(kwargs['pass_fds'][0],b'123\n')
        with patch.object(D.subprocess,'Popen',side_effect=spawn), patch.object(D,'x_authenticated',side_effect=[False,True]):
            with D.OwnedDisplay() as desktop:
                desktop.process.returncode=1
                with self.assertRaisesRegex(D.IsolationError,'not running'):
                    desktop.run('must-not-launch.py')
                desktop.process.wait()
        self.assertEqual(calls,['Xvfb'])

    def test_server_death_revokes_running_worker_group(self):
        from unittest.mock import Mock
        desktop = D.OwnedDisplay()
        server = Mock(pid=12345)
        server.poll.side_effect = [None, 1]
        worker = Mock(pid=23456)
        desktop.process = server
        desktop.number = 123
        desktop.env = dict(DISPLAY=':123',XAUTHORITY='/private-test-authority')
        with patch.object(D.subprocess,'Popen',return_value=worker), patch.object(D,'stop_group') as stop, patch('builtins.print'):
            with self.assertRaisesRegex(D.IsolationError,'not running'):
                desktop.run('test-only-worker.py')
            stop.assert_called_once_with(worker)
            self.assertIsNone(desktop.worker)
            worker.poll.assert_not_called()

    def test_cleanup_signals_only_owned_group_before_reaping(self):
        from unittest.mock import Mock
        events = []
        worker = Mock(pid=12345)
        worker.wait.side_effect = lambda **kw: events.append('reap')
        with patch.object(D.os,'killpg',side_effect=lambda pid,sig: events.append((pid,sig))), patch.object(D,'unreaped_status',return_value=0):
            D.stop_group(worker)
        self.assertEqual(events,[(12345,D.signal.SIGTERM),(12345,D.signal.SIGKILL),'reap'])

    def test_session_bus_explicit_and_default_configuration(self):
        from unittest.mock import Mock
        for config in (None,'packaged-session.conf'):
            with self.subTest(configured=config is not None):
                desktop = D.OwnedDisplay()
                desktop.process = Mock(pid=12345)
                desktop.process.poll.return_value = None
                desktop.number = 123
                desktop.env = dict(DISPLAY=':123',XAUTHORITY='/private-test-authority')
                if config:
                    desktop.env['DBUS_TEST_CONFIG'] = config
                worker = Mock(pid=23456)
                with patch.object(D.subprocess,'Popen',return_value=worker) as spawn, patch.object(D,'unreaped_status',return_value=0), patch.object(D,'stop_group'), patch('builtins.print'):
                    self.assertEqual(desktop.run('test-only-worker.py'),0)
                argv = spawn.call_args.args[0]
                prefix = ['dbus-run-session'] + (['--config-file='+config] if config else []) + ['--']
                self.assertEqual(argv[:len(prefix)],prefix)
                self.assertEqual(len(spawn.call_args.kwargs['pass_fds']),1)
                self.assertTrue(spawn.call_args.kwargs['start_new_session'])


if __name__=='__main__':
    unittest.main()
