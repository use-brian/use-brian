/**
 * [COMP:app-web/add-connector-menu] Compact Studio top-bar trigger.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AddConnectorMenu } from "../add-connector-menu";

describe("[COMP:app-web/add-connector-menu] AddConnectorMenu", () => {
  it("matches the compact outlined Skills action sizing", () => {
    const markup = renderToStaticMarkup(
      <AddConnectorMenu
        label="Add connector"
        browseLabel="Browse directory"
        customLabel="Add custom connector"
        onBrowseDirectory={vi.fn()}
        onAddCustom={vi.fn()}
      />,
    );

    expect(markup).toContain("h-7");
    expect(markup).toContain("border-border");
    expect(markup).toContain("text-xs");
    expect(markup).toContain("text-muted-foreground");
    expect(markup).toContain("lucide-plus");
    expect(markup).not.toContain("bg-action");
  });
});
