"""Instrumentation preserves results/guards; bounded reports cannot log AX data."""
import contextlib
import cProfile
import io
import json
import time
from types import SimpleNamespace
import unittest
import native_profile as P
import contract as C


class ProfileTests(unittest.TestCase):
    def tearDown(self):
        self.assertIsNone(P.API_STATS)

    def broker(self,callback,check=lambda:None):
        class Broker:
            def start(self,payload):return callback(payload)
            execute=start
            begin_approval=start
            end_approval=start
        P.install(Broker)
        b=Broker();b.safety=SimpleNamespace(check=check)
        return b

    def test_result_and_guard_preserved_no_content_or_identifiers(self):
        secret='synthetic-private-name-value-identifier'
        expected={'code':secret,'observation':{'nodes':[secret],'completeness':secret}}
        checks=[]
        check=lambda:checks.append(1)
        b=self.broker(lambda p:expected,check)
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIs(b.start({'value':secret}),expected)
        self.assertEqual(len(checks),2)
        self.assertIs(b.safety.check,check)
        self.assertNotIn(secret,out.getvalue())
        record=json.loads(out.getvalue().split(' ',1)[1])
        self.assertFalse(record['receiptOk']);self.assertIsNone(record['completeness'])
        self.assertLessEqual(len(record['functions']),64)

    def test_exception_preserved_and_guard_restored_without_error_text(self):
        error=ValueError('synthetic-private-error-content')
        def fail(p):raise error
        b=self.broker(fail);original=b.safety.check
        out=io.StringIO()
        with contextlib.redirect_stdout(out),self.assertRaises(ValueError) as caught:
            b.start({})
        self.assertIs(caught.exception,error)
        self.assertIs(b.safety.check,original)
        self.assertNotIn(str(error),out.getvalue())
        self.assertIn('"status":"raised"',out.getvalue())

    def test_existing_guard_cannot_be_bypassed(self):
        called=[]
        def deny():raise RuntimeError('original guard')
        b=self.broker(lambda p:called.append(1),deny)
        with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'original guard'):
            b.start({})
        self.assertFalse(called)
        self.assertIs(b.safety.check,deny)

    def test_real_deadline_refuses_late_effect_and_reports_failure(self):
        effects=[]
        def late(p):
            time.sleep(3.55)  # actual elapsed time, never a latency sample
            b.safety.check()
            effects.append(1)
        b=self.broker(late);original=b.safety.check
        out=io.StringIO()
        with contextlib.redirect_stdout(out),self.assertRaisesRegex(RuntimeError,'3500ms budget'):
            b.start({})
        self.assertFalse(effects)
        self.assertIs(b.safety.check,original)
        record=json.loads(out.getvalue().split(' ',1)[1])
        self.assertTrue(record['overBudget'])
        self.assertEqual(record['status'],'raised')
        self.assertGreaterEqual(record['wallMs'],3500)

    def test_record_bound_fails_instead_of_silently_sampling(self):
        b=self.broker(lambda p:True)
        with contextlib.redirect_stdout(io.StringIO()):
            for _ in range(P.MAX_REPORTS):self.assertTrue(b.start({}))
            with self.assertRaisesRegex(RuntimeError,'record bound'):b.start({})

    def test_real_profile_exports_only_fixed_function_metadata(self):
        profile=cProfile.Profile()
        profile.enable();C.text('synthetic-private-content');profile.disable()
        rows=P.rows(profile)
        self.assertTrue(any(r['function']=='contract.py:text' for r in rows))
        self.assertNotIn('synthetic-private-content',json.dumps(rows))
        entry=SimpleNamespace(code=C.text.__code__,callcount=1,inlinetime=.01,totaltime=.02)
        self.assertEqual(len(P.rows(SimpleNamespace(getstats=lambda:[entry]*100))),64)

    def test_native_api_descriptors_preserve_reads_and_exceptions(self):
        calls=[]
        class Accessible:
            def read(self,*args):calls.append(args);return 'synthetic-private-content'
            clear_cache=getRoleName=getState=getAttributes=get_interfaces=getChildAtIndex=read
            name=parent=childCount=property(read)
        class State:
            def contains(self,key):return key==1
        P.install_api_timers(Accessible,State)
        P.API_STATS={}
        try:
            self.assertEqual(Accessible().name,'synthetic-private-content')
            self.assertEqual(Accessible().getChildAtIndex(7),'synthetic-private-content')
            self.assertTrue(State().contains(1))
            self.assertEqual(calls,[(),(7,)])
            self.assertEqual(P.API_STATS['name']['calls'],1)
            self.assertNotIn('synthetic-private-content',json.dumps(P.API_STATS))
        finally:P.API_STATS=None


if __name__=='__main__':unittest.main()
