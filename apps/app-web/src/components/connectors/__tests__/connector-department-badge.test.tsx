// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const api = vi.hoisted(() => ({
  getConnectorContext: vi.fn(),
  updateConnectorContext: vi.fn(),
  listContextTeams: vi.fn(),
  fetchDepartments: vi.fn(),
  onChange: null as null | ((value: string) => void),
}));

vi.mock("@/lib/api/context-scopes", () => ({
  getConnectorContext: api.getConnectorContext,
  updateConnectorContext: api.updateConnectorContext,
  listContextTeams: api.listContextTeams,
}));
vi.mock("@/lib/api/departments", () => ({ fetchDepartments: api.fetchDepartments }));
// The Select primitive is portal-backed; a flat stand-in exposes
// its options and change handler to the test.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange: (v: string) => void }) => {
    api.onChange = onValueChange;
    return <div data-testid="select">{children}</div>;
  },
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div data-testid="trigger">{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div data-testid="options">{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => <div data-value={value}>{children}</div>,
}));

import { ConnectorDepartmentBadge } from "../connector-department-badge";

let host: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <ConnectorDepartmentBadge workspaceId="workspace-1" instanceId="instance-1" />
      </I18nProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  api.listContextTeams.mockResolvedValue([]);
  api.fetchDepartments.mockResolvedValue({
    departments: [
      { departmentId: "d-sales", name: "Sales", status: "active", myClearance: "internal" },
      { departmentId: "d-old", name: "Old", status: "archived", myClearance: "internal" },
    ],
    homes: [],
  });
  api.updateConnectorContext.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("[COMP:app-web/connector-department-badge] connector department badge", () => {
  it("offers General plus the viewer's active departments and saves only the department", async () => {
    api.getConnectorContext.mockResolvedValue({ contextGroupId: null, contextProjectId: "p", canEdit: true });
    await render();
    expect(host.querySelector("[data-testid=trigger]")?.textContent).toBe(en.contextScope.departmentGeneral);
    const values = [...host.querySelectorAll("[data-value]")].map((n) => n.getAttribute("data-value"));
    expect(values).toEqual(["__general__", "d-sales"]);
    await act(async () => { api.onChange!("d-sales"); });
    expect(api.updateConnectorContext).toHaveBeenCalledWith("workspace-1", "instance-1", { contextGroupId: "d-sales" });
    expect(host.querySelector("[data-testid=trigger]")?.textContent).toBe("Sales");
  });

  it("reverts and explains when the change is refused", async () => {
    api.getConnectorContext.mockResolvedValue({ contextGroupId: "d-sales", contextProjectId: null, canEdit: true });
    api.updateConnectorContext.mockRejectedValue(new Error("connector_department_not_held"));
    await render();
    await act(async () => { api.onChange!("__general__"); });
    expect(host.querySelector("[data-testid=trigger]")?.textContent).toBe("Sales");
    expect(host.textContent).toContain(en.contextScope.departmentUpdateFailed);
    expect(host.textContent).not.toContain("connector_department_not_held");
  });

  it("is a read-only pill for a viewer who cannot change it, and absent when hidden", async () => {
    api.getConnectorContext.mockResolvedValue({ contextGroupId: "d-sales", contextProjectId: null, canEdit: false });
    await render();
    expect(host.querySelector("[data-testid=select]")).toBeNull();
    expect(host.textContent).toBe("Sales");

    api.getConnectorContext.mockRejectedValue(new Error("not_found"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.textContent).toBe("");
  });
});
