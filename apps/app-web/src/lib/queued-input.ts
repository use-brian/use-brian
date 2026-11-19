/**
 * Display shape of one mid-turn input waiting in the queued tray. The
 * conversation controller owns the queue itself (its `queued` snapshot
 * entries satisfy this type); this module only names what the tray renders,
 * so `components/ui/queued-inputs.tsx` depends on no queue implementation.
 *
 * Spec: docs/architecture/engine/mid-turn-input.md → "Controller
 * coordination". [COMP:app-web/queued-inputs]
 */
export type QueuedInput = {
  /** Immutable owner; never infer ownership from the currently selected chat. */
  readonly sessionId: string;
  /** Client-minted idempotency key; a steer re-posts under the same id. */
  readonly inputId: string;
  readonly text: string;
  readonly steer: boolean;
  /** A room post the server saved and owns: never re-sent or steered later. */
  readonly serverHeld?: boolean;
};
