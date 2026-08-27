// @vitest-environment jsdom

/**
 * [COMP:app-web/tasks-surface] Task peek creation audit + icon trigger.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { TaskRow } from "@/lib/api/tasks";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const brainApi = vi.hoisted(() => ({ explainBrainRow: vi.fn() }));
const dialogs = vi.hoisted(() => ({ promptDialog: vi.fn() }));

vi.mock("@/lib/api/brain-inbox", () => ({
  explainBrainRow: brainApi.explainBrainRow,
}));

vi.mock("@/components/ui/prompt-dialog", () => ({
  promptDialog: dialogs.promptDialog,
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/components/operator/resizable-peek", () => ({
  ResizablePeek: ({ children }: { children: React.ReactNode }) => (
    <aside>{children}</aside>
  ),
}));

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({ trigger }: { trigger: React.ReactElement }) => trigger,
}));

vi.mock("@/components/brain/property-field", () => ({
  PageTitle: ({ value }: { value: string }) => <h2>{value}</h2>,
  SelectProperty: () => null,
  DateProperty: () => null,
  PersonProperty: () => null,
  EditableBody: () => null,
  StaticProperty: ({ label, value }: { label: string; value: string }) => (
    <div data-property={label}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
}));

import { TaskRecordDetail } from "../task-record-detail";

const SAVED_AT = "2026-06-01T08:00:00.000Z";
const row: TaskRow = {
  id: "task-1",
  title: "Ship the deck",
  status: "todo",
  assigneeId: null,
  due: null,
  tags: [],
  parentId: null,
  attributes: { icon: "🚀" },
  updatedAt: "2026-08-05T01:00:00.000Z",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  brainApi.explainBrainRow.mockReset().mockResolvedValue({
    savedAt: SAVED_AT,
    savedByAssistantId: "assistant-1",
    savedByAssistantName: "Brian",
    sourceSessionId: "session-1",
    sourceEpisodeId: null,
    messages: [],
    origin: {
      kind: "chat",
      source: "user",
      channelType: "telegram",
      workflowId: null,
      episode: null,
      createdByUserId: "user-1",
      createdByUserName: "Hinson",
    },
  });
  dialogs.promptDialog.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/tasks-surface] task peek creation audit", () => {
  it("shows the assigned icon plus original Created at/by provenance", async () => {
    await act(async () => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <TaskRecordDetail
            workspaceId="workspace-1"
            row={row}
            roster={[]}
            projects={[]}
            commitField={vi.fn().mockResolvedValue({ ok: true })}
            commitProject={vi.fn().mockResolvedValue({ ok: true })}
            onDelete={vi.fn().mockResolvedValue({ ok: true })}
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(brainApi.explainBrainRow).toHaveBeenCalledWith(
      "workspace-1",
      "task",
      "task-1",
    );
    expect(container!.querySelector('[aria-label="Change task icon"]')?.textContent)
      .toContain("🚀");
    expect(container!.querySelector('[data-property="Created at"]')?.textContent)
      .toContain(new Date(SAVED_AT).toLocaleString());
    expect(container!.querySelector('[data-property="Created by"]')?.textContent)
      .toContain("Saved from a Telegram conversation.");
  });

  it("deletes with a reason and explicit active-rule consent", async () => {
    dialogs.promptDialog.mockResolvedValue(
      "Discussion about an active task is not a new commitment",
    );
    const onDelete = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    await act(async () => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <TaskRecordDetail
            workspaceId="workspace-1"
            row={row}
            roster={[]}
            projects={[]}
            commitField={vi.fn().mockResolvedValue({ ok: true })}
            commitProject={vi.fn().mockResolvedValue({ ok: true })}
            onDelete={onDelete}
            onClose={onClose}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Delete task"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dialogs.promptDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete task and teach Brian",
        confirmLabel: "Delete and add rule",
      }),
    );
    expect(onDelete).toHaveBeenCalledWith(
      "Discussion about an active task is not a new commitment",
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("deletes without teaching anything when the reason is left blank", async () => {
    // "" is the empty-but-confirmed answer (null is still cancel).
    dialogs.promptDialog.mockResolvedValue("");
    const onDelete = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    await act(async () => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <TaskRecordDetail
            workspaceId="workspace-1"
            row={row}
            roster={[]}
            projects={[]}
            commitField={vi.fn().mockResolvedValue({ ok: true })}
            commitProject={vi.fn().mockResolvedValue({ ok: true })}
            onDelete={onDelete}
            onClose={onClose}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Delete task"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dialogs.promptDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        allowEmpty: true,
        multiline: true,
        emptyConfirmLabel: "Delete task",
      }),
    );
    expect(onDelete).toHaveBeenCalledWith("");
    expect(container!.textContent).not.toContain("Enter at least 3 characters.");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("still rejects a too-short reason", async () => {
    dialogs.promptDialog.mockResolvedValue("no");
    const onDelete = vi.fn().mockResolvedValue({ ok: true });
    await act(async () => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <TaskRecordDetail
            workspaceId="workspace-1"
            row={row}
            roster={[]}
            projects={[]}
            commitField={vi.fn().mockResolvedValue({ ok: true })}
            commitProject={vi.fn().mockResolvedValue({ ok: true })}
            onDelete={onDelete}
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Delete task"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onDelete).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("Enter at least 3 characters.");
  });
});
