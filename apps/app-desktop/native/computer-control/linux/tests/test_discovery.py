"""Local titles are not authoritative identities or snapshot target metadata."""
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from atspi_backend import Backend, EDITOR
from test_completeness import Element


class DiscoveryTests(unittest.TestCase):
    def test_local_names_strict_storage_and_reused_identity(self):
        first = Element(name='a' * 255 + '😀', role='frame')
        second = Element(name='Second document', role='frame')
        app = Element()
        app.children = [first, second]
        app.get_process_id = lambda: 42
        desktop = Element()
        desktop.children = [app]
        backend = Backend.__new__(Backend)
        backend.desktop, backend.windows, backend.processes = desktop, {}, {}
        backend.pump = lambda: None
        backend.cohort = lambda pid: EDITOR
        backend.bounds = lambda element: {'x': 0}
        backend.x = SimpleNamespace(match=lambda pid, bounds: 7)
        backend.a = SimpleNamespace(STATE_SHOWING='showing')
        with patch('atspi_backend.process_key', return_value='process-one'):
            targets = backend.discover()
            self.assertEqual([t['displayName'] for t in targets], ['a' * 255, 'Second document'])
            self.assertNotEqual(targets[0]['windowId'], targets[1]['windowId'])
            for window in backend.windows.values():
                self.assertEqual(len(window['target']), 5)
                self.assertNotIn('displayName', window['target'])
            first.name = 'Renamed'
            renamed = backend.discover()
            self.assertEqual(renamed[0]['windowInstanceId'], targets[0]['windowInstanceId'])
            self.assertEqual(renamed[0]['displayName'], 'Renamed')
            app.children[0] = Element(name='Renamed', role='frame')
            self.assertNotEqual(backend.discover()[0]['windowInstanceId'], targets[0]['windowInstanceId'])
        with patch('atspi_backend.process_key', return_value='process-two'):
            self.assertNotEqual(backend.discover()[1]['processInstanceId'], targets[1]['processInstanceId'])


if __name__ == '__main__':
    unittest.main()
