"use client";

/**
 * Webhook trigger fields (app-web) — an optional server-side event filter
 * (the guided rule-builder / raw-JSONLogic editor), plus one-click copies for
 * URL / secret / curl, a confirm-gated secret rotation, an in-browser
 * HMAC-signed test request pane, and language-tabbed signature snippets.
 *
 * Ported from `apps/web/src/components/workflow/webhook-trigger-fields.tsx`
 * (app consolidation §5a); the `match` filter editor was added 2026-06-30.
 * The browser computes the signature live via `crypto.subtle` so the "Send
 * test request" round-trip is fully self-contained — no backend proxy, no
 * copy-paste, no leak of the secret to a third party. The confirm uses
 * app-web's themed `confirmDialog`, never `window.confirm`.
 *
 * Spec: docs/architecture/features/workflow.md → Webhook trigger.
 * [COMP:app-web/workflow]
 */

import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { webhookUrlForSlug, type WorkflowTrigger } from "@/lib/api/workflow";
import {
  computeWebhookSignature,
  curlSnippet,
  nodeSnippet,
  pythonSnippet,
} from "@/lib/workflow-signature";
import {
  conditionToRules,
  emptyRule,
  rulesToCondition,
  WEBHOOK_OPS,
  type WebhookCombine,
  type WebhookOp,
  type WebhookRule,
} from "@/lib/webhook-match";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Props = {
  trigger: Extract<WorkflowTrigger, { kind: "webhook" }>;
  onChange: (next: WorkflowTrigger) => void;
  slug: string | null;
  secret: string | null;
  onRotate: () => void | Promise<void>;
  disabled?: boolean;
};

