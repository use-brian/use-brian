// Passive host attachment to the ONE existing API-owned production run.
// No planner, command executor, grants, approvals, helper spawn or second task.
import { randomUUID } from 'node:crypto';
import { isPromise } from 'node:util/types';
import { NativeTraceBindingSchema, sourceUuidSchema, PassiveObserverHealthSchema } from './source-contract.mjs';
import { createSourceIngestor } from './source-ingestor.mjs';
import { createBrokerIngestor } from './broker-ingestor.mjs';
import { createHelperTimingIngestor, parseHelperCallback, helperLimits } from './helper-ingestor.mjs';
const failure = () => new Error('Passive source observation incomplete');
const validBinding = b => b && typeof b === 'object' && Reflect.ownKeys(b).length === 2 && Object.hasOwn(b, 'sessionId') && Object.hasOwn(b, 'epoch') && sourceUuidSchema.safeParse(b.sessionId).success && Number.isSafeInteger(b.epoch) && b.epoch >= 0;

/** @param {import('./main-driver.d.ts').PassiveOptions} options */
export function createPassiveObserverAdapter({ binding, stopLocalExecutionGate }) {
  if (!validBinding(binding) || typeof stopLocalExecutionGate !== 'function') throw failure();
  binding = Object.freeze({ sessionId: binding.sessionId, epoch: binding.epoch });
  const ingestor = createSourceIngestor(), helper = createHelperTimingIngestor({ binding }), broker = createBrokerIngestor({ binding });
  let factoryUsed = false, brokerFactoryUsed = false, stopped = false, ended = false;
  let directChannel, unscopedHelperEvents = 0, unscopedHelperDroppedBefore = 0, unscopedHelperDropsSaturated = false;
  const healthSources = new Map();
  const subscriptions = new Set(), attachments = new Set(), listeners = new Set(), detaching = new WeakMap();
  const invalidate = reason => { ingestor.invalidate(reason); helper.invalidate(reason); return broker.invalidate(reason); };
  const detachOne = value => {
    if (!value || typeof value !== 'object') return Promise.resolve();
    if (!detaching.has(value)) {
      const p = Promise.resolve().then(() => value.detach()).catch(() => { invalidate('observer-failed'); });
      detaching.set(value, p);
    }
    return detaching.get(value);
  };
  const detach = () => {
    ended = true; invalidate('detached'); ingestor.endInput(); helper.endInput(); broker.endInput();
    for (const remove of listeners) remove(); listeners.clear();
    for (const subscription of subscriptions) void detachOne(subscription);
    // Observer detach is NOT provider/helper drain.
  };
  const stop = () => {
    if (!stopped) {
      stopped = true;
      try { Promise.resolve(stopLocalExecutionGate()).catch(() => { invalidate('observer-failed'); }); }
      catch { invalidate('observer-failed'); }
    }
    invalidate('cancelled'); detach();
  };
  const observerFactory = candidate => {
    // This can be installed as the GLOBAL API factory. Returning undefined is
    // essential: even a noop callback would create a trace for another session.
    try {
      if (!validBinding(candidate)) { ingestor.invalidate('invalid-metadata'); return undefined; }
      if (candidate.sessionId !== binding.sessionId || candidate.epoch !== binding.epoch) return undefined;
      if (ended || factoryUsed) { ingestor.invalidate('correlation-conflict'); return undefined; }
      factoryUsed = true;
      return event => {
        if (ingestor.ingest(event)) {
          if (ingestor.streamCount() > 1) ingestor.invalidate('correlation-conflict');
          else { helper.ingestCore(event); broker.ingestCore(event); }
        }
      };
    } catch { ingestor.invalidate('invalid-metadata'); return undefined; }
  };
  const helperObserverFactory = channelId => {
    // A channel is a trusted main-owned registration identity for ONE helper
    // client instance, not an ID taken from returned helper diagnostics.
    if (!helper.openChannel(channelId)) return undefined;
    return Object.freeze({ enabled: true, onMetadata(event) { helper.ingest(channelId, event); broker.ingestHelper(channelId, event); } });
  };
  const brokerObserverFactory = candidate => {
    // Unlike the API factory, the actual desktop factory requires a function;
    // the trace already exists before this callback. Unrelated scopes get a
    // noop, never the prepared binding's sink or a mutable current-epoch retag.
    try {
      const parsed = NativeTraceBindingSchema.safeParse(candidate);
      if (!parsed.success) { broker.invalidate('invalid-metadata'); return () => {}; }
      if (candidate.sessionId !== binding.sessionId || candidate.epoch !== binding.epoch) return () => {};
      if (ended || brokerFactoryUsed) { broker.invalidate('correlation-conflict'); return () => {}; }
      brokerFactoryUsed = true;
      return event => { broker.ingest(event); };
    } catch { broker.invalidate('invalid-metadata'); return () => {}; }
  };
  const helperTimingObserver = input => {
    // Compatible with NativeIntegrationOptions.helperTimingObserver. Filter by
    // ORIGINAL correlation, never by the integration's current auth/session.
    try {
      const e = parseHelperCallback(input);
      if (e.correlation && (e.correlation.sessionId !== binding.sessionId || e.correlation.epoch !== binding.epoch)) return;
      if (ended) { helper.invalidate('late-event'); return; }
      if (!e.correlation) {
        unscopedHelperEvents = Math.min(helperLimits.events + 1, unscopedHelperEvents + 1);
        if (unscopedHelperEvents > helperLimits.events) { helper.invalidate('overflow'); return; }
        unscopedHelperDroppedBefore += e.droppedBefore;
        unscopedHelperDropsSaturated ||= e.droppedBefore === 65535;
        if (e.droppedBefore) helper.invalidate('helper-events-dropped');
        if (e.state === 'incomplete' && e.reason === 'invalid') helper.invalidate('helper-invalid');
        // No binding exists for capabilities/discovery callbacks. Count only;
        // don't pin a prepared session to an arbitrary global helper instance.
        return;
      }
      if (!directChannel) {
        directChannel = randomUUID();
        if (!helper.openChannel(directChannel)) return;
      }
      helper.ingest(directChannel, e); broker.ingestHelper(directChannel, e);
    } catch { helper.invalidate('invalid-metadata'); }
  };
  async function attach(kind, host, signal) {
    const directHelper = kind === 'helper' && typeof host?.attachHelperTimingObserver === 'function';
    const method = kind === 'api' ? 'attachObserver' : kind === 'broker' ? 'attachBrokerObserver' : directHelper ? 'attachHelperTimingObserver' : 'attachHelperObserver';
    if (attachments.has(kind) || ended || !host || typeof host[method] !== 'function') throw failure();
    attachments.add(kind);
    if (signal?.aborted) { stop(); throw failure(); }
    let abort;
    const remove = () => { signal?.removeEventListener('abort', abort); listeners.delete(remove); };
    const aborted = new Promise((_, reject) => { abort = () => { stop(); reject(failure()); }; signal?.addEventListener('abort', abort, { once: true }); });
    listeners.add(remove);
    const pending = Promise.resolve().then(() => {
      if (ended || signal?.aborted) throw failure();
      const callback = kind === 'api' ? observerFactory : kind === 'broker' ? brokerObserverFactory : directHelper ? helperTimingObserver : helperObserverFactory;
      return host[method](binding, callback, signal);
    }).then(value => {
      if (ended || signal?.aborted) { void detachOne(value); throw failure(); }
      if (!value || typeof value.detach !== 'function') throw failure();
      subscriptions.add(value); healthSources.set(kind, { attachment: value, reason: null }); return value;
    });
    try { await Promise.race([pending, aborted]); }
    catch { invalidate('observer-failed'); detach(); remove(); throw failure(); }
  }
  return Object.freeze({
    observerFactory,
    helperObserverFactory,
    brokerObserverFactory,
    helperTimingObserver,
    attach: (host, signal) => attach('api', host, signal),
    attachHelper: (host, signal) => attach('helper', host, signal),
    attachBroker: (host, signal) => attach('broker', host, signal),
    detach,
    stop,
    // Explicit safety invalidation never fabricates a native outcome.
    invalidate,
    diagnostics() {
      // Only diagnostics calls the trusted synchronous health port. Stop and
      // detach never consult it. Keep fixed failures sticky across later reads.
      const attachmentHealth = [], healthReasons = [];
      for (const [kind, source] of healthSources) {
        let health = null;
        try {
          const descriptor = Object.getOwnPropertyDescriptor(source.attachment, 'health');
          if (!descriptor && 'health' in source.attachment) throw failure();
          if (descriptor) {
            if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw failure();
            const value = descriptor.value.call(source.attachment);
            if (isPromise(value)) {
              // The contract is synchronous. Consume accidental async rejection
              // without waiting, invoking a thenable getter, or accepting it.
              void Promise.prototype.then.call(value, undefined, () => {});
              throw failure();
            }
            const parsed = PassiveObserverHealthSchema.safeParse(value);
            if (!parsed.success) throw failure();
            health = parsed.data;
            source.reason ??= health.reason;
          }
        } catch { source.reason ??= 'invalid_metadata'; }
        attachmentHealth.push(Object.freeze({ kind, state: 'incomplete', status: health ? 'observed' : 'unknown', reason: source.reason, drain: 'not_observed' }));
        if (source.reason) healthReasons.push(`attachment:${kind}:${source.reason}`);
      }
      const core = ingestor.diagnostics(), timing = helper.diagnostics(), desktop = broker.diagnostics();
      return Object.freeze({ ...core, state: healthReasons.length || [core, timing, desktop].some(d => d.state === 'poisoned') ? 'poisoned' : 'incomplete',
        poisonReasons: Object.freeze([...healthReasons, ...core.poisonReasons, ...timing.poisonReasons.map(r => `helper:${r}`), ...desktop.poisonReasons.map(r => `broker:${r}`)]),
        attachmentHealth: Object.freeze(attachmentHealth), helperTiming: timing, broker: desktop, unscopedHelperEvents, unscopedHelperDroppedBefore, unscopedHelperDropsSaturated,
        missingSources: Object.freeze([...core.missingSources.filter(s => s !== 'local-stop-gate'), 'physical-activation-to-local-stop-gate', ...(!desktop.localGate ? ['broker-method-to-local-gate'] : [])]) });
    },
    assertPublishable: ingestor.assertPublishable,
  });
}
