"""XI2 raw provenance and UNENABLED XTest candidate. No ignore-input interval.

Core XTEST sources are shared across clients. Provenance is only trustworthy while
this SAME X connection owns an XGrabServer, after a pre-dispatch drain, and raw
cookies match the precise request serial/source/master/type/detail sequence.
The Openbox native probe fails this condition for release; Broker never calls
CanvasInput and always advertises input=false. This is not a usable control lane.
Physical input continues during a server grab and is never exempted.
"""
import ctypes as C
import hashlib
import math
from contextlib import contextmanager
from x11 import P, I, U


class Takeover(RuntimeError):
    pass


class Cookie(C.Structure):
    _fields_ = [('type', I), ('serial', U), ('send_event', I), ('display', P),
                ('extension', I), ('evtype', I), ('cookie', C.c_uint), ('data', P)]


class Valuators(C.Structure):
    _fields_ = [('mask_len', I), ('mask', C.POINTER(C.c_ubyte)), ('values', C.POINTER(C.c_double))]


class Raw(C.Structure):
    _fields_ = [('type', I), ('serial', U), ('send_event', I), ('display', P),
                ('extension', I), ('evtype', I), ('time', U), ('deviceid', I),
                ('sourceid', I), ('detail', I), ('flags', I), ('valuators', Valuators),
                ('raw_values', C.POINTER(C.c_double))]


class Device(C.Structure):
    _fields_ = [('deviceid', I), ('name', C.c_char_p), ('use', I), ('attachment', I),
                ('enabled', I), ('num_classes', I), ('classes', P)]


class Buttons(C.Structure):
    _fields_ = [('mask_len', I), ('mask', C.POINTER(C.c_ubyte))]


class Mods(C.Structure):
    _fields_ = [('base', I), ('latched', I), ('locked', I), ('effective', I)]


def raw_events(x):
    x.bind('XGetEventData', [P, C.POINTER(Cookie)], I)
    x.bind('XFreeEventData', [P, C.POINTER(Cookie)], None)
    events = []
    while x.x.XPending(x.d):
        event = (C.c_long * 24)()
        x.x.XNextEvent(x.d, event)
        cookie = C.cast(event, C.POINTER(Cookie))
        if cookie.contents.type != 35:
            raise Takeover('unexpected X event')
        if not x.x.XGetEventData(x.d, cookie):
            raise Takeover('unreadable raw input')
        try:
            c = cookie.contents
            if c.send_event or c.extension != x.xi_opcode or c.evtype not in (13, 14, 15, 16, 17, 22, 23, 24):
                raise Takeover('unrecognized input source')
            r = C.cast(c.data, C.POINTER(Raw)).contents
            events.append(dict(serial=r.serial, type=r.evtype, source=r.sourceid,
                               master=r.deviceid, detail=r.detail, send_event=bool(r.send_event)))
            if len(events) > 2048:
                raise Takeover('input overflow')
        finally:
            x.x.XFreeEventData(x.d, cookie)
    return events


def exact_event(events, source, master, kind, detail, serial):
    return events == [dict(serial=serial, type=kind, source=source, master=master,
                           detail=detail, send_event=False)]


def frame_point(bounds, width, height, x, y):
    if (type(x) not in (int, float) or type(y) not in (int, float)
            or not math.isfinite(x) or not math.isfinite(y)
            or width != bounds['width'] or height != bounds['height']
            or not 0 <= x < width or not 0 <= y < height):
        raise ValueError('invalid frame transform')
    # Capture is exactly one pixel per X server coordinate; subpixels floor.
    return bounds['x'] + math.floor(x), bounds['y'] + math.floor(y)


