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
  setWorkspaceDecisionRouting: vi.fn(),
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
import { clearWorkspaceModelRoute, setWorkspaceModelRoute, type MenuModel } from "@/lib/api/models";
import { resetSurfaceCache } from "@/lib/surface-cache";
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
  supportsVision: false,
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
  // The section paints from the module-level surface cache: each render
  // below must fetch fresh, not paint the previous render's rows.
  resetSurfaceCache();
  fetchModelMenu.mockResolvedValue({
    classes: {},
    defaults: [],
    profiles: [],
    modelRoutes: [],
    decisionRouting: {
      mode: "llm_only",
      modelAlias: null,
      updatedAt: null,
      operatorOverride: false,
      shadowSampleRate: 0.1,
      models: [{
        alias: "typesafe-jev-1.13",
        displayName: "Jev 1.13",
        provider: "typesafe",
        adapterId: "typesafe",
        hybridOperations: [],
      }],
    },
    meteredBillingAvailable: false,
  });
  getCustomLlmConfiguration.mockResolvedValue({ endpoints: [endpoint], tierDefaults: [] });
  updateCustomLlmProfile.mockResolvedValue({ ...profile, contextWindow: 1_048_576 });
});

describe("[COMP:app-web/models-settings] workspace tier routing", () => {
  const t = en.chrome.settingsModal.models;
  const model: MenuModel = {
    alias: "fixture-pro", apiModelId: "fixture-wire", displayName: "Fixture Chat",
    provider: "openai-codex", class: "standard-pro", tier: "pro", contextWindow: 32000,
    capabilities: { tools: true, vision: false, thinking: false }, metered: false,
  };
  const classes = { "standard-pro": [model] };
  const baseMenu = { classes, defaults: [], profiles: [], modelRoutes: [], meteredBillingAvailable: false };

  async function openTier(container: HTMLElement, label: string) {
    const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  }

  it("saves a cross-tier managed route, renders its exact saved alias, and restores Auto", async () => {
    const menu = {
      ...baseMenu,
      managedRouteModels: { standard: [model], pro: [model], max: [model], research: [model] },
    };
    fetchModelMenu.mockResolvedValueOnce(menu)
      .mockResolvedValueOnce({ ...menu, modelRoutes: [{ tier: "standard", modelAlias: model.alias }] })
      .mockResolvedValue(menu);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider locale="en" dict={en}><ModelsSection /></I18nProvider>));
      const options = await openTier(container, t.classStandard);
      const matches = options.filter((option) => option.textContent?.includes(model.displayName));
      expect(matches).toHaveLength(1);
      await act(async () => matches[0].click());
      expect(setWorkspaceModelRoute).toHaveBeenCalledWith("ws-1", "standard", { modelAlias: model.alias });
      expect(container.querySelector(`button[aria-label="${t.classStandard}"]`)?.textContent).toContain(model.displayName);
      const auto = (await openTier(container, t.classStandard)).find((option) => option.textContent?.startsWith(t.autoRouting));
      expect(auto).toBeDefined();
      await act(async () => auto!.click());
      expect(clearWorkspaceModelRoute).toHaveBeenCalledWith("ws-1", "standard");
      expect(container.querySelector(`button[aria-label="${t.classStandard}"]`)?.textContent).toContain(t.autoRouting);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it.each([
    ["hosted routes", { ...baseMenu, managedRouteModels: { standard: [], pro: [model], max: [], research: [] } }],
    ["older servers", baseMenu],
  ])("respects tier availability for %s and retains an unavailable saved alias", async (_case, menu) => {
    fetchModelMenu.mockResolvedValue({
      ...menu, modelRoutes: [{ tier: "standard", modelAlias: "unavailable", modelDisplayName: "Offline Model" }],
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider locale="en" dict={en}><ModelsSection /></I18nProvider>));
      const options = await openTier(container, t.classStandard);
      expect(options.some((option) => option.textContent?.includes(model.displayName))).toBe(false);
      expect(options.some((option) => option.textContent?.includes(t.unavailableModel.replace("{model}", "Offline Model")))).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("[COMP:app-web/models-settings] custom profile editing", () => {
  it("renders the workspace decision classifier separately from tier routing", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={en as unknown as Dictionary}>
          <ModelsSection />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain(en.chrome.settingsModal.models.decisionRoutingTitle);
    expect(container.textContent).toContain(en.chrome.settingsModal.models.decisionLlmOnly);
    expect(container.textContent).toContain(en.chrome.settingsModal.models.decisionWorkspaceFirstAvailable);
    await act(async () => root.unmount());
  });

  it("shows the exact approved-operation count for a hybrid workspace", async () => {
    fetchModelMenu.mockResolvedValueOnce({
      classes: {},
      defaults: [],
      profiles: [],
      modelRoutes: [],
      decisionRouting: {
        mode: "hybrid",
        modelAlias: "typesafe-jev-1.13",
        updatedAt: "now",
        operatorOverride: false,
        shadowSampleRate: 0.1,
        models: [{
          alias: "typesafe-jev-1.13",
          displayName: "Jev 1.13",
          provider: "typesafe",
          adapterId: "typesafe",
          hybridOperations: [{
            operationId: "research.intent",
            operationVersion: "1",
            evaluationSegment: "global",
            profileId: "approved-research-intent",
            profileVersion: "1",
          }],
        }],
      },
      meteredBillingAvailable: false,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={en as unknown as Dictionary}>
          <ModelsSection />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain(
      en.chrome.settingsModal.models.decisionHybridAvailable.replace("{count}", "1"),
    );
    expect(container.textContent).toContain(
      en.chrome.settingsModal.models.decisionHybridBadge.replace("{count}", "1"),
    );
    await act(async () => root.unmount());
  });

  it("labels an inherited Jev operator override as the deployment default", async () => {
    fetchModelMenu.mockResolvedValueOnce({
      classes: {},
      defaults: [],
      profiles: [],
      modelRoutes: [],
      decisionRouting: {
        mode: "hybrid",
        modelAlias: "typesafe-jev-1.13",
        updatedAt: null,
        operatorOverride: true,
        shadowSampleRate: 0.1,
        models: [{
          alias: "typesafe-jev-1.13",
          displayName: "Jev 1.13",
          provider: "typesafe",
          adapterId: "typesafe",
          hybridOperations: [],
        }],
      },
      meteredBillingAvailable: false,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={en as unknown as Dictionary}>
          <ModelsSection />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain(en.chrome.settingsModal.models.decisionOperatorOverrideBadge);
    expect(container.textContent).toContain(en.chrome.settingsModal.models.decisionOperatorOverrideNotice);
    expect(container.textContent).not.toContain(en.chrome.settingsModal.models.decisionHybridGate);
    await act(async () => root.unmount());
  });

  // A profile verified before the vision probe existed reads `false`, and the
  // only way a workspace admin can learn that (or fix it) is if the row says
  // so: image turns on this endpoint are answered by a built-in model, and
  // re-saving the profile is what re-runs the probe.
  it("says whether the endpoint reads images, and how to re-check", async () => {
    const render = async () => {
      resetSurfaceCache();
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
      return container;
    };

    const sightless = await render();
    expect(sightless.textContent).toContain(en.chrome.settingsModal.models.textOnly);
    expect(sightless.textContent).not.toContain(en.chrome.settingsModal.models.readsImages);

    getCustomLlmConfiguration.mockResolvedValue({
      endpoints: [{ ...endpoint, profiles: [{ ...profile, supportsVision: true }] }],
      tierDefaults: [],
    });
    const seeing = await render();
    expect(seeing.textContent).toContain(en.chrome.settingsModal.models.readsImages);
  });

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
