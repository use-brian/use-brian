import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const signedInSource = readFileSync(
  new URL("../signed-in/page.tsx", import.meta.url),
  "utf8",
);
const connectorConnectedSource = readFileSync(
  new URL("../connector-connected/page.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/desktop-signed-in] [COMP:app-web/desktop-connector-connected] desktop confirmation branding", () => {
  it("renders the signed-in mark inside the dark app-icon tile", () => {
    expect(signedInSource).toContain('src="/icon.png"');
    expect(signedInSource).toContain(
      'className="mx-auto flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-[#080d15] ring-1 ring-primary/30 shadow-',
    );
    expect(signedInSource).toContain('className="h-11 w-11"');
  });

  it("keeps the connector confirmation mark frameless", () => {
    expect(connectorConnectedSource).toContain('src="/icon.png"');
    expect(connectorConnectedSource).toContain(
      'className="mx-auto h-14 w-14"',
    );
    expect(connectorConnectedSource).not.toMatch(/rounded-|ring-|shadow-/);
  });
});
