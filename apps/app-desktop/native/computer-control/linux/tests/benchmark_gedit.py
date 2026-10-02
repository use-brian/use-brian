"""Aggregate fresh-session native gedit timings; any failure keeps exit nonzero."""
import argparse
import json
import math
from pathlib import Path
import subprocess
import sys


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--sessions',type=int,default=5)
    parser.add_argument('--json-out',type=Path)
    args=parser.parse_args()
    if not 1<=args.sessions<=20:parser.error('sessions must be 1..20')
    groups={}; failures=0;over=[]; all_samples=[]; sessions=[]; table=[]
    for i in range(args.sessions):
        child=subprocess.Popen([sys.executable,str(Path(__file__).with_name('native_gedit.py'))],
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        try:
            output,_=child.communicate(timeout=210)
        except subprocess.TimeoutExpired:
            # SIGTERM lets the owning supervisor clean its Xvfb/D-Bus group;
            # subprocess.run(timeout=...) would SIGKILL it before that cleanup.
            child.terminate()
            output,_=child.communicate(timeout=10)
        failures+=child.returncode!=0
        errors=[line for line in output.splitlines() if line.startswith(('AssertionError:','RuntimeError:'))]
        sessions.append(dict(session=i+1,exit=child.returncode,errors=errors))
        print(f'SESSION {i+1} exit={child.returncode}',flush=True)
        for line in output.splitlines():
            if line.startswith('GEDIt_TIMING '):
                sample=json.loads(line.split(' ',1)[1])
                sample['session']=i+1
                all_samples.append(sample)
                if sample['overBudget']:over.append(sample)
                if sample['operation'] in ('start','observe','begin','end','execute'):
                    groups.setdefault((sample['phase'],sample['operation']),[]).append(sample)
        if child.returncode:
            for line in output.splitlines():
                if line.startswith(('AssertionError:','RuntimeError:')):print(line,flush=True)
    print('phase operation n success p50_ms p95_ms max_ms',flush=True)
    for phase in ('cold','warm'):
        for op in ('start','observe','begin','end','execute'):
            samples=groups.get((phase,op),[])
            # Report positive-request samples AND watchdog failures; routine
            # intentional denials/partial observations are not latency successes.
            samples=[s for s in samples if s['expectedSuccess'] or s['overBudget']]
            values=sorted(s['ms'] for s in samples)
            if not values:
                table.append(dict(phase=phase,operation=op,n=0,success=0,p50Ms=None,p95Ms=None,maxMs=None))
                print(f'{phase} {op} 0 0 NA NA NA');continue
            def q(p):return values[math.ceil(p*len(values))-1]
            row=dict(phase=phase,operation=op,n=len(values),success=sum(s['success'] for s in samples),p50Ms=q(.5),p95Ms=q(.95),maxMs=max(values))
            table.append(row)
            print(f'{phase} {op} {len(values)} {row["success"]} {q(.5):.3f} {q(.95):.3f} {max(values):.3f}')
    incomplete=[s for s in all_samples if s['expectedSuccess'] and not s['success']]
    for sample in all_samples:
        if sample['overBudget'] or (sample['expectedSuccess'] and not sample['success']):
            print('FAILED_REQUEST '+json.dumps(sample,sort_keys=True),flush=True)
    failed=failures!=0 or bool(over) or bool(incomplete)
    report=dict(requestBudgetMs=3500,treeBudgetMs=1800,sessions=sessions,failedSessions=failures,
                overBudgetRequests=len(over),failedExpectedRequests=len(incomplete),timingAccepted=not failed,
                productionAuthorityAccepted=False,quantile='nearest rank; expected failures included',
                results=table,samples=all_samples)
    if args.json_out:
        args.json_out.write_text(json.dumps(report,indent=2)+'\n')
    print(f'RESULT sessions={args.sessions} failed={failures} overBudget={len(over)} failedExpected={len(incomplete)}; simulated logind/consent, real 3500ms deadline',flush=True)
    return int(failed)


if __name__=='__main__':sys.exit(main())
