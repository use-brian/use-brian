// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const api = vi.hoisted(() => ({
  listContextTeams: vi.fn(),
  listContextProjects: vi.fn(),
  getConnectorContext: vi.fn(),
  updateConnectorContext: vi.fn(),
}));

vi.mock("@/lib/api/context-scopes", () => api);
vi.mock("../context-scope-picker", () => ({
  ContextScopePicker: () => <div data-testid="context-picker" />,
}));

import { ConnectorContextBinding } from "../connector-context-binding";

let host: HTMLDivElement;
let root: Root;

async function renderBinding(): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <ConnectorContextBinding workspaceId="workspace-1" instanceId="instance-1" />
      </I18nProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  api.listContextTeams.mockResolvedValue([]);
  api.listContextProjects.mockResolvedValue([]);
  api.getConnectorContext.mockResolvedValue({ contextGroupId: null, contextProjectId: null });
  api.updateConnectorContext.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("[COMP:app-web/context-scope] connector context binding", () => {
  it("discloses the provider-root limit for a scoped connector", async () => {
    api.getConnectorContext.mockResolvedValue({
      contextGroupId: "team-product",
      contextProjectId: "project-roadmap",
    });
    await renderBinding();

    expect(host.textContent).toContain(en.contextScope.connectorProviderRootUnavailable);
  });

  it("renders localized load copy instead of a raw API error code", async () => {
    api.getConnectorContext.mockRejectedValue(new Error("not_found"));
    await renderBinding();

    expect(host.textContent).toContain(en.contextScope.loadFailed);
    expect(host.textContent).not.toContain("not_found");
  });

  it("renders localized update copy instead of a raw API error code", async () => {
    api.updateConnectorContext.mockRejectedValue(new Error("not_found"));
    await renderBinding();

    const save = [...host.querySelectorAll("button")]
      .find((button) => button.textContent === en.contextScope.saveContext);
    expect(save).toBeDefined();
    await act(async () => save!.click());

    expect(host.textContent).toContain(en.contextScope.updateFailed);
    expect(host.textContent).not.toContain("not_found");
  });
});
