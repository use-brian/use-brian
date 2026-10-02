"""Direct libX11/XInput2 bindings. No command execution, clipboard, or root capture."""
import ctypes as C
import hashlib
import struct
import zlib

U = C.c_ulong
I = C.c_int
P = C.c_void_p


class Mask(C.Structure):
    _fields_ = [('deviceid', I), ('mask_len', I), ('mask', C.POINTER(C.c_ubyte))]


class Attributes(C.Structure):
    _fields_ = [(n, I) for n in ('x', 'y', 'width', 'height', 'border_width', 'depth')] + [
        ('visual', P), ('root', U), ('window_class', I), ('bit_gravity', I), ('win_gravity', I),
        ('backing_store', I), ('backing_planes', U), ('backing_pixel', U), ('save_under', I),
        ('colormap', U), ('map_installed', I), ('map_state', I), ('all_event_masks', C.c_long),
        ('your_event_mask', C.c_long), ('do_not_propagate_mask', C.c_long), ('override_redirect', I), ('screen', P)]


class ClientData(C.Union):
    _fields_ = [('b', C.c_char * 20), ('s', C.c_short * 10), ('l', C.c_long * 5)]


class ClientMessage(C.Structure):
    _fields_ = [('type', I), ('serial', U), ('send_event', I), ('display', P),
                ('window', U), ('message_type', U), ('format', I), ('data', ClientData)]


class Resources(C.Structure):
    _fields_ = [('timestamp', U), ('configTimestamp', U)]


