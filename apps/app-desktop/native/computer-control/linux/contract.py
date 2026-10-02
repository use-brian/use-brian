"""Private pipe schema subset, deliberately independent of GI and OS APIs."""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import math
import struct
import time
import uuid

PROTOCOL = 'native-computer-v1'
MAX_BYTES = 4 * 1024 * 1024
# Zod/JavaScript string maxima count UTF-16 code units, not Python code points.
ID_UNITS = 256
AX_TEXT_UNITS = 4096
ROLE_UNITS = 100
REQUESTER_UNITS = 200
GOAL_UNITS = 2000
LIMITATION_UNITS = 300
FRAME_DATA_UNITS = 3 * 1024 * 1024
METHODS = frozenset(('capabilities', 'listTargets', 'start', 'beginApproval', 'endApproval', 'execute'))
IDENTITY = 'deploymentId userId workspaceId deviceId sessionId conversationId taskId'.split()
TARGET = 'appId processId processInstanceId windowId windowInstanceId'.split()
ACTIONS = {
    'observe': '', 'capture': 'observationId', 'focus': 'observationId',
    'invoke': 'observationId ref', 'setValue': 'observationId ref text',
    'select': 'observationId ref', 'scroll': 'observationId ref deltaY',
    'click': 'observationId frameId x y', 'key': 'observationId key',
}


def uid():
    return str(uuid.uuid4())


def now():
    return int(time.time() * 1000)


def mono():
    # Includes suspend: sleep cannot extend a lease.
    return time.clock_gettime(time.CLOCK_BOOTTIME) * 1000


def keys(value, names):
    return isinstance(value, dict) and set(value) == set(names.split() if isinstance(names, str) else names)


def utf16_units(value):
    """JS string length for well-formed Unicode; never logs the supplied text."""
    return len(value.encode('utf-16-le')) // 2


def utf16_prefix(value, maximum):
    """Bound a wire string without splitting a non-BMP scalar or normalizing it.

    Malformed OS text is replaced. Callers must mark any changed/clipped string
    partial; this function does not authorize effects from a truncated prefix.
    Combining marks are preserved, not normalized or counted as one grapheme.
    """
    return value.encode('utf-16-le', errors='replace')[:maximum * 2].decode('utf-16-le', errors='ignore')


def text(value, maximum=ID_UNITS, minimum=1):
    if not isinstance(value, str):
        return False
    try:
        return minimum <= utf16_units(value) <= maximum
    except UnicodeEncodeError:
        # Zod can represent lone UTF-16 surrogates; native APIs cannot. Refuse
        # this stricter malformed-Unicode subset instead of throwing/logging it.
        return False


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 2**53 - 1


def identity(value):
    return keys(value, IDENTITY) and all(text(v) for v in value.values())


def target(value):
    return keys(value, TARGET) and integer(value['processId'], 1) and all(text(value[k]) for k in TARGET if k != 'processId')


def grant(g):
    return (keys(g, 'protocol identity grantId epoch expiresAt targets allowControl allowCapture requester goal')
            and g['protocol'] == PROTOCOL and identity(g['identity']) and text(g['grantId'])
            and integer(g['epoch'], 1) and integer(g['expiresAt'])
            and type(g['allowControl']) is bool and type(g['allowCapture']) is bool
            and text(g['requester'], REQUESTER_UNITS) and text(g['goal'], GOAL_UNITS)
            and isinstance(g['targets'], list) and 1 <= len(g['targets']) <= 8
            and all(target(t) for t in g['targets']))


def command(c):
    if not (keys(c, 'protocol identity grantId epoch commandId deadlineAt action')
            and c['protocol'] == PROTOCOL and identity(c['identity']) and text(c['grantId'])
            and integer(c['epoch']) and integer(c['deadlineAt']) and text(c['commandId'])):
        return False
    a = c['action']
    if not isinstance(a, dict) or a.get('kind') not in ACTIONS:
        return False
    if not keys(a, ['kind', 'target'] + ACTIONS[a['kind']].split()) or not target(a['target']):
        return False
    for field in ('observationId', 'ref', 'frameId'):
        if field in a and not text(a[field]):
            return False
    if a['kind'] == 'setValue' and (not text(a['text'], AX_TEXT_UNITS, 0) or '\0' in a['text']):
        return False
    if a['kind'] == 'scroll' and (type(a['deltaY']) is not int or not -600 <= a['deltaY'] <= 600):
        return False
    if a['kind'] == 'click' and not all(type(a[k]) in (int, float) and math.isfinite(a[k]) and 0 <= a[k] <= 32768 for k in ('x', 'y')):
        return False
    return a['kind'] != 'key' or a['key'] in ('Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Enter')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def receipt(c, code, outcome='not_executed', observation=None):
    command_id = c.get('commandId')
    r = dict(commandId=command_id if text(command_id) else 'invalid', code=code, outcome=outcome)
    if observation is not None:
        r['observation'] = observation
    return r


