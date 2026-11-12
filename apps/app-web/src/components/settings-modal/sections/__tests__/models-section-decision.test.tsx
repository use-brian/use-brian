// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { resetSurfaceCache } from "@/lib/surface-cache";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { setWorkspaceDecisionRouting, type WorkspaceDecisionRouting } from "@/lib/api/models";
import { ModelsSection } from "../models-section";

// Inspect the section's actual menu contract without coupling policy tests to
// combobox portal/keyboard behavior, which belongs to the shared UI tests.
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({ items, value, onValueChange, "aria-label": label }: {
    items: Array<{ value: string; label: string; hint?: string; badge?: string }>;
    value: string; onValueChange: (value: string) => void; "aria-label"?: string;
  }) => <div aria-label={label} data-value={value}>{items.map(item =>
    <button key={item.value} data-route={item.value} onClick={() => onValueChange(item.value)}>
      {item.label}<span>{item.hint}</span><span>{item.badge}</span>
    </button>)}</div>,
}));

const t = en.chrome.settingsModal.models;
const alias = "typesafe-jev-1.13";
const approved = {
  operationId: "research.intent", operationVersion: "1", evaluationSegment: "global",
  profileId: "approved-research-intent", profileVersion: "1",
};
const model = {
  alias, displayName: "Jev 1.13", provider: "typesafe", adapterId: "typesafe",
  hybridOperations: [],
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  resetSurfaceCache();
  vi.mocked(confirmDialog).mockResolvedValue(false);
  vi.mocked(setWorkspaceDecisionRouting).mockResolvedValue({ mode: "hybrid", modelAlias: alias, updatedAt: "now" });
  getCustomLlmConfiguration.mockResolvedValue({ endpoints: [], tierDefaults: [] });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });

async function render(routing: Partial<WorkspaceDecisionRouting> = {}) {
  fetchModelMenu.mockResolvedValue({
    classes: {}, defaults: [], profiles: [], modelRoutes: [], meteredBillingAvailable: false,
    decisionRouting: {
      mode: "llm_only", modelAlias: null, updatedAt: null, operatorOverride: false,
      shadowSampleRate: 0.1, models: [model], ...routing,
    },
  });
  await act(async () => root.render(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}><ModelsSection /></I18nProvider>,
  ));
}
function choices(route: string) {
  return container.querySelectorAll<HTMLButtonElement>(`button[data-route="${route}"]`);
}
async function choose(route: string) {
  const button = choices(route)[0];
  expect(button).toBeDefined();
  await act(async () => button.click());
}

