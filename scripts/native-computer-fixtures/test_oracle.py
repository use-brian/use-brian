#!/usr/bin/env python3
import copy,json,pathlib,unittest
from check_oracle import BOOLS,COUNTERS,validate
ROWS=json.loads(pathlib.Path(__file__).with_name('tasks.v1.json').read_text())['variants']
def record(task,sequence,state):return dict(schema='brian.fixture.oracle.v1',identity=task['id'],sequence=sequence,state=state.copy())
def encode(records):return [(json.dumps(r,separators=(',',':'))+'\n').encode() for r in records]
def sample(task):
    state={k:False for k in BOOLS}|{k:0 for k in COUNTERS};out=[record(task,0,state)]
    for k in BOOLS:
        if task['postcondition'][k]:state[k]=True;out.append(record(task,len(out),state))
    for k in COUNTERS:
        if task['postcondition'][k]:state[k]+=1;out.append(record(task,len(out),state))
    return out
class Oracle(unittest.TestCase):
    def test_concrete_goals(self):
        for r in ROWS:
            self.assertTrue(validate(encode(sample(r)),r),r['id'])
            self.assertGreater(len(r['goal']),30)
            if r['variant'] in ('form-selection','unicode','menu-dialog','prompt-injection'):self.assertIn(repr(r['payload']),r['goal'])
            if r['variant']=='duplicate-labels':self.assertIn(r['context']+' target',r['goal'])
    def test_rejects_private_and_bad_transport(self):
        r=ROWS[0];good=sample(r)
        for change in [lambda x:x.update(identity='held-out/canvas/3301'),lambda x:x.update(sequence=77),
                       lambda x:x.update(text='arbitrary input'),lambda x:x['state'].update(frame='not permitted'),
                       lambda x:x['state'].update(sends=True),lambda x:x['state'].update(sends=-1),
                       lambda x:x['state'].update(sends=2)]:
            bad=copy.deepcopy(good);change(bad[-1])
            with self.assertRaises(ValueError):validate(encode(bad),r)
        for lines in [[],[b'x'*1025+b'\n'],[encode(good)[0][:-1]]]:
            with self.assertRaises(ValueError):validate(lines,r)
    def test_extra_effect_is_not_success(self):
        for r in ROWS:
            records=sample(r);state=records[-1]['state'].copy();state['sends']+=1
            records.append(record(r,len(records),state))
            self.assertFalse(validate(encode(records),r))
if __name__=='__main__':unittest.main()
