"use client";

// [COMP:app-web/preview-markdown]
/**
 * Inline-only markdown for compact **preview** surfaces — the comment-rail
 * collapsed card body (`PreviewRow`) and the Inbox row snippets. The full
 * message bodies (the expanded thread, the floating chat) already render
 * through `ChatMarkdown` inside a `.chat-markdown` block wrapper; these
 * previews could not, because they live inside a single-line `truncate` /
 * two-line `line-clamp-2` container and block-level nodes (`<p>`, headings,
 * lists) break that clamp. So an AI reply body like
 * `**"AI Trading Research Overview"** (version 5)` leaked the literal `**`.
 *
 * This wraps the same `ChatMarkdown` renderer but maps every block-level node
 * react-markdown would emit down to an inline fragment, so the result stays on
 * one flow line and the parent clamp holds. Inline marks (`**bold**`,
 * `*italic*`, `` `code` ``) render normally — that's the point. Two rules
 * worth calling out:
 *   - Links render as a plain underlined `<span>`, never an `<a>`: the whole
 *     preview row is itself a link/button, and a nested `<a>` is invalid HTML.
 *   - Images / horizontal rules are dropped (no place in a one-line snippet).
 *
 * Spec: `docs/architecture/features/doc-comments.md` (rail preview) +
 * `docs/architecture/features/doc-inbox.md` (inbox rows).
 */

import * as React from "react";
import { ChatMarkdown, type ChatMarkdownProps } from "@use-brian/chat-ui";

const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

/** Collapse block-level nodes to inline so the parent clamp/truncate holds. */
const INLINE_COMPONENTS: NonNullable<ChatMarkdownProps["components"]> = {
  p: passthrough,
  h1: passthrough,
  h2: passthrough,
  h3: passthrough,
  h4: passthrough,
  h5: passthrough,
  h6: passthrough,
  ul: passthrough,
  ol: passthrough,
  blockquote: passthrough,
  pre: passthrough,
  // Trailing space so collapsed list items don't run into each other.
  li: ({ children }) => <>{children} </>,
  // Keep inline <code> but never the block <pre><code> treatment.
  code: ({ children }) => <code>{children}</code>,
  // The row around this is already a link/button — render link text, not <a>.
  a: ({ children }) => <span className="underline">{children}</span>,
  img: () => null,
  hr: () => null,
  br: () => <> </>,
};

/** Render `text` as inline-only markdown, safe inside a truncate/line-clamp box. */
export function PreviewMarkdown({ text }: { text: string }) {
  return <ChatMarkdown text={text} components={INLINE_COMPONENTS} />;
}
