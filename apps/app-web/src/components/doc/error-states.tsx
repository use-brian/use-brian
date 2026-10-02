"use client";

/**
 * Phase 4 — Bundle of error placeholders / boundaries for the Doc
 * surface.
 *
 *   • `ErrorBoundary`         — generic React class boundary with a
 *                                reload button. Wrap the doc shell
 *                                or any block subtree.
 *   • `NetworkErrorBanner`    — sticky top banner showing "Connection
 *                                lost. Retrying…" with an explicit retry
 *                                callback the host wires.
 *   • `CollabStatusIndicator` — live Yjs connection pill (connected /
 *                                reconnecting / offline) driven by the
 *                                `HocuspocusProvider` status. Replaces the
 *                                old `VersionMismatchToast`: under the CRDT
 *                                model edits always merge, so there is no
 *                                "page changed upstream → refresh" state to
 *                                surface — only the connection itself.
 *
 * All strings flow through `useT()`. Theme tokens only.
 *
 * [COMP:app-web/error-states]
 */

import {
  Component,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import Image from "next/image";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  Copy,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { CollabStatus } from "@/lib/collab/use-collab-provider";
import { Button } from "@/components/ui/button";

const DIAGNOSTIC_ERROR_LIMIT = 20_000;

type PageLoadDiagnosticCopy = {
  diagnosticsTitle: string;
  technicalTime: string;
  technicalRoute: string;
  diagnosticsOnline: string;
  technicalStatus: string;
  diagnosticsUserAgent: string;
  diagnosticsError: string;
  diagnosticsYes: string;
  diagnosticsNo: string;
  diagnosticsUnknown: string;
  diagnosticsTruncated: string;
};

function pageLoadHttpStatus(error: string): number | null {
  const match = /^HTTP\s+(\d{3})\b/i.exec(error.trim());
  return match ? Number(match[1]) : null;
}

export function isServerUnavailableError(error: string): boolean {
  const status = pageLoadHttpStatus(error);
  if (status !== null) return status >= 500 && status <= 599;
  return /(failed to fetch|network\s*error|network request failed|load failed)/i.test(error);
}

export function buildPageLoadDiagnostics(
  error: string,
  context: {
    occurredAt: string;
    path: string;
    online?: boolean;
    userAgent?: string;
  },
  copy: PageLoadDiagnosticCopy,
): string {
  const status = pageLoadHttpStatus(error);
  const clipped = error.slice(0, DIAGNOSTIC_ERROR_LIMIT);
  const errorText = error.length > clipped.length
    ? `${clipped}\n${copy.diagnosticsTruncated}`
    : clipped;
  return [
    copy.diagnosticsTitle,
    `${copy.technicalTime}: ${context.occurredAt}`,
    `${copy.technicalRoute}: ${context.path || "/"}`,
    `${copy.diagnosticsOnline}: ${context.online === undefined ? copy.diagnosticsUnknown : context.online ? copy.diagnosticsYes : copy.diagnosticsNo}`,
    `${copy.technicalStatus}: ${status === null ? copy.diagnosticsUnknown : `HTTP ${status}`}`,
    `${copy.diagnosticsUserAgent}: ${context.userAgent || copy.diagnosticsUnknown}`,
    "",
    `${copy.diagnosticsError}:`,
    errorText,
  ].join("\n");
}

// ── ErrorBoundary ───────────────────────────────────────────────────────

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Optional override for the fallback render. */
  fallback?: (
    error: Error,
    reset: () => void,
  ) => ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/**
 * Generic error boundary. Renders a centred fallback card with a
 * "Reload" button when a descendant throws. The button resets local
 * state — if the underlying source of the error is sticky (e.g. a
 * broken store), the parent should also remount via `key`.
 *
 * Class component because that's the React API for catching render
 * errors. Strings come in via the static fallback that consumes the
 * dictionary through a hook — `getDerivedStateFromError` itself can't
 * call hooks.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaces in the browser console; the analytics pipeline picks
    // these up via the global `error` handler elsewhere — no extra wire
    // here.
    console.error("[app-web] ErrorBoundary caught:", error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <ErrorFallback error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

/** Default fallback rendered by `ErrorBoundary` when no custom one is supplied. */
function ErrorFallback({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const t = useT().docPage.errors;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-8 text-center"
    >
      <div
        aria-hidden
        className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive"
      >
        <AlertTriangle className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {t.boundaryTitle}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t.boundaryDesc}
        </p>
        {error.message ? (
          <p className="mt-2 break-words rounded bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground/90">
            {error.message}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={reset}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-action px-3 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90"
      >
        <RefreshCw className="size-3.5" aria-hidden />
        {t.boundaryReload}
      </button>
    </div>
  );
}

// ── PageLoadErrorState ────────────────────────────────────────────────

/**
 * Full centre-pane recovery state for a cold page-metadata failure.
 *
 * The upstream response remains available for support, but only through the
 * explicit clipboard action. Proxy HTML must never become the page's visual
 * hierarchy again.
 */
export function PageLoadErrorState({
  error,
  occurredAt,
  path,
  onRetry,
}: {
  error: string;
  occurredAt: string;
  path: string;
  onRetry: () => void;
}) {
  const t = useT().docPage.errors;
  const serverUnavailable = isServerUnavailableError(error);
  const status = pageLoadHttpStatus(error);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const copyDiagnostics = async () => {
    if (!navigator.clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(buildPageLoadDiagnostics(
        error,
        {
          occurredAt,
          path,
          online: navigator.onLine,
          userAgent: navigator.userAgent,
        },
        t,
      ));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6">
      <section
        role="alert"
        aria-live="assertive"
        className="m-auto w-full max-w-lg rounded-2xl border border-border/70 bg-card/70 px-5 py-7 text-center shadow-sm sm:px-8 sm:py-9"
      >
        <div aria-hidden className="relative mx-auto mb-5 flex size-28 items-center justify-center rounded-[2rem] bg-muted/70 ring-1 ring-border/50">
          <Image
            src="/icon.png"
            alt=""
            width={64}
            height={64}
            className="size-16 grayscale opacity-60 contrast-125 dark:opacity-70"
          />
          <span className="absolute -bottom-1 -right-1 flex size-10 items-center justify-center rounded-2xl border-4 border-card bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <CloudOff className="size-5" />
          </span>
        </div>

        <span className="inline-flex rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
          {serverUnavailable ? t.serverUnavailableBadge : t.pageUnavailableBadge}
        </span>
        <h1 className="mt-3 text-balance text-2xl font-semibold tracking-tight text-foreground">
          {serverUnavailable ? t.serverUnavailableTitle : t.pageUnavailableTitle}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-6 text-muted-foreground">
          {serverUnavailable ? t.serverUnavailableDesc : t.pageUnavailableDesc}
        </p>

        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Button type="button" size="lg" className="min-h-11 sm:min-w-32" onClick={onRetry}>
            <RefreshCw aria-hidden />
            {t.pageLoadRetry}
          </Button>
          <Button type="button" size="lg" variant="outline" className="min-h-11 sm:min-w-40" onClick={() => void copyDiagnostics()}>
            {copyState === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copyState === "copied" ? t.diagnosticsCopied : t.copyDiagnostics}
          </Button>
        </div>
        {copyState === "failed" ? (
          <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">
            {t.diagnosticsCopyFailed}
          </p>
        ) : null}

        <details className="group mt-6 border-t border-border/70 pt-2 text-left">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-2 text-sm font-medium text-muted-foreground outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {t.technicalDetails}
            <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <dl className="mt-1 space-y-2 px-2 py-2 text-xs">
            {status !== null ? (
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{t.technicalStatus}</dt>
                <dd className="font-mono text-foreground">HTTP {status}</dd>
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted-foreground">{t.technicalTime}</dt>
              <dd className="break-all text-right font-mono text-foreground">{occurredAt}</dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted-foreground">{t.technicalRoute}</dt>
              <dd className="break-all text-right font-mono text-foreground">{path}</dd>
            </div>
          </dl>
        </details>
      </section>
    </div>
  );
}

// ── NetworkErrorBanner ──────────────────────────────────────────────────

/**
 * Sticky top banner shown when a fetch loop reports a sustained
 * connection failure. The component is presentational — the host owns
 * the visibility logic and the retry handler.
 */
export function NetworkErrorBanner({
  onRetry,
  className,
}: {
  onRetry?: () => void;
  className?: string;
}) {
  const t = useT().docPage.errors;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <WifiOff className="size-3.5 shrink-0" aria-hidden />
      <span className="flex-1">{t.networkRetrying}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium underline-offset-2 hover:underline"
        >
          {t.networkRetry}
        </button>
      ) : null}
    </div>
  );
}

// ── CollabStatusIndicator ───────────────────────────────────────────────

/**
 * Live collaboration connection pill. Reports the `HocuspocusProvider`
 * status (from `use-collab-provider.ts`) as one of three states:
 *
 *   - **connected + synced** → "Live" (a calm cloud dot).
 *   - **connecting** (or connected-but-not-yet-synced) → "Reconnecting…".
 *   - **disconnected** → "Offline — changes save when you reconnect".
 *
 * This deliberately replaces the old `VersionMismatchToast`: a CRDT never
 * produces a version conflict (edits merge), so the only thing worth
 * surfacing is whether the user's keystrokes are reaching the server. The
 * pill is presentational + inline; the host decides where to place it.
 */
export function CollabStatusIndicator({
  status,
  synced,
  className,
}: {
  status: CollabStatus;
  /** Has the initial document sync completed? */
  synced: boolean;
  className?: string;
}) {
  const t = useT().docPage.errors;

  const state: "connected" | "reconnecting" | "offline" =
    status === "connected" && synced
      ? "connected"
      : status === "disconnected"
        ? "offline"
        : "reconnecting";

  const label =
    state === "connected"
      ? t.collabConnected
      : state === "offline"
        ? t.collabOffline
        : t.collabReconnecting;

  const tone =
    state === "connected"
      ? "text-muted-foreground"
      : state === "offline"
        ? "text-amber-700 dark:text-amber-300"
        : "text-muted-foreground";

  return (
    <span
      role="status"
      aria-live="polite"
      data-collab-status={state}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[11px]",
        tone,
        className,
      )}
    >
      {state === "connected" ? (
        <Cloud className="size-3" aria-hidden />
      ) : state === "offline" ? (
        <CloudOff className="size-3" aria-hidden />
      ) : (
        <RefreshCw className="size-3 animate-spin" aria-hidden />
      )}
      <span>{label}</span>
    </span>
  );
}
