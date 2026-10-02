#!/usr/bin/env python3
import base64, hashlib, json, pathlib, re, subprocess, sys, unittest
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[1]
NATIVE=ROOT/'apps/app-desktop/native/computer-control'
class Variants(unittest.TestCase):
    def test_reproducible_embeds(self):
        files=[HERE/'tasks.v1.json',NATIVE/'Fixture.swift',NATIVE/'windows/Fixture/Program.cs',NATIVE/'linux/fixture.py']
        schema_before=(HERE/'oracle.schema.json').read_bytes()
        before=[p.read_bytes() for p in files]
        subprocess.run([sys.executable,str(HERE/'generate.py')],check=True)
        self.assertEqual(before,[p.read_bytes() for p in files])
        self.assertEqual(schema_before,(HERE/'oracle.schema.json').read_bytes())
        embeds=[json.loads(base64.b64decode(re.search(r'EVAL_DATA = "([A-Za-z0-9+/=]+)"',p.read_text())[1])) for p in files[1:]]
        self.assertEqual(embeds[0],embeds[1]);self.assertEqual(embeds[1],embeds[2])
        self.assertEqual(len(embeds[0]),24)
    def test_disjoint_task_sets_not_apps(self):
        c=json.loads((HERE/'tasks.v1.json').read_text());rows=c['variants']
        self.assertEqual(len({r['id'] for r in rows}),24)
        for a,b in [('train','calibration'),('train','held-out'),('calibration','held-out')]:
            left=[r for r in rows if r['split']==a];right=[r for r in rows if r['split']==b]
            for key in ['id','payload','label','seed','choice','context','order']:
                self.assertFalse({r[key] for r in left}&{r[key] for r in right},key)
            self.assertFalse({tuple(r[k] for k in ['x','y','width','height']) for r in left}&{tuple(r[k] for k in ['x','y','width','height']) for r in right})
        for r in rows:
            self.assertEqual(c['seedAllowlist'][r['split']],[r['seed']])
            self.assertTrue(r['goal']);self.assertLess(len(r['payload']),128)
            self.assertEqual(set(r['postcondition']),{'textMatches','choice','menu','dialog','confirms','cancels','duplicateTarget','duplicateOther','sends','deletes','canvas'})
        self.assertEqual(c['appId'],'com.usebrian.NativeComputerFixture')
        self.assertEqual(len(c['manifestBindings']),45)
        self.assertTrue(all(not b['appCohortAccepted'] for b in c['manifestBindings']))
        self.assertTrue(all(b['taskVariant'] or b['intervention'] for b in c['manifestBindings']))
if __name__=='__main__': unittest.main()
