"""Real local channel revocation, not desktop/AX acceptance.

Also compiles the exact portable poll primitive used by the macOS helper; the
Darwin process/signature implementation is deliberately not stubbed or compiled.
"""
import ctypes
import os
from pathlib import Path
import socket
import select
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from safety import private_channel_alive, Safety
from atspi_backend import Backend


class Disconnected(BaseException):
    pass


class Channels:
    def __init__(self, kind):
        self.sockets = []
        if kind == 'pipe':
            self.input, self.parent_input = os.pipe()
            self.parent_output, self.output = os.pipe()
        else:
            a, b = socket.socketpair()
            c, d = socket.socketpair()
            self.sockets = [a, b, c, d]
            self.input, self.parent_input = a.fileno(), b.fileno()
            self.output, self.parent_output = c.fileno(), d.fileno()
        self.fds = {self.input, self.parent_input, self.output, self.parent_output}
    def close(self, fd):
        if fd in self.fds:
            self.fds.remove(fd)
            for s in self.sockets:
                if s.fileno() == fd:
                    s.close()
                    return
            os.close(fd)
    def cleanup(self):
        for fd in list(self.fds):
            self.close(fd)


class ChannelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        source = Path(cls.tmp.name) / 'probe.c'
        source.write_text('#include "' + str(ROOT.parent / 'ProcessIdentity.h') + '"\n'
                          'int probe(int input,int output) { return brian_pipe_endpoints_alive(input,output); }\n')
        library = str(Path(cls.tmp.name) / 'probe.so')
        subprocess.run(['cc', '-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', str(source), '-o', library], check=True)
        cls.c = ctypes.CDLL(library)
        cls.c.probe.argtypes = [ctypes.c_int, ctypes.c_int]
        cls.c.probe.restype = ctypes.c_int

    def channels(self, kind):
        c = Channels(kind)
        self.addCleanup(c.cleanup)
        return c

    def alive(self, c, expected):
        self.assertEqual(private_channel_alive(c.input, c.output), expected)
        self.assertEqual(bool(self.c.probe(c.input, c.output)), expected)

    def test_buffered_commands_do_not_hide_peer_death_or_get_consumed(self):
        for kind in ('pipe', 'socketpair'):
            for side in ('parent_input', 'parent_output'):
                with self.subTest(kind=kind, side=side):
                    c = self.channels(kind)
                    self.alive(c, True)
                    os.write(c.parent_input, b'buffered unexecuted command')
                    self.alive(c, True)
                    self.alive(c, True)
                    c.close(getattr(c, side))
                    if side == 'parent_output':
                        poller = select.poll(); poller.register(c.output, select.POLLOUT)
                        flags = dict(poller.poll(0))[c.output]
                        self.assertTrue(flags & select.POLLOUT)  # writable is NOT connected
                        self.assertTrue(flags & (select.POLLERR | select.POLLHUP))
                    self.alive(c, False)
                    self.assertEqual(os.read(c.input, 100), b'buffered unexecuted command')

    def test_invalid_and_regular_endpoints_fail_closed(self):
        c = self.channels('pipe')
        c.close(c.input)
        self.alive(c, False)
        with tempfile.TemporaryFile() as file:
            self.assertFalse(private_channel_alive(file.fileno(), c.output))
            self.assertFalse(self.c.probe(file.fileno(), c.output))
        self.assertFalse(private_channel_alive(-1, c.output))
        self.assertFalse(self.c.probe(-1, c.output))

    def test_pre_guard_rejects_before_acquiring_a_blocked_safety_lock(self):
        c = self.channels('pipe')
        s = Safety.__new__(Safety)
        s.lock = threading.Lock()
        s.lock.acquire()
        c.close(c.parent_input)
        with patch('safety.private_channel_alive', side_effect=lambda: private_channel_alive(c.input, c.output)), \
             patch('safety.os._exit', side_effect=Disconnected):
            with self.assertRaises(Disconnected):
                s.check()
        s.lock.release()

    def test_watchdog_exits_with_live_parent_buffered_input_and_blocked_worker(self):
        # Real subprocess with unread stdin and a simulated indefinitely blocked
        # AX worker/locked safety state. No timeout/deadline/parent death involved.
        code = '''
import os, sys, threading
sys.path.insert(0, sys.argv[1])
from safety import Safety
s = Safety.__new__(Safety)
s.lock = threading.Lock(); s.lock.acquire()
threading.Thread(target=s.watch_channel, daemon=True).start()
os.write(2, b'ready\\n')
threading.Event().wait()
'''
        for side in ('stdin', 'stdout'):
            with self.subTest(side=side):
                p = subprocess.Popen([sys.executable, '-c', code, str(ROOT)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.assertEqual(p.stderr.readline(), b'ready\n')
                    p.stdin.write(b'unread command bytes'); p.stdin.flush()
                    start = time.monotonic()
                    getattr(p, side).close()
                    self.assertEqual(p.wait(timeout=2), 70)
                    self.assertLess(time.monotonic() - start, 2)
                finally:
                    if p.poll() is None:
                        p.kill(); p.wait()
                    for stream in (p.stdin, p.stdout, p.stderr):
                        stream.close()

    def test_approval_or_start_focus_restoration_rechecks_after_blocking_ax(self):
        from test_focus import RestoringBackend
        for endpoint in ('parent_input', 'parent_output'):
            with self.subTest(endpoint=endpoint):
                c = self.channels('socketpair')
                backend = RestoringBackend()
                context = backend.context(backend.w)
                _, refs, _ = backend.tree(backend.w)
                original = backend.unchanged
                def late_ax(*args, **kwargs):
                    result = original(*args, **kwargs)
                    os.write(c.parent_input, b'buffered command')
                    c.close(getattr(c, endpoint))
                    return result
                backend.unchanged = late_ax
                def guard():
                    if not private_channel_alive(c.input, c.output):
                        raise Disconnected()
                with self.assertRaises(Disconnected):
                    backend.restore_consented_focus(backend.w, refs, context, 55, guard)
                self.assertEqual(backend.x.requests, 0)
                self.assertEqual(backend.effects, 0)

    def test_broker_reads_and_capture_do_not_admit_or_return_after_disconnect(self):
        from helper import Broker
        from test_contract import Backend as FakeBackend, Safety as FakeSafety
        import contract as C
        for phase in ('buffered-request', 'observe-return', 'capture-before', 'capture-return'):
            with self.subTest(phase=phase):
                c = self.channels('pipe')
                backend, safety = FakeBackend(), FakeSafety()
                def guard():
                    if not private_channel_alive(c.input, c.output):
                        raise Disconnected()
                def revoke():
                    os.write(c.parent_input, b'buffered command')
                    c.close(c.parent_output)  # output remains POLLOUT, but has ERR
                safety.check = guard
                broker = Broker(backend, safety)
                g = dict(protocol=C.PROTOCOL, identity={k:k for k in C.IDENTITY}, grantId='g', epoch=1,
                         expiresAt=C.now()+60000, targets=[backend.target], allowControl=True,
                         allowCapture=True, requester='local', goal='test')
                self.assertTrue(broker.start(dict(grant=g, leaseId='lease')))
                def command(kind, **fields):
                    return dict(protocol=C.PROTOCOL, identity=g['identity'], grantId='g', epoch=1,
                                commandId=C.uid(), deadlineAt=C.now()+30000,
                                action=dict(kind=kind, target=backend.target, **fields))
                reads = []
                if phase == 'buffered-request':
                    backend.discover = lambda: reads.append('discovery')
                    revoke()
                    with self.assertRaises(Disconnected):
                        broker.request('listTargets', {})
                    self.assertEqual(reads, [])
                    continue
                if phase == 'observe-return':
                    tree = backend.tree
                    def late_tree(w):
                        result = tree(w); revoke(); return result
                    backend.tree = late_tree
                    with self.assertRaises(Disconnected):
                        broker.execute(dict(command=command('observe'), leaseId='lease'))
                    self.assertIsNone(broker.snapshot)
                    continue
                observed = broker.execute(dict(command=command('observe'), leaseId='lease'))['observation']
                def canvas(*_):
                    if phase == 'capture-before': revoke()
                    return True
                def capture(_):
                    reads.append('capture')
                    if phase == 'capture-return': revoke()
                    return b'private frame'
                backend.safe_canvas, backend.capture = canvas, capture
                with self.assertRaises(Disconnected):
                    broker.execute(dict(command=command('capture', observationId=observed['id']), leaseId='lease'))
                self.assertEqual(reads, ['capture'] if phase == 'capture-return' else [])
                self.assertNotIn('frame', broker.snapshot['observation'])

    def test_disconnect_during_each_blocking_pattern_lookup_prevents_effect(self):
        for kind in ('invoke', 'setValue', 'select', 'scroll'):
            with self.subTest(kind=kind):
                c = self.channels('pipe')
                calls = []
                def revoke():
                    os.write(c.parent_input, b'next buffered command')
                    c.close(c.parent_input)
                def guard():
                    if not private_channel_alive(c.input, c.output):
                        raise Disconnected()
                class Element:
                    def queryAction(self): revoke(); return self
                    def queryEditableText(self): revoke(); return self
                    def querySelection(self): revoke(); return self
                    def queryValue(self): revoke(); return self
                    def getIndexInParent(self): return 0
                    def doAction(self, *_): calls.append('effect')
                    def setTextContents(self, *_): calls.append('effect')
                    def selectChild(self, *_): calls.append('effect')
                    minimumValue = 0
                    maximumValue = 100
                    @property
                    def currentValue(self): return 1
                    @currentValue.setter
                    def currentValue(self, v): calls.append('effect')
                e = Element(); e.parent = e
                with self.assertRaises(Disconnected):
                    Backend.act(None, kind, (e, {}), {'text': 'x', 'deltaY': 1}, guard)
                self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