def exact(stream, count):
    result = bytearray()
    while len(result) < count:
        chunk = stream.read(count - len(result))
        if not chunk:
            if result:
                raise ValueError('truncated frame')
            raise EOFError
        result.extend(chunk)
    return bytes(result)


def unique(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError('duplicate key')
        result[k] = v
    return result


def read_request(stream):
    size, = struct.unpack('!I', exact(stream, 4))
    if not 0 < size <= MAX_BYTES:
        raise ValueError('invalid size')
    body = exact(stream, size)
    r = json.loads(body.decode('utf-8'), object_pairs_hook=unique,
                   parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
    if (not (keys(r, 'id method payload') or (keys(r, 'id method payload diagnostics') and r['diagnostics'] is True)) or not text(r['id']) or not isinstance(r['payload'], dict)
            or not isinstance(r['method'], str) or r['method'] not in METHODS):
        raise ValueError('invalid envelope')
    return r


def write_response(stream, request_id, result, diagnostics=None):
    if not text(request_id):
        raise ValueError('invalid response identity')
    envelope = dict(id=request_id, ok=True, result=result)
    if diagnostics is not None:
        envelope['diagnostics'] = diagnostics
    body = json.dumps(envelope, separators=(',', ':'), allow_nan=False).encode()
    if len(body) > MAX_BYTES and diagnostics is not None:
        # Optional evidence must not turn an otherwise valid command response
        # into transport loss. The client reports absent diagnostics instead.
        del envelope['diagnostics']
        body = json.dumps(envelope, separators=(',', ':'), allow_nan=False).encode()
    if len(body) > MAX_BYTES:
        raise ValueError('oversized response')
    stream.write(struct.pack('!I', len(body)) + body)
    stream.flush()


# Private diagnostics only. No wall time, payload content or delivery claims.
# Kept in this already-packaged module: no new runtime deployment dependency.
_timing_context = ContextVar('private_request_timing', default=None)
_timing_domain = None
_API_PHASES = {'setValue': 'api_set_value', 'invoke': 'api_invoke',
               'select': 'api_select', 'scroll': 'api_scroll'}


def _source_us():
    global _timing_domain
    if _timing_domain is None:
        _timing_domain = (uid(), uid(), time.monotonic_ns())
    return (time.monotonic_ns() - _timing_domain[2]) // 1000


def _completed_span(phase, start, status):
    end = _source_us()
    # Outside bounds means missing evidence, never an invented/clipped interval.
    if not 0 <= start <= end <= 2**53 - 1 or end - start > 900_000_000:
        return None
    return dict(phase=phase, startUs=start, endUs=end, durationUs=end-start, status=status)


@contextmanager
def native_api_timing(kind):
    """Only the actual semantic API invocation, not lookup/guard/post-observe.

    'returned' means Python API returned, even if its result reports refusal;
    'failed' means it raised. Neither establishes OS delivery/target mutation.
    Killed/hung calls cannot produce completed diagnostics.
    """
    spans = _timing_context.get()
    if spans is None:
        yield
        return
    start = _source_us()
    status = 'failed'
    try:
        yield
        status = 'returned'
    finally:
        span = _completed_span(_API_PHASES[kind], start, status)
        # Exactly one native action per request; overflow suppresses diagnostics.
        if len(spans) < 2:
            spans.append(span if not spans else None)


def timed_request(broker, request):
    """Full broker dispatch (guards, observation/capture, encoding PNG, post-read).

    Excludes framed JSON serialization/transport. Exceptions retain existing
    fail-closed pipe behavior: no fabricated response or terminal/drain event.
    """
    if request.get('diagnostics') is not True:
        return broker.request(request['method'], request['payload']), None
    spans = []
    token = _timing_context.set(spans)
    start = _source_us()
    try:
        result = broker.request(request['method'], request['payload'])
        phase = 'request'
        c = request['payload'].get('command')
        if request['method'] == 'execute' and command(c):
            phase = {'observe': 'observe_request', 'capture': 'capture_request'}.get(c['action']['kind'], 'request')
        outer = _completed_span(phase, start, 'returned')
        if outer is None or len(spans) > 1 or any(s is None for s in spans):
            return result, None
        return result, dict(version=1, instanceId=_timing_domain[0], clockId=_timing_domain[1],
                            requestId=request['id'], method=request['method'], spans=[outer, *spans])
    finally:
        _timing_context.reset(token)
