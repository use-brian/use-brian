// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { ConnectorHealthStatus } from "../connector-health-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/connector-health-status] connector health presentation", () => {
  it.each([
    ["auth_failed", en.settings.connectors.reconnectNeeded],
    ["degraded", en.settings.connectors.healthDegradedPill],
    ["ok", en.settings.connectors.connected],
  ] as const)("shows %s consistently in compact and detail status", (healthStatus, label) => {
    const host = document.createElement("div");
    host.innerHTML = renderToString(
      <I18nProvider locale="en" dict={en}>
        <ConnectorHealthStatus connector={{ connected: true, healthStatus }} compact />
        <ConnectorHealthStatus connector={{ connected: true, healthStatus }} />
      </I18nProvider>,
    );
    const states = [...host.querySelectorAll('[role="status"]')];
    expect(states.map((state) => state.getAttribute("aria-label"))).toEqual([label, label]);
    expect(states.map((state) => state.textContent)).toEqual([label, label]);
    expect(states[0].getAttribute("title")).toBe(label);
    if (healthStatus !== "ok") expect(states.every((state) => state.className.includes("amber"))).toBe(true);
  });

  it("updates an already-mounted status when a stored login fails and after reconnect", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      for (const healthStatus of ["ok", "auth_failed", "ok"] as const) {
        await act(async () => root.render(
          <I18nProvider locale="ja" dict={ja}>
            <ConnectorHealthStatus connector={{ connected: true, healthStatus }} />
          </I18nProvider>,
        ));
        expect(host.textContent).toBe(healthStatus === "auth_failed"
          ? ja.settings.connectors.reconnectNeeded : ja.settings.connectors.connected);
      }
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps disconnected and always-available primitives distinct from a failed login", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={en}>
        <ConnectorHealthStatus connector={{ connected: false, healthStatus: "auth_failed" }} />
        <ConnectorHealthStatus connector={{ connected: true, healthStatus: "auth_failed" }} builtin />
      </I18nProvider>,
    );
    expect(html).toContain(en.settings.connectors.disconnected);
    expect(html).toContain(en.settings.connectors.builtinPill);
    expect(html).not.toContain(en.settings.connectors.reconnectNeeded);
  });
});
