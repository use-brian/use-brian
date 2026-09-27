"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { useCallback, useRef, useState } from "react";
import type { UseMessageStreamResult } from "@use-brian/chat-ui";
import { authFetch } from "./auth-fetch";

// Same resolution every chat host uses for its own turns — kept local rather
// than imported so this hook has no dependency on which host mounted it.
const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/**
 * Mid-turn input, client side — "send while the assistant is working".
 *
 * A message sent during a live turn is POSTed on a SECOND connection and
 * handed to the RUNNING turn, which takes it at its next safe boundary (or,
 * for a steer, interrupts its in-flight response to take it sooner). The reply
 * comes back on the ORIGINAL stream, which is why this never goes through
 * `stream.start()` — that aborts the live stream.
 *
 * While the conversation stays selected, the client holds unapplied input.
 * The host calls `drain(sessionId)` on stream exit for its explicit fallback.
 * Leaving the conversation abandons this client retry/steering queue: accepted
 * side submissions continue processing on the server. Their acknowledgements
 * may be missed while disconnected, so returning must NOT retry uncertain
 * deliveries (which may already have been applied).
 *
 * Spec: docs/architecture/engine/mid-turn-input.md. `[COMP:app-web/mid-turn-queue]`
 */

export type QueuedInput = {
  /** Immutable owner; never infer ownership from the currently selected chat. */
  readonly sessionId: string;
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
  /** Selected session's waiting inputs, oldest first; cleared on session change. */
  queued: QueuedInput[];
  /**
   * Hand a message to the running turn. Returns false when there is no
   * session to hand it to, or selection changed before the host rendered.
   * A fallback send must independently validate the intended session.
   */
  queue: (text: string, steer: boolean) => boolean;
  /** Escalate an already-queued message to a steer. No-op if already steering. */
  steer: (inputId: string) => void;
  /**
   * The turn took this one (`input_applied`). Removes it and returns the entry
   * so the host can splice it into its thread at the right place. Pass the
   * originating stream session, not the current selection. Stale acknowledgements
   * never return an entry for a different conversation.
   */
  take: (inputId: string, sessionId: string) => QueuedInput | null;
  /**
   * The stream ended. Drain only the named, currently selected session. Leaving
   * a session discards its retry queue. Capture the stream session ID before
   * any await. The host MUST also recheck ownership immediately before a
   * deferred fallback send (or send explicitly to the owner), never blindly
   * call a latest-session send callback after a timer/await.
   */
  drain: (sessionId: string) => QueuedInput[];
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
  // The ref is authoritative: queue/take/drain can all run before React commits.
  const publish = useCallback((next: QueuedInput[]) => {
    queuedRef.current = next;
    setQueued(next);
  }, []);

  // Params are read at call time so a host can pass fresh closures each render
  // without churning the callbacks below (they end up in stream-handler
  // dependency arrays).
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const selectedSessionId = params.getSessionId() ?? null;
  const ownerRef = useRef(selectedSessionId);
  const renderedSessionRef = useRef(selectedSessionId);
  renderedSessionRef.current = selectedSessionId;
  // Reset during render, not in a passive effect: A -> B -> A must not revive
  // A's uncertain deliveries, even when no queue callback runs in B.
  if (ownerRef.current !== selectedSessionId) {
    ownerRef.current = selectedSessionId;
    publish([]);
  }

  const currentSession = useCallback((): string | null => {
    const selected = paramsRef.current.getSessionId() ?? null;
    // Selection refs can change before React renders. Abandon the previous
    // queue synchronously even for a stale/unknown take, steer or drain call.
    if (ownerRef.current !== selected) {
      ownerRef.current = selected;
      publish([]);
    }
    // Never post or deliver through a host still rendered for another session.
    return selected === renderedSessionRef.current ? selected : null;
  }, [publish]);

  const post = useCallback((input: QueuedInput) => {
    const p = paramsRef.current;
    void p.stream.sideStream({
      url: `${API_URL}/api/chat`,
      authFetch: (url, init) => authFetch(String(url), init),
      body: {
        message: input.text,
        sessionId: input.sessionId,
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
      // covered by the host's end-of-stream drain only while still selected.
      // Once selection changes, uncertain delivery must not be retried.
      onEvent: () => {},
    });
  }, []);

  const queue = useCallback(
    (text: string, steer: boolean): boolean => {
      const trimmed = text.trim();
      const sessionId = currentSession();
      if (!trimmed || !sessionId) return false;
      const input: QueuedInput = { sessionId, inputId: mintInputId(), text: trimmed, steer };
      publish([...queuedRef.current, input]);
      post(input);
      return true;
    },
    [post, publish, currentSession],
  );

  const steer = useCallback(
    (inputId: string) => {
      const sessionId = currentSession();
      const entry = queuedRef.current.find((q) => q.inputId === inputId);
      if (!entry || entry.steer) return;
      if (sessionId !== entry.sessionId) return;
      publish(queuedRef.current.map((q) =>
        q.inputId === inputId ? { ...q, steer: true } : q,
      ));
      post({ ...entry, steer: true });
    },
    [post, publish, currentSession],
  );

  const take = useCallback((inputId: string, sessionId: string): QueuedInput | null => {
    const selected = currentSession();
    if (!sessionId || selected !== sessionId) return null;
    const entry = queuedRef.current.find((q) =>
      q.inputId === inputId && q.sessionId === sessionId,
    );
    if (!entry) return null;
    publish(queuedRef.current.filter((q) => q !== entry));
    return entry;
  }, [publish, currentSession]);

  const drain = useCallback((sessionId: string): QueuedInput[] => {
    // Fail closed for old/unscoped callers and stale async completions.
    const selected = currentSession();
    if (!sessionId || selected !== sessionId) return [];
    const left = queuedRef.current.filter((q) => q.sessionId === sessionId);
    if (left.length) publish(queuedRef.current.filter((q) => q.sessionId !== sessionId));
    return left;
  }, [publish, currentSession]);

  return {
    queued: queued.filter((q) => q.sessionId === selectedSessionId),
    queue, steer, take, drain,
  };
}

/** Join a drained batch into the one ordinary message the host sends. */
export function joinQueuedInputs(inputs: QueuedInput[]): string {
  return inputs.map((input) => input.text).join("\n\n");
}
