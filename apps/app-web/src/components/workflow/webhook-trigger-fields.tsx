"use client";

/**
 * Webhook trigger fields (app-web) — one-click copies for URL / secret /
 * curl, a confirm-gated secret rotation, an in-browser HMAC-signed test
 * request pane, and language-tabbed signature helper snippets.
 *
 * Ported from `apps/web/src/components/workflow/webhook-trigger-fields.tsx`
 * (app consolidation §5a). The browser computes the signature live via
 * `crypto.subtle` so the "Send test request" round-trip is fully
 * self-contained — no backend proxy, no copy-paste, no leak of the secret
 * to a third party. The confirm uses app-web's themed `confirmDialog`,
 * never `window.confirm`.
 *
 * Spec: docs/architecture/features/workflow.md → Webhook UI polish.
 * [COMP:app-web/workflow]
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { webhookUrlForSlug } from "@/lib/api/workflow";
import {
  computeWebhookSignature,
  curlSnippet,
  nodeSnippet,
  pythonSnippet,
} from "@/lib/workflow-signature";
import { cn } from "@/lib/utils";

type Props = {
  slug: string | null;
  secret: string | null;
  onRotate: () => void | Promise<void>;
  disabled?: boolean;
};

type CopiedTarget =
  | "url"
  | "secret"
  | "curl"
  | "snippet-curl"
  | "snippet-node"
  | "snippet-python"
  | null;

type TestResult =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "done"; httpStatus: number; body: string }
  | { status: "error"; message: string };

export function WebhookTriggerFields({
  slug,
  secret,
  onRotate,
  disabled,
}: Props) {
  const t = useT();
  const [copied, setCopied] = useState<CopiedTarget>(null);
  const [tab, setTab] = useState<"curl" | "node" | "python">("curl");
  const [bodyDraft, setBodyDraft] = useState('{"hello":"world"}');
  const [test, setTest] = useState<TestResult>({ status: "idle" });

  if (!slug || !secret) {
    // Webhook trigger selected but credentials haven't been minted yet —
    // they'll appear after Save changes.
    return (
      <div className="ml-6 pl-3 border-l border-border text-xs text-muted-foreground">
        {t.workflowPage.builder.saveChanges} →
      </div>
    );
  }

  const url = webhookUrlForSlug(slug);
  const curlExample = curlSnippet(url, secret, "{}");

  const copy = async (text: string, target: CopiedTarget) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(target);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore — clipboard may be restricted
    }
  };

  const onRotateClick = async () => {
    const ok = await confirmDialog({
      title: t.workflowPage.builder.webhookRotateConfirmTitle,
      description: t.workflowPage.builder.webhookRotateConfirmBody,
      confirmLabel: t.workflowPage.builder.webhookRotateConfirmAction,
      variant: "destructive",
    });
    if (!ok) return;
    await onRotate();
  };

  const sendTestRequest = async () => {
    setTest({ status: "sending" });
    try {
      const signature = await computeWebhookSignature(secret, bodyDraft);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workflow-Signature": signature,
        },
        body: bodyDraft,
      });
      const text = await res.text().catch(() => "");
      setTest({ status: "done", httpStatus: res.status, body: text });
    } catch (e) {
      setTest({
        status: "error",
        message:
          e instanceof Error
            ? e.message
            : t.workflowPage.builder.webhookTestNetworkError,
      });
    }
  };

  const snippets = {
    curl: curlSnippet(url, secret, bodyDraft || "{}"),
    node: nodeSnippet(url, secret),
    python: pythonSnippet(url, secret),
  } as const;

  return (
    <div className="ml-6 pl-3 border-l border-border flex flex-col gap-3">
      <FieldWithCopy
        label={t.workflowPage.builder.webhookUrlLabel}
        value={url}
        copied={copied === "url"}
        onCopy={() => copy(url, "url")}
        copyLabel={t.workflowPage.builder.webhookCopyUrl}
        copiedLabel={t.workflowPage.builder.webhookCopied}
      />
      <FieldWithCopy
        label={t.workflowPage.builder.webhookSecretLabel}
        value={secret}
        masked
        copied={copied === "secret"}
        onCopy={() => copy(secret, "secret")}
        copyLabel={t.workflowPage.builder.webhookCopySecret}
        copiedLabel={t.workflowPage.builder.webhookCopied}
      />

      {/* Curl one-liner — the lowest-friction "try it" affordance. */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.webhookCurlLabel}
        </label>
        <div className="flex items-start gap-2">
          <pre className="flex-1 px-3 py-1.5 bg-background border border-border rounded-md text-[11px] font-mono whitespace-pre-wrap break-all">
            {curlExample}
          </pre>
          <button
            type="button"
            onClick={() => copy(curlExample, "curl")}
            className="text-xs px-2 py-1.5 rounded border border-border hover:bg-muted whitespace-nowrap"
          >
            {copied === "curl"
              ? t.workflowPage.builder.webhookCopied
              : t.workflowPage.builder.webhookCopyCurl}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRotateClick}
          disabled={disabled}
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          {t.workflowPage.builder.webhookRotate}
        </button>
        <div className="text-xs text-muted-foreground">
          {t.workflowPage.builder.webhookHint}
        </div>
      </div>

      {/* Test request pane — browser computes the signature, posts to
          the real endpoint. */}
      <div className="flex flex-col gap-2 pt-1 border-t border-border/60">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.webhookTestPaneHeading}
        </label>
        <textarea
          value={bodyDraft}
          onChange={(e) => setBodyDraft(e.target.value)}
          placeholder={t.workflowPage.builder.webhookTestBodyPlaceholder}
          rows={3}
          disabled={disabled}
          className="w-full text-xs px-2 py-1.5 bg-background border border-border rounded font-mono outline-none focus:ring-2 focus:ring-ring resize-y"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={sendTestRequest}
            disabled={disabled || test.status === "sending"}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
          >
            {test.status === "sending"
              ? t.workflowPage.builder.webhookTestSending
              : t.workflowPage.builder.webhookTestSendBtn}
          </button>
        </div>
        {test.status === "done" && (
          <div className="flex flex-col gap-1 text-xs">
            <div
              className={cn(
                "font-mono",
                test.httpStatus >= 200 && test.httpStatus < 300
                  ? "text-green-700 dark:text-green-400"
                  : "text-red-600 dark:text-red-400",
              )}
            >
              {fmt(t.workflowPage.builder.webhookTestResultStatus, {
                status: test.httpStatus,
              })}
            </div>
            <details className="text-muted-foreground">
              <summary className="cursor-pointer">
                {t.workflowPage.builder.webhookTestResultBody}
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto px-2 py-1.5 bg-background border border-border rounded text-[11px] font-mono whitespace-pre-wrap break-all">
                {test.body || t.workflowPage.builder.webhookTestEmptyBody}
              </pre>
            </details>
          </div>
        )}
        {test.status === "error" && (
          <div className="text-xs text-red-600 dark:text-red-400">
            {test.message}
          </div>
        )}
      </div>

      {/* Signature helper snippets — tabbed per language. */}
      <div className="flex flex-col gap-2 pt-1 border-t border-border/60">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.webhookSnippetsHeading}
        </label>
        <div role="tablist" className="flex gap-1">
          <SnippetTab
            label={t.workflowPage.builder.webhookSnippetTabCurl}
            active={tab === "curl"}
            onClick={() => setTab("curl")}
          />
          <SnippetTab
            label={t.workflowPage.builder.webhookSnippetTabNode}
            active={tab === "node"}
            onClick={() => setTab("node")}
          />
          <SnippetTab
            label={t.workflowPage.builder.webhookSnippetTabPython}
            active={tab === "python"}
            onClick={() => setTab("python")}
          />
        </div>
        <div className="flex items-start gap-2">
          <pre className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">
            {snippets[tab]}
          </pre>
          <button
            type="button"
            onClick={() =>
              copy(
                snippets[tab],
                tab === "curl"
                  ? "snippet-curl"
                  : tab === "node"
                    ? "snippet-node"
                    : "snippet-python",
              )
            }
            className="text-xs px-2 py-1.5 rounded border border-border hover:bg-muted whitespace-nowrap"
          >
            {copied === `snippet-${tab}`
              ? t.workflowPage.builder.webhookSnippetCopied
              : t.workflowPage.builder.webhookSnippetCopy}
          </button>
        </div>
      </div>
    </div>
  );
}

function SnippetTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "text-xs px-2.5 py-1 rounded border",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border hover:bg-muted text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}

function FieldWithCopy({
  label,
  value,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
  masked,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
  masked?: boolean;
}) {
  const display = masked
    ? `${value.slice(0, 4)}••••••••${value.slice(-4)}`
    : value;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-3 py-1.5 bg-background border border-border rounded-md text-xs font-mono break-all">
          {display}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs px-2 py-1.5 rounded border border-border hover:bg-muted whitespace-nowrap"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
    </div>
  );
}
