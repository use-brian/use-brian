"""Owned Xvfb/GTK source timing test. Logind, lease/consent guards simulated.
No production native-session acceptance, no model/evaluator or hardware input.
"""
import json
from pathlib import Path
import subprocess
import sys
import time
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from isolated_desktop import run_isolated, stop_process
from discovery_targets import selected_target
if not globals().get('_OWNED_DESKTOP_WORKER'):
    raise SystemExit(run_isolated(__file__, sys.argv[1:]))
import contract as C
from helper import Broker
from atspi_backend import Backend
from test_contract import Safety  # explicitly simulated authority; real backend APIs
from gi.repository import GLib


def wait(fn):
    for _ in range(100):
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        result = fn()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('native fixture readiness failed')


child = None
try:
    clock = None
    previous = 0
    for canvas in (False, True):
        child = subprocess.Popen([sys.executable, str(ROOT/'fixture.py'), '--canvas' if canvas else '--safe-form'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        backend = Backend()
        discovered = wait(lambda: next((t for t in backend.discover() if t['processId'] == child.pid), None))
        target = selected_target(discovered, 'Brian Safe Canvas' if canvas else 'Brian Native Fixture')
        window = backend.live(target)
        wait(lambda: backend.context(window)['foreground'])
        wait(lambda: backend.tree(window)[2] == 'complete')
        broker = Broker(backend, Safety())
        grant = dict(protocol=C.PROTOCOL, identity={k:k for k in C.IDENTITY}, grantId='g', epoch=1,
                     expiresAt=C.now()+120000, targets=[target], allowControl=True, allowCapture=canvas,
                     requester='local timing test', goal='local fixture only')
        assert broker.start(dict(grant=grant, leaseId='lease'))
        assert broker.capabilities()['input'] is False

        def command(kind, **extra):
            return dict(protocol=C.PROTOCOL, identity=grant['identity'], grantId='g', epoch=1,
                        commandId=C.uid(), deadlineAt=C.now()+30000, action=dict(kind=kind, target=target, **extra))

        def request(method, payload, expected='request', api=None):
            global clock, previous
            req = dict(id=C.uid(), method=method, payload=payload, diagnostics=True)
            result, timing = C.timed_request(broker, req)
            assert timing and timing['requestId'] == req['id'] and timing['method'] == method
            domain = (timing['instanceId'], timing['clockId'])
            assert clock is None or domain == clock
            clock = domain
            spans = timing['spans']
            assert len(spans) == (2 if api else 1)
            assert spans[0]['phase'] == expected and spans[0]['startUs'] >= previous
            previous = spans[0]['endUs']
            for span in spans:
                assert set(span) == {'phase', 'startUs', 'endUs', 'durationUs', 'status'}
                assert span['status'] == 'returned'
                assert all(type(span[k]) is int for k in ('startUs','endUs','durationUs'))
                assert 0 <= span['durationUs'] == span['endUs'] - span['startUs'] <= 900_000_000
            if api:
                assert spans[1]['phase'] == api
                assert spans[0]['startUs'] <= spans[1]['startUs'] <= spans[1]['endUs'] <= spans[0]['endUs']
            encoded = json.dumps(timing)
            assert len(encoded) < 2048 and 'PRIVATE_TIMING_SENTINEL' not in encoded
            return result

        def observe():
            result = request('execute', dict(command=command('observe'), leaseId='lease'), 'observe_request')
            assert result['code'] == 'ok'
            return result['observation'] if result['observation']['completeness'] == 'complete' else None

        observation = wait(observe)  # retry bounded read only, never replay effects
        if canvas:
            result = request('execute', dict(command=command('capture', observationId=observation['id']), leaseId='lease'), 'capture_request')
            assert result['outcome'] == 'executed' and result['observation']['frame']['mimeType'] == 'image/png'
            result = request('execute', dict(command=command('click', observationId=observation['id'], frameId=result['observation']['frame']['id'], x=10, y=10), leaseId='lease'))
            assert result['code'] == 'unsupported'
        else:
            for kind, name, extra in [('setValue','Harmless note',dict(text='PRIVATE_TIMING_SENTINEL')), ('invoke','Copy note locally',{}), ('select',None,{}), ('scroll',None,dict(deltaY=120))]:
                node = next(n for n in observation['nodes'] if kind in n['actions'] and (name is None or n['name'] == name))
                cmd = command(kind, observationId=observation['id'], ref=node['ref'], **extra)
                payload = dict(command=cmd, leaseId='lease')
                assert request('beginApproval', payload)
                assert request('endApproval', dict(**payload, approved=True))
                result = request('execute', payload, api=C._API_PHASES[kind])
                assert result['outcome'] == 'executed', 'semantic request refused (not retried)'
                observation = wait(observe)
        stop_process(child)
        child = None
    print('PASS real isolated GTK broker observation/capture and four AT-SPI API invocation timings; input disabled. Authority guards simulated; no delivery/acceptance claim.')
finally:
    if child is not None:
        stop_process(child)
