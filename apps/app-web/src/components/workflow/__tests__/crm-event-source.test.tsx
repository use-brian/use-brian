// @vitest-environment jsdom

/** [COMP:app-web/workflow] Closed-world CRM event source filters. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listWorkspaceChannelOptions: vi.fn(async () => []),
  listWorkspaceConnectorOptions: vi.fn(async () => []),
  listWorkspaceMemberOptions: vi.fn(async () => []),
  listWorkspacePageOptions: vi.fn(async () => []),
  listCrmWorkflowEventCatalog: vi.fn(async () => ({
    eventTypes: ["crm.submission.received", "crm.consent.changed"],
    stableKeys: [{ kind: "definition", key: "website_contact", label: "Website contact" }],
  })),
}));
vi.mock("@/lib/api/workflow", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/workflow")>(),
  ...api,
}));

import { EventTriggerFields } from "../event-trigger-fields";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null;
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/workflow] CRM event source", () => {
  it("loads and renders only enumerated CRM event types and stable keys", async () => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(
      <I18nProvider locale="en" dict={en}>
        <EventTriggerFields
          workspaceId="workspace-1"
          trigger={{ kind: "event", event: { sources: [{ source: { type: "crm" } }] } }}
          onChange={vi.fn()}
        />
      </I18nProvider>,
    ));
    for (let index = 0; index < 6; index += 1) await act(async () => { await Promise.resolve(); });
    expect(api.listCrmWorkflowEventCatalog).toHaveBeenCalledWith("workspace-1");
    expect(host.textContent).toContain("CRM operations");
    expect(host.textContent).toContain("Submission received");
    expect(host.textContent).toContain("Consent changed");
    expect(host.textContent).toContain("Stable catalog keys");
    expect(host.textContent).not.toContain("crm.deal.stage_changed");
  });
});
