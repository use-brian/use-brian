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
 * Below `sm`, a compact section picker sits above the requested section.
 * Deep links open their body immediately; desktop keeps the two-rail layout.
 *
 * Unlike apps/web — which reuses the `(app)/settings/*` route page
 * components directly — app-web has no settings routes, so the
 * section bodies are imported as named-export components ported into
 * `./sections/*` and `./workspace-sections`. The modal stays a thin
 * shell that dispatches to them.
 */

import {WorkspaceModeSummary} from "@/components/context/mode-aware-context";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { organizationSettingsHref } from "@/lib/organization-navigation";
import { createPortal } from "react-dom";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format, useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { deploymentCapabilities, isOssEdition, HOSTED_UPGRADE_URL } from "@/lib/edition";
import type { DeploymentCapabilities } from "@use-brian/shared/deployment-capabilities";
import { AccountSection } from "./sections/account-section";
import { GeneralSection } from "./sections/general-section";
import { PrivacySection } from "./sections/privacy-section";
import { TokenUsageSection } from "./sections/token-usage-section";
import { BillingSection } from "./sections/billing-section";
import { ModelsSection } from "./sections/models-section";
import { DomainsSection } from "./sections/domains-section";
import { ProjectsContextSection } from "./sections/context-scopes-section";
import {
  WorkspaceGeneralSection,
} from "./workspace-sections";

import type { SettingsSection } from '@/lib/workspace-settings-events';
export { OPEN_SETTINGS_EVENT, openWorkspaceSettings } from '@/lib/workspace-settings-events';
export type { SettingsSection, OpenSettingsDetail } from '@/lib/workspace-settings-events';
import type { SettingsMemberTarget } from '@/lib/workspace-settings-events';

type Props = {
  open: boolean;
  initialSection?: SettingsSection;
  initialMemberTarget?:SettingsMemberTarget;
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
  "ws-organization",
  "ws-general",
  "ws-projects",
  // Provider connections and model routing share the Models section.
  // Domains (custom-domains.md + platform-subdomains.md) — the workspace-level
  // manager for published-page hostnames. Open feature, so OSS keeps it too.
  "ws-domains",
  // Models also owns custom endpoint profiles and tier assignments.
  "ws-models",
  // ws-usage is absent on purpose: the Usage block renders inside ws-plan
  // ("Plan & usage") — the alias case below still routes old deep links.
  // Billing sits last in the group: day-to-day workspace config first.
  "ws-plan",
];
// Standalone editions expose token usage, not hosted billing. People and
// department administration share the Organization shortcut. Browser profiles
// live in the Browsers mini app in both editions.
const OSS_WORKSPACE_SECTIONS: SettingsSection[] = [
  "ws-organization",
  "ws-general",
  "ws-projects",
  "ws-models",
  "ws-domains",
  "ws-usage",
];

const OSS_SOURCE_URL = "https://github.com/use-brian/use-brian";
const OSS_GIT_COMMIT_SHA = process.env.NEXT_PUBLIC_OSS_GIT_COMMIT_SHA?.trim() ?? "";

export function workspaceSettingsSections(
  capabilities: DeploymentCapabilities,
): SettingsSection[] {
  return capabilities.billing ? WORKSPACE_SECTIONS : OSS_WORKSPACE_SECTIONS;
}

