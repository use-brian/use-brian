"use client";

/**
 * Dedicated CRM email-review workspace. A compact queue + relationship rail
 * sits beside one resizable work surface containing the archived conversation
 * and draft, so the message being reviewed owns most of the viewport.
 *
 * [COMP:app-web/crm-email-review]
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Building2,
  Check,
  ChevronRight,
  Clock3,
  Mail,
  Phone,
  RefreshCw,
  Tags,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { extractEmailSender, parseToolPreview } from "@/lib/approval-previews";
import {
  fetchEmailReviewContext,
  respondByKind,
  reviseEmailApproval,
  type EmailReviewContext,
  type PendingApprovalRow,
} from "@/lib/api/approvals";
import type { CrmData } from "@/lib/api/crm";
import type { CrmEmailApprovalQueueItem } from "@/lib/crm-r2";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

type ReviewOperation = "save" | "approve" | "reject" | null;

const REVIEW_MAIN_STORAGE_KEY = "crm:email-review-main-width";
const REVIEW_MAIN_MIN_WIDTH = 448;
const REVIEW_CONTEXT_MIN_WIDTH = 240;
const REVIEW_RESIZE_STEP = 24;

function storedReviewWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REVIEW_MAIN_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= REVIEW_MAIN_MIN_WIDTH
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function useEmailReviewResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const frameRef = useRef<number | null>(null);
  const detachDragRef = useRef<(() => void) | null>(null);
  const [width, setWidth] = useState<number | null>(storedReviewWidth);
  const [resizing, setResizing] = useState(false);

  const clamp = useCallback((desired: number) => {
    const available = containerRef.current?.getBoundingClientRect().width
      ?? window.innerWidth;
    const maximum = Math.max(
      REVIEW_MAIN_MIN_WIDTH,
      available - REVIEW_CONTEXT_MIN_WIDTH,
    );
    return Math.min(Math.max(desired, REVIEW_MAIN_MIN_WIDTH), maximum);
  }, []);

  const persist = useCallback((next: number | null) => {
    try {
      if (next === null) window.localStorage.removeItem(REVIEW_MAIN_STORAGE_KEY);
      else window.localStorage.setItem(REVIEW_MAIN_STORAGE_KEY, String(next));
    } catch {
      // A remembered split is a convenience, never a requirement.
    }
  }, []);

  useEffect(() => () => {
    detachDragRef.current?.();
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    detachDragRef.current?.();
    const container = containerRef.current?.getBoundingClientRect();
    const right = container?.right ?? window.innerWidth;
    let latest = mainRef.current?.getBoundingClientRect().width
      ?? width
      ?? REVIEW_MAIN_MIN_WIDTH;
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      latest = clamp(right - moveEvent.clientX);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        setWidth(latest);
      });
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    const onEnd = () => {
      detach();
      detachDragRef.current = null;
      setResizing(false);
      setWidth(latest);
      persist(latest);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    detachDragRef.current = detach;
  }, [clamp, persist, width]);

  const onDoubleClick = useCallback(() => {
    setWidth(null);
    persist(null);
  }, [persist]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = mainRef.current?.getBoundingClientRect().width
      ?? width
      ?? REVIEW_MAIN_MIN_WIDTH;
    const delta = event.key === "ArrowLeft"
      ? REVIEW_RESIZE_STEP
      : -REVIEW_RESIZE_STEP;
    const next = clamp(current + delta);
    setWidth(next);
    persist(next);
  }, [clamp, persist, width]);

  return {
    containerRef,
    mainRef,
    width,
    resizing,
    handleProps: { onPointerDown, onDoubleClick, onKeyDown },
  };
}

export function CrmEmailReviewWorkspace({
  workspaceId,
  data,
  items,
  selectedId,
  loading,
  loadError,
  onSelect,
  onReload,
  onResolved,
  onRevised,
  onOpenContact,
}: {
  workspaceId: string;
  data: CrmData;
  items: readonly CrmEmailApprovalQueueItem[];
  selectedId: string | null;
  loading: boolean;
  loadError: boolean;
  onSelect: (approvalId: string) => void;
  onReload: () => void;
  onResolved: (approvalId: string) => void;
  onRevised: (oldId: string, next: PendingApprovalRow) => void;
  onOpenContact: (contactId: string) => void;
}) {
  const dictionary = useT();
  const t = dictionary.crmPage.r2;
  const emailT = dictionary.approvalsPage.emailPreview;
  const selected = useMemo(
    () => items.find((item) => item.approval.id === selectedId) ?? null,
    [items, selectedId],
  );
  const row = selected?.approval ?? null;
  const savedBody = typeof row?.arguments.body === "string" ? row.arguments.body : "";
  const [body, setBody] = useState(savedBody);
  const [context, setContext] = useState<EmailReviewContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState(false);
  const [operation, setOperation] = useState<ReviewOperation>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBody(savedBody);
    setActionError(null);
    setOperation(null);
  }, [row?.id, savedBody]);

  const loadContext = useCallback(async () => {
    const contactId = selected?.contacts[0]?.id;
    if (!row || !contactId) {
      setContext(null);
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    setContextError(false);
    try {
      setContext(await fetchEmailReviewContext(row.id, contactId));
    } catch {
      setContext(null);
      setContextError(true);
    } finally {
      setContextLoading(false);
    }
  }, [row, selected]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  const preview = row ? parseToolPreview(row.toolName, row.arguments) : null;
  const email = preview?.kind === "email_send" ? preview.email : null;
  const sender = row
    ? extractEmailSender(row.approvalPayload.displayLines)
      ?? email?.from
      ?? emailT.primaryAccount
    : emailT.primaryAccount;
  const dirty = body !== savedBody;
  const revision = row?.approvalPayload.emailDraftRevision ?? 1;
  const selectedContactIds = new Set(selected?.contacts.map((contact) => contact.id) ?? []);
  const relatedDeals = data.deals.filter(
    (deal) => deal.contactId && selectedContactIds.has(deal.contactId),
  );
  const {
    containerRef,
    mainRef,
    width: reviewWidth,
    resizing,
    handleProps,
  } = useEmailReviewResize();

  async function respond(decision: "approved" | "rejected") {
    if (!row || operation) return;
    setOperation(decision === "approved" ? "approve" : "reject");
    setActionError(null);
    const result = await respondByKind(row, decision);
    if (result.ok) {
      onResolved(row.id);
      requestApprovalsRefresh(workspaceId);
      return;
    }
    setActionError("error" in result ? result.error : t.approvalFailed);
    setOperation(null);
  }

  async function saveRevision() {
    if (!row || operation || !dirty || body.trim().length === 0) return;
    setOperation("save");
    setActionError(null);
    const result = await reviseEmailApproval(row.id, body);
    if (result.ok) {
      onRevised(row.id, result.approval);
      requestApprovalsRefresh(workspaceId);
      return;
    }
    setActionError(result.error);
    setOperation(null);
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-y-auto bg-muted/10 lg:flex-row lg:overflow-hidden">
      <aside
        aria-label={t.emailDraftQueue}
        data-email-context-rail
        className="flex min-h-[24rem] shrink-0 flex-col border-b border-border/70 bg-background lg:min-h-0 lg:min-w-60 lg:flex-1 lg:border-b-0 lg:border-r"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t.emailDrafts}</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {format(t.emailDraftCount, { count: String(items.length) })}
            </p>
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t.refreshEmailDrafts}
            disabled={loading}
            onClick={onReload}
          >
            <RefreshCw className={cn(loading && "animate-spin")} aria-hidden />
          </Button>
        </div>

        {dirty && (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
            {t.finishDraftBeforeSwitching}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2 max-lg:max-h-48 lg:max-h-[45%]">
          {loadError && items.length === 0 ? (
            <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
              <p>{t.emailDraftsLoadFailed}</p>
              <Button size="xs" variant="ghost" className="mt-2" onClick={onReload}>
                <RefreshCw aria-hidden /> {t.retry}
              </Button>
            </div>
          ) : loading && items.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">{t.emailDraftsLoading}</p>
          ) : items.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <span className="mx-auto grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                <Check className="size-4" aria-hidden />
              </span>
              <p className="mt-3 text-xs font-medium">{t.emailDraftsEmpty}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t.emailDraftsEmptyDescription}
              </p>
            </div>
          ) : (
            <ol className="space-y-1">
              {items.map((item) => {
                const itemPreview = parseToolPreview(item.approval.toolName, item.approval.arguments);
                const itemEmail = itemPreview?.kind === "email_send" ? itemPreview.email : null;
                const active = item.approval.id === row?.id;
                const switchBlocked = dirty && !active;
                return (
                  <li key={item.approval.id}>
                    <button
                      type="button"
                      disabled={switchBlocked}
                      aria-pressed={active}
                      title={switchBlocked ? t.finishDraftBeforeSwitching : undefined}
                      onClick={() => onSelect(item.approval.id)}
                      className={cn(
                        "group w-full rounded-lg px-2.5 py-2.5 text-left transition-colors",
                        active
                          ? "bg-foreground text-background shadow-sm"
                          : "hover:bg-muted",
                        switchBlocked && "cursor-not-allowed opacity-45",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <Mail className={cn("mt-0.5 size-3.5 shrink-0", active ? "text-background/75" : "text-amber-600")} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 text-xs font-medium leading-snug">
                            {itemEmail?.subject || t.reviewDraft}
                          </div>
                          <div className={cn("mt-1 truncate text-[11px]", active ? "text-background/65" : "text-muted-foreground")}>
                            {item.contacts.map((contact) => contact.name).join(", ")}
                          </div>
                          <div className={cn("mt-1 flex items-center justify-between gap-2 text-[10px]", active ? "text-background/55" : "text-muted-foreground/80")}>
                            <span>{format(t.draftRevision, { number: item.approval.approvalPayload.emailDraftRevision ?? 1 })}</span>
                            <time>{new Date(item.approval.createdAt).toLocaleDateString()}</time>
                          </div>
                        </div>
                        <ChevronRight className={cn("mt-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100", active && "opacity-100")} aria-hidden />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {row && selected && (
          <div className="min-h-0 border-t border-border/70 px-3 py-3 lg:flex-1 lg:overflow-y-auto">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t.crmProfile}</div>
            <div className="mt-2 space-y-2">
              {selected.contacts.map((contact) => {
                const company = contact.companyId
                  ? data.companies.find((candidate) => candidate.id === contact.companyId)
                  : null;
                return (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => onOpenContact(contact.id)}
                    className="group w-full rounded-xl border border-border bg-card p-3 text-left shadow-sm transition-colors hover:bg-accent/40"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted"><UserRound className="size-4" aria-hidden /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <span className="truncate">{contact.name}</span>
                          <ChevronRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">{contact.email}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                      {contact.phone && <span className="inline-flex items-center gap-1"><Phone className="size-3" aria-hidden />{contact.phone}</span>}
                      {company && <span className="inline-flex items-center gap-1"><Building2 className="size-3" aria-hidden />{company.name}</span>}
                      {contact.tags.length > 0 && <span className="inline-flex items-center gap-1"><Tags className="size-3" aria-hidden />{contact.tags.join(", ")}</span>}
                    </div>
                  </button>
                );
              })}
            </div>

            {relatedDeals.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.relatedDeals}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {relatedDeals.slice(0, 4).map((deal) => (
                    <span key={deal.id} className="max-w-full truncate rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">{deal.name}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </aside>

      <main
        ref={mainRef}
        aria-label={t.reviewDraft}
        data-email-review-main
        style={reviewWidth !== null ? {
          width: reviewWidth,
          maxWidth: "calc(100% - 15rem)",
        } : undefined}
        className={cn(
          "relative flex min-h-[42rem] min-w-0 shrink-0 flex-col bg-background lg:min-h-0 lg:min-w-[28rem] lg:w-[68%]",
          resizing && "select-none",
        )}
      >
        <div className="hidden lg:block">
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={dictionary.filterBar.resize}
            aria-valuemin={REVIEW_MAIN_MIN_WIDTH}
            aria-valuenow={reviewWidth !== null ? Math.round(reviewWidth) : undefined}
            {...handleProps}
            className="group/resize absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none select-none outline-none focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
          >
            <div
              className={cn(
                "mx-auto h-full w-px bg-transparent transition-colors group-hover/resize:bg-primary/40",
                resizing && "bg-primary/60 group-hover/resize:bg-primary/60",
              )}
            />
          </div>
        </div>

        {row && selected ? (
          <>
            <header className="shrink-0 border-b border-border/70 px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-muted-foreground">
                  <Mail className="size-3.5 shrink-0" aria-hidden />
                  <span>{t.conversation}</span>
                  {context?.thread?.truncated && <span>· {t.conversationTruncated}</span>}
                </div>
                <span className="shrink-0 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {format(t.draftRevision, { number: revision })}
                </span>
              </div>
              <h3 className="mt-1 truncate text-sm font-semibold">{email?.subject || t.reviewDraft}</h3>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {sender} → {email?.to.join(", ")}
              </p>
            </header>

            {contextLoading ? (
              <div className="shrink-0 border-b border-border/70 px-5 py-4 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-2"><RefreshCw className="size-3.5 animate-spin" aria-hidden />{t.conversationLoading}</span>
              </div>
            ) : contextError ? (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-5 py-3 text-xs text-destructive">
                <p>{t.conversationLoadFailed}</p>
                <Button size="xs" variant="ghost" onClick={() => void loadContext()}>
                  <RefreshCw aria-hidden /> {t.retry}
                </Button>
              </div>
            ) : !context?.thread ? (
              <div className="flex shrink-0 items-start gap-3 border-b border-border/70 bg-muted/20 px-5 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Clock3 className="size-3.5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium">{t.conversationNotSynced}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t.conversationUnavailable}</p>
                </div>
              </div>
            ) : (
              <section aria-label={t.conversation} className="min-h-40 max-h-[42%] shrink-0 overflow-y-auto border-b border-border/70 bg-muted/10 px-5 py-4">
                <ol className="mx-auto max-w-4xl space-y-3">
                  {context.thread.messages.map((message) => (
                    <li key={`${message.folder}:${message.id}`} className="rounded-xl border border-border/70 bg-card p-3 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold">{message.from}</div>
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                            {emailT.to}: {message.to.join(", ")}
                          </div>
                          {message.cc.length > 0 && (
                            <div className="truncate text-[10px] text-muted-foreground">{emailT.cc}: {message.cc.join(", ")}</div>
                          )}
                        </div>
                        {message.sentAt && (
                          <time className="shrink-0 text-[10px] text-muted-foreground">{new Date(message.sentAt).toLocaleString()}</time>
                        )}
                      </div>
                      <p className="mt-3 whitespace-pre-wrap break-words text-[12.5px] leading-6 text-foreground/85">{message.body}</p>
                      {message.bodyTruncated && <div className="mt-2 text-[10px] text-muted-foreground">{t.messageTruncated}</div>}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className="flex min-h-[28rem] flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`crm-email-review-${row.id}`} className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t.reviewDraft}
                  </label>
                  <span className={cn("text-[10px]", dirty ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300")}>
                    {dirty ? t.unsavedChanges : t.savedDraftReady}
                  </span>
                </div>

                <dl className="mt-2 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-[11px]">
                  <dt className="text-muted-foreground">{emailT.from}</dt><dd className="truncate">{sender}</dd>
                  <dt className="text-muted-foreground">{emailT.to}</dt><dd className="truncate">{email?.to.join(", ")}</dd>
                  <dt className="text-muted-foreground">{emailT.subject}</dt><dd className="line-clamp-2 font-medium">{email?.subject}</dd>
                </dl>

                <textarea
                  id={`crm-email-review-${row.id}`}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  aria-label={t.replyBody}
                  className="mt-2 min-h-64 w-full flex-1 resize-none rounded-xl border border-border bg-background px-3 py-3 text-[12.5px] leading-6 outline-none transition-shadow focus:ring-2 focus:ring-ring/30"
                />
                {actionError && <p role="alert" className="mt-2 text-xs text-destructive">{actionError}</p>}
              </div>

              <div className="shrink-0 border-t border-border/70 bg-background/95 p-3 backdrop-blur">
                {dirty && (
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[10px] text-muted-foreground">{t.saveBeforeApprove}</p>
                    <Button size="xs" variant="ghost" disabled={operation !== null} onClick={() => setBody(savedBody)}>
                      {t.discardChanges}
                    </Button>
                  </div>
                )}
                <div className="flex items-center justify-end gap-2">
                  <Button size="sm" variant="destructive" disabled={operation !== null} onClick={() => void respond("rejected")}>
                    <X aria-hidden /> {operation === "reject" ? t.rejectingReply : t.rejectReply}
                  </Button>
                  {dirty ? (
                    <Button size="sm" disabled={operation !== null || body.trim().length === 0} onClick={() => void saveRevision()}>
                      {operation === "save" ? t.saving : t.saveRevision}
                    </Button>
                  ) : (
                    <Button size="sm" disabled={operation !== null} onClick={() => void respond("approved")}>
                      <Check aria-hidden /> {operation === "approve" ? t.approvingReply : t.approveSend}
                    </Button>
                  )}
                </div>
              </div>
            </section>
          </>
        ) : (
          <EmptySelection label={t.selectEmailDraft} />
        )}
      </main>
    </div>
  );
}

function EmptySelection({ label }: { label: string }) {
  return (
    <div className="grid min-h-64 flex-1 place-items-center p-6 text-center">
      <div>
        <span className="mx-auto grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
          <Mail className="size-4" aria-hidden />
        </span>
        <p className="mt-3 text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
