// QUARANTINED synthetic-only legacy timing harness. Never a production driver.
// This second sequential callback loop is kept solely for recorder regression
// tests. It refuses live headers; its timings cannot establish local OS gates.
import { validateConsent } from './recorder.mjs';

/** @param {import('./synthetic-sequential-driver.d.ts').MainCallbacks} main */
export function createSyntheticSequentialDriver(main) {
  return Object.freeze({
    source: 'synthetic',
    stop: () => main.stopLocalExecutionGate(),
    async open(task, header, signal) {
      if (header.source !== 'synthetic') throw new Error('Synthetic harness only');
      // Test callbacks/attestations only. No claim of production integration.
      let session;
      try { session = await main.requireLocalFixtureSession(task, header, signal); }
      catch { throw new Error('Incomplete attended collection'); }
      let unsubscribe, closePromise;
      const unsubscribeNow = () => {
        const fn = unsubscribe; unsubscribe = undefined;
        try { fn?.(); } catch {}
      };
      const close = () => {
        if (!closePromise) {
          closePromise = Promise.resolve().then(() => session.closeAndDrain())
            .catch(() => { throw new Error('Incomplete attended collection'); })
            .finally(() => { unsubscribeNow(); signal?.removeEventListener('abort', abort); });
          closePromise.catch(() => {});
        }
        return closePromise;
      };
      const abort = () => {
        // Failure cleanup must unsubscribe even if closeAndDrain never settles.
        // Normal close retains safety callbacks until drain has completed.
        unsubscribeNow(); close().catch(() => {});
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) throw new Error();
        validateConsent(header, session.consent);
      } catch { abort(); throw new Error('Incomplete attended collection'); }
      return {
        consent: session.consent,
        // These callbacks read the fixture's independent oracle, NOT receipts,
        // model confidence, or the planner's notion of completion.
        oracle: {
          selection: ({ slot }) => session.oracleSelection(slot),
          task: () => session.oracleTask(),
        },
        async run(hooks, runSignal) {
          if (signal?.aborted || runSignal?.aborted || closePromise) throw new Error('Incomplete attended collection');
          unsubscribe = session.subscribeLocalSafety({ event: hooks.event, beginStop: hooks.beginStop });
          if (signal?.aborted || runSignal?.aborted) { abort(); throw new Error('Incomplete attended collection'); }
          for (let count = 0; ; count++) {
            if (runSignal?.aborted) throw new Error('Collection cancelled');
            const meta = await session.nextStep();
            if (meta === null) break;
            if (count >= 128) throw new Error('Fixture step bound exceeded');
            hooks.beginStep(meta);
            let end = hooks.beginSpan('observation');
            await session.observe(meta.slot, { event: hooks.event }, runSignal); end();
            end = hooks.beginSpan('decision');
            await session.decide(meta.slot, {
              beginAttempt: hooks.beginAttempt, decision: hooks.decision, event: hooks.event,
            }, runSignal); end();
            end = hooks.beginSpan('dispatch');
            // onDelivered must come from the local execution gate, not an API
            // receipt. Approval, scope/freshness and Stop remain broker-owned.
            await session.dispatch(meta.slot, hooks.delivered, runSignal); end();
            end = hooks.beginSpan('verification');
            await session.verifyFreshFixtureState(meta.slot, runSignal); end();
            await hooks.endStep();
          }
        },
        attest: () => session.settleAllAttemptsAndActions(),
        close,
      };
    },
  });
}
