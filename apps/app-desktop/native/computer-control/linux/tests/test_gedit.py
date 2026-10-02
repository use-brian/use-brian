"""Admission and action-scope regressions; native_gedit.py provides real evidence."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch, mock_open, Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from atspi_backend import Backend, EDITOR, FIXTURE, GEDIT_EXECUTABLES
from test_completeness import ReadingBackend, Element
from test_safety import credential_status


class GeditTests(unittest.TestCase):
    def test_only_exact_audited_executables_admitted(self):
        backend = ReadingBackend()
        def cohort(executable, owner=None, argv=b'gedit\0--application-id=org.gnome.gedit\0'):
            class Proc:
                def stat(self):
                    return SimpleNamespace(st_uid=os.getuid() if owner is None else owner)
                def __truediv__(self,name):
                    return SimpleNamespace(resolve=lambda **kw: Path(executable),read_bytes=lambda:argv)
            with patch('atspi_backend.Path',return_value=Proc()), patch('safety.open', mock_open(read_data=credential_status(os.getuid(), os.getgid()))):
                return Backend.cohort(backend,123)
        for executable in GEDIT_EXECUTABLES:
            self.assertEqual(cohort(executable),EDITOR)
            self.assertIsNone(cohort(executable,owner=os.getuid()+1))
        rejected = [
            '/tmp/gedit', '/usr/local/bin/gedit', '/usr/bin/bash', '/usr/bin/sh',
            '/usr/bin/python3', '/usr/bin/gnome-text-editor',
            '/nix/store/unmeasured-gedit-50.0/bin/gedit',
            '/nix/store/unmeasured-gedit-50.0/bin/.gedit-wrapped',
        ]
        for executable in rejected:
            with self.subTest(executable=executable):
                self.assertIsNone(cohort(executable))

    def test_live_target_credential_change_refuses_before_ax_access(self):
        backend = Backend.__new__(Backend)
        backend.pump = lambda: None
        target = dict(processId=42, appId=EDITOR, windowInstanceId='window')
        element = Mock()
        backend.windows = {'window': dict(target=target, key='birth', element=element)}
        proc = Mock()
        proc.stat.return_value = SimpleNamespace(st_uid=os.getuid())
        proc.__truediv__ = Mock(return_value=SimpleNamespace(
            resolve=lambda **kw: Path('/usr/bin/gedit'), read_bytes=lambda: b'gedit\0'))
        good = credential_status(os.getuid(), os.getgid())
        target_status = good
        def status(path, mode):
            return mock_open(read_data=good if path == '/proc/thread-self/status' else target_status)()
        with patch('atspi_backend.Path', return_value=proc), patch('safety.open', side_effect=status), \
                patch('atspi_backend.process_key', return_value='birth'):
            self.assertEqual(backend.cohort(42), EDITOR)
            changes = [dict(Uid=f'{os.getuid()} {os.getuid()} 0 {os.getuid()}'),
                       dict(Gid=f'{os.getgid()} {os.getgid()} {os.getgid()} 0')]
            changes += [{key: '0000000000000001'} for key in ('CapEff', 'CapPrm', 'CapAmb', 'CapInh')]
            changes += [dict(CapEff=None)]
            for change in changes:
                target_status = credential_status(os.getuid(), os.getgid(), **change)
                with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'process changed'):
                    backend.live(target)
                self.assertEqual(element.mock_calls, [])
            target_status = good
            self.assertEqual(backend.cohort(42), EDITOR)
            with patch('safety.open', side_effect=FileNotFoundError()):
                self.assertIsNone(backend.cohort(42))

    def test_manifest_matches_exact_nix_pin(self):
        manifest = json.loads((Path(__file__).resolve().parents[1]/'dependencies.json').read_text())
        self.assertIn(manifest['nativeGeditTest']['executable'],GEDIT_EXECUTABLES)
        self.assertEqual(manifest['testedNativeStack']['gedit'],'50.0')
        self.assertEqual(len(GEDIT_EXECUTABLES),2)

    def test_document_only_setvalue(self):
        backend = ReadingBackend()
        for role in ('text','entry','button','toggle button','table column header','icon','menu item'):
            element = Element(text='synthetic',role=role)
            node,_ = backend.node(element,'r',None,EDITOR)
            self.assertEqual(node['actions'],['setValue'] if role=='text' else [])
        element = Element(text='synthetic')
        element.getState = lambda: SimpleNamespace(contains=lambda s:s in ('enabled','sensitive','showing','editable'))
        self.assertEqual(backend.node(element,'r',None,EDITOR)[0]['actions'],[])

    def test_passive_roles_remain_nonactionable_and_sensitive_attributes_redact(self):
        backend = ReadingBackend()
        for role in ('toggle button','table column header','icon','tree table'):
            element = Element(name='synthetic',role=role)
            node,_ = backend.node(element,'r',None,EDITOR)
            self.assertFalse(node['sensitive'])
            self.assertEqual(node['actions'],[])
            self.assertTrue(backend.node(element,'r',None,FIXTURE)[0]['sensitive'])
            element.getAttributes = lambda:['sensitive:true']
            node,_ = backend.node(element,'r',None,EDITOR)
            self.assertTrue(node['sensitive'])
            self.assertEqual(node['name'],'')
            self.assertEqual(node['actions'],[])
        self.assertTrue(backend.node(Element(role='unknown'),'r',None,EDITOR)[0]['sensitive'])

    def test_editor_tree_budget_is_bounded_and_fixture_budget_unchanged(self):
        for cohort in (EDITOR,FIXTURE):
            backend = ReadingBackend()
            backend.target['appId'] = cohort
            elapsed = [0]
            def clock():
                elapsed[0] += 350
                return elapsed[0]
            with patch('atspi_backend.mono',side_effect=clock):
                nodes,refs,complete = backend.tree(backend.w)
            self.assertEqual(complete,'complete' if cohort==EDITOR else 'partial')
            with patch('atspi_backend.mono',side_effect=[0,2000]):
                self.assertEqual(backend.tree(backend.w)[2],'partial')


if __name__=='__main__':
    unittest.main()
