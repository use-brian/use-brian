import { createHash } from 'node:crypto';
import { HelperTimingEventSchema, NativeTraceEventSchema, sourceUuidSchema, helperContractDigest } from './source-contract.mjs';
import { boundedMetadataCopy } from './metadata-boundary.mjs';

export const helperLimits = Object.freeze({ channels: 16, events: 2048, commands: 2048, unmatched: 128, eventBytes: 8192, totalBytes: 8 * 1024 * 1024 });
const hash = s => createHash('sha256').update(s).digest('hex');
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const exact = (x, required, optional = []) => x && typeof x === 'object' && !Array.isArray(x) && required.every(k => Object.hasOwn(x, k)) && Reflect.ownKeys(x).every(k => [...required, ...optional].includes(k));
const bindingValid = b => exact(b, ['sessionId', 'epoch']) && sourceUuidSchema.safeParse(b.sessionId).success && Number.isSafeInteger(b.epoch) && b.epoch >= 0;
const apiPhases = { setValue: 'api_set_value', invoke: 'api_invoke', select: 'api_select', scroll: 'api_scroll' };
const allowedFaults = new Set(['invalid-metadata', 'overflow', 'correlation-conflict', 'duplicate-request', 'source-clock', 'source-phase', 'helper-events-dropped', 'helper-invalid', 'late-event', 'detached', 'cancelled', 'observer-failed', 'safety-defect']);

// Keep the descriptor-safe bounded copy ahead of canonical runtime validation.
export function parseHelperCallback(input) {
  return HelperTimingEventSchema.parse(boundedMetadataCopy(input));
}

/** Passive per-prepared-binding helper channel. API and helper clocks NEVER
 * share arithmetic. Joining waits for original command IDs, not arrival order.
 * All diagnostics remain incomplete/poisoned and cannot publish live evidence. */
