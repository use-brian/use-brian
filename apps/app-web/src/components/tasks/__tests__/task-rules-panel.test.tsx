// @vitest-environment jsdom

/** [COMP:app-web/task-rules] Tasks-owned rule and rejection settings. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { TaskRule, TaskTombstone } from "@/lib/api/task-guardrails";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const guardrailApi = vi.hoisted(() => ({
  loadTaskRules: vi.fn(),
  loadTaskTombstones: vi.fn(),
  setTaskRuleStatus: vi.fn(),
  deleteTaskRule: vi.fn(),
  deleteTaskTombstone: vi.fn(),
}));

vi.mock("@/lib/api/task-guardrails", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/task-guardrails")>();
  return { ...actual, ...guardrailApi };
});

import { TaskRulesPanel } from "../task-rules-panel";

const rule: TaskRule = {
  id: "rule-1",
  workspaceId: "workspace-1",
  status: "active",
  effect: "deny",
  predicate: { title_matches: ["standup"] },
  nlClause: "Stop making tasks out of standup chatter",
  reason: null,
  origin: "user",
  createdAt: "2026-07-29T04:16:30.000Z",
};

const tombstone: TaskTombstone = {
  id: "tombstone-1",
  title: "Post the daily standup",
  reason: "This was chatter, not a commitment",
  sourceKind: "slack_thread",
  lane: "extracted",
  createdAt: "2026-07-29T04:16:30.000Z",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  guardrailApi.loadTaskRules.mockReset().mockResolvedValue([rule]);
  guardrailApi.loadTaskTombstones.mockReset().mockResolvedValue([tombstone]);
  guardrailApi.setTaskRuleStatus.mockReset().mockImplementation(
    async (_workspaceId: string, _ruleId: string, status: TaskRule["status"]) => ({
      ...rule,
      status,
    }),
  );
  guardrailApi.deleteTaskRule.mockReset();
  guardrailApi.deleteTaskTombstone.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderPanel(onClose = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <TaskRulesPanel workspaceId="workspace-1" onClose={onClose} />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return onClose;
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

describe("[COMP:app-web/task-rules] Task rules settings panel", () => {
  it("reviews workspace rules and rejection memory inside Tasks", async () => {
    const onClose = await renderPanel();

    expect(container!.querySelector('aside[aria-label="Task rules"]')).toBeTruthy();
    expect(container!.textContent).toContain(rule.nlClause);
    expect(container!.textContent).toContain(tombstone.title);
    expect(container!.textContent).toContain(tombstone.reason);

    await act(async () => {
      buttonNamed("Turn off").click();
      await Promise.resolve();
    });
    expect(guardrailApi.setTaskRuleStatus).toHaveBeenCalledWith(
      "workspace-1",
      "rule-1",
      "disabled",
    );

    await act(async () => {
      (container!.querySelector('[aria-label="Close"]') as HTMLButtonElement).click();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
