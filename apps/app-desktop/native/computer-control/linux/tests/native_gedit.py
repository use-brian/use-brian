"""Actual gedit unsaved-buffer test, NOT production consent/logind acceptance.
Run with the pinned development Nix shell. Never uses host desktop/documents.
"""
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from discovery_targets import selected_target
from isolated_desktop import run_isolated, stop_process
if not globals().get('_OWNED_DESKTOP_WORKER'):
    raise SystemExit(run_isolated(__file__,sys.argv[1:]))

import contract as C
from atspi_backend import Backend, EDITOR
from gi.repository import GLib

# Exact measured package, not PATH/title/argv impersonation or a fixture alias.
PACKAGE = '/nix/store/pbdrndbn9wfzl5j9dhyyykiacrgyia9l-gedit-50.0'
BINARY = PACKAGE+'/bin/gedit'
children = []


def wait_for(fn, label, timeout=12):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        result = fn()
        if result:
            return result
        time.sleep(.03)
    raise AssertionError('gedit readiness timeout: '+label)


from gedit_timing import DeadlineGuard, TimedBroker


def launch():
    # No filename, stdin document, recovery session, file chooser or Save action.
    child = subprocess.Popen([BINARY,'--standalone','--new-window','--new-document'],cwd=os.environ['HOME'],
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    children.append(child)
    wait_for(lambda: child.poll() is not None or Path(f'/proc/{child.pid}/exe').resolve().name=='.gedit-wrapped','exec')
    assert child.poll() is None, 'actual gedit exited before discovery'
    actual = Path(f'/proc/{child.pid}/exe').resolve(strict=True)
    print('MEASURED: gedit 50.0 executable='+str(actual),flush=True)
    assert str(actual)==PACKAGE+'/bin/.gedit-wrapped', 'unmeasured executable'
    return child


try:
    child = launch()
    backend = Backend()
    assert backend.cohort(child.pid)==EDITOR, 'actual gedit executable rejected by existing cohort gate'
    def discovered():
        targets = backend.discover()
        matches = [t for t in targets if t['processId']==child.pid]
        assert all(t['appId']==EDITOR for t in matches)
        assert len(matches)<=1, 'unexpected extra gedit window'
        if not matches:
            return None
        discovery = matches[0]
        assert isinstance(discovery.get('displayName'), str) and 'Untitled Document' in discovery['displayName']
        target = selected_target(discovery)
        w = backend.live(target)
        assert discovery['displayName'] == C.utf16_prefix(w['element'].name, 256), 'discovery differs from real gedit window title'
        return target
    target = wait_for(discovered,'scoped process/window discovery')
    w = backend.live(target)
    assert backend.x.pid(w['xid'])==child.pid
    wait_for(lambda: backend.context(w)['foreground'],'foreground')
    print('PASS: real gedit discovered by exact executable, process and X11 window',flush=True)

    grant = dict(protocol=C.PROTOCOL,identity={k:k for k in C.IDENTITY},grantId='gedit-test',epoch=1,
        expiresAt=C.now()+300000,targets=[target],allowControl=True,allowCapture=True,
        requester='isolated native test',goal='unsaved gedit document cohort verification')
    assert C.grant(grant) and all('displayName' not in t for t in grant['targets'])
    broker = TimedBroker(backend,DeadlineGuard())
    assert broker.start(dict(grant=grant,leaseId='simulated-lease'))
    # First observation is measured BEFORE any full-tree readiness warmup.
    cold_command = dict(protocol=C.PROTOCOL,identity=grant['identity'],grantId=grant['grantId'],epoch=1,
        commandId=C.uid(),deadlineAt=C.now()+30000,action=dict(kind='observe',target=target))
    cold_observed = broker.execute(dict(command=cold_command,leaseId='simulated-lease'))
    assert cold_observed['code']=='ok' and cold_observed['observation']['completeness']=='complete', 'cold observation incomplete'

    def complete_tree():
        tree = backend.tree(w)
        return tree if tree[2]=='complete' else None
    nodes = cold_observed['observation']['nodes']
    refs = broker.snapshot['refs']
    assert len(nodes)<=500
    actionable = [n for n in nodes if n['actions']]
    assert len(actionable)==1 and actionable[0]['actions']==['setValue'], 'non-document action advertised'
    doc = refs[actionable[0]['ref']][0]
    assert doc.getState().contains(backend.a.STATE_MULTI_LINE)
    assert doc.queryText().getText(0,C.AX_TEXT_UNITS+1)=='', 'new document is not empty'
    toolbar = [n for n in nodes if n['role'] in ('tool bar','button','push button','menu','menu item')]
    assert toolbar and all(not n['actions'] for n in toolbar)
    print('PASS: bounded complete gedit AX; exactly one document setValue; no toolbar/menu actions',flush=True)

    def command(kind='observe',**args):
        return dict(protocol=C.PROTOCOL,identity=grant['identity'],grantId=grant['grantId'],epoch=1,
            commandId=C.uid(),deadlineAt=C.now()+30000,action=dict(kind=kind,target=target,**args))
    def payload(c):
        return dict(command=c,leaseId='simulated-lease')
    def observe(complete=True):
        def read():
            r = broker.execute(payload(command()))
            assert r['code']=='ok', 'observation refused'
            o = r['observation']
            return o if not complete or o['completeness']=='complete' else None
        return wait_for(read,'fresh observation')
    def document(o):
        return next(n for n in o['nodes'] if n['actions']==['setValue'])
    def deny_capture(o):
        # Permission is TRUE: the cohort, not grant flags, must exclude pixels.
        from unittest.mock import patch
        with patch.object(backend.x,'pixels',side_effect=AssertionError('editor pixel capture attempted')) as pixels:
            r = broker.execute(payload(command('capture',observationId=o['id'])))
            assert r['outcome']=='not_executed' and 'frame' not in r.get('observation',{})
            assert not backend.safe_canvas(w,broker.snapshot)
            pixels.assert_not_called()
    def approved_write(value, o=None):
        o = observe() if o is None else o
        p = payload(command('setValue',observationId=o['id'],ref=document(o)['ref'],text=value))
        assert broker.begin_approval(p), 'complete document approval refused'
        assert broker.end_approval(dict(**p,approved=True)), 'simulated consent completion refused'
        r = broker.execute(p)
        assert r['outcome']=='executed', 'approved document assignment failed'
        assert r['observation']['id']!=o['id']
        assert document(r['observation'])['value']==value
        fresh = observe()
        assert document(fresh)['value']==value and doc.queryText().getText(0,C.AX_TEXT_UNITS+1)==value
        deny_capture(fresh)
        return fresh

    value = ('e'+chr(0x301)+chr(0x1f600)+'\n')*20
    approved_write(value,cold_observed['observation'])
    TimedBroker.profile_expected = False
    initial = observe()
    deny_capture(initial)
    chrome = next(n for n in initial['nodes'] if n['role'] in ('button','toggle button'))
    denied = payload(command('invoke',observationId=initial['id'],ref=chrome['ref']))
    assert not broker.begin_approval(denied)
    assert broker.execute(denied)['outcome']=='not_executed'
    print('PASS: real gedit toolbar invoke cannot acquire approval or dispatch',flush=True)
    TimedBroker.profile_expected = True
    # Four further valid cycles provide warm samples of every operation. New
    # broker instances exercise warm start without resetting app/backend caches;
    # leases are simulated, never asserted as production ownership acceptance.
    for _ in range(4):
        broker = TimedBroker(backend,DeadlineGuard())
        assert broker.start(dict(grant=grant,leaseId='simulated-lease'))
        approved_write(value)
    boundary = chr(0x1f600)*2048
    o = approved_write(boundary)
    assert C.utf16_units(document(o)['value'])==4096
    TimedBroker.profile_expected = False
    p = payload(command('setValue',observationId=o['id'],ref=document(o)['ref'],text=boundary+chr(0x1f600)))
    assert not broker.begin_approval(p)
    assert broker.execute(p)['outcome']=='not_executed'
    assert doc.queryText().getText(0,C.AX_TEXT_UNITS+1)==boundary
    print('PASS: real approved UTF-16 document assignments and fresh postvalues; 4096 accepted, oversized input denied; no values logged',flush=True)

    # Seed oversize state via test-only AT-SPI, not a helper validation bypass.
    # Mutate AFTER approval too, proving the pre-dispatch freshness barrier.
    o = observe()
    p = payload(command('setValue',observationId=o['id'],ref=document(o)['ref'],text='must not dispatch'))
    assert broker.begin_approval(p)
    assert broker.end_approval(dict(**p,approved=True))
    oversized = boundary+chr(0x1f600)
    assert doc.queryEditableText().setTextContents(oversized)
    assert broker.execute(p)['outcome']=='not_executed'
    partial = observe(complete=False)
    assert partial['completeness']=='partial'
    assert C.utf16_units(document(partial)['value'])==4096
    p = payload(command('setValue',observationId=partial['id'],ref=document(partial)['ref'],text='must not approve'))
    assert not broker.begin_approval(p)
    assert broker.execute(p)['outcome']=='not_executed'
    assert doc.queryText().getText(0,C.AX_TEXT_UNITS+1)==oversized
    deny_capture(partial)
    assert doc.queryEditableText().setTextContents('x'*4097)
    ascii_partial = observe(complete=False)
    assert ascii_partial['completeness']=='partial'
    assert C.utf16_units(document(ascii_partial)['value'])==4096
    denied = payload(command('setValue',observationId=ascii_partial['id'],ref=document(ascii_partial)['ref'],text='not permitted'))
    assert not broker.begin_approval(denied)
    assert broker.execute(denied)['outcome']=='not_executed'
    assert doc.queryText().getText(0,C.AX_TEXT_UNITS+1)=='x'*4097
    deny_capture(ascii_partial)
    print('PASS: >4096-unit gedit text is partial; new approval and already-approved dispatch refused; capture denied throughout',flush=True)

    old = dict(target)
    old_xid = w['xid']
    stop_process(child)  # terminate, never Save or answer a save dialog
    wait_for(lambda: old_xid not in backend.x.prop(backend.x.root,'_NET_CLIENT_LIST_STACKING'),'old WM teardown')
    child = launch()
    target = wait_for(discovered,'reopened gedit')
    assert target['processId']!=old['processId']
    for key in ('processInstanceId','windowId','windowInstanceId'):
        assert target[key]!=old[key], 'identity reused after reopening'
    try:
        backend.live(old)
    except RuntimeError:
        pass
    else:
        raise AssertionError('old target accepted after reopening')
    w = backend.live(target)
    nodes,refs,_ = wait_for(complete_tree,'reopened empty document')
    reopened = next(ref[0] for ref in refs.values() if ref[1]['actions']==['setValue'])
    assert reopened.queryText().getText(0,C.AX_TEXT_UNITS+1)=='', 'unsaved document recovered unexpectedly'
    stale = command()
    stale['action']['target'] = old
    assert broker.execute(payload(stale))['outcome']=='not_executed'
    # App config/cache may exist in private XDG directories; document contents
    # must not have been persisted. Never follow links out of this disposable HOME.
    for key in ('HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR'):
        root = Path(os.environ[key]).resolve()
        for path in root.rglob('*'):
            if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root):
                assert path.stat().st_size<2*1024*1024, 'unexpected private data file size'
                data = path.read_bytes()
                assert all(content.encode() not in data for content in (value,boundary,oversized,'x'*4097)), 'unsaved document contents persisted'
    print('PASS: reopened real gedit has new process/window identities and empty unsaved buffer; stale target refused',flush=True)
    print('NOTE: actual gedit/AT-SPI/X11; 3500ms per-request deadline enforced; consent/logind/lease simulated; no production acceptance',flush=True)
finally:
    for child in reversed(children):
        stop_process(child)