class CanvasInput:
    # Native Openbox probe fails exact release provenance while XGrabServer is
    # held. This candidate is NOT connected to Broker.execute or advertised.
    # No environment variable, caller payload or capability flag enables it.
    def __init__(self, x):
        self.x = x
        self.held = False
        self.xt = C.CDLL('libXtst.so.6')
        self.xt.XTestQueryExtension.argtypes = [P, C.POINTER(I), C.POINTER(I), C.POINTER(I), C.POINTER(I)]
        args = [I() for _ in range(4)]
        if not self.xt.XTestQueryExtension(x.d, *(C.byref(v) for v in args)):
            raise RuntimeError('XTEST unavailable')
        self.xt.XTestFakeMotionEvent.argtypes = [P, I, I, I, U]
        self.xt.XTestFakeButtonEvent.argtypes = [P, C.c_uint, I, U]
        self.xi = C.CDLL('libXi.so.6')
        self.xi.XIQueryDevice.argtypes = [P, I, C.POINTER(I)]
        self.xi.XIQueryDevice.restype = C.POINTER(Device)
        self.xi.XIFreeDeviceInfo.argtypes = [C.POINTER(Device)]
        self.xi.XIGetClientPointer.argtypes = [P, U, C.POINTER(I)]
        self.xi.XIQueryPointer.argtypes = [P, I, U, C.POINTER(U), C.POINTER(U),
            C.POINTER(C.c_double), C.POINTER(C.c_double), C.POINTER(C.c_double), C.POINTER(C.c_double),
            C.POINTER(Buttons), C.POINTER(Mods), C.POINTER(Mods)]
        x.bind('XNextRequest', [P], U)
        self.master, self.source = self.identity()

    def devices(self):
        count = I()
        devices = self.xi.XIQueryDevice(self.x.d, 0, C.byref(count))
        if not devices:
            raise RuntimeError('XI2 devices unavailable')
        try:
            if not 0 < count.value <= 256:
                raise RuntimeError('ambiguous XI2 devices')
            return [dict(id=d.deviceid, name=d.name.decode(), use=d.use,
                         attachment=d.attachment, enabled=bool(d.enabled)) for d in devices[:count.value]]
        finally:
            self.xi.XIFreeDeviceInfo(devices)

    def identity(self):
        master = I()
        if not self.xi.XIGetClientPointer(self.x.d, 0, C.byref(master)):
            raise RuntimeError('no client pointer')
        devices = self.devices()
        masters = [d for d in devices if d['id'] == master.value and d['use'] == 1 and d['enabled']]
        sources = [d for d in devices if d['attachment'] == master.value and d['use'] == 3
                   and d['enabled'] and d['name'] == 'Virtual core XTEST pointer']
        if len(masters) != 1 or masters[0]['name'] != 'Virtual core pointer' or len(sources) != 1:
            raise RuntimeError('unsupported pointer topology')
        return master.value, sources[0]['id']

    def pointer(self):
        root, child = U(), U()
        coords = [C.c_double() for _ in range(4)]
        buttons, mods, group = Buttons(), Mods(), Mods()
        if not self.xi.XIQueryPointer(self.x.d, self.master, self.x.root, C.byref(root), C.byref(child),
                *(C.byref(v) for v in coords), C.byref(buttons), C.byref(mods), C.byref(group)):
            raise Takeover('pointer unavailable')
        try:
            if not 0 <= buttons.mask_len <= 32:
                raise Takeover('unknown buttons')
            pressed = any(buttons.mask[i] for i in range(buttons.mask_len))
            return coords[0].value, coords[1].value, pressed, mods.effective
        finally:
            if buttons.mask:
                self.x.x.XFree(buttons.mask)

    @contextmanager
    def grabbed(self):
        if getattr(self.x, 'server_grabbed', False):
            raise RuntimeError('nested input dispatch')
        self.x.x.XGrabServer(self.x.d)
        self.x.x.XSync(self.x.d, 0)
        self.x.server_grabbed = True
        try:
            yield
        finally:
            try:
                self.release_held()
            finally:
                self.x.server_grabbed = False
                self.x.x.XUngrabServer(self.x.d)
                self.x.x.XSync(self.x.d, 0)

    def release_held(self):
        if self.held:
            # Never release somebody else's pre-existing held button: dispatch
            # refuses it before arming. Cleanup only releases our own down.
            self.xt.XTestFakeButtonEvent(self.x.d, 1, 0, 0)
            self.x.x.XSync(self.x.d, 0)
            self.held = False

    def emit(self, kind, x=None, y=None):
        serial = self.x.x.XNextRequest(self.x.d)
        if kind == 17:
            ok = self.xt.XTestFakeMotionEvent(self.x.d, -1, x, y, 0)
        else:
            if kind == 15:
                self.held = True  # before request: failure can be after delivery
            ok = self.xt.XTestFakeButtonEvent(self.x.d, 1, int(kind == 15), 0)
        self.x.x.XSync(self.x.d, 0)
        if not ok or not exact_event(raw_events(self.x), self.source, self.master, kind, 0 if kind == 17 else 1, serial):
            raise Takeover('unexpected input sequence')
        if kind == 16:
            self.held = False

    def click(self, window, pid, frame, x, y, guard):
        point = frame_point(frame['bounds'], frame['width'], frame['height'], x, y)
        # guard performs lease/deadline/logind checks BEFORE grabbing the server;
        # it must not make AT-SPI calls or use another X display while grabbed.
        guard()
        with self.grabbed():
            if raw_events(self.x):
                raise Takeover('input before dispatch')
            if self.identity() != (self.master, self.source):
                raise Takeover('input topology changed')
            old_x, old_y, pressed, modifiers = self.pointer()
            if pressed or modifiers:
                raise Takeover('held input')
            if (self.x.pid(window) != pid or self.x.bounds(window) != frame['bounds']
                    or self.x.layout() != frame['displayLayoutVersion']
                    or self.x.foreground() != window or not self.x.unoccluded(window)):
                raise ValueError('stale frame geometry/stacking')
            if hashlib.sha256(self.x.pixels(window)).hexdigest() != frame['digest']:
                raise ValueError('stale frame pixels')
            # No unrelated client requests can run here. Physical input still can.
            if raw_events(self.x):
                raise Takeover('input while verifying pixels')
            guard()
            if point != (old_x, old_y):
                self.emit(17, *point)
            px, py, pressed, modifiers = self.pointer()
            if (px, py) != point or pressed or modifiers or raw_events(self.x):
                raise Takeover('pointer moved or held')
            if not self.x.unoccluded(window) or self.x.foreground() != window:
                raise ValueError('stacking changed')
            guard()
            try:
                self.emit(15)
                # Revoke on external input even between down and up. The finally
                # path pairs our down regardless of validation failure.
                if raw_events(self.x):
                    raise Takeover('input during click')
                self.emit(16)
            finally:
                self.release_held()
            if self.pointer()[2] or raw_events(self.x):
                raise Takeover('unexpected held/input state after click')
        return True