// Old response fixtures intentionally omit classifierFirst.
describe("[COMP:app-web/models-settings] workspace decision routing", () => {
  it.each([
    [alias, "Jev 1.13", 0.1, true],
    [alias, "Jev 1.13", 1, true],
    ["openai-decisions-gpt-6-luna", "GPT-6 Luna Decisions", 0.1, true],
    ["openai-decisions-gpt-6-luna", "GPT-6 Luna Decisions", 1, true],
    [alias, "Jev 1.13", 0.1, false],
    [alias, "Jev 1.13", 1, false],
    ["openai-decisions-gpt-6-luna", "GPT-6 Luna Decisions", 0.1, false],
    ["openai-decisions-gpt-6-luna", "GPT-6 Luna Decisions", 1, false],
  ] as const)("selects shadow %s (%s) at rate %s (confirm=%s)", async (selectedAlias, displayName, rate, confirmed) => {
    const openai = { ...model, alias: "openai-decisions-gpt-6-luna", displayName: "GPT-6 Luna Decisions",
      provider: "openai-decisions", adapterId: "openai-decisions" };
    await render({ models: [model, openai], mode: "shadow", modelAlias: selectedAlias, shadowSampleRate: rate === 1 ? 0.1 : 1 });
    for (const candidate of [model, openai]) {
      expect(choices(`hybrid:${candidate.alias}`)).toHaveLength(0);
      for (const sample of [0.1, 1]) {
        const option = choices(`shadow:${sample}:${candidate.alias}`);
        expect(option).toHaveLength(1);
        expect(option[0].textContent).toContain(t.decisionShadowOption.replace("{model}", candidate.displayName).replace("{percent}", String(sample * 100)));
      }
    }
    vi.mocked(confirmDialog).mockResolvedValueOnce(confirmed);
    await choose(`shadow:${rate}:${selectedAlias}`);
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith({
      title: t.decisionConfirmTitle,
      description: t.decisionConfirmBody.replace("{model}", displayName).replace("{percent}", String(rate * 100)),
      confirmLabel: t.decisionConfirmCta,
    });
    if (confirmed) {
      expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", {
        mode: "shadow", modelAlias: selectedAlias, shadowSampleRate: rate,
      });
      expect(fetchModelMenu).toHaveBeenCalledTimes(2);
    } else {
      expect(setWorkspaceDecisionRouting).not.toHaveBeenCalled();
      expect(fetchModelMenu).toHaveBeenCalledTimes(1);
      expect(container.querySelector(`[data-value="shadow:${rate === 1 ? 0.1 : 1}:${selectedAlias}"]`)).not.toBeNull();
    }
    expect(choices(`hybrid:${selectedAlias}`)).toHaveLength(0);
  });

  it.each([
    [alias, "Jev 1.13", true], [alias, "Jev 1.13", false],
    ["openai-decisions-gpt-6-luna", "GPT-6 Luna Decisions", true],
    ["openai-decisions-gpt-6-luna", "GPT-6 Luna Decisions", false],
  ] as const)("selects explicit classifier first without grant for %s (confirm=%s)", async (selectedAlias, displayName, confirmed) => {
    await render({ models: [{ ...model, alias: selectedAlias, displayName }] });
    const option = choices(`classifier_first:${selectedAlias}`);
    expect(option).toHaveLength(1);
    expect(option[0].textContent).toContain(t.decisionFirstOption.replace("{model}", displayName));
    expect(option[0].textContent).toContain(t.decisionWorkspaceFirstScope);
    vi.mocked(confirmDialog).mockResolvedValueOnce(confirmed);
    await choose(`classifier_first:${selectedAlias}`);
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith({
      title: t.decisionFirstConfirmTitle,
      description: t.decisionWorkspaceFirstConfirmBody.replace("{model}", displayName),
      confirmLabel: t.decisionFirstConfirmCta,
    });
    if (confirmed) {
      expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", { mode: "classifier_first", modelAlias: selectedAlias });
      expect(fetchModelMenu).toHaveBeenCalledTimes(2);
    } else {
      expect(setWorkspaceDecisionRouting).not.toHaveBeenCalled();
      expect(container.querySelector('[data-value="llm_only"]')).not.toBeNull();
    }
  });

  it.each([alias, "openai-decisions-gpt-6-luna", "unavailable-adapter"])("restores saved classifier_first for %s independently of grants", async (selectedAlias) => {
    await render({ mode: "classifier_first", modelAlias: selectedAlias, models: [model] });
    expect(container.querySelector(`[data-value="classifier_first:${selectedAlias}"]`)).not.toBeNull();
    expect(choices(`classifier_first:${selectedAlias}`)).toHaveLength(1);
    expect(container.textContent).toContain(t.decisionWorkspaceFirstBadge);
    expect(container.textContent).toContain(t.decisionWorkspaceFirstConfirmBody.replace("{model}", selectedAlias === alias ? model.displayName : selectedAlias));
    expect(container.textContent).not.toContain(t.decisionHybridFallbackBadge);
  });

  it.each([alias, "openai-decisions-gpt-6-luna"])("restores persisted 100%% shadow for %s without granting hybrid", async (selectedAlias) => {
    await render({ mode: "shadow", modelAlias: selectedAlias, shadowSampleRate: 1,
      models: [{ ...model, alias: selectedAlias }],
    });
    expect(container.querySelector(`[data-value="shadow:1:${selectedAlias}"]`)).not.toBeNull();
    expect(choices(`shadow:1:${selectedAlias}`)).toHaveLength(1);
    expect(choices(`shadow:0.1:${selectedAlias}`)).toHaveLength(1);
    expect(choices(`hybrid:${selectedAlias}`)).toHaveLength(0);
    expect(container.textContent).toContain(t.decisionShadowBadge.replace("{percent}", "100"));
  });

  it("defaults legacy shadow settings without a rate to 10%", async () => {
    await render({ mode: "shadow", modelAlias: alias, shadowSampleRate: undefined });
    expect(container.querySelector(`[data-value="shadow:0.1:${alias}"]`)).not.toBeNull();
    expect(container.textContent).toContain(t.decisionShadowBadge.replace("{percent}", "10"));
    expect(container.textContent).not.toContain("NaN");
  });

  it("offers explicit classifier first but not hybrid on availability alone", async () => {
    await render();
    expect(choices(`hybrid:${alias}`)).toHaveLength(0);
    expect(choices(`shadow:0.1:${alias}`)).toHaveLength(1);
    expect(container.textContent).toContain(t.decisionWorkspaceFirstAvailable);
    expect(choices(`classifier_first:${alias}`)).toHaveLength(1);
  });

  it.each([false, true])("requires confirmation for full routing without approvals (confirm=%s)", async (confirmed) => {
    await render({ models: [{ ...model, classifierFirst: { operationIds: ["research.intent", "chat.route"] } }] });
    const option = choices(`hybrid:${alias}`);
    expect(option).toHaveLength(1);
    expect(option[0].textContent).toContain(t.decisionLegacyHybridOption.replace("{model}", model.displayName));
    expect(option[0].textContent).toContain("research.intent, chat.route");
    expect(option[0].textContent).toContain(t.decisionFirstBadge);
    expect(container.textContent).toContain(t.decisionFirstAvailable);
    expect(container.textContent).not.toContain(t.decisionHybridGate);
    vi.mocked(confirmDialog).mockResolvedValueOnce(confirmed);
    await choose(`hybrid:${alias}`);
    expect(confirmDialog).toHaveBeenCalledWith({
      title: t.decisionFirstConfirmTitle,
      description: t.decisionFirstConfirmBody.replace("{model}", "Jev 1.13").replace("{scope}", "research.intent, chat.route"),
      confirmLabel: t.decisionFirstConfirmCta,
    });
    if (confirmed) {
      expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", { mode: "hybrid", modelAlias: alias });
      expect(fetchModelMenu).toHaveBeenCalledTimes(2);
    } else {
      expect(setWorkspaceDecisionRouting).not.toHaveBeenCalled();
      expect(fetchModelMenu).toHaveBeenCalledTimes(1);
    }
  });

  it.each([false, true])("grants full routing only to the exact OpenAI model, with Jev approved=%s", async (jevApproved) => {
    const openaiAlias = "openai-decisions-gpt-6-luna";
    const openai = {
      alias: openaiAlias, displayName: "GPT-6 Luna Decisions",
      provider: "openai-decisions", adapterId: "openai-decisions",
      hybridOperations: [approved], classifierFirst: { operationIds: ["research.intent"] },
    };
    await render({ models: [
      { ...model, hybridOperations: jevApproved ? [approved] : [], classifierFirst: null },
      openai,
    ] });
    const fullRouting = choices(`hybrid:${openaiAlias}`);
    expect(fullRouting).toHaveLength(1);
    expect(fullRouting[0].textContent).toContain(t.decisionLegacyHybridOption.replace("{model}", openai.displayName));
    expect(fullRouting[0].textContent).toContain("research.intent");
    expect(fullRouting[0].textContent).not.toContain("chat.route");
    expect(fullRouting[0].textContent).toContain(t.decisionFirstBadge);
    expect(choices(`shadow:0.1:${openaiAlias}`)).toHaveLength(1);
    expect(choices(`shadow:0.1:${alias}`)).toHaveLength(1);
    expect(choices(`shadow:0.1:${alias}`)[0].textContent).toContain("Jev 1.13");
    const jevHybrid = choices(`hybrid:${alias}`);
    expect(jevHybrid).toHaveLength(jevApproved ? 1 : 0);
    if (jevApproved) {
      expect(jevHybrid[0].textContent).toContain(t.decisionHybridBadge.replace("{count}", "1"));
      expect(jevHybrid[0].textContent).not.toContain("Classifier first (100%)");
    }
    expect(choices(`classifier_first:${openaiAlias}`)).toHaveLength(1);
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    await choose(`hybrid:${openaiAlias}`);
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith({
      title: t.decisionFirstConfirmTitle,
      description: t.decisionFirstConfirmBody.replace("{model}", openai.displayName).replace("{scope}", "research.intent"),
      confirmLabel: t.decisionFirstConfirmCta,
    });
    expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", { mode: "hybrid", modelAlias: openaiAlias });
  });

  it.each(["llm_only", "shadow"] as const)("rolls OpenAI full routing back to %s without changing the contract", async (mode) => {
    const openaiAlias = "openai-decisions-gpt-6-luna";
    await render({ mode: "hybrid", modelAlias: openaiAlias, operatorOverride: true,
      models: [model, {
        alias: openaiAlias, displayName: "GPT-6 Luna Decisions",
        provider: "openai-decisions", adapterId: "openai-decisions",
        hybridOperations: [], classifierFirst: { operationIds: ["research.intent"] },
      }],
    });
    expect(container.querySelector(`[data-value="hybrid:${openaiAlias}"]`)).not.toBeNull();
    expect(container.textContent).toContain(t.decisionFirstConfirmBody.replace("{model}", "GPT-6 Luna Decisions").replace("{scope}", "research.intent"));
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    await choose(mode === "llm_only" ? mode : `shadow:0.1:${openaiAlias}`);
    if (mode === "llm_only") {
      expect(confirmDialog).not.toHaveBeenCalled();
      expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", { mode });
    } else {
      expect(confirmDialog).toHaveBeenCalledExactlyOnceWith({
        title: t.decisionConfirmTitle,
        description: t.decisionConfirmBody.replace("{model}", "GPT-6 Luna Decisions").replace("{percent}", "10"),
        confirmLabel: t.decisionConfirmCta,
      });
      expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", { mode, modelAlias: openaiAlias, shadowSampleRate: 0.1 });
    }
  });

  it.each([null, "now"])("shows all-eligible scope and override, without duplicate approved choices (updatedAt=%s)", async (updatedAt) => {
    await render({ mode: "hybrid", modelAlias: alias, operatorOverride: true, updatedAt,
      models: [{ ...model, hybridOperations: [approved], classifierFirst: { operationIds: null } }],
    });
    expect(choices(`hybrid:${alias}`)).toHaveLength(1);
    expect(choices(`shadow:0.1:${alias}`)).toHaveLength(1);
    expect(container.textContent).toContain(t.decisionFirstAllEligible);
    expect(container.textContent).toContain(t.decisionFirstBadge);
    expect(container.textContent).not.toContain(t.decisionHybridAvailable.replace("{count}", "1"));
    expect(container.textContent).not.toContain(t.decisionHybridBadge.replace("{count}", "1"));
    expect(container.textContent).toContain("Your chat model is unchanged.");
  });

  it("keeps approved-only hybrid separate when full-routing capability is null", async () => {
    await render({ mode: "hybrid", modelAlias: alias,
      models: [{ ...model, hybridOperations: [approved], classifierFirst: null }],
    });
    expect(choices(`hybrid:${alias}`)).toHaveLength(1);
    expect(container.textContent).toContain(t.decisionHybridAvailable.replace("{count}", "1"));
    await choose(`hybrid:${alias}`);
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: t.decisionHybridConfirmTitle }));
  });

  it("retains shadow confirmation and sampled routing", async () => {
    await render({ mode: "shadow", modelAlias: alias,
      models: [{ ...model, classifierFirst: { operationIds: null } }],
    });
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    await choose(`shadow:0.1:${alias}`);
    expect(confirmDialog).toHaveBeenCalledWith({
      title: t.decisionConfirmTitle,
      description: t.decisionConfirmBody.replace("{model}", "Jev 1.13").replace("{percent}", "10"),
      confirmLabel: t.decisionConfirmCta,
    });
    expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", { mode: "shadow", modelAlias: alias, shadowSampleRate: 0.1 });
  });

  it("retains legacy operator_hybrid deployment-default display", async () => {
    await render({ mode: "hybrid", modelAlias: alias, operatorOverride: true });
    expect(choices(`hybrid:${alias}`)).toHaveLength(1);
    expect(container.textContent).toContain(t.decisionOperatorOverrideNotice);
    expect(container.textContent).toContain(t.decisionOperatorOverrideBadge);
    expect(choices(`hybrid:${alias}`)[0].textContent).not.toContain("Classifier first (100%)");
  });

  it("retains revoked hybrid selections", async () => {
    await render({ mode: "hybrid", modelAlias: alias });
    expect(choices(`hybrid:${alias}`)).toHaveLength(1);
    expect(container.textContent).toContain(t.decisionHybridRevokedHint);
  });

  it("retains unavailable model selections", async () => {
    await render({ mode: "hybrid", modelAlias: "missing-jev" });
    expect(choices("hybrid:missing-jev")).toHaveLength(1);
    expect(container.textContent).toContain(t.decisionUnavailableModelHint);
  });

  it("opts out via the unchanged llm_only request, without classifier confirmation", async () => {
    await render({ mode: "hybrid", modelAlias: alias, operatorOverride: true,
      models: [{ ...model, classifierFirst: { operationIds: null } }],
    });
    await choose("llm_only");
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(setWorkspaceDecisionRouting).toHaveBeenCalledExactlyOnceWith("ws-1", { mode: "llm_only" });
  });
});
