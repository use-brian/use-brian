"""Actual private helper process framing/refusal tests; no native authority."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]


def frame(method, payload):
    data = json.dumps(dict(id=method, method=method, payload=payload)).encode()
    return struct.pack('!I', len(data)) + data


def run(data):
    env = {'PATH': '/usr/bin:/bin', 'WAYLAND_DISPLAY': 'wayland-test', 'XDG_SESSION_TYPE': 'wayland'}
    return subprocess.run([sys.executable, '-Es', str(ROOT / 'helper.py')], input=data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, env=env)


class PipeTests(unittest.TestCase):
    def test_all_six_methods_fail_closed_without_supported_session(self):
        requests = [('capabilities', {}), ('listTargets', {}), ('start', {'grant': {}, 'leaseId': 'x'}),
                    ('beginApproval', {'command': {}, 'leaseId': 'x'}),
                    ('endApproval', {'command': {}, 'leaseId': 'x', 'approved': True}),
                    ('execute', {'command': {}, 'leaseId': 'x'})]
        result = run(b''.join(frame(method, payload) for method, payload in requests))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b'')
        output, responses = result.stdout, []
        for method, _ in requests:
            size, = struct.unpack('!I', output[:4])
            response = json.loads(output[4:4+size])
            self.assertEqual(response['id'], method)
            self.assertIs(response['ok'], True)
            responses.append(response['result'])
            output = output[4+size:]
        self.assertEqual(output, b'')
        self.assertFalse(responses[0]['axRead'])
        self.assertFalse(responses[0]['input'])
        self.assertIn('Wayland', responses[0]['limitations'][0])
        self.assertEqual(responses[1:5], [[], False, False, False])
        self.assertEqual(responses[5]['outcome'], 'not_executed')
    def test_bad_frame_terminates_without_output(self):
        result = run(struct.pack('!I', 4*1024*1024+1))
        self.assertEqual(result.returncode, 64)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'')
    def test_eof_revokes(self):
        self.assertEqual(run(b'').returncode, 0)


if __name__ == '__main__':
    unittest.main()
