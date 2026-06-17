/**
 * [COMP:app-web/empty-page-landing] Default-viewer landing — chatter +
 * recents cards, and the chat-seed event bus that wires the chatter to the
 * chat.
 *
 * vitest in app-web is node-only (no jsdom): components are mounted via
 * `renderToString` and asserted against the static markup, matching
 * `mobile-chat-drawer.test.tsx`. The click → `requestChatSeed` path is
 * covered separately against a stubbed `window`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { ViewListRow } from "@/lib/api/views";
import { EmptyPageLanding } from "../empty-page-landing";
import { CHAT_SEED_EVENT, requestChatSeed } from "@/lib/chat-seed";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

function row(over: Partial<ViewListRow> & Pick<ViewListRow, "id" | "name">): ViewListRow {
  return {
    workspaceId: "ws_1",
    description: null,
    entity: "tasks",
    viewType: "table",
    state: "saved",
    updatedAt: "2026-05-01T00:00:00.000Z",
    nestParentId: null,
    position: 0,
    icon: null,
    nameOrigin: "user",
    ...over,
  };
}

describe("[COMP:app-web/empty-page-landing] Landing chatter + recents", () => {
  it("renders the chatter heading, subtitle, placeholder, and send label", () => {
    const html = wrap(<EmptyPageLanding workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />);
    expect(html).toContain(dict.docPage.landing.title);
    expect(html).toContain(dict.docPage.landing.subtitle);
    expect(html).toMatch(/placeholder="e\.g\. A board of open deals by stage"/);
    expect(html).toContain(dict.docPage.landing.send);
  });

  it("renders the starter-prompt chips", () => {
    const html = wrap(<EmptyPageLanding workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />);
    for (const s of dict.docPage.landing.suggestions) {
      expect(html).toContain(s);
    }
  });

  it("renders the file-attach affordance (paperclip button + hidden input)", () => {
    const html = wrap(<EmptyPageLanding workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />);
    // The paperclip button carries the shared attachments aria-label, and the
    // hidden multi-file input backs it.
    expect(html).toContain(`aria-label="${dict.attachments.attach}"`);
    expect(html).toMatch(/type="file"[^>]*multiple/);
  });

  it("renders the 'start with a blank page' escape hatch button", () => {
    const html = wrap(<EmptyPageLanding workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />);
    // The quiet text button below the composer that skips the AI prompt and
    // opens an empty editor (wired to the shell's blank-draft path).
    expect(html).toContain(dict.docPage.landing.startBlank);
  });

  it("renders the deep-research toggle (doc research now ships)", () => {
    const html = wrap(<EmptyPageLanding workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />);
    // <ComposerControls showResearch /> renders the research toggle by label.
    expect(html).toContain(dict.chat.research);
  });

  it("gives the composer textarea the auto-grow cap + overflow (always shows full context)", () => {
    // The shared ChatComposer auto-grows the textarea; the landing's job is only
    // to set a sensible cap so a multi-line "what do you want to see?" prompt
    // stays fully visible (no top-clipping) and scrolls past the cap rather than
    // earlier. Guards against regressing to the old clip-too-early 160px / a
    // missing overflow class. Matches the floating dock's composer.
    const html = wrap(<EmptyPageLanding workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />);
    expect(html).toContain("max-h-[240px]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("resize-none");
    expect(html).not.toContain("max-h-[160px]");
  });

  it("renders each recent page as a card and shows the recents heading", () => {
    const html = wrap(
      <EmptyPageLanding
        workspaceId="ws_1"
        cards={[row({ id: "v1", name: "Q2 pipeline" }), row({ id: "v2", name: "Hiring" })]}
        onOpenCard={() => {}}
        onSubmitPrompt={() => {}} onStartBlank={() => {}}
      />,
    );
    expect(html).toContain(dict.docPage.landing.recentsTitle);
    expect(html).toContain("Q2 pipeline");
    expect(html).toContain("Hiring");
  });

  it("hides the recents section entirely when there are no cards", () => {
    const html = wrap(<EmptyPageLanding workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />);
    expect(html).not.toContain(dict.docPage.landing.recentsTitle);
  });

  it("falls back to the Untitled label for an empty page name", () => {
    const html = wrap(
      <EmptyPageLanding workspaceId="ws_1" cards={[row({ id: "v1", name: "   " })]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />,
    );
    expect(html).toContain(dict.docPage.breadcrumbUntitled);
  });

  it("uses the page's emoji icon when set", () => {
    const html = wrap(
      <EmptyPageLanding workspaceId="ws_1" cards={[row({ id: "v1", name: "Deals", icon: "🤝" })]} onOpenCard={() => {}} onSubmitPrompt={() => {}} onStartBlank={() => {}} />,
    );
    expect(html).toContain("🤝");
  });
});

describe("[COMP:app-web/empty-page-landing] chat-seed bus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches a CHAT_SEED_EVENT carrying the prefill + autoSend", () => {
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    vi.stubGlobal(
      "CustomEvent",
      class {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    );

    requestChatSeed({ prefill: "make me a board", autoSend: true });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const evt = dispatch.mock.calls[0][0] as { type: string; detail: { prefill: string; autoSend?: boolean } };
    expect(evt.type).toBe(CHAT_SEED_EVENT);
    expect(evt.detail).toEqual({ prefill: "make me a board", autoSend: true });
  });

  it("drops a blank prefill without dispatching", () => {
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    requestChatSeed({ prefill: "   " });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
