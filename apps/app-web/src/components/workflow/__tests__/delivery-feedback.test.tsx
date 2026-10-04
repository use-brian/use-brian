// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import type { WorkflowDelivery } from "@/lib/api/workflow";

const route = vi.hoisted(() => ({ params: null as null | Record<string, string | string[] | undefined> }));
vi.mock("next/navigation", () => ({ useParams: () => route.params }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
import { WorkflowDeliveryField } from "../step-editor";
import { ScheduleTriggerFields } from "../schedule-trigger-fields";
import { DeliveryOutcomeFeedback } from "../delivery-feedback";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); route.params = null; });
function mount(node: ReactNode) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(node));
}
function field(delivery?: WorkflowDelivery, disabled = false) {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState(delivery);
    return <WorkflowDeliveryField delivery={value} destinations={[]} channelOptions={[]} slackChannels={[]} t={en} disabled={disabled} onChange={next => { changed(next); setValue(next); }} />;
  }
  mount(<Harness />);
  return changed;
}
const copy = en.workflowPage.builder.deliveryFeedback;
async function openChannelSelect() {
  await act(async () => (host.querySelector('[role="combobox"]') as HTMLElement).click());
}

describe("[COMP:app-web/workflow-delivery-feedback] audience denial outcomes", () => {
  it.each([
    ["unbound", copy.unbound],
    ["personal_group_unverified", copy.unverified],
    ["evidence_exceeds_audience", copy.evidenceExceedsAudience],
    [undefined, copy.unverified],
    ["private-source-secret", copy.unverified],
    [{ message: "private-source-secret" }, copy.unverified],
  ])("shows safe guidance for detail %j", (detail, expected) => {
    mount(<DeliveryOutcomeFeedback workspaceId="workspace-example" output={{ __delivery: {
      status: "skipped", channelType: "telegram", reason: "delivery_audience_unverified", detail,
    } }} />);
    expect(host.textContent).toContain(copy.skipped);
    expect(host.textContent).toContain(expected);
    expect(host.textContent).not.toContain("private-source-secret");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/w/workspace-example/studio/channels");
  });

  it("ignores audience detail on unrelated skips", () => {
    mount(<DeliveryOutcomeFeedback workspaceId="workspace-example" output={{ __delivery: {
      status: "skipped", channelType: "telegram", reason: "no_integration", detail: "evidence_exceeds_audience",
    } }} />);
    expect(host.textContent).not.toContain(copy.evidenceExceedsAudience);
    expect(host.querySelector("a")).toBeNull();
  });
});

describe("[COMP:app-web/workflow-delivery-feedback] delivery authoring", () => {
  it.each([
    { channelType: "telegram", channelId: "fictional" },
    { replyToTrigger: true, channelType: "telegram" },
  ] as WorkflowDelivery[])("shows audience guidance and workspace link for %j", delivery => {
    route.params = { workspaceId: "workspace-example" };
    field(delivery);
    expect(host.textContent).toContain(copy.guidance);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/w/workspace-example/studio/channels");
  });
  it.each([null, {}, { workspaceId: ["unexpected"] }])("handles absent or invalid route params %j", params => {
    route.params = params;
    field({ channelType: "telegram", channelId: "fictional" });
    expect(host.textContent).toContain(copy.guidance);
    expect(host.querySelector("a")).toBeNull();
  });
  it("shows no audience guidance when disabled delivery is unset", () => {
    field(); expect(host.textContent).not.toContain(copy.guidance);
  });
  it("does not offer web for new targets", async () => {
    field({ channelType: "telegram", channelId: "" });
    await openChannelSelect();
    expect([...document.querySelectorAll('[role="option"]')].some(n => n.textContent === en.workflowPage.builder.deliverChannelWeb)).toBe(false);
  });
  it("preserves legacy web visibly without a custom target editor and allows disabling", () => {
    const changed = field({ channelType: "web", channelId: "legacy-example" });
    expect(host.textContent).toContain(copy.legacyWeb);
    expect(host.textContent).toContain("legacy-example");
    expect(host.querySelector('input[type="text"]')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    act(() => (host.querySelector('[role="switch"]') as HTMLElement).click());
    expect(changed).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("allows explicitly changing legacy web to a supported channel", async () => {
    const changed = field({ channelType: "web", channelId: "legacy-example" });
    await openChannelSelect();
    const options = [...document.querySelectorAll('[role="option"]')];
    const web = options.find(n => n.textContent === en.workflowPage.builder.deliverChannelWeb)!;
    expect(web.getAttribute("aria-disabled")).toBe("true");
    await act(async () => (options.find(n => n.textContent === en.workflowPage.builder.deliverChannelSlack) as HTMLElement).click());
    expect(changed).toHaveBeenCalledExactlyOnceWith({ channelType: "slack", channelId: "" });
    expect(host.textContent).not.toContain(copy.legacyWeb);
  });
  it("respects disabled legacy controls", () => {
    const changed = field({ channelType: "web", channelId: "legacy-example" }, true);
    act(() => (host.querySelector('[role="switch"]') as HTMLElement).click());
    expect(changed).not.toHaveBeenCalled();
  });
  it.each([true, false])("schedule audience guidance follows delivery enabled=%s", enabled => {
    route.params = { workspaceId: "workspace-schedule" };
    mount(<ScheduleTriggerFields trigger={{ kind: "schedule", schedule: { type: "daily", time: "09:00" }, delivery: enabled ? { channel: "feishu" } : undefined }} onChange={vi.fn()} />);
    expect(host.textContent?.includes(copy.guidance)).toBe(enabled);
    expect(host.querySelector('a[href="/w/workspace-schedule/studio/channels"]') !== null).toBe(enabled);
  });
});
