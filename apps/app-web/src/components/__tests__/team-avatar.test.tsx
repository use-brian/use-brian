/** [COMP:app-web/workspace-icon] Workspace picture precedence and fallback. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TeamAvatar } from "../team-avatar";

describe("[COMP:app-web/workspace-icon] TeamAvatar", () => {
  it("renders the uploaded workspace picture when iconUrl is present", () => {
    const html = renderToStaticMarkup(
      createElement(TeamAvatar, {
        id: "ws-1",
        name: "Example Workspace",
        iconSeed: 42,
        iconUrl: "https://api.example/api/workspace-icons/ws-1?v=abcd",
        size: "lg",
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain("/api/workspace-icons/ws-1?v=abcd");
    expect(html).toContain('alt="Example Workspace"');
  });

  it("renders the generated landmark when no picture is present", () => {
    const html = renderToStaticMarkup(
      createElement(TeamAvatar, {
        id: "ws-1",
        name: "Example Workspace",
        iconSeed: 42,
      }),
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
  });
});
