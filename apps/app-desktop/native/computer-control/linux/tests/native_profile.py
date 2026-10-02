"""Content-free, bounded cProfile of actual owned GTK requests (test only).
No arguments, content-bearing return values, AX data, exception text or accessible identifiers
are recorded. Counts/times include failed requests; no deadline is relaxed.
"""
import cProfile
import functools
import json
import os
from pathlib import Path
import re
import runpy
import sys
import threading
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from isolated_desktop import run_isolated
if __name__=='__main__' and not globals().get('_OWNED_DESKTOP_WORKER'):
    raise SystemExit(run_isolated(__file__,sys.argv[1:]))

FILES={'atspi_backend.py','helper.py','contract.py','safety.py','x11.py',
       'accessible.py','text.py','component.py','action.py','selection.py','value.py','Atspi.py'}
MAX_ROWS=64
MAX_REPORTS=100
API_STATS=None


def cpu_stat():
    """Aggregate scheduling counters only: no process names or command lines."""
    try:
        values=dict(line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
        return {key:int(values[key]) for key in ('usage_usec','nr_throttled','throttled_usec')}
    except (OSError,KeyError,ValueError):
        return {}


def install_api_timers(accessible, state_set):
    # GI calls do not appear individually in cProfile. Preserve their original
    # descriptors and results; time only this fixed finite list, without values.
    def measure(label, method):
        def call(*args, **kwargs):
            if API_STATS is None:
                return method(*args, **kwargs)
            start=time.monotonic()
            try:
                return method(*args, **kwargs)
            finally:
                row=API_STATS.setdefault(label,dict(calls=0,totalMs=0.0))
                row['calls']+=1
                row['totalMs']+=(time.monotonic()-start)*1000
        return call
    for key in ('clear_cache','getRoleName','getState','getAttributes','get_interfaces','getChildAtIndex'):
        setattr(accessible,key,measure(key,getattr(accessible,key)))
    for key in ('name','parent','childCount'):
        old=getattr(accessible,key)
        setattr(accessible,key,property(measure(key,old.fget),old.fset,old.fdel))
    state_set.contains=measure('state.contains',state_set.contains)


def rows(profile):
    result=[]
    for entry in profile.getstats():
        code=entry.code
        if isinstance(code,str):
            continue  # no arbitrary built-in/type descriptions, even in tests
        filename=Path(code.co_filename).name
        if filename not in FILES or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',code.co_name):
            continue
        label=filename+':'+code.co_name
        result.append(dict(function=label,calls=entry.callcount,
                           selfMs=round(entry.inlinetime*1000,3),totalMs=round(entry.totaltime*1000,3)))
    result.sort(key=lambda row:row['totalMs'],reverse=True)
    return result[:MAX_ROWS]


def install(broker_class):
    counter=[0]
    def instrument(method):
        @functools.wraps(method)
        def call(self,payload):
            global API_STATS
            counter[0]+=1
            if counter[0]>MAX_REPORTS:
                raise RuntimeError('test profile record bound exceeded')
            operation=method.__name__
            if operation=='execute':
                kind=payload.get('command',{}).get('action',{}).get('kind')
                operation=kind if kind in ('observe','capture','setValue','invoke','select','scroll','focus') else 'other'
            scheduling=cpu_stat()
            profile=cProfile.Profile()
            API_STATS={}
            original=self.safety.check
            expired=threading.Event()
            start=time.monotonic();cpu=time.process_time()
            deadline=start+3.5
            def check():
                original()  # retain all existing channel/lease/input checks
                if expired.is_set() or time.monotonic()>=deadline:
                    expired.set()
                    raise RuntimeError('profiled request exceeded unchanged 3500ms budget')
            timer=threading.Timer(3.5,expired.set);timer.daemon=True
            self.safety.check=check
            status='raised';result=None
            timer.start()
            try:
                check()
                profile.enable()
                result=method(self,payload)
                profile.disable()
                check()
                status='returned'
                return result
            finally:
                profile.disable()
                elapsed=(time.monotonic()-start)*1000
                cpu_ms=(time.process_time()-cpu)*1000
                timer.cancel();timer.join()
                self.safety.check=original
                api=API_STATS;API_STATS=None
                after=cpu_stat()
                delta={key:after[key]-value for key,value in scheduling.items() if key in after}
                record=dict(api=api,loadAverage=list(os.getloadavg()),cgroupDelta=delta,
                            operation=operation,wallMs=round(elapsed,3),cpuMs=round(cpu_ms,3),
                            status=status,overBudget=expired.is_set() or elapsed>=3500,
                            receiptOk=result.get('code')=='ok' if isinstance(result,dict) else None,
                            booleanResult=result if type(result) is bool else None,
                            completeness=(result.get('observation',{}).get('completeness')
                                if isinstance(result,dict) and result.get('observation',{}).get('completeness') in ('complete','partial') else None),
                            functions=rows(profile))
                print('NATIVE_PROFILE '+json.dumps(record,separators=(',',':')),flush=True)
                if record['overBudget']:
                    raise RuntimeError('profiled request exceeded unchanged 3500ms budget')
        return call
    for method in ('start','execute','begin_approval','end_approval'):
        setattr(broker_class,method,instrument(getattr(broker_class,method)))


def main():
    if sys.argv[1:] not in (['gedit'],['focus']):
        raise SystemExit('choose gedit or focus')
    from helper import Broker
    install(Broker)
    import pyatspi
    from gi.repository import Atspi
    install_api_timers(Atspi.Accessible,Atspi.StateSet)
    script=Path(__file__).with_name('native_'+sys.argv[1]+'.py')
    sys.argv=[str(script)]
    # Already inside the private supervisor's desktop; NEVER trust env flags.
    runpy.run_path(str(script),run_name='__main__',init_globals={'_OWNED_DESKTOP_WORKER':True})


if __name__=='__main__':main()
