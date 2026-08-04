// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  HOME_APPS_REFRESH_EVENT,
  requestHomeAppsRefresh,
  type HomeAppsRefreshDetail,
} from "@/lib/home-apps-events";

describe("[COMP:app-web/studio-mini-apps] Home apps same-tab refresh", () => {
  it("publishes the server-confirmed order synchronously for persistent chrome", () => {
    let received: HomeAppsRefreshDetail | null = null;
    const handler = (event: Event) => {
      received = (event as CustomEvent<HomeAppsRefreshDetail>).detail;
    };
    window.addEventListener(HOME_APPS_REFRESH_EVENT, handler);

    requestHomeAppsRefresh("ws-1", ["chat", "page", "crm"]);

    expect(received).toEqual({
      workspaceId: "ws-1",
      homeApps: ["chat", "page", "crm"],
    });
    window.removeEventListener(HOME_APPS_REFRESH_EVENT, handler);
  });

  it("also supports payload-less repair signals", () => {
    let received: HomeAppsRefreshDetail | null = null;
    const handler = (event: Event) => {
      received = (event as CustomEvent<HomeAppsRefreshDetail>).detail;
    };
    window.addEventListener(HOME_APPS_REFRESH_EVENT, handler);

    requestHomeAppsRefresh("ws-2");

    expect(received).toEqual({ workspaceId: "ws-2", homeApps: undefined });
    window.removeEventListener(HOME_APPS_REFRESH_EVENT, handler);
  });
});
