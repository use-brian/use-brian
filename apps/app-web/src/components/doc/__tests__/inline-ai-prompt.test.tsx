/**
 * [COMP:app-web/inline-ai-prompt] Inline "Space for AI" composer — the mini
 * box that opens at the caret on an empty line and seeds an anchored autoSend
 * turn on submit.
 *
 * vitest in app-web is node-only (no jsdom): the component is mounted via
 * `renderToString` and asserted against the static compose-state markup, and
 * the submit→seed payload is covered through the pure `buildInlineAiSeed`
 * helper (the box's onClick can't be driven without a DOM). Matches
 * `empty-page-landing.test.tsx`.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { InlineAiPrompt, buildInlineAiSeed } from "../inline-ai-prompt";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/inline-ai-prompt] compose-state render", () => {
  it("renders the prompt placeholder + send label", () => {
    const html = wrap(
      <InlineAiPrompt
        workspaceId="ws_1"
        viewId="v1"
        anchorBlockId="blk_1"
        position={{ top: 100, left: 80, width: 720 }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(`placeholder="${dict.docPage.inlineAi.placeholder}"`);
    expect(html).toContain(dict.docPage.inlineAi.send);
  });

  it("renders the shared model picker (default Standard tier)", () => {
    const html = wrap(
      <InlineAiPrompt
        workspaceId="ws_1"
        viewId={null}
        anchorBlockId="blk_1"
        position={{ top: 0, left: 0, width: 720 }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    // ComposerControls is reused, so the research toggle + model label show.
    expect(html).toContain(dict.chat.research);
    expect(html).toContain(dict.chat.modelStandard);
  });
});

describe("[COMP:app-web/inline-ai-prompt] buildInlineAiSeed", () => {
  it("builds an anchored autoSend seed when a page is open", () => {
    const seed = buildInlineAiSeed({
      prompt: "  a table of Q3 priorities  ",
      viewId: "v1",
      anchorBlockId: "blk_42",
      model: "pro",
      researchMode: false,
    });
    expect(seed).toEqual({
      prefill: "a table of Q3 priorities",
      autoSend: true,
      docViewId: "v1",
      anchorBlockId: "blk_42",
      model: "pro",
      researchMode: false,
    });
  });

  it("omits docViewId when no page is open (mints a new draft)", () => {
    const seed = buildInlineAiSeed({
      prompt: "draft a brief",
      viewId: null,
      anchorBlockId: "blk_7",
      model: "standard",
      researchMode: true,
    });
    expect(seed.docViewId).toBeUndefined();
    expect(seed.anchorBlockId).toBe("blk_7");
    expect(seed.autoSend).toBe(true);
    expect(seed.researchMode).toBe(true);
  });
});
