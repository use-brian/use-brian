#!/usr/bin/env python3
"""Real eval fixture process and AT-SPI actions, independent inherited-pipe oracle.
This is not the live helper/approval/lease recorder or production acceptance.
"""
import json, os, pathlib, queue, subprocess, sys, threading, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
NATIVE=ROOT/'apps/app-desktop/native/computer-control/linux'
sys.path.insert(0,str(NATIVE))
sys.path.insert(0,str(NATIVE/'tests'))
from discovery_targets import selected_target
from atspi_backend import Backend
from gi.repository import GLib
rows=json.loads(pathlib.Path(__file__).with_name('tasks.v1.json').read_text())['variants']
def wait(fn):
    last=None
    for _ in range(100):
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        try:
            result=fn()
            if result:return result
        except Exception as e:last=e
        time.sleep(.05)
    raise AssertionError(last or 'timeout')
for split in ['train','calibration','held-out']:
    r=next(r for r in rows if r['split']==split and r['variant']=='menu-dialog')
    child=subprocess.Popen([sys.executable,str(NATIVE/'fixture.py'),'--eval-split',split,'--eval-seed',str(r['seed']),'--eval-variant',r['variant'],'--eval-oracle-stdout'],stdout=subprocess.PIPE,text=True)
    records=queue.Queue()
    def read():
        for line in child.stdout: records.put(json.loads(line))
    thread=threading.Thread(target=read,daemon=True);thread.start()
    try:
        backend=Backend()
        target=wait(lambda:next((t for t in backend.discover() if t['processId']==child.pid),None))
        target=selected_target(target, 'Brian Evaluation '+r['label'])
        w=backend.live(target)
        wait(lambda:backend.context(w)['foreground'])
        def ref(name,action):
            return wait(lambda:next((r for r in backend.tree(w)[1].values() if r[1]['name']==name and action in r[1]['actions']),None))
        nodes,refs,complete=wait(lambda:backend.tree(w) if len(backend.tree(w)[0])>15 else None)
        assert complete,[(n['name'],n['role']) for n in nodes if n['sensitive']]
        assert backend.act('setValue',ref(r['label']+' note','setValue'),{'text':r['payload']})
        def selection():
            nodes,refs,_=backend.tree(w)
            label=next((n for n in nodes if n['name']==r['choice'] and n['role']=='label'),None)
            return refs.get(label.get('parentRef')) if label else None
        choice=wait(selection);assert 'select' in choice[1]['actions'];assert backend.act('select',choice,{})
        assert backend.act('invoke',ref(r['label']+' actions','invoke'),{})
        assert backend.act('invoke',ref('Mark '+r['label']+' reviewed','invoke'),{})
        assert backend.act('invoke',ref('Review '+r['label'],'invoke'),{})
        # GTK exposes the modal as a separate top-level. Parent must rebind it.
        dialog_target=wait(lambda:next((t for t in backend.discover() if t['processId']==child.pid and t['windowId']!=target['windowId']),None))
        dialog_target=selected_target(dialog_target, 'Local review dialog')
        w=backend.live(dialog_target)
        assert backend.act('invoke',ref('Confirm local draft','invoke'),{})
        received=[]
        def complete_oracle():
            while not records.empty():received.append(records.get_nowait())
            return received and received[-1]['state']==r['postcondition']
        wait(complete_oracle)
        assert [x['sequence'] for x in received]==list(range(len(received)))
        assert all(x['identity']==r['id'] for x in received)
        print('PASS: actual AT-SPI setValue/select/menu/dialog + independent pipe oracle',r['id'])
    finally:
        child.terminate();child.wait(timeout=3);child.stdout.close();thread.join(timeout=1)
# Exercise the CURRENT helper's safe-canvas predicate on each actual eval process.
# No alternate appId, title, root/window-class exception or backend modification.
for r in [r for r in rows if r['variant']=='canvas']:
    child=subprocess.Popen([sys.executable,str(NATIVE/'fixture.py'),'--eval-split',r['split'],'--eval-seed',str(r['seed']),'--eval-variant','canvas','--eval-oracle-stdout'],stdout=subprocess.PIPE,text=True)
    try:
        backend=Backend()
        target=wait(lambda:next((t for t in backend.discover() if t['processId']==child.pid),None))
        assert target['appId']=='com.usebrian.NativeComputerFixture'
        assert len([t for t in backend.discover() if t['processId']==child.pid])==1
        target=selected_target(target, 'Brian Safe Canvas')
        w=backend.live(target);wait(lambda:backend.context(w)['foreground'])
        def safe():
            nodes,refs,complete=backend.tree(w)
            snapshot=dict(observation=dict(completeness='complete' if complete else 'partial',nodes=nodes),refs=refs)
            return backend.safe_canvas(w,snapshot)
        assert wait(safe)
        initial=json.loads(child.stdout.readline())
        assert initial['identity']==r['id'] and initial['sequence']==0 and initial['state']['canvas']==0
        print('PASS: unchanged helper safe_canvas predicate, isolated window and cohort',r['id'])
    finally:
        child.terminate();child.wait(timeout=3);child.stdout.close()
