"use client";

import type { QueuedInput } from "@/lib/use-mid-turn-queue";

/**
 * Messages handed to the running turn but not yet taken by it (mid-turn
 * input).
 *
 * Rendered BELOW the live assistant bubble on every chat surface, because
 * that is where they sit in time — a queued message parked in the committed
 * message list would appear ABOVE a reply that was written before it was
 * sent. Each carries Steer: take this now instead of at the next boundary.
 *
 * Spec: docs/architecture/engine/mid-turn-input.md.
 * `[COMP:app-web/queued-inputs]`
 */
export type QueuedInputsDict = {
  pending: string;
  steering: string;
  steer: string;
  steerHint: string;
};

export function QueuedInputs(props: {
  inputs: QueuedInput[];
  dict: QueuedInputsDict;
  onSteer: (inputId: string) => void;
}) {
  if (props.inputs.length === 0) return null;
  return (
    <>
      {props.inputs.map((input) => (
        <div key={input.inputId} className="flex justify-end">
          <div className="max-w-[85%] space-y-1">
            <div className="whitespace-pre-wrap break-words rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {input.text}
            </div>
            <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
              <span>{input.steer ? props.dict.steering : props.dict.pending}</span>
              {input.steer ? null : (
                <button
                  type="button"
                  onClick={() => props.onSteer(input.inputId)}
                  title={props.dict.steerHint}
                  className="rounded px-1.5 py-0.5 font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                >
                  {props.dict.steer}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
