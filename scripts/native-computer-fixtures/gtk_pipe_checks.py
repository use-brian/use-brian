#!/usr/bin/env python3
"""Real inherited full pipe: oracle fails promptly; ordinary launches stay silent."""
import os,pathlib,subprocess,sys,time
fixture=pathlib.Path(__file__).resolve().parents[2]/'apps/app-desktop/native/computer-control/linux/fixture.py'
for args in [[],['--safe-form'],['--canvas'],['--eval-split','train','--eval-seed','1103','--eval-variant','canvas'],['--eval-split','train','--eval-seed','1103','--eval-variant','canvas','--eval-oracle-stdout']]:
    read,write=os.pipe();os.set_blocking(write,False);filled=0
    try:
        while True:filled+=os.write(write,b'x'*4096)
    except BlockingIOError:pass
    start=time.monotonic()
    child=subprocess.Popen([sys.executable,str(fixture)]+args,stdout=write,stderr=subprocess.DEVNULL)
    os.close(write)
    try:
        if '--eval-oracle-stdout' in args:
            assert child.wait(timeout=5)==74
            assert time.monotonic()-start<5
        else:
            time.sleep(.7);assert child.poll() is None
            child.terminate();child.wait(timeout=3)
        data=b''
        while True:
            chunk=os.read(read,65536)
            if not chunk:break
            data+=chunk
        assert data==b'x'*filled, 'unexpected stdout on silent/full-pipe path'
    finally:
        if child.poll() is None:child.kill();child.wait()
        os.close(read)
print('PASS: inherited full stdout pipe never stalls GTK; all legacy/non-opt-in modes silent')