export function SettingsModal({ open, initialSection = "profile", initialMemberTarget, onClose }: Props) {
  const t = useT();
  const router = useRouter();
  const { workspaceId } = useWorkspaceContext();
  const oss = isOssEdition();
  const workspaceSections = workspaceSettingsSections(deploymentCapabilities());
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [memberTarget,setMemberTarget]=useState(initialMemberTarget);
  const activeSection = section === "ws-usage" && deploymentCapabilities().billing ? "ws-plan"
    : section === "ws-llm-key" ? "ws-models" : section;
  const labels: Record<SettingsSection, string> = {
    "ws-organization": t.organization.title,
    "ws-access": t.workspaceAccess.title,
    "ws-general": t.chrome.settingsModal.workspace.general,
    "ws-members": oss
      ? t.chrome.settingsModal.upgrade.teammatesNav
      : t.chrome.settingsModal.workspace.members,
    "ws-teams": t.contextScope.teamsTitle,
    "ws-projects": t.contextScope.projectsTitle,
    "ws-llm-key": t.chrome.settingsModal.workspace.llmKey,
    "ws-domains": t.chrome.settingsModal.workspace.domains,
    "ws-plan": t.chrome.settingsModal.workspace.plan,
    "ws-usage": t.chrome.settingsModal.workspace.usage,
    "ws-models": t.chrome.settingsModal.workspace.models,
    profile: t.chrome.settingsModal.account.profile,
    preferences: t.chrome.settingsModal.account.preferences,
    privacy: t.chrome.settingsModal.account.privacy,
    notifications: t.chrome.settingsModal.account.notifications,
  };
  const groups = [
    { label: t.chrome.settingsModal.workspace.section, sections: workspaceSections },
    { label: t.chrome.settingsModal.account.section, sections: ACCOUNT_SECTIONS },
  ];
  // Track previous open/initialSection so we can reset `section` when the
  // modal transitions from closed→open or initialSection changes while
  // open. "Adjusting state during render" per React docs — avoids the
  // setState-in-effect anti-pattern.
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevInitial, setPrevInitial] = useState(initialSection);
  const [prevMemberTarget,setPrevMemberTarget]=useState(initialMemberTarget);
  if (open !== prevOpen || initialSection !== prevInitial || initialMemberTarget!==prevMemberTarget) {
    setPrevOpen(open);
    setPrevInitial(initialSection);
    setPrevMemberTarget(initialMemberTarget);
    if (open) {
      setSection(initialSection);
      setMemberTarget(initialMemberTarget);
      setPickerOpen(false);
    }
  }

  const organizationDestination = organizationSettingsHref(workspaceId, section, memberTarget);
  useEffect(() => {
    if (!open || !organizationDestination) return;
    router.push(organizationDestination);
    onClose();
  }, [open, organizationDestination, router, onClose]);

  const selectSection = (s: SettingsSection) => {
    setMemberTarget(undefined);
    setSection(s);
    setPickerOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !pickerOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, pickerOpen]);

  // SSR-safe portal mount guard — document.body only exists client-side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!open || !mounted || organizationDestination) return null;

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
            "flex flex-col sm:flex-row overflow-hidden",
            "h-[100dvh] sm:h-[85vh]",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Desktop rail and mobile picker share the same destinations. */}
          <nav
            aria-label={t.chrome.settingsModal.title}
            className="hidden sm:flex w-56 shrink-0 border-r border-border p-3 flex-col overflow-hidden"
          >
            <div className="min-h-0 flex-1 overflow-y-auto space-y-4">
              {groups.map((group) => (
                <SectionGroup
                  key={group.label}
                  {...group}
                  active={activeSection}
                  onSelect={selectSection}
                  labels={labels}
                />
              ))}
            </div>
            {oss && <OssVersionFooter />}
          </nav>

          <div className="sm:hidden shrink-0 border-b border-border p-3 pr-16">
            <Select
              value={activeSection}
              onValueChange={(value) => { if (value) selectSection(value); }}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
            >
              <SelectTrigger aria-label={t.chrome.settingsModal.title} className="w-full min-h-11">
                <SelectValue>{labels[activeSection]}</SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className="max-h-[min(60dvh,var(--available-height))]"
              >
                {groups.map((group) => (
                  <div key={group.label} role="group" aria-label={group.label}>
                    <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </div>
                    {group.sections.map((s) => (
                      <SelectItem key={s} value={s} className="min-h-11">
                        {labels[s]}
                      </SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div key={activeSection} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <SectionBody section={section} onClose={onClose} />
            {oss && <div className="sm:hidden"><OssVersionFooter /></div>}
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t.chrome.settingsModal.close}
            className="absolute top-3 right-3 h-11 w-11 sm:h-7 sm:w-7 rounded hover:bg-muted inline-flex items-center justify-center text-muted-foreground"
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

export function OssVersionFooter({ commitSha = OSS_GIT_COMMIT_SHA }: { commitSha?: string }) {
  const t = useT();
  const normalizedSha = /^[0-9a-f]{7,40}$/i.test(commitSha) ? commitSha.toLowerCase() : "";
  const shortSha = normalizedSha.slice(0, 7);
  const href = normalizedSha ? `${OSS_SOURCE_URL}/commit/${normalizedSha}` : OSS_SOURCE_URL;
  const label = shortSha
    ? format(t.chrome.settingsModal.source.version, { hash: shortSha })
    : t.chrome.settingsModal.source.repository;
  const linkLabel = shortSha
    ? format(t.chrome.settingsModal.source.viewVersion, { hash: shortSha })
    : t.chrome.settingsModal.source.viewRepository;

  return (
    <div className="shrink-0 px-2 pb-1 pt-6 text-[11px] text-muted-foreground">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={linkLabel}
        title={normalizedSha || linkLabel}
        className="transition-colors hover:text-foreground hover:underline underline-offset-2"
      >
        {label}
      </a>
    </div>
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
      return <><WorkspaceModeSummary/><WorkspaceGeneralSection onWorkspaceDeleted={onClose} /></>;
    case "ws-members":
    case "ws-teams":
    case "ws-access":
    case "ws-organization":
      // The modal redirects these compatibility entries to the canonical hub.
      return null;
    case "ws-projects":
      return <ProjectsContextSection />;
    case "ws-llm-key":
      // Compatibility for old deep links: provider setup now lives in Models.
      return <ModelsSection />;
    case "ws-domains":
      // Domains work in both editions (open feature): the workspace-level
      // subdomain + custom-domain manager (platform-subdomains.md).
      return <DomainsSection />;
    case "ws-plan":
      // Billing is per-workspace — the "Plan" section IS the billing
      // surface (plan tier, payment method, invoices, upgrade/cancel).
      // OSS has no billing; defensively pitch the upgrade in case something
      // dispatches openWorkspaceSettings('ws-plan') directly (the nav hides it).
      if (deploymentCapabilities().billing) return <BillingSection />;
      return deploymentCapabilities().hostedUpgradePrompts ? <HostedUpgradeSection /> : null;
    case "ws-usage":
      // Hosted keeps its historical alias; standalone reads local token telemetry.
      return deploymentCapabilities().billing ? <BillingSection /> : <TokenUsageSection />;
    case "ws-models":
      // Custom endpoint profiles and tier assignments work in both editions.
      // Hosted additionally exposes metered profiles and billing estimates.
      return <ModelsSection />;
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
          className="inline-flex items-center rounded-md bg-action px-3 py-2 text-sm font-medium text-action-foreground hover:bg-action/90"
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
