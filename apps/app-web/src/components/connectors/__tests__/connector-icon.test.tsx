import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorIcon } from "../connector-icon";

describe("[COMP:app-web/studio-connectors] connector icons", () => {
  it("renders a dedicated Local Directory glyph instead of an initial fallback", () => {
    const html = renderToStaticMarkup(
      <ConnectorIcon connectorId="local" fallback={<span>INITIAL</span>} />,
    );

    expect(html).toContain('data-connector-icon="local-directory"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("INITIAL");
  });
});
