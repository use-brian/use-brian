import { describe, expect, it } from "vitest";
import {
  isPatConnector,
  resolveConnectorAddAnotherFlow,
} from "../connector-add-another";

describe("[COMP:app-web/connector-add-another] add-another routing", () => {
  it("opens the existing IMAP form instead of falling through to the directory route", () => {
    expect(resolveConnectorAddAnotherFlow({ id: "imap" })).toBe("imap-form");
  });

  it("preserves the other connector-specific flows", () => {
    expect(resolveConnectorAddAnotherFlow({ id: "cli" })).toBe("cli-form");
    expect(resolveConnectorAddAnotherFlow({ id: "github" })).toBe("pat-form");
    expect(resolveConnectorAddAnotherFlow({ id: "wordpress" })).toBe("wordpress-form");
    // Search Console is api_key + oauthRequired (the paste-form trick): the
    // form must win over the OAuth branch.
    expect(resolveConnectorAddAnotherFlow({ id: "gsc", oauthRequired: true })).toBe("gsc-form");
    expect(resolveConnectorAddAnotherFlow({ id: "notion", oauthRequired: true })).toBe("oauth");
    expect(resolveConnectorAddAnotherFlow({ id: "community-mcp" })).toBe("directory");
    expect(isPatConnector("github")).toBe(true);
    expect(isPatConnector("imap")).toBe(false);
  });
});
