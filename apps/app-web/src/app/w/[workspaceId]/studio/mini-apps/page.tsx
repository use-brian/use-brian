"use client";

/**
 * Studio → Mini-apps store (app-web).
 *
 * Ported from `apps/web/src/app/(app)/studio/mini-apps/page.tsx` as part of
 * the studio surface migration (docs/plans/doc-web-app-consolidation.md
 * §9 #5). Card grid of installable surfaces, each deep-linking to the
 * mini-app's standalone deployable:
 *
 *   distribution (Feed)   → feed-web   `${FEED_APP_URL}/w/<wid>`
 *
 * The `views` (Doc) mini-app is intentionally **excluded from this gallery**
 * (`STUDIO_HIDDEN_MINI_APPS`): app-web *is* the Doc surface, so a card that
 * deep-links back to `${AUTHED_APP_URL}/w/<wid>/doc` would point at the app
 * the user is already inside. It stays in the shared `MINI_APPS` registry for
 * the apps/web onboarding picker + workspace-home, where listing Doc as an
 * installable capability still makes sense.
 *
 * Both surfaces are sibling deployables on their own origin, so the gallery
 * uses `window.open` instead of router push. Mini-apps with `status: 'alpha'`
 * (Feed today) are gated behind a manual trial request: the card shows an
 * "Alpha" pill and a "Contact us for trial" CTA that opens a `mailto:`.
 * `status: 'coming_soon'` cards render disabled with no CTA.
 *
 * The `MINI_APPS` registry is imported directly from `@sidanclaw/shared`
 * (the `./mini-apps` subpath, so the server-only `env.js` barrel never reaches
 * the client bundle) — the single source of truth, same as apps/web. No local
 * mirror.
 *
 * Strings live under `workspace.home.miniApps.*`; the studio section name /
 * description live under `studioPage.sections.miniApps` and
 * `studioPage.sectionDescriptions.miniApps`.
 *
 * Spec: docs/architecture/features/web-ui.md → Studio.
 * [COMP:app-web/studio-mini-apps]
 */

import { useRouter } from "next/navigation";
import { Sparkles, Megaphone, Table } from "lucide-react";
import {
  MINI_APPS,
  type MiniAppId,
  type MiniAppMeta,
  type SupportedApp,
} from "@sidanclaw/shared/mini-apps";
import { useWorkspaces } from "@/contexts/workspace-context";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { isOssEdition } from "@/lib/edition";

const FEED_APP_URL =
  process.env.NEXT_PUBLIC_FEED_URL ?? "https://feed.sidan.ai";
const AUTHED_APP_URL =
  process.env.NEXT_PUBLIC_AUTHED_APP_URL ?? "https://app.sidan.ai";
// Alpha mini-apps are gated behind a trial request rather than self-serve
// open — the card opens a pre-filled mailto here. Mirrors the contact
// address used by the billing / pricing "Contact sales" CTAs.
const TRIAL_CONTACT_EMAIL = "contact@sidan.io";

// User-visible strings come from the i18n dictionaries keyed by mini-app id
// (`workspace.home.miniApps.<id>`); the gallery iterates the shared `MINI_APPS`
// registry for order/status/icon and looks up copy by id.

// Mini-apps the Studio store hides. `views` (Doc) is the surface app-web
// itself renders, so a card linking back to /doc would be circular - see the
// header note. The id stays in the shared registry for the apps/web surfaces.
// In the OSS edition the gallery also hides `distribution` (Feed) - Feed is a
// hosted-only mini-app. This is belt-and-suspenders: the whole Mini-apps
// section is nav-hidden in OSS (`visibleStudioGroups`), so the gallery is
// already unreachable there, but the filter keeps the page coherent if reached
// directly by URL.
function studioHiddenMiniApps(): Set<MiniAppId> {
  const hidden = new Set<MiniAppId>(["views"]);
  if (isOssEdition()) hidden.add("distribution");
  return hidden;
}

const ICON_BY_NAME: Record<string, React.ComponentType<{ className?: string }>> = {
  Megaphone,
  Table,
};

export default function StudioMiniAppsPage() {
  const t = useT();
  const { activeId } = useWorkspaces();

  if (!activeId) {
    return (
      <div className="text-sm text-muted-foreground">
        {t.studioPage.channels.noActiveWorkspace}
      </div>
    );
  }

  return (
    <section>
      {/* Intro row — the topbar breadcrumb names the section
          (docs/architecture/features/studio.md → "Page headers"). */}
      <header className="mb-5">
        <p className="text-[13px] text-muted-foreground max-w-prose">
          {t.studioPage.sectionDescriptions.miniApps}
        </p>
      </header>
      <Gallery workspaceId={activeId} />
    </section>
  );
}

