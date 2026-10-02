"""Private source timing, no native acceptance claim. Real pipes tested separately."""
import io
import json
from pathlib import Path
import struct
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract as C
from atspi_backend import Backend
from helper import Broker, write_private_response
from test_contract import Backend as FakeBackend, Safety
from test_pipe import run


def request(method='capabilities', payload=None, **extra):
    return dict(id='private-request', method=method, payload={} if payload is None else payload, **extra)


def frame(r):
    body = json.dumps(r).encode()
    return struct.pack('!I', len(body)) + body


def response(data):
    size, = struct.unpack('!I', data[:4])
    assert len(data) == size + 4, 'Exactly one response, no unsolicited output'
    return json.loads(data[4:])


class TimingTests(unittest.TestCase):
    def test_opt_in_is_literal_private_envelope_only(self):
        self.assertEqual(C.read_request(io.BytesIO(frame(request()))), request())
        self.assertTrue(C.read_request(io.BytesIO(frame(request(diagnostics=True))))['diagnostics'])
        for value in (False, 1, 0, 'true', None, {}, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                C.read_request(io.BytesIO(frame(request(diagnostics=value))))
        with self.assertRaises(ValueError):
            C.read_request(io.BytesIO(frame(request(diagnostics=True, extra='secret'))))

    def test_disabled_has_no_clock_reads_no_metadata(self):
        broker = SimpleNamespace(request=lambda *_: True)
        with patch('contract._source_us', side_effect=AssertionError('diagnostic clock used')):
            self.assertEqual(C.timed_request(broker, request()), (True, None))
            with C.native_api_timing('invoke'):
                pass
        out = io.BytesIO()
        C.write_response(out, 'request', True)
        self.assertEqual(set(response(out.getvalue())), {'id', 'ok', 'result'})

    def test_real_pipe_default_off_opt_in_and_instance_clock_stability(self):
        plain = run(frame(request()))
        self.assertEqual(plain.returncode, 0)
        self.assertNotIn('diagnostics', response(plain.stdout))
        self.assertEqual(response(plain.stdout)['diagnosticsVersion'], 1)
        self.assertIs(type(response(plain.stdout)['diagnosticsVersion']), int)
        self.assertNotIn('diagnosticsVersion', response(plain.stdout)['result'])
        r = run(frame(request(diagnostics=True)) + frame(request('listTargets', diagnostics=True)))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stderr, b'')
        size, = struct.unpack('!I', r.stdout[:4])
        first, second = response(r.stdout[:4+size]), response(r.stdout[4+size:])
        self.assertFalse(first['result']['input'])
        self.assertEqual(first['diagnosticsVersion'], 1)
        self.assertNotIn('diagnosticsVersion', second)
        a, b = first['diagnostics'], second['diagnostics']
        self.assertEqual((a['instanceId'], a['clockId']), (b['instanceId'], b['clockId']))
        self.assertEqual(a['requestId'], 'private-request')
        self.assertEqual(b['method'], 'listTargets')
        self.assertLessEqual(a['spans'][0]['endUs'], b['spans'][0]['startUs'])
        self.assertNotEqual(a['clockId'], a['instanceId'])
        self.assertEqual(set(a), {'version', 'instanceId', 'clockId', 'requestId', 'method', 'spans'})
        for span in a['spans'] + b['spans']:
            self.assertEqual(set(span), {'phase', 'startUs', 'endUs', 'durationUs', 'status'})
            self.assertEqual(span['endUs'] - span['startUs'], span['durationUs'])
            self.assertTrue(all(type(span[k]) is int for k in ('startUs', 'endUs', 'durationUs')))

    def test_advertisement_is_private_capabilities_only_and_never_implicitly_enables_timing(self):
        r = run(frame(request()) + frame(request('listTargets')) + frame(request('listTargets', diagnostics=True)))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stderr, b'')
        remaining = r.stdout
        messages = []
        while remaining:
            size, = struct.unpack('!I', remaining[:4])
            messages.append(response(remaining[:4+size]))
            remaining = remaining[4+size:]
        self.assertEqual(len(messages), 3)
        self.assertEqual(set(messages[0]), {'id', 'ok', 'result', 'diagnosticsVersion'})
        self.assertNotIn('diagnosticsVersion', messages[0]['result'])
        self.assertEqual(set(messages[1]), {'id', 'ok', 'result'})
        self.assertEqual(set(messages[2]), {'id', 'ok', 'result', 'diagnostics'})
        self.assertEqual(messages[1]['result'], messages[2]['result'])

    def test_private_advertisement_writer_preserves_framing_default_off_and_byte_bound(self):
        out = io.BytesIO()
        with patch('contract._source_us', side_effect=AssertionError('default-off clock')):
            write_private_response(out, request(), {'input': False}, None)
        self.assertEqual(response(out.getvalue()), dict(id='private-request', ok=True, result={'input': False}, diagnosticsVersion=1))
        # Preserve a valid result even if optional advertisement/timing exceeds
        # the frame budget. No public capability or command schema is widened.
        out = io.BytesIO()
        with patch('helper.MAX_BYTES', 64), patch('contract.MAX_BYTES', 64):
            write_private_response(out, request(), True, {'large': 'x' * 64})
        self.assertEqual(response(out.getvalue()), dict(id='private-request', ok=True, result=True))
        with self.assertRaises(ValueError):
            write_private_response(io.BytesIO(), dict(request(), id=True), True, None)

    def test_optional_metadata_never_overflows_an_otherwise_valid_frame(self):
        out = io.BytesIO()
        with patch('contract.MAX_BYTES', 64):
            C.write_response(out, 'request', True, {'large': 'x' * 64})
        self.assertEqual(response(out.getvalue()), dict(id='request', ok=True, result=True))

    def test_each_actual_semantic_api_boundary_excludes_lookup_and_guard(self):
        for kind, phase in C._API_PHASES.items():
            order = []
            class Value:
                minimumValue, maximumValue = 0, 100
                @property
                def currentValue(self):
                    return 1
                @currentValue.setter
                def currentValue(self, value):
                    order.append('api')
            api = lambda *_: order.append('api') or True
            def lookup():
                order.append('lookup')
                return SimpleNamespace(setTextContents=api, doAction=api, selectChild=api)
            element = SimpleNamespace(queryEditableText=lookup, queryAction=lookup, queryValue=lambda: Value(),
                                      parent=SimpleNamespace(querySelection=lookup), getIndexInParent=lambda: 0)
            def source():
                order.append('clock')
                return [100, 110, 130, 160][order.count('clock')-1]
            broker = SimpleNamespace(request=lambda *_: Backend.act(None, kind, (element,), {'text': 'SECRET', 'deltaY': 5}, lambda: order.append('guard')))
            with patch('contract._source_us', side_effect=source), patch('contract._timing_domain', ('instance', 'clock', 0)):
                result, timing = C.timed_request(broker, request('execute', diagnostics=True))
            self.assertTrue(result)
            self.assertLess(order.index('guard'), order.index('api'))
            self.assertEqual(order[order.index('guard')+1:order.index('api')+2], ['clock', 'api', 'clock'])
            self.assertEqual(timing['spans'], [dict(phase='request', startUs=100, endUs=160, durationUs=60, status='returned'),
                                              dict(phase=phase, startUs=110, endUs=130, durationUs=20, status='returned')])
            self.assertNotIn('SECRET', json.dumps(timing))

    def test_failed_native_invocation_is_completed_api_not_delivery_evidence(self):
        def dispatch(*_):
            try:
                with C.native_api_timing('invoke'):
                    raise RuntimeError('private error text')
            except RuntimeError:
                return {'outcome': 'execution_unknown'}
        result, timing = C.timed_request(SimpleNamespace(request=dispatch), request('execute', diagnostics=True))
        self.assertEqual(result['outcome'], 'execution_unknown')
        self.assertEqual(timing['spans'][1]['status'], 'failed')
        self.assertEqual(timing['spans'][0]['status'], 'returned')
        self.assertNotIn('private error', json.dumps(timing))
        with self.assertRaises(RuntimeError):
            C.timed_request(SimpleNamespace(request=Mock(side_effect=RuntimeError('unhandled'))), request(diagnostics=True))
        self.assertIsNone(C._timing_context.get())

    def test_no_clipping_or_fake_intervals_when_bounds_exceeded(self):
        for ticks in ([5, 4], [0, 900_000_001], [0, 2**53]):
            with patch('contract._source_us', side_effect=ticks):
                self.assertEqual(C.timed_request(SimpleNamespace(request=lambda *_: True), request(diagnostics=True)), (True, None))

    def test_full_broker_observe_capture_and_rejected_click_keep_guards(self):
        backend = FakeBackend()
        backend.safe_canvas = lambda *_: True
        backend.capture = lambda *_: b'private PNG bytes'
        broker = Broker(backend, Safety())
        grant = dict(protocol=C.PROTOCOL, identity={k: k for k in C.IDENTITY}, grantId='g', epoch=1, expiresAt=C.now()+60000,
                     targets=[backend.target], allowControl=True, allowCapture=True, requester='private requester', goal='private goal')
        self.assertTrue(broker.start(dict(grant=grant, leaseId='lease')))
        def execute(kind, **fields):
            c = dict(protocol=C.PROTOCOL, identity=grant['identity'], grantId='g', epoch=1, commandId=C.uid(), deadlineAt=C.now()+30000,
                     action=dict(kind=kind, target=backend.target, **fields))
            return C.timed_request(broker, request('execute', dict(command=c, leaseId='lease'), diagnostics=True))
        observed, timing = execute('observe')
        self.assertEqual(observed['outcome'], 'executed')
        self.assertEqual(timing['spans'][0]['phase'], 'observe_request')
        captured, timing = execute('capture', observationId=observed['observation']['id'])
        self.assertEqual(captured['outcome'], 'executed')
        self.assertEqual(timing['spans'][0]['phase'], 'capture_request')
        self.assertNotIn('private', json.dumps(timing).replace('private-request', 'request'))
        refused, timing = execute('click', observationId=observed['observation']['id'], frameId='f', x=1, y=1)
        self.assertEqual(refused['code'], 'unsupported')
        self.assertEqual(len(timing['spans']), 1)
        self.assertEqual(backend.effects, 0)
        self.assertFalse(broker.capabilities()['input'])


if __name__ == '__main__':
    unittest.main()
