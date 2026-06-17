/**
 * [COMP:app-web/draft-prune-button] Draft prune / Save-page affordance.
 *
 * Node-only vitest (no jsdom) — assert against the static `renderToString`
 * markup. The hover/focus countdown↔"Save page" swap is pure CSS (both
 * spans ship in the DOM, one hidden), so the contract here is: the right
 * escalating countdown copy renders, the "Save page" CTA + button
 * aria-label are present, and `interactive` gates the button's tabindex so
 * it isn't keyboard-reachable while the parent has it collapsed.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { DraftPruneButton } from "../draft-prune-button";

const dict = en as unknown as Dictionary;
const noop = () => {};

function render(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/draft-prune-button] Draft prune / Save-page button", () => {
  it("renders the day-count countdown plus the Save-page CTA", () => {
    const html = render(
      <DraftPruneButton days={28} interactive onSave={noop} />,
    );
    expect(html).toContain("28d until auto-delete");
    expect(html).toContain(en.docPage.sidebarDraftSave); // "Save page"
    expect(html).toContain(`aria-label="${en.docPage.sidebarDraftSave}"`);
  });

  it("escalates the copy as the prune date nears", () => {
    expect(render(<DraftPruneButton days={1} interactive onSave={noop} />)).toContain(
      en.docPage.sidebarDraftPruneOne, // "Auto-deletes tomorrow"
    );
    expect(render(<DraftPruneButton days={0} interactive onSave={noop} />)).toContain(
      en.docPage.sidebarDraftPruneSoon, // "Auto-deletes today"
    );
    expect(render(<DraftPruneButton days={-1} interactive onSave={noop} />)).toContain(
      en.docPage.sidebarDraftPruneOverdue, // "Auto-deletes soon"
    );
  });

  it("gates keyboard reachability on the revealed (interactive) state", () => {
    expect(
      render(<DraftPruneButton days={28} interactive onSave={noop} />),
    ).toContain('tabindex="0"');
    expect(
      render(<DraftPruneButton days={28} interactive={false} onSave={noop} />),
    ).toContain('tabindex="-1"');
  });
});