function Gallery({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const hidden = studioHiddenMiniApps();

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {MINI_APPS.filter((app) => !hidden.has(app.id)).map((app) => (
        <Card
          key={app.id}
          app={app}
          workspaceId={workspaceId}
          onNavigate={(href, external) => {
            if (href.startsWith("mailto:")) {
              window.location.href = href;
            } else if (external) {
              window.open(href, "_blank", "noopener,noreferrer");
            } else {
              router.push(href);
            }
          }}
        />
      ))}
    </div>
  );
}

function Card({
  app,
  workspaceId,
  onNavigate,
}: {
  app: MiniAppMeta;
  workspaceId: string;
  onNavigate: (href: string, external?: boolean) => void;
}) {
  const t = useT();
  const meta = t.workspace.home.miniApps[app.id];
  const Icon = ICON_BY_NAME[app.icon] ?? Sparkles;

  const isComingSoon = app.status === "coming_soon";
  const isAlpha = app.status === "alpha";

  // Alpha mini-apps are gated behind a manual trial request — the card opens
  // a pre-filled mailto instead of deep-linking to the deployable.
  const trialMailto = `mailto:${TRIAL_CONTACT_EMAIL}?subject=${encodeURIComponent(
    format(t.workspace.home.trialEmailSubject, { app: meta.label }),
  )}`;

  // Each mini-app deep-links to its own deployable on a separate origin —
  // flagged `external` so the gallery uses `window.open` instead of
  // router push. Alpha cards point at the trial-request mailto instead.
  const target: { href: string; external?: boolean } | null = (() => {
    if (isComingSoon) return null;
    if (isAlpha) return { href: trialMailto, external: true };
    switch (app.id) {
      case "distribution":
        return { href: `${FEED_APP_URL}/w/${workspaceId}`, external: true };
      case "views":
        return { href: `${AUTHED_APP_URL}/w/${workspaceId}/doc`, external: true };
    }
  })();
  const href = target?.href ?? null;

  const ctaLabel = isAlpha
    ? t.workspace.home.contactForTrial
    : t.workspace.home.open;

  return (
    <button
      type="button"
      onClick={() => href && onNavigate(href, target?.external)}
      disabled={isComingSoon}
      className={`text-left rounded-xl border p-4 transition-colors ${
        isComingSoon
          ? "border-border bg-muted/20 cursor-not-allowed opacity-70"
          : "border-border hover:border-primary/40 hover:bg-primary/5 cursor-pointer"
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon className="w-[18px] h-[18px]" />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isAlpha && (
            <span className="text-[10px] font-medium bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200 px-1.5 py-0.5 rounded">
              {t.workspace.home.alphaBadge}
            </span>
          )}
          {/* During alpha, pricing is "contact us" — the Pro tier badge would
              be misleading, so it's suppressed in favor of the Alpha pill. */}
          {app.requiresPaid && !isAlpha && (
            <span className="text-[10px] font-medium bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 px-1.5 py-0.5 rounded">
              {t.workspace.home.proBadge}
            </span>
          )}
          {isComingSoon && (
            <span className="text-[10px] font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
              {t.workspace.home.comingSoon}
            </span>
          )}
        </div>
      </div>
      <div className="text-[14px] font-medium">{meta.label}</div>
      <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
        {meta.description}
      </p>
      {app.supportedApps && app.supportedApps.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          {app.supportedApps.map((id) => (
            <SupportedAppIcon key={id} id={id} />
          ))}
        </div>
      )}
      {!isComingSoon && (
        <div className="mt-3 text-[12px] font-medium text-primary">
          {ctaLabel}
          <span className="ml-1">→</span>
        </div>
      )}
    </button>
  );
}

function SupportedAppIcon({ id }: { id: SupportedApp }) {
  switch (id) {
    case "x":
      return (
        <span
          className="inline-flex w-8 h-8 items-center justify-center rounded-[22%] bg-black text-white ring-1 ring-black/10 dark:ring-white/15"
          aria-label="X"
          title="X"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
          </svg>
        </span>
      );
    case "threads":
      return (
        <span
          className="inline-flex w-8 h-8 items-center justify-center rounded-[22%] bg-black text-white ring-1 ring-black/10 dark:ring-white/15"
          aria-label="Threads"
          title="Threads"
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.781 3.63 2.695 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.74-1.757-.504-.586-1.288-.886-2.327-.893h-.029c-.84 0-1.974.232-2.674 1.295l-1.738-1.187c.94-1.42 2.45-2.205 4.412-2.205h.04c3.282.02 5.232 2.043 5.428 5.583.111.048.222.097.328.147 1.5.704 2.598 1.77 3.174 3.083.804 1.831.878 4.815-1.552 7.245-1.857 1.853-4.114 2.692-7.317 2.714Zm1.825-9.476a8.39 8.39 0 0 0-2.155.224c-1.41.225-2.218 1.027-2.218 2.064 0 1.064 1.06 2.024 2.665 2.024 1.587 0 2.97-.652 3.41-2.32-.4-.21-.83-.39-1.282-.512a8.385 8.385 0 0 0-1.06-.135 5.6 5.6 0 0 0-.36-.013z" />
          </svg>
        </span>
      );
  }
}