export function createHelperTimingIngestor({ binding }) {
  if (!bindingValid(binding)) throw new Error('Helper source observation incomplete');
  binding = Object.freeze({ ...binding });
  const channels = new Map(), instances = new Map(), commands = new Map(), requests = new Map();
  const waitingHelpers = new Map(), waitingApi = new Set(), faults = new Set(), terminals = new Set();
  let unmatchedHelpers = 0, events = 0, bytes = 0, dropped = 0, droppedSaturated = false, closed = false;
  const incomplete = { absent: 0, invalid: 0, lost_response: 0 };
  const poison = reason => { faults.add(allowedFaults.has(reason) ? reason : 'invalid-metadata'); return false; };
  function join(row, core) {
    if (row.correlation.commandId !== core.commandId) return poison('correlation-conflict');
    if (row.state === 'complete' && row.method === 'execute') {
      const spans = row.timing.spans;
      const expected = core.actionKind === 'observe' ? 'observe_request' : core.actionKind === 'capture' ? 'capture_request' : 'request';
      if (spans[0].phase !== expected || (spans[1] && spans[1].phase !== apiPhases[core.actionKind])) return poison('source-phase');
      row.expectedApiPhase = apiPhases[core.actionKind] ?? null;
    }
    row.core = core;
    if (row.method === 'execute') waitingApi.delete(core.commandId);
    return true;
  }
  function ingest(channelId, input) {
    if (closed) return poison('late-event');
    if (faults.size) return false;
    try {
      const channel = channels.get(channelId); if (!channel) return poison('correlation-conflict');
      const e = parseHelperCallback(input), size = Buffer.byteLength(JSON.stringify(e));
      if (events >= helperLimits.events || size > helperLimits.eventBytes || bytes + size > helperLimits.totalBytes) return poison('overflow');
      if (e.correlation && (e.correlation.sessionId !== binding.sessionId || e.correlation.epoch !== binding.epoch)) return poison('correlation-conflict');
      const key = `${channelId}/${e.requestId}`;
      if (requests.has(key)) return poison('duplicate-request');
      if (e.state === 'complete') {
        const t = e.timing, previous = channel.clock;
        if ((previous && (previous.instanceId !== t.instanceId || previous.clockId !== t.clockId || t.spans[0].startUs < previous.endUs)) ||
            (instances.has(t.instanceId) && instances.get(t.instanceId) !== channelId)) return poison('source-clock');
        channel.clock = { instanceId: t.instanceId, clockId: t.clockId, endUs: t.spans[0].endUs }; instances.set(t.instanceId, channelId);
      }
      const command = e.correlation?.commandId;
      if (command && !commands.has(command) && unmatchedHelpers >= helperLimits.unmatched) return poison('overflow');
      events++; bytes += size; dropped += e.droppedBefore; droppedSaturated ||= e.droppedBefore === 65535;
      if (e.state === 'incomplete') incomplete[e.reason]++;
      const row = { ...e, correlation: e.correlation ?? null, channelId, core: null, expectedApiPhase: null };
      requests.set(key, row);
      if (command) {
        if (commands.has(command)) { if (!join(row, commands.get(command))) return false; }
        else {
          if (!waitingHelpers.has(command)) waitingHelpers.set(command, []);
          waitingHelpers.get(command).push(row); unmatchedHelpers++;
        }
      }
      // Retain the metadata/loss counts before poisoning, including loss first
      // reported AFTER logical terminal. No zero-loss inference from silence.
      if (e.droppedBefore) return poison('helper-events-dropped');
      if (e.state === 'incomplete' && e.reason === 'invalid') return poison('helper-invalid');
      return true;
    } catch { return poison('invalid-metadata'); }
  }
  return Object.freeze({
    openChannel(channelId) {
      if (closed) return poison('late-event');
      if (faults.size) return false;
      if (!sourceUuidSchema.safeParse(channelId).success || channels.has(channelId)) return poison('correlation-conflict');
      if (channels.size >= helperLimits.channels) return poison('overflow');
      channels.set(channelId, { clock: null }); return true;
    },
    ingest,
    // Called only after core source ingestion succeeds; this canonical parse
    // also protects direct use, but does not replace core sequence validation.
    ingestCore(input) {
      if (closed) return poison('late-event');
      if (faults.size) return false;
      try {
        const e = NativeTraceEventSchema.parse(boundedMetadataCopy(input));
        if (e.evidence !== 'valid') return poison('invalid-metadata');
        if (e.kind === 'run-terminal') { if (terminals.size >= 16) return poison('overflow'); terminals.add(e.runId); }
        if (e.kind !== 'span-start' || e.scope !== 'rpc') return true;
        if (commands.has(e.commandId)) return poison('correlation-conflict');
        if (commands.size >= helperLimits.commands) return poison('overflow');
        const pending = waitingHelpers.get(e.commandId) ?? [];
        if (!pending.some(row => row.method === 'execute') && waitingApi.size >= helperLimits.unmatched) return poison('overflow');
        const core = Object.freeze({ sessionId: binding.sessionId, epoch: binding.epoch, commandId: e.commandId, runId: e.runId, clockId: e.clockId, spanId: e.spanId, actionKind: e.actionKind, phase: e.phase });
        for (const row of pending) if (!join(row, core)) return false;
        commands.set(e.commandId, core);
        if (!pending.some(row => row.method === 'execute')) waitingApi.add(e.commandId);
        unmatchedHelpers -= pending.length; waitingHelpers.delete(e.commandId);
        return true;
      } catch { return poison('invalid-metadata'); }
    },
    invalidate: poison,
    endInput() { closed = true; },
    assertPublishable() { throw new Error('Live helper evidence incomplete; publication refused'); },
    diagnostics() {
      const rows = [...requests.values()].map(row => ({
        channelId: row.channelId, requestIdDigest: hash(row.requestId), method: row.method,
        correlation: row.correlation, state: row.state, droppedBefore: row.droppedBefore,
        reason: row.state === 'incomplete' ? row.reason : null,
        source: row.state === 'complete' ? { instanceId: row.timing.instanceId, clockId: row.timing.clockId, unit: 'microseconds', spans: row.timing.spans } : null,
        core: row.core, expectedApiPhase: row.expectedApiPhase,
        apiSpanObserved: row.state === 'complete' && row.timing.spans.length === 2,
        nonDispatch: null, osDelivery: null, targetMutation: null, drain: 'not_observed',
      }));
      return freeze(structuredClone({
        type: 'helper-source-diagnostics', version: 1, helperContractDigest,
        state: faults.size ? 'poisoned' : 'incomplete', poisonReasons: [...faults], inputClosed: closed,
        events, bytes, channels: channels.size, droppedBeforeTotal: dropped, droppedBeforeSaturated: droppedSaturated, incomplete,
        unmatchedHelperRequests: unmatchedHelpers, unmatchedApiCommands: waitingApi.size,
        uncorrelatedRequests: rows.filter(r => !r.correlation?.commandId).length,
        missingApiSpans: rows.filter(r => r.expectedApiPhase && !r.apiSpanObserved).length,
        apiLogicalTerminals: terminals.size, rows,
        publicationAllowed: false, routingProfileApproval: false, releaseStatus: 'pending',
        drain: 'not_observed', fixtureSuccess: null, axSuccess: null, warmAxGateEvidence: 'unavailable',
        incompleteReasons: [
          ...(!events ? ['helper-timing-not-observed'] : []),
          ...(unmatchedHelpers || waitingApi.size ? ['unmatched-command-evidence'] : []),
          ...(incomplete.absent ? ['helper-timing-absent'] : []),
          ...(incomplete.lost_response ? ['helper-response-lost'] : []),
          ...(rows.some(r => r.expectedApiPhase && !r.apiSpanObserved) ? ['helper-api-span-not-observed'] : []),
          'timings-are-not-dispatch-mutation-or-drain-proof', 'oracle-and-completeness-evidence-unavailable',
        ],
      }));
    },
  });
}
