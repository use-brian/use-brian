"""Native-test instrumentation: real 3500ms deadline, simulated OS authority.
Not a production Safety replacement. Expected failures remain in latency samples.
"""
import json
import os
import threading
import contract as C
from helper import Broker

REQUEST_BUDGET_MS = 3500


class DeadlineGuard:
    parent = os.getpid()
    deadline = float('inf')
    approval = False
    approval_window = 0
    request_deadline = float('inf')
    def __init__(self):
        self.lock = threading.RLock()
        self.expired = threading.Event()
    def acquire(self,expiry):
        self.deadline = C.mono()+expiry-C.now()
    def check(self):
        if C.mono() >= self.request_deadline:
            self.expired.set()
        if self.expired.is_set():
            raise RuntimeError('3500ms request watchdog expired')
        if C.mono() >= self.deadline:
            raise RuntimeError('simulated lease expired')
    def close_approval(self):
        self.check()
        self.approval = False
        self.approval_window = 0


class TimedBroker(Broker):
    # Shared counts within one fresh process/session; first successful call per
    # operation is cold-first-use, later calls warm. Driver aggregates sessions.
    counts = {}
    profile_expected = True
    def measured(self,name,method,p):
        if getattr(self, '_source_dispatch', False):
            return method(self,p)
        guard = self.safety
        start = C.mono()
        guard.request_deadline = start+REQUEST_BUDGET_MS
        timer = threading.Timer(REQUEST_BUDGET_MS/1000,guard.expired.set)
        timer.daemon = True
        timer.start()
        result = None
        timing = None
        passed = False
        try:
            guard.check()
            endpoint = {'start':'start','begin_approval':'beginApproval',
                        'end_approval':'endApproval','execute':'execute'}.get(method.__name__)
            if endpoint is None:  # unit-only injected callback
                result = method(self,p)
            else:
                self._source_dispatch = True
                try:
                    result,timing = C.timed_request(self,dict(id=C.uid(),method=endpoint,payload=p,diagnostics=True))
                finally:
                    self._source_dispatch = False
            guard.check()  # caught backend/Broker timeout may NEVER pass the test
            passed = True
            return result
        finally:
            timer.cancel()
            timer.join()
            elapsed = C.mono()-start
            over = guard.expired.is_set() or elapsed >= REQUEST_BUDGET_MS
            if over:
                guard.expired.set()  # latched; cannot resume on the next request
            guard.request_deadline = float('inf')
            success = passed and not over and (result is True or (
                isinstance(result,dict) and result.get('outcome')=='executed' and
                result.get('observation',{}).get('completeness')=='complete'))
            cold = self.counts.get(name,0)==0
            if success:
                self.counts[name] = self.counts.get(name,0)+1
            print('GEDIt_TIMING '+json.dumps(dict(operation=name,phase='cold' if cold else 'warm',
                ms=round(elapsed,3),success=success,overBudget=over,expectedSuccess=self.profile_expected and name in ('start','observe','begin','end','execute'),
                code=result.get('code') if isinstance(result,dict) else None,
                outcome=result.get('outcome') if isinstance(result,dict) else None,
                completeness=result.get('observation',{}).get('completeness') if isinstance(result,dict) else None,
                sourceRequestMs=timing['spans'][0]['durationUs']/1000 if timing else None,
                apiMs=[span['durationUs']/1000 for span in timing['spans'][1:]] if timing else None)),flush=True)
            if over:
                raise RuntimeError('3500ms request watchdog expired')
    def start(self,p):
        return self.measured('start',Broker.start,p)
    def begin_approval(self,p):
        return self.measured('begin',Broker.begin_approval,p)
    def end_approval(self,p):
        return self.measured('end',Broker.end_approval,p)
    def execute(self,p):
        kind = p.get('command',{}).get('action',{}).get('kind')
        name = 'observe' if kind=='observe' else 'execute' if kind=='setValue' else kind
        return self.measured(name,Broker.execute,p)
