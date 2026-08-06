"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMessageStreamResult } from "@use-brian/chat-ui";
import { authFetch } from "./auth-fetch";

// Same resolution every chat host uses for its own turns — kept local rather
// than imported so this hook has no dependency on which host mounted it.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Mid-turn input, client side — "send while the assistant is working".
 *
 * A message sent during a live turn is POSTed on a SECOND connection and
 * handed to the RUNNING turn, which takes it at its next safe boundary (or,
 * for a steer, interrupts its in-flight response to take it sooner). The reply
 * comes back on the ORIGINAL stream, which is why this never goes through
 * `stream.start()` — that aborts the live stream.
 *
 * **The client is the durable holder.** Nothing is persisted server-side at
 * queue time; an entry becomes part of the transcript only when the turn takes
 * it and the server reports `input_applied`. So the host must call `drain()`
 * on every stream exit (done, error, abort) and send whatever is left as an
 * ordinary turn — that single fallback covers a turn that finished first, a
 * user who hit Stop, a dropped connection, and a lost cross-instance delivery.
 *
 * Spec: docs/architecture/engine/mid-turn-input.md. `[COMP:app-web/mid-turn-queue]`
 */

export type QueuedInput = {
  /** Client-minted idempotency key. Steering re-posts under the SAME id, so
   *  the server-side inbox upgrades the waiting entry instead of duplicating it. */
  inputId: string;
  text: string;
  steer: boolean;
};

export type MidTurnQueueParams = {
  /** The host's message stream — `sideStream` is the only method used. */
  stream: Pick<UseMessageStreamResult, "sideStream">;
  /** Read at call time: the session must already exist to have a running turn. */
  getSessionId: () => string | null | undefined;
  workspaceId?: string;
  /** Read at call time — the dock's selected assistant can change. */
  getAssistantId?: () => string | null | undefined;
  appOrigin?: string;
  /** IANA zone, when the host sends one on ordinary turns. */
  timezone?: string;
};

export type MidTurnQueue = {
  /** Everything handed to the running turn and not yet taken, oldest first. */
  queued: QueuedInput[];
  /**
   * Hand a message to the running turn. Returns false when there is no
   * session to hand it to (the host should fall back to an ordinary send).
   */
  queue: (text: string, steer: boolean) => boolean;
  /** Escalate an already-queued message to a steer. No-op if already steering. */
  steer: (inputId: string) => void;
  /**
   * The turn took this one (`input_applied`). Removes it and returns the entry
   * so the host can splice it into its thread at the right place.
   */
  take: (inputId: string) => QueuedInput | null;
  /**
   * The stream ended. Returns everything still waiting and clears — the host
   * sends it as an ordinary turn.
   */
  drain: () => QueuedInput[];
};

function mintInputId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `input-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useMidTurnQueue(params: MidTurnQueueParams): MidTurnQueue {
  const [queued, setQueued] = useState<QueuedInput[]>([]);
  const queuedRef = useRef<QueuedInput[]>([]);
  useEffect(() => {
    queuedRef.current = queued;
  }, [queued]);

  // Params are read at call time so a host can pass fresh closures each render
  // without churning the callbacks below (they end up in stream-handler
  // dependency arrays).
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const post = useCallback((input: QueuedInput, sessionId: string) => {
    const p = paramsRef.current;
    void p.stream.sideStream({
      url: `${API_URL}/api/chat`,
      authFetch: (url, init) => authFetch(String(url), init),
      body: {
        message: input.text,
        sessionId,
        // The client is the only party that knows its own stream is live, so
        // this flag — not the `sessions` row — is what makes the server queue
        // instead of starting a turn. A session left `running` by a crashed
        // turn therefore still accepts ordinary sends.
        midTurn: true,
        steer: input.steer,
        inputId: input.inputId,
        ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
        ...(p.getAssistantId?.() ? { assistantId: p.getAssistantId?.() } : {}),
        ...(p.appOrigin ? { appOrigin: p.appOrigin } : {}),
        ...(p.timezone ? { timezone: p.timezone } : {}),
      },
      // The side connection answers `session` / `input_queued` / `done` and
      // closes. Nothing to render from it: a delivery that never lands is
      // covered by the host's end-of-stream drain, which is the same path a
      // turn that ended before taking it takes.
      onEvent: () => {},
    });
  }, []);

  const queue = useCallback(
    (text: string, steer: boolean): boolean => {
      const trimmed = text.trim();
      const sessionId = paramsRef.current.getSessionId();
      if (!trimmed || !sessionId) return false;
      const input: QueuedInput = { inputId: mintInputId(), text: trimmed, steer };
      setQueued((current) => [...current, input]);
      post(input, sessionId);
      return true;
    },
    [post],
  );

  const steer = useCallback(
    (inputId: string) => {
      const entry = queuedRef.current.find((q) => q.inputId === inputId);
      if (!entry || entry.steer) return;
      const sessionId = paramsRef.current.getSessionId();
      if (!sessionId) return;
      setQueued((current) =>
        current.map((q) => (q.inputId === inputId ? { ...q, steer: true } : q)),
      );
      post({ ...entry, steer: true }, sessionId);
    },
    [post],
  );

  const take = useCallback((inputId: string): QueuedInput | null => {
    const entry = queuedRef.current.find((q) => q.inputId === inputId) ?? null;
    // Filter unconditionally: an id we don't recognise is already gone, and
    // re-running the filter is cheaper than branching on it.
    setQueued((current) => current.filter((q) => q.inputId !== inputId));
    return entry;
  }, []);

  const drain = useCallback((): QueuedInput[] => {
    const left = queuedRef.current;
    if (left.length === 0) return [];
    queuedRef.current = [];
    setQueued([]);
    return left;
  }, []);

  return { queued, queue, steer, take, drain };
}

/** Join a drained batch into the one ordinary message the host sends. */
export function joinQueuedInputs(inputs: QueuedInput[]): string {
  return inputs.map((input) => input.text).join("\n\n");
}
