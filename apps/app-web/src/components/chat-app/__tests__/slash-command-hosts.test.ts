/**
 * [COMP:app-web/slash-command-autocomplete] General-chat host parity.
 *
 * The interaction contract lives in the shared hook/components. This source
 * seam prevents a composer refactor from silently dropping discovery or the
 * selected-command treatment from one of Brian's three general chat hosts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const hosts = [
  ["full-page Chat", source("../chat-surface.tsx")],
  ["universal workspace dock", source("../../chrome/floating-chat.tsx")],
  ["Feed assistant dock", source("../../feed/tuning-chat-panel.tsx")],
] as const;

describe("[COMP:app-web/slash-command-autocomplete] general chat hosts", () => {
  it.each(hosts)("keeps discovery and selected state in %s", (_name, host) => {
    expect(host).toContain("useSlashCommands({");
    expect(host).toContain("<SlashCommandMenuList");
    expect(host).toContain("<SlashCommandIndicator");
    expect(host).toContain("slashCommands.handleKeyDown");
  });

  it("paints the command prefix in both shared ChatComposer hosts", () => {
    expect(hosts[0][1]).toContain("...slashCommands.highlightRanges");
    expect(hosts[1][1]).toContain(
      "highlightRanges={slashCommands.highlightRanges}",
    );
  });
});
