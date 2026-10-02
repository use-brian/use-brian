"""Test-only mirror of trusted main's discovery -> strict authority projection.

Never weaken Backend.live or native grant validation to consume UI metadata.
The optional Node check uses real Broker discovery and production framing, with
simulated readiness only; it does not establish production session authority.
"""
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import contract as C


def selected_target(discovered, expected_title=None):
    assert isinstance(discovered, dict)
    assert set(C.TARGET) <= discovered.keys() <= set(C.TARGET) | {'displayName'}
    if 'displayName' in discovered:
        assert C.text(discovered['displayName'], 256, 0), 'invalid local discovery label'
    if expected_title is not None:
        assert isinstance(discovered.get('displayName'), str)
        assert discovered['displayName'] == C.utf16_prefix(expected_title, 256), 'wrong human window label'
        assert discovered['displayName'].strip(), 'empty human window label'
    # Explicit five-field projection, not mutation of the discovery cache.
    target = {key: discovered[key] for key in C.TARGET}
    assert C.target(target) and 'displayName' not in target
    return target


def check_discovery_frame(backend):
    from helper import Broker
    # listTargets needs no actions/lease; simulated readiness is explicit here.
    discovered = Broker(backend, SimpleNamespace(check=lambda: None)).request('listTargets', {})
    assert discovered and any(isinstance(t.get('displayName'), str) and t['displayName'] for t in discovered)
    frame = io.BytesIO()
    C.write_response(frame, 'discovery-shape', discovered)
    wire = frame.getvalue()
    size, = struct.unpack('!I', wire[:4])
    assert len(wire) == size + 4
    response = json.loads(wire[4:])
    assert response['id'] == 'discovery-shape' and response['ok'] is True
    for target in response['result']:
        selected_target(target)
    node = shutil.which('node')
    if node is None:
        print('SKIP: optional shared DiscoverySchema frame check (Node unavailable)', flush=True)
        return
    protocol = Path(__file__).resolve().parents[6] / 'packages/computer-control/dist/protocol.js'
    assert protocol.is_file(), 'rebuild shared protocol declarations/runtime before Node frame check'
    code = '''
import { readFileSync } from 'node:fs';
const { DiscoveredTargetSchema, TargetSchema } = await import(process.argv[1]);
const wire = readFileSync(0);
if (wire.readUInt32BE(0) !== wire.length - 4) throw Error('bad frame length');
const response = JSON.parse(wire.subarray(4).toString('utf8'));
if (response.id !== 'discovery-shape' || response.ok !== true) throw Error('bad helper response');
const targets = DiscoveredTargetSchema.array().max(128).parse(response.result);
if (!targets.length) throw Error('no real discovery');
for (const discovered of targets) {
  if (typeof discovered.displayName !== 'string' || !discovered.displayName.trim()) throw Error('missing human label');
  if (TargetSchema.safeParse(discovered).success) throw Error('metadata accepted as authority');
  const { displayName, ...base } = discovered;
  TargetSchema.parse(base);
  // Legacy five-field helpers remain valid discoveries.
  DiscoveredTargetSchema.parse(base);
  if (DiscoveredTargetSchema.safeParse({ ...discovered, extra: true }).success) throw Error('non-strict discovery');
}
console.log('PASS: real Broker listTargets frame decoded by shared DiscoveredTargetSchema; strict authority and legacy five-field discovery');
'''
    result = subprocess.run([node, '--input-type=module', '-e', code, protocol.as_uri()],
                            input=wire, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    assert result.returncode == 0, 'shared discovery frame validation failed (values withheld)'
    print(result.stdout.decode().strip(), flush=True)


if __name__ == '__main__':
    import unittest

    class ProjectionTests(unittest.TestCase):
        def test_legacy_and_labelled_discovery(self):
            base = dict(appId='editor', processId=1, processInstanceId='p', windowId='w', windowInstanceId='wi')
            self.assertEqual(selected_target(base), base)
            discovered = dict(base, displayName='First document')
            self.assertEqual(selected_target(discovered, 'First document'), base)
            self.assertEqual(discovered['displayName'], 'First document')
            self.assertFalse(C.target(discovered))

        def test_invalid_discovery_is_not_laundered_into_authority(self):
            base = dict(appId='editor', processId=1, processInstanceId='p', windowId='w', windowInstanceId='wi')
            for patch in ({'displayName': '😀' * 129}, {'displayName': None}, {'token': 'extra'}, {'processId': 0}):
                with self.assertRaises(AssertionError):
                    selected_target(dict(base, **patch))

    unittest.main()
