// @vitest-environment jsdom
/** [COMP:app-web/decision-playbook] Scoped learned-rule governance cards. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ workspaceId: "workspace-1" }),
}));

import {
  DecisionPlaybookRuleCard,
  type DecisionPlaybookRuleView,
} from "../assistant-detail";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RULE: DecisionPlaybookRuleView = {
  id: "00000000-0000-4000-8000-000000000010",
  rule: "Show a draft before sending from this mailbox.",
  rationale: null,
  provenance: {
    sourceKinds: ["reviewed_email", "tool_denial"],
    firstEvidenceAt: "2026-08-20T00:00:00.000Z",
    lastEvidenceAt: "2026-08-25T00:00:00.000Z",
    rawBody: "must never render",
  },
  status: "suggested",
  createdBy: "decision_reflection",
  appliesToUserId: "00000000-0000-4000-8000-000000000011",
  applicabilityKind: "email",
  applicabilityKey: "primary",
  evidenceCount: 3,
  decidedByUserId: null,
};

let host: HTMLDivElement;
let root: Root;
const onDecision = vi.fn();

function render(rule: DecisionPlaybookRuleView, canDecide = true) {
  act(() => {
    root.render(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <DecisionPlaybookRuleCard
          rule={rule}
          canDecide={canDecide}
          deciding={false}
          onDecision={onDecision}
        />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("[COMP:app-web/decision-playbook] decision rule card", () => {
  it("shows minimized applicability/evidence provenance and member actions", () => {
    render(RULE);
    expect(host.textContent).toContain("Learned from your decisions");
    expect(host.textContent).toContain("Email: primary");
    expect(host.textContent).toContain("Evidence: 3");
    expect(host.textContent).toContain("Reviewed email, Tool decision");
    expect(host.textContent).not.toContain("must never render");

    const approve = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Approve");
    expect(approve).toBeTruthy();
    act(() => approve!.click());
    expect(onDecision).toHaveBeenCalledWith("approve");
  });

  it("lets the member retire an own active rule and keeps retired history read-only", () => {
    render({ ...RULE, status: "active" });
    const retire = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Retire");
    expect(retire).toBeTruthy();
    act(() => retire!.click());
    expect(onDecision).toHaveBeenCalledWith("retire");

    render({ ...RULE, status: "retired" }, false);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.textContent).toContain("Learned from your decisions");
  });
});

