/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-fetch", () => ({ authFetch }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    browseDirectory: new Proxy(
      { connect: "Connect" },
      {
        get: (labels, key: string | symbol) =>
          labels[key as keyof typeof labels] ?? String(key),
      },
    ),
  }),
}));

import { BrowseDirectory } from "../browse-directory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/api/connectors/directory")) {
      return new Response(
        JSON.stringify({
          directory: [
            {
              id: "local",
              name: "Local Directory Storage",
              description: "Store workspace files on this server.",
              category: "official",
              auth_type: "none",
              oauth_required: false,
              tags: [],
              enabled: true,
              connected: false,
              added: true,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("[COMP:app-web/browse-directory] connector setup handoff", () => {
  it("delegates Local Directory Connect instead of sending an empty generic POST", async () => {
    const onConnectorConnect = vi.fn();
    await act(async () => {
      root.render(
        <BrowseDirectory
          open
          onClose={vi.fn()}
          onConnectorAdded={vi.fn()}
          onConnectorConnect={onConnectorConnect}
        />,
      );
    });

    const connect = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Connect",
    );
    expect(connect).toBeDefined();

    await act(async () => {
      connect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onConnectorConnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "local" }),
    );
    expect(authFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/connectors/local/connect"),
      expect.anything(),
    );
  });
});
