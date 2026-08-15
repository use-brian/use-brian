// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  fetchModelMenu,
  getCustomLlmConfiguration,
  updateCustomLlmProfile,
} = vi.hoisted(() => ({
  fetchModelMenu: vi.fn(),
  getCustomLlmConfiguration: vi.fn(),
  updateCustomLlmProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({ workspaceId: "ws-1" }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));
vi.mock("@/components/ui/prompt-dialog", () => ({
  promptDialog: vi.fn(async () => null),
}));
vi.mock("@/lib/api/models", () => ({
  clearWorkspaceModelDefault: vi.fn(),
  clearWorkspaceModelRoute: vi.fn(),
  createMeteredProfile: vi.fn(),
  deleteMeteredProfile: vi.fn(),
  fetchMeteredEstimate: vi.fn(),
  fetchModelMenu,
  setWorkspaceModelDefault: vi.fn(),
  setWorkspaceModelRoute: vi.fn(),
  updateMeteredProfile: vi.fn(),
}));
vi.mock("@/lib/api/custom-llm-endpoints", () => ({
  clearCustomLlmTierDefault: vi.fn(),
  createCustomLlmProfile: vi.fn(),
  deleteCustomLlmProfile: vi.fn(),
  getCustomLlmConfiguration,
  setCustomLlmTierDefault: vi.fn(),
  updateCustomLlmProfile,
}));
vi.mock("../custom-llm-endpoints-block", () => ({
  CustomLlmEndpointsBlock: () => <div data-testid="endpoint-block" />,
}));
vi.mock("../llm-key-block", () => ({
  WorkspaceLlmKeyBlock: () => <div data-testid="llm-key-block" />,
}));

import { I18nProvider } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { en } from "@/lib/i18n/dictionaries/en";
import { ModelsSection } from "../models-section";

const profile = {
  id: "profile-1",
  endpointId: "endpoint-1",
  workspaceId: "ws-1",
  selector: "custom:profile-1",
  name: "terra-high",
  modelId: "terra-high",
  contextWindow: 32768,
  maxOutputTokens: 4096,
  supportsTools: true,
  verifiedAt: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};
const endpoint = {
  id: "endpoint-1",
  workspaceId: "ws-1",
  name: "hinson-pro",
  baseUrl: "https://models.example/v1",
  hasApiKey: true,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  profiles: [profile],
};

function click(container: HTMLElement, predicate: (button: HTMLButtonElement) => boolean): void {
  const button = Array.from(container.querySelectorAll("button")).find(predicate);
  if (!button) throw new Error("button not found");
  button.click();
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchModelMenu.mockResolvedValue({
    classes: {},
    defaults: [],
    profiles: [],
    modelRoutes: [],
    meteredBillingAvailable: false,
  });
  getCustomLlmConfiguration.mockResolvedValue({ endpoints: [endpoint], tierDefaults: [] });
  updateCustomLlmProfile.mockResolvedValue({ ...profile, contextWindow: 1_048_576 });
});

describe("[COMP:app-web/models-settings] custom profile editing", () => {
  it("opens the profile editor and saves a reverified context-window update in place", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={en as unknown as Dictionary}>
          <ModelsSection />
        </I18nProvider>,
      );
    });

    await act(async () => {
      click(container, (button) => button.textContent === en.chrome.settingsModal.models.viewProviders);
    });
    await act(async () => {
      click(container, (button) => button.getAttribute("aria-label") === en.chrome.settingsModal.models.editProfileCta);
    });

    expect(container.textContent).toContain(en.chrome.settingsModal.models.customEditTitle);
    const numericInputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
    expect(numericInputs[0]?.value).toBe("32768");

    await act(async () => {
      changeInput(numericInputs[0]!, "1048576");
    });
    await act(async () => {
      click(container, (button) => button.textContent?.includes(en.chrome.settingsModal.models.updateProfileCta) ?? false);
    });

    expect(updateCustomLlmProfile).toHaveBeenCalledWith(
      "ws-1",
      "endpoint-1",
      "profile-1",
      {
        name: "terra-high",
        modelId: "terra-high",
        contextWindow: 1_048_576,
        maxOutputTokens: 4096,
      },
    );

    await act(async () => root.unmount());
  });
});
