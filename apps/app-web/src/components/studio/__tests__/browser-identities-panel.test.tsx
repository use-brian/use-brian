import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  BrowserIdentityList,
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

function render(profiles: BrowserProfile[], drafts: Record<string, string> = {}) {
  return renderToString(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      <BrowserIdentityList
        profiles={profiles}
        assistantId="assistant-1"
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

  it("reveals the compact save action only after the note changes", () => {
    const enabled = profile("company", {
      enabledAssistantIds: ["assistant-1"],
      assistantRoutingNotes: { "assistant-1": "Old guidance" },
    });
    expect(render([enabled])).not.toContain("Save note");
    expect(render([enabled], { company: "New guidance" })).toContain("Save note");
  });
});
