"""Actual GTK/AT-SPI/X11 backend integration, NOT production safety acceptance.
Run under dbus-run-session. Subprocesses exist only in this test harness.
No runtime bypass flag exists in the private helper.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Discard inherited desktop/bus credentials through the owning supervisor.
from discovery_targets import selected_target, check_discovery_frame
from isolated_desktop import run_isolated
if not globals().get('_OWNED_DESKTOP_WORKER'):
    raise SystemExit(run_isolated(__file__, sys.argv[1:]))
children = []

def launch(argv):
    child = subprocess.Popen(argv, stdout=subprocess.DEVNULL)
    children.append(child)
    return child

def wait_for(fn):
    last = None
    for _ in range(60):
        try:
            value = fn()
            if value:
                return value
        except Exception as error:
            last = error
        time.sleep(.1)
    raise AssertionError(f'native fixture not ready: {last}')

try:
    fixture = launch([sys.executable, str(ROOT / 'fixture.py')])
    from atspi_backend import Backend, FIXTURE
    backend = Backend()
    def discover():
        result = backend.discover()
        if not result:
            from gi.repository import GLib
            while GLib.MainContext.default().pending():
                GLib.MainContext.default().iteration(False)
        return result
    try:
        targets = wait_for(discover)
    except AssertionError:
        print('desktop children', backend.desktop.childCount, flush=True)
        for app in backend.desktop:
            print('app', app.name, app.get_process_id(), backend.cohort(app.get_process_id()), flush=True)
            for child in app:
                print('window', child.getRoleName(), backend.bounds(child), flush=True)
                for xid in backend.x.prop(backend.x.root, '_NET_CLIENT_LIST_STACKING'):
                    print('X11', xid, backend.x.pid(xid), backend.x.bounds(xid), flush=True)
        raise
    assert len(targets) == 1 and targets[0]['appId'] == FIXTURE
    target = selected_target(targets[0], 'Brian Native Fixture')
    w = backend.live(target)
    assert w['target'] == target and 'displayName' not in w['target']
    check_discovery_frame(backend)
    wait_for(lambda: backend.context(w)['foreground'])
    def fixture_tree_ready():
        nodes, refs, completeness = backend.tree(w)
        required = {'Harmless note','Copy note locally','Local actions','Local scroll content'}
        if required <= {n['name'] for n in nodes} and any('scroll' in n['actions'] for n in nodes):
            return nodes, refs, completeness
        return None
    nodes, refs, completeness = wait_for(fixture_tree_ready)
    assert nodes, 'real AT-SPI tree missing'
    assert 'SENTINEL' not in json.dumps(nodes), 'secure field data leaked'
    assert any(n['sensitive'] for n in nodes), 'password field not redacted'
    ref = next(r for r in refs.values() if r[1]['name'] == 'Harmless note')
    assert 'setValue' in ref[1]['actions'], ref[1]
    assert backend.act('setValue', ref, {'text': 'real GTK semantic edit'}, lambda: None)
    nodes, refs, _ = wait_for(fixture_tree_ready)
    assert any(n.get('value') == 'real GTK semantic edit' for n in nodes)
    button = next(r for r in refs.values() if r[1]['name'] == 'Copy note locally' and 'invoke' in r[1]['actions'])
    assert backend.act('invoke', button, {}, lambda: None)
    nodes, refs, _ = wait_for(fixture_tree_ready)
    assert any(n['role'] == 'label' and n['name'] == 'real GTK semantic edit' for n in nodes)
    selection = next(r for r in refs.values() if 'select' in r[1]['actions'])
    assert backend.act('select', selection, {}, lambda: None)
    nodes, refs, _ = wait_for(fixture_tree_ready)
    assert any(n['role'] == 'list item' and n['selected'] for n in nodes)
    scrollbar = next(r for r in refs.values() if 'scroll' in r[1]['actions'])
    before = float(scrollbar[1]['value'])
    assert backend.act('scroll', scrollbar, {'deltaY': 120}, lambda: None)
    assert wait_for(lambda: any(n['role'] == 'scroll bar' and float(n['value']) > before for n in backend.tree(w)[0]))
    nodes, refs, _ = wait_for(fixture_tree_ready)
    root_menu = next(r for r in refs.values() if r[1]['name'] == 'Local actions' and 'invoke' in r[1]['actions'])
    assert backend.act('invoke', root_menu, {}, lambda: None)
    def menu_target():
        _, current_refs, _ = backend.tree(w)
        return next((r for r in current_refs.values() if r[1]['name'] == 'Mark menu complete' and 'invoke' in r[1]['actions']), None)
    item = wait_for(menu_target)
    assert backend.act('invoke', item, {}, lambda: None)
    def menu_done():
        current, _, _ = backend.tree(w)
        return any(n['name'] == 'Menu workflow complete' for n in current)
    assert wait_for(menu_done)
    print('PASS: actual GTK AT-SPI edit/invoke/select, scroll Value and local menu workflow; redaction')
    fixture.terminate()
    fixture.wait(timeout=3)
    try:
        backend.live(target)
        raise AssertionError('dead process still accepted')
    except (ProcessLookupError, FileNotFoundError, RuntimeError):
        pass
    canvas = launch([sys.executable, str(ROOT / 'fixture.py'), '--canvas'])
    targets = wait_for(backend.discover)
    target = selected_target(targets[0], 'Brian Safe Canvas')
    w = backend.live(target)
    wait_for(lambda: backend.context(w)['foreground'])
    time.sleep(.3)
    nodes, refs, complete = backend.tree(w)
    assert backend.safe_canvas(w, dict(observation=dict(nodes=nodes, completeness=complete), refs=refs)), (complete, nodes)
    png = backend.capture(w)
    assert png.startswith(b'\x89PNG\r\n\x1a\n') and len(png) > 100
    # Verify actual raster colours, not just an encoded PNG header.
    import struct, zlib
    offset, compressed = 8, b''
    while offset < len(png):
        size, = struct.unpack('!I',png[offset:offset+4])
        kind = png[offset+4:offset+8]
        data = png[offset+8:offset+8+size]
        if kind == b'IDAT':
            compressed += data
        offset += size+12
    raw = zlib.decompress(compressed)
    width = backend.context(w)['bounds']['width']
    def pixel(x,y):
        start = y*(width*3+1)+1+x*3
        return tuple(raw[start:start+3])
    assert pixel(10,10) == (255,255,255), pixel(10,10)
    blue = pixel(150,120)
    assert blue[2] > blue[1] > blue[0], blue
    print('PASS: actual XGetImage isolated canvas PNG and 1:1 pixel transform')
    # XI2 subscription is real; no logind/mock session authority is asserted.
    from x11 import X11
    events = X11(events=True)
    assert not events.input_pending()
    import ctypes as C
    xtest = C.CDLL('libXtst.so.6')
    xtest.XTestFakeMotionEvent.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong]
    assert xtest.XTestFakeMotionEvent(events.d, -1, 30, 40, 0)
    events.x.XSync(events.d, 0)
    assert wait_for(events.input_pending)
    print('PASS: actual XI2 raw-input detection using test-only XTest injection')
    from xinput import CanvasInput
    import hashlib
    import xinput
    original_match = xinput.exact_event
    def diagnostic_match(actual, *expected):
        matched = original_match(actual, *expected)
        if not matched:
            print('XI2 sequence mismatch:', actual, 'expected:', expected, flush=True)
        return matched
    xinput.exact_event = diagnostic_match
    injector = CanvasInput(events)
    b = backend.context(w)['bounds']
    f = dict(bounds=b, width=b['width'], height=b['height'],
             displayLayoutVersion=events.layout(), digest=hashlib.sha256(backend.capture(w)).hexdigest())
    from xinput import Takeover, raw_events
    try:
        injector.click(w['xid'], w['target']['processId'], f, 150, 120, lambda: None)
    except Takeover as error:
        print('EXPECTED FAIL-CLOSED PROBE:', str(error), flush=True)
    else:
        raise AssertionError('reassess attribution blocker: probe unexpectedly succeeded')
    # Candidate deliberately cannot satisfy its exact sequence under Openbox.
    # Unfreeze the WM, then prove button release/visible effect instead of replay.
    time.sleep(.2)
    delayed = raw_events(events)
    assert not injector.pointer()[2] and not injector.held
    print('XI2 delayed after server ungrab:', delayed, flush=True)
    def canvas_result():
        nodes, _, _ = backend.tree(w)
        return next((n for n in nodes if n['name'] == 'Canvas result: blue selected (1)'), None)
    result = wait_for(canvas_result)
    assert result['actions'] == []
    print('PASS: candidate native click produced non-actionable AX result; cleanup released held input')
    try:
        injector.click(w['xid'], w['target']['processId'], f, 150, 120, lambda: None)
    except ValueError as error:
        assert 'stale frame pixels' in str(error)
    else:
        raise AssertionError('stale pixels replayed')
    assert wait_for(canvas_result)
    print('PASS: stale pixel digest refused before redispatch')
    # Another X client uses the very same XTEST source: device ID alone is NOT
    # attribution. No test grants it an ignore window.
    external = X11()
    assert xtest.XTestFakeMotionEvent(external.d, -1, 20, 20, 0)
    external.x.XSync(external.d, 0)
    external_events = wait_for(lambda: raw_events(events))
    assert all(e['source'] == injector.source for e in external_events)
    assert not xinput.exact_event(external_events, injector.source, injector.master, 15, 1, -1)
    print('PASS: external-client XTEST shares source', injector.source, '; no source-only exemption')
    # Test a different XI2 source using the Xvfb mouse device. This is genuine
    # server event routing, but XTest-generated, NOT physical-hardware acceptance.
    non_xtest = next(d for d in injector.devices() if d['name'] == 'Xvfb mouse')
    injector.xi.XOpenDevice.argtypes = [C.c_void_p, C.c_ulong]
    injector.xi.XOpenDevice.restype = C.c_void_p
    injector.xi.XCloseDevice.argtypes = [C.c_void_p, C.c_void_p]
    xtest.XTestFakeDeviceMotionEvent.argtypes = [C.c_void_p, C.c_void_p, C.c_int, C.c_int, C.POINTER(C.c_int), C.c_int, C.c_ulong]
    device = injector.xi.XOpenDevice(external.d, non_xtest['id'])
    assert device
    try:
        axes = (C.c_int * 2)(18, 18)
        assert xtest.XTestFakeDeviceMotionEvent(external.d, device, 0, 0, axes, 2, 0)
        external.x.XSync(external.d, 0)
        other_events = wait_for(lambda: raw_events(events))
        assert any(e['source'] == non_xtest['id'] for e in other_events), other_events
        assert not xinput.exact_event(other_events, injector.source, injector.master, 17, 0, other_events[0]['serial'])
        print('PASS: non-XTEST XI2 source', non_xtest['id'], 'cannot match our expected sequence (simulated hardware)')
    finally:
        injector.xi.XCloseDevice(external.d, device)
    # Fail after our own down; finally must release even when outcome is unknown.
    f['digest'] = hashlib.sha256(backend.capture(w)).hexdigest()
    original_emit = injector.emit
    def interrupted(kind, *args):
        original_emit(kind, *args)
        if kind == 15:
            raise Takeover('simulated interruption after native down')
    injector.emit = interrupted
    try:
        injector.click(w['xid'], w['target']['processId'], f, 150, 120, lambda: None)
    except Takeover:
        pass
    else:
        raise AssertionError('interrupted click reported success')
    finally:
        injector.emit = original_emit
    time.sleep(.2)
    raw_events(events)
    assert not injector.pointer()[2] and not injector.held
    print('PASS: actual held button released after injected failure; no replay')
    # A user's pre-existing down must cause refusal, not an unsolicited release.
    assert xtest.XTestFakeMotionEvent(external.d, -1, b['x']+10, b['y']+10, 0)
    external.x.XSync(external.d, 0)
    raw_events(events)
    xtest.XTestFakeButtonEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
    assert xtest.XTestFakeButtonEvent(external.d, 1, 1, 0)
    external.x.XSync(external.d, 0)
    assert wait_for(lambda: injector.pointer()[2])
    time.sleep(.1)
    raw_events(events)
    try:
        try:
            injector.click(w['xid'], w['target']['processId'], f, 150, 120, lambda: None)
        except Takeover as error:
            assert str(error) == 'held input', str(error)
        else:
            raise AssertionError('pre-existing held input accepted')
        assert injector.pointer()[2] and not injector.held
    finally:
        xtest.XTestFakeButtonEvent(external.d, 1, 0, 0)
        external.x.XSync(external.d, 0)
        time.sleep(.1)
        raw_events(events)
    assert not injector.pointer()[2]
    print('PASS: pre-existing held input refused without releasing user-owned button')
    # An unrelated top-level X window must prevent canvas capture.
    x = backend.x
    x.bind('XCreateSimpleWindow', [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong], C.c_ulong)
    x.bind('XMapRaised', [C.c_void_p, C.c_ulong], C.c_int)
    x.bind('XDestroyWindow', [C.c_void_p, C.c_ulong], C.c_int)
    b = backend.context(w)['bounds']
    overlay = x.x.XCreateSimpleWindow(x.d, x.root, b['x']+40, b['y']+40, 120, 120, 0, 0, 0)
    x.x.XMapRaised(x.d, overlay)
    x.x.XSync(x.d, 0)
    time.sleep(.2)
    try:
        backend.capture(w)
    except RuntimeError:
        pass
    else:
        raise AssertionError('overlaid canvas captured')
    try:
        injector.click(w['xid'], w['target']['processId'], f, 150, 120, lambda: None)
    except ValueError as error:
        assert 'geometry/stacking' in str(error), str(error)
    else:
        raise AssertionError('overlaid candidate click dispatched')
    assert not injector.held and not injector.pointer()[2]
    print('PASS: candidate click rechecks stacking before native input')
    x.x.XDestroyWindow(x.d, overlay)
    x.x.XSync(x.d, 0)
    print('PASS: actual overlay capture refusal; production logind/lease/watchdog acceptance NOT tested')
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
