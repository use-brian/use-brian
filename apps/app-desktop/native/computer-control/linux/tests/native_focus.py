"""Real GTK/AT-SPI/EWMH + broker lifecycle regression under disposable Xvfb.
The guard's logind/lease is simulated. No production lock/lease acceptance claim.
"""
import copy
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import contract as C
# Discard inherited desktop/bus credentials through the owning supervisor.
from discovery_targets import selected_target
from isolated_desktop import run_isolated
if not globals().get('_OWNED_DESKTOP_WORKER'):
    raise SystemExit(run_isolated(__file__, sys.argv[1:]))
children = []


def launch(args):
    process = subprocess.Popen(args,stdout=subprocess.DEVNULL)
    children.append(process)
    return process


def wait_for(fn):
    for _ in range(80):
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        value = fn()
        if value:
            return value
        time.sleep(.02)
    raise AssertionError('native condition not reached')


try:
    import gi
    gi.require_version('Gtk','3.0')
    gi.require_version('GdkX11','3.0')
    from gi.repository import Gtk, GLib, GdkX11
    from atspi_backend import Backend
    from helper import Broker
    from x11 import X11
    fixture = launch([sys.executable,str(ROOT/'fixture.py'),'--safe-form'])
    backend = Backend()
    original_restore = backend.restore_consented_focus
    def diagnostic_restore(*args, **kwargs):
        try:
            return original_restore(*args, **kwargs)
        except Exception as error:
            print('FOCUS GUARD REFUSED:', type(error).__name__, str(error), flush=True)
            raise
    backend.restore_consented_focus = diagnostic_restore
    discovered = wait_for(lambda: next((t for t in backend.discover() if t['processId']==fixture.pid),None))
    target = selected_target(discovered, 'Brian Native Fixture')
    w = backend.live(target)
    wait_for(lambda: backend.context(w)['foreground'])
    assert wait_for(lambda: backend.tree(w)[2] == 'complete')
    events = X11(events=True)
    assert not events.input_pending()
    parent = Gtk.Window(title='Trusted test consent parent')
    parent.set_default_size(500,360)
    parent.add(Gtk.Label(label='Test-only local consent'))
    parent.show_all()
    wait_for(lambda: parent.get_window())
    parent_xid = parent.get_window().get_xid()

    def parent_focus():
        parent.present()
        parent.get_display().sync()  # flush test-dialog presentation before helper-side activation
        backend.x.request_activation(parent_xid)
        wait_for(lambda: backend.x.foreground()==parent_xid)
        assert not events.input_pending(), 'EWMH generated unexpected raw input'

    class Guard:
        # Only lifecycle plumbing uses this fake guard. Every native UI call and
        # completeness/identity/geometry/focus guard below is the actual backend.
        parent = os.getpid()
        deadline = float('inf')
        approval = False
        approval_window = 0
        lock = threading.RLock()
        acquired = False
        def acquire(self,expiry):
            self.acquired = True
            self.deadline = C.mono()+expiry-C.now()
        def check(self):
            assert C.mono()<self.deadline
            assert not events.input_pending(), 'external raw input during native focus test'
        def close_approval(self):
            self.check()
            self.approval = False
            self.approval_window = 0

    grant = dict(protocol=C.PROTOCOL,identity={k:k for k in C.IDENTITY},grantId='g',epoch=1,
        expiresAt=C.now()+120000,targets=[target],allowControl=True,allowCapture=False,requester='local test',goal='focus lifecycle')
    assert C.grant(grant) and all('displayName' not in t for t in grant['targets'])
    assert not C.grant(dict(grant, targets=[discovered]))
    def broker_start():
        parent_focus()
        # A cold/slow bounded traversal may legitimately be partial. Wait on
        # read-only readiness; never retry an effect to hide a partial observation.
        assert wait_for(lambda: backend.tree(w)[2]=='complete')
        for _ in range(10):
            guard = Guard()
            broker = Broker(backend,guard)
            if broker.start(dict(grant=grant,leaseId='lease')):
                break
            # Retry ONLY the bounded read that precedes lease acquisition and
            # focus dispatch. Any refusal after acquiring authority is a failure.
            assert not broker.stopped and not guard.acquired, 'consented start failed after acquisition'
            assert backend.x.foreground()==parent_xid
            assert wait_for(lambda: backend.tree(w)[2]=='complete')
        else:
            raise AssertionError('no complete start-time observation')
        assert backend.x.foreground()==w['xid']
        return broker
    def command(kind='observe',**args):
        return dict(protocol=C.PROTOCOL,identity=grant['identity'],grantId='g',epoch=1,commandId=C.uid(),
            deadlineAt=C.now()+30000,action=dict(kind=kind,target=target,**args))
    def prepare(broker):
        def complete_observation():
            result = broker.execute(dict(command=command(),leaseId='lease'))
            assert result['code']=='ok', result['code']
            o = result['observation']
            return o if o['completeness']=='complete' else None
        o = wait_for(complete_observation)
        node = next(n for n in o['nodes'] if n['name']=='Harmless note')
        c = command('setValue',observationId=o['id'],ref=node['ref'],text='focus restored safely')
        p = dict(command=c,leaseId='lease')
        assert broker.begin_approval(p)
        return c,p

    broker = broker_start()
    print('PASS: consented start returns exact selected GTK window to foreground via EWMH')
    c,p = prepare(broker)
    parent_focus()
    assert broker.end_approval(dict(**p,approved=True)), 'consented endApproval failed'
    assert backend.x.foreground()==w['xid']
    r = broker.execute(p)
    assert r['outcome']=='executed', r['code']
    assert any(n.get('value')=='focus restored safely' for n in r['observation']['nodes'])
    print('PASS: consented endApproval restores foreground and permits the exact approved semantic effect')
    assert not events.input_pending()

    # Denial does not reactivate the target.
    c,p = prepare(broker)
    parent_focus()
    assert broker.end_approval(dict(**p,approved=False))
    assert backend.x.foreground()==parent_xid
    print('PASS: denied approval causes no focus side effect')

    # A stale target identity must fail BEFORE sending any activation message.
    bad = copy.deepcopy(grant)
    bad['targets'][0]['processInstanceId'] = 'stale'
    assert not Broker(backend,Guard()).start(dict(grant=bad,leaseId='lease'))
    assert backend.x.foreground()==parent_xid
    print('PASS: stale target identity cannot activate a window')

    # An unrelated popup from even the SAME parent PID is not the consent window.
    broker = broker_start()
    c,p = prepare(broker)
    parent_focus()
    popup = Gtk.Window(type=Gtk.WindowType.POPUP)
    popup.set_accept_focus(False)
    popup.set_default_size(140,100)
    b = backend.x.bounds(w['xid'])
    popup.move(b['x']+25,b['y']+25)
    popup.add(Gtk.Label(label='Unrelated overlay'))
    popup.show_all()
    wait_for(lambda: popup.get_window())
    time.sleep(.1)
    assert backend.x.foreground()==parent_xid
    assert not broker.end_approval(dict(**p,approved=True))
    assert backend.x.foreground()==parent_xid, 'overlay was bypassed by raising target'
    popup.destroy()
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)
    print('PASS: unrelated same-parent-PID overlay prevents restoration before any focus request')

    # Never steal focus from or automate a different app/window at approval end.
    broker = broker_start()
    c,p = prepare(broker)
    other = launch([sys.executable,str(ROOT/'fixture.py'),'--safe-form'])
    other_xid = wait_for(lambda: next((x for x in backend.x.prop(backend.x.root,'_NET_CLIENT_LIST_STACKING') if backend.x.pid(x)==other.pid),None))
    wait_for(lambda: backend.x.foreground()==other_xid)
    assert not broker.end_approval(dict(**p,approved=True))
    assert backend.x.foreground()==other_xid
    other.terminate()
    other.wait(timeout=3)
    # Process exit precedes WM destruction/focus bookkeeping. Wait for both so
    # teardown cannot race the next independently consented scenario.
    wait_for(lambda: other_xid not in backend.x.prop(backend.x.root,'_NET_CLIENT_LIST_STACKING') and backend.x.foreground()!=other_xid)
    print('PASS: other-window foreground is neither stolen nor automated')

    # Real AT-SPI 4096+ suffix mutation cannot acquire approval or dispatch.
    broker = broker_start()
    _,refs,_ = backend.tree(w)
    entry = next(ref[0] for ref in refs.values() if ref[1]['name']=='Harmless note')
    assert entry.queryEditableText().setTextContents('x'*4096+'old suffix')
    o = broker.execute(dict(command=command(),leaseId='lease'))['observation']
    assert o['completeness']=='partial'
    ref = next(n['ref'] for n in o['nodes'] if n['name']=='Harmless note')
    c = command('setValue',observationId=o['id'],ref=ref,text='must not write')
    assert entry.queryEditableText().setTextContents('x'*4096+'NEW suffix')
    assert not broker.begin_approval(dict(command=c,leaseId='lease'))
    assert broker.execute(dict(command=c,leaseId='lease'))['outcome']=='not_executed'
    assert entry.queryText().getText(4096,-1)=='NEW suffix'
    # Partial tree also forbids the start-time focus side effect.
    parent_focus()
    assert not Broker(backend,Guard()).start(dict(grant=grant,leaseId='lease'))
    assert backend.x.foreground()==parent_xid
    print('PASS: real long-text suffix mutation yields partial; approval/dispatch/start restoration denied')
    # Wire/native Unicode boundaries. Test values never enter diagnostic output.
    astral = chr(0x1f600)
    valid = astral*2048
    assert entry.queryEditableText().setTextContents(valid)
    broker = broker_start()
    def unicode_observation():
        observed = broker.execute(dict(command=command(),leaseId='lease'))['observation']
        return observed if observed['completeness']=='complete' else None
    o = wait_for(unicode_observation)
    node = next(n for n in o['nodes'] if n['name']=='Harmless note')
    assert C.utf16_units(node['value'])==4096 and node['value']==valid
    c = command('setValue',observationId=o['id'],ref=node['ref'],text=valid)
    p = dict(command=c,leaseId='lease')
    assert broker.begin_approval(p)
    parent_focus()
    assert broker.end_approval(dict(**p,approved=True))
    result = broker.execute(p)
    assert result['outcome']=='executed'
    o = wait_for(unicode_observation)
    node = next(n for n in o['nodes'] if n['name']=='Harmless note')
    c = command('setValue',observationId=o['id'],ref=node['ref'],text=astral*2049)
    assert not broker.begin_approval(dict(command=c,leaseId='lease'))
    assert broker.execute(dict(command=c,leaseId='lease'))['code']=='denied'
    assert entry.queryText().getText(0,-1)==valid
    assert entry.queryEditableText().setTextContents(astral*2049)
    o = broker.execute(dict(command=command(),leaseId='lease'))['observation']
    assert o['completeness']=='partial'
    node = next(n for n in o['nodes'] if n['name']=='Harmless note')
    assert node['value']==valid and C.utf16_units(node['value'])==4096
    assert not any(0xd800<=ord(ch)<=0xdfff for ch in node['value'])
    c = command('setValue',observationId=o['id'],ref=node['ref'],text='not authorized from partial')
    assert not broker.begin_approval(dict(command=c,leaseId='lease'))
    assert broker.execute(dict(command=c,leaseId='lease'))['outcome']=='not_executed'
    combining = ('e'+chr(0x301))*2048
    assert entry.queryEditableText().setTextContents(combining)
    o = wait_for(unicode_observation)
    node = next(n for n in o['nodes'] if n['name']=='Harmless note')
    assert node['value']==combining and C.utf16_units(node['value'])==4096
    print('PASS: native GTK UTF-16: 2048 supplementary scalars accepted; 2049 denied/partial; combining codepoints preserved; no values logged')
    print('NOTE: real GTK/EWMH/AT-SPI; simulated guard, no logind/lease/packaged acceptance')
    parent.destroy()
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
