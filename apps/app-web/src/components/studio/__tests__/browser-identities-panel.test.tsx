import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  BrowserIdentityList,
  clearanceCovers,
  manageableBrowserProfiles,
} from "../browser-identities-panel";
import type { BrowserProfile } from "@/lib/api/computer";

function profile(
  id: string,
  overrides: Partial<BrowserProfile> = {},
): BrowserProfile {
  return {
    id,
    workspaceId: "workspace-1",
    ownerUserId: "user-1",
    name: `Profile ${id}`,
    clearance: "confidential",
    enabledAssistantIds: [],
    assistantRoutingNotes: {},
    defaultBackend: "cloud",
    localControlMode: "task_tabs",
    proxyUrl: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    sessions: [],
    credentials: [],
    grants: [],
    canManage: true,
    ...overrides,
  };
}

function render(
  profiles: BrowserProfile[],
  drafts: Record<string, string> = {},
  assistantClearance?: "public" | "internal" | "confidential",
) {
  return renderToString(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      <BrowserIdentityList
        profiles={profiles}
        assistantId="assistant-1"
        assistantClearance={assistantClearance}
        drafts={drafts}
        savingId={null}
        savedId={null}
        errorId={null}
        onToggle={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/browser-identities] assistant browser identity selection", () => {
  it("keeps non-owner profiles out of the manageable roster", () => {
    const owned = profile("owned");
    const shared = profile("shared", { canManage: false });
    expect(manageableBrowserProfiles([owned, shared])).toEqual([owned]);
  });

  it("shows the acting assistant's note only while that profile is available", () => {
    const enabled = profile("company", {
      name: "Company Instagram",
      enabledAssistantIds: ["assistant-1"],
      assistantRoutingNotes: {
        "assistant-1": "Use for company social accounts.",
        "assistant-2": "Never reveal this note.",
      },
    });
    const disabled = profile("personal", {
      name: "Personal",
      assistantRoutingNotes: { "assistant-1": "Use for personal accounts." },
      defaultBackend: "local",
    });
    const html = render([enabled, disabled]);
    expect(html).toContain("Company Instagram");
    expect(html).toContain("Use for company social accounts.");
    expect(html).not.toContain("Never reveal this note.");
    expect(html).not.toContain("Use for personal accounts.");
    expect(html).toContain("Remote");
    expect(html).toContain("Local");
  });

  /**
   * 2026-08-19: toggling this switch ON wrote `enabledAssistantIds` and
   * reported success, but the runtime gate (`canUseProfile`) also requires the
   * assistant's clearance to cover the profile's rung. An `internal` assistant
   * enabled for a `confidential` profile was refused every turn while this
   * panel showed it as granted, so the user re-toggled it four times.
   */
  it("warns that enabling is not enough when the assistant's clearance is below the profile's rung", () => {
    const enabled = profile("work", {
      name: "hinson-work",
      clearance: "confidential",
      enabledAssistantIds: ["assistant-1"],
    });
    const html = render([enabled], {}, "internal");
    expect(html).toContain("Enabling is not enough");
    // Both sides of the mismatch, and both real remedies.
    expect(html).toContain("confidential");
    expect(html).toContain("internal");
    expect(html).toContain("Raise this assistant&#x27;s clearance");
    // The remedy must name the control the user will actually see. The profile
    // pane labels the rung in plain language ("Who can use it": Only me /
    // Cleared teammates), never "confidential" / "internal", so a remedy
    // phrased in tier words sends them hunting on the destination screen.
    expect(html).toContain("Who can use it");
    expect(html).toContain("Cleared teammates");
  });

  it("stays silent when the clearance covers the rung, and while the clearance is unknown", () => {
    const covered = profile("ok", { clearance: "internal", enabledAssistantIds: ["assistant-1"] });
    expect(render([covered], {}, "internal")).not.toContain("Enabling is not enough");
    expect(render([covered], {}, "confidential")).not.toContain("Enabling is not enough");
    // Undefined is the parent still loading, never a fabricated denial.
    const top = profile("top", { clearance: "confidential", enabledAssistantIds: ["assistant-1"] });
    expect(render([top])).not.toContain("Enabling is not enough");
  });

  it("clearanceCovers mirrors the runtime ladder", () => {
    expect(clearanceCovers("internal", "confidential")).toBe(false);
    expect(clearanceCovers("internal", "internal")).toBe(true);
    expect(clearanceCovers("internal", "public")).toBe(true);
    expect(clearanceCovers("public", "internal")).toBe(false);
    expect(clearanceCovers("confidential", "confidential")).toBe(true);
    expect(clearanceCovers(undefined, "confidential")).toBe(true);
  });

  it("reveals the compact save action only after the note changes", () => {
    const enabled = profile("company", {
      enabledAssistantIds: ["assistant-1"],
      assistantRoutingNotes: { "assistant-1": "Old guidance" },
    });
    expect(render([enabled])).not.toContain("Save note");
    expect(render([enabled], { company: "New guidance" })).toContain("Save note");
  });
});
