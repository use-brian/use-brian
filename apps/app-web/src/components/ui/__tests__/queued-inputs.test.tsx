/**
 * [COMP:app-web/queued-inputs] Mid-turn queued-message tray.
 *
 * Node-only vitest (no jsdom): the component is pure presentation, so the
 * SSR markup carries the whole contract — what a waiting message looks like,
 * and when Steer is offered.
 *
 * Spec: docs/architecture/engine/mid-turn-input.md.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueuedInputs, type QueuedInputsDict } from "../queued-inputs";
import type { QueuedInput } from "@/lib/use-mid-turn-queue";

const dict: QueuedInputsDict = {
  pending: "Queued",
  steering: "Steering",
  steer: "Steer",
  steerHint: "Take this now",
};

const input = (over: Partial<QueuedInput> & { text: string }): QueuedInput => ({
  inputId: over.inputId ?? "in-1",
  steer: over.steer ?? false,
  text: over.text,
});

function render(inputs: QueuedInput[]): string {
  return renderToString(
    <QueuedInputs inputs={inputs} dict={dict} onSteer={() => {}} />,
  );
}

describe("[COMP:app-web/queued-inputs] Mid-turn queued-message tray", () => {
  it("renders nothing when nothing is waiting", () => {
    expect(render([])).toBe("");
  });

  it("shows the waiting message with its state and a Steer action", () => {
    const html = render([input({ text: "what about Jack?" })]);
    expect(html).toContain("what about Jack?");
    expect(html).toContain("Queued");
    expect(html).toContain("Steer");
  });

  it("drops the Steer action once the message is already steering", () => {
    // Steering is the strongest ask available — offering it again would
    // re-post an input that is already expedited.
    const html = render([input({ text: "no, last Friday", steer: true })]);
    expect(html).toContain("Steering");
    expect(html).not.toContain(">Steer<");
  });

  it("renders every waiting message in order", () => {
    const html = render([
      input({ inputId: "a", text: "first ask" }),
      input({ inputId: "b", text: "second ask" }),
    ]);
    expect(html.indexOf("first ask")).toBeLessThan(html.indexOf("second ask"));
  });
});
