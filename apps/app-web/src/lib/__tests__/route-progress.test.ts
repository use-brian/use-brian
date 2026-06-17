import { describe, it, expect, beforeEach } from "vitest";
import { routeProgress, isInternalNavigation } from "../route-progress";

const ORIGIN = "https://app.sidan.ai";
const HOME = `${ORIGIN}/w/team-1/p`;

describe("[COMP:app-web/route-progress] routeProgress store", () => {
  beforeEach(() => {
    // Reset the module-level flag between tests.
    routeProgress.done();
  });

  it("starts idle and reports via getSnapshot", () => {
    expect(routeProgress.getSnapshot()).toBe(false);
  });

  it("getServerSnapshot is always idle (no SSR navigation)", () => {
    routeProgress.start();
    expect(routeProgress.getServerSnapshot()).toBe(false);
    routeProgress.done();
  });

  it("start() flips active and notifies subscribers; done() flips back", () => {
    const seen: boolean[] = [];
    const unsubscribe = routeProgress.subscribe(() =>
      seen.push(routeProgress.getSnapshot()),
    );

    routeProgress.start();
    expect(routeProgress.getSnapshot()).toBe(true);
    routeProgress.done();
    expect(routeProgress.getSnapshot()).toBe(false);

    expect(seen).toEqual([true, false]);
    unsubscribe();
  });

  it("start()/done() are idempotent — no duplicate emissions", () => {
    let emissions = 0;
    const unsubscribe = routeProgress.subscribe(() => {
      emissions += 1;
    });

    routeProgress.start();
    routeProgress.start(); // already active → no emit
    routeProgress.done();
    routeProgress.done(); // already idle → no emit

    expect(emissions).toBe(2);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    let emissions = 0;
    const unsubscribe = routeProgress.subscribe(() => {
      emissions += 1;
    });
    routeProgress.start();
    unsubscribe();
    routeProgress.done();
    expect(emissions).toBe(1);
  });
});

describe("[COMP:app-web/route-progress] isInternalNavigation classifier", () => {
  const base = {
    target: null,
    hasDownload: false,
    origin: ORIGIN,
    currentUrl: HOME,
  };

  it("fires for a same-origin link to a different pathname", () => {
    expect(
      isInternalNavigation({ ...base, href: `${ORIGIN}/w/team-1/brain` }),
    ).toBe(true);
  });

  it("ignores a same-pathname query-only change (done() keys on pathname)", () => {
    expect(
      isInternalNavigation({ ...base, href: `${HOME}?tab=2`, currentUrl: HOME }),
    ).toBe(false);
  });

  it("ignores a no-op click on the current page", () => {
    expect(isInternalNavigation({ ...base, href: HOME })).toBe(false);
  });

  it("ignores a same-page hash jump", () => {
    expect(isInternalNavigation({ ...base, href: `${HOME}#section` })).toBe(
      false,
    );
  });

  it("ignores an external origin", () => {
    expect(
      isInternalNavigation({ ...base, href: "https://example.com/x" }),
    ).toBe(false);
  });

  it("ignores mailto:/tel: protocols", () => {
    expect(
      isInternalNavigation({ ...base, href: "mailto:hi@sidan.ai" }),
    ).toBe(false);
  });

  it("ignores a link that opens a new tab/window", () => {
    expect(
      isInternalNavigation({
        ...base,
        href: `${ORIGIN}/w/team-1/brain`,
        target: "_blank",
      }),
    ).toBe(false);
  });

  it("allows an explicit target=_self", () => {
    expect(
      isInternalNavigation({
        ...base,
        href: `${ORIGIN}/w/team-1/brain`,
        target: "_self",
      }),
    ).toBe(true);
  });

  it("ignores a download link", () => {
    expect(
      isInternalNavigation({
        ...base,
        href: `${ORIGIN}/files/report.pdf`,
        hasDownload: true,
      }),
    ).toBe(false);
  });

  it("ignores an empty/missing href", () => {
    expect(isInternalNavigation({ ...base, href: null })).toBe(false);
    expect(isInternalNavigation({ ...base, href: "" })).toBe(false);
  });

  it("ignores an unparseable href", () => {
    expect(isInternalNavigation({ ...base, href: "::::not a url" })).toBe(false);
  });
});
