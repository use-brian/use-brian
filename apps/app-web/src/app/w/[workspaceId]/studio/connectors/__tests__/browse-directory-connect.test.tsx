/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
let directoryEntry: Record<string, unknown>;

vi.mock("@/lib/auth-fetch", () => ({ authFetch }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    browseDirectory: new Proxy(
      { connect: "Connect", addAnother: "Add another" },
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
  directoryEntry = {
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
  };
  authFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/api/connectors/directory")) {
      return new Response(
        JSON.stringify({
          directory: [directoryEntry],
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
  it.each(["cli", "github", "imap", "wordpress", "gsc", "notion"])(
    "delegates %s Add another to setup without calling the idempotent install endpoint",
    async (id) => {
      directoryEntry = {
        ...directoryEntry,
        id,
        connected: true,
        addable: true,
        oauth_required: id === "notion" || id === "gsc",
      };
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
      const addAnother = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Add another",
      );
      expect(addAnother).toBeDefined();
      await act(async () => addAnother!.click());

      expect(onConnectorConnect).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        { addAnother: true },
      );
      expect(authFetch.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([]);
    },
  );

  it("preserves the directory install path for remote MCP entries", async () => {
    directoryEntry = { ...directoryEntry, id: "community-mcp", connected: true };
    const onConnectorConnect = vi.fn();
    const onConnectorAdded = vi.fn();
    await act(async () => {
      root.render(
        <BrowseDirectory
          open
          onClose={vi.fn()}
          onConnectorAdded={onConnectorAdded}
          onConnectorConnect={onConnectorConnect}
        />,
      );
    });
    const addAnother = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add another",
    );
    expect(addAnother).toBeDefined();
    await act(async () => addAnother!.click());

    expect(onConnectorConnect).not.toHaveBeenCalled();
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/connectors/directory/community-mcp/add"),
      { method: "POST" },
    );
    expect(onConnectorAdded).toHaveBeenCalledOnce();
  });

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
