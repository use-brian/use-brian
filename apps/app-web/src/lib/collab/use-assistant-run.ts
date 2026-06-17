"use client";

/**
 * Live "an assistant is working on this page" state, read off the page's Yjs
 * awareness. `apps/doc-sync` publishes an `AssistantRunState` into the
 * document's awareness (under the service client's `assistantRun` field) for
 * the duration of a run — opened/heartbeated/closed by `apps/api`'s chat route
 * at the turn boundary, from ANY channel (a Telegram/Slack/web turn anchored to
 * the page, with no browser open, still lights this up). Absence of the field =
 * idle. See `docs/architecture/features/doc.md` → "Assistant run presence".
 *
 * Transport-agnostic by design: it reads the same awareness the human face-pile
 * (`usePresence`) rides, so the producer can move from awareness to stateless
 * broadcast without touching this hook or its consumers (the working claw, the
 * status banner, the composer guard).
 *
 * [COMP:app-web/assistant-run]
 */

import { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { AssistantRunState } from "@sidanclaw/doc-model";

/** An awareness client state may carry the server-published run field. */
type AwarenessWithRun = { assistantRun?: AssistantRunState | null };

/**
 * Pure: find the single active run across all awareness states. doc-sync
 * publishes at most one `assistantRun` (its own service client), but we scan
 * defensively and return the freshest non-expired `running` entry. Exported so
 * the contract is unit-testable without a live socket.
 */
export function deriveAssistantRun(
  states: Map<number, AwarenessWithRun | undefined>,
  now: number,
): AssistantRunState | null {
  let best: AssistantRunState | null = null;
  for (const state of states.values()) {
    const run = state?.assistantRun;
    if (!run || run.status !== "running") continue;
    // Ignore a run whose TTL already lapsed — the sweeper clears it server-side,
    // but a client that missed the clearing update shouldn't show a ghost.
    if (typeof run.expiresAt === "number" && run.expiresAt <= now) continue;
    if (!best || run.startedAt > best.startedAt) best = run;
  }
  return best;
}

export function useAssistantRun(
  provider: HocuspocusProvider | null,
): AssistantRunState | null {
  const [run, setRun] = useState<AssistantRunState | null>(null);

  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) {
      setRun(null);
      return;
    }
    const recompute = () => {
      setRun(
        deriveAssistantRun(
          awareness.getStates() as Map<number, AwarenessWithRun>,
          Date.now(),
        ),
      );
    };
    recompute();
    awareness.on("change", recompute);
    // The TTL clear is published as an awareness change too, but if the
    // producer ever crashes mid-run, re-derive on an interval so the local
    // banner/claw still drop when `expiresAt` passes.
    const tick = setInterval(recompute, 5_000);
    return () => {
      awareness.off("change", recompute);
      clearInterval(tick);
    };
  }, [provider]);

  return run;
}
