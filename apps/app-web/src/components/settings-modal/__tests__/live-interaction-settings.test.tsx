// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/live-interaction/api", () => ({ interactionRequest: request, DEFAULT_INTERACTION_RULE: "When I say Hey Brian, answer the question that follows." }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/components/ui/button", () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} /> }));
import { LiveInteractionSettings } from "../sections/live-interaction-settings";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
beforeEach(() => { request.mockReset(); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
it("loads a personal natural rule, saves via PUT, and previews speech without a workspace scope", async () => {
  request.mockResolvedValue({ rule: "Answer when I ask for a decision", available: true });
  await act(async () => root.render(<LiveInteractionSettings />));
  expect(container.querySelector("textarea")!.value).toBe("Answer when I ask for a decision");
  await act(async () => button(en.liveInteraction.save).click());
  expect(request).toHaveBeenCalledWith("/settings", { rule: "Answer when I ask for a decision" }, "PUT");
  const sample = container.querySelectorAll("textarea")[1];
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(sample, "What decision did we reach?");
    sample.dispatchEvent(new Event("input", { bubbles: true }));
  });
  request.mockResolvedValueOnce({ question: "What decision did we reach?" });
  await act(async () => button(en.liveInteraction.preview).click());
  expect(request).toHaveBeenLastCalledWith("/preview", { rule: "Answer when I ask for a decision", text: "What decision did we reach?" });
  expect(container.textContent).toContain("What decision did we reach?");
});
it("makes provider unavailability visible and disables preview while keeping personal settings editable", async () => {
  request.mockResolvedValue({ rule: "Personal rule", available: false });
  await act(async () => root.render(<LiveInteractionSettings />));
  expect(container.textContent).toContain(en.liveInteraction.unavailable);
  expect(button(en.liveInteraction.preview).disabled).toBe(true);
  expect(button(en.liveInteraction.save).disabled).toBe(false);
});
it("fails closed visibly when personal settings cannot be loaded", async () => {
  request.mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<LiveInteractionSettings />));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button(en.liveInteraction.save).disabled).toBe(true);
});
