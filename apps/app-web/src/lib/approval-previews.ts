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
type ToolPreviewKind = "email_send" | "shopify_refund" | "shopify_cancel";

/**
 * Tool name → preview kind. Keyed on the canonical tool ident carried by
 * the approval row (`tool_name`) — the same name whether the row came from
 * a suspended chat turn (`tool_invocation`), an ask-policy workflow step
 * (`workflow_step`), or an agent-surface staged write (`staged_write`).
 */
const TOOL_PREVIEW_KINDS: Record<string, ToolPreviewKind> = {
  gmailSendMessage: "email_send",
  // Company mailbox (imap) sends share the same to/subject/body shape — the
  // two mail lanes look identical at approval time (mailbox-imap.md §4).
  imapSendMessage: "email_send",
  // Shopify order actions that move real money / cancel a fulfilment. The
  // approver reads the order, the flags, and — for refunds — the fact that
  // the amount is Shopify's own suggested figure, not one we invent here.
  shopifyRefundOrder: "shopify_refund",
  shopifyCancelOrder: "shopify_cancel",
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

/** One line of a partial refund — the line item id and quantity refunded. */
type ShopifyRefundLineItem = { lineItemId: string; quantity: number };

/** Parsed `shopifyRefundOrder` input, normalised for rendering. */
export type ShopifyRefundPreviewData = {
  orderId: string;
  /** `null` = full refund; otherwise the specific lines being refunded. */
  lineItems: ShopifyRefundLineItem[] | null;
  /** Email the customer about the refund (tool default: true). */
  notify: boolean;
  note: string | null;
};

/** The cancellation reasons the `shopifyCancelOrder` tool accepts (its enum). */
const SHOPIFY_CANCEL_REASONS = [
  "CUSTOMER",
  "DECLINED",
  "FRAUD",
  "INVENTORY",
  "OTHER",
  "STAFF",
] as const;
type ShopifyCancelReason = (typeof SHOPIFY_CANCEL_REASONS)[number];

/** Parsed `shopifyCancelOrder` input, normalised for rendering. */
export type ShopifyCancelPreviewData = {
  orderId: string;
  /** Cancellation reason (tool default: OTHER). */
  reason: ShopifyCancelReason;
  /** Restock the items (tool default: true). */
  restock: boolean;
  /** Refund the payment (tool default: true). */
  refund: boolean;
  /** Notify the customer (tool default: true). */
  notifyCustomer: boolean;
  staffNote: string | null;
};

export type ToolPreviewData =
  | { kind: "email_send"; email: EmailSendPreviewData }
  | { kind: "shopify_refund"; refund: ShopifyRefundPreviewData }
  | { kind: "shopify_cancel"; cancel: ShopifyCancelPreviewData };

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
  switch (kind) {
    case "email_send": {
      const email = parseEmailSendArgs(args ?? {});
      return email ? { kind, email } : null;
    }
    case "shopify_refund": {
      const refund = parseShopifyRefundArgs(args ?? {});
      return refund ? { kind, refund } : null;
    }
    case "shopify_cancel": {
      const cancel = parseShopifyCancelArgs(args ?? {});
      return cancel ? { kind, cancel } : null;
    }
    default:
      return null;
  }
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
 * Parse `shopifyRefundOrder`-shaped arguments. `orderId` is required (the
 * tool requires it); without it the input isn't a refund, so degrade to the
 * generic view. An absent or empty `lineItems` is a *full* refund. The
 * refunded amount is deliberately never parsed — Shopify computes the
 * suggested refund server-side, so the card must not imply a figure the
 * input doesn't carry.
 */
export function parseShopifyRefundArgs(
  args: Record<string, unknown>,
): ShopifyRefundPreviewData | null {
  const orderId = typeof args.orderId === "string" ? args.orderId : null;
  if (!orderId) return null;
  const lineItems = Array.isArray(args.lineItems)
    ? args.lineItems
        .map(parseRefundLineItem)
        .filter((li): li is ShopifyRefundLineItem => li !== null)
    : [];
  return {
    orderId,
    lineItems: lineItems.length > 0 ? lineItems : null,
    notify: typeof args.notify === "boolean" ? args.notify : true,
    note: typeof args.note === "string" && args.note.trim() ? args.note : null,
  };
}

/** Parse one `{ lineItemId, quantity }` refund line; `null` on any bad shape. */
function parseRefundLineItem(entry: unknown): ShopifyRefundLineItem | null {
  if (!entry || typeof entry !== "object") return null;
  const li = entry as Record<string, unknown>;
  const lineItemId = typeof li.lineItemId === "string" ? li.lineItemId : null;
  const quantity = typeof li.quantity === "number" ? li.quantity : null;
  if (lineItemId === null || quantity === null) return null;
  return { lineItemId, quantity };
}

/**
 * Parse `shopifyCancelOrder`-shaped arguments. `orderId` is required; the
 * three booleans fall back to the tool's own defaults (restock / refund /
 * notify all true) when absent, and an unrecognised `reason` degrades to
 * OTHER.
 */
export function parseShopifyCancelArgs(
  args: Record<string, unknown>,
): ShopifyCancelPreviewData | null {
  const orderId = typeof args.orderId === "string" ? args.orderId : null;
  if (!orderId) return null;
  const reason =
    typeof args.reason === "string" &&
    (SHOPIFY_CANCEL_REASONS as readonly string[]).includes(args.reason)
      ? (args.reason as ShopifyCancelReason)
      : "OTHER";
  return {
    orderId,
    reason,
    restock: typeof args.restock === "boolean" ? args.restock : true,
    refund: typeof args.refund === "boolean" ? args.refund : true,
    notifyCustomer:
      typeof args.notifyCustomer === "boolean" ? args.notifyCustomer : true,
    staffNote:
      typeof args.staffNote === "string" && args.staffNote.trim()
        ? args.staffNote
        : null,
  };
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
