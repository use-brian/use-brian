#!/usr/bin/python3 -Es
"""Linux private-pipe native computer helper; stdout is protocol only."""
import base64
import copy
import json
import struct
import os
import sys
from contract import PROTOCOL, MAX_BYTES, FRAME_DATA_UNITS, keys, grant, command, text, now, mono, uid, digest, receipt, read_request, write_response, timed_request


class Broker:
    def __init__(self, backend=None, safety=None):
        self.backend, self.safety = backend, safety
        self.reason = 'Required X11, AT-SPI, XI2, RANDR, local logind session or private runtime directory unavailable.'
        self.grant = None
        self.lease = None
        self.snapshot = None
        self.pending = None
        self.approved = None
        self.journal = {}
        self.stopped = False
        self.capture_time = -float('inf')
        if backend is None:
            if os.environ.get('WAYLAND_DISPLAY') or os.environ.get('XDG_SESSION_TYPE') != 'x11':
                self.reason = 'Unsupported Wayland/portal combination: no verified scoped lease, lock and takeover integration. No XWayland fallback.'
                return
            try:
                from safety import Safety
                from atspi_backend import Backend
                self.safety = Safety()
                self.backend = Backend()
            except Exception:
                self.backend = self.safety = None

    def capabilities(self):
        ready = self.backend is not None and self.safety is not None
        return dict(protocol=PROTOCOL, platform='linux', axRead=ready, semanticActions=ready,
                    windowCapture=ready, input=False, accessibilityPermission='granted' if ready else 'unknown',
                    capturePermission='granted' if ready else 'unknown', limitations=[
                        'Experimental X11 GTK fixture and gedit document-text cohort; packaged acceptance pending.' if ready else self.reason,
                        'One foreground window; all semantic writes require exact local approval. Fixture semantic scroll/menu supported. No generic focus, keys or coordinate injection.',
                        'Capture only the shipped isolated safe canvas, at 1:1 X11 client pixels; no editor screenshots.',
                        'Click unavailable: native XI2 release provenance failed under a server grab; shared XTEST device identity alone is insufficient.',
                        'XI2 takeover includes synthetic input. Only exact parent-dialog input is excepted. Consented start/approval restore the selected window using EWMH.',
                        'Requires an active unlocked local logind X11 session and EWMH window manager. Xvfb alone is not an accepted session.'
                    ])

    def start(self, p):
        if not keys(p, 'grant leaseId') or not grant(p['grant']) or not text(p['leaseId']) or self.grant or self.stopped or not self.capabilities()['axRead']:
            return False
        g = p['grant']
        if not now() < g['expiresAt'] <= now() + 900000 or len(g['targets']) != 1:
            return False
        try:
            self.safety.check()
            w = self.backend.live(g['targets'][0])
            context = self.backend.context(w)
            refs = None
            if not context['foreground']:
                _, refs, completeness = self.backend.tree(w)
                if completeness != 'complete' or self.backend.context(w) != context:
                    return False
            self.safety.acquire(g['expiresAt'])
            def guard():
                if not now() < g['expiresAt'] or mono() >= self.safety.deadline:
                    raise ValueError('expired local consent')
                self.safety.check()
            guard()
            if refs is not None:
                self.backend.restore_consented_focus(w, refs, context, self.safety.parent, guard, strict_after=False)
            guard()
            self.grant, self.lease = copy.deepcopy(g), p['leaseId']
            return True
        except Exception:
            self.stopped = True
            return False

    def authorized(self, c, lease, allow_stopped=False):
        if not command(c) or (self.stopped and not allow_stopped) or not self.grant or lease != self.lease:
            return 'denied'
        g = self.grant
        if now() >= c['deadlineAt'] or now() >= g['expiresAt'] or mono() >= self.safety.deadline:
            return 'expired'
        if any(c[k] != g[k] for k in ('protocol', 'identity', 'grantId', 'epoch')):
            return 'denied'
        if c['action']['target'] not in g['targets']:
            return 'wrong_target'
        if c['action']['kind'] == 'capture' and not g['allowCapture']:
            return 'denied'
        if c['action']['kind'] not in ('observe', 'capture') and not g['allowControl']:
            return 'denied'
        self.safety.check()
        return None

    def _fresh_header(self, c, allow_approval_age=False, restoring=False):
        s = self.snapshot
        a = c['action']
        if not s or a.get('observationId') != s['observation']['id'] or s['observation']['target'] != a['target']:
            raise ValueError('stale observation')
        if s['observation']['completeness'] != 'complete':
            raise ValueError('partial observations cannot authorize effects')
        if not allow_approval_age and mono() - s['time'] >= 5000:
            raise ValueError('expired observation')
        w = self.backend.live(a['target'])
        ctx = self.backend.context(w)
        fields = ('bounds', 'displayLayoutVersion') if restoring else tuple(ctx)
        if (not restoring and not ctx['foreground']) or any(ctx[k] != s['observation'][k] for k in fields):
            raise ValueError('changed context')
        return w, s

    def fresh(self, c, allow_approval_age=False, restoring=False):
        w, s = self._fresh_header(c, allow_approval_age, restoring)
        if not self.backend.unchanged(w, s['refs'], ignore_focus=restoring):
            raise ValueError('changed tree')
        return w, s

    def observe(self, c, w):
        self.safety.check()
        started = mono()
        before = self.backend.context(w)
        self.safety.check()
        nodes, refs, complete = self.backend.tree(w)
        if self.backend.context(w) != before:
            raise ValueError('changed while observing')
        self.safety.check()
        o = dict(identity=c['identity'], epoch=c['epoch'], id=uid(), capturedAt=now(), monotonicMs=started,
                 target=w['target'], completeness=complete, nodes=nodes, **before)
        self.snapshot = dict(observation=o, refs=refs, time=started)
        return o

    def begin_approval(self, p):
        if not keys(p, 'command leaseId') or self.pending or self.authorized(p['command'], p['leaseId']):
            return False
        c = p['command']
        if c['action']['kind'] not in ('invoke', 'setValue', 'select', 'scroll') or c['commandId'] in self.journal:
            return False
        try:
            _, s = self.fresh(c)
            ref = s['refs'].get(c['action']['ref'])
            if not ref or c['action']['kind'] not in ref[1]['actions']:
                return False
            self.approved = None
            self.pending = copy.deepcopy(c)
            self.approval_expiry = min(mono() + 30000, mono() + c['deadlineAt'] - now())
            with self.safety.lock:
                self.safety.approval_window = 0
                self.safety.approval_deadline = self.approval_expiry
                self.safety.approval = True
            return True
        except Exception:
            return False

    def end_approval(self, p):
        if self.safety is None or not keys(p, 'command leaseId approved') or type(p['approved']) is not bool:
            return False
        try:
            c = p['command']
            if self.pending != c or self.authorized(c, p['leaseId']) or mono() >= self.approval_expiry:
                return False
            # Approval grants this exact effect AND the disclosed lifecycle focus
            # restoration, never a generic focus action. No exception during it.
            self.safety.close_approval()
            if not p['approved']:
                self.snapshot = None
                return True
            # Header checks scope, completeness, approval age, identity and
            # geometry. Restoration owns the TWO full pre/post tree passes.
            w, s = self._fresh_header(c, allow_approval_age=True, restoring=True)
            def guard():
                if self.authorized(c, p['leaseId']) or mono() >= self.approval_expiry:
                    raise ValueError('expired/revoked action approval')
            if not self.backend.restore_consented_focus(w, s['refs'], s['observation'], self.safety.parent, guard):
                raise ValueError('focus restoration refused')
            _, current = self._fresh_header(c, allow_approval_age=True)
            if current is not s:
                raise ValueError('snapshot changed during approval')
            guard()
            s['time'] = mono()
            self.approved = digest(c)
            return True
        except Exception:
            self.stopped = True
            return False
        finally:
            self.pending = None
            self.safety.approval = False
            self.safety.approval_window = 0

    def execute(self, p):
        c = p.get('command', {})
        if not isinstance(c, dict):
            c = {}
        if not keys(p, 'command leaseId') or not command(c):
            return receipt({'commandId': 'invalid'}, 'denied')
        denial = self.authorized(c, p['leaseId'], allow_stopped=True)
        if denial:
            return receipt(c, denial)
        fingerprint = digest(c)
        old = self.journal.get(c['commandId'])
        if old:
            return copy.deepcopy(old[1]) if old[0] == fingerprint else receipt(c, 'denied')
        if self.stopped or self.pending or len(self.journal) >= 512:
            return receipt(c, 'stopped')
        self.journal[c['commandId']] = (fingerprint, receipt(c, 'helper_error', 'execution_unknown'))
        dispatched = False
        def finish(r):
            self.journal[c['commandId']] = (fingerprint, {k: v for k, v in r.items() if k != 'observation'})
            if r['outcome'] == 'execution_unknown':
                self.stopped = True
            return r
        try:
            a = c['action']
            kind = a['kind']
            w = self.backend.live(a['target'])
            if kind == 'observe':
                o = self.observe(c, w)
                return finish(receipt(c, 'expired') if self.authorized(c, p['leaseId']) else receipt(c, 'ok', 'executed', o))
            if kind not in ('capture', 'invoke', 'setValue', 'select', 'scroll'):
                return finish(receipt(c, 'unsupported'))
            if kind == 'capture':
                w, s = self.fresh(c)  # pixels keep BOTH full pre/post checks
                if mono() - self.capture_time < 1000 or not self.backend.safe_canvas(w, s):
                    return finish(receipt(c, 'denied'))
                self.capture_time = mono()
                self.safety.check()
                png = self.backend.capture(w)
                self.safety.check()
                self.fresh(c)
                if self.authorized(c, p['leaseId']):
                    return finish(receipt(c, 'expired'))
                encoded = base64.b64encode(png).decode('ascii')
                if not text(encoded, FRAME_DATA_UNITS, 0):
                    return finish(receipt(c, 'unsupported'))
                o = copy.deepcopy(s['observation'])
                b = o['bounds']
                o['frame'] = dict(id=uid(), mimeType='image/png', data=encoded,
                                  width=b['width'], height=b['height'], bounds=b, displayLayoutVersion=o['displayLayoutVersion'])
                return finish(receipt(c, 'ok', 'executed', o))
            # Eligibility checks below are pure local dictionary/digest checks.
            # Do not scan the whole tree here AND again before act. Header
            # checks preserve early scope/age/context denials; the sole full
            # semantic scan remains at the final blocking-read barrier.
            w, s = self._fresh_header(c)
            if self.approved != fingerprint:
                return finish(receipt(c, 'approval_required'))
            self.approved = None
            ref = s['refs'].get(a['ref'])
            if not ref or ref[1]['sensitive'] or kind not in ref[1]['actions']:
                return finish(receipt(c, 'denied'))
            # Last full barrier after eligibility checks, immediately followed
            # by authorization and native act's post-lookup setter guard.
            w, validated = self.fresh(c)
            if validated is not s or validated['refs'].get(a['ref']) is not ref:
                raise ValueError('snapshot/ref changed during final validation')
            if self.authorized(c, p['leaseId']):
                return finish(receipt(c, 'expired'))
            self.snapshot = None
            dispatched = True
            if not self.backend.act(kind, ref, a, self.safety.check):
                return finish(receipt(c, 'helper_error', 'execution_unknown'))
            # A successful method reply is not proof of task progress. Supply fresh
            # state; orchestration must verify its own exact postcondition.
            o = self.observe(c, w) if not self.authorized(c, p['leaseId']) else None
            return finish(receipt(c, 'ok', 'executed', o))
        except Exception:
            return finish(receipt(c, 'helper_error' if dispatched else 'stale_observation', 'execution_unknown' if dispatched else 'not_executed'))

    def request(self, method, payload):
        if self.safety:
            self.safety.check()
        if method == 'capabilities' and payload == {}:
            result = self.capabilities()
        elif method == 'listTargets' and payload == {}:
            result = self.backend.discover() if self.capabilities()['axRead'] and not self.grant else []
        else:
            methods = {'start': self.start, 'beginApproval': self.begin_approval,
                       'endApproval': self.end_approval, 'execute': self.execute}
            if method not in methods:
                raise ValueError('unknown method')
            result = methods[method](payload)
        if self.safety:
            self.safety.check()  # never return a read/frame after revocation
        return result


