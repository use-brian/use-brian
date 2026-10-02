"""Real normalization/freshness code over mock accessible objects, not native acceptance."""
import copy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from atspi_backend import Backend, FIXTURE
from helper import Broker
import contract as C
from test_contract import Safety


class Element:
    def __init__(self, name='', text=None, role='text', parent=None):
        self.name, self.text, self.role, self.parent = name, text, role, parent
        self.children = []
    def clear_cache(self):
        pass
    def getRoleName(self):
        return self.role
    def getState(self):
        return SimpleNamespace(contains=lambda state: state in ('enabled','sensitive','showing','editable','multi_line'))
    def getAttributes(self):
        return []
    def get_interfaces(self):
        return ['Text','EditableText'] if self.text is not None else []
    def queryText(self):
        return self
    @property
    def characterCount(self):
        return len(self.text)
    def getText(self, start, end):
        return self.text[start:end]
    @property
    def childCount(self):
        return len(self.children)
    def getChildAtIndex(self, index):
        return self.children[index]


class ReadingBackend(Backend):
    def __init__(self):
        states = 'enabled sensitive showing editable multi_line focused selected vertical'.split()
        self.a = SimpleNamespace(**{'STATE_'+s.upper():s for s in states})
        self.root = Element('window', role='frame')
        self.field = Element('note', 'short', parent=self.root)
        self.root.children = [self.field]
        self.target = dict(appId=FIXTURE,processId=5,processInstanceId='p',windowId='w',windowInstanceId='wi')
        self.w = dict(target=self.target,element=self.root)
        self.effects = 0
        self.restores = 0
    def live(self, target):
        if target != self.target:
            raise ValueError('wrong target')
        return self.w
    def bounds(self, element):
        return dict(x=0,y=0,width=400,height=300)
    def context(self, w):
        return dict(bounds=self.bounds(self.root),displayLayoutVersion='layout',foreground=True)
    def restore_consented_focus(self,w,refs,context,parent_pid,guard,strict_after=True):
        guard()
        if not self.unchanged(w,refs):
            raise ValueError('changed')
        self.restores += 1
        return True
    def act(self,kind,ref,action,guard):
        guard()
        self.effects += 1
        return True


class CompletenessTests(unittest.TestCase):
    def setUp(self):
        self.os = ReadingBackend()
        self.b = Broker(self.os,Safety())
        self.g = dict(protocol=C.PROTOCOL,identity={k:k for k in C.IDENTITY},grantId='g',epoch=1,
            expiresAt=C.now()+60000,targets=[self.os.target],allowControl=True,allowCapture=False,requester='local',goal='test')
        self.assertTrue(self.b.start(dict(grant=self.g,leaseId='lease')))
    def command(self, kind='observe', **fields):
        return dict(protocol=C.PROTOCOL,identity=self.g['identity'],grantId='g',epoch=1,commandId=C.uid(),
            deadlineAt=C.now()+30000,action=dict(kind=kind,target=self.os.target,**fields))
    def execute(self,c):
        return self.b.execute(dict(command=c,leaseId='lease'))
    def observe_action(self):
        o = self.execute(self.command())['observation']
        ref = next(n['ref'] for n in o['nodes'] if n['role']=='text')
        return o,self.command('setValue',observationId=o['id'],ref=ref,text='allowed short value')
    def test_all_truncated_names_and_values_are_partial(self):
        for attribute in ('name','text'):
            for content in ('x'*4097, '\U0001f600'*2049):
                with self.subTest(attribute=attribute,astral=content[0]!='x'):
                    self.os.field.name,self.os.field.text = 'note','short'
                    setattr(self.os.field,attribute,content)
                    o,c = self.observe_action()
                    self.assertEqual(o['completeness'],'partial')
                    self.assertFalse(self.b.begin_approval(dict(command=c,leaseId='lease')))
                    self.b.approved = C.digest(c)  # even cached approval cannot authorize a partial tree
                    self.assertEqual(self.execute(c)['outcome'],'not_executed')
        self.assertEqual(self.os.effects,0)
    def test_changed_truncated_suffix_never_counts_as_unchanged(self):
        for attribute in ('name','text'):
            self.os.field.name,self.os.field.text = 'note','short'
            setattr(self.os.field,attribute,'x'*4096+'old suffix')
            o,c = self.observe_action()
            refs = self.b.snapshot['refs']
            setattr(self.os.field,attribute,'x'*4096+'NEW suffix')
            self.assertFalse(self.os.unchanged(self.os.w,refs))
            self.assertFalse(self.b.begin_approval(dict(command=c,leaseId='lease')))
            self.assertEqual(self.execute(c)['outcome'],'not_executed')
        self.assertEqual(self.os.effects,0)
    def test_exact_utf16_limit_is_complete(self):
        for value in ('x'*4096, '\U0001f600'*2048):
            self.os.field.name = value
            self.os.field.text = value
            o,_ = self.observe_action()
            self.assertEqual(o['completeness'],'complete')
    def test_complete_prefix_becomes_partial_before_approval_end(self):
        self.os.field.text = 'x'*4096
        _,c = self.observe_action()
        self.assertTrue(self.b.begin_approval(dict(command=c,leaseId='lease')))
        self.os.field.text += 'unobserved suffix'
        self.assertFalse(self.b.end_approval(dict(command=c,leaseId='lease',approved=True)))
        self.assertEqual(self.os.restores,0)
        self.assertEqual(self.os.effects,0)
    def test_complete_prefix_becomes_partial_before_dispatch(self):
        self.os.field.text = 'x'*4096
        _,c = self.observe_action()
        p = dict(command=c,leaseId='lease')
        self.assertTrue(self.b.begin_approval(p))
        self.assertTrue(self.b.end_approval(dict(**p,approved=True)))
        self.os.field.text += 'unobserved suffix'
        self.assertEqual(self.execute(c)['outcome'],'not_executed')
        self.assertEqual(self.os.effects,0)
    def test_partial_after_approval_does_not_dispatch(self):
        _,c = self.observe_action()
        p = dict(command=c,leaseId='lease')
        self.assertTrue(self.b.begin_approval(p))
        self.assertTrue(self.b.end_approval(dict(**p,approved=True)))
        self.b.snapshot['observation']['completeness'] = 'partial'
        self.assertEqual(self.execute(c)['outcome'],'not_executed')
        self.assertEqual(self.os.effects,0)
    def test_generic_focus_stays_unsupported(self):
        o,_ = self.observe_action()
        c = self.command('focus',observationId=o['id'])
        self.assertFalse(self.b.begin_approval(dict(command=c,leaseId='lease')))
        self.assertEqual(self.execute(c)['code'],'unsupported')
        self.assertEqual(self.os.restores,0)
    def test_truncated_sibling_also_blocks_effect(self):
        sibling = Element('x'*4097,role='label',parent=self.os.root)
        self.os.root.children.append(sibling)
        o,c = self.observe_action()
        self.assertEqual(o['completeness'],'partial')
        self.assertFalse(self.b.begin_approval(dict(command=c,leaseId='lease')))


if __name__ == '__main__':
    unittest.main()
