"""Graph corruption, live reparenting, closure and approval-pass regressions."""
import copy
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import io
from contextlib import redirect_stdout
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import contract as C
from helper import Broker
from test_completeness import Element, ReadingBackend
from test_focus import RestoringBackend
from test_contract import Safety
from gedit_timing import DeadlineGuard, TimedBroker


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.b = ReadingBackend()
        _,self.refs,complete = self.b.tree(self.b.w)
        self.assertEqual(complete,'complete')
        self.root = next(r for r,v in self.refs.items() if v[0] is self.b.root)
        self.leaf = next(r for r,v in self.refs.items() if v[0] is self.b.field)
    def cloned(self):
        return {r:(e,copy.deepcopy(n),list(cs)) for r,(e,n,cs) in self.refs.items()}
    def test_corrupt_refs_fail_before_live_calls(self):
        corruptions = [
            lambda r:r.clear(),
            lambda r:r.pop(self.root),
            lambda r:r[self.leaf][1].update(parentRef='missing'),
            lambda r:r[self.leaf][1].update(parentRef=self.leaf),
            lambda r:r[self.root][1].update(parentRef=self.leaf),
            lambda r:r[self.leaf][1].pop('parentRef'),
            lambda r:r[self.leaf][1].update(ref='not-key'),
            lambda r:r[self.root][2].append(self.b.field),
            lambda r:r[self.root][2].append(Element()),
            lambda r:r[self.leaf][2].append(self.b.root),
            lambda r:r[self.leaf][1].update(sensitive=True),
        ]
        for mutate in corruptions:
            refs=self.cloned();mutate(refs)
            with patch.object(self.b,'live',wraps=self.b.live) as live:
                self.assertFalse(self.b.unchanged(self.b.w,refs))
                live.assert_not_called()
    def test_duplicate_accessible_and_disconnected_cycle(self):
        refs=self.cloned()
        refs['alias']=(self.b.field,dict(ref='alias',role='text',sensitive=False,parentRef=self.root),[])
        self.assertFalse(self.b.unchanged(self.b.w,refs))
        refs=self.cloned()
        for r,p in [('a','b'),('b','a')]:
            refs[r]=(Element(),dict(ref=r,role='panel',sensitive=False,parentRef=p),[])
        self.assertFalse(self.b.unchanged(self.b.w,refs))
    def test_live_reparent_inside_same_root_is_not_unchanged(self):
        other=Element(role='panel',parent=self.b.root)
        self.b.root.children.append(other)
        _,refs,c=self.b.tree(self.b.w)
        self.assertEqual(c,'complete')
        # Even unchanged enumeration lists cannot hide a changed live parent.
        self.b.field.parent=other
        self.assertFalse(self.b.unchanged(self.b.w,refs))
    def test_live_child_membership_order_changes_fail(self):
        other=Element(role='label',parent=self.b.root)
        self.b.root.children.append(other)
        _,refs,_=self.b.tree(self.b.w)
        self.b.root.children.reverse()
        self.assertFalse(self.b.unchanged(self.b.w,refs))
    def test_virtual_parent_closure_is_observed_and_revalidated(self):
        relative=Element(role='panel',parent=self.b.root)
        extra=Element(role='label',parent=relative)
        relative.children=[extra,self.b.field]
        self.b.field.parent=relative
        _,refs,c=self.b.tree(self.b.w)
        self.assertEqual(c,'complete')
        self.assertEqual(len(refs),4)
        by_element={e:r for r,(e,n,cs) in refs.items()}
        self.assertEqual(refs[by_element[self.b.field]][1]['parentRef'],by_element[relative])
        self.assertTrue(self.b.unchanged(self.b.w,refs))
        extra.name='changed'
        self.assertFalse(self.b.unchanged(self.b.w,refs))
    def test_outside_or_cyclic_parent_closure_never_reads_extra_content(self):
        for cyclic in (False,True):
            outside=Element(role='panel')
            outside.parent=outside if cyclic else None
            self.b.field.parent=outside
            with patch.object(self.b,'node',wraps=self.b.node) as node:
                self.assertEqual(self.b.tree(self.b.w)[2],'partial')
                self.assertFalse(any(c.args[0] is outside for c in node.call_args_list))
    def test_sensitive_virtual_ancestor_redacts_already_enumerated_descendants(self):
        secret=Element(role='password text',parent=self.b.root)
        secret.children=[self.b.field]
        self.b.field.parent=secret
        nodes,refs,complete=self.b.tree(self.b.w)
        self.assertEqual(complete,'partial')
        self.assertFalse(any(e is self.b.field for e,n,c in refs.values()))
        self.assertTrue(any(n['sensitive'] for n in nodes))
        self.assertFalse(any(n.get('value')==self.b.field.text for n in nodes))

    def test_missing_live_parent_is_partial(self):
        self.b.field.parent=None
        self.assertEqual(self.b.tree(self.b.w)[2],'partial')
    def test_parent_ipc_count_is_linear(self):
        class Counted(Element):
            reads=0
            @property
            def parent(self):
                self.reads+=1
                return self._parent
            @parent.setter
            def parent(self,v): self._parent=v
        nodes=[self.b.root]
        self.b.root.children=[]
        for i in range(12):
            e=Counted(role='panel',parent=nodes[-1]);nodes[-1].children=[e];nodes.append(e)
        _,refs,c=self.b.tree(self.b.w)
        self.assertEqual(c,'complete')
        for n in nodes[1:]:n.reads=0
        self.assertTrue(self.b.unchanged(self.b.w,refs))
        self.assertEqual(sum(n.reads for n in nodes[1:]),12)


