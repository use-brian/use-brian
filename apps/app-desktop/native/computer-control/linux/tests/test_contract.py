import copy
import io
import json
import os
from pathlib import Path
import struct
import sys
import threading
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract as C
from helper import Broker


class Safety:
    def __init__(self):
        self.parent = os.getppid()
        self.deadline = float('inf')
        self.approval = False
        self.lock = threading.RLock()
    def acquire(self, expiry):
        self.deadline = C.mono() + expiry - C.now()
    def check(self):
        pass
    def close_approval(self):
        self.check()
        self.approval = False


class Backend:
    def __init__(self):
        self.target = dict(appId='fixture', processId=5, processInstanceId='p', windowId='w', windowInstanceId='wi')
        self.context_value = dict(foreground=True, bounds=dict(x=-100, y=0, width=400, height=300), displayLayoutVersion='layout')
        self.value = ''
        self.effects = 0
        self.fail = False
    def live(self, target):
        if target != self.target:
            raise ValueError()
        return {'target': self.target}
    def context(self, w):
        return copy.deepcopy(self.context_value)
    def tree(self, w):
        node = dict(ref='r', role='text', name='note', value=self.value, enabled=True, focused=False, selected=False, sensitive=False, actions=['setValue'])
        return [node], {'r': (object(), node, [])}, 'complete'
    def unchanged(self, w, refs, ignore_focus=False):
        return refs['r'][1]['value'] == self.value
    def restore_consented_focus(self, w, refs, context, parent_pid, guard, strict_after=True):
        guard()
        if not self.unchanged(w, refs):
            raise ValueError('changed')
        self.context_value['foreground'] = True
        guard()
        return True
    def act(self, kind, ref, action, guard):
        guard()
        self.effects += 1
        if self.fail:
            raise RuntimeError('may have executed')
        self.value = action['text']
        return True


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.os = Backend()
        self.b = Broker(self.os, Safety())
        self.g = dict(protocol=C.PROTOCOL, identity={k:k for k in C.IDENTITY}, grantId='g', epoch=1,
                      expiresAt=C.now()+60000, targets=[self.os.target], allowControl=True, allowCapture=False, requester='local', goal='test')
        self.assertTrue(self.b.start({'grant':self.g, 'leaseId':'lease'}))
    def cmd(self, kind='observe', **args):
        return dict(protocol=C.PROTOCOL, identity=self.g['identity'], grantId='g', epoch=1, commandId=C.uid(), deadlineAt=C.now()+30000,
                    action=dict(kind=kind, target=self.os.target, **args))
    def execute(self, c, lease='lease'):
        return self.b.execute(dict(command=c, leaseId=lease))
    def action(self):
        o = self.execute(self.cmd())['observation']
        return self.cmd('setValue', observationId=o['id'], ref='r', text='benign note')
    def approve(self, c):
        p = dict(command=c, leaseId='lease')
        self.assertTrue(self.b.begin_approval(p))
        self.assertTrue(self.b.end_approval(dict(**p, approved=True)))
    def test_real_shape(self):
        self.assertTrue(C.grant(self.g))
        self.assertTrue(C.command(self.cmd()))
    def test_approval_and_no_replay(self):
        c = self.action()
        self.approve(c)
        result = self.execute(c)
        self.assertEqual(result['outcome'], 'executed')
        self.assertEqual(result['observation']['nodes'][0]['value'], 'benign note')
        self.assertNotIn('observation', self.execute(c))
        self.assertEqual(self.os.effects, 1)
        c['action']['text'] = 'changed'
        self.assertEqual(self.execute(c)['code'], 'denied')
    def test_missing_approval(self):
        self.assertEqual(self.execute(self.action())['code'], 'approval_required')
        self.assertEqual(self.os.effects, 0)
    def test_unknown_latches_and_never_replays(self):
        c = self.action()
        self.approve(c)
        self.os.fail = True
        self.assertEqual(self.execute(c)['outcome'], 'execution_unknown')
        self.assertEqual(self.execute(c)['outcome'], 'execution_unknown')
        self.assertEqual(self.os.effects, 1)
        self.assertTrue(self.b.stopped)
    def test_scope_epoch_deadline_lease(self):
        for field, value in [('epoch',2), ('grantId','other'), ('deadlineAt',0), ('identity',{k:'other' for k in C.IDENTITY})]:
            c = self.cmd()
            c[field] = value
            self.assertEqual(self.execute(c)['outcome'], 'not_executed')
        self.assertEqual(self.execute(self.cmd(), 'other')['code'], 'denied')
    def test_geometry_foreground_layout(self):
        for field, value in [('foreground',False), ('displayLayoutVersion','new'), ('bounds',dict(x=0,y=0,width=400,height=300))]:
            old = copy.deepcopy(self.os.context_value)
            c = self.action()
            self.approve(c)
            self.os.context_value[field] = value
            self.assertEqual(self.execute(c)['outcome'], 'not_executed')
            self.os.context_value = old
        self.assertEqual(self.os.effects, 0)
    def test_mutation_during_approval(self):
        c = self.action()
        p = dict(command=c, leaseId='lease')
        self.assertTrue(self.b.begin_approval(p))
        self.os.value = 'user changed'
        self.assertFalse(self.b.end_approval(dict(**p, approved=True)))
        self.assertEqual(self.os.effects, 0)
    def test_approval_payload_binding(self):
        c = self.action()
        self.approve(c)
        c['action']['text'] = 'different'
        self.assertEqual(self.execute(c)['code'], 'approval_required')
    def test_stale_and_wrong_ref(self):
        c = self.action()
        self.b.snapshot['time'] -= 5001
        self.assertFalse(self.b.begin_approval(dict(command=c,leaseId='lease')))
        c = self.action()
        c['action']['ref'] = 'invented'
        self.assertFalse(self.b.begin_approval(dict(command=c,leaseId='lease')))
    def test_readonly_and_capture_denial(self):
        c = self.action()
        self.b.grant['allowControl'] = False
        self.assertEqual(self.execute(c)['code'], 'denied')
        self.assertEqual(self.execute(self.cmd('capture', observationId='x'))['code'], 'denied')
    def test_bounded_journal(self):
        self.b.journal = {str(i):('x',{}) for i in range(512)}
        self.assertEqual(self.execute(self.cmd())['code'], 'stopped')
    def test_parser_fail_closed(self):
        for raw in [b'', b'{}', b'{"id":"x","id":"y","method":"capabilities","payload":{}}', b'{"id":"x","method":"capabilities","payload":{"x":NaN}}']:
            with self.assertRaises((ValueError, EOFError)):
                C.read_request(io.BytesIO(struct.pack('!I',len(raw))+raw))
        with self.assertRaises(ValueError):
            C.read_request(io.BytesIO(struct.pack('!I',C.MAX_BYTES+1)))
        with self.assertRaises(ValueError):
            C.read_request(io.BytesIO(struct.pack('!I',100)+b'partial'))
    def test_framing(self):
        request = dict(id='id',method='capabilities',payload={})
        body = json.dumps(request).encode()
        self.assertEqual(C.read_request(io.BytesIO(struct.pack('!I',len(body))+body)),request)
        stream = io.BytesIO()
        C.write_response(stream,'id',True)
        self.assertEqual(json.loads(stream.getvalue()[4:]),dict(id='id',ok=True,result=True))
    def test_schema_rejects_unknown_and_bool_numbers(self):
        for mutate in [lambda c:c.update(extra=True), lambda c:c.update(epoch=True), lambda c:c['action'].update(extra='x')]:
            c = self.cmd()
            mutate(c)
            self.assertFalse(C.command(c))
    def test_wayland_is_not_xwayland(self):
        previous = os.environ.get('WAYLAND_DISPLAY')
        os.environ['WAYLAND_DISPLAY'] = 'wayland-0'
        try:
            b = Broker()
            self.assertFalse(b.capabilities()['axRead'])
            self.assertFalse(b.capabilities()['input'])
        finally:
            if previous is None:
                del os.environ['WAYLAND_DISPLAY']
            else:
                os.environ['WAYLAND_DISPLAY'] = previous


if __name__ == '__main__':
    unittest.main()
