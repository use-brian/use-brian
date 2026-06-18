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
 * Unlike apps/web — which reuses the `(app)/settings/*` route page
 * components directly — app-web has no settings routes, so the
 * section bodies are imported as named-export components ported into
 * `./sections/*` and `./workspace-sections`. The modal stays a thin
 * shell that dispatches to them.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { isOssEdition, HOSTED_UPGRADE_URL } from "@/lib/edition";
import { AccountSection } from "./sections/account-section";
import { GeneralSection } from "./sections/general-section";
import { PrivacySection } from "./sections/privacy-section";
import { BillingSection } from "./sections/billing-section";
import { UsageSection } from "./sections/usage-section";
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
  | "ws-plan"
  | "ws-usage";

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
  "ws-llm-key",
  "ws-plan",
  "ws-usage",
];
// The OSS single-player edition has no billing: drop the Plan + Usage sections
// entirely. Members stays (relabeled "Teammates"), routed to the hosted-upgrade
// pitch instead of the live members manager. Hosted keeps the full list above.
const OSS_WORKSPACE_SECTIONS: SettingsSection[] = [
  "ws-general",
  "ws-members",
  "ws-llm-key",
];

export function SettingsModal({ open, initialSection = "profile", onClose }: Props) {
  const t = useT();
  const oss = isOssEdition();
  const workspaceSections = oss ? OSS_WORKSPACE_SECTIONS : WORKSPACE_SECTIONS;
  const [section, setSection] = useState<SettingsSection>(initialSection);
  // Track previous open/initialSection so we can reset `section` when the
  // modal transitions from closed→open or initialSection changes while
  // open. "Adjusting state during render" per React docs — avoids the
  // setState-in-effect anti-pattern.
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevInitial, setPrevInitial] = useState(initialSection);
  if (open !== prevOpen || initialSection !== prevInitial) {
    setPrevOpen(open);
    setPrevInitial(initialSection);
    if (open) setSection(initialSection);
  }

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
      <div className="min-h-full flex items-center justify-center p-6">
        <div
          role="dialog"
          aria-label={t.chrome.settingsModal.title}
          className={cn(
            "relative w-full max-w-4xl bg-popover border border-border rounded-xl shadow-2xl",
            "flex overflow-hidden",
            "h-[85vh]",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Left rail */}
          <nav
            aria-label="Settings sections"
            className="w-56 shrink-0 border-r border-border p-3 overflow-y-auto"
          >
            <SectionGroup
              label={t.chrome.settingsModal.workspace.section}
              sections={workspaceSections}
              active={section}
              onSelect={setSection}
              labels={{
                "ws-general": t.chrome.settingsModal.workspace.general,
                "ws-members": oss
                  ? t.chrome.settingsModal.upgrade.teammatesNav
                  : t.chrome.settingsModal.workspace.members,
                "ws-llm-key": t.chrome.settingsModal.workspace.llmKey,
                "ws-plan": t.chrome.settingsModal.workspace.plan,
                "ws-usage": t.chrome.settingsModal.workspace.usage,
              }}
            />
            <div className="mt-4">
              <SectionGroup
                label={t.chrome.settingsModal.account.section}
                sections={ACCOUNT_SECTIONS}
                active={section}
                onSelect={setSection}
                labels={{
                  profile: t.chrome.settingsModal.account.profile,
                  preferences: t.chrome.settingsModal.account.preferences,
                  privacy: t.chrome.settingsModal.account.privacy,
                  notifications: t.chrome.settingsModal.account.notifications,
                }}
              />
            </div>
          </nav>

          {/* Right pane */}
          <div className="flex-1 overflow-y-auto p-6">
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
    case "ws-plan":
      // Billing is per-workspace — the "Plan" section IS the billing
      // surface (plan tier, payment method, invoices, upgrade/cancel).
      // OSS has no billing; defensively pitch the upgrade in case something
      // dispatches openWorkspaceSettings('ws-plan') directly (the nav hides it).
      return isOssEdition() ? <HostedUpgradeSection /> : <BillingSection />;
    case "ws-usage":
      // Usage is per-workspace (migration 143) — the monthly credit
      // allowance + reset date for the active workspace. OSS has no billing;
      // defensive upgrade pitch (the nav hides this section in OSS).
      return isOssEdition() ? <HostedUpgradeSection /> : <UsageSection />;
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