export function WebhookTriggerFields({
  trigger,
  onChange,
  slug,
  secret,
  onRotate,
  disabled,
}: Props) {
  const setCondition = (condition: unknown) =>
    onChange(
      condition === undefined
        ? { kind: "webhook" }
        : { kind: "webhook", match: { condition } },
    );

  return (
    <div className="flex flex-col gap-3">
      {/* Endpoint first (mirrors the Manual panel's Run-endpoint block),
          then the optional payload filter below a divider. */}
      {slug && secret ? (
        <WebhookCredentials
          slug={slug}
          secret={secret}
          onRotate={onRotate}
          disabled={disabled}
        />
      ) : (
        <WebhookPendingCallout />
      )}
      <div className="pt-3 border-t border-border/60">
        <WebhookMatchEditor
          condition={trigger.match?.condition}
          onChange={setCondition}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// ── Pending (unsaved) callout ───────────────────────────────────────────────
//
// The webhook URL + signing secret are minted server-side on the first save
// of a `webhook` trigger, so they can't be shown before that. Rather than a
// bare "Save changes" hint (which reads like the panel is missing its
// endpoint), preview the URL shape with a placeholder slug and spell out that
// saving generates the real value.

function WebhookPendingCallout() {
  const t = useT();
  // A masked slug the same visual length as a real one (base64url of 12
  // bytes ≈ 16 chars) so the previewed URL matches the eventual shape. Same
  // layout as the Manual panel's Run-endpoint block (label / `POST <url>` /
  // hint), muted + dashed to read as "not generated yet".
  const previewUrl = webhookUrlForSlug("••••••••••••••••");
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {t.workflowPage.builder.webhookUrlLabel}
      </label>
      <code className="px-3 py-1.5 bg-muted/40 border border-dashed border-border rounded-md text-xs font-mono text-muted-foreground/70 break-all select-none">
        POST {previewUrl}
      </code>
      <p className="text-xs text-muted-foreground">
        {t.workflowPage.builder.webhookPendingCallout}
      </p>
    </div>
  );
}

// ── Match filter editor ───────────────────────────────────────────────────

function WebhookMatchEditor({
  condition,
  onChange,
  disabled,
}: {
  condition: unknown;
  onChange: (condition: unknown) => void;
  disabled?: boolean;
}) {
  const t = useT();
  // Seed local editor state from the stored condition once (this panel mounts
  // per workflow / per trigger-kind selection, and is the only writer of the
  // condition, so a one-shot seed stays in sync).
  const seed = useMemo(() => conditionToRules(condition), [condition]);
  const [rules, setRules] = useState<WebhookRule[]>(seed?.rules ?? []);
  const [combine, setCombine] = useState<WebhookCombine>(seed?.combine ?? "and");
  const [rawMode, setRawMode] = useState(seed === null);
  const [rawText, setRawText] = useState(
    condition === undefined ? "" : JSON.stringify(condition, null, 2),
  );
  const [rawError, setRawError] = useState<string | null>(null);

  const OP_LABELS: Record<WebhookOp, string> = {
    "==": t.workflowPage.builder.webhookFilterOpEquals,
    "!=": t.workflowPage.builder.webhookFilterOpNotEquals,
    ">": t.workflowPage.builder.webhookFilterOpGt,
    ">=": t.workflowPage.builder.webhookFilterOpGte,
    "<": t.workflowPage.builder.webhookFilterOpLt,
    "<=": t.workflowPage.builder.webhookFilterOpLte,
    contains: t.workflowPage.builder.webhookFilterOpContains,
  };

  const commit = (nextRules: WebhookRule[], nextCombine: WebhookCombine) => {
    setRules(nextRules);
    setCombine(nextCombine);
    onChange(rulesToCondition(nextRules, nextCombine));
  };

  const updateRule = (idx: number, patch: Partial<WebhookRule>) =>
    commit(
      rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
      combine,
    );
  const addRule = () => setRules([...rules, emptyRule()]); // local until it has a path
  const removeRule = (idx: number) =>
    commit(
      rules.filter((_, i) => i !== idx),
      combine,
    );

  const enterRaw = () => {
    const cond = rulesToCondition(rules, combine);
    setRawText(cond === undefined ? "" : JSON.stringify(cond, null, 2));
    setRawError(null);
    setRawMode(true);
  };

  const exitRaw = () => {
    let parsed: unknown;
    if (rawText.trim() === "") parsed = undefined;
    else {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        setRawError(t.workflowPage.builder.webhookFilterRawInvalid);
        return;
      }
    }
    const back = conditionToRules(parsed);
    if (back === null) {
      setRawError(t.workflowPage.builder.webhookFilterRawComplexNote);
      return;
    }
    setRules(back.rules);
    setCombine(back.combine);
    setRawError(null);
    setRawMode(false);
  };

  const onRawChange = (text: string) => {
    setRawText(text);
    if (text.trim() === "") {
      setRawError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setRawError(null);
      onChange(parsed);
    } catch {
      setRawError(t.workflowPage.builder.webhookFilterRawInvalid);
    }
  };

  return (
    <div className="flex flex-col gap-2 pb-1">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.webhookFilterHeading}
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            {t.workflowPage.builder.webhookFilterHint}
          </p>
        </div>
        <button
          type="button"
          onClick={rawMode ? exitRaw : enterRaw}
          disabled={disabled}
          className="text-[11px] px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50 whitespace-nowrap"
        >
          {rawMode
            ? t.workflowPage.builder.webhookFilterAdvancedHide
            : t.workflowPage.builder.webhookFilterAdvancedShow}
        </button>
      </div>

      {rawMode ? (
        <div className="flex flex-col gap-1">
          <textarea
            value={rawText}
            onChange={(e) => onRawChange(e.target.value)}
            placeholder={t.workflowPage.builder.webhookFilterRawPlaceholder}
            rows={5}
            disabled={disabled}
            className="w-full text-xs px-2 py-1.5 bg-background border border-border rounded font-mono outline-none focus:ring-2 focus:ring-ring resize-y"
          />
          <p className="text-[11px] text-muted-foreground/80">
            {t.workflowPage.builder.webhookFilterAdvancedHint}
          </p>
          {rawError && (
            <p className="text-[11px] text-red-600 dark:text-red-400">{rawError}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.length > 1 && (
            <div className="flex items-center gap-2">
              <Select
                value={combine}
                onValueChange={(v) => commit(rules, v as WebhookCombine)}
                disabled={disabled}
              >
                <SelectTrigger className="w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="and">
                    {t.workflowPage.builder.webhookFilterCombineAll}
                  </SelectItem>
                  <SelectItem value="or">
                    {t.workflowPage.builder.webhookFilterCombineAny}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {rules.map((rule, idx) => (
            <RuleRow
              key={idx}
              rule={rule}
              opLabels={OP_LABELS}
              onChange={(patch) => updateRule(idx, patch)}
              onRemove={() => removeRule(idx)}
              disabled={disabled}
            />
          ))}

          <button
            type="button"
            onClick={addRule}
            disabled={disabled}
            className="self-start text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
          >
            {t.workflowPage.builder.webhookFilterAddRule}
          </button>
        </div>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  opLabels,
  onChange,
  onRemove,
  disabled,
}: {
  rule: WebhookRule;
  opLabels: Record<WebhookOp, string>;
  onChange: (patch: Partial<WebhookRule>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={rule.path}
        onChange={(e) => onChange({ path: e.target.value })}
        placeholder={t.workflowPage.builder.webhookFilterFieldPlaceholder}
        disabled={disabled}
        className="flex-1 min-w-[8rem] px-2 py-1.5 bg-background border border-border rounded text-xs font-mono outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
      <Select
        value={rule.op}
        onValueChange={(v) => onChange({ op: v as WebhookOp })}
        disabled={disabled}
      >
        <SelectTrigger className="w-36 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WEBHOOK_OPS.map((op) => (
            <SelectItem key={op} value={op}>
              {opLabels[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input
        type="text"
        value={rule.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder={t.workflowPage.builder.webhookFilterValuePlaceholder}
        disabled={disabled}
        className="flex-1 min-w-[8rem] px-2 py-1.5 bg-background border border-border rounded text-xs font-mono outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={t.workflowPage.builder.webhookFilterRemoveRule}
        className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 px-1"
      >
        ×
      </button>
    </div>
  );
}

// ── Credentials (URL / secret / curl / test / snippets) ─────────────────────

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

function WebhookCredentials({
  slug,
  secret,
  onRotate,
  disabled,
}: {
  slug: string;
  secret: string;
  onRotate: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState<CopiedTarget>(null);
  const [tab, setTab] = useState<"curl" | "node" | "python">("curl");
  const [bodyDraft, setBodyDraft] = useState('{"hello":"world"}');
  const [test, setTest] = useState<TestResult>({ status: "idle" });

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
    <div className="flex flex-col gap-3">
      <FieldWithCopy
        label={t.workflowPage.builder.webhookUrlLabel}
        value={url}
        displayPrefix="POST "
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
  displayPrefix,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
  masked?: boolean;
  /** Shown before the value (e.g. `POST `) but never copied — matches the
   *  Manual panel, which displays `POST <url>` yet copies the bare URL. */
  displayPrefix?: string;
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
          {displayPrefix}
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