class X11:
    def __init__(self, events=False):
        self.x = C.CDLL('libX11.so.6')
        self.bind('XInitThreads', [], I)()
        self.bind('XOpenDisplay', [C.c_char_p], P)
        self.bind('XDefaultRootWindow', [P], U)
        self.bind('XInternAtom', [P, C.c_char_p, I], U)
        self.bind('XGetWindowProperty', [P, U, U, C.c_long, C.c_long, I, U, C.POINTER(U), C.POINTER(I), C.POINTER(U), C.POINTER(U), C.POINTER(P)], I)
        self.bind('XFree', [P], I)
        self.bind('XGetGeometry', [P, U, C.POINTER(U), C.POINTER(I), C.POINTER(I), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint)], I)
        self.bind('XTranslateCoordinates', [P, U, U, I, I, C.POINTER(I), C.POINTER(I), C.POINTER(U)], I)
        self.bind('XPending', [P], I)
        self.bind('XNextEvent', [P, P], I)
        self.bind('XSync', [P, I], I)
        self.bind('XGetImage', [P, U, I, I, C.c_uint, C.c_uint, U, I], P)
        self.bind('XGetPixel', [P, I, I], U)
        self.bind('XDestroyImage', [P], I)
        self.bind('XQueryTree', [P, U, C.POINTER(U), C.POINTER(U), C.POINTER(C.POINTER(U)), C.POINTER(C.c_uint)], I)
        self.bind('XGetWindowAttributes', [P, U, C.POINTER(Attributes)], I)
        self.bind('XGrabServer', [P], I)
        self.bind('XUngrabServer', [P], I)
        self.rr = C.CDLL('libXrandr.so.2')
        self.rr.XRRGetScreenResourcesCurrent.argtypes = [P, U]
        self.rr.XRRGetScreenResourcesCurrent.restype = C.POINTER(Resources)
        self.rr.XRRFreeScreenResources.argtypes = [C.POINTER(Resources)]
        # X errors terminate rather than continuing with uncertain window identity.
        self.d = self.x.XOpenDisplay(None)
        if not self.d:
            raise RuntimeError('X11 unavailable')
        self.root = self.x.XDefaultRootWindow(self.d)
        if events:
            xi = C.CDLL('libXi.so.6')
            xi.XIQueryVersion.argtypes = [P, C.POINTER(I), C.POINTER(I)]
            major, minor = I(2), I(2)
            if xi.XIQueryVersion(self.d, C.byref(major), C.byref(minor)) != 0 or major.value < 2:
                raise RuntimeError('XI2 unavailable')
            xi.XISelectEvents.argtypes = [P, U, C.POINTER(Mask), I]
            bits = (C.c_ubyte * 4)()
            # Raw key/button/motion/touch events, all master devices. Includes
            # synthetic input; no unsafe ignore-own-input window is implemented.
            for event in (13, 14, 15, 16, 17, 22, 23, 24):
                bits[event // 8] |= 1 << (event % 8)
            mask = Mask(1, 4, bits)
            if xi.XISelectEvents(self.d, self.root, C.byref(mask), 1) != 0:
                raise RuntimeError('XI2 subscription failed')
            self.x.XSync(self.d, 0)
            self.bind('XQueryExtension', [P, C.c_char_p, C.POINTER(I), C.POINTER(I), C.POINTER(I)], I)
            opcode, first_event, first_error = I(), I(), I()
            if not self.x.XQueryExtension(self.d, b'XInputExtension', C.byref(opcode), C.byref(first_event), C.byref(first_error)):
                raise RuntimeError('XI2 extension unavailable')
            self.xi_opcode = opcode.value

    def bind(self, name, args, result):
        f = getattr(self.x, name)
        f.argtypes, f.restype = args, result
        return f

    def prop(self, window, name):
        atom = self.x.XInternAtom(self.d, name.encode(), 1)
        if not atom:
            return []
        actual, fmt, n, rest, data = U(), I(), U(), U(), P()
        status = self.x.XGetWindowProperty(self.d, window, atom, 0, 4096, 0, 0, C.byref(actual), C.byref(fmt), C.byref(n), C.byref(rest), C.byref(data))
        try:
            if status or rest.value or fmt.value != 32 or n.value > 4096:
                return []
            return list(C.cast(data, C.POINTER(U))[:n.value])
        finally:
            if data:
                self.x.XFree(data)

    def pid(self, window):
        p = self.prop(window, '_NET_WM_PID')
        return p[0] if len(p) == 1 else 0

    def foreground(self):
        windows = self.prop(self.root, '_NET_ACTIVE_WINDOW')
        return windows[0] if len(windows) == 1 else 0

    def bounds(self, window):
        root, child = U(), U()
        x, y, dx, dy = I(), I(), I(), I()
        w, h, border, depth = (C.c_uint() for _ in range(4))
        if not self.x.XGetGeometry(self.d, window, C.byref(root), C.byref(x), C.byref(y), C.byref(w), C.byref(h), C.byref(border), C.byref(depth)):
            raise RuntimeError('geometry unavailable')
        if not self.x.XTranslateCoordinates(self.d, window, self.root, 0, 0, C.byref(dx), C.byref(dy), C.byref(child)):
            raise RuntimeError('transform unavailable')
        return dict(x=dx.value, y=dy.value, width=w.value, height=h.value)

    def layout(self):
        resources = self.rr.XRRGetScreenResourcesCurrent(self.d, self.root)
        if not resources:
            raise RuntimeError('RANDR unavailable')
        try:
            version = (resources.contents.timestamp, resources.contents.configTimestamp)
        finally:
            self.rr.XRRFreeScreenResources(resources)
        return hashlib.sha256(repr((version, self.bounds(self.root), self.prop(self.root, '_NET_WORKAREA'))).encode()).hexdigest()

    def tree(self, window):
        root, parent, count = U(), U(), C.c_uint()
        children = C.POINTER(U)()
        if not self.x.XQueryTree(self.d, window, C.byref(root), C.byref(parent), C.byref(children), C.byref(count)):
            raise RuntimeError('window tree unavailable')
        try:
            if count.value > 4096:
                raise RuntimeError('window tree too large')
            return parent.value, list(children[:count.value])
        finally:
            if children:
                self.x.XFree(children)

    def pointer_within(self, window):
        self.bind('XQueryPointer', [P, U, C.POINTER(U), C.POINTER(U), C.POINTER(I), C.POINTER(I),
                                   C.POINTER(I), C.POINTER(I), C.POINTER(C.c_uint)], I)
        root, child, mask = U(), U(), C.c_uint()
        rx, ry, x, y = I(), I(), I(), I()
        if not self.x.XQueryPointer(self.d, window, C.byref(root), C.byref(child), C.byref(rx), C.byref(ry),
                                   C.byref(x), C.byref(y), C.byref(mask)):
            return False
        b = self.bounds(window)
        return 0 <= x.value < b['width'] and 0 <= y.value < b['height']

    def request_activation(self, window):
        """EWMH client message only; not a generic broker action or input event."""
        atom = self.x.XInternAtom(self.d, b'_NET_ACTIVE_WINDOW', 1)
        if not atom or atom not in self.prop(self.root, '_NET_SUPPORTED'):
            raise RuntimeError('EWMH activation unsupported')
        self.bind('XSendEvent', [P, U, I, C.c_long, P], I)
        event = (C.c_long * 24)()
        message = C.cast(event, C.POINTER(ClientMessage)).contents
        message.type, message.display = 33, self.d
        message.window, message.message_type, message.format = window, atom, 32
        # Pager source: explicit local lifecycle consent, not inferred task intent.
        message.data.l[0], message.data.l[1], message.data.l[2] = 2, 0, self.foreground()
        if not self.x.XSendEvent(self.d, self.root, 0, (1 << 20) | (1 << 19), event):
            raise RuntimeError('focus request rejected')
        self.x.XSync(self.d, 0)

    def ancestor_of(self, ancestor, window):
        for _ in range(16):
            if window == ancestor:
                return True
            if not window or window == self.root:
                return False
            window, _ = self.tree(window)
        return False

    def unoccluded(self, window, allowed_window=0):
        b = self.bounds(window)
        root_bounds = self.bounds(self.root)
        if b['x'] < 0 or b['y'] < 0 or b['x'] + b['width'] > root_bounds['width'] or b['y'] + b['height'] > root_bounds['height']:
            return False
        current = window
        for _ in range(16):
            attrs = Attributes()
            if not self.x.XGetWindowAttributes(self.d, current, C.byref(attrs)) or attrs.map_state != 2:
                return False
            parent, _ = self.tree(current)
            if not parent:
                return False
            _, siblings = self.tree(parent)
            if current not in siblings:
                return False
            for sibling in siblings[siblings.index(current) + 1:]:
                if allowed_window and self.ancestor_of(sibling, allowed_window):
                    continue
                a = Attributes()
                if not self.x.XGetWindowAttributes(self.d, sibling, C.byref(a)):
                    return False
                if a.map_state != 2 or a.window_class == 2:  # unmapped / InputOnly
                    continue
                r = self.bounds(sibling)
                if (r['x'] < b['x'] + b['width'] and b['x'] < r['x'] + r['width']
                        and r['y'] < b['y'] + b['height'] and b['y'] < r['y'] + r['height']):
                    return False
            if parent == self.root:
                return True
            current = parent
        return False

    def match(self, pid, bounds):
        matches = []
        for w in self.prop(self.root, '_NET_CLIENT_LIST_STACKING'):
            if self.pid(w) != pid:
                continue
            client = self.bounds(w)
            extents = self.prop(w, '_NET_FRAME_EXTENTS')
            framed = None
            if len(extents) == 4 and all(0 <= e <= 1024 for e in extents):
                left, right, top, bottom = extents
                framed = dict(x=client['x']-left, y=client['y']-top,
                              width=client['width']+left+right, height=client['height']+top+bottom)
            if bounds == client or bounds == framed:
                matches.append(w)
        return matches[0] if len(matches) == 1 else None

    def input_pending(self):
        from xinput import raw_events
        return bool(raw_events(self))

    def pixels(self, window):
        # Client-only capture is safe only for the immutable fixture canvas.
        # XGetImage is not used on the root, even transiently.
        b = self.bounds(window)
        w, h = b['width'], b['height']
        if not 0 < w <= 1024 or not 0 < h <= 1024 or self.foreground() != window:
            raise RuntimeError('unsafe capture')
        # Freeze X window stacking while checking every ancestor and capturing.
        # Reject even override-redirect overlays; obscured XGetImage pixels are
        # undefined, so a client-list-only check would not be a privacy boundary.
        own_grab = not getattr(self, 'server_grabbed', False)
        if own_grab:
            self.x.XGrabServer(self.d)
        try:
            if not self.unoccluded(window) or self.foreground() != window or self.bounds(window) != b:
                raise RuntimeError('obscured canvas')
            image = self.x.XGetImage(self.d, window, 0, 0, w, h, U(-1).value, 2)
        finally:
            if own_grab:
                self.x.XUngrabServer(self.d)
                self.x.XSync(self.d, 0)
        if not image:
            raise RuntimeError('capture unavailable')
        class Image(C.Structure):
            _fields_ = [('width', I), ('height', I), ('xoffset', I), ('format', I), ('data', P), ('byte_order', I), ('bitmap_unit', I), ('bitmap_bit_order', I), ('bitmap_pad', I), ('depth', I), ('bytes_per_line', I), ('bits_per_pixel', I), ('red_mask', U), ('green_mask', U), ('blue_mask', U)]
        header = C.cast(image, C.POINTER(Image)).contents
        try:
            if (header.red_mask, header.green_mask, header.blue_mask) != (0xff0000, 0xff00, 0xff) or header.depth not in (24, 32):
                raise RuntimeError('unsupported visual')
            raw = bytearray()
            for y in range(h):
                raw.append(0)
                for x in range(w):
                    pixel = self.x.XGetPixel(image, x, y)
                    raw.extend(((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255))
        finally:
            self.x.XDestroyImage(image)
        def chunk(kind, data):
            return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
        return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
