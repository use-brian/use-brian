/** [COMP:app-web/workspace-picker] Small lists are icon destinations, not outline buttons. */

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => createElement("a", { href, ...props }, children),
}));
vi.mock("@/lib/i18n/client", () => ({ useT: () => ({ teams: {} }) }));
vi.mock("@/lib/api/workspaces", () => ({
  updateWorkspacePickerPreferences: vi.fn(async () => ({})),
}));

import { WorkspacePicker } from "../workspace-picker";

describe("[COMP:app-web/workspace-picker] workspace destinations", () => {
  it("shows each workspace icon on a filled destination, separate from an outline button", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePicker, {
        next: "/home",
        initialWorkspaces: [
          {
            id: "north",
            name: "North Workshop",
            role: "owner",
            iconUrl: "https://api.example/api/workspace-icons/north?v=1",
          },
          {
            id: "south",
            name: "South Workshop",
            role: "member",
            iconSeed: 7,
          },
        ],
      }),
    );

    expect(html).toContain('href="/w/north/home"');
    expect(html).toContain('href="/w/south/home"');
    expect(html).toContain('data-slot="workspace-destination"');
    expect(html).toContain("bg-secondary");
    expect(html).toContain("bg-action");
    expect(html).not.toContain("border-border");
    expect(html).toContain('alt="North Workshop"');
    expect(html).toContain("/api/workspace-icons/north?v=1");
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="South Workshop"');
    expect(html).toContain("North Workshop");
    expect(html).toContain(">owner<");
    expect(html).toContain(">member<");
  });
});
