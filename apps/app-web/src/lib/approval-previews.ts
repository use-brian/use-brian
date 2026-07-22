/**
 * Per-tool approval previews — the pure parse layer (app-web).
 *
 * The approvals queue renders a rich, tool-specific preview for actions it
 * recognises (an outgoing email as an email, not a JSON blob) and falls
 * back to the generic raw-input view for everything else. This module owns
 * the recognition + argument parsing so it stays unit-testable; the render
 * layer lives in
 * `components/doc/panels/approval-tool-previews.tsx`.
 *
 * Adding a preview for another tool: add its name → kind to
 * `TOOL_PREVIEW_KINDS`, a parse function returning `null` on any
 * unexpected shape (null = degrade to the generic view, never throw), a
 * branch in `parseToolPreview`, and a card in the render layer.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 * [COMP:app-web/approvals]
 */

/** Discriminator for the specific previews the queue knows how to render. */
type ToolPreviewKind = "email_send";

/**
 * Tool name → preview kind. Keyed on the canonical tool ident carried by
 * the approval row (`tool_name`) — the same name whether the row came from
 * a suspended chat turn (`tool_invocation`), an ask-policy workflow step
 * (`workflow_step`), or an agent-surface staged write (`staged_write`).
 */
const TOOL_PREVIEW_KINDS: Record<string, ToolPreviewKind> = {
  gmailSendMessage: "email_send",
};

/** Parsed `gmailSendMessage` input, normalised for rendering. */
export type EmailSendPreviewData = {
  /** Recipient addresses — a comma-separated `to` string is split. */
  to: string[];
  /** Verified "Send mail as" alias, when the model passed one. */
  from: string | null;
  subject: string;
  body: string;
  /** Raw attachment refs (workspace file id or path), as passed. */
  attachments: string[];
};

export type ToolPreviewData = {
  kind: "email_send";
  email: EmailSendPreviewData;
};

/**
 * Recognise + parse an approval row's tool call into preview data.
 * Returns `null` when the tool has no specific preview OR its arguments
 * don't match the expected shape — the caller falls back to the generic
 * raw-input view in both cases.
 */
export function parseToolPreview(
  toolName: string | null | undefined,
  args: Record<string, unknown> | null | undefined,
): ToolPreviewData | null {
  const kind = toolName ? TOOL_PREVIEW_KINDS[toolName] : undefined;
  if (kind === "email_send") {
    const email = parseEmailSendArgs(args ?? {});
    return email ? { kind, email } : null;
  }
  return null;
}

/**
 * Parse `gmailSendMessage`-shaped arguments. Lenient by design — a missing
 * field renders empty rather than hiding the whole preview — but at least
 * one of to / subject / body must be a string, otherwise the input doesn't
 * look like an email send and the generic view is more honest.
 */
export function parseEmailSendArgs(
  args: Record<string, unknown>,
): EmailSendPreviewData | null {
  const to = typeof args.to === "string" ? args.to : null;
  const subject = typeof args.subject === "string" ? args.subject : null;
  const body = typeof args.body === "string" ? args.body : null;
  if (to === null && subject === null && body === null) return null;
  const attachments = Array.isArray(args.attachments)
    ? args.attachments.filter((a): a is string => typeof a === "string")
    : [];
  return {
    to: to ? splitRecipients(to) : [],
    from: typeof args.from === "string" && args.from.trim() ? args.from : null,
    subject: subject ?? "",
    body: body ?? "",
    attachments,
  };
}

/** Split a To header value on commas/semicolons into address chips. */
export function splitRecipients(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolved attachment lines from the row's `displayLines` (the server-side
 * `describeConfirmation` output resolves file refs to real names + sizes,
 * which the raw arguments can't). Prefix-matched; when the format doesn't
 * match, the caller falls back to the raw refs.
 */
export function extractAttachmentLines(
  displayLines: string[] | undefined,
): string[] {
  const prefix = "• Attachment: ";
  return (displayLines ?? [])
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));
}

/**
 * Prepare an email body for markdown rendering with send parity. The email
 * renderer (`renderEmailBody`, packages/channels/src/email/markdown.ts)
 * treats a single newline inside a paragraph as a hard break (`<br>`);
 * standard markdown collapses it into a space, which would misrender the
 * most common email shape (greeting / paragraphs / sign-off on their own
 * lines). Harden each intra-paragraph newline into a markdown hard break
 * (trailing two spaces). Fenced code spans are left untouched — the email
 * renderer extracts them before its paragraph pass, so they carry no
 * hard-break semantics.
 */
export function emailBodyPreviewMarkdown(body: string): string {
  return body
    .split(/(```[\s\S]*?```)/g)
    .map((segment, i) =>
      i % 2 === 1 ? segment : segment.replace(/(?<!\n)\n(?!\n)/g, "  \n"),
    )
    .join("");
}

/** Display name for a raw attachment ref — basename for paths, id as-is. */
export function attachmentDisplayName(ref: string): string {
  const trimmed = ref.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}