def write_private_response(stream, request, result, diagnostics):
    """Advertise optional timing support in the PRIVATE capabilities envelope.

    Never add it to public capabilities/grants. Legacy clients ignore this
    scalar; opt-in remains per request. No unsolicited frames or stdout logs.
    All non-capabilities responses keep the existing writer and frame budget.
    """
    if request['method'] != 'capabilities':
        return write_response(stream, request['id'], result, diagnostics)
    if not text(request['id']):
        raise ValueError('invalid response identity')
    envelope = dict(id=request['id'], ok=True, result=result, diagnosticsVersion=1)
    if diagnostics is not None:
        envelope['diagnostics'] = diagnostics
    body = json.dumps(envelope, separators=(',', ':'), allow_nan=False).encode()
    if len(body) > MAX_BYTES and diagnostics is not None:
        del envelope['diagnostics']
        body = json.dumps(envelope, separators=(',', ':'), allow_nan=False).encode()
    if len(body) > MAX_BYTES:
        # Optional negotiation must not overflow an otherwise valid response.
        # The client conservatively sees absent/changed support, not a new task
        # failure. Fixed production capabilities are far below this limit.
        return write_response(stream, request['id'], result)
    stream.write(struct.pack('!I', len(body)) + body)
    stream.flush()


def main():
    # No sockets, subprocesses, env-selected executables or executable action text.
    broker = Broker()
    try:
        while True:
            r = read_request(sys.stdin.buffer)
            if broker.safety:
                deadline = mono() + 3500
                c = r['payload'].get('command')
                if command(c):
                    deadline = min(deadline, mono() + max(0, c['deadlineAt'] - now()))
                broker.safety.request_deadline = deadline
            result, diagnostics = timed_request(broker, r)
            write_private_response(sys.stdout.buffer, r, result, diagnostics)
            if broker.safety:
                broker.safety.request_deadline = float('inf')
    except EOFError:
        return 0
    except BaseException:
        # Never emit AX data, typed payloads or exception messages to stderr.
        return 64


if __name__ == '__main__':
    sys.exit(main())
