"use client";

/**
 * Settings modal for the app-web surface.
 *
 * Ported from `apps/web/src/components/settings-modal/settings-modal.tsx`.
 * Notion-style two-rail overlay. Houses ADMIN-only sections (account,
 * members, billing, workspace settings). FUNCTIONAL config (connectors,
 * skills, assistants, channels, sensitivity, ingest rules) lives in the
 * core web app's Studio, NOT here.
 *
 * Below the `sm` breakpoint the modal goes full-screen master-detail: the
 * section rail is the first (and only) pane; picking a section swaps to the
 * section body with a Back control. Two-rail from `sm:` up. The 224px rail
 * plus a squeezed body simply doesn't fit a phone.
 *
 * Unlike apps/web — which reuses the `(app)/settings/*` route page
 * components directly — app-web has no settings routes, so the
 * section bodies are imported as named-export components ported into
 * `./sections/*` and `./workspace-sections`. The modal stays a thin
 * shell that dispatches to them.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { isOssEdition, HOSTED_UPGRADE_URL } from "@/lib/edition";
import { AccountSection } from "./sections/account-section";
import { GeneralSection } from "./sections/general-section";
import { PrivacySection } from "./sections/privacy-section";
import { BillingSection } from "./sections/billing-section";
import { BrowserProfilesSection } from "./sections/browser-profiles-section";
import { ModelsSection } from "./sections/models-section";
import { DomainsSection } from "./sections/domains-section";
import {
  WorkspaceGeneralSection,
  WorkspaceMembersSection,
  WorkspaceLlmKeySection,
} from "./workspace-sections";

export type SettingsSection =
  | "profile"
  | "preferences"
  | "privacy"
  | "notifications"
  | "ws-general"
  | "ws-members"
  | "ws-llm-key"
  | "ws-domains"
  | "ws-plan"
  | "ws-usage"
  | "ws-models"
  | "ws-browser-profiles";

// Cross-component request to open the settings modal at a given section. The
// modal is owned by `workspace-switcher.tsx` (local state), so surfaces that
// don't host it — e.g. the sidebar theme picker's "edit" action — ask for it via
// this window event instead of threading a context. The switcher listens and
// opens. Window events are the established cross-component seam here (cf.
// `doc:theme-changed`, `doc:draft-created`).
export const OPEN_SETTINGS_EVENT = "doc:open-settings";
export type OpenSettingsDetail = { section: SettingsSection };

/** Dispatch a request to open the settings modal at `section`. No-op on the
 *  server (guards `window`) so it's safe to call from event handlers in SSR'd
 *  client components. */
export function openWorkspaceSettings(section: SettingsSection): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, {
      detail: { section },
    }),
  );
}

type Props = {
  open: boolean;
  initialSection?: SettingsSection;
  onClose: () => void;
};

// Billing is per-workspace (migration 143) — it lives under the
// WORKSPACE group's "Plan" section, not as an account setting.
const ACCOUNT_SECTIONS: SettingsSection[] = [
  "profile",
  "preferences",
  "privacy",
  "notifications",
];
const WORKSPACE_SECTIONS: SettingsSection[] = [
  "ws-general",
  "ws-members",
  // ws-llm-key is absent here on purpose: hosted surfaces the BYO Gemini key
  // block inside the Models section (everything model-related in one place).
  // The OSS list below keeps the standalone section — it has no Models entry.
  // Domains (custom-domains.md + platform-subdomains.md) — the workspace-level
  // manager for published-page hostnames. Open feature, so OSS keeps it too.
  "ws-domains",
  // ws-usage is absent on purpose: the Usage block renders inside ws-plan
  // ("Plan & usage") — the alias case below still routes old deep links.
  "ws-plan",
  // Metered model profiles (model-registry.md L15). Hosted-only: the lane
  // bills credits; the OSS list below omits it.
  "ws-models",
  // Computer-use Profile-Management (hosted-only: profiles + the vault are
  // closed platform halves, so the OSS list below omits it).
  "ws-browser-profiles",
];
// The OSS single-player edition has no billing: drop the Plan + Usage sections
// entirely. Members stays (relabeled "Teammates"), routed to the hosted-upgrade
// pitch instead of the live members manager. Hosted keeps the full list above.
const OSS_WORKSPACE_SECTIONS: SettingsSection[] = [
  "ws-general",
  "ws-members",
  "ws-llm-key",
  "ws-domains",
];

