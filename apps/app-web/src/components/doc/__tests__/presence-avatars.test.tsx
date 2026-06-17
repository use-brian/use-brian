/**
 * [COMP:app-web/presence-avatars] Top-bar collaborator face-pile.
 *
 * Node-only vitest (no jsdom / @testing-library): we mount through
 * `renderToString` (an SSR pass) and assert against the static markup, the
 * same approach as page-header.test.tsx. We cover the dim-when-away contract —
 * a backgrounded peer renders `opacity-40` and the "— away" label, the active
 * peer renders neither, and **self is never dimmed** even while inactive.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { PresenceUser } from "@/lib/collab/use-presence";
import { PresenceAvatars } from "../presence-avatars";

const dict = en as unknown as Dictionary;

function render(users: PresenceUser[]): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <PresenceAvatars users={users} />
    </I18nProvider>,
  );
}

const ACTIVE: PresenceUser = {
  id: "u-alice",
  name: "Alice",
  color: "#E5484D",
  isSelf: false,
  active: true,
};
const AWAY: PresenceUser = {
  id: "u-bob",
  name: "Bob",
  color: "#3E63DD",
  isSelf: false,
  active: false,
};

describe("[COMP:app-web/presence-avatars] Presence face-pile", () => {
  it("dims a backgrounded peer and labels them away", () => {
    const html = render([AWAY]);
    expect(html).toContain("opacity-40");
    expect(html).toContain("Bob — away");
  });

  it("does not dim an actively-viewing peer", () => {
    const html = render([ACTIVE]);
    expect(html).not.toContain("opacity-40");
    // Active peers carry just the bare name, not the away label.
    expect(html).not.toContain("— away");
  });

  it("never dims yourself, even when inactive", () => {
    const html = render([{ ...AWAY, isSelf: true }]);
    expect(html).not.toContain("opacity-40");
    expect(html).toContain("Bob (you)");
  });

  it("paints earlier (left) avatars over later ones via descending z-index", () => {
    // Two avatars in render order → z-index 2 then 1, so the leftmost overlaps
    // the one to its right. Paired with usePresence sorting the online cluster
    // left, this is the "online on top of offline" half of the rule.
    const html = render([ACTIVE, AWAY]);
    const left = html.indexOf("z-index:2");
    const right = html.indexOf("z-index:1");
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeGreaterThan(left);
  });
});
