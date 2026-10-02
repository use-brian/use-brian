"""Performance reductions must retain completeness, final guards and API spans."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import contract as C
from atspi_backend import Backend
from test_completeness import Element, ReadingBackend
import test_graph_freshness as graph_freshness


class TextReadTests(unittest.TestCase):
    def read(self,value,after=None,role='text'):
        calls=[]
        class Remote(Element):
            def getText(self,start,end):
                calls.append(('read',start,end))
                result=self.text[start:end]
                if after is not None:self.text=after
                return result
            @property
            def characterCount(self):
                calls.append(('count',))
                return len(self.text)
        element=Remote(text=value,role=role)
        node,complete=ReadingBackend().node(element,'r',None,'org.gnome.gedit')
        return node,complete,calls
    def test_one_bounded_read_then_one_fresh_count(self):
        for value in ('','abc','e\u0301','x'*4096,chr(0x1f600)*2048):
            with self.subTest(length=len(value)):
                node,complete,calls=self.read(value)
                self.assertTrue(complete)
                self.assertEqual(node['value'],value)
                self.assertEqual(calls,[('read',0,4097),('count',)])
    def test_growth_and_shrink_after_read_are_partial(self):
        for value,after in [('abc','abcd'),('abcd','abc'),('x'*4096,'x'*4097),
                            ('x'*8192,'x'*4096),('x'*4097,'x'*4096),('abc','')]:
            with self.subTest(before=len(value),after=len(after)):
                self.assertFalse(self.read(value,after)[1])
    def test_sentinel_and_utf16_scalar_clipping_remain_partial(self):
        for value in ('x'*4097,'x'*8192,chr(0x1f600)*2049,'x'*4095+chr(0x1f600),'e\u0301'*2048+'\u0301'):
            node,complete,calls=self.read(value)
            self.assertFalse(complete)
            self.assertLessEqual(C.utf16_units(node['value']),4096)
            self.assertFalse(any(0xd800<=ord(c)<=0xdfff for c in node['value']))
            self.assertEqual(calls,[('read',0,4097),('count',)])
    def test_sensitive_text_is_never_requested(self):
        node,complete,calls=self.read('synthetic',role='password text')
        self.assertEqual(calls,[])
        self.assertTrue(node['sensitive'])
        self.assertNotIn('value',node)
    def test_nonclamping_provider_fails_closed_without_fallback(self):
        backend=ReadingBackend()
        calls=[]
        def failed(start,end):
            calls.append((start,end))
            raise ValueError('bounded offsets unsupported')
        backend.field.getText=failed
        nodes,refs,complete=backend.tree(backend.w)
        self.assertEqual(complete,'partial')
        self.assertEqual(calls,[(0,4097)])
        self.assertFalse(any('value' in n for n in nodes))
    def test_unknown_fresh_count_is_rejected(self):
        class Unknown(Element):
            @property
            def characterCount(self):return -1
        with self.assertRaises(ValueError):
            ReadingBackend().node(Unknown(text='synthetic'),'r',None,'org.gnome.gedit')


class SemanticBarrierTests(unittest.TestCase):
    def prepared(self):
        backend,broker,p=graph_freshness.ApprovalPassTests.prepared(self)
        self.assertTrue(broker.end_approval(dict(**p,approved=True)))
        return backend,broker,p
    def test_one_full_final_scan_and_fresh_post_observation(self):
        backend,broker,p=self.prepared()
        before=broker.snapshot['observation']['id']
        with patch.object(backend,'unchanged',wraps=backend.unchanged) as scan, patch.object(backend,'tree',wraps=backend.tree) as observed:
            result=broker.execute(p)
            self.assertEqual(result['outcome'],'executed')
            self.assertEqual(scan.call_count,1)
            self.assertEqual(observed.call_count,1)
        self.assertNotEqual(result['observation']['id'],before)
    def test_missing_approval_cannot_dispatch_or_claim_freshness(self):
        backend,broker,p=self.prepared();broker.approved=None
        with patch.object(backend,'unchanged',wraps=backend.unchanged) as scan:
            self.assertEqual(broker.execute(p)['code'],'approval_required')
            scan.assert_not_called()
        self.assertEqual(backend.effects,0)
    def test_final_scan_still_rejects_content_and_truncated_sibling(self):
        for kind in ('content','clipped sibling'):
            backend,broker,p=self.prepared()
            if kind=='content':backend.field.text='changed'
            else:backend.root.children.append(Element(name='x'*4097,role='label',parent=backend.root))
            self.assertEqual(broker.execute(p)['outcome'],'not_executed')
            self.assertEqual(backend.effects,0)
    def test_guard_after_blocking_final_scan_prevents_effect(self):
        backend,broker,p=self.prepared();revoked=[False]
        scan=backend.unchanged
        def late(*args,**kwargs):
            result=scan(*args,**kwargs);revoked[0]=True;return result
        def guard():
            if revoked[0]:raise RuntimeError('revoked')
        backend.unchanged=late;broker.safety.check=guard
        self.assertEqual(broker.execute(p)['outcome'],'not_executed')
        self.assertEqual(backend.effects,0)
    def test_snapshot_and_ref_rebinding_cannot_cross_final_barrier(self):
        for kind in ('snapshot','ref'):
            backend,broker,p=self.prepared();fresh=broker.fresh
            def replace(c):
                w,s=fresh(c)
                if kind=='snapshot':
                    s=dict(s);broker.snapshot=s
                else:
                    ref=c['action']['ref'];e,n,cs=s['refs'][ref]
                    s['refs'][ref]=(e,dict(n),list(cs))
                return w,s
            broker.fresh=replace
            self.assertEqual(broker.execute(p)['outcome'],'not_executed')
            self.assertEqual(backend.effects,0)
    def test_actual_setter_guard_remains_after_blocking_lookup(self):
        backend,broker,p=self.prepared();revoked=[False];calls=[]
        class Editable:
            def queryEditableText(self):revoked[0]=True;return self
            def setTextContents(self,value):calls.append('setter');return True
        def guard():
            if revoked[0]:raise RuntimeError('expired after lookup')
        broker.safety.check=guard
        backend.act=lambda kind,ref,action,check:Backend.act(None,kind,(Editable(),),action,check)
        result=broker.execute(p)
        self.assertNotEqual(result['outcome'],'executed')
        self.assertEqual(calls,[])
    def test_capture_keeps_pre_and_post_full_scans(self):
        for mutate in (False,True):
            backend,broker,_=self.prepared();broker.grant['allowCapture']=True
            backend.safe_canvas=lambda *_:True  # policy stub only; native canvas tested separately
            def capture(w):
                if mutate:backend.field.text='changed during capture'
                return b'unit-test-only'
            backend.capture=capture
            c=dict(protocol=C.PROTOCOL,identity=broker.grant['identity'],grantId='g',epoch=1,
                commandId=C.uid(),deadlineAt=C.now()+30000,
                action=dict(kind='capture',target=backend.target,observationId=broker.snapshot['observation']['id']))
            with patch.object(backend,'unchanged',wraps=backend.unchanged) as scan:
                result=broker.execute(dict(command=c,leaseId='l'))
                self.assertEqual(scan.call_count,2)
            self.assertEqual(result['outcome'],'not_executed' if mutate else 'executed')
            if mutate:self.assertNotIn('frame',result.get('observation',{}))


if __name__=='__main__':unittest.main()
