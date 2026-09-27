// @vitest-environment jsdom
/**
 * [COMP:app-web/goals-board] + [COMP:app-web/triage-panel] paint from the
 * surface cache (instant-navigation contract N1 / N3).
 *
 * Report E "Worst offenders" #7: both panels used to `setRows(null)` on every
 * open and paint "Loading…" until `listGoals` answered, and stayed live only
 * through a local `refetchTick` the acting tab bumped. They now read one
 * cache slot each (`goals:<wid>:<viewer>:<status>`, `triage:<wid>:<viewer>`),
 * paint the last-known rows on the first frame, and revalidate behind the
 * paint when the `goal` primitive marks the family stale. The detail pane
 * opens on the list row's title while its own slot is cold.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { GoalRow } from "@/lib/api/goals";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { goalsCacheKey, triageCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaces: () => ({ activeId: "w1", workspaces: [], active: null }),
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));

const api = vi.hoisted(() => ({ listGoals: vi.fn(), getGoalDetail: vi.fn() }));
vi.mock("@/lib/api/goals", () => ({
  listGoals: (...args: unknown[]) => api.listGoals(...args),
  getGoalDetail: (...args: unknown[]) => api.getGoalDetail(...args),
  confirmGoal: vi.fn(),
  workGoal: vi.fn(),
  abandonGoal: vi.fn(),
}));

import { AutopilotPanel } from "../autopilot-panel";
import { TriagePanel } from "../triage-panel";

const dict = en as unknown as Dictionary;

const row = (id: string, outcome: string, confirmed: boolean): GoalRow => ({
  id,
  outcome,
  status: "active",
  host: null,
  hostTitle: confirmed ? null : `Task for ${id}`,
  parentGoalId: null,
  recipeId: null,
  blockerReason: null,
  contextGroupId: null,
  contextProjectId: null,
  confirmedAt: confirmed ? "2026-09-01T00:00:00.000Z" : null,
  hasWorkflow: false,
  originSessionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const pending = () => new Promise<never>(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>);
    await settle();
  });
}

beforeEach(() => {
  resetSurfaceCache();
  api.listGoals.mockReset();
  api.getGoalDetail.mockReset();
  api.getGoalDetail.mockReturnValue(pending());
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

for (const [name, node, key, confirmed, loadingCopy] of [
  ["Autopilot", <AutopilotPanel key="a" />, goalsCacheKey("w1", "all"), true, en.goalsPage.loading],
  ["Triage", <TriagePanel key="t" />, triageCacheKey("w1"), false, en.triagePage.loading],
] as const) {
  describe(`[COMP:app-web/goals-board] ${name} panel paints from the surface cache`, () => {
    it("first paint renders the warmed rows while the fetch is still pending (no skeleton, no Loading text)", async () => {
      await loadSurfaceCache(key, async () => [row("g1", "Ship the launch page", confirmed)]);
      markSurfaceCacheStale(key);
      api.listGoals.mockReturnValue(pending());

      await mount(node);

      const list = host!.firstElementChild!.children[0] as HTMLElement;
      expect(list.textContent).toContain("Ship the launch page");
      expect(list.querySelector("[aria-busy]")).toBeNull();
      expect(host!.textContent).not.toContain(loadingCopy);
      expect(api.listGoals).toHaveBeenCalledTimes(1);
      // The detail pane opens on the row's title while its own slot is cold -
      // never a "Loading…" line.
      const detail = host!.firstElementChild!.children[1] as HTMLElement;
      expect(detail.textContent).toContain("Ship the launch page");
    });

    it("a cold cache paints a skeleton, never a Loading sentence (N4)", async () => {
      api.listGoals.mockReturnValue(pending());
      await mount(node);
      const list = host!.firstElementChild!.children[0] as HTMLElement;
      expect(list.querySelector("[aria-busy]")).not.toBeNull();
      expect(host!.textContent).not.toContain(loadingCopy);
    });

    it("the goal primitive's mark-stale repaints behind the paint", async () => {
      await loadSurfaceCache(key, async () => [row("g1", "Ship the launch page", confirmed)]);
      await mount(node);
      expect(host!.textContent).toContain("Ship the launch page");

      let resolveList: (rows: GoalRow[]) => void = () => {};
      api.listGoals.mockReturnValue(
        new Promise<GoalRow[]>((resolve) => {
          resolveList = resolve;
        }),
      );
      // The families `staleMarksFor(GOAL_REFRESH_EVENT)` marks.
      await act(async () => {
        markSurfaceCacheStale("goals:w1");
        markSurfaceCacheStale("triage:w1");
        await settle();
      });
      expect(host!.textContent).toContain("Ship the launch page");
      expect(host!.firstElementChild!.children[0].querySelector("[aria-busy]")).toBeNull();

      await act(async () => {
        resolveList([row("g1", "Ship the launch page, then announce it", confirmed)]);
        await settle();
      });
      expect(host!.textContent).toContain("Ship the launch page, then announce it");
    });
  });
}

describe('[COMP:app-web/goals-board] source permission recovery', () => {
  it('opens department access without resuming a blocked goal', async () => {
    const blocked={...row('g1','Authorized fixture goal',true),status:'blocked',blockerReason:'goal_source_scope_unavailable'}
    api.listGoals.mockResolvedValue([blocked])
    api.getGoalDetail.mockResolvedValue({...blocked,doneWhen:{kind:'subtasks'},means:{},budget:{},policy:{},completionClaim:null,brief:null})
    const events:unknown[]=[]
    const listener=(event:Event)=>events.push((event as CustomEvent).detail)
    window.addEventListener('doc:open-settings',listener)
    try {
      await mount(<AutopilotPanel />)
      expect(host!.textContent).toContain(en.goalsPage.detail.sourceAccessChanged)
      expect(host!.textContent).not.toContain('goal_source_scope_unavailable')
      const button=Array.from(host!.querySelectorAll('button')).find(button=>button.textContent===en.goalsPage.detail.reviewDepartmentAccess)!
      await act(async()=>{button.click();await settle()})
      expect(events).toEqual([{section:'ws-access'}])
      const {workGoal}=await import('@/lib/api/goals')
      expect(workGoal).not.toHaveBeenCalled()
    }finally{window.removeEventListener('doc:open-settings',listener)}
  })
})
