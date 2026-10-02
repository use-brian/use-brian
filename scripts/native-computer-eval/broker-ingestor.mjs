import { createHash } from 'node:crypto';
import { NativeBrokerTraceEventSchema, NativeTraceBindingSchema, NativeTraceEventSchema, sourceUuidSchema, brokerContractDigest } from './source-contract.mjs';
import { boundedMetadataCopy } from './metadata-boundary.mjs';
import { parseHelperCallback } from './helper-ingestor.mjs';
export const brokerLimits = Object.freeze({ events: 2048, commands: 2048, helpers: 2048, unmatched: 128, pending: 128, eventBytes: 8192, totalBytes: 8 * 1024 * 1024 });
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const hash = x => createHash('sha256').update(x).digest('hex');
const reasons = new Set(['invalid-metadata', 'scope-conflict', 'source-clock', 'missing-sequence', 'duplicate-or-out-of-order', 'lifecycle-conflict', 'correlation-conflict', 'overflow', 'broker-loss', 'helper-events-dropped', 'helper-invalid', 'late-event', 'safety-defect', 'cancelled', 'detached', 'observer-failed']);

/** Canonical broker metadata + bounded identity joins only. No executor, local
 * AX success, physical Stop timer, OS delivery assertion or fixture drain. */
export function createBrokerIngestor({ binding }) {
  try { binding = Object.freeze(NativeTraceBindingSchema.parse(binding)); }
  catch { throw new Error('Broker source observation incomplete'); }
  const rows = [], commands = new Map(), helpers = new Set(), faults = new Set();
  const waits = new Map(), rpcPending = new Map();
  let sourceId, clockId, sequence = 0, elapsed = 0, bytes = 0, unmatched = 0, closed = false, loss = false;
  let stopEntry = null, gate = null, lifetime = { outcome: 'not_observed', scope: 'helper-lifetime-only', durationMs: null };
  const poison = reason => { faults.add(reasons.has(reason) ? reason : 'invalid-metadata'); return false; };
  const conflict = reason => { poison(reason); throw new Error('Broker source observation incomplete'); };
  function join(commandId, origin, value) {
    const old = commands.get(commandId);
    if (!old && commands.size >= brokerLimits.commands) return poison('overflow');
    const row = old ? { ...old, helpers: [...old.helpers] } : { sessionId: binding.sessionId, epoch: binding.epoch, commandId, actionKind: null, core: null, broker: null, helpers: [] };
    if (origin !== 'helper') {
      if (row.actionKind && row.actionKind !== value.actionKind) return poison('correlation-conflict');
      row.actionKind = value.actionKind;
    }
    if (origin === 'core') {
      if (row.core) return poison('correlation-conflict');
      row.core = value;
    } else if (origin === 'broker') {
      // Replays/admission/check/approval events legitimately share a command.
      row.broker = row.broker ?? value;
    } else row.helpers.push(value);
    const present = r => Boolean(r?.core && r?.broker && r.helpers.length);
    const count = unmatched + Number(!present(row)) - Number(Boolean(old) && !present(old));
    if (count > brokerLimits.unmatched) return poison('overflow');
    unmatched = count; commands.set(commandId, row); return true;
  }
  function lifecycle(e) {
    const key = `${e.event}/${e.operation ?? '-'}/${e.command?.commandId ?? '-'}`;
    if (e.event === 'stop_requested') {
      if (stopEntry || e.outcome !== 'started') conflict('lifecycle-conflict');
      stopEntry = { elapsedMs: e.elapsedMs, sequence: e.sequence };
    } else if (e.event === 'local_gate_revoked') {
      if (!stopEntry || gate || e.outcome !== 'revoked' || e.durationMs === undefined) conflict('lifecycle-conflict');
      gate = { elapsedMs: e.elapsedMs, methodEntryToLocalGateMs: e.durationMs, physicalActivationToGateMs: null, nativeOsStopMs: null };
    } else if (e.event === 'helper_lifetime_barrier') {
      if (e.operation !== 'kill') conflict('lifecycle-conflict');
      if (e.outcome === 'started') {
        if (!gate || lifetime.outcome !== 'not_observed') conflict('lifecycle-conflict');
        lifetime = { outcome: 'pending', scope: 'helper-lifetime-only', startedElapsedMs: e.elapsedMs, durationMs: null };
      } else {
        if (lifetime.outcome !== 'pending' || !['resolved', 'failed'].includes(e.outcome) || e.durationMs === undefined) conflict('lifecycle-conflict');
        lifetime = { ...lifetime, outcome: e.outcome, durationMs: e.durationMs };
      }
    } else if (e.event === 'helper_rpc_settlement') {
      const rpcKey = `${e.operation ?? '-'}/${e.command?.commandId ?? '-'}`;
      if (!rpcPending.has(rpcKey) || !['resolved', 'failed', 'late_resolved', 'late_failed'].includes(e.outcome) || e.durationMs === undefined) conflict('lifecycle-conflict');
      rpcPending.delete(rpcKey);
    } else if (['helper_rpc_wait', 'approval_wait'].includes(e.event) || (e.event === 'authority_check' && e.operation === 'remote')) {
      if (e.outcome === 'started') {
        if (waits.has(key) || waits.size >= brokerLimits.pending) conflict('lifecycle-conflict');
        waits.set(key, e.sequence);
        if (e.event === 'helper_rpc_wait') {
          const rpcKey = `${e.operation ?? '-'}/${e.command?.commandId ?? '-'}`;
          if (rpcPending.has(rpcKey) || rpcPending.size >= brokerLimits.pending) conflict('lifecycle-conflict');
          rpcPending.set(rpcKey, e.sequence);
        }
      } else {
        if (!waits.has(key) || !['resolved', 'denied', 'failed', 'cancelled'].includes(e.outcome) || e.durationMs === undefined) conflict('lifecycle-conflict');
        waits.delete(key); // Logical wait ending does not settle the helper RPC.
      }
    }
  }
  return Object.freeze({
    ingest(input) {
      if (closed) return poison('late-event'); if (faults.size) return false;
      try {
        const e = NativeBrokerTraceEventSchema.parse(boundedMetadataCopy(input));
        if (e.sessionId !== binding.sessionId || e.epoch !== binding.epoch) return poison('scope-conflict');
        const size = Buffer.byteLength(JSON.stringify(e));
        if (rows.length >= brokerLimits.events || size > brokerLimits.eventBytes || bytes + size > brokerLimits.totalBytes) return poison('overflow');
        if (sourceId && (sourceId !== e.sourceId || clockId !== e.clockId)) return poison('source-clock');
        if (e.sequence !== sequence + 1) return poison(e.sequence > sequence + 1 ? 'missing-sequence' : 'duplicate-or-out-of-order');
        if (e.elapsedMs < elapsed || (e.durationMs !== undefined && e.durationMs > e.elapsedMs)) return poison('source-clock');
        sourceId = e.sourceId; clockId = e.clockId; sequence = e.sequence; elapsed = e.elapsedMs; bytes += size; rows.push(e);
        // The source has NO exported drop count. Flag/marker disclose loss even
        // when queued events have contiguous sequences; never invent zero loss.
        if (e.incomplete || e.event === 'trace_incomplete') { loss = true; return poison('broker-loss'); }
        if (e.command && !join(e.command.commandId, 'broker', { sourceId, clockId, firstSequence: sequence, actionKind: e.command.actionKind })) return false;
        lifecycle(e); return true;
      } catch { if (!faults.size) poison('invalid-metadata'); return false; }
    },
    ingestCore(input) {
      if (closed) return poison('late-event'); if (faults.size) return false;
      try {
        const e = NativeTraceEventSchema.parse(boundedMetadataCopy(input));
        if (e.evidence !== 'valid') return poison('invalid-metadata');
        if (e.kind !== 'span-start' || e.scope !== 'rpc') return true;
        return join(e.commandId, 'core', { runId: e.runId, clockId: e.clockId, spanId: e.spanId, actionKind: e.actionKind, phase: e.phase });
      } catch { return poison('invalid-metadata'); }
    },
    ingestHelper(channelId, input) {
      if (closed) return poison('late-event'); if (faults.size) return false;
      try {
        if (!sourceUuidSchema.safeParse(channelId).success) return poison('invalid-metadata');
        const e = parseHelperCallback(input);
        if (e.correlation && (e.correlation.sessionId !== binding.sessionId || e.correlation.epoch !== binding.epoch)) return poison('scope-conflict');
        const key = `${channelId}/${e.requestId}`;
        if (helpers.has(key)) return poison('duplicate-or-out-of-order');
        if (helpers.size >= brokerLimits.helpers) return poison('overflow');
        helpers.add(key);
        if (e.correlation?.commandId && !join(e.correlation.commandId, 'helper', {
          channelId, requestIdDigest: hash(e.requestId), method: e.method, state: e.state,
          instanceId: e.state === 'complete' ? e.timing.instanceId : null,
          clockId: e.state === 'complete' ? e.timing.clockId : null,
        })) return false;
        if (e.droppedBefore) return poison('helper-events-dropped');
        if (e.state === 'incomplete' && e.reason === 'invalid') return poison('helper-invalid');
        return true;
      } catch { return poison('invalid-metadata'); }
    },
    invalidate: poison,
    endInput() { closed = true; },
    diagnostics() {
      return freeze(structuredClone({
        type: 'broker-source-diagnostics', version: 1, brokerContractDigest, binding,
        state: faults.size ? 'poisoned' : 'incomplete', poisonReasons: [...faults], inputClosed: closed,
        sourceId: sourceId ?? null, clockId: clockId ?? null, events: rows.length, bytes, lastSequence: sequence,
        brokerLossObserved: loss, droppedEvents: null, rows,
        commands: [...commands.values()].map(r => ({ ...r, join: r.core && r.broker && r.helpers.length ? 'matched-identities' : 'pending-identities', osDelivery: null, nonDispatch: null, targetMutation: null })),
        unmatchedCommands: unmatched, pendingLogicalWaits: waits.size, pendingHelperRpcSettlements: rpcPending.size,
        stopEntry, localGate: gate, helperLifetimeBarrier: lifetime,
        leaseReleaseObserved: null, fixtureDrain: 'not_observed', drain: 'not_observed', fixtureSuccess: null,
        axSuccess: null, warmAxGateEvidence: 'unavailable', publicationAllowed: false, routingProfileApproval: false, releaseStatus: 'pending',
        incompleteReasons: [
          ...(!rows.length ? ['broker-source-not-observed'] : []),
          ...(unmatched ? ['unmatched-command-evidence'] : []),
          ...(waits.size || rpcPending.size ? ['pending-broker-or-helper-waits'] : []),
          ...(lifetime.outcome !== 'resolved' ? ['helper-lifetime-unresolved'] : []),
          'source-settlement-is-not-ax-success-or-os-delivery', 'fixture-oracle-and-final-completeness-unavailable',
        ],
      }));
    },
    assertPublishable() { throw new Error('Live broker evidence incomplete; publication refused'); },
  });
}
