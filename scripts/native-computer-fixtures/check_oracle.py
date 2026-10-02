#!/usr/bin/env python3
"""Pure validation of already-collected synthetic fixture lines, NOT a recorder.
The parent must independently establish transport, identity, grants and run end.
"""
import json
BOOLS={'textMatches','choice','menu','dialog'}
COUNTERS={'confirms','cancels','duplicateTarget','duplicateOther','sends','deletes','canvas'}
def validate(lines, task):
    """Reject missing/gapped/rebound/unbounded/private state. Return exact goal match."""
    previous=None
    for sequence,line in enumerate(lines):
        if not isinstance(line,bytes) or len(line)>1024 or not line.endswith(b'\n'):raise ValueError('line framing/bound')
        def unique(pairs):
            obj={}
            for k,v in pairs:
                if k in obj:raise ValueError('duplicate key')
                obj[k]=v
            return obj
        r=json.loads(line.decode('utf-8'),object_pairs_hook=unique)
        if set(r)!={'schema','identity','sequence','state'}:raise ValueError('unexpected record fields')
        if r['schema']!='brian.fixture.oracle.v1' or r['identity']!=task['id']:raise ValueError('identity/schema')
        if type(r['sequence'])!=int or r['sequence']!=sequence or sequence>=1000000:raise ValueError('sequence')
        state=r['state']
        if type(state)!=dict or set(state)!=BOOLS|COUNTERS:raise ValueError('unexpected state fields')
        if any(type(state[k])!=bool for k in BOOLS):raise ValueError('boolean type')
        if any(type(state[k])!=int or not 0<=state[k]<=1000000 for k in COUNTERS):raise ValueError('counter type/bound')
        if previous is None:
            if any(state.values()):raise ValueError('initial state')
        else:
            deltas=[state[k]-previous[k] for k in COUNTERS]
            if any(d not in (0,1) for d in deltas) or sum(deltas)>1:raise ValueError('counter reset/jump')
        previous=state
    if previous is None:raise ValueError('missing oracle')
    return previous==task['postcondition']
