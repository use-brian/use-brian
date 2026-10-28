import { describe, it } from "vitest";
import { verifyChatWelcomeLayout } from "../../../../scripts/chat-welcome-layout-browser.mjs";

/** Opt in against a running local rig with CHAT_LAYOUT_BROWSER=1.
 * The normal unit suite does not require a browser or local server.
 */
describe.skipIf(process.env.CHAT_LAYOUT_BROWSER !== "1")(
  "[COMP:app-web/chat-responsive-controls] welcome browser layout",
  () => {
    it("docks and resizes the composer while preserving drafts across phone and desktop", () => {
      verifyChatWelcomeLayout();
    }, 120_000);
  },
);
