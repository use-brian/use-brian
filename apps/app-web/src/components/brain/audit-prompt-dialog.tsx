"use client";

/**
 * The Audit section's raw-prompt reader (features/chat-audit.md → "Raw
 * prompt"): everything one model call put on the wire - the system prompt,
 * every message in order, and the response - dereferenced from the ledger's
 * `provider_call` payload refs through the member-gated payload route.
 * Fetched only when the reviewer opens it; an erased payload says so.
 *
 * [COMP:app-web/brain-audit]
 */

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Check, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { fetchTurnPayload } from "@/lib/api/turn-trace";
import {
  formatPromptMessage,
  formatPromptResponse,
  formatTokens,
  type ProviderPromptRefs,
  type PromptMessageView,
} from "@/lib/turn-audit";

/** Content-addressed and immutable, so one fetch per hash per page load. */
const payloadCache = new Map<string, PayloadText>();
const FETCH_CONCURRENCY = 6;

type PayloadText = { status: "ready"; text: string } | { status: "erased" } | { status: "error" };

async function loadPayloads(
  sessionId: string,
  hashes: readonly string[],
  onEach: () => void,
): Promise<void> {
  const queue = hashes.filter((hash) => !payloadCache.has(hash));
  const worker = async () => {
    for (let hash = queue.shift(); hash; hash = queue.shift()) {
      const payload = await fetchTurnPayload(sessionId, hash);
      payloadCache.set(
        hash,
        payload === null
          ? { status: "error" }
          : payload.kind === "erased"
            ? { status: "erased" }
            : { status: "ready", text: payload.text },
      );
      onEach();
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
}

export type AuditPromptTarget = {
  prompt: ProviderPromptRefs;
  model?: string;
  turn?: number;
  inputTokens?: number;
};

type Section = {
  key: string;
  label: string;
  role: PromptMessageView["role"] | "response";
  hash: string;
};

export function AuditPromptDialog({
  sessionId,
  target,
  onClose,
}: {
  sessionId: string;
  target: AuditPromptTarget | null;
  onClose: () => void;
}) {
  const t = useT();
  const copy = t.brainPage.audit.prompt;
  const [, setVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  const sections = useMemo<Section[]>(() => {
    if (!target) return [];
    const { systemRef, messageRefs, responseRef } = target.prompt;
    return [
      ...(systemRef ? [{ key: "system", label: copy.system, role: "system" as const, hash: systemRef }] : []),
      ...messageRefs.map((hash, index) => ({
        key: `m${index}`,
        label: format(copy.messageN, { index: index + 1 }),
        role: "other" as const,
        hash,
      })),
      ...(responseRef ? [{ key: "response", label: copy.response, role: "response" as const, hash: responseRef }] : []),
    ];
  }, [target, copy]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setCopied(false);
    void loadPayloads(sessionId, sections.map((section) => section.hash), () => {
      if (!cancelled) setVersion((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, target, sections]);

  const rendered = sections.map((section) => {
    const payload = payloadCache.get(section.hash);
    if (!payload) return { ...section, text: null as string | null, state: "loading" as const };
    if (payload.status !== "ready") return { ...section, text: null, state: payload.status };
    if (section.role === "system") return { ...section, text: payload.text, state: "ready" as const };
    const view = section.role === "response"
      ? formatPromptResponse(payload.text)
      : formatPromptMessage(payload.text);
    return { ...section, role: section.role === "response" ? section.role : view.role, text: view.text, state: "ready" as const };
  });
  const loaded = rendered.filter((section) => section.state !== "loading").length;
  const allReady = rendered.length > 0 && rendered.every((section) => section.state === "ready");

  const roleLabel = (role: Section["role"]) =>
    role === "system"
      ? copy.roles.system
      : role === "user"
        ? copy.roles.user
        : role === "assistant"
          ? copy.roles.assistant
          : role === "response"
            ? copy.roles.response
            : copy.roles.other;

  const copyAll = async () => {
    const text = rendered
      .map((section) => `### ${section.label} (${roleLabel(section.role)})\n\n${section.text ?? ""}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const meta = target
    ? [
        target.model,
        target.turn !== undefined ? format(copy.round, { turn: target.turn + 1 }) : null,
        target.inputTokens ? format(copy.tokensIn, { count: formatTokens(target.inputTokens) }) : null,
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex h-[min(88vh,960px)] w-[calc(var(--native-app-width,100vw)-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl ring-1 ring-foreground/5 outline-none transition-[opacity,transform] duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold text-foreground">{copy.title}</Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-xs text-muted-foreground">
                {meta ? `${meta} · ` : ""}{copy.hint}
              </Dialog.Description>
            </div>
            <button
              type="button"
              disabled={!allReady}
              onClick={() => void copyAll()}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border md:h-8 border-border px-2.5 text-xs text-foreground hover:bg-muted disabled:opacity-50"
            >
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? copy.copied : copy.copyAll}
            </button>
            <Dialog.Close aria-label={copy.close} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:size-8">
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loaded < rendered.length && (
              <p className="pb-2 text-[11px] text-muted-foreground" role="status">
                {format(copy.loading, { loaded, total: rendered.length })}
              </p>
            )}
            <ol className="flex flex-col gap-3">
              {rendered.map((section) => (
                <li key={section.key}>
                  <details open className="group rounded-lg border border-border">
                    <summary className="flex max-sm:min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          section.role === "system"
                            ? "bg-[var(--graph-highlight)]/15 text-foreground"
                            : section.role === "response" || section.role === "assistant"
                              ? "bg-primary/10 text-foreground"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {roleLabel(section.role)}
                      </span>
                      <span className="font-medium text-foreground">{section.label}</span>
                      {section.text !== null && (
                        <span className="ml-auto tabular-nums text-muted-foreground">
                          {format(copy.chars, { count: section.text.length.toLocaleString() })}
                        </span>
                      )}
                    </summary>
                    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/90">
                      {section.state === "ready"
                        ? section.text
                        : section.state === "erased"
                          ? copy.erased
                          : section.state === "error"
                            ? copy.unavailable
                            : copy.loadingOne}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
