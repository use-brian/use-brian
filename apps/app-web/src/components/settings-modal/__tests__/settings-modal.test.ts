import { describe, expect, it } from "vitest";
import { workspaceSettingsSections } from "../settings-modal";

describe("[COMP:app-web/connect-browser] OSS settings navigation", () => {
  it("shows Browser profiles so OSS users can pair My Browser", () => {
    expect(workspaceSettingsSections(true)).toContain("ws-browser-profiles");
  });

  it("keeps hosted-only billing and model sections out of OSS", () => {
    expect(workspaceSettingsSections(true)).not.toContain("ws-plan");
    expect(workspaceSettingsSections(true)).not.toContain("ws-models");
  });
});
