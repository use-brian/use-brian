/** Lightweight settings navigation shared by embedded settings surfaces. */
export type SettingsSection =
  | "profile"
  | "preferences"
  | "privacy"
  | "notifications"
  | "ws-general"
  | "ws-members"
  | "ws-teams"
  | "ws-organization"
  | "ws-access"
  | "ws-projects"
  | "ws-llm-key"
  | "ws-domains"
  | "ws-plan"
  | "ws-usage"
  | "ws-models";

// Cross-component request to open the settings modal at a given section. The
// modal is owned by `workspace-switcher.tsx` (local state), so surfaces that
// don't host it — e.g. the sidebar theme picker's "edit" action — ask for it via
// this window event instead of threading a context. The switcher listens and
// opens. Window events are the established cross-component seam here (cf.
// `doc:theme-changed`, `doc:draft-created`).
export const OPEN_SETTINGS_EVENT = "doc:open-settings";
export type SettingsMemberTarget = {workspaceId:string;memberId:string};
export type OpenSettingsDetail = { section: SettingsSection; memberTarget?:SettingsMemberTarget };

/** Dispatch a request to open the settings modal at `section`. No-op on the
 *  server (guards `window`) so it's safe to call from event handlers in SSR'd
 *  client components. */
export function openWorkspaceSettings(section: SettingsSection, memberTarget?:SettingsMemberTarget): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, {
      detail: { section, ...(section==='ws-members'&&memberTarget?{memberTarget}: {}) },
    }),
  );
}
