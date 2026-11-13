// @vitest-environment jsdom
/**
 * [COMP:app-web/popover] Popover clamp (responsive contract M5).
 *
 * A popover is a primary container on a phone (the workspace switcher is the
 * admin menu), so it must never be wider than the viewport and never taller
 * than what fits - the 320px switcher menu clipped "Add another account" and
 * "Log out" in 375px-tall landscape with no way to scroll. The clamp lives on
 * the PRIMITIVE so every consumer inherits it; the switcher additionally caps
 * its own width. Graded repo-wide by `invariants/popover-width-clamp`; this
 * pins the primitive itself.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@use-brian/chat-ui";
import { describe, expect, it } from "vitest";

const popover = readFileSync(resolve(__dirname, "../../../../../../packages/chat-ui/src/Popover.tsx"), "utf8");
const globals = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/popover] PopoverContent clamps to the phone viewport", () => {
  it("carries the width and height clamps and scrolls its overflow", () => {
    const cls = popover;
    expect(cls).toContain("max-w-[calc(var(--native-app-width,100vw)-1rem)]");
    expect(cls).toContain("max-h-[min(80dvh,var(--available-height))]");
    expect(cls).toContain("overflow-y-auto");
  });

  it("tints modal backdrops without filling rounded popover positioners or the Inbox backdrop", async () => {
    // Exercise the stylesheet selector against the real Base UI markup. Both
    // positioners and backdrops carry presentation roles and open-state data.
    const selector = globals.match(/([^{}]+)\{\s*background-color: color-mix\(in srgb, var\(--foreground\) 40%, transparent\);/)![1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement("div", null,
        createElement(Popover, { defaultOpen: true },
          createElement(PopoverTrigger, null, "Update ready"),
          createElement(PopoverContent, null, "Restart to update")),
        createElement(Dialog.Root, { defaultOpen: true },
          createElement(Dialog.Portal, null,
            createElement(Dialog.Backdrop, { className: "fixed inset-0", ...{ "data-test-modal-backdrop": "" } }),
            createElement(Dialog.Popup, null, createElement(Dialog.Title, null, "Test modal")))),
        createElement(Dialog.Root, { defaultOpen: true },
          createElement(Dialog.Portal, null,
            createElement(Dialog.Backdrop, { className: "fixed inset-0", ...{ "data-inbox-backdrop": "" } }),
            createElement(Dialog.Popup, null, createElement(Dialog.Title, null, "Inbox")))),
      )));
      const popup = document.querySelector('[data-slot="popover-content"]')!;
      const positioner = popup.parentElement!;
      expect(positioner.getAttribute("role")).toBe("presentation");
      expect(positioner.hasAttribute("data-open")).toBe(true);
      expect(positioner.matches(selector)).toBe(false);
      expect(document.querySelector("[data-test-modal-backdrop]")!.matches(selector)).toBe(true);
      expect(document.querySelector("[data-inbox-backdrop]")!.matches(selector)).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

});
