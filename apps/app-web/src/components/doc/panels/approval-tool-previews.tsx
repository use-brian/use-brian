"use client";

/**
 * Per-tool approval previews — the render layer.
 *
 * `ToolPreview` switches on the parsed preview data from
 * `lib/approval-previews.ts` (the recognition + parsing lives there so it
 * stays unit-testable). One card per preview kind; tools without a card use
 * `GenericToolPreview`, while exact input remains behind `ToolInputToggle`.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 * [COMP:app-web/approvals]
 */

import { useState } from "react";
import { Ban, Check, Mail, Paperclip, RotateCcw, X } from "lucide-react";
import remarkGfm from "remark-gfm";
import { ChatMarkdown } from "@use-brian/chat-ui";
import type { ConfirmationPreview } from "@use-brian/shared";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  attachmentDisplayName,
  emailBodyPreviewMarkdown,
  type EmailSendPreviewData,
  type ShopifyCancelPreviewData,
  type ShopifyRefundPreviewData,
  type ToolPreviewData,
} from "@/lib/approval-previews";

const EMAIL_BODY_REMARK_PLUGINS = [remarkGfm];

export function GenericToolPreview({
  preview,
}: {
  preview: ConfirmationPreview;
}) {
  if (preview.fields.length === 0) return null;
  return (
    <dl className="w-full max-w-2xl mt-1 rounded-md border border-border bg-background px-3 py-2 space-y-2">
      {preview.fields.map((field, index) => (
        <div
          key={`${field.label}-${index}`}
          className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"
        >
          <dt className="text-[11px] text-muted-foreground">{field.label}</dt>
          <dd className="text-xs whitespace-pre-wrap break-words">
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Exact frozen arguments, disclosed for auditing but never used as display copy. */
export function ToolInputToggle({
  args,
  disabled = false,
}: {
  args: Record<string, unknown>;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (Object.keys(args).length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className="text-xs text-primary hover:underline disabled:opacity-50"
      >
        {open ? t.approvalsPage.hideToolInput : t.approvalsPage.viewToolInput}
      </button>
      {open && (
        <pre className="w-full text-[11px] font-mono bg-muted/50 border border-border rounded px-2 py-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all max-w-2xl">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </>
  );
}

export function ToolPreview({
  preview,
  attachmentLines,
  senderEmail,
}: {
  preview: ToolPreviewData;
  /** Server-resolved attachment names + sizes (from `displayLines`), when
   *  available — richer than the raw refs in the arguments. */
  attachmentLines: string[];
  /** Server-resolved connected account, when the input omitted an explicit
   *  Gmail alias or IMAP account. */
  senderEmail?: string | null;
}) {
  switch (preview.kind) {
    case "email_send":
      return (
        <EmailSendPreview
          email={preview.email}
          attachmentLines={attachmentLines}
          senderEmail={senderEmail}
        />
      );
    case "shopify_refund":
      return <ShopifyRefundPreview refund={preview.refund} />;
    case "shopify_cancel":
      return <ShopifyCancelPreview cancel={preview.cancel} />;
  }
}

/**
 * An outgoing email, rendered the way a mail client would show it:
 * envelope header (To / From / Subject), the body as readable text, and
 * an attachment strip. The approver reads the actual email, not JSON.
 */
function EmailSendPreview({
  email,
  attachmentLines,
  senderEmail,
}: {
  email: EmailSendPreviewData;
  attachmentLines: string[];
  senderEmail?: string | null;
}) {
  const t = useT();
  // Prefer the server-resolved names (real filename + size); fall back to
  // the raw refs from the arguments when the row carries no displayLines.
  const attachments =
    attachmentLines.length > 0
      ? attachmentLines
      : email.attachments.map(attachmentDisplayName);
  const sender = email.from ?? senderEmail;
  return (
    <div className="w-full max-w-2xl mt-1 rounded-lg border border-border bg-background overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border">
        <Mail className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t.approvalsPage.emailPreview.title}
        </span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-1.5 border-b border-border">
        <EnvelopeRow label={t.approvalsPage.emailPreview.from}>
          {sender ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {sender}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t.approvalsPage.emailPreview.primaryAccount}
            </span>
          )}
        </EnvelopeRow>
        <EnvelopeRow label={t.approvalsPage.emailPreview.to}>
          {email.to.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {email.to.map((addr) => (
                <span
                  key={addr}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {addr}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t.approvalsPage.emailPreview.noRecipient}
            </span>
          )}
        </EnvelopeRow>
        {email.cc.length > 0 && (
          <EnvelopeRow label={t.approvalsPage.emailPreview.cc}>
            <span className="flex flex-wrap gap-1">
              {email.cc.map((addr) => (
                <span
                  key={addr}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {addr}
                </span>
              ))}
            </span>
          </EnvelopeRow>
        )}
        {email.bcc.length > 0 && (
          <EnvelopeRow label={t.approvalsPage.emailPreview.bcc}>
            <span className="flex flex-wrap gap-1">
              {email.bcc.map((addr) => (
                <span
                  key={addr}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {addr}
                </span>
              ))}
            </span>
          </EnvelopeRow>
        )}
        <EnvelopeRow label={t.approvalsPage.emailPreview.subject}>
          {email.subject ? (
            <span className="text-sm font-medium">{email.subject}</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t.approvalsPage.emailPreview.noSubject}
            </span>
          )}
        </EnvelopeRow>
      </div>
      {/* Rendered markdown, not the raw source — the send renders the body
          too (renderEmailBody), so this is what the recipient will read.
          emailBodyPreviewMarkdown keeps single-newline hard breaks in
          parity with the email renderer's paragraph rule. */}
      <div className="chat-markdown px-3 py-2.5 text-sm leading-relaxed break-words max-h-64 overflow-y-auto">
        <ChatMarkdown
          text={emailBodyPreviewMarkdown(email.body)}
          remarkPlugins={EMAIL_BODY_REMARK_PLUGINS}
        />
      </div>
      <div
        className="px-3 py-2 border-t border-border flex flex-wrap items-center gap-1.5"
        aria-label={t.approvalsPage.emailPreview.attachments}
      >
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground mr-0.5">
          <Paperclip
            className="size-3.5 shrink-0"
            aria-hidden
          />
          {t.approvalsPage.emailPreview.attachments}
        </span>
        {attachments.length > 0 ? (
          attachments.map((name, i) => (
            <span
              key={`${name}-${i}`}
              className="rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-mono max-w-[16rem] truncate"
              title={name}
            >
              {name}
            </span>
          ))
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {t.approvalsPage.emailPreview.noAttachments}
          </span>
        )}
      </div>
    </div>
  );
}

function EnvelopeRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A `shopifyRefundOrder` approval: the order, whether it's a full or
 * per-line refund, the notify flag, and an optional note. The card is
 * explicit that the money figure is Shopify's own suggested refund — the
 * tool never carries an amount, so the preview must not invent one.
 */
function ShopifyRefundPreview({
  refund,
}: {
  refund: ShopifyRefundPreviewData;
}) {
  const t = useT();
  const s = t.approvalsPage.shopifyRefundPreview;
  const scope = refund.lineItems
    ? format(s.lineItems, { count: refund.lineItems.length })
    : s.fullRefund;
  return (
    <div className="w-full max-w-2xl mt-1 rounded-lg border border-border bg-background overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border">
        <RotateCcw className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {s.title}
        </span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-1.5">
        <FieldRow label={s.order}>
          <span className="text-sm font-mono break-all">{refund.orderId}</span>
        </FieldRow>
        <FieldRow label={s.summary}>
          <span className="text-sm font-medium">{scope}</span>
        </FieldRow>
        <FlagRow label={s.notify} on={refund.notify} />
        {refund.note && (
          <FieldRow label={s.note}>
            <span className="text-sm break-words">{refund.note}</span>
          </FieldRow>
        )}
      </div>
      <div className="px-3 py-2 border-t border-border">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {s.amountNote}
        </p>
      </div>
    </div>
  );
}

/**
 * A `shopifyCancelOrder` approval: the order, the cancellation reason, and
 * the three consequential flags (restock / refund / notify) as explicit
 * yes/no rows. Each flag defaults to the tool's default (true) when the
 * model omitted it, so the approver sees what will actually happen.
 */
function ShopifyCancelPreview({
  cancel,
}: {
  cancel: ShopifyCancelPreviewData;
}) {
  const t = useT();
  const c = t.approvalsPage.shopifyCancelPreview;
  return (
    <div className="w-full max-w-2xl mt-1 rounded-lg border border-border bg-background overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border">
        <Ban className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {c.title}
        </span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-1.5">
        <FieldRow label={c.order}>
          <span className="text-sm font-mono break-all">{cancel.orderId}</span>
        </FieldRow>
        <FieldRow label={c.reason}>
          <span className="text-sm font-medium">{c.reasons[cancel.reason]}</span>
        </FieldRow>
        <FlagRow label={c.restock} on={cancel.restock} />
        <FlagRow label={c.refund} on={cancel.refund} />
        <FlagRow label={c.notify} on={cancel.notifyCustomer} />
        {cancel.staffNote && (
          <FieldRow label={c.note}>
            <span className="text-sm break-words">{cancel.staffNote}</span>
          </FieldRow>
        )}
      </div>
    </div>
  );
}

/** Label + value row for the order-action cards (wider label than email). */
function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="w-28 shrink-0 text-[11px] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A boolean option rendered as an explicit yes/no, tick for on. */
function FlagRow({ label, on }: { label: string; on: boolean }) {
  const t = useT();
  const f = t.approvalsPage.shopifyFlag;
  return (
    <FieldRow label={label}>
      <span
        className={cn(
          "inline-flex items-center gap-1 text-sm",
          on ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {on ? (
          <Check
            className="size-3.5 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
        ) : (
          <X className="size-3.5" aria-hidden />
        )}
        {on ? f.yes : f.no}
      </span>
    </FieldRow>
  );
}