class ApprovalPassTests(unittest.TestCase):
    def prepared(self):
        backend=RestoringBackend();backend.x.foreground_window=100
        guard=Safety();guard.parent=55
        broker=Broker(backend,guard)
        grant=dict(protocol=C.PROTOCOL,identity={k:k for k in C.IDENTITY},grantId='g',epoch=1,
            expiresAt=C.now()+60000,targets=[backend.target],allowControl=True,allowCapture=False,requester='test',goal='test')
        self.assertTrue(broker.start(dict(grant=grant,leaseId='l')))
        c=dict(protocol=C.PROTOCOL,identity=grant['identity'],grantId='g',epoch=1,commandId=C.uid(),
            deadlineAt=C.now()+30000,action=dict(kind='observe',target=backend.target))
        o=broker.execute(dict(command=c,leaseId='l'))['observation']
        ref=next(n['ref'] for n in o['nodes'] if n['role']=='text')
        c=dict(c,commandId=C.uid(),action=dict(kind='setValue',target=backend.target,observationId=o['id'],ref=ref,text='test'))
        p=dict(command=c,leaseId='l')
        self.assertTrue(broker.begin_approval(p))
        backend.x.foreground_window=200
        return backend,broker,p
    def test_end_has_exactly_two_full_passes_actions_keep_final_full_checks(self):
        backend,broker,p=self.prepared()
        with patch.object(backend,'unchanged',wraps=backend.unchanged) as unchanged:
            self.assertTrue(broker.end_approval(dict(**p,approved=True)))
            self.assertEqual(unchanged.call_count,2)
            unchanged.reset_mock()
            self.assertEqual(broker.execute(p)['outcome'],'executed')
            self.assertEqual(unchanged.call_count,1)  # final whole-tree semantic barrier
    def test_post_restoration_reparent_or_clipping_refuses_approval(self):
        for mode in ('reparent','clip'):
            backend,broker,p=self.prepared()
            def mutate():
                if mode=='clip':backend.field.text='x'*4097
                else:backend.field.parent=Element()
            backend.x.after_request=mutate
            self.assertFalse(broker.end_approval(dict(**p,approved=True)))
            self.assertIsNone(broker.approved)
            self.assertEqual(backend.effects,0)
    def test_partial_wrong_id_and_expired_approval_still_refused(self):
        for mode in ('partial','id','expiry'):
            backend,broker,p=self.prepared()
            if mode=='partial':broker.snapshot['observation']['completeness']='partial'
            elif mode=='id':broker.snapshot['observation']['id']='wrong'
            else:broker.approval_expiry=C.mono()-1
            self.assertFalse(broker.end_approval(dict(**p,approved=True)))
            self.assertEqual(backend.x.requests,0)


class RequestDeadlineTests(unittest.TestCase):
    def test_elapsed_deadline_raises_and_latches(self):
        guard=DeadlineGuard();guard.request_deadline=3500
        with patch('contract.mono',return_value=3501):
            with self.assertRaises(RuntimeError):guard.check()
        guard.request_deadline=float('inf')
        with self.assertRaises(RuntimeError):guard.check()
    def test_swallowed_timeout_cannot_pass_native_instrumentation(self):
        guard=DeadlineGuard();broker=TimedBroker(ReadingBackend(),guard)
        def refused(b,p):
            guard.expired.set()
            return False
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):broker.measured('probe',refused,{})
        self.assertTrue(guard.expired.is_set())


if __name__=='__main__':unittest.main()
