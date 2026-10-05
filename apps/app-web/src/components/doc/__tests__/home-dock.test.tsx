import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDock } from "@/lib/api/home-dock";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { HomeDock } from "../home-dock";

const state = vi.hoisted(() => ({ dock: null as ResolvedDock | null }));
vi.mock("../doc-sidebar-data", () => ({ useSidebarData: () => state }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
const render = () => renderToStaticMarkup(<I18nProvider locale="en" dict={en}><HomeDock workspaceId="workspace-1" /></I18nProvider>);
beforeEach(() => {
  state.dock = { source: "default", generatedAt: null, note: null, needsYou: [], pickUp: [], comingUp: [], brain: { entryCount: 40, growth7d: 0, hasConnector: true } };
});

describe("[COMP:app-web/home-dock] compact sidebar suggestion entry", () => {
  it("hides an unresolved or empty dock, even with existing brain entries", () => {
    expect(render()).toBe("");
    state.dock = null;
    expect(render()).toBe("");
  });
  it.each(["note", "needsYou", "pickUp", "comingUp", "growth"])("keeps the briefing reachable for %s", (kind) => {
    const dock = state.dock!;
    if (kind === "note") dock.note = "Review today's work";
    if (kind === "needsYou") dock.needsYou = [{ kind: "approvals", count: 2, caption: null }];
    if (kind === "pickUp") dock.pickUp = [{ id: "draft-1", name: "Draft", updatedAt: "2026-01-01" }];
    if (kind === "comingUp") dock.comingUp = [{ id: "run-1", name: "Run", nextRunAt: "2026-01-01" }];
    if (kind === "growth") dock.brain.growth7d = 1;
    expect(render()).toContain('href="/w/workspace-1/p?suggested=1"');
    expect(render()).toContain(en.docPage.suggested.sidebarEntry);
  });
});
