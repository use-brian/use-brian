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
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AlertTriangle, Cloud, CloudOff, RefreshCw, WifiOff } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { CollabStatus } from "@/lib/collab/use-collab-provider";

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
        className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <RefreshCw className="size-3.5" aria-hidden />
        {t.boundaryReload}
      </button>
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
