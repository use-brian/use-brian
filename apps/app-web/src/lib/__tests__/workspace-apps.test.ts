import { describe, expect, it } from "vitest";
import type { CustomHomeApp } from "@/lib/api/home-apps";
import { workspaceAppCatalogue, miniAppPinsKey, miniAppMenuOrderKey } from "../workspace-apps";

const custom = (id: string, status: CustomHomeApp["status"], renderable: boolean) => ({
  id, name: "Team dashboard", status, renderable,
} as CustomHomeApp);

describe("[COMP:app-web/workspace-apps] App store discovery", () => {
  it("includes Chat and selected apps while leaving other discovery in Studio", () => {
    const ids = workspaceAppCatalogue(["crm", "chat", "page"], []).map((app) => app.id);
    expect(ids).toEqual(["crm", "chat", "page"]);
    expect(ids).not.toContain("office");
    expect(ids).not.toContain("workflow");
    expect(ids).not.toContain("organization");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the canonical compact defaults and ignores unknown or unselected entries", () => {
    expect(workspaceAppCatalogue([], []).map(app => app.id)).toEqual(["chat", "page", "browsers"]);
    const apps = workspaceAppCatalogue(["chat", "custom:missing", "custom:pending"], [
      custom("unselected", "active", true), custom("pending", "needs_consent", false),
    ]);
    expect(apps.map(app => app.id)).toEqual(["chat"]);
  });

  it("never exposes disabled, removed or unapproved custom entries from stale configuration", () => {
    const apps = workspaceAppCatalogue(["custom:gone", "custom:pending", "custom:active"], [
      custom("active", "active", true), custom("pending", "needs_consent", false),
      custom("disabled", "disabled", true), custom("ungranted", "active", false),
    ]);
    expect(apps.filter((app) => app.custom).map((app) => app.id)).toEqual(["custom:active"]);
    expect(apps[0].id).toBe("custom:active");
  });

  it("separates local preferences across deployments, viewers and workspaces", () => {
    const key = miniAppPinsKey("https://api.example.test", "person-a", "workspace-a");
    expect(new Set([
      key,
      miniAppPinsKey("https://other.example.test", "person-a", "workspace-a"),
      miniAppPinsKey("https://api.example.test", "person-b", "workspace-a"),
      miniAppPinsKey("https://api.example.test", "person-a", "workspace-b"),
    ]).size).toBe(4);
    const order = miniAppMenuOrderKey("https://api.example.test", "person-a", "workspace-a");
    expect(order).not.toBe(key);
    expect(new Set([
      order,
      miniAppMenuOrderKey("https://other.example.test", "person-a", "workspace-a"),
      miniAppMenuOrderKey("https://api.example.test", "person-b", "workspace-a"),
      miniAppMenuOrderKey("https://api.example.test", "person-a", "workspace-b"),
    ]).size).toBe(4);
  });
});
