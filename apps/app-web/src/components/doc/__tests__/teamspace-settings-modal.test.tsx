// @vitest-environment jsdom
/**
 * [COMP:app-web/teamspace-settings] General tab autosave.
 *
 * The settings dialog writes name and description after a short pause, and
 * again on blur or close. There is no Save changes button. Driven in jsdom
 * (`createRoot` + `act`) with the teamspace API mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Teamspace } from "@/lib/api/teamspaces";
import {
  TEAMSPACE_AUTOSAVE_MS,
  TeamspaceSettingsModal,
  teamspaceSettingsPatch,
} from "../teamspace-settings-modal";

const updateTeamspace = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
  ...teamspace,
  ...patch,
}));

vi.mock("@/lib/api/teamspaces", () => ({
  updateTeamspace: (...args: unknown[]) => updateTeamspace(...args),
  listTeamspaceMembers: vi.fn(async () => []),
  addTeamspaceMember: vi.fn(),
  removeTeamspaceMember: vi.fn(),
  deleteTeamspace: vi.fn(),
  createTeamspace: vi.fn(),
}));

vi.mock("@/lib/api/context-scopes", () => ({
  listContextTeams: vi.fn(async () => []),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const teamspace: Teamspace = {
  id: "ts-1",
  workspaceId: "ws-1",
  name: "Product",
  icon: null,
  description: "Holds the roadmap",
  sensitivity: "internal",
  workspaceGroupId: null,
  isDefault: false,
  position: 1,
  memberCount: 2,
  canManage: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function field(placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  const node = document.querySelector(`[placeholder="${placeholder}"]`);
  if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
    throw new Error(`missing field ${placeholder}`);
  }
  return node;
}

async function setField(placeholder: string, value: string) {
  const node = field(placeholder);
  const prototype = node instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blurField(placeholder: string) {
  const node = field(placeholder);
  await act(async () => {
    node.focus();
    node.blur();
  });
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <TeamspaceSettingsModal
          workspaceId="ws-1"
          teamspace={teamspace}
          initialTab="general"
          open
          onOpenChange={() => {}}
          onChanged={() => {}}
        />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  updateTeamspace.mockClear();
  updateTeamspace.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...teamspace,
    ...patch,
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

describe("[COMP:app-web/teamspace-settings] teamspaceSettingsPatch", () => {
  const saved = {
    name: "Product",
    icon: null,
    description: "Holds the roadmap",
    sensitivity: "internal" as const,
    workspaceGroupId: null,
  };

  it("omits a blank name and still includes other dirty fields", () => {
    expect(teamspaceSettingsPatch(saved, { ...saved, name: "   " })).toBeNull();
    expect(
      teamspaceSettingsPatch(saved, {
        ...saved,
        name: " ",
        description: "New notes",
        sensitivity: "confidential",
        icon: "📦",
        workspaceGroupId: "team-1",
      }),
    ).toEqual({
      description: "New notes",
      sensitivity: "confidential",
      icon: "📦",
      workspaceGroupId: "team-1",
    });
  });

  it("trims text and ignores an unchanged draft", () => {
    expect(teamspaceSettingsPatch(saved, { ...saved, name: " Product " })).toBeNull();
    expect(teamspaceSettingsPatch(saved, { ...saved, name: "Design" })).toEqual({
      name: "Design",
    });
  });
});

describe("[COMP:app-web/teamspace-settings] General tab autosave", () => {
  beforeEach(async () => {
    await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("saves a name edit after the pause and does not offer Save changes", async () => {
    expect(document.body.textContent).not.toContain("Save changes");
    expect(document.body.textContent).toContain(en.docPage.teamspaceMenuDelete);

    await setField(en.docPage.teamspaceNamePlaceholder, "Design");
    expect(document.body.textContent).toContain(en.docPage.teamspaceSaving);
    expect(updateTeamspace).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEAMSPACE_AUTOSAVE_MS - 1);
    });
    expect(updateTeamspace).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(updateTeamspace).toHaveBeenCalledTimes(1);
    expect(updateTeamspace).toHaveBeenCalledWith("ts-1", { name: "Design" });
    expect(field(en.docPage.teamspaceNamePlaceholder).value).toBe("Design");
    expect(document.body.textContent).toContain(en.docPage.teamspaceSavedNotice);
  });

  it("flushes a description edit on blur without waiting out the pause", async () => {
    await setField(en.docPage.teamspaceDescriptionPlaceholder, "Launch notes");
    expect(updateTeamspace).not.toHaveBeenCalled();
    await blurField(en.docPage.teamspaceDescriptionPlaceholder);
    expect(updateTeamspace).toHaveBeenCalledTimes(1);
    expect(updateTeamspace).toHaveBeenCalledWith("ts-1", { description: "Launch notes" });
  });

  it("writes a pending edit when the dialog closes", async () => {
    await setField(en.docPage.teamspaceNamePlaceholder, "Design");
    expect(updateTeamspace).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = null;
    expect(updateTeamspace).toHaveBeenCalledTimes(1);
    expect(updateTeamspace).toHaveBeenCalledWith("ts-1", { name: "Design" });
  });

  it("does not write a cleared name", async () => {
    await setField(en.docPage.teamspaceNamePlaceholder, "   ");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEAMSPACE_AUTOSAVE_MS);
    });
    expect(updateTeamspace).not.toHaveBeenCalled();
  });
});
