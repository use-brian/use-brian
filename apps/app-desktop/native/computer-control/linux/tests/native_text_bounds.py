"""Real pinned GTK bounded-offset evidence; synthetic unsaved text, no OS authority.
Separate session from latency runs so this probe cannot warm their AT-SPI trees.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from isolated_desktop import run_isolated, stop_process
from discovery_targets import selected_target
if not globals().get('_OWNED_DESKTOP_WORKER'):
    raise SystemExit(run_isolated(__file__))
import contract as C
from atspi_backend import Backend
from gi.repository import GLib


def wait(fn):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        while GLib.MainContext.default().pending():GLib.MainContext.default().iteration(False)
        result=fn()
        if result:return result
        time.sleep(.03)
    raise AssertionError('bounded native text readiness failed')


def main():
    package=json.loads((ROOT/'dependencies.json').read_text())['nativeGeditTest']['package']
    for name,args in [('fixture',[sys.executable,str(ROOT/'fixture.py'),'--safe-form']),
                      ('gedit',[package+'/bin/gedit','--standalone','--new-window','--new-document'])]:
        child=subprocess.Popen(args,cwd=os.environ['HOME'],stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            backend=Backend()
            discovery=wait(lambda:next((t for t in backend.discover() if t['processId']==child.pid),None))
            window=backend.live(selected_target(discovery))
            def ready():
                tree=backend.tree(window)
                return tree if tree[2]=='complete' else None
            _,refs,_=wait(ready)
            text_nodes=[e for e,n,_ in refs.values() if not n['sensitive'] and 'Text' in e.get_interfaces()]
            assert text_nodes
            for element in text_nodes:
                text=element.queryText()
                value=text.getText(0,C.AX_TEXT_UNITS+1)
                count=text.characterCount
                assert isinstance(value,str) and len(value)==min(count,C.AX_TEXT_UNITS+1), 'pinned Text provider did not clamp'
            document=next(e for e,n,_ in refs.values() if 'setValue' in n['actions'])
            text=document.queryText()
            cases=['','abc','e'+chr(0x301),chr(0x1f600)*2048,chr(0x1f600)*2049,
                   'x'*4096,'x'*4097,'x'*8192]
            for value in cases:
                assert document.queryEditableText().setTextContents(value)
                bounded=text.getText(0,C.AX_TEXT_UNITS+1)
                count=text.characterCount
                assert bounded==value[:C.AX_TEXT_UNITS+1] and count==len(value), 'bounded-offset mismatch'
            assert document.queryEditableText().setTextContents('')
            print(f'PASS: pinned {name} Text nodes clamp getText(0,4097); empty/Unicode/4096/4097/8192 cases; no values logged',flush=True)
        finally:
            stop_process(child)
    print('NOTE: real isolated GTK/gedit read-range evidence only; no production session acceptance',flush=True)


if __name__=='__main__':main()
