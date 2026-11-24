// @vitest-environment jsdom

/** [COMP:app-web/workflow-task-events] Task lifecycle and Project home event filters. */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { WorkflowTrigger } from "@/lib/api/workflow";
import { resetSurfaceCache } from "@/lib/surface-cache";
import { EventTriggerFields } from "../event-trigger-fields";

const projects = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/context-scopes", () => ({ listContextProjects: projects }));
vi.mock("@/lib/api/workflow", () => ({
  listWorkspaceChannelOptions: async () => [],
  listWorkspaceConnectorOptions: async () => [],
  listWorkspaceMemberOptions: async () => [],
  listWorkspacePageOptions: async () => [],
  listCrmWorkflowEventCatalog: async () => ({ eventTypes: [], stableKeys: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = en.workflowPage.builder;
const atlas = "11111111-1111-4111-8111-111111111111";
const beacon = "22222222-2222-4222-8222-222222222222";
const missing = "33333333-3333-4333-8333-333333333333";
const shared = { status: "active", myRole: "owner" };
type Trigger = Extract<WorkflowTrigger, { kind: "event" }>;
let root: Root;
let host: HTMLDivElement;
const change = vi.fn<(value: Trigger) => void>();

beforeEach(() => {
  resetSurfaceCache();
  change.mockClear();
  projects.mockReset().mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(match?: Trigger["event"]["sources"][number]["match"], workspaceId = "w1") {
  function Editor() {
    const [trigger, setTrigger] = useState<Trigger>({
      kind: "event", event: { sources: [{ source: { type: "task" }, match }] },
    });
    return <EventTriggerFields workspaceId={workspaceId} trigger={trigger} onChange={(next) => {
      if (next.kind !== "event") throw new Error("Expected event trigger");
      change(next);
      setTrigger(next);
    }} />;
  }
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><Editor /></I18nProvider>));
}

function selectedSource() {
  return change.mock.lastCall?.[0].event.sources[0];
}

function choice(label: string) {
  return host.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`)!;
}

function button(label: string) {
  return [...host.querySelectorAll("button")].find((el) => el.textContent === label || el.getAttribute("aria-label") === label)!;
}

async function click(el: HTMLElement) {
  expect(el).toBeTruthy();
  await act(async () => el.click());
}

function projectOptions() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function openProjects() {
  await click(button(copy.eventTaskProjectsAdd));
}

describe("[COMP:app-web/workflow-task-events] task event source", () => {
  it("stores status_changed and keeps a Project-only match when the action is unchecked", async () => {
    await mount({ taskProjectIds: [atlas] });
    const status = choice(copy.eventTaskActionStatusChanged);
    await click(status);
    expect(status.getAttribute("aria-checked")).toBe("true");
    expect(selectedSource()?.match).toEqual({ inChannels: ["status_changed"], taskProjectIds: [atlas] });
    await click(status);
    expect(status.getAttribute("aria-checked")).toBe("false");
    expect(selectedSource()?.match).toEqual({ taskProjectIds: [atlas] });
  });

  it("adds multiple eligible workspace Project IDs and preserves an unavailable selection until removed", async () => {
    projects.mockResolvedValue([
      { id: atlas, name: "Atlas", status: "active", shared },
      { id: beacon, name: "Beacon", status: "active", shared: { ...shared, myRole: "participant" } },
      { id: "legacy", name: "Legacy", status: "active", shared: null },
      { id: "archived", name: "Archived", status: "archived", shared },
      { id: "quarantined", name: "Quarantined", status: "active", shared: { ...shared, status: "quarantined" } },
      { id: "oversight", name: "Oversight", status: "active", shared: { ...shared, myRole: "oversight" } },
    ]);
    await mount({ taskProjectIds: [missing], inChannels: ["status_changed"] }, "workspace-filter");
    expect(projects).toHaveBeenCalledWith("workspace-filter", true);
    expect(change).not.toHaveBeenCalled();
    expect(host.textContent).toContain(`${missing} (unavailable)`);

    await openProjects();
    expect(projectOptions().map((el) => el.textContent)).toEqual(["Atlas", "Beacon"]);
    await click(projectOptions()[0]);
    expect(selectedSource()?.match?.taskProjectIds).toEqual([missing, atlas]);
    await openProjects();
    await click(projectOptions().find((el) => el.textContent === "Beacon")!);
    expect(selectedSource()?.match?.taskProjectIds).toEqual([missing, atlas, beacon]);

    await click(button(`Remove Project: ${missing} (unavailable)`));
    expect(selectedSource()?.match).toEqual({ taskProjectIds: [atlas, beacon], inChannels: ["status_changed"] });
    await click(button(copy.eventSourceKindPage));
    expect(selectedSource()?.source.type).toBe("page");
    expect(selectedSource()?.match?.taskProjectIds).toBeUndefined();
    expect(host.textContent).not.toContain(copy.eventTaskProjectsLabel);
    await click(button(copy.eventSourceKindTask));
    expect(selectedSource()?.match?.taskProjectIds).toBeUndefined();
  });

  it("keeps the saved scope through a registry failure and retry", async () => {
    projects.mockRejectedValueOnce(new Error("offline"));
    await mount({ taskProjectIds: [atlas] });
    expect(host.textContent).toContain(copy.eventTaskProjectsLoadError);
    expect(host.textContent).not.toContain(copy.eventTaskProjectsEmpty);
    expect(button(copy.eventTaskProjectsAdd)).toBeUndefined();
    expect(change).not.toHaveBeenCalled();
    await click(choice(copy.eventTaskActionStatusChanged));
    expect(selectedSource()?.match?.taskProjectIds).toEqual([atlas]);

    projects.mockResolvedValue([{ id: atlas, name: "Atlas", status: "active", shared }]);
    await click(button(copy.eventTaskProjectsRetry));
    expect(host.textContent).not.toContain(copy.eventTaskProjectsLoadError);
    expect(change).toHaveBeenCalledTimes(1);
    await click(button("Remove Project: Atlas"));
    expect(selectedSource()?.match).toEqual({ inChannels: ["status_changed"] });
  });
});