export function SettingsModal({ open, initialSection = "profile", onClose }: Props) {
  const t = useT();
  const oss = isOssEdition();
  const workspaceSections = oss ? OSS_WORKSPACE_SECTIONS : WORKSPACE_SECTIONS;
  const [section, setSection] = useState<SettingsSection>(initialSection);
  // Which pane shows below the `sm` breakpoint (no effect from `sm:` up,
  // where both panes render side by side): the modal opens on the section
  // rail; picking a section swaps to its body with a Back control.
  const [mobilePane, setMobilePane] = useState<"nav" | "body">("nav");
  // Track previous open/initialSection so we can reset `section` when the
  // modal transitions from closed→open or initialSection changes while
  // open. "Adjusting state during render" per React docs — avoids the
  // setState-in-effect anti-pattern.
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevInitial, setPrevInitial] = useState(initialSection);
  if (open !== prevOpen || initialSection !== prevInitial) {
    setPrevOpen(open);
    setPrevInitial(initialSection);
    if (open) {
      setSection(initialSection);
      setMobilePane("nav");
    }
  }

  const selectSection = (s: SettingsSection) => {
    setSection(s);
    setMobilePane("body");
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // SSR-safe portal mount guard — document.body only exists client-side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!open || !mounted) return null;

  // Portal to <body> so the fixed overlay escapes the sidebar's transformed
  // ancestor (the chrome wrapper carries `md:translate-x-0`, which would
  // otherwise make `position: fixed` resolve to the 256px sidebar column
  // instead of the viewport — clipping the modal). Mirrors the AlertDialog.Portal
  // already used by DeleteWorkspaceDialog.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-background/40 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <div className="min-h-full flex items-center justify-center p-0 sm:p-6">
        <div
          role="dialog"
          aria-label={t.chrome.settingsModal.title}
          className={cn(
            "relative w-full max-w-4xl bg-popover border border-border rounded-none sm:rounded-xl shadow-2xl",
            "flex overflow-hidden",
            "h-[100dvh] sm:h-[85vh]",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Left rail — the only pane on phones until a section is picked */}
          <nav
            aria-label="Settings sections"
            className={cn(
              "w-full sm:w-56 shrink-0 sm:border-r border-border p-3 overflow-y-auto",
              mobilePane === "body" && "hidden sm:block",
            )}
          >
            <SectionGroup
              label={t.chrome.settingsModal.workspace.section}
              sections={workspaceSections}
              active={section}
              onSelect={selectSection}
              labels={{
                "ws-general": t.chrome.settingsModal.workspace.general,
                "ws-members": oss
                  ? t.chrome.settingsModal.upgrade.teammatesNav
                  : t.chrome.settingsModal.workspace.members,
                "ws-llm-key": t.chrome.settingsModal.workspace.llmKey,
                "ws-domains": t.chrome.settingsModal.workspace.domains,
                "ws-plan": t.chrome.settingsModal.workspace.plan,
                "ws-usage": t.chrome.settingsModal.workspace.usage,
                "ws-models": t.chrome.settingsModal.workspace.models,
                "ws-browser-profiles": t.chrome.settingsModal.workspace.browserProfiles,
              }}
            />
            <div className="mt-4">
              <SectionGroup
                label={t.chrome.settingsModal.account.section}
                sections={ACCOUNT_SECTIONS}
                active={section}
                onSelect={selectSection}
                labels={{
                  profile: t.chrome.settingsModal.account.profile,
                  preferences: t.chrome.settingsModal.account.preferences,
                  privacy: t.chrome.settingsModal.account.privacy,
                  notifications: t.chrome.settingsModal.account.notifications,
                }}
              />
            </div>
          </nav>

          {/* Right pane — swaps in for the rail on phones */}
          <div
            className={cn(
              "flex-1 overflow-y-auto p-6",
              mobilePane === "nav" && "hidden sm:block",
            )}
          >
            <button
              type="button"
              onClick={() => setMobilePane("nav")}
              className="sm:hidden -ml-2 mb-4 inline-flex items-center gap-1.5 rounded px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t.chrome.settingsModal.back}
            </button>
            <SectionBody section={section} onClose={onClose} />
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t.chrome.settingsModal.close}
            className="absolute top-3 right-3 h-7 w-7 rounded hover:bg-muted inline-flex items-center justify-center text-muted-foreground"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SectionGroup({
  label,
  sections,
  active,
  onSelect,
  labels,
}: {
  label: string;
  sections: SettingsSection[];
  active: SettingsSection;
  onSelect: (s: SettingsSection) => void;
  labels: Partial<Record<SettingsSection, string>>;
}) {
  return (
    <div>
      <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <ul className="flex flex-col">
        {sections.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onSelect(s)}
              aria-current={active === s ? "page" : undefined}
              className={cn(
                "w-full text-left px-2 py-1.5 text-sm rounded transition-colors",
                active === s
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {labels[s]}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionBody({
  section,
  onClose,
}: {
  section: SettingsSection;
  onClose: () => void;
}) {
  switch (section) {
    case "profile":
      return <AccountSection />;
    case "preferences":
      return <GeneralSection />;
    case "privacy":
      return <PrivacySection />;
    case "notifications":
      return <NotificationsSection />;
    case "ws-general":
      return <WorkspaceGeneralSection onWorkspaceDeleted={onClose} />;
    case "ws-members":
      // OSS is single-player: teammates are a hosted-cloud feature, so the
      // Members section pitches the upgrade instead of the live manager.
      return isOssEdition() ? <HostedUpgradeSection /> : <WorkspaceMembersSection />;
    case "ws-llm-key":
      return <WorkspaceLlmKeySection />;
    case "ws-domains":
      // Domains work in both editions (open feature): the workspace-level
      // subdomain + custom-domain manager (platform-subdomains.md).
      return <DomainsSection />;
    case "ws-plan":
      // Billing is per-workspace — the "Plan" section IS the billing
      // surface (plan tier, payment method, invoices, upgrade/cancel).
      // OSS has no billing; defensively pitch the upgrade in case something
      // dispatches openWorkspaceSettings('ws-plan') directly (the nav hides it).
      return isOssEdition() ? <HostedUpgradeSection /> : <BillingSection />;
    case "ws-usage":
      // Alias: Usage merged into the Plan section ("Plan & usage"). Kept so
      // openWorkspaceSettings("ws-usage") deep links still land somewhere
      // sensible. OSS has no billing; defensive upgrade pitch.
      return isOssEdition() ? <HostedUpgradeSection /> : <BillingSection />;
    case "ws-models":
      // Metered model profiles (model-registry.md L15). The lane is a
      // hosted billing construct; OSS nav hides the section, this is defensive.
      return isOssEdition() ? <HostedUpgradeSection /> : <ModelsSection />;
    case "ws-browser-profiles":
      // Computer-use Profile-Management (computer-use.md §7, R2-4). Profiles
      // + the vault are closed platform halves; OSS nav hides the section,
      // this is defensive.
      return isOssEdition() ? <HostedUpgradeSection /> : <BrowserProfilesSection />;
  }
}

function HostedUpgradeSection() {
  const t = useT();
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.chrome.settingsModal.upgrade.heading}</h2>
      <div className="border-t border-border pt-6 space-y-4">
        <p className="text-sm text-muted-foreground max-w-prose">
          {t.chrome.settingsModal.upgrade.body}
        </p>
        <a
          href={HOSTED_UPGRADE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t.chrome.settingsModal.upgrade.cta}
        </a>
      </div>
    </div>
  );
}

function NotificationsSection() {
  const t = useT();
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.chrome.settingsModal.account.notifications}</h2>
      <div className="border-t border-border pt-6 text-sm text-muted-foreground">
        {t.chrome.settingsModal.body.notificationsComingSoon}
      </div>
    </div>
  );
}
