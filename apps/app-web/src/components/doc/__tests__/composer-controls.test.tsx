// @vitest-environment jsdom
/**
 * [COMP:app-web/composer-controls] Shared composer footer controls.
 *
 * Two surfaces under test:
 *   1. **The presentational `<ComposerControls>`** — the research toggle's
 *      pressed state + click contract, the exhausted upgrade affordance, the
 *      remaining-quota pill, and the model trigger's active-tier label. Driven
 *      in jsdom (`createRoot` + `act`, no `@testing-library/react`) so the
 *      regression guard is the rendered DOM + the callback shape.
 *   2. **`useComposerControls`** — the one piece of real logic: folding a
 *      `research_quota` / `research_quota_exhausted` SSE event into the quota +
 *      exhausted state (and disarming research on exhaustion), mirroring the
 *      floating chat.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

// useComposerControls → useChatModelTier resolves the workspace plan via
// authFetch on mount; stub it to a not-ok response so no plan ever resolves
// (gating stays permissive) and no network is touched.
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(() =>
    Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  ),
}));

import {
  ComposerControls,
  useComposerControls,
  type ComposerControlsState,
} from "../composer-controls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

/** Baseline props: every control off, no quota, plan unresolved. The research
 *  toggle is opt-in (`showResearch` defaults to `false` — feed assistants keep
 *  it off), so the presentational research tests arm it explicitly, the same
 *  way the doc comment composers do now that doc research ships. */
function props(over: Partial<React.ComponentProps<typeof ComposerControls>> = {}) {
  return {
    model: "standard" as const,
    onModelChange: vi.fn(),
    plan: null,
    researchMode: false,
    onResearchModeChange: vi.fn(),
    researchQuota: null,
    researchExhausted: false,
    showResearch: true,
    ...over,
  };
}

describe("[COMP:app-web/composer-controls] presentational controls", () => {
  it("toggles research on click and reflects the pressed state", () => {
    const onResearchModeChange = vi.fn();
    mount(<ComposerControls {...props({ onResearchModeChange })} />);

    const toggle = container!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(toggle).toBeTruthy();
    // Off → not pressed, and the hint is the live (not exhausted) copy.
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe(dict.chat.researchHint);

    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // Stateless: it reports the *intended* next value (true), owner flips it.
    expect(onResearchModeChange).toHaveBeenCalledWith(true);
  });

  it("shows the remaining-quota pill when research is armed on a free plan", () => {
    mount(
      <ComposerControls
        {...props({ researchMode: true, researchQuota: { used: 1, quota: 5, isPaid: false } })}
      />,
    );
    // quota - used = 4 of 5.
    expect(container!.textContent).toContain("4/5");
  });

  it("becomes an upgrade affordance when research is exhausted (no toggle)", () => {
    const onResearchModeChange = vi.fn();
    mount(<ComposerControls {...props({ researchExhausted: true, onResearchModeChange })} />);
    const toggle = container!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(toggle.title).toBe(dict.chat.researchHintExhausted);
    // Clicking exhausted routes to /plans rather than flipping the mode — we
    // don't dispatch the click here (jsdom navigation is a no-op), but the
    // surfaced hint is the regression guard.
    expect(onResearchModeChange).not.toHaveBeenCalled();
  });

  it("labels the model trigger with the active tier", () => {
    mount(<ComposerControls {...props({ model: "pro" })} />);
    const trigger = container!.querySelector<HTMLButtonElement>(
      `[aria-label="${dict.chat.modelLabel}"]`,
    )!;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain(dict.chat.modelPro);
  });

  it("hides the research toggle when showResearch is off (feed / opted-out)", () => {
    mount(<ComposerControls {...props({ showResearch: false })} />);
    // No AI-reply toggle is wired here either, so there's no aria-pressed
    // control at all — the research toggle is genuinely absent, not just unset.
    expect(container!.querySelector("button[aria-pressed]")).toBeNull();
    expect(container!.textContent).not.toContain(dict.chat.research);
  });

  it("renders the AI-reply toggle only when onAiReplyChange is wired, and flips it", () => {
    const onAiReplyChange = vi.fn();
    mount(
      <ComposerControls
        {...props({ showResearch: false, aiReply: true, onAiReplyChange })}
      />,
    );
    const toggle = container!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-label")).toBe(dict.comments.aiReply);
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAiReplyChange).toHaveBeenCalledWith(false);
  });

  it("disables research + model controls when AI reply is off (they only shape an AI turn)", () => {
    mount(
      <ComposerControls
        {...props({ aiReply: false, onAiReplyChange: vi.fn() })}
      />,
    );
    // The research toggle is rendered (showResearch true) but disabled.
    const research = Array.from(
      container!.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes(dict.chat.research));
    expect(research).toBeTruthy();
    expect(research!.disabled).toBe(true);
    // The model picker trigger is disabled too.
    const trigger = container!.querySelector<HTMLButtonElement>(
      `[aria-label="${dict.chat.modelLabel}"]`,
    )!;
    expect(trigger.disabled).toBe(true);
  });
});

describe("[COMP:app-web/composer-controls] useComposerControls quota folding", () => {
  let latest: ComposerControlsState | null = null;

  function Harness() {
    latest = useComposerControls("ws1");
    return null;
  }

  afterEach(() => {
    latest = null;
  });

  it("records remaining quota from a research_quota event", () => {
    mount(<Harness />);
    expect(latest!.researchQuota).toBeNull();
    act(() =>
      latest!.applyResearchQuotaEvent({ type: "research_quota", used: 2, quota: 5, isPaid: false }),
    );
    expect(latest!.researchQuota).toEqual({ used: 2, quota: 5, isPaid: false });
    expect(latest!.researchExhausted).toBe(false);
  });

  it("disarms research and marks exhausted on research_quota_exhausted", () => {
    mount(<Harness />);
    act(() => latest!.setResearchMode(true));
    expect(latest!.researchMode).toBe(true);

    act(() =>
      latest!.applyResearchQuotaEvent({ type: "research_quota_exhausted", used: 5, quota: 5 }),
    );
    expect(latest!.researchExhausted).toBe(true);
    expect(latest!.researchMode).toBe(false);
    expect(latest!.researchQuota).toEqual({ used: 5, quota: 5, isPaid: false });
  });
});
